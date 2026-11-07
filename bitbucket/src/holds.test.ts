import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraKey } from '@shipmill-atlassian/shared/jira-key';
import type { WorkItemStatus } from '@shipmill-atlassian/shared/work-item';
import type { PullRequest } from './bitbucket-rest';
import { card, checkResult, holds, verdictLine, type Facts } from './holds';

const DANA = { accountId: '712020:dana', displayName: 'Dana Okafor' };
const SAM = { accountId: '712020:sam', displayName: 'Sam Reyes' };

const PULL_REQUEST: PullRequest = {
  id: 2,
  title: 'HRB-2 Retire API v1 tokens',
  url: 'https://bitbucket.org/shipmill-dev/harbor/pull-requests/2',
  repositorySlug: 'harbor',
  author: SAM,
  sourceCommit: '0123456789abcdef',
  destinationBranch: 'main',
  destinationCommit: 'fedcba9876543210',
  participants: [],
};

const ITEM: WorkItemStatus = {
  key: jiraKey('HRB-2'),
  found: true,
  summary: 'Retire API v1 tokens',
  fixVersions: ['2.4'],
  openDecisions: [],
  decider: DANA,
};

// A pull request nothing holds: its item has no open decision, the build is green, nothing breaks
const CLEAR: Facts = {
  pullRequest: PULL_REQUEST,
  workItem: ITEM,
  statuses: [{ key: 'pipelines', name: 'Pipeline #7', state: 'SUCCESSFUL' }],
  tasks: [],
  breaking: [],
  lanes: ['stable'],
};

const kinds = (facts: Facts) => holds(facts).map((hold) => hold.kind);

test('a pull request with nothing open passes the check', () => {
  assert.deepEqual(holds(CLEAR), []);
  const result = checkResult(CLEAR);
  assert.equal(result.success, true);
  assert.match(result.message, /clear to merge.*0123456789ab/);
});

test('an open decision on the work item fails the check, and passes once decided', () => {
  const open: Facts = { ...CLEAR, workItem: { ...ITEM, openDecisions: ['retire v1 tokens in 2.4, or keep them?'] } };
  assert.deepEqual(holds(open), [
    { kind: 'decision', message: 'HRB-2 waits on a decision: retire v1 tokens in 2.4, or keep them?', waitsOn: 'Dana Okafor' },
  ]);
  assert.equal(checkResult(open).success, false);
  assert.equal(checkResult({ ...open, workItem: ITEM }).success, true);
});

test('an unresolved decision task on the pull request fails the check, and passes once resolved', () => {
  const asked: Facts = { ...CLEAR, tasks: [{ id: 1, state: 'UNRESOLVED', text: 'Decision needed: keep the v1\nendpoint as a redirect?' }] };
  assert.deepEqual(holds(asked), [
    { kind: 'decision', message: 'this pull request waits on a decision: keep the v1 endpoint as a redirect?', waitsOn: 'Dana Okafor' },
  ]);
  assert.equal(checkResult({ ...asked, tasks: [{ id: 1, state: 'RESOLVED', text: 'Decision needed: keep the v1 endpoint as a redirect?' }] }).success, true);
});

test('a decision task asking the work item\'s own open decision is one hold, not two', () => {
  const question = 'retire v1 tokens in 2.4, or keep them?';
  const both: Facts = {
    ...CLEAR,
    workItem: { ...ITEM, openDecisions: [question] },
    tasks: [{ id: 3, state: 'UNRESOLVED', text: `Decision needed: ${question}` }],
  };
  assert.deepEqual(holds(both), [{ kind: 'decision', message: `HRB-2 waits on a decision: ${question}`, waitsOn: 'Dana Okafor' }]);
});

test('an ordinary task is not a decision', () => {
  assert.deepEqual(holds({ ...CLEAR, tasks: [{ id: 2, state: 'UNRESOLVED', text: 'Rename the variable' }] }), []);
});

test('a build that is not green on the head commit fails the check, and passes once green', () => {
  const failed: Facts = { ...CLEAR, statuses: [{ key: 'pipelines', name: 'Pipeline #7', state: 'FAILED' }] };
  assert.deepEqual(holds(failed), [{ kind: 'build', message: 'build Pipeline #7 is failed on 0123456789ab', waitsOn: 'Sam Reyes' }]);
  const running: Facts = { ...CLEAR, statuses: [{ key: 'pipelines', name: 'Pipeline #8', state: 'INPROGRESS' }] };
  assert.deepEqual(holds(running), [{ kind: 'build', message: 'build Pipeline #8 is still running on 0123456789ab', waitsOn: 'the build' }]);
  assert.equal(checkResult(failed).success, false);
  assert.equal(checkResult(CLEAR).success, true);
});

