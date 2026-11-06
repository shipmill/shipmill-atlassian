import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decode, encode } from '@shipmill-atlassian/shared/bridge';
import { parseDecisionView, parseReplyOutcome } from '@shipmill-atlassian/shared/decision';
import { jiraKey, type JiraKey } from '@shipmill-atlassian/shared/jira-key';
import type { WorkItemStatus } from '@shipmill-atlassian/shared/work-item';
import { askDecisions } from '../../jira/src/ask';
import { FakeJira } from '../../jira/src/fake-jira';
import { seedRelease } from '../../jira/src/fixtures';
import { findDecisions } from '../../jira/src/finder';
import { templatePreparer } from '../../jira/src/prepare';
import { decisionView, relayPullRequestReply } from '../../jira/src/pull-request-decision';
import { relayReply } from '../../jira/src/relay';
import type { PullRequest } from './bitbucket-rest';
import { APP, FakeQuestions, FakeRepository, REPOSITORY } from './fake-bitbucket';
import { checkResult, type Facts } from './holds';
import { STALE_CLAIM_MS, relayPullRequestComment, syncQuestion, type Decisions, type QuestionDeps } from './pr-decision';

// The seeded pull request for HRB-2 against the Jira app's own preparer and relay: the
// question HRB-2 waits on is asked on the pull request, answered there, and clears.

const NOW = () => new Date('2026-12-03T11:00:00.000Z');
const SECRET = 'a-shared-secret';
const DANA = { accountId: '712020:dana', displayName: 'Dana Okafor' };
const SAM = { accountId: '712020:sam', displayName: 'Sam Reyes' };
const HRB2 = jiraKey('HRB-2');
const QUESTION = 'retire v1 tokens in 2.4, or keep them for one more release?';

const SEEDED: PullRequest = {
  id: 2,
  title: 'HRB-2 Rejects API v1 tokens with a pointer to the migration guide',
  url: 'https://bitbucket.org/shipmill-dev/harbor/pull-requests/2',
  repositorySlug: 'harbor',
  author: SAM,
  sourceCommit: '0123456789abcdef',
  destinationBranch: 'main',
  destinationCommit: 'fedcba9876543210',
  participants: [],
};

// The Jira app on the other end of the signed bridge, messages encoded and decoded as sent
function bridged(jira: FakeJira): Decisions {
  const send = (message: Parameters<typeof encode>[1]) => {
    const { body, signature } = encode(SECRET, message);
    return decode(SECRET, body, signature, message.sentAt);
  };
  const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
  return {
    async view(key) {
      const message = send({ kind: 'decision', sentAt: NOW().getTime(), key });
      if (message.kind !== 'decision') throw new Error(`sent a decision query, decoded ${message.kind}`);
      return parseDecisionView(roundTrip(await decisionView(jira, message.key)));
    },
    async reply(reply) {
      const message = send({ kind: 'decision-reply', sentAt: NOW().getTime(), ...reply });
      if (message.kind !== 'decision-reply') throw new Error(`sent a decision reply, decoded ${message.kind}`);
      return parseReplyOutcome(roundTrip(await relayPullRequestReply(message, { jira, reader: null, now: NOW })));
    },
  };
}

// The seed release asked in Jira with the LLM off, and the harbor repository with its pull request
async function seeded(pullRequest = SEEDED) {
  const release = await seedRelease();
  const decisions = await findDecisions(release, { llm: false, implicit: { find: async () => [] } });
  const jira = new FakeJira();
  await askDecisions(release, decisions, { jira, preparer: templatePreparer, now: NOW });
  const rest = new FakeRepository(pullRequest);
  const store = new FakeQuestions();
  const deps: QuestionDeps = { rest, store, decisions: bridged(jira), repository: REPOSITORY, now: NOW };
  return { jira, rest, store, deps };
}

// What the merge check sees: the item's label as the open decision, and the pull request's tasks
async function check(jira: FakeJira, rest: FakeRepository, key: JiraKey = HRB2) {
  const decided = jira.labels.some((change) => change.key === key && !change.present);
  const workItem: WorkItemStatus = {
    key,
    found: true,
    summary: 'Retire API v1 tokens',
    fixVersions: ['2.4'],
    openDecisions: decided ? [] : [QUESTION],
    decider: DANA,
  };
  const facts: Facts = {
    pullRequest: SEEDED,
    workItem,
    statuses: await rest.statuses(''),
    tasks: await rest.tasks(SEEDED.id),
    breaking: [],
    lanes: ['stable'],
  };
  return checkResult(facts);
}

