import { kvs, WhereConditions } from '@forge/kvs';
import type { PullRequestDecisions } from '@shipmill-atlassian/shared/bridge';
import { findJiraKey, type JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { parsePullRequestReport, type PullRequestReport, type ReportOutcome } from '@shipmill-atlassian/shared/pull-request-decisions';
import { rememberLinkedPullRequest } from './pull-request-store';

// The decisions the Bitbucket app reported open on each pull request, one KVS value per pull
// request, named by the work item its title names now. Keyed by the pull request rather than
// the work item, so a title edited to name another item moves its decisions with it, and a
// report with nothing open removes the value.

export interface ReportStore {
  set(report: PullRequestReport): Promise<void>;
  remove(workspace: string, repository: string, id: number): Promise<void>;
  // Every kept report; the caller picks the work items it reads
  all(): Promise<PullRequestReport[]>;
}

export async function recordReport(
  message: Omit<PullRequestDecisions, 'kind' | 'sentAt'>,
  deps: { store: ReportStore; link: typeof rememberLinkedPullRequest },
): Promise<ReportOutcome> {
  const { workspace, repository, id, title, url, open } = message;
  const key = findJiraKey(title);
  if (key === undefined || open.length === 0) {
    await deps.store.remove(workspace, repository, id);
    return { key: key ?? null, open: 0 };
  }
  const pullRequest = { workspace, repository, id, title, url };
  // A pull request opened before the apps were paired is linked by its first report
  await deps.link(key, pullRequest);
  await deps.store.set({ key, pullRequest, open });
  return { key, open: open.length };
}

export function reportsFor(reports: readonly PullRequestReport[], keys: ReadonlySet<JiraKey>): PullRequestReport[] {
  return reports.filter((report) => keys.has(report.key));
}

const PREFIX = 'pull-request-decisions:';

// KVS keys allow letters, digits and ":._-#", so the uuids lose their braces
function uuid(text: string): string {
  const bare = /^\{?([0-9a-f-]{36})\}?$/i.exec(text)?.[1]?.toLowerCase();
  if (bare === undefined) throw new Error(`not a Bitbucket uuid: ${JSON.stringify(text)}`);
  return bare;
}

export function reportKey(workspace: string, repository: string, id: number): string {
  return `${PREFIX}${uuid(workspace)}:${uuid(repository)}:${id}`;
}

export const kvsReports: ReportStore = {
  async set(report) {
    const { workspace, repository, id } = report.pullRequest;
    await kvs.set(reportKey(workspace, repository, id), report);
  },
  async remove(workspace, repository, id) {
    await kvs.delete(reportKey(workspace, repository, id));
  },
  async all() {
    const reports: PullRequestReport[] = [];
    let cursor: string | undefined;
    do {
      const query = kvs.query().where('key', WhereConditions.beginsWith(PREFIX)).limit(100);
      const page = await (cursor === undefined ? query : query.cursor(cursor)).getMany<unknown>();
      for (const entry of page.results) reports.push(parsePullRequestReport(entry.value, entry.key));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return reports;
  },
};
