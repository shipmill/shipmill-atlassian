import type { ChatResponse, Prompt } from '@forge/llm';
import { jiraKey } from '@shipmill-atlassian/shared/jira-key';
import { list, nonEmpty, object, string } from '@shipmill-atlassian/shared/parse';
import { pullRequestLabel } from '@shipmill-atlassian/shared/pull-requests';
import { logUsage, toolArguments } from './llm-tool';
import { NEEDS_DECISION, commentId, type Release } from '@shipmill-atlassian/shared/release';
import { ImplicitDecisionError, type ImplicitDecision, type ImplicitFinder } from './finder';

// The implicit half of the finder: Claude through Forge LLM reads the release and names the
// questions nobody answered. It only finds; the finder checks every answer against the
// release, and policy (what blocks, what may ship) stays in shipmill's code.

export type Chat = (prompt: Prompt) => Promise<ChatResponse>;

// Sonnet 4.6: lists blockers correctly at about 5 s and $0.02 a release (codegeist findings,
// item 2); Sonnet 5 needs a far larger token cap and costs about twice as much
export const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 2000;
const TOOL = 'report_decisions';

const SYSTEM = `You read a software release in Jira and find the decisions that block it and that nobody has made yet.

A decision is a question a person must answer before the release ships: a choice between options, asked in a comment or in the description, that no later comment answers. Report it once, on the work item where it was asked.

Not a decision:
- a question a later comment answers, even briefly ("yes", "go with option 2", "decided: ...")
- a status update, a plan already agreed, a question about facts that only needs looking up, a thank-you
- anything on an item labelled ${NEEDS_DECISION}: those are already known

Call ${TOOL} exactly once. Report an empty list when nothing is open. For each decision give the item key, the id of the comment that asks it (null when it is asked in the description), the question in one plain sentence ending with "?", and the account id of the person who should answer (null when no one on the item is clearly the one to decide).`;

const PARAMETERS = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The work item key, as in HRB-4' },
          comment_id: { type: ['string', 'null'], description: 'The id of the comment that asks it, or null for the description' },
          question: { type: 'string', description: 'The open question in one sentence' },
          ask_account_id: { type: ['string', 'null'], description: 'The account id of the person who should answer, or null' },
        },
        required: ['key', 'comment_id', 'question', 'ask_account_id'],
      },
    },
  },
  required: ['decisions'],
};

export function describeRelease(release: Release): string {
  const lines = [`Release: project ${release.project}, fix version ${release.version}, ${release.items.length} work items.`, ''];
  for (const item of release.items) {
    lines.push(`## ${item.key}: ${item.summary}`);
    lines.push(`Status: ${item.status} (${item.statusCategory}). Labels: ${item.labels.join(', ') || 'none'}.`);
    lines.push(`Owner: ${person(item.owner)}. Reporter: ${person(item.reporter)}.`);
    if (item.description !== '') lines.push(`Description: ${item.description}`);
    for (const link of item.links) lines.push(`Link: ${link.relation} ${link.key} "${link.summary}" (${link.statusCategory})`);
    for (const pr of item.pullRequests) lines.push(`Pull request: ${pullRequestLabel(pr)} "${pr.title}"`);
    for (const comment of item.comments) {
      lines.push(`Comment ${comment.id} by ${person(comment.author)} at ${comment.created}: ${comment.text}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function person(value: { accountId: string; displayName: string } | null): string {
  return value === null ? 'none' : `${value.displayName} [${value.accountId}]`;
}

export function prompt(release: Release): Prompt {
  return {
    model: MODEL,
    max_completion_tokens: MAX_TOKENS,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: describeRelease(release) },
    ],
    tools: [{ type: 'function', function: { name: TOOL, description: 'Report the open decisions of the release', parameters: PARAMETERS } }],
    tool_choice: { type: 'function', function: { name: TOOL } },
  };
}

export function parseResponse(response: ChatResponse): ImplicitDecision[] {
  const args = toolArguments(response, TOOL, (message) => new ImplicitDecisionError(message));
  return list(args.decisions, `${TOOL}.decisions`, (value, path) => {
    const fields = object(value, path);
    return {
      key: jiraKey(nonEmpty(fields.key, `${path}.key`)),
      commentId: fields.comment_id === null ? null : commentId(nonEmpty(fields.comment_id, `${path}.comment_id`)),
      question: string(fields.question, `${path}.question`),
      askAccountId: fields.ask_account_id === null ? null : nonEmpty(fields.ask_account_id, `${path}.ask_account_id`),
    };
  });
}

export function llmFinder(chat: Chat, log: (line: string) => void = console.log): ImplicitFinder {
  return {
    async find(release) {
      const started = Date.now();
      const response = await chat(prompt(release));
      logUsage(log, `llm finder ${release.project} ${release.version}`, started, response);
      return parseResponse(response);
    },
  };
}
