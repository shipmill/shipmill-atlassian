import type { JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { NEEDS_DECISION, type CommentId, type Person, type Release, type WorkItem } from '@shipmill-atlassian/shared/release';

// The decision finder. Explicit decisions are the work items labelled needs-decision, found
// by code every time. Implicit ones (a question asked in a comment that nobody answered)
// need a reader of prose, so they come from the LLM, and only while the switch is on.

export type DecisionSource = 'label' | 'llm';

// Where the question was read: the item's description, one of its comments, or nowhere
// (a label with no question written down, so the finder words it from the summary)
export type Evidence = { kind: 'description' } | { kind: 'comment'; id: CommentId } | { kind: 'summary' };

export type Decision = {
  key: JiraKey;
  source: DecisionSource;
  question: string;
  evidence: Evidence;
  askOf: Person | null;
};

// What the LLM reports for one implicit decision, before the finder checks it against the release
export type ImplicitDecision = {
  key: JiraKey;
  commentId: CommentId | null;
  question: string;
  askAccountId: string | null;
};

export interface ImplicitFinder {
  find(release: Release): Promise<ImplicitDecision[]>;
}

export class ImplicitDecisionError extends Error {}

export async function findDecisions(
  release: Release,
  options: { llm: boolean; implicit: ImplicitFinder },
): Promise<Decision[]> {
  const explicit = release.items.filter(isLabelled).map(explicitDecision);
  if (!options.llm) return explicit;
  const implicit = (await options.implicit.find(release)).flatMap((found) => checked(release, found));
  return [...explicit, ...implicit];
}

function isLabelled(item: WorkItem): boolean {
  return item.labels.includes(NEEDS_DECISION);
}

// "Decision needed: <question>" is how shipmill writes a question; the newest one wins
const ASKED = /Decision needed:\s*(.+?\?)/s;

function explicitDecision(item: WorkItem): Decision {
  const askOf = item.owner ?? item.reporter;
  for (const comment of [...item.comments].reverse()) {
    const asked = ASKED.exec(comment.text);
    if (asked?.[1] !== undefined) {
      return { key: item.key, source: 'label', question: oneLine(asked[1]), evidence: { kind: 'comment', id: comment.id }, askOf };
    }
  }
  const asked = ASKED.exec(item.description);
  if (asked?.[1] !== undefined) {
    return { key: item.key, source: 'label', question: oneLine(asked[1]), evidence: { kind: 'description' }, askOf };
  }
  return { key: item.key, source: 'label', question: `What should ${item.key} "${item.summary}" ship as in this release?`, evidence: { kind: 'summary' }, askOf };
}

function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

// The LLM's answer is checked against what the reader saw: a key outside the release, a
// comment the item doesn't have, or a person who never touched the item is an error, not
// something to drop quietly. A labelled item is already found, so the LLM's copy is dropped.
function checked(release: Release, found: ImplicitDecision): Decision[] {
  const item = release.items.find((candidate) => candidate.key === found.key);
  if (item === undefined) throw new ImplicitDecisionError(`the LLM named ${found.key}, which is not in ${release.project} ${release.version}`);
  if (isLabelled(item)) return [];
  if (found.question.trim() === '') throw new ImplicitDecisionError(`the LLM gave ${found.key} an empty question`);
  let evidence: Evidence = { kind: 'description' };
  if (found.commentId !== null) {
    if (!item.comments.some((comment) => comment.id === found.commentId)) {
      throw new ImplicitDecisionError(`the LLM cited comment ${found.commentId}, which ${found.key} does not have`);
    }
    evidence = { kind: 'comment', id: found.commentId };
  }
  return [{ key: item.key, source: 'llm', question: oneLine(found.question), evidence, askOf: askOf(item, found) }];
}

function askOf(item: WorkItem, found: ImplicitDecision): Person | null {
  if (found.askAccountId === null) return item.owner ?? item.reporter;
  const people = [item.owner, item.reporter, ...item.comments.map((comment) => comment.author)];
  const person = people.find((candidate) => candidate?.accountId === found.askAccountId);
  if (person === undefined || person === null) {
    throw new ImplicitDecisionError(`the LLM asks ${found.askAccountId}, who is not on ${found.key}`);
  }
  return person;
}
