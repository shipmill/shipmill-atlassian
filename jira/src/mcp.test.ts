import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraKey, type ProjectKey } from '@shipmill-atlassian/shared/jira-key';
import { NEEDS_DECISION, commentId, type WorkItem } from '@shipmill-atlassian/shared/release';
import { withdrawQuestion } from './ask';
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
  parseOptions,
  readAnswer,
  seesPullRequestData,
  McpInputError,
  type AskInput,
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

// The account the MCP client signed in as
const DEV = '557058:dev';

// A release decision shipmill prepares, and an agent's own question
const PREPARED: AskInput = { kind: 'release', item: HRB2, agent: 'shipmill', version: SEED_VERSION };
const OWN = {
  issueKey: 'HRB-1',
  agent: 'Claude Code',
  question: 'Retry the payment webhook three times,\n  or fail on the first error?',
  options: '1. Retry three times with backoff\n2. Fail on the first error\n',
  recommended: 1,
  reason: 'The provider asks for it and the handler is idempotent',
  care: 'routine',
};

function askDeps(jira: FakeJira, permissions: CallerPermissions) {
  return {
    permissions,
    caller: DEV,
    item: async (key: typeof HRB1): Promise<WorkItem | undefined> => (await seedRelease()).items.find((item) => item.key === key),
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
  assert.deepEqual(parseAskInput({ issueKey: 'HRB-2', version: '2.4' }), PREPARED);
  assert.throws(() => parseAskInput({ issueKey: 'HRB-2' }), /give your question, or the open fix version/);
  assert.throws(() => parseItemInput({ issueKey: 'HRB 2' }), /not a Jira work item key/);
});

test("ask takes an agent's own question: options one per line, the recommended one with its reason, careful unless routine", () => {
  assert.deepEqual(parseAskInput(OWN), {
    kind: 'own',
    item: HRB1,
    agent: 'Claude Code',
    question: 'Retry the payment webhook three times, or fail on the first error?',
    options: [
      { text: 'Retry three times with backoff', reason: 'The provider asks for it and the handler is idempotent' },
      { text: 'Fail on the first error', reason: null },
    ],
    recommended: 1,
    care: 'routine',
  });
  // No recommendation, and careful by default; an MCP client may send an unused input empty
  const bare = parseAskInput({ issueKey: 'HRB-1', agent: 'Cursor', question: 'Drop the table?', options: 'Drop it\nKeep it', recommended: null, reason: '', care: '', version: '' });
  assert.deepEqual(bare, {
    kind: 'own',
    item: HRB1,
    agent: 'Cursor',
    question: 'Drop the table?',
    options: [{ text: 'Drop it', reason: null }, { text: 'Keep it', reason: null }],
    recommended: null,
    care: 'careful',
  });
  assert.deepEqual(parseOptions('- Yes\n\n* No\n3) 2 replicas\n'), ['Yes', 'No', '2 replicas']);

  for (const [bad, message] of [
    [{ ...OWN, options: undefined }, /options: your own question needs its options/],
    [{ ...OWN, options: 'Only one' }, /options: 1 given, a question takes 2 to 4/],
    [{ ...OWN, options: 'a\nb\nc\nd\ne' }, /options: 5 given/],
    [{ ...OWN, options: 'Same\nSame' }, /"Same" is given twice/],
    [{ ...OWN, options: `${'x'.repeat(301)}\nNo` }, /options\[1\]: 301 characters, more than the 300 allowed/],
    [{ ...OWN, options: ['Yes', 'No'] }, /options: expected a string/],
    [{ ...OWN, recommended: 3 }, /recommended: 3 is not an option from 1 to 2/],
    [{ ...OWN, recommended: 0 }, /recommended: 0 is not an option/],
    [{ ...OWN, recommended: '1' }, /recommended: expected a non-negative integer/],
    [{ ...OWN, reason: undefined }, /reason: say why you recommend that option/],
    [{ ...OWN, recommended: undefined }, /reason: it says why you recommend an option, so it needs recommended/],
    [{ ...OWN, care: 'urgent' }, /care: expected one of routine, careful/],
    [{ ...OWN, agent: undefined }, /agent: say which agent asks/],
    [{ ...OWN, question: 'x'.repeat(1001) }, /question: 1001 characters/],
    [{ ...OWN, version: '2.4' }, /version: it picks a release decision shipmill prepares/],
    // Without a question the other inputs describe nothing
    [{ issueKey: 'HRB-2', version: '2.4', options: 'a\nb' }, /options: it describes your own question, so it needs question/],
    [{ issueKey: 'HRB-2', version: '2.4', care: 'routine' }, /care: it describes your own question/],
  ] as const) {
    assert.throws(() => parseAskInput(bad), message);
  }
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
  const first = await askDecision(PREPARED, askDeps(jira, permissions));
  assert.equal(first.asked, true);
  if (first.decision.status !== 'waiting') throw new Error(`expected waiting, got ${first.decision.status}`);
  assert.equal(first.decision.question, 'retire v1 tokens in 2.4, or keep them for one more release?');
  assert.equal(first.decision.waitsOn.displayName, 'Dana Okafor');
  assert.match(first.decision.options[0]!, /^1\. .*\(recommended\)/);
  assert.match(first.decision.howToAnswer!, /starts with the option number/);
  // A decision that blocks a release is careful, and the record names the account that had it asked
  assert.equal(first.decision.care, 'careful');
  assert.deepEqual(first.decision.askedBy, { agent: 'shipmill', accountId: DEV });
  assert.deepEqual(permissions.asked, [{ item: HRB2 }]);

  const posted = jira.posted(HRB2);
  assert.equal(posted.length, 1);
  assert.equal(jira.comments.get(commentId(first.decision.questionId))?.comment.author, APP);
  // HRB-2 already carries the label, so asking adds none
  assert.deepEqual(jira.labels, []);

  const again = await askDecision(PREPARED, askDeps(jira, permissions));
  assert.equal(again.asked, false);
  assert.equal(jira.posted(HRB2).length, 1);
});

