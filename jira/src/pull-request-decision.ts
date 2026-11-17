import type { DecisionReply } from '@shipmill-atlassian/shared/bridge';
import type { DecisionView, ReplyOutcome } from '@shipmill-atlassian/shared/decision';
import type { JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { relayComment } from './comment';
import type { DecisionJira } from './decision-jira';
import type { DecisionLog } from './decision-log';
import { current, isAnswered, withClosed } from './question';
import { answerText, readReply, type ReplyReader } from './relay';

// The Jira side of a decision asked on a pull request. The Bitbucket app asks what the work
// item waits on, posts that question on the pull request, and sends back a reply made there.
// Jira keeps the one answer: a reply on the pull request is relayed exactly as a comment on
// the work item would be, and the person asked is checked here again.

export async function decisionView(jira: DecisionJira, key: JiraKey): Promise<DecisionView> {
  const question = current(await jira.questions(key));
  // A withdrawn question waits on nobody: the pull request has nothing to show
  if (question === undefined || question.status === 'withdrawn') return { key, status: 'none' };
  const asked = {
    questionId: question.id,
    question: question.question,
    options: question.options,
    recommended: question.recommended,
    decider: question.askedOf,
    llm: question.llm,
  };
  if (isAnswered(question)) return { key, status: 'decided', ...asked, answer: answerText(question, question.answer) };
  return { key, status: 'waiting', ...asked };
}

export async function relayPullRequestReply(
  reply: DecisionReply,
  deps: { jira: DecisionJira; reader: ReplyReader | null; now: () => Date; log: DecisionLog },
): Promise<ReplyOutcome> {
  const { key } = reply;
  const questions = await deps.jira.questions(key);
  const open = current(questions);
  if (open === undefined) return { relayed: false, reason: 'no-question' };
  // The pull request still shows an older question; its next sync shows the current one
  if (open.id !== reply.questionId) return { relayed: false, reason: 'other-question' };
  if (open.status === 'withdrawn') return { relayed: false, reason: 'no-question' };
  if (open.status !== 'waiting') return { relayed: false, reason: 'decided' };
  if (reply.author.accountId !== open.askedOf.accountId) return { relayed: false, reason: 'not-decider' };
  const reading = await readReply(open, reply.text, deps.reader);
  // The note asking for a number goes on the pull request, where the reply was made
  if (reading === 'unread' || reading === 'no-answer') return { relayed: false, reason: reading };
  const answer = answerText(open, reading);
  const where = `on Bitbucket pull request #${reply.pullRequest.id} (${reply.pullRequest.url})`;
  const replyId = await deps.jira.postComment(key, relayComment(reply.author, answer, where));
  await deps.jira.label(key, false);
  const answeredAt = deps.now().toISOString();
  await deps.jira.setQuestions(key, withClosed(questions, { ...open, status: 'answered', answer: reading, answeredBy: reply.author, answeredAt, replyId }));
  await deps.log.record({ key, question: open.question, answer, decider: reply.author, decidedAt: answeredAt, replyId });
  return { relayed: true, answer };
}
