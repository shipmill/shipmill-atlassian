import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraKey, type ProjectKey } from '@shipmill-atlassian/shared/jira-key';
import { NEEDS_DECISION, commentId } from '@shipmill-atlassian/shared/release';
import { APP, FakeJira, FakeLog } from './fake-jira';
import { SEED_PROJECT, SEED_VERSION, seedRelease } from './fixtures';
import {
  askDecision,
  callerAccountId,
  listDecisions,
  listedView,
  parseAskInput,
  parseItemInput,
  parseListInput,
  readAnswer,
  seesPullRequestData,
  McpInputError,
} from './mcp';
import { AccessError, parseMyPermissions, type CallerPermissions, type Permission, type PermissionTarget } from './permissions';
import { templatePreparer } from './prepare';
import { relayReply } from './relay';
import { releasePanel } from './release-panel';

const HRB1 = jiraKey('HRB-1');
const HRB2 = jiraKey('HRB-2');
const HRB3 = jiraKey('HRB-3');

// Jira's answer to "what may the caller do": granted per project or work item
class FakePermissions implements CallerPermissions {
  readonly asked: PermissionTarget[] = [];
  constructor(private readonly granted: Record<string, readonly Permission[]>) {}

  async held(target: PermissionTarget, permissions: readonly Permission[]): Promise<Permission[]> {
    this.asked.push(target);
    const granted = this.granted['project' in target ? target.project : target.item] ?? [];
    return permissions.filter((permission) => granted.includes(permission));
  }
}

const EVERYTHING: readonly Permission[] = ['BROWSE_PROJECTS', 'ADD_COMMENTS'];
const BROWSE: readonly Permission[] = ['BROWSE_PROJECTS'];

function askDeps(jira: FakeJira, permissions: CallerPermissions) {
  return {
    permissions,
    versions: async (_project: ProjectKey) => [SEED_VERSION, '2.5'],
    release: async (project: ProjectKey, version: string) => {
      assert.equal(project, SEED_PROJECT);
      assert.equal(version, SEED_VERSION);
      return seedRelease();
    },
    jira,
    preparer: templatePreparer,
    now: () => new Date('2026-12-03T09:00:00.000Z'),
  };
}

test('the caller is the principal Forge passes in the action context', () => {
  assert.equal(callerAccountId({ principal: { accountId: '557058:dana' }, installContext: 'ari:cloud:jira::site/1' }), '557058:dana');
  assert.throws(() => callerAccountId({ installContext: 'ari:cloud:jira::site/1' }), /context\.principal/);
});

test('tool inputs are checked strictly', () => {
  assert.deepEqual(parseListInput({ project: 'HRB' }), { project: SEED_PROJECT, version: undefined });
  assert.deepEqual(parseListInput({ project: 'HRB', version: '2.4', context: {} }), { project: SEED_PROJECT, version: '2.4' });
  assert.throws(() => parseListInput({ project: 'hrb' }), /not a Jira project key/);
  assert.deepEqual(parseAskInput({ issueKey: 'HRB-2', version: '2.4' }), { item: HRB2, version: '2.4' });
  assert.throws(() => parseAskInput({ issueKey: 'HRB-2' }), /version/);
  assert.throws(() => parseItemInput({ issueKey: 'HRB 2' }), /not a Jira work item key/);
});

test('list returns the release panel for a caller who may browse the project, and refuses one who may not', async () => {
  const release = await seedRelease();
  const view = async (project: ProjectKey, version: string | undefined) => ({
    versions: [SEED_VERSION],
    panel: await releasePanel({ ...release, project, version: version ?? SEED_VERSION }, new FakeJira(), []),
  });
  const listed = await listDecisions({ project: SEED_PROJECT, version: undefined }, { permissions: new FakePermissions({ HRB: BROWSE }), view, seesPullRequests: true });
  assert.deepEqual(listed.panel?.decisions.map((decision) => [decision.key, decision.askedAt]), [
    [HRB2, null],
    [HRB3, null],
  ]);
  assert.equal(listed.panel?.ready, false);

  let viewed = false;
  await assert.rejects(
    listDecisions({ project: SEED_PROJECT, version: undefined }, { permissions: new FakePermissions({}), view: async () => ((viewed = true), { versions: [], panel: null }), seesPullRequests: true }),
    (error: unknown) => error instanceof AccessError && /BROWSE_PROJECTS on project HRB/.test(error.message),
  );
  assert.equal(viewed, false, 'nothing is read before the check');
});

test('list never claims ready when the pull requests could not be read', () => {
  const clear = { project: SEED_PROJECT, version: SEED_VERSION, decisions: [], pullRequestDecisions: [], ready: true };
  const onJira = listedView({ versions: [SEED_VERSION], panel: clear }, true);
  assert.equal(onJira.panel?.ready, true);
  assert.equal(onJira.panel?.pullRequestData, 'read');

  const onConfluence = listedView({ versions: [SEED_VERSION], panel: clear }, false);
  assert.equal(onConfluence.panel?.ready, 'unknown');
  assert.equal(onConfluence.panel?.pullRequestData, 'unavailable');

  // A work item's own decision holds the release whatever the pull requests say
  const blocked = { ...clear, ready: false, decisions: [{ key: HRB2 }] } as unknown as typeof clear;
  assert.equal(listedView({ versions: [SEED_VERSION], panel: blocked }, false).panel?.ready, false);

  assert.equal(listedView({ versions: [], panel: null }, false).panel, null);
});

