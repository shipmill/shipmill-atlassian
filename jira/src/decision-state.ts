import { boolean, list, natural, nonEmpty, object, oneOf } from '@shipmill-atlassian/shared/parse';
import { commentId, parsePerson, timestamp, type CommentId, type Person } from '@shipmill-atlassian/shared/release';
import type { DecisionOption } from './prepare';

// What shipmill asked on a work item and whether it is answered, kept in the item's
// shipmill-decision entity property. It stands in for the protocol's marker comment: the
// question is the comment it names, posted by the app, and only a newer comment by the
// decider can answer it. The needs-decision label stays the sign a person reads.

export const PROPERTY = 'shipmill-decision';

export type Answer = { kind: 'option'; number: number } | { kind: 'own'; text: string };

type Asked = {
  questionId: CommentId;
  question: string;
  options: DecisionOption[];
  decider: Person;
  llm: boolean;
  askedAt: string;
};

export type DecisionState =
  | ({ status: 'waiting' } & Asked)
  | ({ status: 'decided'; replyId: CommentId; answer: Answer; decidedAt: string } & Asked);

export function parseDecisionState(value: unknown, path = PROPERTY): DecisionState {
  const fields = object(value, path);
  const options = list(fields.options, `${path}.options`, (entry, at) => {
    const option = object(entry, at);
    return { text: nonEmpty(option.text, `${at}.text`), reason: nonEmpty(option.reason, `${at}.reason`) };
  });
  const asked: Asked = {
    questionId: commentId(nonEmpty(fields.questionId, `${path}.questionId`)),
    question: nonEmpty(fields.question, `${path}.question`),
    options,
    decider: parsePerson(fields.decider, `${path}.decider`),
    llm: boolean(fields.llm, `${path}.llm`),
    askedAt: timestamp(fields.askedAt, `${path}.askedAt`),
  };
  const status = oneOf(fields.status, `${path}.status`, ['waiting', 'decided'] as const);
  if (status === 'waiting') return { status, ...asked };
  return {
    status,
    ...asked,
    replyId: commentId(nonEmpty(fields.replyId, `${path}.replyId`)),
    answer: parseAnswer(fields.answer, `${path}.answer`, options.length),
    decidedAt: timestamp(fields.decidedAt, `${path}.decidedAt`),
  };
}

function parseAnswer(value: unknown, path: string, options: number): Answer {
  const fields = object(value, path);
  const kind = oneOf(fields.kind, `${path}.kind`, ['option', 'own'] as const);
  if (kind === 'own') return { kind, text: nonEmpty(fields.text, `${path}.text`) };
  const number = natural(fields.number, `${path}.number`);
  if (number < 1 || number > options) throw new Error(`${path}.number: ${number} is not an option from 1 to ${options}`);
  return { kind, number };
}

// Jira gives comment ids in the order the comments were made
export function newer(reply: CommentId, question: CommentId): boolean {
  return BigInt(reply) > BigInt(question);
}
