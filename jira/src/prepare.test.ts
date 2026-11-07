import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Prompt } from '@forge/llm';
import { jiraKey } from '@shipmill-atlassian/shared/jira-key';
import { commentId, type Release } from '@shipmill-atlassian/shared/release';
import { askDecisions } from './ask';
import { MARKER, frameText, questionComment } from './comment';
import { FakeJira, LEAD, toolResponse } from './fake-jira';
import { seedRelease } from './fixtures';
import { findDecisions, type Decision } from './finder';
import { PrepareError, evidenceText, llmPreparer, templatePreparer, type Prepared } from './prepare';

const NOW = () => new Date('2026-12-03T09:00:00.000Z');

async function seedDecisions(): Promise<{ release: Release; decisions: Decision[] }> {
  const release = await seedRelease();
  const implicit: Decision = {
    key: jiraKey('HRB-4'),
    source: 'llm',
    question: 'Run the invoices migration during the 2.4 rollout or in a separate maintenance window?',
    evidence: { kind: 'comment', id: commentId('10101') },
    askOf: null,
  };
  const labelled = await findDecisions(release, { llm: false, implicit: { find: async () => [] } });
  return { release, decisions: [...labelled, implicit] };
}

async function prepareFirst(): Promise<Prepared> {
  const { release, decisions } = await seedDecisions();
  const decision = decisions[0]!;
  const item = release.items.find((candidate) => candidate.key === decision.key)!;
  return templatePreparer.prepare(decision, item, release, decision.askOf!);
}

test('with the LLM off the question is the needs-decision frame, options read from "A, or B?"', async () => {
  assert.equal(
    frameText(await prepareFirst()),
    [
      MARKER,
      '@Dana Okafor Decision needed: retire v1 tokens in 2.4, or keep them for one more release?',
      '',
      '1. Move HRB-2 out of 2.4 (recommended): 2.4 ships without waiting on this; the decision moves to the next version with the work item',
      '2. Retire v1 tokens in 2.4: decided now, and 2.4 ships with HRB-2 done this way',
      '3. Keep them for one more release: decided now, and 2.4 ships with HRB-2 done this way',
      '',
      'Evidence: asked in the description of HRB-2: "Decision needed: retire v1 tokens in 2.4, or keep them for one more release? Fourteen customers still call the API with a v1 token every week."',
      '',
      'Reply here with a number; shipmill takes this up as soon as you reply.',
    ].join('\n'),
  );
});

// The protocol's shape, line by line: the marker, the mention and the question, a blank
// line, the numbered options with only the first recommended, then the reply line last
function assertFrame(text: string, llm: boolean): void {
  const lines = text.split('\n');
  assert.equal(lines[0], MARKER);
  assert.match(lines[1]!, /^@\S.* Decision needed: \S.*\?$/);
  assert.equal(lines[2], '');
  const options = lines.slice(3, lines.indexOf('', 3));
  assert.ok(options.length >= 2 && options.length <= 4, `${options.length} options`);
  options.forEach((line, index) => {
    assert.ok(line.startsWith(`${index + 1}. `), line);
    assert.equal(line.includes(' (recommended): '), index === 0, line);
    assert.match(line, /: \S/);
  });
  assert.match(lines.at(-1)!, llm ? /^Reply here with a number or your own answer; / : /^Reply here with a number; /);
}

test('every seeded decision prepares to the frame, from the description, a comment or the summary', async () => {
  const { release, decisions } = await seedDecisions();
  const summaryOnly: Decision = { key: jiraKey('HRB-1'), source: 'label', question: 'What should HRB-1 "Export invoices as CSV" ship as in this release?', evidence: { kind: 'summary' }, askOf: null };
  for (const decision of [...decisions, summaryOnly]) {
    const item = release.items.find((candidate) => candidate.key === decision.key)!;
    const prepared = await templatePreparer.prepare(decision, item, release, decision.askOf ?? LEAD);
    assertFrame(frameText(prepared), false);
  }
});

test('the ADF comment mentions the decider and numbers the options as an ordered list', async () => {
  const body = questionComment(await prepareFirst());
  const [question, options, evidence, reply] = body.content;
  assert.deepEqual(question?.content[0], { type: 'mention', attrs: { id: '712020:dana', text: '@Dana Okafor' } });
  assert.equal(options?.type, 'orderedList');
  assert.equal(options?.content.length, 3);
  assert.equal(evidence?.type, 'paragraph');
  assert.equal(reply?.type, 'paragraph');
});