test("ask records an agent's own question with every field, shows it on the work item, and read answer gives the answer from the record", async () => {
  const jira = new FakeJira();
  const permissions = new FakePermissions({ [HRB1]: EVERYTHING });
  const asked = await askDecision(parseAskInput(OWN), askDeps(jira, permissions));
  assert.equal(asked.asked, true);
  const lee = { accountId: '712020:lee', displayName: 'Lee Park' };
  assert.deepEqual(asked.decision, {
    key: HRB1,
    status: 'waiting',
    question: 'Retry the payment webhook three times, or fail on the first error?',
    options: ['1. Retry three times with backoff (recommended): The provider asks for it and the handler is idempotent', '2. Fail on the first error'],
    recommended: 1,
    care: 'routine',
    askedBy: { agent: 'Claude Code', accountId: DEV },
    // HRB-1's assignee
    waitsOn: lee,
    askedAt: '2026-12-03T09:00:00.000Z',
    questionId: jira.current(HRB1)!.id,
    howToAnswer: 'Lee Park answers on HRB-1 in Jira (a reply that starts with the option number), or on a linked pull request in Bitbucket',
    answer: null,
    answeredBy: null,
    answeredAt: null,
    answeredFrom: null,
    withdrawnAt: null,
  });
  // The comment is the record's visible form, posted as shipmill; HRB-1 had no label, so asking adds it
  assert.match(jira.posted(HRB1)[0]!.text, /^@Lee Park Decision needed: Retry the payment webhook three times, or fail on the first error\?\n/);
  assert.match(jira.posted(HRB1)[0]!.text, /Asked by Claude Code, an agent, which marked this routine\./);
  assert.equal(jira.comments.get(commentId(jira.current(HRB1)!.id))?.comment.author, APP);
  assert.deepEqual(jira.labels, [{ key: HRB1, present: true }]);

  // Not asked twice while it waits, whoever asks
  const again = await askDecision(parseAskInput({ ...OWN, question: 'Something else?' }), askDeps(jira, permissions));
  assert.equal(again.asked, false);
  assert.equal(again.decision.status === 'not-asked' ? null : again.decision.question, 'Retry the payment webhook three times, or fail on the first error?');
  assert.equal(jira.posted(HRB1).length, 1);

  await relayReply(HRB1, jira.reply(HRB1, lee, '1'), { jira, reader: null, now: () => new Date('2026-12-03T10:00:00.000Z'), log: new FakeLog() });
  const answered = await readAnswer({ item: HRB1 }, { permissions, jira });
  if (answered.status !== 'answered') throw new Error(`expected answered, got ${answered.status}`);
  assert.equal(answered.answer, 'option 1, Retry three times with backoff (recommended): The provider asks for it and the handler is idempotent');
  assert.deepEqual(answered.answeredBy, lee);
  assert.equal(answered.answeredAt, '2026-12-03T10:00:00.000Z');
  assert.equal(answered.howToAnswer, null);

  // Answered, so the work item can be asked again; the answered record stays behind the new one
  const next = await askDecision(parseAskInput({ ...OWN, question: 'Log the retries at warn or at info?', options: 'warn\ninfo', recommended: undefined, reason: undefined }), askDeps(jira, permissions));
  assert.equal(next.asked, true);
  assert.equal(next.decision.status, 'waiting');
  assert.deepEqual((await jira.questions(HRB1)).map((question) => question.status), ['answered', 'waiting']);
});

