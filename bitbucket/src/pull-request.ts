import api, { route } from '@forge/api';
import { sendToJira } from './bridge';
import { pairing } from './settings';

// The event carries ids only: its title is { value, truncated } and it has no links,
// so the handler reads the pull request from the REST API
type PullRequestEvent = {
  eventType: string;
  selfGenerated?: boolean;
  workspace: { uuid: string };
  repository: { uuid: string };
  pullrequest: { id: number };
};

type PullRequest = { title: string; url: string };

async function readPullRequest(workspace: string, repository: string, id: number): Promise<PullRequest> {
  const response = await api
    .asApp()
    .requestBitbucket(route`/2.0/repositories/${workspace}/${repository}/pullrequests/${id}`);
  if (!response.ok) {
    throw new Error(`reading pull request ${id} failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { title?: unknown; links?: { html?: { href?: unknown } } };
  const title = body.title;
  const url = body.links?.html?.href;
  if (typeof title !== 'string' || typeof url !== 'string') {
    throw new Error(`pull request ${id} came back without a title or an HTML link`);
  }
  return { title, url };
}

export async function onPullRequest(event: PullRequestEvent): Promise<void> {
  if (event.selfGenerated === true) return;
  const paired = await pairing();
  if (paired === undefined) {
    console.warn('not paired with a Jira site yet: set it up in the workspace settings');
    return;
  }
  const workspace = event.workspace.uuid;
  const repository = event.repository.uuid;
  const { id } = event.pullrequest;
  const { title, url } = await readPullRequest(workspace, repository, id);
  const answer = await sendToJira(paired, {
    kind: 'pullrequest-opened',
    sentAt: Date.now(),
    workspace,
    repository,
    id,
    title,
    url,
  });
  console.log(`told Jira about pull request ${id}: ${JSON.stringify(answer)}`);
}
