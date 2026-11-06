import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DecisionReply } from '@shipmill-atlassian/shared/bridge';
import { jiraKey } from '@shipmill-atlassian/shared/jira-key';
import { commentId } from '@shipmill-atlassian/shared/release';
import { askDecisions } from './ask';
import { FakeJira, toolResponse } from './fake-jira';
import { seedRelease } from './fixtures';
import { findDecisions } from './finder';
import { templatePreparer } from './prepare';
import { decisionView, relayPullRequestReply } from './pull-request-decision';
import { llmReplyReader } from './relay';

const NOW = () => new Date('2026-12-03T11:00:00.000Z');
const DANA = { accountId: '712020:dana', displayName: 'Dana Okafor' };
const HRB2 = jiraKey('HRB-2');

async function asked(): Promise<FakeJira> {
  const release = await seedRelease();
  const decisions = await findDecisions(release, { llm: false, implicit: { find: async () => [] } });
  const jira = new FakeJira();
  await askDecisions(release, decisions, { jira, preparer: templatePreparer, now: NOW });
  return jira;
}

function reply(jira: FakeJira, text: string, author = DANA): DecisionReply {
  return {
    kind: 'decision-reply',
    sentAt: NOW().getTime(),
    key: HRB2,
    questionId: jira.states.get(HRB2)!.questionId,
    author,
    text,
    pullRequest: { id: 2, url: 'https://bitbucket.org/shipmill-dev/harbor/pull-requests/2' },
  };
}

test('the view shows the question while it waits and the answer once decided', async () => {
  const jira = await asked();
  const waiting = await decisionView(jira, HRB2);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.status === 'waiting' ? waiting.options.length : 0, 3);
  assert.deepEqual(await decisionView(jira, jiraKey('HRB-5')), { key: 'HRB-5', status: 'none' });
  await relayPullRequestReply(reply(jira, '3'), { jira, reader: null, now: NOW });
  const decided = await decisionView(jira, HRB2);
  assert.equal(decided.status === 'decided' ? decided.answer : null, 'option 3, Keep them for one more release: decided now, and 2.4 ships with HRB-2 done this way');
});

test('a reply on a pull request records the relay comment as the reply that ended the wait', async () => {
  const jira = await asked();
  assert.equal((await relayPullRequestReply(reply(jira, '2'), { jira, reader: null, now: NOW })).relayed, true);
  const state = jira.states.get(HRB2);
  const relay = jira.posted(HRB2).at(-1)!;
  assert.match(relay.text, /^Decision by @Dana Okafor, relayed by shipmill\nAnswered on Bitbucket pull request #2 /);
  assert.equal(state?.status === 'decided' ? jira.comments.get(state.replyId)?.comment.text : null, relay.text);
});

test('only the person asked, on the current question, still waiting, is relayed', async () => {
  const jira = await asked();
  const deps = { jira, reader: null, now: NOW };
  const outsider = { accountId: '712020:sam', displayName: 'Sam Reyes' };
  assert.deepEqual(await relayPullRequestReply(reply(jira, '1', outsider), deps), { relayed: false, reason: 'not-decider' });
  assert.deepEqual(await relayPullRequestReply({ ...reply(jira, '1'), questionId: commentId('1') }, deps), { relayed: false, reason: 'other-question' });
  assert.deepEqual(await relayPullRequestReply({ ...reply(jira, '1'), key: jiraKey('HRB-5') }, deps), { relayed: false, reason: 'no-question' });
  assert.deepEqual(await relayPullRequestReply(reply(jira, 'maybe later'), deps), { relayed: false, reason: 'unread' });
  assert.equal(jira.states.get(HRB2)?.status, 'waiting');
  assert.deepEqual(jira.labels, []);
  assert.equal((await relayPullRequestReply(reply(jira, '1'), deps)).relayed, true);
  assert.deepEqual(await relayPullRequestReply(reply(jira, '2'), deps), { relayed: false, reason: 'decided' });
});

test('with the LLM on Claude reads a free-text reply made on a pull request', async () => {
  const jira = await asked();
  await jira.setState(HRB2, { ...jira.states.get(HRB2)!, llm: true });
  const reader = llmReplyReader(async () => toolResponse('read_reply', { kind: 'option', option: 3, answer: null }), () => {});
  const outcome = await relayPullRequestReply(reply(jira, 'Keep them one more release'), { jira, reader, now: NOW });
  assert.deepEqual(outcome, { relayed: true, answer: 'option 3, Keep them for one more release: decided now, and 2.4 ships with HRB-2 done this way' });
  const none = await asked();
  await none.setState(HRB2, { ...none.states.get(HRB2)!, llm: true });
  const undecided = llmReplyReader(async () => toolResponse('read_reply', { kind: 'none', option: null, answer: null }), () => {});
  assert.deepEqual(await relayPullRequestReply(reply(none, 'Which customers?'), { jira: none, reader: undecided, now: NOW }), { relayed: false, reason: 'no-answer' });
});
