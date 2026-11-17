import type { DecisionOption } from '@shipmill-atlassian/shared/decision';
import { projectOf, type JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { NEEDS_DECISION, type CommentId, type Person, type Release, type WorkItem } from '@shipmill-atlassian/shared/release';
import { AGENT, preparedFrame, questionComment, withdrawnComment, type QuestionFrame } from './comment';
import type { DecisionJira } from './decision-jira';
import type { Decision } from './finder';
import type { Preparer } from './prepare';
import { current, withAsked, withClosed, type Asker, type Care, type Question } from './question';

// Asking a question on a work item: post it as a comment, add the needs-decision label when
// the item has none, and record it. Two askers come through here: shipmill itself, for the
// release decisions it finds and prepares, and an agent with its own question. An item that
// already waits on an answer is not asked twice.

export type AskOutcome = { key: JiraKey; asked: true; questionId: CommentId } | { key: JiraKey; asked: false; reason: 'waiting' };

// shipmill's own questions: no person's agent asked them
export const SHIPMILL: Asker = { agent: AGENT, accountId: null };

type AskDeps = { jira: DecisionJira; now: () => Date };

async function post(
  key: JiraKey,
  earlier: readonly Question[],
  frame: QuestionFrame,
  record: { care: Care; askedBy: Asker },
  labelled: boolean,
  deps: AskDeps,
): Promise<CommentId> {
  const id = await deps.jira.postComment(key, questionComment(frame));
  if (!labelled) await deps.jira.label(key, true);
  await deps.jira.setQuestions(
    key,
    withAsked(earlier, {
      status: 'waiting',
      id,
      question: frame.question,
      options: frame.options,
      recommended: frame.recommended,
      care: record.care,
      askedBy: record.askedBy,
      askedOf: frame.askedOf,
      askedAt: deps.now().toISOString(),
      llm: frame.llm,
    }),
  );
  return id;
}

// askedBy: who had shipmill ask, SHIPMILL itself from the release panel
export async function askDecisions(
  release: Release,
  decisions: Decision[],
  deps: AskDeps & { preparer: Preparer; askedBy: Asker },
): Promise<AskOutcome[]> {
  let lead: Person | undefined;
  const outcomes: AskOutcome[] = [];
  for (const decision of decisions) {
    const item = release.items.find((candidate) => candidate.key === decision.key);
    if (item === undefined) throw new Error(`${decision.key} is not in ${release.project} ${release.version}`);
    const earlier = await deps.jira.questions(decision.key);
    if (current(earlier)?.status === 'waiting') {
      outcomes.push({ key: decision.key, asked: false, reason: 'waiting' });
      continue;
    }
    // Nobody on the item to ask: the project lead decides
    const decider = decision.askOf ?? (lead ??= await deps.jira.projectLead(release.project));
    const prepared = await deps.preparer.prepare(decision, item, release, decider);
    const frame = preparedFrame(prepared);
    // A decision that blocks a release is never answered in a batch
    const questionId = await post(decision.key, earlier, frame, { care: 'careful', askedBy: deps.askedBy }, item.labels.includes(NEEDS_DECISION), deps);
    outcomes.push({ key: decision.key, asked: true, questionId });
  }
  return outcomes;
}

// An agent's own question: its words, its options, what it recommends and why, and whether
// the answer is routine or careful
export type AgentQuestion = {
  question: string;
  options: DecisionOption[];
  recommended: number | null;
  care: Care;
  askedBy: Asker;
};

// The work item as far as asking needs it: the person on it is the one asked
export type AskedItem = Pick<WorkItem, 'key' | 'labels' | 'owner' | 'reporter'>;

export async function askAgentQuestion(item: AskedItem, asked: AgentQuestion, deps: AskDeps): Promise<AskOutcome> {
  const earlier = await deps.jira.questions(item.key);
  if (current(earlier)?.status === 'waiting') return { key: item.key, asked: false, reason: 'waiting' };
  // Nobody on the item to ask: the project lead decides
  const askedOf = item.owner ?? item.reporter ?? (await deps.jira.projectLead(projectOf(item.key)));
  const frame: QuestionFrame = {
    askedOf,
    question: asked.question,
    options: asked.options,
    recommended: asked.recommended,
    evidence: [],
    // The reply is read by code, as an option number: the agent's question costs no model call
    llm: false,
    agent: { name: asked.askedBy.agent, care: asked.care },
  };
  const questionId = await post(item.key, earlier, frame, { care: asked.care, askedBy: asked.askedBy }, item.labels.includes(NEEDS_DECISION), deps);
  return { key: item.key, asked: true, questionId };
}

// The asker takes its question back: the record closes as withdrawn, the work item says so,
// and the label goes, since nothing waits on a person. Only the side that asked may: the
// account the agent runs as, or shipmill for its own.
export type WithdrawOutcome =
  | { key: JiraKey; withdrawn: true; questionId: CommentId }
  | { key: JiraKey; withdrawn: false; reason: 'no-question' | 'not-waiting' | 'not-asker' };

export async function withdrawQuestion(key: JiraKey, by: Asker, deps: AskDeps): Promise<WithdrawOutcome> {
  const questions = await deps.jira.questions(key);
  const open = current(questions);
  if (open === undefined) return { key, withdrawn: false, reason: 'no-question' };
  if (open.status !== 'waiting') return { key, withdrawn: false, reason: 'not-waiting' };
  if (open.askedBy.accountId !== by.accountId) return { key, withdrawn: false, reason: 'not-asker' };
  await deps.jira.postComment(key, withdrawnComment(by.agent, open.askedOf));
  await deps.jira.label(key, false);
  await deps.jira.setQuestions(key, withClosed(questions, { ...open, status: 'withdrawn', withdrawnBy: by, withdrawnAt: deps.now().toISOString() }));
  return { key, withdrawn: true, questionId: open.id };
}
