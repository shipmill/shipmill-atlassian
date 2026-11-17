import type { Prompt } from '@forge/llm';
import type { JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { natural, nonEmpty, oneOf } from '@shipmill-atlassian/shared/parse';
import type { CommentId } from '@shipmill-atlassian/shared/release';
import { optionLine, optionLines, relayComment, unreadComment } from './comment';
import type { DecisionJira } from './decision-jira';
import type { DecisionLog } from './decision-log';
import { current, newer, withClosed, type Answer, type Question } from './question';
import { MODEL, type Chat } from './llm-finder';
import { logUsage, toolArguments } from './llm-tool';

// The relay: a reply by the person asked ends the wait. shipmill posts "Decision by `@x`,
// relayed by shipmill" with the answer, removes the needs-decision label, and closes the
// question's record with the answer, who gave it and when, then hands it to the Confluence
// decision log. A reply that starts with an option number is read by code; with the LLM on,
// Claude reads any other reply, and with it off such a reply gets a note and the question
// stays open. Anyone else's comment, or one older than the question, never counts.

export interface ReplyReader {
  read(question: Question, reply: string): Promise<Answer | null>;
}

export class ReplyError extends Error {}

// "2", "2.", "#2", "option 2: ..." count; a number later in the reply does not
const NUMBER = /^\s*(?:option\s*)?#?(\d+)(?![\d.,]\d)/i;

export function optionNumber(reply: string, options: number): number | null {
  const found = NUMBER.exec(reply);
  if (found?.[1] === undefined) return null;
  const number = Number(found[1]);
  return number >= 1 && number <= options ? number : null;
}

export function answerText(question: Question, answer: Answer): string {
  if (answer.kind === 'own') return answer.text;
  const option = question.options[answer.number - 1];
  if (option === undefined) throw new ReplyError(`option ${answer.number} is not one of ${question.options.length}`);
  return `option ${answer.number}, ${optionLine(option, answer.number === question.recommended)}`;
}

export type RelayOutcome =
  | { key: JiraKey; relayed: true; answer: Answer }
  | { key: JiraKey; relayed: false; reason: 'no-question' | 'decided' | 'not-newer' | 'not-decider' | 'unread' | 'no-answer' };

export async function relayReply(
  key: JiraKey,
  replyId: CommentId,
  deps: { jira: DecisionJira; reader: ReplyReader | null; now: () => Date; log: DecisionLog },
): Promise<RelayOutcome> {
  const questions = await deps.jira.questions(key);
  const open = current(questions);
  // A withdrawn question waits on nobody, so a reply after it answers nothing
  if (open === undefined || open.status === 'withdrawn') return { key, relayed: false, reason: 'no-question' };
  if (open.status !== 'waiting') return { key, relayed: false, reason: 'decided' };
  if (!newer(replyId, open.id)) return { key, relayed: false, reason: 'not-newer' };
  const reply = await deps.jira.comment(key, replyId);
  if (reply.author.accountId !== open.askedOf.accountId) return { key, relayed: false, reason: 'not-decider' };
  const reading = await readReply(open, reply.text, deps.reader);
  if (reading === 'unread') {
    await deps.jira.postComment(key, unreadComment(open.askedOf, open.options.length));
    return { key, relayed: false, reason: 'unread' };
  }
  if (reading === 'no-answer') return { key, relayed: false, reason: 'no-answer' };
  const answer = answerText(open, reading);
  await deps.jira.postComment(key, relayComment(reply.author, answer));
  await deps.jira.label(key, false);
  const answeredAt = deps.now().toISOString();
  await deps.jira.setQuestions(key, withClosed(questions, { ...open, status: 'answered', answer: reading, answeredBy: reply.author, answeredAt, replyId }));
  // Only once the decision is recorded: the log never holds a decision Jira doesn't
  await deps.log.record({ key, question: open.question, answer, decider: reply.author, decidedAt: answeredAt, replyId });
  return { key, relayed: true, answer: reading };
}

// What a reply by the decider decides. The question said how to reply: a number while the
// LLM was off when it was asked, so only then is a reply without one "unread"; with it on,
// Claude reads the reply, and one that decides nothing yet is "no-answer".
export async function readReply(question: Question, reply: string, reader: ReplyReader | null): Promise<Answer | 'unread' | 'no-answer'> {
  const number = optionNumber(reply, question.options.length);
  if (number !== null) return { kind: 'option', number };
  if (!question.llm || reader === null) return 'unread';
  return (await reader.read(question, reply)) ?? 'no-answer';
}

// Claude reads a free-text reply against the options

const TOOL = 'read_reply';
const MAX_TOKENS = 500;

const SYSTEM = `A person was asked to make a decision that blocks a software release, and replied. Read the reply and say what they decided.

- "option": the reply picks one of the numbered options, in any words
- "own": the reply decides something the options don't cover; give it in one sentence, in their words where you can
- "none": the reply decides nothing yet (it asks something back, defers, discusses)

Call ${TOOL} exactly once.`;

const PARAMETERS = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['option', 'own', 'none'] },
    option: { type: ['integer', 'null'], description: 'The option number for "option", else null' },
    answer: { type: ['string', 'null'], description: 'The decision in one sentence for "own", else null' },
  },
  required: ['kind', 'option', 'answer'],
};

export function replyPrompt(question: Question, reply: string): Prompt {
  const options = optionLines(question.options, question.recommended).join('\n');
  return {
    model: MODEL,
    max_completion_tokens: MAX_TOKENS,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Question: ${question.question}\n\nOptions:\n${options}\n\nReply by ${question.askedOf.displayName}:\n${reply}` },
    ],
    tools: [{ type: 'function', function: { name: TOOL, description: 'Report what the reply decided', parameters: PARAMETERS } }],
    tool_choice: { type: 'function', function: { name: TOOL } },
  };
}

export function parseReply(args: Record<string, unknown>, options: number): Answer | null {
  const kind = oneOf(args.kind, `${TOOL}.kind`, ['option', 'own', 'none'] as const);
  switch (kind) {
    case 'none':
      return null;
    case 'own':
      return { kind, text: nonEmpty(args.answer, `${TOOL}.answer`).replaceAll(/\s+/g, ' ').trim() };
    case 'option': {
      const number = natural(args.option, `${TOOL}.option`);
      if (number < 1 || number > options) throw new ReplyError(`the LLM picked option ${number}, not one of 1 to ${options}`);
      return { kind, number };
    }
  }
}

export function llmReplyReader(chat: Chat, log: (line: string) => void = console.log): ReplyReader {
  return {
    async read(question, reply) {
      const started = Date.now();
      const response = await chat(replyPrompt(question, reply));
      logUsage(log, 'llm reply reader', started, response);
      return parseReply(toolArguments(response, TOOL, (message) => new ReplyError(message)), question.options.length);
    },
  };
}
