import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraKey } from '@shipmill-atlassian/shared/jira-key';
import { commentId, type Person } from '@shipmill-atlassian/shared/release';
import { askDecisions } from './ask';
import {
  DecisionLogError,
  decisionRow,
  parseLoggedDecision,
  spaceKey,
  writeDecision,
  type Confluence,
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

// An in-memory Confluence with one space, DOCS
class FakeConfluence implements Confluence {
  readonly pages = new Map<string, Page & { title: string; spaceId: string }>();
  #next = 100;

  async spaceId(space: string): Promise<string | undefined> {
    return space === 'DOCS' ? '9001' : undefined;
  }

  async page(spaceId: string, title: string): Promise<Page | undefined> {
    return [...this.pages.values()].find((page) => page.spaceId === spaceId && page.title === title);
  }

  async createPage(spaceId: string, title: string, body: string): Promise<string> {
    const id = String(this.#next++);
    this.pages.set(id, { id, spaceId, title, version: 1, body });
    return id;
  }

  async updatePage(page: Page, title: string, body: string): Promise<void> {
    const stored = this.pages.get(page.id)!;
    assert.equal(stored.version, page.version, 'updated from a stale version');
    this.pages.set(page.id, { ...stored, title, body, version: page.version + 1 });
  }

  rows(id: string): number {
    return (this.pages.get(id)!.body.match(/<tr>/g) ?? []).length - 1;
  }
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
  assert.equal(confluence.pages.size, 0);
});

test('the first decision creates the project\'s page, the next adds a row to it', async () => {
  const confluence = new FakeConfluence();
  const deps = { space: spaceKey('DOCS'), confluence, site };
  const first = await writeDecision(DECISION, deps);
  assert.deepEqual(first, { written: true, page: '100', created: true });
  assert.equal(confluence.pages.get('100')?.title, 'Release decisions: HRB');
  assert.equal(confluence.rows('100'), 1);

  const second = await writeDecision({ ...DECISION, key: HRB3, replyId: commentId('20009') }, deps);
  assert.deepEqual(second, { written: true, page: '100', created: false });
  const page = confluence.pages.get('100')!;
  assert.equal(page.version, 2);
  assert.equal(confluence.rows('100'), 2);
  assert.ok(page.body.indexOf('>HRB-2<') < page.body.indexOf('>HRB-3<'), 'rows in the order decided');
  assert.ok(page.body.endsWith('</tbody></table>'));

  // Another project gets its own page
  await writeDecision({ ...DECISION, key: jiraKey('OPS-1') }, deps);
  assert.equal(confluence.pages.get('101')?.title, 'Release decisions: OPS');
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
