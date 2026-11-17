import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraKey, projectKey } from '@shipmill-atlassian/shared/jira-key';
import { NEEDS_DECISION, commentId, type Person } from '@shipmill-atlassian/shared/release';
import { askAgentQuestion, withdrawQuestion, type AgentQuestion, type AskedItem } from './ask';
import { FakeJira, FakeLog } from './fake-jira';
import type { JiraRest, SearchRequest } from './jira-rest';
import {
  PROPERTY,
  PROPERTY_BYTES,
  parseProperty,
  propertyValue,
  withAsked,
  withClosed,
  type Answered,
  type AnsweredFromRecord,
  type Asker,
  type Question,
  type Waiting,
} from './question';
import { answeredQuestions, indexJql, questionOn, searchIndex, waitingQuestions } from './question-reads';
import { relayReply } from './relay';

// The life of a question as a record: asked, answered, withdrawn, asked again on the same
// work item, and the reads the queue and the lookup of earlier answers stand on.

const LEE: Person = { accountId: '712020:lee', displayName: 'Lee Park' };
const DANA: Person = { accountId: '712020:dana', displayName: 'Dana Okafor' };
const CLAUDE: Asker = { agent: 'Claude Code', accountId: '557058:dev' };
const OTHER_DEV = '557058:other-dev';
const CURSOR: Asker = { agent: 'Cursor', accountId: OTHER_DEV };

const HRB1: AskedItem = { key: jiraKey('HRB-1'), labels: [], owner: LEE, reporter: DANA };
const HRB2: AskedItem = { key: jiraKey('HRB-2'), labels: [NEEDS_DECISION], owner: DANA, reporter: LEE };
const HRB6: AskedItem = { key: jiraKey('HRB-6'), labels: [], owner: null, reporter: null };
const OPS9: AskedItem = { key: jiraKey('OPS-9'), labels: [], owner: LEE, reporter: null };
const HRB = projectKey('HRB');

const RETRY: AgentQuestion = {
  question: 'Retry the payment webhook three times, or fail on the first error?',
  options: [
    { text: 'Retry three times with backoff', reason: 'the provider asks for it and the handler is idempotent' },
    { text: 'Fail on the first error', reason: null },
  ],
  recommended: 1,
  care: 'routine',
  askedBy: CLAUDE,
};

const DROP: AgentQuestion = {
  question: 'Drop the legacy_sessions table in this migration?',
  options: [
    { text: 'Drop it now', reason: null },
    { text: 'Keep it one more release', reason: null },
  ],
  recommended: null,
  care: 'careful',
  askedBy: CLAUDE,
};

function clock(...times: string[]): () => Date {
  let at = 0;
  return () => {
    const time = times[Math.min(at++, times.length - 1)];
    if (time === undefined) throw new Error('a clock needs a time');
    return new Date(time);
  };
}

const T1 = '2026-12-03T09:00:00.000Z';
const T2 = '2026-12-03T09:30:00.000Z';
const T3 = '2026-12-03T10:00:00.000Z';
const T4 = '2026-12-03T11:00:00.000Z';

function relayDeps(jira: FakeJira, time: string) {
  return { jira, reader: null, now: clock(time), log: new FakeLog() };
}

test('asked: the record holds every field, and the work item shows the question and gets the label', async () => {
  const jira = new FakeJira();
  const outcome = await askAgentQuestion(HRB1, RETRY, { jira, now: clock(T1) });
  if (!outcome.asked) throw new Error('expected the question to be asked');

  assert.deepEqual(await questionOn(jira, HRB1.key), {
    status: 'waiting',
    id: outcome.questionId,
    question: RETRY.question,
    options: RETRY.options,
    recommended: 1,
    care: 'routine',
    askedBy: CLAUDE,
    // The person on the work item is the one asked
    askedOf: LEE,
    askedAt: T1,
    llm: false,
  });

  assert.equal(
    jira.posted(HRB1.key)[0]?.text,
    [
      '@Lee Park Decision needed: Retry the payment webhook three times, or fail on the first error?',
      // An ordered list in the comment: Jira numbers the options
      'Retry three times with backoff (recommended): the provider asks for it and the handler is idempotent\nFail on the first error',
      'Asked by Claude Code, an agent, which marked this routine.',
      'Reply here with a number; shipmill takes this up as soon as you reply.',
    ].join('\n'),
  );
  assert.deepEqual(jira.labels, [{ key: HRB1.key, present: true }]);

  // Jira indexes these for the queue's search
  const stored = jira.properties.get(HRB1.key);
  assert.deepEqual(
    [stored?.status, stored?.askedOf, stored?.askedBy, stored?.answered],
    ['waiting', LEE.accountId, CLAUDE.accountId, 0],
  );
});

