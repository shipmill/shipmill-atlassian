import type { DecisionOption } from '@shipmill-atlassian/shared/decision';
import { jiraKey, projectKey, projectOf, type JiraKey, type ProjectKey } from '@shipmill-atlassian/shared/jira-key';
import { natural, nonEmpty, object, oneOf, type Fields } from '@shipmill-atlassian/shared/parse';
import type { Person, Release } from '@shipmill-atlassian/shared/release';
import { askAgentQuestion, askDecisions, type AskOutcome, type AskedItem } from './ask';
import { AGENT, optionLines } from './comment';
import type { DecisionJira } from './decision-jira';
import { labelledDecisions } from './finder';
import type { PanelView } from './panel-resolver';
import { requirePermissions, type CallerPermissions } from './permissions';
import { MAX_OPTIONS, MIN_OPTIONS, type Preparer } from './prepare';
import { CARES, isAnswered, type Asker, type Care, type Question, type QuestionRef, type Status } from './question';
import { questionOn } from './question-reads';
import { answerText } from './relay';
import { checkOpen, type ReleasePanel } from './release-panel';

// The tools a coding agent calls through MCP (the rovo:mcp module over three Rovo actions):
// list a release's blocking decisions, ask a question (its own, or a release decision
// shipmill prepares), and read its answer from the question's record. Each runs behind the
// caller's Jira permissions: the work items
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

// Linked pull requests and the decisions opened on them live in the Jira install's Forge
// storage, and storage is per install. Where the app is also installed in Confluence (for the
// decision log), Atlassian serves MCP calls from that install, which reads none of it.
export function seesPullRequestData(installContext: string): boolean {
  return installContext.startsWith('ari:cloud:jira::site/');
}

// `ready` is 'unknown' when no work item blocks but the pull requests could not be read: a
// decision opened on a pull request may still hold the release, so true would be a false claim
export type ListedPanel = Omit<ReleasePanel, 'ready'> & { ready: boolean | 'unknown'; pullRequestData: 'read' | 'unavailable' };
export type ListView = { versions: string[]; panel: ListedPanel | null };

export function listedView(view: PanelView, seesPullRequests: boolean): ListView {
  if (view.panel === null) return { versions: view.versions, panel: null };
  if (seesPullRequests) return { versions: view.versions, panel: { ...view.panel, pullRequestData: 'read' } };
  return {
    versions: view.versions,
    panel: { ...view.panel, ready: view.panel.decisions.length > 0 ? false : 'unknown', pullRequestData: 'unavailable' },
  };
}

export async function listDecisions(
  input: ListInput,
  deps: {
    permissions: CallerPermissions;
    view: (project: ProjectKey, version: string | undefined) => Promise<PanelView>;
    seesPullRequests: boolean;
  },
): Promise<ListView> {
  await requirePermissions(deps.permissions, { project: input.project }, ['BROWSE_PROJECTS']);
  return listedView(await deps.view(input.project, input.version), deps.seesPullRequests);
}

// read-decision-answer: where the question on a work item stands, from its record

export type DecisionView =
  | { key: JiraKey; status: 'not-asked' }
  | {
      key: JiraKey;
      status: Status;
      question: string;
      // Numbered as the question comment numbers them, the recommended one marked
      options: string[];
      // The number of the recommended option, or null when the agent recommended none
      recommended: number | null;
      // careful: irreversible, breaking, or outside the agent's mandate; never answered in a batch
      care: Care;
      // The agent that asked and the account it runs as
      askedBy: Asker;
      waitsOn: Person;
      askedAt: string;
      // The Jira comment that holds the question
      questionId: string;
      // While it waits: how the person asked answers it
      howToAnswer: string | null;
      // Once answered: the answer, who gave it and when
      answer: string | null;
      answeredBy: Person | null;
      answeredAt: string | null;
      // For answered-from-record: the earlier question whose answer the agent went on by
      answeredFrom: QuestionRef | null;
      withdrawnAt: string | null;
    };

