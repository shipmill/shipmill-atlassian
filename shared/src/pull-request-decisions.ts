import { jiraKey, type JiraKey } from './jira-key';
import { ParseError, list, natural, nonEmpty, object } from './parse';
import { parseLinkedPullRequest, type LinkedPullRequest } from './pull-requests';

// Decisions opened on a Bitbucket pull request: each unresolved task "Decision needed:
// <question>" on it. The Bitbucket app reports them over the bridge whenever it reads the
// pull request's tasks (Bitbucket has no task event), and the Jira app counts each as a
// blocker of the release the pull request's work item is in. The task shipmill opens to
// repeat the work item's own question is left out: the work item already counts.

export type OpenTask = { taskId: number; question: string };

// What the Jira app keeps for one pull request: the work item its title names and its open decisions
export type PullRequestReport = { key: JiraKey; pullRequest: LinkedPullRequest; open: OpenTask[] };

// The Jira app's answer to a report: the work item it filed the decisions under, if the title names one
export type ReportOutcome = { key: JiraKey | null; open: number };

export function parseOpenTask(value: unknown, path: string): OpenTask {
  const fields = object(value, path);
  return { taskId: natural(fields.taskId, `${path}.taskId`), question: nonEmpty(fields.question, `${path}.question`) };
}

export function parsePullRequestReport(value: unknown, path: string): PullRequestReport {
  const fields = object(value, path);
  const open = list(fields.open, `${path}.open`, parseOpenTask);
  if (open.length === 0) throw new ParseError(`${path}.open`, 'a kept report has at least one open decision');
  return {
    key: jiraKey(nonEmpty(fields.key, `${path}.key`)),
    pullRequest: parseLinkedPullRequest(fields.pullRequest, `${path}.pullRequest`),
    open,
  };
}

export function parseReportOutcome(value: unknown, path = 'report'): ReportOutcome {
  const fields = object(value, path);
  return {
    key: fields.key === null ? null : jiraKey(nonEmpty(fields.key, `${path}.key`)),
    open: natural(fields.open, `${path}.open`),
  };
}
