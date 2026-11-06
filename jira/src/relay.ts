import type { Prompt } from '@forge/llm';
import type { JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { natural, nonEmpty, oneOf } from '@shipmill-atlassian/shared/parse';
import type { CommentId } from '@shipmill-atlassian/shared/release';
import { optionLine, relayComment, unreadComment } from './comment';
import type { DecisionJira } from './decision-jira';
import { newer, type Answer, type DecisionState } from './decision-state';
import { MODEL, type Chat } from './llm-finder';
import { logUsage, toolArguments } from './llm-tool';

// The relay: a reply by the person asked ends the wait. shipmill posts "Decision by `@x`,
// relayed by shipmill" with the answer, removes the needs-decision label, and records the
// answer. A reply that starts with an option number is read by code; with the LLM on,
// Claude reads any other reply, and with it off such a reply gets a note and the question
// stays open. Anyone else's comment, or one older than the question, never counts.

export interface ReplyReader {
  read(state: DecisionState, reply: string): Promise<Answer | null>;
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

export function answerText(state: DecisionState, answer: Answer): string {
  if (answer.kind === 'own') return answer.text;
  const option = state.options[answer.number - 1];
  if (option === undefined) throw new ReplyError(`option ${answer.number} is not one of ${state.options.length}`);
  return `option ${answer.number}, ${optionLine(option, answer.number - 1)}`;
}

export type RelayOutcome =
  | { key: JiraKey; relayed: true; answer: Answer }
  | { key: JiraKey; relayed: false; reason: 'no-question' | 'decided' | 'not-newer' | 'not-decider' | 'unread' | 'no-answer' };

export async function relayReply(
  key: JiraKey,
  replyId: CommentId,
  deps: { jira: DecisionJira; reader: ReplyReader | null; now: () => Date },
): Promise<RelayOutcome> {
  const state = await deps.jira.state(key);
  if (state === undefined) return { key, relayed: false, reason: 'no-question' };
  if (state.status === 'decided') return { key, relayed: false, reason: 'decided' };
  if (!newer(replyId, state.questionId)) return { key, relayed: false, reason: 'not-newer' };
  const reply = await deps.jira.comment(key, replyId);
  if (reply.author.accountId !== state.decider.accountId) return { key, relayed: false, reason: 'not-decider' };
  const number = optionNumber(reply.text, state.options.length);
  let answer: Answer | null = number === null ? null : { kind: 'option', number };
  // The question said how to reply: a number while the LLM was off when it was asked
  if (answer === null && state.llm && deps.reader !== null) answer = await deps.reader.read(state, reply.text);
  if (answer === null) {
    if (state.llm && deps.reader !== null) return { key, relayed: false, reason: 'no-answer' };
    await deps.jira.postComment(key, unreadComment(state.decider, state.options.length));
    return { key, relayed: false, reason: 'unread' };
  }
  await deps.jira.postComment(key, relayComment(reply.author, answerText(state, answer)));
  await deps.jira.label(key, false);
  await deps.jira.setState(key, { ...state, status: 'decided', replyId, answer, decidedAt: deps.now().toISOString() });
  return { key, relayed: true, answer };
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

export function replyPrompt(state: DecisionState, reply: string): Prompt {
  const options = state.options.map((option, index) => `${index + 1}. ${optionLine(option, index)}`).join('\n');
  return {
    model: MODEL,
    max_completion_tokens: MAX_TOKENS,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Question: ${state.question}\n\nOptions:\n${options}\n\nReply by ${state.decider.displayName}:\n${reply}` },
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
    async read(state, reply) {
      const started = Date.now();
      const response = await chat(replyPrompt(state, reply));
      logUsage(log, 'llm reply reader', started, response);
      return parseReply(toolArguments(response, TOOL, (message) => new ReplyError(message)), state.options.length);
    },
  };
}
