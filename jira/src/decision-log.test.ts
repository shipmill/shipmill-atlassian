import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraKey } from '@shipmill-atlassian/shared/jira-key';
import { commentId, type Person } from '@shipmill-atlassian/shared/release';
import { askDecisions } from './ask';
import {
  DecisionLogError,
  decisionRow,
  logEvent,
  parseLoggedDecision,
  queuedDecisionLog,
  spaceKey,
  writeDecision,
  type Confluence,
  type LogEvent,
  type LoggedDecision,
  type Page,
} from './decision-log';
import { FakeJira, FakeLog } from './fake-jira';
import { seedRelease } from './fixtures';
import { findDecisions } from './finder';
import { templatePreparer } from './prepare';
import { relayPullRequestReply } from './pull-request-decision';
import { relayReply } from './relay';

const NOW = () => new Date('2026-12-03T11:00:00.000Z');
const SITE = 'https://example.atlassian.net';
const DANA: Person = { accountId: '712020:dana', displayName: 'Dana Okafor' };
const HRB2 = jiraKey('HRB-2');
const HRB3 = jiraKey('HRB-3');

const DECISION: LoggedDecision = {
  key: HRB2,
  question: 'Retire v1 tokens in 2.4, or keep them <for now>?',
  answer: 'option 2, Retire v1 tokens in 2.4 & ship',
  decider: DANA,
  decidedAt: '2026-12-03T11:00:00.000Z',
  replyId: commentId('20004'),
};

// An in-memory Confluence with one space, DOCS. Like Confluence, it allows two pages with
// one title, and every call yields, so writes that are not serialized can interleave.
class FakeConfluence implements Confluence {
  readonly stored = new Map<string, Page & { title: string; spaceId: string }>();
  #next = 100;
  #clock = Date.parse('2026-12-03T11:00:00.000Z');

  async spaceId(space: string): Promise<string | undefined> {
    await tick();
    return space === 'DOCS' ? '9001' : undefined;
  }

  async pages(spaceId: string, title: string): Promise<Page[]> {
    await tick();
    return [...this.stored.values()].filter((page) => page.spaceId === spaceId && page.title === title);
  }