test('with the LLM on Claude writes the question and options; the evidence and decider stay the finder\'s', async () => {
  const { release, decisions } = await seedDecisions();
  const migration = decisions[2]!;
  const item = release.items.find((candidate) => candidate.key === migration.key)!;
  const prompts: Prompt[] = [];
  const preparer = llmPreparer(
    async (prompt) => {
      prompts.push(prompt);
      return toolResponse('prepare_decision', {
        question: 'Do we run the invoices migration during the 2.4 rollout or in a separate maintenance window?',
        recommended: { option: 'Run it in a separate maintenance window.', why: 'Customers keep invoicing during the rollout.' },
        others: [{ option: 'Run it during the 2.4 rollout', cost: 'The invoices table locks for about 20 minutes while customers are online.' }],
      });
    },
    () => {},
  );
  const prepared = await preparer.prepare(migration, item, release, LEAD);
  assert.equal(prompts.length, 1);
  assert.match(JSON.stringify(prompts[0]?.messages), /HRB-4/);
  assert.deepEqual(prompts[0]?.tool_choice, { type: 'function', function: { name: 'prepare_decision' } });
  assert.equal(prepared.llm, true);
  assert.equal(prepared.options[0]?.text, 'Run it in a separate maintenance window');
  assert.match(evidenceText(prepared.evidence), /^asked by Seed Bot in a comment on .*, found by Claude: "Do we run this migration/);
  assertFrame(frameText(prepared), true);
});

test('refuses a prepared decision out of shape', async () => {
  const { release, decisions } = await seedDecisions();
  const decision = decisions[0]!;
  const item = release.items.find((candidate) => candidate.key === decision.key)!;
  const good = { question: 'Retire them now?', recommended: { option: 'Retire', why: 'Less to keep.' }, others: [{ option: 'Keep', cost: 'One more release of upkeep.' }] };
  const bad: object[] = [
    { ...good, question: 'Retire them now.' },
    { ...good, others: [] },
    { ...good, others: [good.others[0], good.others[0], good.others[0], good.others[0]] },
    { ...good, recommended: { option: '', why: 'x' } },
  ];
  for (const args of bad) {
    const preparer = llmPreparer(async () => toolResponse('prepare_decision', args), () => {});
    await assert.rejects(preparer.prepare(decision, item, release, LEAD), (error) => error instanceof PrepareError || error instanceof Error);
  }
  const silent = llmPreparer(async () => ({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }] }), () => {});
  await assert.rejects(silent.prepare(decision, item, release, LEAD), PrepareError);
});

test('asking posts each question, labels the unlabelled one, records the wait, and never asks twice', async () => {
  const { release, decisions } = await seedDecisions();
  const jira = new FakeJira();
  const outcomes = await askDecisions(release, decisions, { jira, preparer: templatePreparer, now: NOW });
  assert.deepEqual(outcomes.map((o) => [o.key, o.asked]), [['HRB-2', true], ['HRB-3', true], ['HRB-4', true]]);
  // HRB-2 and HRB-3 carry the label already; the implicit HRB-4 gets it
  assert.deepEqual(jira.labels, [{ key: 'HRB-4', present: true }]);
  // Nobody asked on HRB-4's decision, so the project lead decides, read once
  assert.equal(jira.states.get(jiraKey('HRB-4'))?.decider.displayName, 'Project Lead');
  assert.equal(jira.leadCalls, 1);
  const state = jira.states.get(jiraKey('HRB-2'));
  assert.equal(state?.status, 'waiting');
  assert.equal(state?.questionId, outcomes[0]?.asked === true ? outcomes[0].questionId : undefined);
  assert.equal(state?.askedAt, '2026-12-03T09:00:00.000Z');
  assert.equal(state?.llm, false);
  assert.match(jira.posted(jiraKey('HRB-2'))[0]!.text, /^@Dana Okafor Decision needed: retire v1 tokens/);

  const again = await askDecisions(release, decisions, { jira, preparer: templatePreparer, now: NOW });
  assert.deepEqual(again.map((o) => o.asked), [false, false, false]);
  assert.equal(jira.posted(jiraKey('HRB-2')).length, 1);
});
