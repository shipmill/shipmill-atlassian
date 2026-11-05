import { kvs } from '@forge/kvs';
import type { JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { parseLinkedPullRequests, remember, type LinkedPullRequest } from '@shipmill-atlassian/shared/pull-requests';
import type { PullRequestLookup } from './reader';

// The pull requests the bridge linked to each work item, one KVS value per item. The Jira
// dev-status API is closed to Forge apps, so this is where the reader finds them.

function storageKey(key: JiraKey): string {
  return `pull-requests:${key}`;
}

export async function linkedPullRequests(key: JiraKey): Promise<LinkedPullRequest[]> {
  const stored = await kvs.get<unknown>(storageKey(key));
  return stored === undefined ? [] : parseLinkedPullRequests(stored, storageKey(key));
}

// Read, merge and write: two events for the same item at the same moment could drop one,
// which the next event for that pull request (an update, a reopen) puts back
export async function rememberLinkedPullRequest(key: JiraKey, pullRequest: LinkedPullRequest): Promise<void> {
  await kvs.set(storageKey(key), remember(await linkedPullRequests(key), pullRequest));
}

export const kvsPullRequests: PullRequestLookup = { forItem: linkedPullRequests };