test('asked: a careful question with no recommendation says so, and nobody on the item sends it to the project lead', async () => {
  const jira = new FakeJira();
  await askAgentQuestion(HRB6, DROP, { jira, now: clock(T1) });
  const question = await questionOn(jira, HRB6.key);
  assert.equal(question?.care, 'careful');
  assert.equal(question?.recommended, null);
  assert.equal(question?.askedOf.displayName, 'Project Lead');
  assert.match(jira.posted(HRB6.key)[0]!.text, /\nDrop it now\nKeep it one more release\nAsked by Claude Code, an agent, which marked this careful: it is answered on its own, never in a batch\./);
  // HRB-2 carries the label already, so asking adds none
  await askAgentQuestion(HRB2, DROP, { jira, now: clock(T1) });
  assert.deepEqual(jira.labels, [{ key: HRB6.key, present: true }]);
});

test('a work item that waits on an answer is not asked twice', async () => {
  const jira = new FakeJira();
  await askAgentQuestion(HRB1, RETRY, { jira, now: clock(T1) });
  assert.deepEqual(await askAgentQuestion(HRB1, DROP, { jira, now: clock(T2) }), { key: HRB1.key, asked: false, reason: 'waiting' });
  assert.equal(jira.posted(HRB1.key).length, 1);
  assert.equal((await jira.questions(HRB1.key)).length, 1);
});

test('answered: a reply by number closes the record with the answer, who gave it and when', async () => {
  const jira = new FakeJira();
  await askAgentQuestion(HRB1, RETRY, { jira, now: clock(T1) });
  const reply = jira.reply(HRB1.key, LEE, '1');
  assert.deepEqual(await relayReply(HRB1.key, reply, relayDeps(jira, T3)), { key: HRB1.key, relayed: true, answer: { kind: 'option', number: 1 } });

  const question = await questionOn(jira, HRB1.key);
  if (question?.status !== 'answered') throw new Error(`expected answered, got ${question?.status}`);
  assert.deepEqual(question.answer, { kind: 'option', number: 1 });
  assert.deepEqual(question.answeredBy, LEE);
  assert.equal(question.answeredAt, T3);
  assert.equal(question.replyId, reply);
  // What was asked stays as it was
  assert.equal(question.askedAt, T1);
  assert.deepEqual(question.askedBy, CLAUDE);

  assert.equal(
    jira.posted(HRB1.key).at(-1)?.text,
    'Decision by @Lee Park, relayed by shipmill\nAnswered in Jira: option 1, Retry three times with backoff (recommended): the provider asks for it and the handler is idempotent',
  );
  assert.deepEqual(jira.labels.at(-1), { key: HRB1.key, present: false });
  assert.equal(jira.properties.get(HRB1.key)?.status, 'answered');
  assert.equal(jira.properties.get(HRB1.key)?.answered, 1);
});

test('answered: an option with no reason is relayed by its text alone', async () => {
  const jira = new FakeJira();
  await askAgentQuestion(HRB1, DROP, { jira, now: clock(T1) });
  await relayReply(HRB1.key, jira.reply(HRB1.key, LEE, '2'), relayDeps(jira, T3));
  assert.equal(jira.posted(HRB1.key).at(-1)?.text, 'Decision by @Lee Park, relayed by shipmill\nAnswered in Jira: option 2, Keep it one more release');
});

