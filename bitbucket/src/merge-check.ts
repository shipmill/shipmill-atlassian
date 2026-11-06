import { NotPairedError, gatherFacts, jiraWorkItems } from './facts';
import { checkResult, type CheckResult } from './holds';
import { forgeQuestions } from './jira-decisions';
import { syncQuestion } from './pr-decision';

// The bitbucket:mergeCheck function. The event carries ids only; everything else is read
// fresh, so a rerun after a hold is lifted passes. It first brings the pull request's
// question in line with Jira (asks it, or resolves its task once Jira has the answer). An
// error thrown here counts as a failed check that the user can rerun.
type MergeCheckEvent = {
  workspace: { uuid: string };
  repository: { uuid: string };
  pullrequest: { id: number };
  trigger: { type: string };
};

export async function onMergeCheck(event: MergeCheckEvent): Promise<CheckResult> {
  const questions = forgeQuestions(event.workspace.uuid, event.repository.uuid);
  try {
    await syncQuestion(questions, await questions.rest.pullRequest(event.pullrequest.id));
    return checkResult(await gatherFacts(questions.rest, jiraWorkItems, event.pullrequest.id));
  } catch (error) {
    if (error instanceof NotPairedError) return { success: false, message: error.message };
    throw error;
  }
}
