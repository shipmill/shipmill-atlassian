import type { DecisionReply } from '@shipmill-atlassian/shared/bridge';
import type { DecisionView, ReplyOutcome, ReplyReason } from '@shipmill-atlassian/shared/decision';
import { findJiraKey, type JiraKey } from '@shipmill-atlassian/shared/jira-key';
import type { Person } from '@shipmill-atlassian/shared/release';
import type { BitbucketRest, BitbucketWrites, PullRequest } from './bitbucket-rest';
import { questionBody, relayBody, taskText, unreadBody } from './pr-comment';
import type { PullRequestQuestion, PullRequestRef, QuestionStore } from './question-store';

// Decisions on pull requests. When the work item a pull request names waits on a question
// shipmill asked in Jira, the pull request gets the same question as a comment, and a task
// "Decision needed: ..." on it that holds the merge. A newer comment on the pull request by
// the person asked goes to the Jira app, which relays it as it would a comment on the work
// item; once Jira records the answer, the pull request gets the relay and the task resolves.
// An answer given in Jira resolves the task the next time the pull request is looked at.

export type ReplyToJira = Omit<DecisionReply, 'kind' | 'sentAt'>;

// The paired Jira app, over the bridge
export interface Decisions {
  view(key: JiraKey): Promise<DecisionView>;
  reply(reply: ReplyToJira): Promise<ReplyOutcome>;
}

export type QuestionDeps = {
  rest: BitbucketRest & BitbucketWrites;
  store: QuestionStore;
  decisions: Decisions;
  repository: string;
  now: () => Date;
};

// A claim older than this belongs to an invocation that failed between claiming and posting
export const STALE_CLAIM_MS = 2 * 60 * 1000;

export type SyncOutcome = 'no-key' | 'nothing-asked' | 'asked' | 'already-asked' | 'resolved' | 'up-to-date';

function same(record: PullRequestQuestion | undefined, key: JiraKey, view: { questionId: string }): record is PullRequestQuestion {
  return record !== undefined && record.key === key && record.questionId === view.questionId;
}

function live(record: PullRequestQuestion, now: Date): boolean {
  return record.status !== 'asking' || now.getTime() - Date.parse(record.at) < STALE_CLAIM_MS;
}

// Brings the pull request's question in line with Jira's
export async function syncQuestion(deps: QuestionDeps, pullRequest: PullRequest): Promise<SyncOutcome> {
  const key = findJiraKey(pullRequest.title);
  if (key === undefined) return 'no-key';
  const ref = { repository: deps.repository, id: pullRequest.id };
  const [view, record] = await Promise.all([deps.decisions.view(key), deps.store.get(ref)]);
  switch (view.status) {
    case 'none':
      return 'nothing-asked';
    case 'waiting':
      if (same(record, key, view) && live(record, deps.now())) return 'already-asked';
      return ask(deps, ref, key, view);
    case 'decided':
      if (!same(record, key, view) || record.status !== 'waiting') return 'up-to-date';
      await recordAnswer(deps, ref, record, view.decider, view.answer, 'in Jira');
      return 'resolved';
  }
}

async function ask(deps: QuestionDeps, ref: PullRequestRef, key: JiraKey, view: DecisionView & { status: 'waiting' }): Promise<SyncOutcome> {
  const claim: PullRequestQuestion = {
    status: 'asking',
    key,
    questionId: view.questionId,
    decider: view.decider,
    options: view.options.length,
    commentId: 0,
    taskId: 0,
    at: deps.now().toISOString(),
  };
  const replaced = await deps.store.swap(ref, claim);
  if (same(replaced, key, view) && live(replaced, deps.now())) {
    // Another invocation asked, or is asking, this question: leave its record as it was
    await deps.store.set(ref, replaced);
    return 'already-asked';
  }
  // A task for another work item or an older question no longer holds the pull request
  if (replaced?.status === 'waiting') await deps.rest.resolveTask(ref.id, replaced.taskId);
  const commentId = await deps.rest.postComment(ref.id, questionBody(key, view));
  const taskId = await deps.rest.createTask(ref.id, taskText(view), commentId);
  await deps.store.set(ref, { ...claim, status: 'waiting', commentId, taskId });
  return 'asked';
}

async function recordAnswer(
  deps: QuestionDeps,
  ref: PullRequestRef,
  record: PullRequestQuestion,
  decider: Person,
  answer: string,
  where: string,
): Promise<void> {
  await deps.rest.postComment(ref.id, relayBody(decider, answer, where));
  await deps.rest.resolveTask(ref.id, record.taskId);
  await deps.store.set(ref, { ...record, status: 'decided', at: deps.now().toISOString() });
}

export type CommentOutcome = 'relayed' | 'no-question' | 'not-waiting' | 'not-newer' | 'not-decider' | 'empty' | ReplyReason;

// A new comment on a pull request: relayed when it is a newer one by the person asked
export async function relayPullRequestComment(deps: QuestionDeps, pullRequestId: number, commentId: number): Promise<CommentOutcome> {
  const ref = { repository: deps.repository, id: pullRequestId };
  const record = await deps.store.get(ref);
  if (record === undefined) return 'no-question';
  if (record.status !== 'waiting') return 'not-waiting';
  // Bitbucket numbers comments in the order they are made
  if (commentId <= record.commentId) return 'not-newer';
  const comment = await deps.rest.comment(pullRequestId, commentId);
  if (comment.author.accountId !== record.decider.accountId) return 'not-decider';
  if (comment.text.trim() === '') return 'empty';
  const pullRequest = await deps.rest.pullRequest(pullRequestId);
  const outcome = await deps.decisions.reply({
    key: record.key,
    questionId: record.questionId,
    author: comment.author,
    text: comment.text,
    pullRequest: { id: pullRequestId, url: pullRequest.url },
  });
  if (outcome.relayed) {
    await recordAnswer(deps, ref, record, comment.author, outcome.answer, 'on this pull request');
    return 'relayed';
  }
  switch (outcome.reason) {
    case 'unread':
      await deps.rest.postComment(pullRequestId, unreadBody(comment.author, record.options));
      break;
    // Jira moved on (answered there, or asked again): show the pull request what it has now
    case 'decided':
    case 'other-question':
    case 'no-question':
      await syncQuestion(deps, pullRequest);
      break;
    case 'not-decider':
    case 'no-answer':
      break;
  }
  return outcome.reason;
}