test('withdrawn: the asker takes the question back; the record, the work item and the label say so', async () => {
  const jira = new FakeJira();
  const asked = await askAgentQuestion(HRB1, RETRY, { jira, now: clock(T1) });

  // Only the account that asked may withdraw
  assert.deepEqual(await withdrawQuestion(HRB1.key, CURSOR, { jira, now: clock(T2) }), { key: HRB1.key, withdrawn: false, reason: 'not-asker' });
  assert.equal((await questionOn(jira, HRB1.key))?.status, 'waiting');

  const outcome = await withdrawQuestion(HRB1.key, CLAUDE, { jira, now: clock(T2) });
  assert.deepEqual(outcome, { key: HRB1.key, withdrawn: true, questionId: asked.asked ? asked.questionId : null });
  const question = await questionOn(jira, HRB1.key);
  if (question?.status !== 'withdrawn') throw new Error(`expected withdrawn, got ${question?.status}`);
  assert.deepEqual(question.withdrawnBy, CLAUDE);
  assert.equal(question.withdrawnAt, T2);
  assert.equal(jira.posted(HRB1.key).at(-1)?.text, 'Question withdrawn by Claude Code: it no longer waits on @Lee Park.');
  assert.deepEqual(jira.labels.at(-1), { key: HRB1.key, present: false });

  // Nothing waits any more: a late reply answers nothing, and a second withdrawal does nothing
  const late = jira.reply(HRB1.key, LEE, '1');
  assert.deepEqual(await relayReply(HRB1.key, late, relayDeps(jira, T3)), { key: HRB1.key, relayed: false, reason: 'no-question' });
  assert.deepEqual(await withdrawQuestion(HRB1.key, CLAUDE, { jira, now: clock(T3) }), { key: HRB1.key, withdrawn: false, reason: 'not-waiting' });
  assert.deepEqual(await withdrawQuestion(HRB2.key, CLAUDE, { jira, now: clock(T3) }), { key: HRB2.key, withdrawn: false, reason: 'no-question' });
  assert.equal((await questionOn(jira, HRB1.key))?.status, 'withdrawn');
});

test('asked again on the same work item: a new record beside the earlier ones, which keep their answers', async () => {
  const jira = new FakeJira();
  const first = await askAgentQuestion(HRB1, RETRY, { jira, now: clock(T1) });
  await relayReply(HRB1.key, jira.reply(HRB1.key, LEE, '1'), relayDeps(jira, T2));
  const second = await askAgentQuestion(HRB1, DROP, { jira, now: clock(T3) });
  if (!first.asked || !second.asked) throw new Error('expected both questions to be asked');
  assert.notEqual(second.questionId, first.questionId);

  const questions = await jira.questions(HRB1.key);
  assert.deepEqual(questions.map((question) => [question.id, question.status, question.question]), [
    [first.questionId, 'answered', RETRY.question],
    [second.questionId, 'waiting', DROP.question],
  ]);
  // The current question is the new one, and the earlier answer is still counted
  assert.equal((await questionOn(jira, HRB1.key))?.id, second.questionId);
  assert.equal(jira.properties.get(HRB1.key)?.status, 'waiting');
  assert.equal(jira.properties.get(HRB1.key)?.answered, 1);

  // A reply now answers the new question, not the earlier one
  await relayReply(HRB1.key, jira.reply(HRB1.key, LEE, '2'), relayDeps(jira, T4));
  assert.deepEqual((await jira.questions(HRB1.key)).map((question) => question.status), ['answered', 'answered']);

  // And after a withdrawal the item can be asked again too
  await askAgentQuestion(HRB6, DROP, { jira, now: clock(T1) });
  await withdrawQuestion(HRB6.key, CLAUDE, { jira, now: clock(T2) });
  assert.equal((await askAgentQuestion(HRB6, RETRY, { jira, now: clock(T3) })).asked, true);
  assert.deepEqual((await jira.questions(HRB6.key)).map((question) => question.status), ['withdrawn', 'waiting']);
});

