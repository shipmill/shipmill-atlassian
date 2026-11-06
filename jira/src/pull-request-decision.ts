import type { DecisionReply } from '@shipmill-atlassian/shared/bridge';
import type { DecisionView, ReplyOutcome } from '@shipmill-atlassian/shared/decision';
import type { JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { relayComment } from './comment';
import type { DecisionJira } from './decision-jira';
import { answerText, readReply, type ReplyReader } from './relay';

// The Jira side of a decision asked on a pull request. The Bitbucket app asks what the work
// item waits on, posts that question on the pull request, and sends back a reply made there.
// Jira keeps the one answer: a reply on the pull request is relayed exactly as a comment on
// the work item would be, and the person asked is checked here again.

export async function decisionView(jira: DecisionJira, key: JiraKey): Promise<DecisionView> {
  const state = await jira.state(key);
  if (state === undefined) return { key, status: 'none' };
  const asked = {
    questionId: state.questionId,
    question: state.question,
    options: state.options,
    decider: state.decider,
    llm: state.llm,
  };
  if (state.status === 'waiting') return { key, status: 'waiting', ...asked };
  return { key, status: 'decided', ...asked, answer: answerText(state, state.answer) };
}

export async function relayPullRequestReply(
  reply: DecisionReply,
  deps: { jira: DecisionJira; reader: ReplyReader | null; now: () => Date },
): Promise<ReplyOutcome> {
  const { key } = reply;
  const state = await deps.jira.state(key);
  if (state === undefined) return { relayed: false, reason: 'no-question' };
  // The pull request still shows an older question; its next sync shows the current one
  if (state.questionId !== reply.questionId) return { relayed: false, reason: 'other-question' };
  if (state.status === 'decided') return { relayed: false, reason: 'decided' };
  if (reply.author.accountId !== state.decider.accountId) return { relayed: false, reason: 'not-decider' };
  const reading = await readReply(state, reply.text, deps.reader);
  // The note asking for a number goes on the pull request, where the reply was made
  if (reading === 'unread' || reading === 'no-answer') return { relayed: false, reason: reading };
  const answer = answerText(state, reading);
  const where = `on Bitbucket pull request #${reply.pullRequest.id} (${reply.pullRequest.url})`;
  const replyId = await deps.jira.postComment(key, relayComment(reply.author, answer, where));
  await deps.jira.label(key, false);
  await deps.jira.setState(key, { ...state, status: 'decided', replyId, answer: reading, decidedAt: deps.now().toISOString() });
  return { relayed: true, answer };
}
