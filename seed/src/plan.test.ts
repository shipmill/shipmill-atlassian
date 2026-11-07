import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DECISION_LABEL, FIX_VERSION, ITEMS, mainFiles, type SeedItem } from './demo';
import {
  planBitbucket,
  planJira,
  pullRequestSpecs,
  type BitbucketState,
  type ItemState,
  type JiraState,
  type PullRequestSpec,
  type PullRequestState,
} from './plan';

const MAIN_FILES = mainFiles('Harbor', 'harbor');
const EMPTY_JIRA: JiraState = { project: false, versions: new Set(), items: new Map() };
const EMPTY_BITBUCKET: BitbucketState = { repository: false, mainFiles: new Set(), branches: new Set(), pullRequests: new Map() };

function keysFor(items: readonly SeedItem[]): Map<string, string> {
  return new Map(items.map((item, index) => [item.id, `HRB-${index + 1}`]));
}

function seededJira(): JiraState {
  const keys = keysFor(ITEMS);
  const items = new Map<string, ItemState>(
    ITEMS.map((item) => [
      item.id,
      { key: keys.get(item.id) ?? '', labels: [...item.labels], fixVersions: [FIX_VERSION], comments: [], asked: false },
    ]),
  );
  return { project: true, versions: new Set([FIX_VERSION]), items };
}

function withItem(state: JiraState, id: string, change: Partial<ItemState>): JiraState {
  const found = state.items.get(id);
  assert.ok(found, id);
  return { ...state, items: new Map([...state.items, [id, { ...found, ...change }]]) };
}

const SPECS = pullRequestSpecs(ITEMS, keysFor(ITEMS));
const DECISION_SPEC = SPECS.find((spec) => spec.task !== undefined);
assert.ok(DECISION_SPEC);

function openPullRequest(spec: PullRequestSpec, id: number): PullRequestState {
  return { id, state: 'OPEN', tasks: spec.task === undefined ? [] : [{ id: 900, text: spec.task, resolved: false }] };
}

function seededBitbucket(): BitbucketState {
  return {
    repository: true,
    mainFiles: new Set(MAIN_FILES.keys()),
    branches: new Set(['main', ...SPECS.map((spec) => spec.branch)]),
    pullRequests: new Map(SPECS.map((spec, index) => [spec.branch, [openPullRequest(spec, index + 1)]])),
  };
}

function withPullRequests(state: BitbucketState, branch: string, pullRequests: PullRequestState[]): BitbucketState {
  return { ...state, pullRequests: new Map([...state.pullRequests, [branch, pullRequests]]) };
}

test('the demo has about 20 work items, three labelled decisions and one pull request decision', () => {
  assert.ok(ITEMS.length >= 18 && ITEMS.length <= 22);
  const labelled = ITEMS.filter((item) => item.labels.includes(DECISION_LABEL));
  assert.equal(labelled.length, 3);
  assert.ok(labelled.some((item) => item.pullRequest !== undefined), 'a decision has a linked pull request');
  assert.equal(SPECS.filter((spec) => spec.task !== undefined).length, 1);
  assert.ok(MAIN_FILES.has('shipmill.toml'));
});

test('an empty site plans the project, the version and every item, in order', () => {
  const actions = planJira(ITEMS, FIX_VERSION, EMPTY_JIRA);
  assert.deepEqual(actions.slice(0, 2), [{ kind: 'create-project' }, { kind: 'create-version', name: FIX_VERSION }]);
  assert.equal(actions.filter((action) => action.kind === 'create-item').length, ITEMS.length);
  assert.equal(actions.length, ITEMS.length + 2);
});

test('a seeded site plans nothing', () => {
  assert.deepEqual(planJira(ITEMS, FIX_VERSION, seededJira()), []);
});

test('a half-seeded site plans only what is missing', () => {
  const seeded = seededJira();
  const items = new Map(seeded.items);
  items.delete('csv-import-row');
  const actions = planJira(ITEMS, FIX_VERSION, { ...seeded, items });
  assert.deepEqual(
    actions.map((action) => (action.kind === 'create-item' ? action.item.id : action.kind)),
    ['csv-import-row'],
  );
});

test('an answered decision is reset: record and comments cleared, label put back', () => {
  // After a run: shipmill asked (property and question), the decider replied, the relay
  // posted and removed the label
  const state = withItem(seededJira(), 'retire-v1-tokens', { labels: [], comments: ['10001', '10002', '10003'], asked: true });
  assert.deepEqual(planJira(ITEMS, FIX_VERSION, state), [
    { kind: 'clear-question', itemId: 'retire-v1-tokens', key: 'HRB-2', comments: ['10001', '10002', '10003'], asked: true },
    { kind: 'reset-fields', itemId: 'retire-v1-tokens', key: 'HRB-2', labels: [DECISION_LABEL] },
  ]);
});

test('an asked but unanswered decision forgets the question, so the app asks it again', () => {
  const state = withItem(seededJira(), 'pricing-page', { comments: ['10004'], asked: true });
  assert.deepEqual(
    planJira(ITEMS, FIX_VERSION, state).map((action) => action.kind),
    ['clear-question'],
  );
});

