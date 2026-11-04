import { sendToJira } from './bridge';
import { pairing } from './settings';

type Text = string | { value: string };

type PullRequestEvent = {
  eventType: string;
  selfGenerated?: boolean;
  workspace: { uuid: string };
  repository: { uuid: string };
  pullrequest: { id: number; title: Text; links?: { html?: { href?: string } } };
};

// Event payloads carry the title as { value, truncated }, unlike the REST API's string
function plain(text: Text): string {
  return typeof text === 'string' ? text : text.value;
}

export async function onPullRequest(event: PullRequestEvent): Promise<void> {
  if (event.selfGenerated === true) return;
  const paired = await pairing();
  if (paired === undefined) {
    console.warn('not paired with a Jira site yet: set it up in the workspace settings');
    return;
  }
  const { pullrequest } = event;
  const url = pullrequest.links?.html?.href;
  if (url === undefined) throw new Error(`pull request ${pullrequest.id} has no HTML link`);
  const answer = await sendToJira(paired, {
    kind: 'pullrequest-opened',
    sentAt: Date.now(),
    workspace: event.workspace.uuid,
    repository: event.repository.uuid,
    id: pullrequest.id,
    title: plain(pullrequest.title),
    url,
  });
  console.log(`told Jira about pull request ${pullrequest.id}: ${JSON.stringify(answer)}`);
}
