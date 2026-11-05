import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DECISION_LABEL, FIX_VERSION, ITEMS, MAIN_FILES, type SeedItem } from './demo';
import { planBitbucket, planJira, pullRequestSpecs, type BitbucketState, type JiraState } from './plan';

const EMPTY_JIRA: JiraState = { project: false, versions: new Set(), items: new Map(), comments: new Map() };
const EMPTY_BITBUCKET: BitbucketState = {
  repository: false,
  mainFiles: new Set(),
  branches: new Set(),
  pullRequestBranches: new Set(),
};

function keysFor(items: readonly SeedItem[]): Map<string, string> {
  return new Map(items.map((item, index) => [item.id, `HRB-${index + 1}`]));
}

function seededJira(): JiraState {
  const keys = keysFor(ITEMS);
  const comments = new Map(ITEMS.map((item) => [keys.get(item.id) ?? '', item.comments]));
  return { project: true, versions: new Set([FIX_VERSION]), items: keys, comments };
}

test('the demo has about 20 work items and three blocking decisions', () => {
  assert.ok(ITEMS.length >= 18 && ITEMS.length <= 22);
  assert.equal(ITEMS.filter((item) => item.labels.includes(DECISION_LABEL)).length, 2);
  const implicit = ITEMS.filter((item) => !item.labels.includes(DECISION_LABEL) && item.comments.length > 0);
  assert.equal(implicit.length, 1);
  assert.ok(implicit[0]?.comments.every((comment) => comment.includes('?')));
  assert.ok(MAIN_FILES.has('shipmill.toml'));
});

test('an empty site plans the project, the version, every item and the comment, in order', () => {
  const actions = planJira(ITEMS, FIX_VERSION, EMPTY_JIRA);
  assert.deepEqual(actions.slice(0, 2), [{ kind: 'create-project' }, { kind: 'create-version', name: FIX_VERSION }]);
  assert.equal(actions.filter((action) => action.kind === 'create-item').length, ITEMS.length);
  const comment = actions.findIndex((action) => action.kind === 'add-comment');
  const item = actions.findIndex((action) => action.kind === 'create-item' && action.item.id === 'invoice-migration');
  assert.ok(comment > item, 'a comment comes after its work item is made');
});

test('a seeded site plans nothing', () => {
  assert.deepEqual(planJira(ITEMS, FIX_VERSION, seededJira()), []);
});

test('a half-seeded site plans only what is missing', () => {
  const seeded = seededJira();
  const items = new Map(seeded.items);
  items.delete('csv-import-row');
  const actions = planJira(ITEMS, FIX_VERSION, {
    ...seeded,
    items,
    comments: new Map([[seeded.items.get('invoice-migration') ?? '', []]]),
  });
  assert.deepEqual(
    actions.map((action) => (action.kind === 'create-item' ? action.item.id : action.kind)),
    ['add-comment', 'csv-import-row'],
  );
});

test('a comment someone else wrote does not count as the seed question', () => {
  const seeded = seededJira();
  const key = seeded.items.get('invoice-migration') ?? '';
  const actions = planJira(ITEMS, FIX_VERSION, { ...seeded, comments: new Map([[key, ['Looks good']]]) });
  assert.deepEqual(actions.map((action) => action.kind), ['add-comment']);
});

test('duplicate seed ids are refused', () => {
  const first = ITEMS[0];
  assert.ok(first);
  assert.throws(() => planJira([first, first], FIX_VERSION, EMPTY_JIRA), /unique/);
});

test('pull requests name their work item in the title and the branch', () => {
  const specs = pullRequestSpecs(ITEMS, keysFor(ITEMS));
  assert.equal(specs.length, ITEMS.filter((item) => item.pullRequest !== undefined).length);
  for (const spec of specs) {
    const key = spec.title.split(' ')[0] ?? '';
    assert.match(key, /^HRB-\d+$/);
    assert.ok(spec.branch.startsWith(`${key}-`));
  }
  const decisions = ITEMS.filter((item) => item.labels.includes(DECISION_LABEL) || item.comments.length > 0);
  for (const item of decisions) {
    assert.ok(specs.some((spec) => spec.itemId === item.id), `${item.id} has a pull request`);
  }
});

test('a pull request without its work item key fails', () => {
  assert.throws(() => pullRequestSpecs(ITEMS, new Map()), /no work item key/);
});

test('an empty workspace plans the repository, the main files, then a branch and pull request each', () => {
  const specs = pullRequestSpecs(ITEMS, keysFor(ITEMS));
  const actions = planBitbucket(MAIN_FILES, specs, EMPTY_BITBUCKET);
  assert.deepEqual(actions.slice(0, 2).map((action) => action.kind), ['create-repository', 'commit-main']);
  const main = actions[1];
  assert.ok(main?.kind === 'commit-main');
  assert.deepEqual([...main.files.keys()], [...MAIN_FILES.keys()]);
  assert.equal(actions.length, 2 + specs.length * 2);
});

test('a seeded workspace plans nothing', () => {
  const specs = pullRequestSpecs(ITEMS, keysFor(ITEMS));
  const branches = new Set(['main', ...specs.map((spec) => spec.branch)]);
  const state: BitbucketState = {
    repository: true,
    mainFiles: new Set(MAIN_FILES.keys()),
    branches,
    pullRequestBranches: new Set(specs.map((spec) => spec.branch)),
  };
  assert.deepEqual(planBitbucket(MAIN_FILES, specs, state), []);
});

test('a branch without its pull request gets only the pull request, and a missing file only that file', () => {
  const specs = pullRequestSpecs(ITEMS, keysFor(ITEMS));
  const [open, ...rest] = specs;
  assert.ok(open);
  const state: BitbucketState = {
    repository: true,
    mainFiles: new Set(['README.md']),
    branches: new Set(['main', ...specs.map((spec) => spec.branch)]),
    pullRequestBranches: new Set(rest.map((spec) => spec.branch)),
  };
  const actions = planBitbucket(MAIN_FILES, specs, state);
  assert.equal(actions.length, 2);
  const [main, pr] = actions;
  assert.ok(main?.kind === 'commit-main');
  assert.deepEqual([...main.files.keys()], ['shipmill.toml']);
  assert.ok(pr?.kind === 'create-pull-request');
  assert.equal(pr.spec.branch, open.branch);
});

test('a merged or declined pull request counts: its branch is not made again', () => {
  const specs = pullRequestSpecs(ITEMS, keysFor(ITEMS));
  const state: BitbucketState = {
    repository: true,
    mainFiles: new Set(MAIN_FILES.keys()),
    branches: new Set(['main']),
    pullRequestBranches: new Set(specs.map((spec) => spec.branch)),
  };
  assert.deepEqual(planBitbucket(MAIN_FILES, specs, state), []);
});
