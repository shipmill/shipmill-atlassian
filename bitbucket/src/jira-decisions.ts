import { parseDecisionView, parseReplyOutcome } from '@shipmill-atlassian/shared/decision';
import { ParseError } from '@shipmill-atlassian/shared/parse';
import { parseReportOutcome, type ReportOutcome } from '@shipmill-atlassian/shared/pull-request-decisions';
import type { PullRequest, Task } from './bitbucket-rest';
import { forgeBitbucket } from './bitbucket-rest';
import { sendToJira } from './bridge';
import { NotPairedError } from './facts';
import type { Decisions, QuestionDeps } from './pr-decision';
import { reportDecisions, type ReportToJira } from './pr-report';
import { kvsQuestions } from './question-store';
import { pairing } from './settings';

// The paired Jira app's decisions over the signed bridge

async function paired() {
  const found = await pairing();
  if (found === undefined) throw new NotPairedError();
  return found;
}

export const jiraDecisions: Decisions = {
  async view(key) {
    const view = parseDecisionView(await sendToJira(await paired(), { kind: 'decision', sentAt: Date.now(), key }));
    if (view.key !== key) throw new ParseError('decision.key', `asked about ${key}, the answer is about ${view.key}`);
    return view;
  },
  async reply(reply) {
    return parseReplyOutcome(await sendToJira(await paired(), { kind: 'decision-reply', sentAt: Date.now(), ...reply }));
  },
};

export function forgeQuestions(workspace: string, repository: string): QuestionDeps {
  return { rest: forgeBitbucket(workspace, repository), store: kvsQuestions, decisions: jiraDecisions, repository, now: () => new Date() };
}

export const jiraReport: ReportToJira = async (report) =>
  parseReportOutcome(await sendToJira(await paired(), { kind: 'pullrequest-decisions', sentAt: Date.now(), ...report }));

// Reports the decisions open on a pull request to Jira; tasks as already read, or read now
export async function reportToJira(
  workspace: string,
  questions: QuestionDeps,
  pullRequest: PullRequest,
  tasks?: readonly Task[],
): Promise<ReportOutcome> {
  const deps = { report: jiraReport, store: questions.store, workspace, repository: questions.repository };
  return reportDecisions(deps, pullRequest, tasks ?? (await questions.rest.tasks(pullRequest.id)));
}
