import type { JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { parsePullRequestReport, type PullRequestReport } from '@shipmill-atlassian/shared/pull-request-decisions';
import type { LinkedPullRequest } from '@shipmill-atlassian/shared/pull-requests';
import { reportKey, type ReportStore } from './pull-request-report';

// Tests only; the app never imports this.

// An in-memory report store, values round-tripped through JSON as KVS does
export class FakeReports implements ReportStore {
  readonly values = new Map<string, unknown>();
  readonly linked: { key: JiraKey; pullRequest: LinkedPullRequest }[] = [];

  async set(report: PullRequestReport): Promise<void> {
    const { workspace, repository, id } = report.pullRequest;
    this.values.set(reportKey(workspace, repository, id), JSON.parse(JSON.stringify(report)));
  }

  async remove(workspace: string, repository: string, id: number): Promise<void> {
    this.values.delete(reportKey(workspace, repository, id));
  }

  async all(): Promise<PullRequestReport[]> {
    return [...this.values.entries()].map(([key, value]) => parsePullRequestReport(value, key));
  }

  readonly link = async (key: JiraKey, pullRequest: LinkedPullRequest): Promise<void> => {
    this.linked.push({ key, pullRequest });
  };
}
