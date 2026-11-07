import type { Prompt } from '@forge/llm';
import type { DecisionOption } from '@shipmill-atlassian/shared/decision';
import type { JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { list, nonEmpty, object } from '@shipmill-atlassian/shared/parse';
import { linkedByUrl, pullRequestLabel, type LinkedPullRequest } from '@shipmill-atlassian/shared/pull-requests';
import type { Person, Release, WorkItem } from '@shipmill-atlassian/shared/release';
import type { Decision } from './finder';
import { QUERY_SCOPES, UNREAD_LISTS, type GraphEvidence, type GraphLookup, type GraphPullRequest, type WorkItemGraph } from './graph';
import { describeRelease, MODEL, type Chat } from './llm-finder';
import { logUsage, toolArguments } from './llm-tool';

// The preparer: a found decision to the question shipmill asks, in the frame of shipmill's
// needs-decision protocol: the question in one sentence, numbered options with the
// recommended one first, each with why or what it costs, the evidence, and who decides.
// With the LLM on Claude writes the question, options and reasons; with it off they come
// from a template, which reads the alternatives out of an "A, or B?" question.

export type { DecisionOption };

// The evidence as text with links in it: the comment links a pull request by its label
export type EvidenceLink = { text: string; url: string };
export type EvidencePart = string | EvidenceLink;

// As Markdown, the way shipmill writes it on GitHub
export function evidenceText(parts: readonly EvidencePart[]): string {
  return parts.map((part) => (typeof part === 'string' ? part : part.text === part.url ? part.url : `[${part.text}](${part.url})`)).join('');
}

export type Prepared = {
  key: JiraKey;
  question: string;
  // The recommended option first, as the protocol asks
  options: DecisionOption[];
  evidence: EvidencePart[];
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
      evidence: [evidence(decision, item)],
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
      return { key: decision.key, question, options, evidence: [evidence(decision, item)], decider, llm: true };
    },
  };
}

// The Teamwork Graph's evidence, appended to what the reader found: linked pull requests and
// deployments, and the teams the item is assigned to as who may decide besides the person
// asked. Without the graph, or with nothing in it, the evidence is exactly the reader's.

const STATE: Record<string, string> = { IN_PROGRESS: 'in progress', ROLLED_BACK: 'rolled back' };

function state(value: string): string {
  return STATE[value] ?? value.toLowerCase();
}

export function hasGraphEvidence(graph: GraphEvidence): boolean {
  return graph.pullRequests.length + graph.deployments.length + graph.teams.length > 0;
}

// A pull request is named the way the release panel names it, "harbor #5", linked to the
// graph's URL. The graph's ExternalPullRequest has no repository name, only ids, and for
// Bitbucket Cloud its URL names the workspace and repository by uuid; the label comes from
// the pull request the bridge reported for the item. One the bridge never reported (another
// provider, or reported before the bridge was installed) is linked by its URL as it is.
function graphPullRequest(pr: GraphPullRequest, linked: readonly LinkedPullRequest[]): EvidencePart[] {
  const known = linkedByUrl(linked, pr.url);
  if (known === undefined) return [`pull request "${quote(pr.title)}" (${state(pr.status)}, `, { text: pr.url, url: pr.url }, ')'];
  return ['pull request ', { text: pullRequestLabel(known), url: pr.url }, ` "${quote(pr.title)}" (${state(pr.status)})`];
}

export function graphEvidence(graph: GraphEvidence, linked: readonly LinkedPullRequest[]): EvidencePart[] | undefined {
  const parts: EvidencePart[][] = [
    ...graph.pullRequests.map((pr) => graphPullRequest(pr, linked)),
    ...graph.deployments.map((deploy) => [`deployment ${deploy.name} to ${deploy.environment} (${state(deploy.state)}, `, { text: deploy.url, url: deploy.url }, ')']),
  ];
  const teams = graph.teams.map((team) => team.name);
  if (teams.length > 0) parts.push([`assigned to ${teams.length === 1 ? 'team' : 'teams'} ${teams.join(', ')}, who may decide too`]);
  if (parts.length === 0) return undefined;
  return ['in the Teamwork Graph, ', ...parts.flatMap((part, index) => (index === 0 ? part : ['; ', ...part]))];
}

// What the graph read for one item, for the log: every empty list names the scopes it
// needed, since an ungranted scope empties a query instead of failing it, and every list
// not read says why
export function graphNotes(key: JiraKey, item: WorkItem, lookup: GraphLookup): string[] {
  if (lookup.status === 'unavailable') return [`graph ${key}: not read, ${lookup.reason}`];
  const unread = Object.entries(UNREAD_LISTS).map(([list, reason]) => `graph ${key}: ${list} not read, ${reason}`);
  return [...lookup.empty.map((list) => {
    const scopes = QUERY_SCOPES[list].join(', ');
    if (list === 'pullRequests' && item.pullRequests.length > 0) {
      return `graph ${key}: no pull requests, yet Bitbucket links ${item.pullRequests.length}; check that an admin granted ${scopes}`;
    }
    return `graph ${key}: no ${list}; either none is linked or ${scopes} is not granted`;
  }), ...unread];
}

export function withGraph(preparer: Preparer, graph: WorkItemGraph, log: (line: string) => void = console.log): Preparer {
  return {
    async prepare(decision, item, release, decider) {
      const [prepared, lookup] = await Promise.all([preparer.prepare(decision, item, release, decider), graph.lookup(decision.key)]);
      for (const note of graphNotes(decision.key, item, lookup)) log(note);
      const found = lookup.status === 'read' ? graphEvidence(lookup.evidence, item.pullRequests) : undefined;
      return found === undefined ? prepared : { ...prepared, evidence: [...prepared.evidence, '; ', ...found] };
    },
  };
}
