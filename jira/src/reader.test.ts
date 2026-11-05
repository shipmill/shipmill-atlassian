import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraKey, projectKey } from '@shipmill-atlassian/shared/jira-key';
import { RecordedJira, RecordedPullRequests, SEED_PROJECT, SEED_VERSION, seedRelease } from './fixtures';
import { readRelease, releaseJql } from './reader';

test('reads every work item of the fix version across search pages', async () => {
  const jira = new RecordedJira();
  const release = await readRelease(jira, new RecordedPullRequests(), SEED_PROJECT, SEED_VERSION);
  assert.equal(release.items.length, 20);
  assert.deepEqual(
    jira.searches.map((search) => search.nextPageToken),
    [undefined, 'page-2'],
  );
  assert.equal(jira.searches[0]?.jql, 'project = "HRB" AND fixVersion = "2.4" ORDER BY key ASC');
});

test('an item carries its owner, labels, description, comments, links and pull requests', async () => {
  const release = await seedRelease();
  const tokens = release.items.find((item) => item.key === 'HRB-2');
  assert.equal(tokens?.owner?.displayName, 'Dana Okafor');
  assert.deepEqual(tokens?.labels, ['needs-decision']);
  assert.match(tokens?.description ?? '', /^Decision needed: retire v1 tokens in 2\.4/);
  assert.equal(tokens?.statusCategory, 'indeterminate');
  assert.deepEqual(tokens?.pullRequests.map((pr) => pr.id), [2]);

  const migration = release.items.find((item) => item.key === 'HRB-4');
  assert.equal(migration?.comments.length, 1);
  assert.match(migration?.comments[0]?.text ?? '', /^Do we run this migration during the 2\.4 rollout/);
  assert.deepEqual(migration?.links, [
    { relation: 'blocks', key: 'HRB-12', summary: 'Archive invoices in bulk', statusCategory: 'new' },
  ]);

  const okta = release.items.find((item) => item.key === 'HRB-9');
  assert.equal(okta?.owner, null);
  assert.deepEqual(okta?.pullRequests, []);
});

test('pages through comments past the ones the search embeds', async () => {
  const author = { accountId: 'a', displayName: 'A' };
  const body = (text: string) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  const entry = (id: number) => ({ id: String(id), author, body: body(`comment ${id}`), created: '2026-11-03T09:00:00.000+0000' });
  const issue = {
    key: 'KAN-1',
    fields: {
      summary: 'One',
      description: null,
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      labels: [],
      assignee: null,
      reporter: author,
      issuelinks: [],
      comment: { comments: [entry(1)], total: 3, startAt: 0, maxResults: 1 },
    },
  };
  const jira = {
    calls: [] as number[],
    async search() {
      return { issues: [issue], isLast: true };
    },
    async comments(_key: unknown, startAt: number) {
      this.calls.push(startAt);
      return startAt === 0 ? { comments: [entry(1), entry(2)] } : { comments: [entry(3)] };
    },
  };
  const release = await readRelease(jira, { forItem: async () => [] }, projectKey('KAN'), '1.0');
  assert.deepEqual(release.items[0]?.comments.map((comment) => comment.text), ['comment 1', 'comment 2', 'comment 3']);
  assert.deepEqual(jira.calls, [0, 2]);
  assert.equal(release.items[0]?.description, '');
});

test('fails on a work item out of shape instead of skipping it', async () => {
  const jira = {
    async search() {
      return { issues: [{ key: 'KAN-1', fields: { summary: 'One' } }], isLast: true };
    },
    async comments() {
      throw new Error('not called');
    },
  };
  await assert.rejects(readRelease(jira, { forItem: async () => [] }, projectKey('KAN'), '1.0'), /KAN-1.*status/);
});

test('quotes the version in the JQL', () => {
  assert.equal(releaseJql(projectKey('KAN'), '2.4 "beta"'), 'project = "KAN" AND fixVersion = "2.4 \\"beta\\"" ORDER BY key ASC');
  assert.equal(jiraKey('KAN-4'), 'KAN-4');
});
