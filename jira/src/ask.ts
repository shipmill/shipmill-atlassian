import type { JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { NEEDS_DECISION, type Person, type Release } from '@shipmill-atlassian/shared/release';
import { questionComment } from './comment';
import type { DecisionJira } from './decision-jira';
import type { Decision } from './finder';
import type { Preparer } from './prepare';

// Asks each found decision on its work item: prepares it, posts the question, adds the
// needs-decision label when the finder found it without one, and records what was asked.
// An item that already waits on an answer is not asked twice.

export type AskOutcome = { key: JiraKey; asked: true; questionId: string } | { key: JiraKey; asked: false; reason: 'waiting' };

export async function askDecisions(
  release: Release,
  decisions: Decision[],
  deps: { jira: DecisionJira; preparer: Preparer; now: () => Date },
): Promise<AskOutcome[]> {
  let lead: Person | undefined;
  const outcomes: AskOutcome[] = [];
  for (const decision of decisions) {
    const item = release.items.find((candidate) => candidate.key === decision.key);
    if (item === undefined) throw new Error(`${decision.key} is not in ${release.project} ${release.version}`);
    if ((await deps.jira.state(decision.key))?.status === 'waiting') {
      outcomes.push({ key: decision.key, asked: false, reason: 'waiting' });
      continue;
    }
    // Nobody on the item to ask: the project lead decides
    const decider = decision.askOf ?? (lead ??= await deps.jira.projectLead(release.project));
    const prepared = await deps.preparer.prepare(decision, item, release, decider);
    const questionId = await deps.jira.postComment(decision.key, questionComment(prepared));
    if (!item.labels.includes(NEEDS_DECISION)) await deps.jira.label(decision.key, true);
    await deps.jira.setState(decision.key, {
      status: 'waiting',
      questionId,
      question: prepared.question,
      options: prepared.options,
      decider,
      llm: prepared.llm,
      askedAt: deps.now().toISOString(),
    });
    outcomes.push({ key: decision.key, asked: true, questionId });
  }
  return outcomes;
}