test('only a call on the Jira install sees the pull request data', () => {
  assert.equal(seesPullRequestData('ari:cloud:jira::site/df3ece76-9d45-44c9-9e41-9c1a22e2fc59'), true);
  assert.equal(seesPullRequestData('ari:cloud:confluence::site/df3ece76-9d45-44c9-9e41-9c1a22e2fc59'), false);
});

test('ask posts the template question as shipmill, records it, and does not ask twice', async () => {
  const jira = new FakeJira();
  const permissions = new FakePermissions({ [HRB2]: EVERYTHING });
  const first = await askDecision({ item: HRB2, version: SEED_VERSION }, askDeps(jira, permissions));
  assert.equal(first.asked, true);
  if (first.decision.status !== 'waiting') throw new Error(`expected waiting, got ${first.decision.status}`);
  assert.equal(first.decision.question, 'retire v1 tokens in 2.4, or keep them for one more release?');
  assert.equal(first.decision.waitsOn.displayName, 'Dana Okafor');
  assert.match(first.decision.options[0]!, /^1\. .*\(recommended\)/);
  assert.match(first.decision.howToAnswer, /starts with the option number/);
  assert.deepEqual(permissions.asked, [{ item: HRB2 }]);

  const posted = jira.posted(HRB2);
  assert.equal(posted.length, 1);
  assert.equal(jira.comments.get(commentId(first.decision.questionId))?.comment.author, APP);
  // HRB-2 already carries the label, so asking adds none
  assert.deepEqual(jira.labels, []);

  const again = await askDecision({ item: HRB2, version: SEED_VERSION }, askDeps(jira, permissions));
  assert.equal(again.asked, false);
  assert.equal(jira.posted(HRB2).length, 1);
});

test('ask refuses a caller who cannot comment on the work item, before reading anything', async () => {
  const jira = new FakeJira();
  const deps = askDeps(jira, new FakePermissions({ [HRB2]: BROWSE }));
  await assert.rejects(askDecision({ item: HRB2, version: SEED_VERSION }, deps), /ADD_COMMENTS on HRB-2/);
  assert.equal(jira.comments.size, 0);
});

test('ask refuses an item that is not a blocking decision, and a version that is not open', async () => {
  const jira = new FakeJira();
  const permissions = new FakePermissions({ [HRB1]: EVERYTHING, [HRB2]: EVERYTHING });
  const notLabelled = (await seedRelease()).items.find((item) => item.key === HRB1)!;
  assert.ok(!notLabelled.labels.includes(NEEDS_DECISION), 'the seed leaves HRB-1 unlabelled');
  await assert.rejects(askDecision({ item: HRB1, version: SEED_VERSION }, askDeps(jira, permissions)), McpInputError);
  await assert.rejects(askDecision({ item: HRB2, version: '2.3' }, askDeps(jira, permissions)), /not an open fix version of HRB/);
  assert.equal(jira.comments.size, 0);
});

test('read answer goes from not asked to waiting to decided, with the relayed answer', async () => {
  const jira = new FakeJira();
  const permissions = new FakePermissions({ [HRB2]: EVERYTHING });
  assert.deepEqual(await readAnswer({ item: HRB2 }, { permissions, jira }), { key: HRB2, status: 'not-asked' });

  await askDecision({ item: HRB2, version: SEED_VERSION }, askDeps(jira, permissions));
  const waiting = await readAnswer({ item: HRB2 }, { permissions, jira });
  assert.equal(waiting.status, 'waiting');

  const state = (await jira.state(HRB2))!;
  const outcome = await relayReply(HRB2, jira.reply(HRB2, state.decider, '2'), { jira, reader: null, now: () => new Date('2026-12-03T10:00:00.000Z'), log: new FakeLog() });
  assert.equal(outcome.relayed, true);
  const decided = await readAnswer({ item: HRB2 }, { permissions, jira });
  if (decided.status !== 'decided') throw new Error(`expected decided, got ${decided.status}`);
  assert.match(decided.answer!, /^option 2, /);
  assert.equal(decided.decidedAt, '2026-12-03T10:00:00.000Z');
});

test('read answer refuses a work item the caller cannot see', async () => {
  const jira = new FakeJira();
  await assert.rejects(readAnswer({ item: HRB2 }, { permissions: new FakePermissions({ [HRB3]: BROWSE }), jira }), AccessError);
});

test('mypermissions is read strictly, permission by permission', () => {
  const body = { permissions: { BROWSE_PROJECTS: { key: 'BROWSE_PROJECTS', havePermission: true }, ADD_COMMENTS: { key: 'ADD_COMMENTS', havePermission: false } } };
  assert.deepEqual(parseMyPermissions(body, ['BROWSE_PROJECTS', 'ADD_COMMENTS'], 'mine'), ['BROWSE_PROJECTS']);
  assert.throws(() => parseMyPermissions({ permissions: {} }, ['ADD_COMMENTS'], 'mine'), /mine\.permissions\.ADD_COMMENTS/);
});