export function decisionView(key: JiraKey, question: Question | undefined): DecisionView {
  if (question === undefined) return { key, status: 'not-asked' };
  const reply = question.llm ? 'a reply in their own words' : 'a reply that starts with the option number';
  const answered = isAnswered(question) ? question : null;
  return {
    key,
    status: question.status,
    question: question.question,
    options: optionLines(question.options, question.recommended),
    recommended: question.recommended,
    care: question.care,
    askedBy: question.askedBy,
    waitsOn: question.askedOf,
    askedAt: question.askedAt,
    questionId: question.id,
    howToAnswer:
      question.status === 'waiting'
        ? `${question.askedOf.displayName} answers on ${key} in Jira (${reply}), or on a linked pull request in Bitbucket`
        : null,
    answer: answered === null ? null : answerText(answered, answered.answer),
    answeredBy: answered?.answeredBy ?? null,
    answeredAt: answered?.answeredAt ?? null,
    answeredFrom: question.status === 'answered-from-record' ? question.from : null,
    withdrawnAt: question.status === 'withdrawn' ? question.withdrawnAt : null,
  };
}

export type ItemInput = { item: JiraKey };

export function parseItemInput(payload: unknown): ItemInput {
  return { item: jiraKey(nonEmpty(object(payload, 'payload').issueKey, 'issueKey')) };
}

export async function readAnswer(input: ItemInput, deps: { permissions: CallerPermissions; jira: Pick<DecisionJira, 'questions'> }): Promise<DecisionView> {
  await requirePermissions(deps.permissions, { item: input.item }, ['BROWSE_PROJECTS']);
  return decisionView(input.item, await questionOn(deps.jira, input.item));
}

// ask-decision: a question on a work item, posted as shipmill's comment and kept as a record.
// Two kinds. The agent's own question: its words, two to four options, the one it recommends
// with why, and whether the answer is routine or careful (careful unless it says routine).
// Or, with no question given, one blocking decision of a fix version, asked the way the
// release panel asks it, with the template's text. Neither calls an LLM, and a work item
// that already waits on an answer is not asked twice.

export const MAX_QUESTION = 1000;
export const MAX_OPTION = 300;
export const MAX_REASON = 500;
export const MAX_AGENT = 80;

export type AskInput = { item: JiraKey; agent: string } & (
  | { kind: 'release'; version: string }
  | { kind: 'own'; question: string; options: DecisionOption[]; recommended: number | null; care: Care }
);

function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function limited(text: string, path: string, limit: number): string {
  if (text.length > limit) throw new McpInputError(`${path}: ${text.length} characters, more than the ${limit} allowed`);
  return text;
}

// A list marker an agent may write before an option: "1.", "2)", "-", "*"
const MARKER = /^(?:\d+[.)]|[-*])\s+/;

// One option per line, in the order the question numbers them
export function parseOptions(value: unknown): string[] {
  const options = nonEmpty(value, 'options')
    .split('\n')
    .map((line) => oneLine(line).replace(MARKER, ''))
    .filter((line) => line !== '');
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    throw new McpInputError(`options: ${options.length} given, a question takes ${MIN_OPTIONS} to ${MAX_OPTIONS}, one per line`);
  }
  for (const [index, option] of options.entries()) {
    limited(option, `options[${index + 1}]`, MAX_OPTION);
    if (options.indexOf(option) !== index) throw new McpInputError(`options: ${JSON.stringify(option)} is given twice`);
  }
  return options;
}