  async createPage(spaceId: string, title: string, body: string): Promise<string> {
    await tick();
    const id = String(this.#next++);
    this.stored.set(id, { id, spaceId, title, version: 1, body, createdAt: new Date(this.#clock++).toISOString() });
    return id;
  }

  async updatePage(page: Page, title: string, body: string): Promise<void> {
    await tick();
    const stored = this.stored.get(page.id)!;
    if (stored.version !== page.version) throw new Error(`409: page ${page.id} is at version ${stored.version}, not ${page.version}`);
    this.stored.set(page.id, { ...stored, title, body, version: page.version + 1 });
  }

  titled(title: string): (Page & { title: string })[] {
    return [...this.stored.values()].filter((page) => page.title === title);
  }

  rows(id: string): number {
    return (this.stored.get(id)!.body.match(/<tr>/g) ?? []).length - 1;
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// The Forge queue as the consumer sees it: events that share a concurrency key with limit 1
// run one after another, others at once
function forgeQueue(consume: (decision: LoggedDecision) => Promise<unknown>) {
  const chains = new Map<string, Promise<unknown>>();
  const runs: Promise<unknown>[] = [];
  return {
    push: async (event: LogEvent) => {
      assert.equal(event.concurrency.limit, 1);
      const run = (chains.get(event.concurrency.key) ?? Promise.resolve()).then(() => consume(event.body));
      chains.set(event.concurrency.key, run);
      runs.push(run);
    },
    drained: () => Promise.all(runs),
  };
}

const site = async () => SITE;

test('a row names the work item, the question, the decision, who decided and when, with links to the item and the reply', () => {
  assert.equal(
    decisionRow(DECISION, SITE),
    '<tr><td><a href="https://example.atlassian.net/browse/HRB-2">HRB-2</a></td>' +
      '<td>Retire v1 tokens in 2.4, or keep them &lt;for now&gt;?</td>' +
      '<td>option 2, Retire v1 tokens in 2.4 &amp; ship</td>' +
      '<td>Dana Okafor</td>' +
      '<td>2026-12-03 11:00</td>' +
      '<td><a href="https://example.atlassian.net/browse/HRB-2?focusedCommentId=20004">reply</a></td></tr>',
  );
});

test('with no space set the log is off and Confluence is not called', async () => {
  const confluence = new FakeConfluence();
  const outcome = await writeDecision(DECISION, {
    space: undefined,
    confluence,
    site: async () => assert.fail('read the site with the log off'),
  });
  assert.deepEqual(outcome, { written: false, reason: 'off' });
  assert.equal(confluence.stored.size, 0);
});

test('the first decision creates the project\'s page, the next adds a row to it', async () => {
  const confluence = new FakeConfluence();
  const deps = { space: spaceKey('DOCS'), confluence, site };
  const first = await writeDecision(DECISION, deps);
  assert.deepEqual(first, { written: true, page: '100', created: true });
  assert.equal(confluence.stored.get('100')?.title, 'Release decisions: HRB');
  assert.equal(confluence.rows('100'), 1);

  const second = await writeDecision({ ...DECISION, key: HRB3, replyId: commentId('20009') }, deps);
  assert.deepEqual(second, { written: true, page: '100', created: false });
  const page = confluence.stored.get('100')!;
  assert.equal(page.version, 2);
  assert.equal(confluence.rows('100'), 2);
  assert.ok(page.body.indexOf('>HRB-2<') < page.body.indexOf('>HRB-3<'), 'rows in the order decided');
  assert.ok(page.body.endsWith('</tbody></table>'));

  // Another project gets its own page
  await writeDecision({ ...DECISION, key: jiraKey('OPS-1') }, deps);
  assert.equal(confluence.stored.get('101')?.title, 'Release decisions: OPS');
});

test('two relays at once on one project write one page with two rows', async () => {
  const jira = await asked();
  const confluence = new FakeConfluence();
  const queue = forgeQueue((decision) => writeDecision(decision, { space: spaceKey('DOCS'), confluence, site }));
  const log = queuedDecisionLog(queue.push);
  const state = jira.states.get(HRB3)!;
  await Promise.all([
    relayReply(HRB2, jira.reply(HRB2, DANA, '2'), { jira, reader: null, now: NOW, log }),
    relayReply(HRB3, jira.reply(HRB3, state.decider, '1'), { jira, reader: null, now: NOW, log }),
  ]);
  await queue.drained();
  const pages = confluence.titled('Release decisions: HRB');
  assert.equal(pages.length, 1);
  assert.equal(confluence.rows(pages[0]!.id), 2);
});

test('without the concurrency key the same two writes would split the log', async () => {
  // Why the key matters: unserialized, both writers see no page and each creates one
  const confluence = new FakeConfluence();
  const deps = { space: spaceKey('DOCS'), confluence, site };
  await Promise.all([writeDecision(DECISION, deps), writeDecision({ ...DECISION, key: HRB3 }, deps)]);
  assert.equal(confluence.titled('Release decisions: HRB').length, 2);
});

test('log events share a concurrency key per project, limit 1', () => {
  assert.deepEqual(logEvent(DECISION).concurrency, { key: 'decision-log-HRB', limit: 1 });
  assert.equal(logEvent({ ...DECISION, key: HRB3 }).concurrency.key, 'decision-log-HRB');
  assert.equal(logEvent({ ...DECISION, key: jiraKey('OPS-1') }).concurrency.key, 'decision-log-OPS');
});

test('with two pages of one title already, rows go to the oldest', async () => {
  const confluence = new FakeConfluence();
  const deps = { space: spaceKey('DOCS'), confluence, site };
  await Promise.all([writeDecision(DECISION, deps), writeDecision({ ...DECISION, key: HRB3 }, deps)]);
  const [first, second] = confluence.titled('Release decisions: HRB');
  await writeDecision({ ...DECISION, key: jiraKey('HRB-9') }, deps);
  await writeDecision({ ...DECISION, key: jiraKey('HRB-10') }, deps);
  assert.equal(confluence.rows(first!.id), 3);
  assert.equal(confluence.rows(second!.id), 1);
});

test('a space that is gone, or a page without its table, fails the write loudly', async () => {
  await assert.rejects(writeDecision(DECISION, { space: spaceKey('GONE'), confluence: new FakeConfluence(), site }), DecisionLogError);
  const confluence = new FakeConfluence();
  await confluence.createPage('9001', 'Release decisions: HRB', '<p>someone removed the table</p>');
  await assert.rejects(writeDecision(DECISION, { space: spaceKey('DOCS'), confluence, site }), /has no table/);
});

test('space keys and queued decisions are checked strictly', () => {
  assert.equal(spaceKey('DOCS'), 'DOCS');
  assert.equal(spaceKey('~712020:dana'), '~712020:dana');
  for (const bad of ['', 'DO CS', 'DOCS/x', '~']) assert.throws(() => spaceKey(bad), /not a Confluence space key/);
  assert.deepEqual(parseLoggedDecision(JSON.parse(JSON.stringify(DECISION)), 'decision'), DECISION);
  assert.throws(() => parseLoggedDecision({ ...DECISION, key: 'nope' }, 'decision'), /not a Jira work item key/);
  assert.throws(() => parseLoggedDecision({ ...DECISION, answer: '' }, 'decision'), /decision\.answer/);
});

// The relays hand a decision to the log only once it is recorded in Jira
async function asked(): Promise<FakeJira> {
  const release = await seedRelease();
  const decisions = await findDecisions(release, { llm: false, implicit: { find: async () => [] } });
  const jira = new FakeJira();
  await askDecisions(release, decisions, { jira, preparer: templatePreparer, now: NOW });
  return jira;
}

test('a reply in Jira that ends the wait goes to the log with its answer and reply', async () => {
  const jira = await asked();
  const log = new FakeLog();
  const question = jira.states.get(HRB2)!.question;
  const unread = jira.reply(HRB2, DANA, 'not sure yet');
  await relayReply(HRB2, unread, { jira, reader: null, now: NOW, log });
  assert.deepEqual(log.recorded, [], 'a reply that decides nothing is not logged');

  const reply = jira.reply(HRB2, DANA, '2');
  await relayReply(HRB2, reply, { jira, reader: null, now: NOW, log });
  assert.deepEqual(log.recorded, [
    {
      key: HRB2,
      question,
      answer: 'option 2, Retire v1 tokens in 2.4: decided now, and 2.4 ships with HRB-2 done this way',
      decider: DANA,
      decidedAt: '2026-12-03T11:00:00.000Z',
      replyId: reply,
    },
  ]);
});

test('a failed log hand-off leaves the decision recorded', async () => {
  const jira = await asked();
  const failing = { record: async () => { throw new Error('queue down'); } };
  await assert.rejects(relayReply(HRB2, jira.reply(HRB2, DANA, '1'), { jira, reader: null, now: NOW, log: failing }), /queue down/);
  assert.equal(jira.states.get(HRB2)?.status, 'decided');
  assert.deepEqual(jira.labels.at(-1), { key: HRB2, present: false });
});

test('a reply on a pull request goes to the log with shipmill\'s relay comment as the reply', async () => {
  const jira = await asked();
  const log = new FakeLog();
  const state = jira.states.get(HRB2)!;
  const outcome = await relayPullRequestReply(
    {
      kind: 'decision-reply',
      sentAt: NOW().getTime(),
      key: HRB2,
      questionId: state.questionId,
      author: state.decider,
      text: '3',
      pullRequest: { id: 5, url: 'https://bitbucket.org/acme/harbor/pull-requests/5' },
    },
    { jira, reader: null, now: NOW, log },
  );
  assert.equal(outcome.relayed, true);
  const decided = jira.states.get(HRB2)!;
  assert.equal(decided.status, 'decided');
  assert.equal(log.recorded.length, 1);
  assert.equal(log.recorded[0]?.replyId, decided.status === 'decided' ? decided.replyId : null);
  assert.match(log.recorded[0]!.answer, /^option 3, /);
});