test('a seeded pull request asks, is answered, and clears', async () => {
  const { jira, rest, deps } = await seeded();
  assert.equal((await check(jira, rest)).success, false);

  // Asks: the prepared question as a comment that mentions Dana, and a task that holds the merge
  assert.equal(await syncQuestion(deps, SEEDED), 'asked');
  assert.deepEqual(rest.posted(2), [
    [
      `@{712020:dana} Decision needed: ${QUESTION}`,
      '',
      '1. Move HRB-2 out of 2.4 (recommended): 2.4 ships without waiting on this; the decision moves to the next version with the work item',
      '2. Retire v1 tokens in 2.4: decided now, and 2.4 ships with HRB-2 done this way',
      '3. Keep them for one more release: decided now, and 2.4 ships with HRB-2 done this way',
      '',
      'Evidence: asked on HRB-2 in Jira, the work item this pull request names; the answer is recorded there.',
      '',
      'Reply here with a number; shipmill takes this up as soon as you reply.',
    ].join('\n'),
  ]);
  const [task] = await rest.tasks(2);
  assert.deepEqual(task, { id: task!.id, state: 'UNRESOLVED', text: `Decision needed: ${QUESTION}` });
  assert.equal(rest.taskById.get(task!.id)?.comment, [...rest.comments.keys()][0]);
  assert.equal((await check(jira, rest)).success, false);

  // Someone else's reply counts for nothing
  assert.equal(await relayPullRequestComment(deps, 2, rest.reply(2, SAM, '1')), 'not-decider');

  // Is answered: Dana replies 2 on the pull request, and Jira records it
  assert.equal(await relayPullRequestComment(deps, 2, rest.reply(2, DANA, '2')), 'relayed');
  const answer = 'option 2, Retire v1 tokens in 2.4: decided now, and 2.4 ships with HRB-2 done this way';
  assert.equal(
    jira.posted(HRB2).at(-1)?.text,
    `Decision by @Dana Okafor, relayed by shipmill\nAnswered on Bitbucket pull request #2 (${SEEDED.url}): ${answer}`,
  );
  assert.deepEqual(jira.labels, [{ key: HRB2, present: false }]);
  const state = jira.states.get(HRB2);
  assert.deepEqual(state?.status === 'decided' ? state.answer : null, { kind: 'option', number: 2 });
  assert.equal(rest.posted(2).at(-1), `Decision by \`@Dana Okafor\`, relayed by shipmill\n\nAnswered on this pull request: ${answer}`);

  // Clears: the task is resolved and the merge check passes
  assert.equal(rest.taskById.get(task!.id)?.state, 'RESOLVED');
  assert.equal((await check(jira, rest)).success, true);

  // Nothing more happens: a later reply, a later sync
  const posted = rest.posted(2).length;
  assert.equal(await relayPullRequestComment(deps, 2, rest.reply(2, DANA, '1')), 'not-waiting');
  assert.equal(await syncQuestion(deps, SEEDED), 'up-to-date');
  assert.equal(rest.posted(2).length, posted);
});

test('a pull request is asked once, however often it is synced', async () => {
  const { rest, deps } = await seeded();
  assert.equal(await syncQuestion(deps, SEEDED), 'asked');
  assert.equal(await syncQuestion(deps, SEEDED), 'already-asked');
  assert.equal(rest.posted(2).length, 1);
  assert.equal((await rest.tasks(2)).length, 1);
});

test('a fresh claim by another invocation holds back a second question; a stale one does not', async () => {
  const { jira, rest, store, deps } = await seeded();
  const questionId = jira.states.get(HRB2)!.questionId;
  const claim = { status: 'asking' as const, key: HRB2, questionId, decider: DANA, options: 3, commentId: 0, taskId: 0, at: NOW().toISOString() };
  await store.set({ repository: REPOSITORY, id: 2 }, claim);
  assert.equal(await syncQuestion(deps, SEEDED), 'already-asked');
  assert.equal(rest.posted(2).length, 0);
  // The claim that held it back is left as it was
  assert.equal((await store.get({ repository: REPOSITORY, id: 2 }))?.status, 'asking');

  const stale = { ...claim, at: new Date(NOW().getTime() - STALE_CLAIM_MS - 1).toISOString() };
  await store.set({ repository: REPOSITORY, id: 2 }, stale);
  assert.equal(await syncQuestion(deps, SEEDED), 'asked');
  assert.equal(rest.posted(2).length, 1);
});

