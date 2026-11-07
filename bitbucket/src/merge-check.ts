import { NotPairedError, gatherFacts, jiraWorkItems } from './facts';
import { checkResult, verdictLine, type CheckResult } from './holds';
import { forgeQuestions, reportToJira } from './jira-decisions';
import { syncQuestion } from './pr-decision';

// The bitbucket:mergeCheck function. The event carries ids only; everything else is read
// fresh, so a rerun after a hold is lifted passes. It first brings the pull request's
// question in line with Jira (asks it, or resolves its task once Jira has the answer), and
// tells Jira the decisions open on the pull request, which block its release. An
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
    const facts = await gatherFacts(questions.rest, jiraWorkItems, event.pullrequest.id);
    await reportToJira(event.workspace.uuid, questions, facts.pullRequest, facts.tasks);
    console.log(verdictLine(facts, event.trigger.type));
    return checkResult(facts);
  } catch (error) {
    if (error instanceof NotPairedError) {
      console.log(`merge check #${event.pullrequest.id} (${event.trigger.type}): not paired; ${error.message}`);
      return { success: false, message: error.message };
    }
    throw error;
  }
}
