import { ParseError, list, natural, nonEmpty, object } from './parse';

// A Bitbucket pull request linked to a Jira work item, as the bridge reported it.
// The Jira dev-status API is closed to Forge apps, so the Jira app keeps these itself.
// repository is the repository's uuid, which identifies the pull request; repositorySlug is
// only its label, as Bitbucket shows it in the pull request's URL.
export type LinkedPullRequest = {
  workspace: string;
  repository: string;
  repositorySlug: string;
  id: number;
  title: string;
  url: string;
};

// How a pull request is named wherever the apps show it: "harbor #2"
export function pullRequestLabel(pullRequest: Pick<LinkedPullRequest, 'repositorySlug' | 'id'>): string {
  return `${pullRequest.repositorySlug} #${pullRequest.id}`;
}

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

const PULL_REQUEST_URL = /^https:\/\/bitbucket\.org\/[^/]+\/([^/]+)\/pull-requests\/(\d+)$/;

// Bitbucket Cloud also names a pull request by its workspace's and repository's uuids, as the
// Teamwork Graph's ExternalPullRequest.url does: https://bitbucket.org/{uuid}/{uuid}/pull-requests/5,
// the braces as they are or percent-encoded
const UUID_PULL_REQUEST_URL = /^https:\/\/bitbucket\.org\/(?:\{|%7B)([0-9a-f-]{36})(?:\}|%7D)\/(?:\{|%7B)([0-9a-f-]{36})(?:\}|%7D)\/pull-requests\/(\d+)$/i;

function bareUuid(text: string): string | undefined {
  return /^\{?([0-9a-f-]{36})\}?$/i.exec(text)?.[1]?.toLowerCase();
}

// The linked pull request a URL names: the one the bridge reported at that URL, or the one
// with the same workspace, repository and id when the URL names them by uuid. undefined when
// the bridge never reported it.
export function linkedByUrl(known: readonly LinkedPullRequest[], url: string): LinkedPullRequest | undefined {
  const exact = known.find((pullRequest) => pullRequest.url === url);
  if (exact !== undefined) return exact;
  const match = UUID_PULL_REQUEST_URL.exec(url);
  if (match === null) return undefined;
  const [, workspace, repository, id] = match;
  return known.find(
    (pullRequest) =>
      pullRequest.id === Number(id) &&
      bareUuid(pullRequest.workspace) === workspace!.toLowerCase() &&
      bareUuid(pullRequest.repository) === repository!.toLowerCase(),
  );
}

// Values stored before the bridge carried the slug have no repositorySlug field. They are
// migrated from their own URL, which names the repository by the same slug; a URL that is
// not that pull request's Bitbucket URL is an error, never a guess
function legacySlug(url: string, id: number, path: string): string {
  const match = PULL_REQUEST_URL.exec(url);
  if (match === null || Number(match[2]) !== id) {
    throw new ParseError(`${path}.repositorySlug`, `missing, and ${JSON.stringify(url)} is not the Bitbucket URL of pull request ${id}`);
  }
  return match[1]!;
}

export function parseLinkedPullRequest(value: unknown, path: string): LinkedPullRequest {
  const fields = object(value, path);
  const id = natural(fields.id, `${path}.id`);
  const url = nonEmpty(fields.url, `${path}.url`);
  return {
    workspace: nonEmpty(fields.workspace, `${path}.workspace`),
    repository: nonEmpty(fields.repository, `${path}.repository`),
    repositorySlug: 'repositorySlug' in fields ? nonEmpty(fields.repositorySlug, `${path}.repositorySlug`) : legacySlug(url, id, path),
    id,
    title: nonEmpty(fields.title, `${path}.title`),
    url,
  };
}

export function parseLinkedPullRequests(value: unknown, path: string): LinkedPullRequest[] {
  return list(value, path, parseLinkedPullRequest);
}
