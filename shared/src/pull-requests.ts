import { list, natural, nonEmpty, object } from './parse';

// A Bitbucket pull request linked to a Jira work item, as the bridge reported it.
// The Jira dev-status API is closed to Forge apps, so the Jira app keeps these itself.
export type LinkedPullRequest = {
  workspace: string;
  repository: string;
  id: number;
  title: string;
  url: string;
};

function same(a: LinkedPullRequest, b: LinkedPullRequest): boolean {
  return a.workspace === b.workspace && a.repository === b.repository && a.id === b.id;
}

// Adds a pull request to a work item's list, or replaces the one with the same identity
// (a title edited since), keeping the order the pull requests were first seen in
export function remember(known: readonly LinkedPullRequest[], pullRequest: LinkedPullRequest): LinkedPullRequest[] {
  const index = known.findIndex((entry) => same(entry, pullRequest));
  if (index === -1) return [...known, pullRequest];
  return known.map((entry, at) => (at === index ? pullRequest : entry));
}

export function parseLinkedPullRequest(value: unknown, path: string): LinkedPullRequest {
  const fields = object(value, path);
  return {
    workspace: nonEmpty(fields.workspace, `${path}.workspace`),
    repository: nonEmpty(fields.repository, `${path}.repository`),
    id: natural(fields.id, `${path}.id`),
    title: nonEmpty(fields.title, `${path}.title`),
    url: nonEmpty(fields.url, `${path}.url`),
  };
}

export function parseLinkedPullRequests(value: unknown, path: string): LinkedPullRequest[] {
  return list(value, path, parseLinkedPullRequest);
}
