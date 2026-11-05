import api, { assumeTrustedRoute, route, routeFromAbsolute, type Route } from '@forge/api';
import { ParseError, boolean, list, natural, nonEmpty, object, oneOf, string, type Fields } from '@shipmill-atlassian/shared/parse';

// The Bitbucket REST calls the merge check and the card make, as an interface so tests
// replay recorded bodies. The parsers are strict: a field out of shape is an error.

export type Account = { accountId: string; displayName: string };

export type Participant = Account & { approved: boolean };

export type PullRequest = {
  id: number;
  title: string;
  url: string;
  author: Account;
  // The head commit of the source branch, which the build must be green on
  sourceCommit: string;
  destinationBranch: string;
  destinationCommit: string;
  participants: Participant[];
};

export const BUILD_STATES = ['SUCCESSFUL', 'FAILED', 'INPROGRESS', 'STOPPED'] as const;
export type BuildState = (typeof BUILD_STATES)[number];
export type BuildStatus = { key: string; name: string; state: BuildState };

export const TASK_STATES = ['RESOLVED', 'UNRESOLVED'] as const;
export type Task = { state: (typeof TASK_STATES)[number]; text: string };

export interface BitbucketRest {
  pullRequest(id: number): Promise<PullRequest>;
  statuses(commit: string): Promise<BuildStatus[]>;
  tasks(pullRequest: number): Promise<Task[]>;
  // A file's text at a commit, or undefined when the commit has no such file
  file(commit: string, path: string): Promise<string | undefined>;
}

function account(value: unknown, path: string): Account {
  const fields = object(value, path);
  return { accountId: nonEmpty(fields.account_id, `${path}.account_id`), displayName: nonEmpty(fields.display_name, `${path}.display_name`) };
}

function commitOf(side: unknown, path: string): { branch: string; commit: string } {
  const fields = object(side, path);
  return {
    branch: nonEmpty(object(fields.branch, `${path}.branch`).name, `${path}.branch.name`),
    commit: nonEmpty(object(fields.commit, `${path}.commit`).hash, `${path}.commit.hash`),
  };
}

export function parsePullRequest(value: unknown, path = 'pullrequest'): PullRequest {
  const fields = object(value, path);
  const source = commitOf(fields.source, `${path}.source`);
  const destination = commitOf(fields.destination, `${path}.destination`);
  return {
    id: natural(fields.id, `${path}.id`),
    title: nonEmpty(fields.title, `${path}.title`),
    url: nonEmpty(object(object(fields.links, `${path}.links`).html, `${path}.links.html`).href, `${path}.links.html.href`),
    author: account(fields.author, `${path}.author`),
    sourceCommit: source.commit,
    destinationBranch: destination.branch,
    destinationCommit: destination.commit,
    participants: list(fields.participants, `${path}.participants`, (entry, at) => {
      const participant = object(entry, at);
      return { ...account(participant.user, `${at}.user`), approved: boolean(participant.approved, `${at}.approved`) };
    }),
  };
}

export function parseStatus(value: unknown, path: string): BuildStatus {
  const fields = object(value, path);
  const key = nonEmpty(fields.key, `${path}.key`);
  const name = fields.name === null || fields.name === undefined ? key : string(fields.name, `${path}.name`);
  return { key, name: name.trim() === '' ? key : name, state: oneOf(fields.state, `${path}.state`, BUILD_STATES) };
}

export function parseTask(value: unknown, path: string): Task {
  const fields = object(value, path);
  return {
    state: oneOf(fields.state, `${path}.state`, TASK_STATES),
    text: string(object(fields.content, `${path}.content`).raw, `${path}.content.raw`),
  };
}

const UUID = /^\{[0-9a-f-]{36}\}$/i;

// Forge gives the workspace as {uuid}, or as an ARI ending in the bare uuid
export function workspaceUuid(value: unknown): string {
  const text = nonEmpty(value, 'context.workspaceId');
  if (UUID.test(text)) return text;
  const bare = /^ari:cloud:bitbucket::workspace\/([0-9a-f-]{36})$/i.exec(text)?.[1];
  if (bare !== undefined) return `{${bare}}`;
  throw new Error(`context.workspaceId is not a workspace uuid: ${JSON.stringify(text)}`);
}

// A path inside the repository as route segments: no "..", no query, no empty segment
export function filePath(path: string): Route {
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || /[?#\\%]/.test(segment)) {
      throw new ParseError('path', `not a plain repository path: ${JSON.stringify(path)}`);
    }
  }
  return assumeTrustedRoute(segments.map(encodeURIComponent).join('/'));
}

async function json(response: Awaited<ReturnType<typeof api.requestBitbucket>>, what: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${what} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

// Follows Bitbucket's "next" links, which stay on api.bitbucket.org
async function allPages<T>(first: Route, what: string, item: (value: unknown, path: string) => T): Promise<T[]> {
  const found: T[] = [];
  let next: Route | undefined = first;
  for (let page = 0; next !== undefined; page++) {
    const body: Fields = object(await json(await api.asApp().requestBitbucket(next), what), `${what}[${page}]`);
    found.push(...list(body.values, `${what}[${page}].values`, item));
    if (body.next === undefined) {
      next = undefined;
    } else {
      const url = new URL(nonEmpty(body.next, `${what}[${page}].next`));
      if (url.hostname !== 'api.bitbucket.org') throw new ParseError(`${what}[${page}].next`, `leaves Bitbucket: ${url.hostname}`);
      next = routeFromAbsolute(url.href);
    }
  }
  return found;
}

export function forgeBitbucket(workspace: string, repository: string): BitbucketRest {
  const base = route`/2.0/repositories/${workspace}/${repository}`;
  return {
    async pullRequest(id) {
      const what = `reading pull request ${id}`;
      return parsePullRequest(await json(await api.asApp().requestBitbucket(route`${base}/pullrequests/${id}`), what));
    },
    async statuses(commit) {
      return allPages(route`${base}/commit/${commit}/statuses?pagelen=100`, `statuses of ${commit}`, parseStatus);
    },
    async tasks(pullRequest) {
      return allPages(route`${base}/pullrequests/${pullRequest}/tasks?pagelen=100`, `tasks of pull request ${pullRequest}`, parseTask);
    },
    async file(commit, path) {
      const response = await api.asApp().requestBitbucket(route`${base}/src/${commit}/${filePath(path)}`);
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`reading ${path} at ${commit} failed: ${response.status} ${await response.text()}`);
      return response.text();
    },
  };
}
