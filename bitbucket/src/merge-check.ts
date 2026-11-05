import { forgeBitbucket } from './bitbucket-rest';
import { NotPairedError, gatherFacts, jiraWorkItems } from './facts';
import { checkResult, type CheckResult } from './holds';

// The bitbucket:mergeCheck function. The event carries ids only; everything else is read
// fresh, so a rerun after a hold is lifted passes. An error thrown here counts as a failed
// check that the user can rerun.
type MergeCheckEvent = {
  workspace: { uuid: string };
  repository: { uuid: string };
  pullrequest: { id: number };
  trigger: { type: string };
};

export async function onMergeCheck(event: MergeCheckEvent): Promise<CheckResult> {
  const rest = forgeBitbucket(event.workspace.uuid, event.repository.uuid);
  try {
    return checkResult(await gatherFacts(rest, jiraWorkItems, event.pullrequest.id));
  } catch (error) {
    if (error instanceof NotPairedError) return { success: false, message: error.message };
    throw error;
  }
}