test('a head commit no build reported on fails the check', () => {
  assert.deepEqual(holds({ ...CLEAR, statuses: [] }), [{ kind: 'build', message: 'no build has reported on 0123456789ab', waitsOn: 'the build' }]);
});

test('one green build and one stopped build still fails', () => {
  const statuses = [...CLEAR.statuses, { key: 'lint', name: 'lint', state: 'STOPPED' as const }];
  assert.deepEqual(kinds({ ...CLEAR, statuses }), ['build']);
});

test('an undecided breaking change fails the check, and passes once the decider approves', () => {
  const breaking: Facts = { ...CLEAR, breaking: ['API v1 tokens are rejected'] };
  assert.deepEqual(holds(breaking), [
    {
      kind: 'breaking',
      message: 'the breaking change "API v1 tokens are rejected" is undecided: Dana Okafor has not approved it',
      waitsOn: 'Dana Okafor',
    },
  ]);
  const approvedBySomeoneElse = { ...PULL_REQUEST, participants: [{ ...SAM, approved: true }, { ...DANA, approved: false }] };
  assert.equal(checkResult({ ...breaking, pullRequest: approvedBySomeoneElse }).success, false);
  const approvedByDecider = { ...PULL_REQUEST, participants: [{ ...DANA, approved: true }] };
  assert.equal(checkResult({ ...breaking, pullRequest: approvedByDecider }).success, true);
});

test('a breaking change with no work item has nobody to decide it', () => {
  const orphan: Facts = { ...CLEAR, workItem: null, breaking: ['Drops Node 20'] };
  assert.deepEqual(holds(orphan), [
    {
      kind: 'breaking',
      message: 'the breaking change "Drops Node 20" is undecided: nobody can decide it yet',
      waitsOn: 'a decider: name a Jira work item in the title',
    },
  ]);
});

test('a key the paired site does not have holds the pull request on its author', () => {
  assert.deepEqual(holds({ ...CLEAR, workItem: { key: jiraKey('HRB-99'), found: false } }), [
    { kind: 'work-item', message: 'HRB-99 is not a work item on the paired Jira site', waitsOn: 'Sam Reyes' },
  ]);
});

test('a failed check is worded as advice and names who it waits on once each', () => {
  const both: Facts = {
    ...CLEAR,
    workItem: { ...ITEM, openDecisions: ['first?', 'second?'] },
    statuses: [],
  };
  const result = checkResult(both);
  assert.equal(result.success, false);
  assert.match(result.message, /^shipmill advises waiting: /);
  assert.match(result.message, /Waits on Dana Okafor, the build\./);
  assert.match(result.message, /only where the check is Required \(Bitbucket Premium\)$/);
});

test('the card shows the release, the lane and who the pull request waits on', () => {
  assert.deepEqual(card({ ...CLEAR, workItem: { ...ITEM, openDecisions: ['retire v1 tokens?'] } }), {
    workItem: { key: 'HRB-2', summary: 'Retire API v1 tokens' },
    release: '2.4',
    lane: 'stable',
    waitsOn: ['Dana Okafor'],
    holds: ['HRB-2 waits on a decision: retire v1 tokens?'],
  });
  assert.deepEqual(card(CLEAR).waitsOn, []);
});

test('the card says why a release or lane is missing', () => {
  const none = card({ ...CLEAR, workItem: null, lanes: null });
  assert.equal(none.release, 'none: the title names no Jira work item');
  assert.equal(none.lane, 'none: main has no shipmill.toml');
  const elsewhere = card({ ...CLEAR, workItem: { ...ITEM, fixVersions: [] }, lanes: [] });
  assert.equal(elsewhere.release, 'none: HRB-2 has no fix version');
  assert.equal(elsewhere.lane, 'none: main is not released by shipmill');
});

test('the verdict line names the pull request, its head, the trigger and each hold', () => {
  assert.equal(verdictLine(CLEAR, 'on-code-pushed'), 'merge check harbor #2 at 0123456789ab (on-code-pushed): pass; clear to merge');
  const held: Facts = { ...CLEAR, statuses: [], breaking: ['Drop API v1 tokens'] };
  assert.equal(
    verdictLine(held, 'on-merge'),
    'merge check harbor #2 at 0123456789ab (on-merge): hold build,breaking; build: no build has reported on 0123456789ab; ' +
      'breaking: the breaking change "Drop API v1 tokens" is undecided: Dana Okafor has not approved it',
  );
});
