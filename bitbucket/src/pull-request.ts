import { forgeBitbucket } from './bitbucket-rest';
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
  const { title, url } = await forgeBitbucket(workspace, repository).pullRequest(id);
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
