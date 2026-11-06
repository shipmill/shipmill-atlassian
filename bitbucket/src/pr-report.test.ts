import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decode, encode } from '@shipmill-atlassian/shared/bridge';
import { jiraKey } from '@shipmill-atlassian/shared/jira-key';
import { parseReportOutcome } from '@shipmill-atlassian/shared/pull-request-decisions';
import { pullRequestLabel } from '@shipmill-atlassian/shared/pull-requests';
import { NEEDS_DECISION, type Release } from '@shipmill-atlassian/shared/release';
import { FakeReports } from '../../jira/src/fake-reports';
import { seedRelease } from '../../jira/src/fixtures';
import { findDecisions, pullRequestDecisions, releaseReady } from '../../jira/src/finder';
import { recordReport, reportsFor } from '../../jira/src/pull-request-report';
import type { PullRequest } from './bitbucket-rest';
import { FakeQuestions, FakeRepository, REPOSITORY } from './fake-bitbucket';
import { braced, openDecisions, reportDecisions, type ReportToJira } from './pr-report';
import type { PullRequestQuestion } from './question-store';

// A seeded pull request against the Jira app's own report store and finder, over the signed
// bridge: a decision opened on the pull request makes release 2.4 not ready in Jira, and
// resolving it makes the release ready again.

const NOW = new Date('2026-12-03T11:00:00.000Z');
const SECRET = 'a-shared-secret';
const WORKSPACE = '{4c16a397-8e48-479c-8ca2-442e46c90570}';
const SAM = { accountId: '712020:sam', displayName: 'Sam Reyes' };
const DANA = { accountId: '712020:dana', displayName: 'Dana Okafor' };

const SEEDED: PullRequest = {
  id: 1,
  title: 'HRB-1 Adds a CSV export to the invoice list',
  url: 'https://bitbucket.org/shipmill-dev/harbor/pull-requests/1',
  repositorySlug: 'harbor',
  author: SAM,
  sourceCommit: '0123456789abcdef',
  destinationBranch: 'main',
  destinationCommit: 'fedcba9876543210',
  participants: [],
};

// The Jira app on the other end of the signed bridge, messages encoded and decoded as sent
function bridged(reports: FakeReports): ReportToJira {
  return async (report) => {
    const { body, signature } = encode(SECRET, { kind: 'pullrequest-decisions', sentAt: NOW.getTime(), ...report });
    const message = decode(SECRET, body, signature, NOW.getTime());
    if (message.kind !== 'pullrequest-decisions') throw new Error(`sent a decisions report, decoded ${message.kind}`);
    const outcome = await recordReport(message, { store: reports, link: reports.link });
    return parseReportOutcome(JSON.parse(JSON.stringify(outcome)));
  };
}

// Release 2.4 once its work items' own decisions are answered
async function decidedRelease(): Promise<Release> {
  const release = await seedRelease();
  return { ...release, items: release.items.map((item) => ({ ...item, labels: item.labels.filter((label) => label !== NEEDS_DECISION) })) };
}

// What the Jira app's release read says: ready, and what blocks it
async function jiraSees(release: Release, reports: FakeReports) {
  const decisions = await findDecisions(release, { llm: false, implicit: { find: async () => [] } });
  const onPullRequests = pullRequestDecisions(release.items, reportsFor(await reports.all(), new Set(release.items.map((item) => item.key))));
  return { ready: releaseReady(decisions, onPullRequests), blockers: onPullRequests.map((d) => `${d.key} #${d.pullRequest.id}: ${d.question}`) };
}

test('a decision opened on a seeded pull request makes the release not ready in Jira, and resolving it makes it ready', async () => {
  const release = await decidedRelease();
  const repository = new FakeRepository(SEEDED);
  const store = new FakeQuestions();
  const reports = new FakeReports();
  const deps = { report: bridged(reports), store, workspace: WORKSPACE, repository: REPOSITORY };
  assert.equal((await jiraSees(release, reports)).ready, true);

  const comment = repository.reply(1, DANA, 'Should the export carry every column?');
  const task = await repository.createTask(1, 'Decision needed: export every column, or only the visible ones?', comment);
  assert.deepEqual(await reportDecisions(deps, SEEDED, await repository.tasks(1)), { key: jiraKey('HRB-1'), open: 1 });
  assert.deepEqual(await jiraSees(release, reports), { ready: false, blockers: ['HRB-1 #1: export every column, or only the visible ones?'] });

  await repository.resolveTask(1, task);
  assert.deepEqual(await reportDecisions(deps, SEEDED, await repository.tasks(1)), { key: jiraKey('HRB-1'), open: 0 });
  assert.deepEqual(await jiraSees(release, reports), { ready: true, blockers: [] });
});

test('the report names the pull request by braced uuids, so the card and the events agree', async () => {
  const reports = new FakeReports();
  const deps = { report: bridged(reports), store: new FakeQuestions(), workspace: WORKSPACE.slice(1, -1), repository: REPOSITORY.slice(1, -1) };
  await reportDecisions(deps, SEEDED, [{ id: 7, state: 'UNRESOLVED', text: 'Decision needed: ship it?' }]);
  assert.deepEqual(reports.linked.map((entry) => [entry.pullRequest.workspace, entry.pullRequest.repository]), [[WORKSPACE, REPOSITORY]]);
  // The uuid identifies it, the slug carried next to it labels it in the release panel
  assert.deepEqual(reports.linked.map((entry) => pullRequestLabel(entry.pullRequest)), ['harbor #1']);
  assert.equal(braced(REPOSITORY.toUpperCase()), REPOSITORY);
  assert.throws(() => braced('harbor'), /not a Bitbucket uuid/);
});

test('only unresolved decision tasks count, less the one shipmill opened for the work item', () => {
  const asked: PullRequestQuestion = {
    status: 'waiting',
    key: jiraKey('HRB-2'),
    questionId: '10200' as PullRequestQuestion['questionId'],
    decider: DANA,
    options: 3,
    commentId: 600,
    taskId: 601,
    at: NOW.toISOString(),
  };
  const tasks = [
    { id: 601, state: 'UNRESOLVED' as const, text: 'Decision needed: retire v1 tokens in 2.4, or keep them?' },
    { id: 602, state: 'UNRESOLVED' as const, text: 'Decision needed:  flag the\nmigration?' },
    { id: 603, state: 'RESOLVED' as const, text: 'Decision needed: drop the old index?' },
    { id: 604, state: 'UNRESOLVED' as const, text: 'Update the changelog' },
  ];
  assert.deepEqual(openDecisions(tasks, asked), [{ taskId: 602, question: 'flag the migration?' }]);
  assert.deepEqual(openDecisions(tasks, undefined).map((task) => task.taskId), [601, 602]);
});
