import api, { route } from '@forge/api';
import { chat } from '@forge/llm';
import { paragraphs } from '@shipmill-atlassian/shared/adf';
import { BridgeError, SIGNATURE_HEADER, decode, type PullRequestOpened } from '@shipmill-atlassian/shared/bridge';
import { findJiraKey } from '@shipmill-atlassian/shared/jira-key';
import { forgeDecisionJira } from './decision-jira';
import { forgeIssueRest, forgeJiraRest } from './jira-rest';
import { decisionView, relayPullRequestReply } from './pull-request-decision';
import { kvsPullRequests, rememberLinkedPullRequest } from './pull-request-store';
import { llmReplyReader } from './relay';
import { bridgeSecret, llmEnabled } from './settings';
import { workItemStatus } from './work-item';

// The web trigger the Bitbucket app calls with signed messages (see shared/src/bridge.ts)

type WebTriggerRequest = { body?: string; headers?: Record<string, string[] | undefined> };
type WebTriggerResponse = { statusCode: number; headers: Record<string, string[]>; body: string };

function respond(statusCode: number, body: object): WebTriggerResponse {
  return { statusCode, headers: { 'Content-Type': ['application/json'] }, body: JSON.stringify(body) };
}

export async function onBridgeRequest(request: WebTriggerRequest): Promise<WebTriggerResponse> {
  const secret = await bridgeSecret();
  if (secret === undefined) return respond(409, { error: 'not paired: generate a secret on the admin page' });
  let message;
  try {
    message = decode(secret, request.body ?? '', request.headers?.[SIGNATURE_HEADER]?.[0] ?? '', Date.now());
  } catch (error) {
    if (error instanceof BridgeError) {
      console.warn(`bridge refused: ${error.code}: ${error.message}`);
      return respond(error.code === 'malformed' ? 400 : 401, { error: error.code });
    }
    throw error;
  }
  switch (message.kind) {
    case 'ping':
      return respond(200, { paired: true });
    case 'pullrequest-opened':
      return respond(200, await pullRequestOpened(message));
    case 'work-item':
      return respond(200, await workItemStatus(forgeJiraRest, forgeIssueRest, kvsPullRequests, message.key));
    case 'decision':
      return respond(200, await decisionView(forgeDecisionJira, message.key));
    case 'decision-reply': {
      // Read with the LLM only while the switch is on, as a reply in Jira is
      const reader = (await llmEnabled()) ? llmReplyReader(chat) : null;
      const outcome = await relayPullRequestReply(message, { jira: forgeDecisionJira, reader, now: () => new Date() });
      console.log(`relay ${message.key} reply on pull request ${message.pullRequest.id}: ${JSON.stringify(outcome)}`);
      return respond(200, outcome);
    }
  }
}

async function pullRequestOpened(message: PullRequestOpened): Promise<{ linked: boolean; key?: string }> {
  const key = findJiraKey(message.title);
  if (key === undefined) return { linked: false };
  const { workspace, repository, id, title, url } = message;
  await rememberLinkedPullRequest(key, { workspace, repository, id, title, url });
  const body = paragraphs([`shipmill: Bitbucket pull request #${message.id} "${message.title}" opened: ${message.url}`]);
  const response = await api.asApp().requestJira(route`/rest/api/3/issue/${key}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) throw new Error(`Jira returned ${response.status} commenting on ${key}: ${await response.text()}`);
  return { linked: true, key };
}