test('reads: the questions waiting on a person, oldest first, by project, person asked and asking account', async () => {
  const jira = new FakeJira();
  await askAgentQuestion(HRB2, DROP, { jira, now: clock(T2) });
  await askAgentQuestion(HRB1, RETRY, { jira, now: clock(T1) });
  await askAgentQuestion(OPS9, { ...RETRY, askedBy: CURSOR }, { jira, now: clock(T3) });
  await askAgentQuestion(HRB6, RETRY, { jira, now: clock(T1) });
  await withdrawQuestion(HRB6.key, CLAUDE, { jira, now: clock(T2) });

  const keys = (listed: { key: string }[]) => listed.map((entry) => entry.key);
  assert.deepEqual(keys(await waitingQuestions(jira.index, { project: HRB })), ['HRB-1', 'HRB-2']);
  assert.deepEqual(keys(await waitingQuestions(jira.index, { askedOf: LEE.accountId })), ['HRB-1', 'OPS-9']);
  assert.deepEqual(keys(await waitingQuestions(jira.index, { project: HRB, askedOf: DANA.accountId })), ['HRB-2']);
  assert.deepEqual(keys(await waitingQuestions(jira.index, { askedBy: OTHER_DEV })), ['OPS-9']);
  assert.deepEqual(keys(await waitingQuestions(jira.index, {})), ['HRB-1', 'HRB-2', 'OPS-9']);

  const [oldest] = await waitingQuestions(jira.index, { project: HRB });
  assert.equal(oldest?.question.status, 'waiting');
  assert.equal(oldest?.question.question, RETRY.question);

  await relayReply(HRB1.key, jira.reply(HRB1.key, LEE, '1'), relayDeps(jira, T4));
  assert.deepEqual(keys(await waitingQuestions(jira.index, { askedOf: LEE.accountId })), ['OPS-9']);
});

test('reads: a search that trails the record never lists an answered question as waiting', async () => {
  const jira = new FakeJira();
  await askAgentQuestion(HRB1, RETRY, { jira, now: clock(T1) });
  const stale = await jira.index.find({ status: 'waiting' });
  await relayReply(HRB1.key, jira.reply(HRB1.key, LEE, '1'), relayDeps(jira, T2));
  // The index still matches the item, but hands back the record as it is now
  const trailing = { find: async () => stale.map(({ key }) => ({ key, questions: [] as Question[] })) };
  for (const entry of await trailing.find()) entry.questions.push(...(await jira.questions(entry.key)));
  assert.deepEqual(await waitingQuestions(trailing, { project: HRB }), []);
});

test("reads: a project's answered questions, the newest answer first, earlier ones on an item included", async () => {
  const jira = new FakeJira();
  await askAgentQuestion(HRB1, RETRY, { jira, now: clock(T1) });
  await relayReply(HRB1.key, jira.reply(HRB1.key, LEE, '1'), relayDeps(jira, T2));
  // Asked again: HRB-1's current question waits, its earlier one stays answered
  await askAgentQuestion(HRB1, DROP, { jira, now: clock(T3) });
  await askAgentQuestion(HRB2, DROP, { jira, now: clock(T1) });
  await relayReply(HRB2.key, jira.reply(HRB2.key, DANA, '2'), relayDeps(jira, T4));
  await askAgentQuestion(HRB6, RETRY, { jira, now: clock(T1) });
  await askAgentQuestion(OPS9, RETRY, { jira, now: clock(T1) });
  await relayReply(OPS9.key, jira.reply(OPS9.key, LEE, '1'), relayDeps(jira, T4));

  const answered = await answeredQuestions(jira.index, HRB);
  assert.deepEqual(
    answered.map(({ key, question }) => [key, question.question, question.answeredBy.displayName, question.answeredAt]),
    [
      ['HRB-2', DROP.question, 'Dana Okafor', T4],
      ['HRB-1', RETRY.question, 'Lee Park', T2],
    ],
  );
  assert.deepEqual(await answeredQuestions(jira.index, projectKey('NONE')), []);
});

test('reads: one question by work item is its current one, from the item itself', async () => {
  const jira = new FakeJira();
  assert.equal(await questionOn(jira, HRB1.key), undefined);
  await askAgentQuestion(HRB1, RETRY, { jira, now: clock(T1) });
  assert.equal((await questionOn(jira, HRB1.key))?.status, 'waiting');
});

// The record itself

