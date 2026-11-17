import { jiraKey, type JiraKey } from './jira-key';
import { ParseError, boolean, list, natural, nonEmpty, object, oneOf } from './parse';
import { commentId, parsePerson, type CommentId, type Person } from './release';

// A decision shipmill asked on a Jira work item, as both apps see it: the Jira app asks it
// and keeps the answer, the Bitbucket app asks it again on the work item's pull requests and
// sends back a reply made there. The question is named by the Jira comment that asked it.

// reason: why, or what the option costs; an agent's own question may give one for the
// recommended option only
export type DecisionOption = { text: string; reason: string | null };

export function optionLine(option: DecisionOption, recommended: boolean): string {
  const text = recommended ? `${option.text} (recommended)` : option.text;
  return option.reason === null ? text : `${text}: ${option.reason}`;
}

// The options as the question numbers them, from 1; recommended is that number, or null
export function optionLines(options: readonly DecisionOption[], recommended: number | null): string[] {
  return options.map((option, index) => `${index + 1}. ${optionLine(option, index + 1 === recommended)}`);
}

export type AskedQuestion = {
  questionId: CommentId;
  question: string;
  options: DecisionOption[];
  // The number of the recommended option, which carries its reason; null when none is.
  // A question shipmill prepares puts it first
  recommended: number | null;
  decider: Person;
  // Whether a free-text reply is read by Claude; with it off the reply is an option number
  llm: boolean;
};

// The Jira app's answer to a decision query: nothing asked, waiting, or decided with the answer
export type DecisionView =
  | { key: JiraKey; status: 'none' }
  | ({ key: JiraKey; status: 'waiting' } & AskedQuestion)
  | ({ key: JiraKey; status: 'decided'; answer: string } & AskedQuestion);

export function parseDecisionOption(value: unknown, path: string): DecisionOption {
  const fields = object(value, path);
  return { text: nonEmpty(fields.text, `${path}.text`), reason: fields.reason === null ? null : nonEmpty(fields.reason, `${path}.reason`) };
}

export function parseRecommended(value: unknown, path: string, options: readonly DecisionOption[]): number | null {
  if (value === null) return null;
  const number = natural(value, path);
  const option = options[number - 1];
  if (number < 1 || option === undefined) throw new ParseError(path, `${number} is not an option from 1 to ${options.length}`);
  if (option.reason === null) throw new ParseError(path, `the recommended option ${number} needs its reason`);
  return number;
}

export function parseDecisionView(value: unknown, path = 'decision'): DecisionView {
  const fields = object(value, path);
  const key = jiraKey(nonEmpty(fields.key, `${path}.key`));
  const status = oneOf(fields.status, `${path}.status`, ['none', 'waiting', 'decided'] as const);
  if (status === 'none') return { key, status };
  const options = list(fields.options, `${path}.options`, parseDecisionOption);
  const asked: AskedQuestion = {
    questionId: commentId(nonEmpty(fields.questionId, `${path}.questionId`)),
    question: nonEmpty(fields.question, `${path}.question`),
    options,
    recommended: parseRecommended(fields.recommended, `${path}.recommended`, options),
    decider: parsePerson(fields.decider, `${path}.decider`),
    llm: boolean(fields.llm, `${path}.llm`),
  };
  if (asked.options.length === 0) throw new ParseError(`${path}.options`, 'a question needs options');
  if (status === 'waiting') return { key, status, ...asked };
  return { key, status, ...asked, answer: nonEmpty(fields.answer, `${path}.answer`) };
}

// What the Jira app did with a reply made on a pull request
export const REPLY_REASONS = ['no-question', 'other-question', 'decided', 'not-decider', 'unread', 'no-answer'] as const;
export type ReplyReason = (typeof REPLY_REASONS)[number];
export type ReplyOutcome = { relayed: true; answer: string } | { relayed: false; reason: ReplyReason };

export function parseReplyOutcome(value: unknown, path = 'reply'): ReplyOutcome {
  const fields = object(value, path);
  if (boolean(fields.relayed, `${path}.relayed`)) return { relayed: true, answer: nonEmpty(fields.answer, `${path}.answer`) };
  return { relayed: false, reason: oneOf(fields.reason, `${path}.reason`, REPLY_REASONS) };
}
