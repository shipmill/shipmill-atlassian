import type { JiraKey } from '@shipmill-atlassian/shared/jira-key';
import type { WorkItemStatus } from '@shipmill-atlassian/shared/work-item';
import { labelledDecisions } from './finder';
import type { IssueRest, JiraRest } from './jira-rest';
import { readWorkItem, type PullRequestLookup } from './reader';

// The bridge's answer about one work item. Only labelled decisions count, never the LLM:
// a merge check must answer fast and cost nothing, and the preparer labels every decision
// it prepares, so a prepared implicit decision is labelled too.
export async function workItemStatus(
  rest: JiraRest,
  issues: IssueRest,
  pullRequests: PullRequestLookup,
  key: JiraKey,
): Promise<WorkItemStatus> {
  const read = await readWorkItem(rest, issues, pullRequests, key);
  if (read === undefined) return { key, found: false };
  const { item, fixVersions } = read;
  return {
    key,
    found: true,
    summary: item.summary,
    fixVersions,
    openDecisions: labelledDecisions([item]).map((decision) => decision.question),
    decider: item.owner ?? item.reporter,
  };
}
