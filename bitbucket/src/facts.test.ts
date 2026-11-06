import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraKey, type JiraKey } from '@shipmill-atlassian/shared/jira-key';
import type { WorkItemStatus } from '@shipmill-atlassian/shared/work-item';
import { workspaceUuid, type BitbucketRest, type BuildStatus, type PullRequest, type Task } from './bitbucket-rest';
import { gatherFacts } from './facts';

const PULL_REQUEST: PullRequest = {
  id: 2,
  title: 'HRB-2 Retire API v1 tokens',
  url: 'https://bitbucket.org/shipmill-dev/harbor/pull-requests/2',
  repositorySlug: 'harbor',
  author: { accountId: 'sam', displayName: 'Sam Reyes' },
  sourceCommit: 'head',
  destinationBranch: 'main',
  destinationCommit: 'base',
  participants: [],
};

class FakeBitbucket implements BitbucketRest {
  readonly files = new Map<string, string>();
  readonly statusCalls: string[] = [];

  async pullRequest(): Promise<PullRequest> {
    return PULL_REQUEST;
  }
  async statuses(commit: string): Promise<BuildStatus[]> {
    this.statusCalls.push(commit);
    return [{ key: 'pipelines', name: 'Pipeline #7', state: 'SUCCESSFUL' }];
  }
  async tasks(): Promise<Task[]> {
    return [];
  }
  async file(commit: string, path: string): Promise<string | undefined> {
    return this.files.get(`${commit}:${path}`);
  }
}

const item = (key: JiraKey): Promise<WorkItemStatus> =>
  Promise.resolve({ key, found: true, summary: 'Retire API v1 tokens', fixVersions: ['2.4'], openDecisions: [], decider: null });

test('reads the policy and changelog at the destination, the build at the head commit', async () => {
  const rest = new FakeBitbucket();
  rest.files.set('base:shipmill.toml', '[lanes.stable]\n[changelog]\npath = "CHANGES.md"\n');
  rest.files.set('head:CHANGES.md', '## Unreleased\n### Breaking\n- v1 tokens are rejected\n');
  const asked: JiraKey[] = [];
  const facts = await gatherFacts(rest, (key) => (asked.push(key), item(key)), 2);
  assert.deepEqual(asked, [jiraKey('HRB-2')]);
  assert.deepEqual(rest.statusCalls, ['head']);
  assert.deepEqual(facts.lanes, ['stable']);
  assert.deepEqual(facts.breaking, ['v1 tokens are rejected']);
  assert.equal(facts.workItem?.key, 'HRB-2');
});

test('without shipmill.toml there is no lane, and a title without a key asks Jira nothing', async () => {
  const rest = new FakeBitbucket();
  const untitled = { ...PULL_REQUEST, title: 'Tidy the README' };
  rest.pullRequest = async () => untitled;
  const facts = await gatherFacts(rest, () => assert.fail('asked Jira'), 2);
  assert.equal(facts.lanes, null);
  assert.equal(facts.workItem, null);
});

test('the workspace comes as a uuid or an ARI', () => {
  const uuid = '{cc8e193d-7603-4dfd-8771-fcc8960aa0fb}';
  assert.equal(workspaceUuid(uuid), uuid);
  assert.equal(workspaceUuid('ari:cloud:bitbucket::workspace/cc8e193d-7603-4dfd-8771-fcc8960aa0fb'), uuid);
  assert.throws(() => workspaceUuid('shipmill-dev'));
});