test('an answer given in Jira resolves the task on the pull request', async () => {
  const { jira, rest, deps } = await seeded();
  await syncQuestion(deps, SEEDED);
  const reply = jira.reply(HRB2, DANA, '1');
  assert.equal((await relayReply(HRB2, reply, { jira, reader: null, now: NOW })).relayed, true);

  assert.equal(await syncQuestion(deps, SEEDED), 'resolved');
  assert.match(rest.posted(2).at(-1)!, /^Decision by `@Dana Okafor`, relayed by shipmill\n\nAnswered in Jira: option 1, Move HRB-2 out of 2.4/);
  assert.deepEqual((await rest.tasks(2)).map((task) => task.state), ['RESOLVED']);
  assert.equal((await check(jira, rest)).success, true);
});

test('a reply on the pull request after Jira has the answer resolves the task there too', async () => {
  const { jira, rest, deps } = await seeded();
  await syncQuestion(deps, SEEDED);
  await relayReply(HRB2, jira.reply(HRB2, DANA, '1'), { jira, reader: null, now: NOW });
  assert.equal(await relayPullRequestComment(deps, 2, rest.reply(2, DANA, '3')), 'decided');
  assert.deepEqual((await rest.tasks(2)).map((task) => task.state), ['RESOLVED']);
  // Jira kept the first answer
  const state = jira.states.get(HRB2);
  assert.deepEqual(state?.status === 'decided' ? state.answer : null, { kind: 'option', number: 1 });
});

test('with the LLM off a reply without a number gets a note on the pull request and the question stays open', async () => {
  const { jira, rest, deps } = await seeded();
  await syncQuestion(deps, SEEDED);
  const inJira = jira.posted(HRB2).length;
  assert.equal(await relayPullRequestComment(deps, 2, rest.reply(2, DANA, 'Keep them, I think')), 'unread');
  assert.equal(
    rest.posted(2).at(-1),
    'shipmill read no option number in the reply by `@Dana Okafor`. Reply with a number from 1 to 3; the decision stays open until then.',
  );
  assert.equal(jira.posted(HRB2).length, inJira);
  assert.equal(jira.states.get(HRB2)?.status, 'waiting');
  assert.deepEqual((await rest.tasks(2)).map((task) => task.state), ['UNRESOLVED']);
});

test('the question and the app\'s own comments are not replies', async () => {
  const { rest, deps, store } = await seeded();
  await syncQuestion(deps, SEEDED);
  const question = (await store.get({ repository: REPOSITORY, id: 2 }))!.commentId;
  assert.equal(await relayPullRequestComment(deps, 2, question), 'not-newer');
  assert.equal(await relayPullRequestComment(deps, 2, rest.reply(2, APP, '1')), 'not-decider');
  assert.equal(await relayPullRequestComment(deps, 2, rest.reply(2, DANA, '   ')), 'empty');
});

test('a pull request with no work item or nothing asked gets nothing', async () => {
  const untitled = { ...SEEDED, title: 'Tidy the README' };
  const { rest, deps } = await seeded(untitled);
  assert.equal(await syncQuestion(deps, untitled), 'no-key');
  const unasked = { ...SEEDED, title: 'HRB-1 Adds a CSV export to the invoice list' };
  assert.equal(await syncQuestion(deps, unasked), 'nothing-asked');
  assert.equal(await relayPullRequestComment(deps, 2, rest.reply(2, DANA, '1')), 'no-question');
  assert.equal(rest.posted(2).length, 0);
});

test('a title moved to another work item drops the old task and asks the new decision', async () => {
  const { rest, deps } = await seeded();
  await syncQuestion(deps, SEEDED);
  const retitled = { ...SEEDED, title: 'HRB-3 Serves the new pricing page behind the new-pricing flag' };
  rest.pullRequests.set(2, retitled);
  assert.equal(await syncQuestion(deps, retitled), 'asked');
  const tasks = await rest.tasks(2);
  assert.deepEqual(tasks.map((task) => task.state), ['RESOLVED', 'UNRESOLVED']);
  assert.match(rest.posted(2).at(-1)!, /^@\{712020:dana\} Decision needed: show the new prices/);
});
