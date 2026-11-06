import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { jiraKey, type JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { RecordedJira, RecordedPullRequests } from './fixtures';
import type { IssueRest } from './jira-rest';
import { workItemStatus } from './work-item';

// Serves the seed's work items one at a time, as GET /issue/{key} returns them
class RecordedIssues implements IssueRest {
  readonly #byKey = new Map<string, Record<string, unknown>>();

  constructor() {
    const page = JSON.parse(readFileSync(new URL('./fixtures/release-2.4/search-page-1.json', import.meta.url), 'utf8')) as {
      issues: { key: string; fields: Record<string, unknown> }[];
    };
    for (const issue of page.issues) {
      this.#byKey.set(issue.key, { ...issue, fields: { ...issue.fields, fixVersions: [{ id: '1', name: '2.4' }] } });
    }
  }

  async issue(key: JiraKey, fields: string[]): Promise<unknown> {
    assert.ok(fields.includes('fixVersions'));
    return this.#byKey.get(key);
  }
}

const status = (key: string) => workItemStatus(new RecordedJira(), new RecordedIssues(), new RecordedPullRequests(), jiraKey(key));

test('a labelled work item reports its open decision, release and decider', async () => {
  assert.deepEqual(await status('HRB-2'), {
    key: 'HRB-2',
    found: true,
    summary: 'Retire API v1 tokens',
    fixVersions: ['2.4'],
    openDecisions: ['retire v1 tokens in 2.4, or keep them for one more release?'],
    decider: { accountId: '712020:dana', displayName: 'Dana Okafor' },
  });
});

test('an unlabelled work item has no open decision, even with an unanswered question', async () => {
  const migration = await status('HRB-4');
  assert.ok(migration.found);
  assert.deepEqual(migration.openDecisions, []);
});

test('a key the site does not have is reported as not found', async () => {
  assert.deepEqual(await status('HRB-999'), { key: 'HRB-999', found: false });
});
