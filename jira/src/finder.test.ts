import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatResponse } from '@forge/llm';
import { jiraKey } from '@shipmill-atlassian/shared/jira-key';
import { commentId } from '@shipmill-atlassian/shared/release';
import { seedRelease } from './fixtures';
import { ImplicitDecisionError, findDecisions, type ImplicitDecision, type ImplicitFinder } from './finder';
import { describeRelease, llmFinder, parseResponse, prompt } from './llm-finder';

function scripted(decisions: ImplicitDecision[]): ImplicitFinder & { calls: number } {
  return {
    calls: 0,
    async find() {
      this.calls++;
      return decisions;
    },
  };
}

const NEVER: ImplicitFinder = {
  async find() {
    throw new Error('the LLM was called with the switch off');
  },
};

const MIGRATION: ImplicitDecision = {
  key: jiraKey('HRB-4'),
  commentId: commentId('10101'),
  question: 'Run the invoices migration during the 2.4 rollout or in a separate maintenance window?',
  askAccountId: null,
};

test('with the switch off it finds the two labelled decisions and makes no LLM call', async () => {
  const decisions = await findDecisions(await seedRelease(), { llm: false, implicit: NEVER });
  assert.deepEqual(
    decisions.map((d) => [d.key, d.source, d.evidence.kind]),
    [
      ['HRB-2', 'label', 'description'],
      ['HRB-3', 'label', 'description'],
    ],
  );
  assert.equal(decisions[0]?.question, 'retire v1 tokens in 2.4, or keep them for one more release?');
  assert.equal(decisions[0]?.askOf?.displayName, 'Dana Okafor');
});

test('with the switch on it adds what the LLM finds, checked against the release', async () => {
  const llm = scripted([MIGRATION]);
  const decisions = await findDecisions(await seedRelease(), { llm: true, implicit: llm });
  assert.equal(llm.calls, 1);
  assert.deepEqual(
    decisions.map((d) => [d.key, d.source]),
    [
      ['HRB-2', 'label'],
      ['HRB-3', 'label'],
      ['HRB-4', 'llm'],
    ],
  );
  assert.deepEqual(decisions[2]?.evidence, { kind: 'comment', id: '10101' });
  assert.equal(decisions[2]?.askOf?.displayName, 'Lee Park');
});

test('drops the LLM copy of a labelled decision', async () => {
  const llm = scripted([{ ...MIGRATION, key: jiraKey('HRB-2'), commentId: null }]);
  const decisions = await findDecisions(await seedRelease(), { llm: true, implicit: llm });
  assert.deepEqual(decisions.map((d) => d.key), ['HRB-2', 'HRB-3']);
});

test('refuses an LLM answer that does not match the release', async () => {
  const release = await seedRelease();
  const cases: ImplicitDecision[] = [
    { ...MIGRATION, key: jiraKey('HRB-99') },
    { ...MIGRATION, commentId: commentId('1') },
    { ...MIGRATION, askAccountId: 'someone-else' },
    { ...MIGRATION, question: ' ' },
  ];
  for (const found of cases) {
    await assert.rejects(findDecisions(release, { llm: true, implicit: scripted([found]) }), ImplicitDecisionError);
  }
});

test('a labelled item with a question in a comment takes the newest one', async () => {
  const release = await seedRelease();
  const item = release.items.find((candidate) => candidate.key === 'HRB-3');
  assert.ok(item);
  item.comments.push({
    id: commentId('20000'),
    author: { accountId: 'x', displayName: 'X' },
    created: '2026-11-04T10:00:00.000+0000',
    text: 'Update. Decision needed: launch the pricing page on Monday or Thursday?',
  });
  const decisions = await findDecisions(release, { llm: false, implicit: NEVER });
  assert.deepEqual(decisions[1]?.evidence, { kind: 'comment', id: '20000' });
  assert.equal(decisions[1]?.question, 'launch the pricing page on Monday or Thursday?');
});

test('the prompt carries the items, comment ids and account ids, and forces the tool', async () => {
  const release = await seedRelease();
  const built = prompt(release);
  const text = describeRelease(release);
  assert.match(text, /## HRB-4: Migrate the invoices table/);
  assert.match(text, /Comment 10101 by Seed Bot \[557058:seed-bot\]/);
  assert.match(text, /Labels: needs-decision\./);
  assert.deepEqual(built.tool_choice, { type: 'function', function: { name: 'report_decisions' } });
  assert.equal(built.messages[1]?.content, text);
});

function response(args: unknown): ChatResponse {
  return {
    choices: [
      {
        finish_reason: 'tool_use',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 't1', type: 'function', index: 0, function: { name: 'report_decisions', arguments: args as object } }],
        },
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

test('reads the tool call, parsed or as a JSON string', () => {
  const args = { decisions: [{ key: 'HRB-4', comment_id: '10101', question: 'When?', ask_account_id: null }] };
  const expected = [{ key: 'HRB-4', commentId: '10101', question: 'When?', askAccountId: null }];
  assert.deepEqual(parseResponse(response(args)), expected);
  assert.deepEqual(parseResponse(response(JSON.stringify(args))), expected);
  assert.deepEqual(parseResponse(response({ decisions: [] })), []);
});

test('refuses a response without exactly one well-formed tool call', () => {
  assert.throws(() => parseResponse({ choices: [] }), ImplicitDecisionError);
  assert.throws(
    () => parseResponse({ choices: [{ finish_reason: 'max_tokens', message: { role: 'assistant', content: 'HOLD' } }] }),
    ImplicitDecisionError,
  );
  assert.throws(() => parseResponse(response({ decisions: [{ key: 'hrb-4', comment_id: null, question: 'q', ask_account_id: null }] })));
  assert.throws(() => parseResponse(response({ found: [] })));
});

test('the LLM finder sends the prompt through the chat it was given', async () => {
  const sent: unknown[] = [];
  const finder = llmFinder(
    async (p) => {
      sent.push(p);
      return response({ decisions: [] });
    },
    () => {},
  );
  assert.deepEqual(await finder.find(await seedRelease()), []);
  assert.equal(sent.length, 1);
});
