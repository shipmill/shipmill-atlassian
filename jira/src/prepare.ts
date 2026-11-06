import type { Prompt } from '@forge/llm';
import type { DecisionOption } from '@shipmill-atlassian/shared/decision';
import type { JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { list, nonEmpty, object } from '@shipmill-atlassian/shared/parse';
import type { Person, Release, WorkItem } from '@shipmill-atlassian/shared/release';
import type { Decision } from './finder';
import { describeRelease, MODEL, type Chat } from './llm-finder';
import { logUsage, toolArguments } from './llm-tool';

// The preparer: a found decision to the question shipmill asks, in the frame of shipmill's
// needs-decision protocol: the question in one sentence, numbered options with the
// recommended one first, each with why or what it costs, the evidence, and who decides.
// With the LLM on Claude writes the question, options and reasons; with it off they come
// from a template, which reads the alternatives out of an "A, or B?" question.

export type { DecisionOption };

export type Prepared = {
  key: JiraKey;
  question: string;
  // The recommended option first, as the protocol asks
  options: DecisionOption[];
  evidence: string;
  decider: Person;
  // Whether a free-text reply is read by Claude; with it off the reply is an option number
  llm: boolean;
};

export interface Preparer {
  prepare(decision: Decision, item: WorkItem, release: Release, decider: Person): Promise<Prepared>;
}

export class PrepareError extends Error {}

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

const QUOTE = 200;

export function evidence(decision: Decision, item: WorkItem): string {
  const found = decision.source === 'llm' ? ', found by Claude' : '';
  switch (decision.evidence.kind) {
    case 'description':
      return `asked in the description of ${item.key}${found}: "${quote(item.description)}"`;
    case 'comment': {
      const id = decision.evidence.id;
      const comment = item.comments.find((candidate) => candidate.id === id);
      if (comment === undefined) throw new PrepareError(`${item.key} has no comment ${id}`);
      return `asked by ${comment.author.displayName} in a comment on ${comment.created.slice(0, 10)}${found}: "${quote(comment.text)}"`;
    }
    case 'summary':
      return `${item.key} "${item.summary}" is labelled needs-decision with no question written down`;
  }
}

function quote(text: string): string {
  const line = text.replaceAll(/\s+/g, ' ').trim();
  return line.length <= QUOTE ? line : `${line.slice(0, QUOTE - 3).trimEnd()}...`;
}

// "retire v1 tokens in 2.4, or keep them for one more release?" names its own two options
const EITHER = /^(.+?),?\s+or\s+(.+?)\?$/;

export function templateOptions(decision: Decision, release: Release): DecisionOption[] {
  const out: DecisionOption = {
    text: `Move ${decision.key} out of ${release.version}`,
    reason: `${release.version} ships without waiting on this; the decision moves to the next version with the work item`,
  };
  const either = EITHER.exec(decision.question);
  if (either?.[1] !== undefined && either[2] !== undefined) {
    const decided = `decided now, and ${release.version} ships with ${decision.key} done this way`;
    return [out, { text: capital(either[1]), reason: decided }, { text: capital(either[2]), reason: decided }];
  }
  return [
    out,
    {
      text: `Keep ${decision.key} in ${release.version} as it stands`,
      reason: `${release.version} ships with the work item as written; any change waits for a follow-up`,
    },
  ];
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const templatePreparer: Preparer = {
  async prepare(decision, item, release, decider) {
    return {
      key: decision.key,
      question: decision.question,
      options: templateOptions(decision, release),
      evidence: evidence(decision, item),
      decider,
      llm: false,
    };
  },
};

// Claude through Forge LLM writes the question and the options; the evidence and who
// decides stay the finder's, so the comment cites what the reader saw

const TOOL = 'prepare_decision';
const MAX_TOKENS = 1500;

const SYSTEM = `You prepare one decision that blocks a software release, for the person who has to make it.

Write the question in one plain sentence ending with "?". Then give between ${MIN_OPTIONS} and ${MAX_OPTIONS} options in all: the one you recommend, with why, and the others, each with what it costs. Say in each what it means for the release and for the product's users, in words the team uses, in one sentence. Keep each option a short imperative phrase without a trailing period. Base everything on the work item and its comments; invent no facts.

Call ${TOOL} exactly once.`;

const PARAMETERS = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The decision in one sentence ending with "?"' },
    recommended: {
      type: 'object',
      properties: {
        option: { type: 'string', description: 'The option you recommend' },
        why: { type: 'string', description: 'Why, in one sentence' },
      },
      required: ['option', 'why'],
    },
    others: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          option: { type: 'string', description: 'Another option' },
          cost: { type: 'string', description: 'What it costs, in one sentence' },
        },
        required: ['option', 'cost'],
      },
    },
  },
  required: ['question', 'recommended', 'others'],
};

export function preparePrompt(decision: Decision, item: WorkItem, release: Release): Prompt {
  const context = describeRelease({ project: release.project, version: release.version, items: [item] });
  return {
    model: MODEL,
    max_completion_tokens: MAX_TOKENS,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `${context}\nThe open decision on ${item.key}: ${decision.question}\nWhere it was found: ${evidence(decision, item)}`,
      },
    ],
    tools: [{ type: 'function', function: { name: TOOL, description: 'Report the prepared decision', parameters: PARAMETERS } }],
    tool_choice: { type: 'function', function: { name: TOOL } },
  };
}

export function parsePrepared(args: Record<string, unknown>): { question: string; options: DecisionOption[] } {
  const question = oneLine(nonEmpty(args.question, `${TOOL}.question`));
  if (!question.endsWith('?')) throw new PrepareError(`the LLM's question does not end with "?": ${question}`);
  const recommended = object(args.recommended, `${TOOL}.recommended`);
  const others = list(args.others, `${TOOL}.others`, (value, path) => {
    const fields = object(value, path);
    return { text: option(fields.option, `${path}.option`), reason: oneLine(nonEmpty(fields.cost, `${path}.cost`)) };
  });
  const options = [
    { text: option(recommended.option, `${TOOL}.recommended.option`), reason: oneLine(nonEmpty(recommended.why, `${TOOL}.recommended.why`)) },
    ...others,
  ];
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    throw new PrepareError(`the LLM gave ${options.length} options, not ${MIN_OPTIONS} to ${MAX_OPTIONS}`);
  }
  return { question, options };
}

function option(value: unknown, path: string): string {
  return oneLine(nonEmpty(value, path)).replace(/\.$/, '');
}

function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

export function llmPreparer(chat: Chat, log: (line: string) => void = console.log): Preparer {
  return {
    async prepare(decision, item, release, decider) {
      const started = Date.now();
      const response = await chat(preparePrompt(decision, item, release));
      logUsage(log, `llm preparer ${decision.key}`, started, response);
      const { question, options } = parsePrepared(toolArguments(response, TOOL, (message) => new PrepareError(message)));
      return { key: decision.key, question, options, evidence: evidence(decision, item), decider, llm: true };
    },
  };
}
