import { natural, object } from '@shipmill-atlassian/shared/parse';
import { sendToJira } from './bridge';
import { forgeQuestions, jiraReport, reportToJira } from './jira-decisions';
import { relayPullRequestComment, syncQuestion } from './pr-decision';
import { braced } from './pr-report';
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
  const questions = forgeQuestions(workspace, repository);
  const pullRequest = await questions.rest.pullRequest(id);
  const { title, url } = pullRequest;
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
  console.log(`question on pull request ${id}: ${await syncQuestion(questions, pullRequest)}`);
  console.log(`decisions on pull request ${id}: ${JSON.stringify(await reportToJira(workspace, questions, pullRequest))}`);
}

// avi:bitbucket:updated:pullrequest: a title edited to name a work item asks its decision
export async function onPullRequestUpdated(event: PullRequestEvent): Promise<void> {
  if (event.selfGenerated === true) return;
  if ((await pairing()) === undefined) return;
  const questions = forgeQuestions(event.workspace.uuid, event.repository.uuid);
  const { id } = event.pullrequest;
  const pullRequest = await questions.rest.pullRequest(id);
  console.log(`question on pull request ${id}: ${await syncQuestion(questions, pullRequest)}`);
  // A title edited to name another work item moves the pull request's decisions with it
  console.log(`decisions on pull request ${id}: ${JSON.stringify(await reportToJira(event.workspace.uuid, questions, pullRequest))}`);
}

// avi:bitbucket:created:pullrequest-comment. The app's own comments are selfGenerated, and
// only the person asked can answer anyway.
export async function onPullRequestComment(event: PullRequestEvent & { comment?: unknown }): Promise<void> {
  if (event.selfGenerated === true) return;
  if ((await pairing()) === undefined) return;
  const id = natural(event.pullrequest.id, 'event.pullrequest.id');
  const comment = natural(object(event.comment, 'event.comment').id, 'event.comment.id');
  const questions = forgeQuestions(event.workspace.uuid, event.repository.uuid);
  const outcome = await relayPullRequestComment(questions, id, comment);
  console.log(`comment ${comment} on pull request ${id}: ${outcome}`);
  // A comment is the nearest event to a task opened on it
  const pullRequest = await questions.rest.pullRequest(id);
  console.log(`decisions on pull request ${id}: ${JSON.stringify(await reportToJira(event.workspace.uuid, questions, pullRequest))}`);
}

// avi:bitbucket:rejected:pullrequest: a declined pull request ships nothing, so its open
// decisions no longer block the release
export async function onPullRequestDeclined(event: PullRequestEvent): Promise<void> {
  if ((await pairing()) === undefined) return;
  const questions = forgeQuestions(event.workspace.uuid, event.repository.uuid);
  const { id } = event.pullrequest;
  const { title, url } = await questions.rest.pullRequest(id);
  const where = { workspace: braced(event.workspace.uuid), repository: braced(event.repository.uuid) };
  const outcome = await jiraReport({ ...where, id, title, url, open: [] });
  console.log(`pull request ${id} declined, decisions cleared: ${JSON.stringify(outcome)}`);
}
