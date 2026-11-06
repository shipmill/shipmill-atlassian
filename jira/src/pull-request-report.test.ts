import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraKey } from '@shipmill-atlassian/shared/jira-key';
import { parsePullRequestReport } from '@shipmill-atlassian/shared/pull-request-decisions';
import { NEEDS_DECISION, type Release } from '@shipmill-atlassian/shared/release';
import { seedRelease } from './fixtures';
import { findDecisions, pullRequestDecisions, releaseReady } from './finder';
import { FakeReports } from './fake-reports';
import { recordReport, reportKey, reportsFor } from './pull-request-report';

const WORKSPACE = '{4c16a397-8e48-479c-8ca2-442e46c90570}';
const REPOSITORY = '{15a31549-1cff-45dc-9d0d-310114c5038b}';
const PR1 = { workspace: WORKSPACE, repository: REPOSITORY, repositorySlug: 'harbor', id: 1, title: 'HRB-1 Adds a CSV export to the invoice list', url: 'https://bitbucket.org/shipmill-dev/harbor/pull-requests/1' };
const QUESTION = { taskId: 41, question: 'export every column, or only the visible ones?' };

// The seed release once HRB-2 and HRB-3 are decided and HRB-4's question is asked and answered:
// nothing on the work items blocks it
async function decidedRelease(): Promise<Release> {
  const release = await seedRelease();
  return { ...release, items: release.items.map((item) => ({ ...item, labels: item.labels.filter((label) => label !== NEEDS_DECISION) })) };
}

async function blockers(release: Release, store: FakeReports) {
  const decisions = await findDecisions(release, { llm: false, implicit: { find: async () => [] } });
  const keys = new Set(release.items.map((item) => item.key));
  const onPullRequests = pullRequestDecisions(release.items, reportsFor(await store.all(), keys));
  return { decisions, onPullRequests, ready: releaseReady(decisions, onPullRequests) };
}

test('a decision opened on a pull request blocks the release, and resolving it clears the block', async () => {
  const release = await decidedRelease();
  const store = new FakeReports();
  assert.equal((await blockers(release, store)).ready, true);

  assert.deepEqual(await recordReport({ ...PR1, open: [QUESTION] }, { store, link: store.link }), { key: 'HRB-1', open: 1 });
  const blocked = await blockers(release, store);
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.decisions, []);
  assert.deepEqual(blocked.onPullRequests, [
    { key: 'HRB-1', question: QUESTION.question, pullRequest: { ...PR1 }, taskId: 41, askOf: release.items[0]?.owner ?? release.items[0]?.reporter },
  ]);
  assert.deepEqual(store.linked, [{ key: 'HRB-1', pullRequest: PR1 }]);

  assert.deepEqual(await recordReport({ ...PR1, open: [] }, { store, link: store.link }), { key: 'HRB-1', open: 0 });
  assert.equal((await blockers(release, store)).ready, true);
  assert.equal(store.values.size, 0);
});

test('the decisions move with the work item a retitled pull request names', async () => {
  const release = await decidedRelease();
  const store = new FakeReports();
  await recordReport({ ...PR1, open: [QUESTION] }, { store, link: store.link });
  await recordReport({ ...PR1, title: 'HRB-5 Adds a CSV export', open: [QUESTION] }, { store, link: store.link });
  assert.deepEqual((await blockers(release, store)).onPullRequests.map((d) => d.key), ['HRB-5']);
  // A title that names no work item files the decisions nowhere
  assert.deepEqual(await recordReport({ ...PR1, title: 'Adds a CSV export', open: [QUESTION] }, { store, link: store.link }), { key: null, open: 0 });
  assert.equal((await blockers(release, store)).ready, true);
});

test('a pull request of a work item in another release does not block this one', async () => {
  const release = await decidedRelease();
  const store = new FakeReports();
  await recordReport({ ...PR1, title: 'HRB-99 Something for 2.5', open: [QUESTION] }, { store, link: store.link });
  assert.equal((await blockers(release, store)).ready, true);
});

test('the release is not ready while a work item still waits, whatever its pull requests say', async () => {
  const { ready, decisions } = await blockers(await seedRelease(), new FakeReports());
  assert.equal(ready, false);
  assert.deepEqual(decisions.map((d) => d.key), [jiraKey('HRB-2'), jiraKey('HRB-3')]);
});

test('a report key names the pull request by bare uuids, braces or not', () => {
  const bare = reportKey(WORKSPACE.slice(1, -1), REPOSITORY.slice(1, -1).toUpperCase(), 1);
  assert.equal(reportKey(WORKSPACE, REPOSITORY, 1), bare);
  assert.match(bare, /^pull-request-decisions:[0-9a-f-]{36}:[0-9a-f-]{36}:1$/);
  assert.throws(() => reportKey('shipmill-dev', REPOSITORY, 1), /not a Bitbucket uuid/);
});

test('a kept report with nothing open is refused', () => {
  assert.throws(() => parsePullRequestReport({ key: 'HRB-1', pullRequest: PR1, open: [] }, 'r'), /at least one open decision/);
});