function waiting(id: string, question = 'Ship it?'): Waiting {
  return {
    status: 'waiting',
    id: commentId(id),
    question,
    options: [
      { text: 'Yes', reason: 'the checks are green' },
      { text: 'No', reason: null },
    ],
    recommended: 1,
    care: 'careful',
    askedBy: CLAUDE,
    askedOf: LEE,
    askedAt: T1,
    llm: false,
  };
}

function answered(id: string, question?: string): Answered {
  return { ...waiting(id, question), status: 'answered', answer: { kind: 'option', number: 1 }, answeredBy: LEE, answeredAt: T2, replyId: commentId(String(Number(id) + 1)) };
}

test('a question answered from a record keeps the earlier answer, who gave it, when, and where it came from', async () => {
  const jira = new FakeJira();
  const fromRecord: AnsweredFromRecord = {
    ...waiting('300'),
    status: 'answered-from-record',
    answer: { kind: 'own', text: 'option 1, Retry three times with backoff' },
    answeredBy: LEE,
    answeredAt: T2,
    from: { item: HRB1.key, id: commentId('100') },
    takenAt: T3,
  };
  await jira.setQuestions(HRB2.key, withClosed([waiting('300')], fromRecord));
  assert.deepEqual(await questionOn(jira, HRB2.key), fromRecord);
  // It counts among the project's answered questions, at the time the agent took the answer
  await jira.setQuestions(HRB1.key, [answered('100')]);
  assert.deepEqual((await answeredQuestions(jira.index, HRB)).map((entry) => [entry.key, entry.question.status]), [
    ['HRB-2', 'answered-from-record'],
    ['HRB-1', 'answered'],
  ]);
  assert.throws(() => parseProperty({ ...propertyValue([fromRecord]).value, questions: [{ ...fromRecord, from: { item: 'hrb-1', id: '100' } }] }), /not a Jira work item key/);
});

test('the record refuses a second open question, and closes only the current waiting one', () => {
  assert.throws(() => withAsked([waiting('100')], waiting('200')), /question 100 still waits on Lee Park/);
  assert.throws(() => withAsked([answered('100')], waiting('100')), /already recorded/);
  assert.throws(() => withClosed([], answered('100')), /no question to close/);
  assert.throws(() => withClosed([answered('100'), waiting('200')], answered('100')), /not the current one/);
  assert.throws(() => withClosed([answered('100')], answered('100')), /already answered/);
  assert.deepEqual(withClosed([answered('100'), waiting('200')], answered('200')).map((question) => question.status), ['answered', 'answered']);
});

test('the property is read strictly, index fields included', () => {
  const { value } = propertyValue([answered('100'), waiting('200')]);
  assert.deepEqual(parseProperty(JSON.parse(JSON.stringify(value))), [answered('100'), waiting('200')]);
  assert.deepEqual(
    { version: value.version, status: value.status, askedOf: value.askedOf, askedBy: value.askedBy, answered: value.answered },
    { version: 1, status: 'waiting', askedOf: LEE.accountId, askedBy: CLAUDE.accountId, answered: 1 },
  );
  for (const [bad, message] of [
    [{ ...value, version: 2 }, /version/],
    [{ ...value, status: 'answered' }, /shipmill-questions\.status: expected "waiting"/],
    [{ ...value, answered: 0 }, /shipmill-questions\.answered/],
    [{ ...value, askedOf: DANA.accountId }, /shipmill-questions\.askedOf/],
    [{ ...value, questions: [] }, /needs a question/],
    [{ ...value, questions: [waiting('100'), waiting('200')] }, /only the last question can be waiting/],
    [{ ...value, questions: [answered('200'), waiting('200')] }, /share an id/],
    [{ ...value, questions: [answered('100'), { ...waiting('200'), care: 'urgent' }] }, /care/],
    [{ ...value, questions: [answered('100'), { ...waiting('200'), recommended: 2 }] }, /recommended option 2 needs its reason/],
    [{ ...value, questions: [{ ...answered('100'), answer: { kind: 'option', number: 3 } }, waiting('200')] }, /3 is not an option from 1 to 2/],
    [{ ...value, questions: [{ ...answered('100'), answeredBy: undefined }, waiting('200')] }, /answeredBy/],
    [{ ...value, questions: [answered('100'), { ...waiting('200'), askedBy: { agent: '' , accountId: null } }] }, /askedBy\.agent/],
  ] as const) {
    assert.throws(() => parseProperty(JSON.parse(JSON.stringify(bad))), message);
  }
});

