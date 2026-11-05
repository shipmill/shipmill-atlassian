import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraKey } from '@shipmill-atlassian/shared/jira-key';
import type { Person } from '@shipmill-atlassian/shared/release';
import { askDecisions } from './ask';
import { FakeJira, toolResponse } from './fake-jira';
import { seedRelease } from './fixtures';
import { findDecisions } from './finder';
import { templatePreparer } from './prepare';
import { ReplyError, llmReplyReader, optionNumber, relayReply, type ReplyReader } from './relay';

const NOW = () => new Date('2026-12-03T11:00:00.000Z');
const DANA: Person = { accountId: '712020:dana', displayName: 'Dana Okafor' };
const OUTSIDER: Person = { accountId: '712020:someone', displayName: 'Someone Else' };
const HRB2 = jiraKey('HRB-2');

const NO_LLM: ReplyReader = {
  async read() {
    throw new Error('the LLM read a reply with the switch off');
  },
};

// The seed release asked with the LLM off: HRB-2 and HRB-3 wait on Dana and on their owners
async function asked(): Promise<FakeJira> {
  const release = await seedRelease();
  const decisions = await findDecisions(release, { llm: false, implicit: { find: async () => [] } });
  const jira = new FakeJira();
  await askDecisions(release, decisions, { jira, preparer: templatePreparer, now: NOW });
  return jira;
}

test('reads an option number at the start of a reply only', () => {
  assert.equal(optionNumber('2', 3), 2);
  assert.equal(optionNumber(' 2. keep them', 3), 2);
  assert.equal(optionNumber('#3', 3), 3);
  assert.equal(optionNumber('Option 1: move it', 3), 1);
  assert.equal(optionNumber('4', 3), null);
  assert.equal(optionNumber('0', 3), null);
  assert.equal(optionNumber('2.5 would be better', 3), null);
  assert.equal(optionNumber('wait 2 days', 3), null);
  assert.equal(optionNumber('', 3), null);
});

test('with the LLM off a number from the decider ends the wait: relay comment, label off, answer recorded', async () => {
  const jira = await asked();
  const reply = jira.reply(HRB2, DANA, '2');
  const outcome = await relayReply(HRB2, reply, { jira, reader: null, now: NOW });
  assert.deepEqual(outcome, { key: HRB2, relayed: true, answer: { kind: 'option', number: 2 } });
  const posted = jira.posted(HRB2);
  assert.equal(
    posted.at(-1)?.text,
    'Decision by @Dana Okafor, relayed by shipmill\nAnswered in Jira: option 2, Retire v1 tokens in 2.4: decided now, and 2.4 ships with HRB-2 done this way',
  );
  // The login sits in a code span, so the record doesn't notify Dana again
  assert.deepEqual(posted.at(-1)?.body.content[0], {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Decision by ' },
      { type: 'text', text: '@Dana Okafor', marks: [{ type: 'code' }] },
      { type: 'text', text: ', relayed by shipmill' },
    ],
  });
  assert.deepEqual(jira.labels.at(-1), { key: HRB2, present: false });
  const state = jira.states.get(HRB2);
  assert.equal(state?.status, 'decided');
  assert.equal(state?.status === 'decided' ? state.replyId : null, reply);

  // A second reply after the decision changes nothing
  const later = jira.reply(HRB2, DANA, '1');
  assert.deepEqual(await relayReply(HRB2, later, { jira, reader: null, now: NOW }), { key: HRB2, relayed: false, reason: 'decided' });
});

test('with the LLM off free text gets a note and the question stays open', async () => {
  const jira = await asked();
  const before = jira.posted(HRB2).length;
  const reply = jira.reply(HRB2, DANA, 'Let us keep them one more release');
  assert.deepEqual(await relayReply(HRB2, reply, { jira, reader: null, now: NOW }), { key: HRB2, relayed: false, reason: 'unread' });
  assert.equal(jira.posted(HRB2).length, before + 1);
  assert.match(jira.posted(HRB2).at(-1)!.text, /Reply with a number from 1 to 3; the decision stays open/);
  assert.equal(jira.states.get(HRB2)?.status, 'waiting');
  assert.deepEqual(jira.labels, []);
});

