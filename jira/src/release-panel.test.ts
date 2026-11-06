import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraKey } from '@shipmill-atlassian/shared/jira-key';
import { NEEDS_DECISION, commentId, type Release } from '@shipmill-atlassian/shared/release';
import { askDecisions } from './ask';
import { FakeJira, LEAD } from './fake-jira';
import { seedRelease } from './fixtures';
import { findDecisions, type Decision } from './finder';
import { templatePreparer } from './prepare';
import { relayPullRequestReply } from './pull-request-decision';
import { relayReply } from './relay';
import { openVersions, parseFixVersions, releasePanel } from './release-panel';

const HRB2 = jiraKey('HRB-2');
const HRB3 = jiraKey('HRB-3');
const HRB4 = jiraKey('HRB-4');

// A clock a minute apart per call, so each decision is asked at its own time
function ticking(start: string): () => Date {
  let at = Date.parse(start);
  return () => new Date((at += 60_000));
}

// The release as the reader would see it again: the labels the app added or removed applied
function relabelled(release: Release, jira: FakeJira): Release {
  return {
    ...release,
    items: release.items.map((item) => {
      let labels = item.labels;
      for (const change of jira.labels.filter((entry) => entry.key === item.key)) {
        labels = change.present ? [...new Set([...labels, NEEDS_DECISION])] : labels.filter((label) => label !== NEEDS_DECISION);
      }
      return { ...item, labels };
    }),
  };
}

// The seed's three decisions: HRB-2 and HRB-3 labelled, and HRB-4's unanswered comment, which
// the LLM finds (recorded here, so no LLM call). HRB-4 is asked first, so oldest first is not key order.
const IMPLICIT: Decision = {
  key: HRB4,
  source: 'llm',
  question: 'Run the invoices migration during the 2.4 rollout or in a separate maintenance window?',
  evidence: { kind: 'comment', id: commentId('10101') },
  askOf: null,
};

async function askedSeed(): Promise<{ release: Release; jira: FakeJira }> {
  const release = await seedRelease();
  const labelled = await findDecisions(release, { llm: false, implicit: { find: async () => [] } });
  const jira = new FakeJira();
  await askDecisions(release, [IMPLICIT, ...labelled], { jira, preparer: templatePreparer, now: ticking('2026-12-03T09:00:00.000Z') });
  return { release: relabelled(release, jira), jira };
}

test('on the seed the panel lists the three decisions oldest first, who each waits on, and their pull requests', async () => {
  const { release, jira } = await askedSeed();
  const panel = await releasePanel(release, jira);
  assert.equal(panel.ready, false);
  assert.deepEqual(
    panel.decisions.map((decision) => [decision.key, decision.waitsOn.displayName, decision.askedAt]),
    [
      [HRB4, LEAD.displayName, '2026-12-03T09:01:00.000Z'],
      [HRB2, 'Dana Okafor', '2026-12-03T09:02:00.000Z'],
      [HRB3, (await jira.state(HRB3))!.decider.displayName, '2026-12-03T09:03:00.000Z'],
    ],
  );
  const hrb2 = panel.decisions[1]!;
  assert.equal(hrb2.question, 'retire v1 tokens in 2.4, or keep them for one more release?');
  assert.equal(hrb2.summary, 'Retire API v1 tokens');
  assert.deepEqual(
    hrb2.pullRequests.map((pullRequest) => [pullRequest.repository, pullRequest.id]),
    (await seedRelease()).items.find((item) => item.key === HRB2)!.pullRequests.map((pullRequest) => [pullRequest.repository, pullRequest.id]),
  );
  assert.ok(hrb2.pullRequests.length > 0, 'the seed links a pull request to HRB-2');
});

test('on the seed the panel shows ready to ship once the decisions are answered in Jira and on a pull request', async () => {
  const { release: before, jira } = await askedSeed();
  const now = ticking('2026-12-03T12:00:00.000Z');
  for (const key of [HRB3, HRB4]) {
    const state = (await jira.state(key))!;
    const outcome = await relayReply(key, jira.reply(key, state.decider, '1'), { jira, reader: null, now });
    assert.equal(outcome.relayed, true, `${key}: ${JSON.stringify(outcome)}`);
  }
  // Still blocked on HRB-2 alone
  const midway = await releasePanel(relabelled(before, jira), jira);
  assert.deepEqual(midway.decisions.map((decision) => decision.key), [HRB2]);
  assert.equal(midway.ready, false);

  // HRB-2 answered on its pull request in Bitbucket
  const state = (await jira.state(HRB2))!;
  const pullRequest = before.items.find((item) => item.key === HRB2)!.pullRequests[0]!;
  const outcome = await relayPullRequestReply(
    { kind: 'decision-reply', sentAt: now().getTime(), key: HRB2, questionId: state.questionId, author: state.decider, text: '2', pullRequest: { id: pullRequest.id, url: pullRequest.url } },
    { jira, reader: null, now },
  );
  assert.equal(outcome.relayed, true, JSON.stringify(outcome));
  const after = await releasePanel(relabelled(before, jira), jira);
  assert.deepEqual(after.decisions, []);
  assert.equal(after.ready, true);
});

test('a labelled item not asked yet comes last, with the finder question and the person shipmill will ask', async () => {
  const release = await seedRelease();
  const jira = new FakeJira();
  const labelled = await findDecisions(release, { llm: false, implicit: { find: async () => [] } });
  // Only HRB-3 asked; HRB-2 is labelled and waits to be asked
  await askDecisions(release, labelled.filter((decision) => decision.key === HRB3), {
    jira,
    preparer: templatePreparer,
    now: ticking('2026-12-03T09:00:00.000Z'),
  });
  const panel = await releasePanel(release, jira);
  assert.deepEqual(
    panel.decisions.map((decision) => [decision.key, decision.askedAt === null]),
    [
      [HRB3, false],
      [HRB2, true],
    ],
  );
  const hrb2 = panel.decisions[1]!;
  assert.equal(hrb2.question, labelled.find((decision) => decision.key === HRB2)!.question);
  assert.equal(hrb2.waitsOn.displayName, 'Dana Okafor');
});

test('a labelled item with nobody on it waits on the project lead, asked once', async () => {
  const release = await seedRelease();
  const nobody: Release = {
    ...release,
    items: release.items.map((item) => (item.key === HRB2 || item.key === HRB3 ? { ...item, owner: null, reporter: null } : item)),
  };
  const jira = new FakeJira();
  const panel = await releasePanel(nobody, jira);
  assert.deepEqual(
    panel.decisions.map((decision) => decision.waitsOn),
    [LEAD, LEAD],
  );
  assert.equal(jira.leadCalls, 1);
});

test('a release with no labelled item is ready to ship', async () => {
  const release = await seedRelease();
  const clear: Release = { ...release, items: release.items.map((item) => ({ ...item, labels: [] })) };
  const panel = await releasePanel(clear, new FakeJira());
  assert.deepEqual(panel, { project: release.project, version: '2.4', decisions: [], ready: true });
});

test('the picker offers the fix versions neither released nor archived, in Jira order', () => {
  const versions = parseFixVersions(
    [
      { id: '1', name: '2.3', released: true, archived: false },
      { id: '2', name: '2.4', released: false, archived: false },
      { id: '3', name: '2.4.1', released: false, archived: true },
      { id: '4', name: '2.5', released: false, archived: false },
    ],
    'versions',
  );
  assert.deepEqual(openVersions(versions), ['2.4', '2.5']);
  assert.throws(() => parseFixVersions([{ name: '2.4', released: 'no', archived: false }], 'versions'), /versions\[0\]\.released/);
});