test("past Jira's size limit the oldest closed questions leave the record, never the current one", () => {
  const long = 'x'.repeat(900);
  const many = Array.from({ length: 40 }, (_, index) => answered(String(1000 + index * 2), `${long} ${index}?`));
  const all = [...many, waiting('5000')];
  const { value, dropped } = propertyValue(all);
  assert.ok(dropped > 0 && dropped < many.length, `dropped ${dropped}`);
  assert.ok(Buffer.byteLength(JSON.stringify(value), 'utf8') <= PROPERTY_BYTES);
  assert.equal(value.questions.at(-1)?.id, '5000');
  assert.equal(value.questions[0]?.id, many[dropped]?.id);
  // The index counts what the record still holds
  assert.equal(value.answered, many.length - dropped);
  assert.deepEqual(parseProperty(JSON.parse(JSON.stringify(value))), all.slice(dropped));
  assert.equal(propertyValue([answered('100'), waiting('200')]).dropped, 0);
  assert.throws(() => propertyValue([waiting('100', 'y'.repeat(PROPERTY_BYTES))]), /takes more than the 32000 bytes/);
});

// The index over Jira's search

test('the index asks Jira by the indexed fields', () => {
  assert.equal(indexJql({ project: HRB, status: 'waiting' }), 'project = "HRB" AND agentQuestionStatus = "waiting" ORDER BY key ASC');
  assert.equal(
    indexJql({ status: 'waiting', askedOf: '712020:lee', askedBy: '557058:dev' }),
    'agentQuestionStatus = "waiting" AND agentQuestionAskedOf = "712020:lee" AND agentQuestionAskedBy = "557058:dev" ORDER BY key ASC',
  );
  assert.equal(indexJql({ project: HRB, answered: true }), 'project = "HRB" AND agentQuestionsAnswered > 0 ORDER BY key ASC');
  assert.equal(indexJql({ status: 'waiting', askedOf: 'a"b' }), 'agentQuestionStatus = "waiting" AND agentQuestionAskedOf = "a\\"b" ORDER BY key ASC');
  assert.throws(() => indexJql({ project: HRB }), /needs a status, or answered/);
});

test('the index pages through the search and reads each record strictly', async () => {
  const record = propertyValue([waiting('100')]).value;
  const pages: unknown[] = [
    { issues: [{ key: 'HRB-1', properties: { [PROPERTY]: record } }], nextPageToken: 'next' },
    { issues: [{ key: 'HRB-2', properties: {} }, { key: 'HRB-3', properties: { [PROPERTY]: record } }], isLast: true },
  ];
  const searches: SearchRequest[] = [];
  const rest: JiraRest = {
    async search(request) {
      searches.push(request);
      const page = pages[searches.length - 1];
      if (page === undefined) throw new Error('no page');
      return page;
    },
    async comments() {
      throw new Error('the index reads no comments');
    },
  };
  const found = await searchIndex(rest).find({ project: HRB, status: 'waiting' });
  // HRB-2 matched the search but its record is gone since
  assert.deepEqual(found.map((entry) => [entry.key, entry.questions.length]), [['HRB-1', 1], ['HRB-3', 1]]);
  assert.deepEqual(searches.map((search) => [search.jql, search.properties, search.nextPageToken]), [
    ['project = "HRB" AND agentQuestionStatus = "waiting" ORDER BY key ASC', [PROPERTY], undefined],
    ['project = "HRB" AND agentQuestionStatus = "waiting" ORDER BY key ASC', [PROPERTY], 'next'],
  ]);

  const corrupt: JiraRest = { ...rest, search: async () => ({ issues: [{ key: 'HRB-1', properties: { [PROPERTY]: { ...record, status: 'answered' } } }], isLast: true }) };
  await assert.rejects(searchIndex(corrupt).find({ status: 'waiting' }), /HRB-1\.shipmill-questions\.status/);
});
