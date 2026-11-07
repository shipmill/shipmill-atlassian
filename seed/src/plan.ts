// What the seed must change, worked out from what it found: pure, so a second run over a
// seeded site and workspace plans nothing, and a run after a demo puts its questions back

import type { SeedItem } from './demo';

// A work item the seed made, as it reads now
export type ItemState = {
  key: string;
  labels: readonly string[];
  // Names of its fix versions
  fixVersions: readonly string[];
  // Whether shipmill recorded a question on it (the shipmill-decision entity property)
  asked: boolean;
};

// What the seed found in Jira; an item is listed only once its work item was read back
export type JiraState = {
  project: boolean;
  versions: ReadonlySet<string>;
  // Seed item id to its work item
  items: ReadonlyMap<string, ItemState>;
};

export type JiraAction =
  | { kind: 'create-project' }
  | { kind: 'create-version'; name: string }
  | { kind: 'create-item'; item: SeedItem }
  // Labels and fix version back to the seed's, after a relay removed the label or someone
  // moved the item out of the release
  | { kind: 'reset-fields'; itemId: string; key: string; labels: readonly string[] }
  // Forgets what shipmill asked, so it asks again. The property is the app's only marker: a
  // reply counts only when it is newer than the question it names, so the old question,
  // reply and relay comments stay (the app's comments can't be deleted by a person anyway)
  | { kind: 'clear-question'; itemId: string; key: string };

export function planJira(items: readonly SeedItem[], version: string, state: JiraState): JiraAction[] {
  assertUniqueIds(items);
  const actions: JiraAction[] = [];
  if (!state.project) {
    actions.push({ kind: 'create-project' });
  }
  if (!state.versions.has(version)) {
    actions.push({ kind: 'create-version', name: version });
  }
  for (const item of items) {
    const found = state.items.get(item.id);
    if (found === undefined) {
      actions.push({ kind: 'create-item', item });
      continue;
    }
    if (found.asked) {
      actions.push({ kind: 'clear-question', itemId: item.id, key: found.key });
    }
    if (!sameSet(found.labels, item.labels) || !sameSet(found.fixVersions, [version])) {
      actions.push({ kind: 'reset-fields', itemId: item.id, key: found.key, labels: item.labels });
    }
  }
  return actions;
}

// A pull request the seed keeps for an item with a change
export type PullRequestSpec = {
  itemId: string;
  branch: string;
  title: string;
  description: string;
  // The one file the branch adds
  path: string;
  content: string;
  // The text of the decision task the pull request carries, if any
  task?: string;
};

// The Bitbucket app reads a task in this form as a decision (bitbucket/src/holds.ts)
export const DECISION_TASK_PREFIX = 'Decision needed: ';
const DECISION_TASK = /^\s*Decision needed:/i;

export function pullRequestSpecs(items: readonly SeedItem[], keys: ReadonlyMap<string, string>): PullRequestSpec[] {
  assertUniqueIds(items);
  return items.flatMap((item) => {
    if (item.pullRequest === undefined) {
      if (item.pullRequestDecision !== undefined) {
        throw new Error(`seed item ${item.id} has a pull request decision but no pull request`);
      }
      return [];
    }
    const key = keys.get(item.id);
    if (key === undefined) {
      throw new Error(`no work item key for seed item ${item.id}`);
    }
    return [
      {
        itemId: item.id,
        branch: `${key}-${item.id}`,
        title: `${key} ${item.summary}`,
        description: `${item.pullRequest}.\n\nWork item: ${key}`,
        path: `changes/${item.id}.md`,
        content: `# ${item.summary}\n\n${item.pullRequest}.\n`,
        ...(item.pullRequestDecision === undefined ? {} : { task: `${DECISION_TASK_PREFIX}${item.pullRequestDecision}` }),
      },
    ];
  });
}

export type TaskState = { id: number; text: string; resolved: boolean };

export type PullRequestState = {
  id: number;
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
  // Read for open pull requests only
  tasks: readonly TaskState[];
};

// What the seed found in Bitbucket
export type BitbucketState = {
  repository: boolean;
  // Paths that exist on the main branch; empty while the repository has no commit
  mainFiles: ReadonlySet<string>;
  branches: ReadonlySet<string>;
  // Source branch to its pull requests, whatever their state
  pullRequests: ReadonlyMap<string, readonly PullRequestState[]>;
};

