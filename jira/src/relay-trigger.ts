import { Queue } from '@forge/events';
import { chat } from '@forge/llm';
import { jiraKey, projectKey } from '@shipmill-atlassian/shared/jira-key';
import { boolean, nonEmpty, object } from '@shipmill-atlassian/shared/parse';
import { commentId } from '@shipmill-atlassian/shared/release';
import { askDecisions, type AskOutcome } from './ask';
import { forgeConfluence, siteUrl } from './confluence';
import { forgeDecisionJira } from './decision-jira';
import { parseLoggedDecision, writeDecision, type DecisionLog } from './decision-log';
import { releaseDecisions } from './decisions';
import { parseGraphLookups, preparerGraph, type ConsumerContext, type GraphLookups } from './graph';
import { llmPreparer, templatePreparer, withGraph } from './prepare';
import { llmReplyReader, relayReply } from './relay';
import { decisionLogSpace, llmEnabled } from './settings';

// The Forge side of the preparer and the relay. A comment event only enqueues: a product
// trigger has 25 s, and reading a reply may call the LLM, so the relay runs in a consumer.
// Preparing a release runs in a consumer too, one LLM call per decision with the switch on.

const RELAY_QUEUE = 'relay-replies';
const PREPARE_QUEUE = 'prepare-releases';
const LOG_QUEUE = 'decision-log';
const relayQueue = new Queue({ key: RELAY_QUEUE });
const prepareQueue = new Queue({ key: PREPARE_QUEUE });
const logQueue = new Queue({ key: LOG_QUEUE });

// A relayed decision goes to the Confluence log through its own queue: the decision is
// already recorded in Jira, and a failed page write fails only the log consumer, in the logs
export const queuedDecisionLog: DecisionLog = {
  async record(decision) {
    await logQueue.push({ body: decision });
  },
};

export async function onDecisionLog(event: { body: Record<string, unknown> }): Promise<void> {
  const decision = parseLoggedDecision(event.body, 'decision');
  const outcome = await writeDecision(decision, { space: await decisionLogSpace(), confluence: forgeConfluence, site: siteUrl });
  console.log(`decision log ${decision.key}: ${JSON.stringify(outcome)}`);
}

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
  const outcome = await relayReply(key, reply, { jira: forgeDecisionJira, reader, now: () => new Date(), log: queuedDecisionLog });
  console.log(`relay ${key} comment ${reply}: ${JSON.stringify(outcome)}`);
}

// The graph, where given, is what the release panel read as the user who pressed "Ask
// decisions"; the dev trigger gives none
export async function enqueuePrepare(project: string, version: string, llm: boolean, graph?: GraphLookups): Promise<void> {
  await prepareQueue.push({ body: graph === undefined ? { project, version, llm } : { project, version, llm, graph } });
}

export async function onPrepareRelease(event: { body: Record<string, unknown> }, context: ConsumerContext): Promise<AskOutcome[]> {
  const project = projectKey(nonEmpty(event.body.project, 'project'));
  const version = nonEmpty(event.body.version, 'version');
  const llm = boolean(event.body.llm, 'llm');
  const carried = event.body.graph === undefined ? undefined : parseGraphLookups(event.body.graph, 'graph');
  const { release, decisions } = await releaseDecisions(project, version, llm);
  const outcomes = await askDecisions(release, decisions, {
    jira: forgeDecisionJira,
    preparer: withGraph(llm ? llmPreparer(chat) : templatePreparer, preparerGraph(context, carried)),
    now: () => new Date(),
  });
  console.log(`prepare ${project} ${version} (llm ${llm}): ${JSON.stringify(outcomes)}`);
  return outcomes;
}