function absent(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function ownQuestion(fields: Fields): { question: string; options: DecisionOption[]; recommended: number | null; care: Care } {
  const question = limited(oneLine(nonEmpty(fields.question, 'question')), 'question', MAX_QUESTION);
  if (absent(fields.options)) throw new McpInputError('options: your own question needs its options, one per line');
  const texts = parseOptions(fields.options);
  const care = absent(fields.care) ? 'careful' : oneOf(fields.care, 'care', CARES);
  if (absent(fields.recommended)) {
    if (!absent(fields.reason)) throw new McpInputError('reason: it says why you recommend an option, so it needs recommended');
    return { question, options: texts.map((text) => ({ text, reason: null })), recommended: null, care };
  }
  const recommended = natural(fields.recommended, 'recommended');
  if (recommended < 1 || recommended > texts.length) throw new McpInputError(`recommended: ${recommended} is not an option from 1 to ${texts.length}`);
  if (absent(fields.reason)) throw new McpInputError('reason: say why you recommend that option');
  const reason = limited(oneLine(nonEmpty(fields.reason, 'reason')), 'reason', MAX_REASON);
  return { question, options: texts.map((text, index) => ({ text, reason: index + 1 === recommended ? reason : null })), recommended, care };
}

export function parseAskInput(payload: unknown): AskInput {
  const fields = object(payload, 'payload');
  const item = jiraKey(nonEmpty(fields.issueKey, 'issueKey'));
  const agent = absent(fields.agent) ? undefined : limited(oneLine(nonEmpty(fields.agent, 'agent')), 'agent', MAX_AGENT);
  if (absent(fields.question)) {
    for (const name of ['options', 'recommended', 'reason', 'care']) {
      if (!absent(fields[name])) throw new McpInputError(`${name}: it describes your own question, so it needs question`);
    }
    if (absent(fields.version)) throw new McpInputError('give your question, or the open fix version whose blocking decision shipmill should ask');
    return { kind: 'release', item, agent: agent ?? AGENT, version: nonEmpty(fields.version, 'version') };
  }
  if (!absent(fields.version)) throw new McpInputError('version: it picks a release decision shipmill prepares; leave it out with your own question');
  if (agent === undefined) throw new McpInputError('agent: say which agent asks, for example Claude Code');
  return { kind: 'own', item, agent, ...ownQuestion(fields) };
}

export type AskResult = { asked: boolean; decision: DecisionView };

export async function askDecision(
  input: AskInput,
  deps: {
    permissions: CallerPermissions;
    // The account the MCP client signed in as: the person the asking agent runs as
    caller: string;
    versions: (project: ProjectKey) => Promise<string[]>;
    // The release as the caller sees it
    release: (project: ProjectKey, version: string) => Promise<Release>;
    // The work item's labels and people; undefined when the site has none by that key
    item: (key: JiraKey) => Promise<AskedItem | undefined>;
    jira: DecisionJira;
    preparer: Preparer;
    now: () => Date;
  },
): Promise<AskResult> {
  await requirePermissions(deps.permissions, { item: input.item }, ['BROWSE_PROJECTS', 'ADD_COMMENTS']);
  const askedBy: Asker = { agent: input.agent, accountId: deps.caller };
  const outcome = input.kind === 'own' ? await askOwn(input, askedBy, deps) : await askPrepared(input.item, input.version, askedBy, deps);
  return { asked: outcome.asked, decision: decisionView(input.item, await questionOn(deps.jira, input.item)) };
}

async function askOwn(
  input: AskInput & { kind: 'own' },
  askedBy: Asker,
  deps: { item: (key: JiraKey) => Promise<AskedItem | undefined>; jira: DecisionJira; now: () => Date },
): Promise<AskOutcome> {
  const item = await deps.item(input.item);
  if (item === undefined) throw new McpInputError(`${input.item} is not a work item on this site`);
  const { question, options, recommended, care } = input;
  return askAgentQuestion(item, { question, options, recommended, care, askedBy }, deps);
}

async function askPrepared(
  key: JiraKey,
  version: string,
  askedBy: Asker,
  deps: {
    versions: (project: ProjectKey) => Promise<string[]>;
    release: (project: ProjectKey, version: string) => Promise<Release>;
    jira: DecisionJira;
    preparer: Preparer;
    now: () => Date;
  },
): Promise<AskOutcome> {
  const project = projectOf(key);
  checkOpen(project, await deps.versions(project), version);
  const release = await deps.release(project, version);
  const decision = labelledDecisions(release.items).find((candidate) => candidate.key === key);
  if (decision === undefined) {
    throw new McpInputError(`${key} is not a blocking decision of ${project} ${version}: it is not in that fix version, or not labelled needs-decision`);
  }
  const [outcome] = await askDecisions(release, [decision], { jira: deps.jira, preparer: deps.preparer, now: deps.now, askedBy });
  if (outcome === undefined) throw new Error(`asking ${key} gave no outcome`);
  return outcome;
}
