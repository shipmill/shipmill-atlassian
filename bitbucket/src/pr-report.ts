import type { PullRequestDecisions } from '@shipmill-atlassian/shared/bridge';
import type { OpenTask, ReportOutcome } from '@shipmill-atlassian/shared/pull-request-decisions';
import type { PullRequest, Task } from './bitbucket-rest';
import { decisionTaskQuestion } from './holds';
import type { PullRequestQuestion, QuestionStore } from './question-store';

// Tells the Jira app which decisions are open on a pull request, so they block the release
// its work item is in. Bitbucket has no event for a task opened or resolved, so this runs
// wherever the app reads the pull request's tasks: its events, the merge check and the card.

export type ReportToJira = (report: Omit<PullRequestDecisions, 'kind' | 'sentAt'>) => Promise<ReportOutcome>;

// The unresolved decision tasks, less the one shipmill opened to repeat the work item's
// question: the work item counts that decision already, and its answer resolves the task
export function openDecisions(tasks: readonly Task[], question: PullRequestQuestion | undefined): OpenTask[] {
  return tasks.flatMap((task) => {
    const asked = decisionTaskQuestion(task);
    if (task.state !== 'UNRESOLVED' || asked === undefined || task.id === question?.taskId) return [];
    return [{ taskId: task.id, question: asked }];
  });
}

// Events give uuids in braces and a module's context may give them bare; the Jira app gets
// them in braces, as the pull request event that linked the pull request sent them
export function braced(uuid: string): string {
  const bare = /^\{?([0-9a-f-]{36})\}?$/i.exec(uuid)?.[1]?.toLowerCase();
  if (bare === undefined) throw new Error(`not a Bitbucket uuid: ${JSON.stringify(uuid)}`);
  return `{${bare}}`;
}

// tasks: the pull request's tasks as read after shipmill last asked or resolved its own
export async function reportDecisions(
  deps: { report: ReportToJira; store: QuestionStore; workspace: string; repository: string },
  pullRequest: PullRequest,
  tasks: readonly Task[],
): Promise<ReportOutcome> {
  const { id, title, url } = pullRequest;
  const question = await deps.store.get({ repository: deps.repository, id });
  const open = openDecisions(tasks, question);
  return deps.report({ workspace: braced(deps.workspace), repository: braced(deps.repository), id, title, url, open });
}