test('an item moved out of the release, or labelled by hand, goes back', () => {
  let state = withItem(seededJira(), 'sso-okta', { fixVersions: ['2.5'] });
  state = withItem(state, 'dark-mode', { labels: [DECISION_LABEL] });
  state = withItem(state, 'audit-log', { fixVersions: [FIX_VERSION, '2.5'] });
  const actions = planJira(ITEMS, FIX_VERSION, state);
  assert.deepEqual(
    actions.map((action) => (action.kind === 'reset-fields' ? `${action.itemId}:${action.labels.join(',')}` : action.kind)),
    [`sso-okta:${DECISION_LABEL}`, 'dark-mode:', 'audit-log:'],
  );
});

test('duplicate seed ids are refused', () => {
  const first = ITEMS[0];
  assert.ok(first);
  assert.throws(() => planJira([first, first], FIX_VERSION, EMPTY_JIRA), /unique/);
});

test('pull requests name their work item in the title and the branch', () => {
  assert.equal(SPECS.length, ITEMS.filter((item) => item.pullRequest !== undefined).length);
  for (const spec of SPECS) {
    const key = spec.title.split(' ')[0] ?? '';
    assert.match(key, /^HRB-\d+$/);
    assert.ok(spec.branch.startsWith(`${key}-`));
  }
});

test('a pull request without its work item key fails', () => {
  assert.throws(() => pullRequestSpecs(ITEMS, new Map()), /no work item key/);
});

test('a pull request decision without a pull request fails', () => {
  const item: SeedItem = { id: 'x', type: 'Task', summary: 'X', description: 'X', labels: [], pullRequestDecision: 'A, or B?' };
  assert.throws(() => pullRequestSpecs([item], new Map([['x', 'HRB-1']])), /no pull request/);
});

test('an empty workspace plans the repository, the main files, then a branch and pull request each', () => {
  const actions = planBitbucket(MAIN_FILES, SPECS, EMPTY_BITBUCKET);
  assert.deepEqual(actions.slice(0, 2).map((action) => action.kind), ['create-repository', 'commit-main']);
  const main = actions[1];
  assert.ok(main?.kind === 'commit-main');
  assert.deepEqual([...main.files.keys()], [...MAIN_FILES.keys()]);
  assert.equal(actions.length, 2 + SPECS.length * 2);
});

test('a seeded workspace plans nothing', () => {
  assert.deepEqual(planBitbucket(MAIN_FILES, SPECS, seededBitbucket()), []);
});

test('a branch without its pull request gets only the pull request, and a missing file only that file', () => {
  const [first] = SPECS;
  assert.ok(first);
  const state = { ...withPullRequests(seededBitbucket(), first.branch, []), mainFiles: new Set(['README.md']) };
  const actions = planBitbucket(MAIN_FILES, SPECS, state);
  assert.equal(actions.length, 2);
  const [main, pr] = actions;
  assert.ok(main?.kind === 'commit-main');
  assert.deepEqual([...main.files.keys()], ['shipmill.toml']);
  assert.ok(pr?.kind === 'create-pull-request');
  assert.equal(pr.spec.branch, first.branch);
});

test('a declined pull request is opened again from its branch; a merged one is left and said', () => {
  const [first, second] = SPECS;
  assert.ok(first && second);
  let state = withPullRequests(seededBitbucket(), first.branch, [{ id: 1, state: 'DECLINED', tasks: [] }]);
  state = withPullRequests(state, second.branch, [{ id: 2, state: 'MERGED', tasks: [] }]);
  assert.deepEqual(
    planBitbucket(MAIN_FILES, SPECS, state).map((action) => `${action.kind}:${'spec' in action ? action.spec.branch : ''}`),
    [`create-pull-request:${first.branch}`, `merged:${second.branch}`],
  );
});

test('two open pull requests on one branch stop the run', () => {
  const [first] = SPECS;
  assert.ok(first);
  const state = withPullRequests(seededBitbucket(), first.branch, [openPullRequest(first, 1), openPullRequest(first, 2)]);
  assert.throws(() => planBitbucket(MAIN_FILES, SPECS, state), /2 open pull requests/);
});

test('the decision task is opened when missing and reopened when resolved', () => {
  const spec = DECISION_SPEC;
  const missing = withPullRequests(seededBitbucket(), spec.branch, [{ id: 7, state: 'OPEN', tasks: [] }]);
  assert.deepEqual(planBitbucket(MAIN_FILES, SPECS, missing), [{ kind: 'open-task', spec, pullRequest: 7, text: spec.task }]);

  const resolved = withPullRequests(seededBitbucket(), spec.branch, [
    { id: 7, state: 'OPEN', tasks: [{ id: 41, text: spec.task ?? '', resolved: true }] },
  ]);
  assert.deepEqual(planBitbucket(MAIN_FILES, SPECS, resolved), [{ kind: 'reopen-task', spec, pullRequest: 7, task: 41 }]);
});

test("shipmill's leftover decision tasks are resolved; other tasks are left alone", () => {
  const [first] = SPECS.filter((spec) => spec.task === undefined);
  assert.ok(first);
  const state = withPullRequests(seededBitbucket(), first.branch, [
    {
      id: 3,
      state: 'OPEN',
      tasks: [
        { id: 51, text: 'Decision needed: retire v1 tokens in 2.4, or keep them?', resolved: false },
        { id: 52, text: 'Decision needed: an old one', resolved: true },
        { id: 53, text: 'Update the docs', resolved: false },
      ],
    },
  ]);
  assert.deepEqual(planBitbucket(MAIN_FILES, SPECS, state), [{ kind: 'resolve-task', spec: first, pullRequest: 3, task: 51 }]);
});