test('a question asked with the LLM off is relayed by number even when the switch is on now', async () => {
  const jira = await asked();
  const reply = jira.reply(HRB2, DANA, 'keep them');
  const outcome = await relayReply(HRB2, reply, { jira, reader: NO_LLM, now: NOW });
  assert.deepEqual(outcome, { key: HRB2, relayed: false, reason: 'unread' });
});

test('only a newer comment by the person asked counts', async () => {
  const jira = await asked();
  const outsider = jira.reply(HRB2, OUTSIDER, '1');
  assert.deepEqual(await relayReply(HRB2, outsider, { jira, reader: null, now: NOW }), { key: HRB2, relayed: false, reason: 'not-decider' });
  const question = jira.states.get(HRB2)!.questionId;
  assert.deepEqual(await relayReply(HRB2, question, { jira, reader: null, now: NOW }), { key: HRB2, relayed: false, reason: 'not-newer' });
  const notAsked = jiraKey('HRB-5');
  const reply = jira.reply(notAsked, DANA, '1');
  assert.deepEqual(await relayReply(notAsked, reply, { jira, reader: null, now: NOW }), { key: notAsked, relayed: false, reason: 'no-question' });
  assert.equal(jira.states.get(HRB2)?.status, 'waiting');
  assert.deepEqual(jira.labels, []);
});

// With the LLM on: a question asked with it on, and Claude reading the free-text reply
async function askedWithLlm(): Promise<FakeJira> {
  const jira = await asked();
  const state = jira.states.get(HRB2)!;
  await jira.setState(HRB2, { ...state, llm: true });
  return jira;
}

test('with the LLM on Claude reads a free-text reply as an option or the decider\'s own answer', async () => {
  const jira = await askedWithLlm();
  const prompts: string[] = [];
  const reader = llmReplyReader(async (prompt) => {
    prompts.push(JSON.stringify(prompt.messages));
    return toolResponse('read_reply', { kind: 'own', option: null, answer: 'Keep v1 tokens until 2.5 and email the fourteen customers.' });
  }, () => {});
  const reply = jira.reply(HRB2, DANA, 'Keep them until 2.5, and let us email those fourteen customers this week.');
  const outcome = await relayReply(HRB2, reply, { jira, reader, now: NOW });
  assert.deepEqual(outcome, { key: HRB2, relayed: true, answer: { kind: 'own', text: 'Keep v1 tokens until 2.5 and email the fourteen customers.' } });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /1\. Move HRB-2 out of 2.4 \(recommended\)/);
  assert.match(prompts[0]!, /email those fourteen customers/);
  assert.equal(jira.posted(HRB2).at(-1)?.text, 'Decision by @Dana Okafor, relayed by shipmill\nAnswered in Jira: Keep v1 tokens until 2.5 and email the fourteen customers.');
  assert.deepEqual(jira.labels.at(-1), { key: HRB2, present: false });
});

test('with the LLM on a number is still read by code, and a reply that decides nothing keeps the wait quietly', async () => {
  const jira = await askedWithLlm();
  const numbered = jira.reply(HRB2, DANA, '1');
  const byNumber = await relayReply(HRB2, numbered, { jira, reader: NO_LLM, now: NOW });
  assert.deepEqual(byNumber, { key: HRB2, relayed: true, answer: { kind: 'option', number: 1 } });

  const other = await askedWithLlm();
  const posted = other.posted(HRB2).length;
  const reader = llmReplyReader(async () => toolResponse('read_reply', { kind: 'none', option: null, answer: null }), () => {});
  const reply = other.reply(HRB2, DANA, 'Which customers are these?');
  assert.deepEqual(await relayReply(HRB2, reply, { jira: other, reader, now: NOW }), { key: HRB2, relayed: false, reason: 'no-answer' });
  assert.equal(other.posted(HRB2).length, posted);
});

test('refuses an LLM reading out of shape', async () => {
  const jira = await askedWithLlm();
  for (const args of [
    { kind: 'option', option: 7, answer: null },
    { kind: 'own', option: null, answer: ' ' },
    { kind: 'maybe', option: null, answer: null },
  ]) {
    const reader = llmReplyReader(async () => toolResponse('read_reply', args), () => {});
    const reply = jira.reply(HRB2, DANA, 'something');
    await assert.rejects(relayReply(HRB2, reply, { jira, reader, now: NOW }), (error) => error instanceof ReplyError || error instanceof Error);
  }
  assert.equal(jira.states.get(HRB2)?.status, 'waiting');
});
