import { findJiraKey, type JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { expectKey, parseWorkItemStatus, type WorkItemStatus } from '@shipmill-atlassian/shared/work-item';
import type { BitbucketRest } from './bitbucket-rest';
import { sendToJira } from './bridge';
import { addedBreaking } from './changelog';
import type { Facts } from './holds';
import { POLICY_FILE, lanesFor, parsePolicy } from './policy';
import { pairing } from './settings';

// Gathers what the check and the card judge a pull request by: Bitbucket for the pull
// request, its build, tasks and changelog; the paired Jira app for its work item

export type WorkItems = (key: JiraKey) => Promise<WorkItemStatus>;

export class NotPairedError extends Error {
  constructor() {
    super('shipmill is not connected to Jira yet: a workspace admin connects it in the workspace settings');
  }
}

export async function gatherFacts(rest: BitbucketRest, workItems: WorkItems, id: number): Promise<Facts> {
  const pullRequest = await rest.pullRequest(id);
  const key = findJiraKey(pullRequest.title);
  const policyText = await rest.file(pullRequest.destinationCommit, POLICY_FILE);
  const policy = policyText === undefined ? undefined : parsePolicy(policyText);
  const changelog = policy?.changelog ?? 'CHANGELOG.md';
  const [workItem, statuses, tasks, sourceChangelog, destinationChangelog] = await Promise.all([
    key === undefined ? null : workItems(key),
    rest.statuses(pullRequest.sourceCommit),
    rest.tasks(id),
    rest.file(pullRequest.sourceCommit, changelog),
    rest.file(pullRequest.destinationCommit, changelog),
  ]);
  return {
    pullRequest,
    workItem,
    statuses,
    tasks,
    breaking: addedBreaking(sourceChangelog, destinationChangelog),
    lanes: policy === undefined ? null : lanesFor(policy, pullRequest.destinationBranch),
  };
}

// Asks the paired Jira app over the signed bridge
export const jiraWorkItems: WorkItems = async (key) => {
  const paired = await pairing();
  if (paired === undefined) throw new NotPairedError();
  const answer = await sendToJira(paired, { kind: 'work-item', sentAt: Date.now(), key });
  return expectKey(parseWorkItemStatus(answer), key);
};