export type BitbucketAction =
  | { kind: 'create-repository' }
  | { kind: 'commit-main'; files: ReadonlyMap<string, string> }
  | { kind: 'create-branch'; spec: PullRequestSpec }
  // Opens the pull request, then its decision task
  | { kind: 'create-pull-request'; spec: PullRequestSpec }
  | { kind: 'open-task'; spec: PullRequestSpec; pullRequest: number; text: string }
  | { kind: 'reopen-task'; spec: PullRequestSpec; pullRequest: number; task: number }
  // A decision task the seed did not ask, such as shipmill's repeat of a question it no longer has
  | { kind: 'resolve-task'; spec: PullRequestSpec; pullRequest: number; task: number }
  // A merged pull request can't be opened again, and a new one would carry no change
  | { kind: 'merged'; spec: PullRequestSpec; pullRequest: number };

export function planBitbucket(
  mainFiles: ReadonlyMap<string, string>,
  specs: readonly PullRequestSpec[],
  state: BitbucketState,
): BitbucketAction[] {
  const actions: BitbucketAction[] = [];
  if (!state.repository) {
    actions.push({ kind: 'create-repository' });
  }
  // A file someone changed since is left as it is: only a missing one is written
  const missing = new Map([...mainFiles].filter(([path]) => !state.mainFiles.has(path)));
  if (missing.size > 0) {
    actions.push({ kind: 'commit-main', files: missing });
  }
  for (const spec of specs) {
    const pullRequests = state.pullRequests.get(spec.branch) ?? [];
    const open = pullRequests.filter((pr) => pr.state === 'OPEN');
    if (open.length > 1) {
      throw new Error(`branch ${spec.branch} has ${open.length} open pull requests; close all but one`);
    }
    const [current] = open;
    if (current !== undefined) {
      actions.push(...planTasks(spec, current));
      continue;
    }
    const merged = pullRequests.find((pr) => pr.state === 'MERGED');
    if (merged !== undefined) {
      actions.push({ kind: 'merged', spec, pullRequest: merged.id });
      continue;
    }
    if (!state.branches.has(spec.branch)) {
      actions.push({ kind: 'create-branch', spec });
    }
    actions.push({ kind: 'create-pull-request', spec });
  }
  return actions;
}

function planTasks(spec: PullRequestSpec, pullRequest: PullRequestState): BitbucketAction[] {
  const actions: BitbucketAction[] = [];
  const ours = spec.task === undefined ? [] : pullRequest.tasks.filter((task) => task.text.trim() === spec.task);
  if (spec.task !== undefined && ours.length === 0) {
    actions.push({ kind: 'open-task', spec, pullRequest: pullRequest.id, text: spec.task });
  }
  if (ours.length > 0 && ours.every((task) => task.resolved)) {
    const [first] = ours;
    if (first !== undefined) {
      actions.push({ kind: 'reopen-task', spec, pullRequest: pullRequest.id, task: first.id });
    }
  }
  for (const task of pullRequest.tasks) {
    if (!task.resolved && DECISION_TASK.test(task.text) && !ours.includes(task)) {
      actions.push({ kind: 'resolve-task', spec, pullRequest: pullRequest.id, task: task.id });
    }
  }
  return actions;
}

export function describeJira(action: JiraAction): string {
  switch (action.kind) {
    case 'create-project':
      return 'create the project';
    case 'create-version':
      return `create fix version ${action.name}`;
    case 'create-item':
      return `create work item "${action.item.summary}"`;
    case 'reset-fields':
      return `reset ${action.key} to labels [${action.labels.join(', ')}] and the release's fix version`;
    case 'clear-question':
      return `clear ${action.key}: delete shipmill's record of the question, so it is asked again`;
  }
}

export function describeBitbucket(action: BitbucketAction): string {
  switch (action.kind) {
    case 'create-repository':
      return 'create the repository';
    case 'commit-main':
      return `commit ${[...action.files.keys()].join(', ')} to the main branch`;
    case 'create-branch':
      return `create branch ${action.spec.branch}`;
    case 'create-pull-request':
      return `open pull request "${action.spec.title}"${action.spec.task === undefined ? '' : ' with its decision task'}`;
    case 'open-task':
      return `open the decision task on pull request #${action.pullRequest}`;
    case 'reopen-task':
      return `reopen decision task ${action.task} on pull request #${action.pullRequest}`;
    case 'resolve-task':
      return `resolve leftover decision task ${action.task} on pull request #${action.pullRequest}`;
    case 'merged':
      return `leave pull request #${action.pullRequest} (${action.spec.branch}): it is merged; delete the repository to seed it again`;
  }
}

function sameSet(found: readonly string[], wanted: readonly string[]): boolean {
  const set = new Set(found);
  return set.size === found.length && found.length === wanted.length && wanted.every((value) => set.has(value));
}

function assertUniqueIds(items: readonly SeedItem[]): void {
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== items.length) {
    throw new Error('seed item ids must be unique');
  }
}