test("ask refuses an agent's own question on a work item the site does not have, or the caller cannot comment on", async () => {
  const jira = new FakeJira();
  const gone = jiraKey('HRB-999');
  const deps = askDeps(jira, new FakePermissions({ [gone]: EVERYTHING, [HRB1]: BROWSE }));
  await assert.rejects(askDecision(parseAskInput({ ...OWN, issueKey: 'HRB-999' }), deps), (error: unknown) => error instanceof McpInputError && /HRB-999 is not a work item on this site/.test(error.message));
  await assert.rejects(askDecision(parseAskInput(OWN), deps), /ADD_COMMENTS on HRB-1/);
  assert.equal(jira.comments.size, 0);
});

test('read answer says a withdrawn question is withdrawn', async () => {
  const jira = new FakeJira();
  const permissions = new FakePermissions({ [HRB1]: EVERYTHING });
  await askDecision(parseAskInput(OWN), askDeps(jira, permissions));
  await withdrawQuestion(HRB1, { agent: 'Claude Code', accountId: DEV }, { jira, now: () => new Date('2026-12-03T09:30:00.000Z') });
  const view = await readAnswer({ item: HRB1 }, { permissions, jira });
  if (view.status !== 'withdrawn') throw new Error(`expected withdrawn, got ${view.status}`);
  assert.equal(view.withdrawnAt, '2026-12-03T09:30:00.000Z');
  assert.equal(view.answer, null);
  assert.equal(view.howToAnswer, null);
});

test('ask refuses a caller who cannot comment on the work item, before reading anything', async () => {
  const jira = new FakeJira();
  const deps = askDeps(jira, new FakePermissions({ [HRB2]: BROWSE }));
  await assert.rejects(askDecision(PREPARED, deps), /ADD_COMMENTS on HRB-2/);
  assert.equal(jira.comments.size, 0);
});

test('ask refuses an item that is not a blocking decision, and a version that is not open', async () => {
  const jira = new FakeJira();
  const permissions = new FakePermissions({ [HRB1]: EVERYTHING, [HRB2]: EVERYTHING });
  const notLabelled = (await seedRelease()).items.find((item) => item.key === HRB1)!;
  assert.ok(!notLabelled.labels.includes(NEEDS_DECISION), 'the seed leaves HRB-1 unlabelled');
  await assert.rejects(askDecision({ ...PREPARED, item: HRB1 }, askDeps(jira, permissions)), McpInputError);
  await assert.rejects(askDecision({ ...PREPARED, version: '2.3' }, askDeps(jira, permissions)), /not an open fix version of HRB/);
  assert.equal(jira.comments.size, 0);
});

test('read answer goes from not asked to waiting to answered, with the answer, who gave it and when', async () => {
  const jira = new FakeJira();
  const permissions = new FakePermissions({ [HRB2]: EVERYTHING });
  assert.deepEqual(await readAnswer({ item: HRB2 }, { permissions, jira }), { key: HRB2, status: 'not-asked' });

  await askDecision(PREPARED, askDeps(jira, permissions));
  const waiting = await readAnswer({ item: HRB2 }, { permissions, jira });
  assert.equal(waiting.status, 'waiting');

  const state = jira.current(HRB2)!;
  const outcome = await relayReply(HRB2, jira.reply(HRB2, state.askedOf, '2'), { jira, reader: null, now: () => new Date('2026-12-03T10:00:00.000Z'), log: new FakeLog() });
  assert.equal(outcome.relayed, true);
  const decided = await readAnswer({ item: HRB2 }, { permissions, jira });
  if (decided.status !== 'answered') throw new Error(`expected answered, got ${decided.status}`);
  assert.match(decided.answer!, /^option 2, /);
  assert.equal(decided.answeredBy?.displayName, 'Dana Okafor');
  assert.equal(decided.answeredAt, '2026-12-03T10:00:00.000Z');
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
