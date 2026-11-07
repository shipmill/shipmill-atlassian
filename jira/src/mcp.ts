import { jiraKey, projectKey, projectOf, type JiraKey, type ProjectKey } from '@shipmill-atlassian/shared/jira-key';
import { nonEmpty, object } from '@shipmill-atlassian/shared/parse';
import type { Person, Release } from '@shipmill-atlassian/shared/release';
import { askDecisions } from './ask';
import { optionLine } from './comment';
import type { DecisionJira } from './decision-jira';
import type { DecisionState } from './decision-state';
import { labelledDecisions } from './finder';
import type { PanelView } from './panel-resolver';
import { requirePermissions, type CallerPermissions } from './permissions';
import type { Preparer } from './prepare';
import { answerText } from './relay';
import { checkOpen } from './release-panel';

// The tools a coding agent calls through MCP (the rovo:mcp module over three Rovo actions):
// list a release's blocking decisions, ask one, and read its answer. Each is the release
// panel's or the preparer's own path, behind the caller's Jira permissions: the work items
// are read as the caller, and Jira is asked what the caller may do before shipmill reads its
// state or comments as the app. See permissions.ts for why the caller must allow access once.

export class McpInputError extends Error {}

// The caller the action runs for: Forge passes it in the function context as principal
export function callerAccountId(context: unknown): string {
  const principal = object(object(context, 'context').principal, 'context.principal');
  return nonEmpty(principal.accountId, 'context.principal.accountId');
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : nonEmpty(value, path);
}

// list-release-decisions

export type ListInput = { project: ProjectKey; version: string | undefined };

export function parseListInput(payload: unknown): ListInput {
  const fields = object(payload, 'payload');
  return { project: projectKey(nonEmpty(fields.project, 'project')), version: optionalText(fields.version, 'version') };
}

export async function listDecisions(
  input: ListInput,
  deps: { permissions: CallerPermissions; view: (project: ProjectKey, version: string | undefined) => Promise<PanelView> },
): Promise<PanelView> {
  await requirePermissions(deps.permissions, { project: input.project }, ['BROWSE_PROJECTS']);
  return deps.view(input.project, input.version);
}

// read-decision-answer

export type DecisionView =
  | { key: JiraKey; status: 'not-asked' }
  | {
      key: JiraKey;
      status: 'waiting' | 'decided';
      question: string;
      // Numbered as the question comment numbers them, the recommended one first
      options: string[];
      waitsOn: Person;
      askedAt: string;
      // The Jira comment that holds the question
      questionId: string;
      howToAnswer: string;
      // Once decided: the answer as the relay recorded it, and when
      answer: string | null;
      decidedAt: string | null;
    };

export function decisionView(key: JiraKey, state: DecisionState | undefined): DecisionView {
  if (state === undefined) return { key, status: 'not-asked' };
  const reply = state.llm ? 'a reply in their own words' : 'a reply that starts with the option number';
  return {
    key,
    status: state.status,
    question: state.question,
    options: state.options.map((option, index) => `${index + 1}. ${optionLine(option, index)}`),
    waitsOn: state.decider,
    askedAt: state.askedAt,
    questionId: state.questionId,
    howToAnswer: `${state.decider.displayName} answers on ${key} in Jira (${reply}), or on a linked pull request in Bitbucket`,
    answer: state.status === 'decided' ? answerText(state, state.answer) : null,
    decidedAt: state.status === 'decided' ? state.decidedAt : null,
  };
}

export type ItemInput = { item: JiraKey };

export function parseItemInput(payload: unknown): ItemInput {
  return { item: jiraKey(nonEmpty(object(payload, 'payload').issueKey, 'issueKey')) };
}

export async function readAnswer(input: ItemInput, deps: { permissions: CallerPermissions; jira: Pick<DecisionJira, 'state'> }): Promise<DecisionView> {
  await requirePermissions(deps.permissions, { item: input.item }, ['BROWSE_PROJECTS']);
  return decisionView(input.item, await deps.jira.state(input.item));
}

// ask-decision: one blocking decision of a fix version, asked the way the release panel asks
// it (the preparer posts the question as shipmill and records it), with the template's text,
// so no LLM is called. A decision already waiting is not asked twice.

export type AskInput = { item: JiraKey; version: string };

export function parseAskInput(payload: unknown): AskInput {
  const fields = object(payload, 'payload');
  return { item: jiraKey(nonEmpty(fields.issueKey, 'issueKey')), version: nonEmpty(fields.version, 'version') };
}

export type AskResult = { asked: boolean; decision: DecisionView };

export async function askDecision(
  input: AskInput,
  deps: {
    permissions: CallerPermissions;
    versions: (project: ProjectKey) => Promise<string[]>;
    // The release as the caller sees it
    release: (project: ProjectKey, version: string) => Promise<Release>;
    jira: DecisionJira;
    preparer: Preparer;
    now: () => Date;
  },
): Promise<AskResult> {
  await requirePermissions(deps.permissions, { item: input.item }, ['BROWSE_PROJECTS', 'ADD_COMMENTS']);
  const project = projectOf(input.item);
  checkOpen(project, await deps.versions(project), input.version);
  const release = await deps.release(project, input.version);
  const decision = labelledDecisions(release.items).find((candidate) => candidate.key === input.item);
  if (decision === undefined) {
    throw new McpInputError(`${input.item} is not a blocking decision of ${project} ${input.version}: it is not in that fix version, or not labelled needs-decision`);
  }
  const [outcome] = await askDecisions(release, [decision], { jira: deps.jira, preparer: deps.preparer, now: deps.now });
  if (outcome === undefined) throw new Error(`asking ${input.item} gave no outcome`);
  return { asked: outcome.asked, decision: decisionView(input.item, await deps.jira.state(input.item)) };
}
