import { parseDecisionOption, parseRecommended, type DecisionOption } from '@shipmill-atlassian/shared/decision';
import { jiraKey, type JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { ParseError, boolean, list, natural, nonEmpty, object, oneOf, type Fields } from '@shipmill-atlassian/shared/parse';
import { commentId, parsePerson, timestamp, type CommentId, type Person } from '@shipmill-atlassian/shared/release';

// A question asked on a work item, as a record: what was asked, by which agent and for whom,
// of whom, how careful the answer must be, and how it ended. The comment on the work item is
// its visible form and gives it its id; only a newer comment by the person asked can answer
// it. The needs-decision label stays the sign a person reads.
//
// The records live in Jira, in the work item's shipmill-questions entity property: every
// question asked on the item, oldest first, the last one being the current one. Jira REST
// reads it from whichever install serves a call, which Forge storage does not (storage is per
// install, and MCP calls are served from the Confluence install where the app has one). Beside
// the list the property carries a few fields about the current question, which Jira indexes
// for JQL (the jira:entityProperty module in manifest.yml), so the questions waiting in a
// project are one search (question-reads.ts).

export const PROPERTY = 'shipmill-questions';
const VERSION = 1;

// Jira takes 32768 bytes in an entity property. Past the budget the oldest closed questions
// leave the record; their comments stay on the work item
export const PROPERTY_BYTES = 32_000;

export const CARES = ['routine', 'careful'] as const;
// careful: irreversible, breaking, or outside the agent's mandate, so never answered in a batch
export type Care = (typeof CARES)[number];

export const STATUSES = ['waiting', 'answered', 'answered-from-record', 'withdrawn'] as const;
export type Status = (typeof STATUSES)[number];

export type Answer = { kind: 'option'; number: number } | { kind: 'own'; text: string };

// The agent that asked, and the Atlassian account it runs as; null for shipmill's own
// questions, which no person's agent asked
export type Asker = { agent: string; accountId: string | null };

// Where an earlier question lives: its work item and the comment that asked it
export type QuestionRef = { item: JiraKey; id: CommentId };

type Asked = {
  // The Jira comment that asks the question
  id: CommentId;
  question: string;
  options: DecisionOption[];
  // The number of the recommended option, which carries its reason; null when none is
  recommended: number | null;
  care: Care;
  askedBy: Asker;
  askedOf: Person;
  askedAt: string;
  // Whether a free-text reply is read by Claude; with it off the reply is an option number
  llm: boolean;
};

export type Waiting = Asked & { status: 'waiting' };
// replyId is the Jira comment that ended the wait: the reply of the person asked, or for a
// reply made on a pull request, shipmill's relay comment that quotes it
export type Answered = Asked & { status: 'answered'; answer: Answer; answeredBy: Person; answeredAt: string; replyId: CommentId };
// No person was asked: the agent went on by the answer an earlier question got. answer,
// answeredBy and answeredAt are that earlier answer's, and takenAt is when the agent took it
export type AnsweredFromRecord = Asked & {
  status: 'answered-from-record';
  answer: Answer;
  answeredBy: Person;
  answeredAt: string;
  from: QuestionRef;
  takenAt: string;
};
export type Withdrawn = Asked & { status: 'withdrawn'; withdrawnBy: Asker; withdrawnAt: string };

export type Question = Waiting | Answered | AnsweredFromRecord | Withdrawn;
export type Closed = Exclude<Question, Waiting>;

// The current question of a work item: the last one asked
export function current(questions: readonly Question[]): Question | undefined {
  return questions.at(-1);
}

// A work item holds one open question at a time, so a reply in its thread answers that one
export function withAsked(questions: readonly Question[], asked: Waiting): Question[] {
  const open = current(questions);
  if (open?.status === 'waiting') throw new Error(`question ${open.id} still waits on ${open.askedOf.displayName}`);
  if (questions.some((earlier) => earlier.id === asked.id)) throw new Error(`question ${asked.id} is already recorded`);
  return [...questions, asked];
}

// The current question ends: answered, answered from a record, or withdrawn
export function withClosed(questions: readonly Question[], closed: Closed): Question[] {
  const open = current(questions);
  if (open === undefined) throw new Error(`no question to close as ${closed.status}`);
  if (open.id !== closed.id) throw new Error(`question ${closed.id} is not the current one, ${open.id}`);
  if (open.status !== 'waiting') throw new Error(`question ${open.id} is already ${open.status}`);
  return [...questions.slice(0, -1), closed];
}

export function isAnswered(question: Question): question is Answered | AnsweredFromRecord {
  return question.status === 'answered' || question.status === 'answered-from-record';
}

// The fields Jira indexes, all about the current question (see manifest.yml); answered counts
// the answered questions on the item, the earlier ones too
type Index = { status: Status; askedOf: string; askedBy: string | null; answered: number };

function indexOf(questions: readonly Question[]): Index {
  const open = current(questions);
  if (open === undefined) throw new Error('a questions record needs a question');
  return {
    status: open.status,
    askedOf: open.askedOf.accountId,
    askedBy: open.askedBy.accountId,
    answered: questions.filter(isAnswered).length,
  };
}

export type PropertyValue = { version: typeof VERSION; questions: Question[] } & Index;

function value(questions: readonly Question[]): PropertyValue {
  return { version: VERSION, ...indexOf(questions), questions: [...questions] };
}

// The property as Jira stores it, and how many of the oldest closed questions were left out
// to fit Jira's limit. The current question always stays; one too large on its own is refused
export function propertyValue(questions: readonly Question[]): { value: PropertyValue; dropped: number } {
  let kept = [...questions];
  while (Buffer.byteLength(JSON.stringify(value(kept)), 'utf8') > PROPERTY_BYTES) {
    if (kept.length <= 1) throw new Error(`question ${kept[0]?.id ?? ''} takes more than the ${PROPERTY_BYTES} bytes a work item property holds`);
    kept = kept.slice(1);
  }
  return { value: value(kept), dropped: questions.length - kept.length };
}

export function parseProperty(raw: unknown, path = PROPERTY): Question[] {
  const fields = object(raw, path);
  if (fields.version !== VERSION) throw new ParseError(`${path}.version`, `expected ${VERSION}, got ${JSON.stringify(fields.version)}`);
  const questions = list(fields.questions, `${path}.questions`, parseQuestion);
  if (questions.length === 0) throw new ParseError(`${path}.questions`, 'a questions record needs a question');
  const ids = new Set(questions.map((question) => question.id));
  if (ids.size !== questions.length) throw new ParseError(`${path}.questions`, 'two questions share an id');
  for (const [index, question] of questions.slice(0, -1).entries()) {
    if (question.status === 'waiting') throw new ParseError(`${path}.questions[${index}].status`, 'only the last question can be waiting');
  }
  // The indexed fields are derived, so a record whose index says otherwise is corrupt
  for (const [name, expected] of Object.entries(indexOf(questions))) {
    if (fields[name] !== expected) {
      throw new ParseError(`${path}.${name}`, `expected ${JSON.stringify(expected)} as the questions give it, got ${JSON.stringify(fields[name])}`);
    }
  }
  return questions;
}

function parseAsker(raw: unknown, path: string): Asker {
  const fields = object(raw, path);
  return {
    agent: nonEmpty(fields.agent, `${path}.agent`),
    accountId: fields.accountId === null ? null : nonEmpty(fields.accountId, `${path}.accountId`),
  };
}

export function parseQuestion(raw: unknown, path: string): Question {
  const fields = object(raw, path);
  const options = list(fields.options, `${path}.options`, parseDecisionOption);
  if (options.length === 0) throw new ParseError(`${path}.options`, 'a question needs options');
  const asked: Asked = {
    id: commentId(nonEmpty(fields.id, `${path}.id`)),
    question: nonEmpty(fields.question, `${path}.question`),
    options,
    recommended: parseRecommended(fields.recommended, `${path}.recommended`, options),
    care: oneOf(fields.care, `${path}.care`, CARES),
    askedBy: parseAsker(fields.askedBy, `${path}.askedBy`),
    askedOf: parsePerson(fields.askedOf, `${path}.askedOf`),
    askedAt: timestamp(fields.askedAt, `${path}.askedAt`),
    llm: boolean(fields.llm, `${path}.llm`),
  };
  const status = oneOf(fields.status, `${path}.status`, STATUSES);
  switch (status) {
    case 'waiting':
      return { status, ...asked };
    case 'answered':
      return { status, ...asked, ...parseAnswered(fields, path, options.length), replyId: commentId(nonEmpty(fields.replyId, `${path}.replyId`)) };
    case 'answered-from-record': {
      const from = object(fields.from, `${path}.from`);
      return {
        status,
        ...asked,
        ...parseAnswered(fields, path, options.length),
        from: { item: jiraKey(nonEmpty(from.item, `${path}.from.item`)), id: commentId(nonEmpty(from.id, `${path}.from.id`)) },
        takenAt: timestamp(fields.takenAt, `${path}.takenAt`),
      };
    }
    case 'withdrawn':
      return {
        status,
        ...asked,
        withdrawnBy: parseAsker(fields.withdrawnBy, `${path}.withdrawnBy`),
        withdrawnAt: timestamp(fields.withdrawnAt, `${path}.withdrawnAt`),
      };
  }
}

function parseAnswered(fields: Fields, path: string, options: number): { answer: Answer; answeredBy: Person; answeredAt: string } {
  return {
    answer: parseAnswer(fields.answer, `${path}.answer`, options),
    answeredBy: parsePerson(fields.answeredBy, `${path}.answeredBy`),
    answeredAt: timestamp(fields.answeredAt, `${path}.answeredAt`),
  };
}

function parseAnswer(raw: unknown, path: string, options: number): Answer {
  const fields = object(raw, path);
  const kind = oneOf(fields.kind, `${path}.kind`, ['option', 'own'] as const);
  if (kind === 'own') return { kind, text: nonEmpty(fields.text, `${path}.text`) };
  const number = natural(fields.number, `${path}.number`);
  if (number < 1 || number > options) throw new ParseError(`${path}.number`, `${number} is not an option from 1 to ${options}`);
  return { kind, number };
}

// Jira gives comment ids in the order the comments were made
export function newer(reply: CommentId, question: CommentId): boolean {
  return BigInt(reply) > BigInt(question);
}
