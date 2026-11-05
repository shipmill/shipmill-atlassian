// What the seed must change, worked out from what it found: pure, so a second run over a
// seeded site and workspace plans nothing

import type { SeedItem } from './demo';

// What the seed found in Jira; an item is listed only once its work item was read back
export type JiraState = {
  project: boolean;
  versions: ReadonlySet<string>;
  // Seed item id to its work item key
  items: ReadonlyMap<string, string>;
  // Work item key to the plain text of its comments
  comments: ReadonlyMap<string, readonly string[]>;
};

export type JiraAction =
  | { kind: 'create-project' }
  | { kind: 'create-version'; name: string }
  | { kind: 'create-item'; item: SeedItem }
  | { kind: 'add-comment'; itemId: string; text: string };

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
    const key = state.items.get(item.id);
    if (key === undefined) {
      actions.push({ kind: 'create-item', item });
    }
    const posted = key === undefined ? [] : (state.comments.get(key) ?? []);
    for (const text of item.comments) {
      if (!posted.includes(text)) {
        actions.push({ kind: 'add-comment', itemId: item.id, text });
      }
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
};

export function pullRequestSpecs(
  items: readonly SeedItem[],
  keys: ReadonlyMap<string, string>,
): PullRequestSpec[] {
  assertUniqueIds(items);
  return items.flatMap((item) => {
    if (item.pullRequest === undefined) {
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
      },
    ];
  });
}

// What the seed found in Bitbucket
export type BitbucketState = {
  repository: boolean;
  // Paths that exist on the main branch; empty while the repository has no commit
  mainFiles: ReadonlySet<string>;
  branches: ReadonlySet<string>;
  // Source branches of every pull request, whatever its state
  pullRequestBranches: ReadonlySet<string>;
};

export type BitbucketAction =
  | { kind: 'create-repository' }
  | { kind: 'commit-main'; files: ReadonlyMap<string, string> }
  | { kind: 'create-branch'; spec: PullRequestSpec }
  | { kind: 'create-pull-request'; spec: PullRequestSpec };

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
    if (state.pullRequestBranches.has(spec.branch)) {
      continue;
    }
    if (!state.branches.has(spec.branch)) {
      actions.push({ kind: 'create-branch', spec });
    }
    actions.push({ kind: 'create-pull-request', spec });
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
    case 'add-comment':
      return `comment on ${action.itemId}: "${action.text}"`;
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
      return `open pull request "${action.spec.title}"`;
  }
}

function assertUniqueIds(items: readonly SeedItem[]): void {
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== items.length) {
    throw new Error('seed item ids must be unique');
  }
}
