import { Queue } from '@forge/events';
import { chat } from '@forge/llm';
import { jiraKey, projectKey } from '@shipmill-atlassian/shared/jira-key';
import { boolean, nonEmpty, object } from '@shipmill-atlassian/shared/parse';
import { commentId } from '@shipmill-atlassian/shared/release';
import { askDecisions, type AskOutcome } from './ask';
import { forgeDecisionJira } from './decision-jira';
import { releaseDecisions } from './decisions';
import { llmPreparer, templatePreparer } from './prepare';
import { llmReplyReader, relayReply } from './relay';
import { llmEnabled } from './settings';

// The Forge side of the preparer and the relay. A comment event only enqueues: a product
// trigger has 25 s, and reading a reply may call the LLM, so the relay runs in a consumer.
// Preparing a release runs in a consumer too, one LLM call per decision with the switch on.

const RELAY_QUEUE = 'relay-replies';
const PREPARE_QUEUE = 'prepare-releases';
const relayQueue = new Queue({ key: RELAY_QUEUE });
const prepareQueue = new Queue({ key: PREPARE_QUEUE });

// avi:jira:commented:issue. The manifest's ignoreSelf already drops the app's own comments;
// selfGenerated is checked as well, so a relay never answers itself.
export async function onComment(event: Record<string, unknown>): Promise<void> {
  if (event.selfGenerated === true) return;
  const issue = object(event.issue, 'event.issue');
  const comment = object(event.comment, 'event.comment');
  await relayQueue.push({
    body: { key: jiraKey(nonEmpty(issue.key, 'event.issue.key')), commentId: commentId(nonEmpty(comment.id, 'event.comment.id')) },
  });
}

export async function onRelayReply(event: { body: Record<string, unknown> }): Promise<void> {
  const key = jiraKey(nonEmpty(event.body.key, 'key'));
  const reply = commentId(nonEmpty(event.body.commentId, 'commentId'));
  const reader = (await llmEnabled()) ? llmReplyReader(chat) : null;
  const outcome = await relayReply(key, reply, { jira: forgeDecisionJira, reader, now: () => new Date() });
  console.log(`relay ${key} comment ${reply}: ${JSON.stringify(outcome)}`);
}

export async function enqueuePrepare(project: string, version: string, llm: boolean): Promise<void> {
  await prepareQueue.push({ body: { project, version, llm } });
}

export async function onPrepareRelease(event: { body: Record<string, unknown> }): Promise<AskOutcome[]> {
  const project = projectKey(nonEmpty(event.body.project, 'project'));
  const version = nonEmpty(event.body.version, 'version');
  const llm = boolean(event.body.llm, 'llm');
  const { release, decisions } = await releaseDecisions(project, version, llm);
  const outcomes = await askDecisions(release, decisions, {
    jira: forgeDecisionJira,
    preparer: llm ? llmPreparer(chat) : templatePreparer,
    now: () => new Date(),
  });
  console.log(`prepare ${project} ${version} (llm ${llm}): ${JSON.stringify(outcomes)}`);
  return outcomes;
}
