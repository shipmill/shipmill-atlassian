// Seeds the demo release: reads what exists, plans what is missing or left from a run (an
// asked or answered question), makes it, and says what it did. A second run plans nothing.

import { Bitbucket } from './bitbucket';
import { parseConfig, USAGE } from './config';
import { FIX_VERSION, ITEMS, mainFiles } from './demo';
import { Jira } from './jira';
import { describeBitbucket, describeJira, planBitbucket, planJira, pullRequestSpecs } from './plan';

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const config = parseConfig(process.argv.slice(2), process.env);
  const verb = config.dryRun ? 'would' : 'will';

  const jira = new Jira(config.jiraSite, config.email, config.jiraToken, config.projectKey, config.projectName);
  const jiraActions = planJira(ITEMS, FIX_VERSION, await jira.read(ITEMS));
  console.log(`Jira ${config.jiraSite}, project ${config.projectKey}: ${jiraActions.length} ${verb} change`);
  for (const action of jiraActions) {
    console.log(`  ${describeJira(action)}`);
    if (!config.dryRun) {
      await jira.apply(action, FIX_VERSION);
    }
  }

  const bitbucket = new Bitbucket(config.workspace, config.email, config.bitbucketToken, config.repository);
  const files = mainFiles(config.projectName, config.repository);
  const state = await bitbucket.read(files);
  const where = `Bitbucket ${config.workspace}/${config.repository}`;
  if (config.dryRun && jiraActions.some((action) => action.kind === 'create-item')) {
    // Branch names and titles carry the work item keys, which only exist once Jira is seeded
    console.log(`${where}: planned after the Jira work items exist`);
    return;
  }
  const bitbucketActions = planBitbucket(files, pullRequestSpecs(ITEMS, jira.keys), state);
  console.log(`${where}: ${bitbucketActions.length} ${verb} change`);
  for (const action of bitbucketActions) {
    console.log(`  ${describeBitbucket(action)}`);
    if (!config.dryRun) {
      await bitbucket.apply(action);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  console.error(USAGE);
  process.exitCode = 1;
});
