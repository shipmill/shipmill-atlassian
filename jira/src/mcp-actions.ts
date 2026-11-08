import { nonEmpty, object } from '@shipmill-atlassian/shared/parse';
import { forgeDecisionJira } from './decision-jira';
import { forgeUserGraph, siteCloudId, siteGraph } from './graph';
import { forgeIssueRest, userJiraRest } from './jira-rest';
import { askDecision, callerAccountId, listDecisions, parseAskInput, parseItemInput, parseListInput, readAnswer, type AskResult, type DecisionView } from './mcp';
import { openFixVersions, panelView, type PanelView } from './panel-resolver';
import { forgeCallerPermissions } from './permissions';
import { templatePreparer, withGraph } from './prepare';
import { kvsPullRequests } from './pull-request-store';
import { readRelease } from './reader';

// The Rovo actions behind the rovo:mcp module, wired to Forge. Each runs for the MCP caller
// (context.principal): reads go as them, writes as the app once Jira says they may.

function logCall(tool: string, accountId: string, input: object, context: unknown): void {
  // Forge storage is per install, so which install answers decides what the tool can see
  console.log(`mcp ${tool} by ${accountId} on ${String(object(context, 'context').installContext)}: ${JSON.stringify(input)}`);
}

export async function mcpListDecisions(payload: unknown, context: unknown): Promise<PanelView> {
  const accountId = callerAccountId(context);
  const input = parseListInput(payload);
  logCall('list', accountId, input, context);
  return listDecisions(input, { permissions: forgeCallerPermissions, view: (project, version) => panelView(project, version, userJiraRest) });
}

export async function mcpAskDecision(payload: unknown, context: unknown): Promise<AskResult> {
  const accountId = callerAccountId(context);
  const input = parseAskInput(payload);
  logCall('ask', accountId, input, context);
  const cloudId = siteCloudId(nonEmpty(object(context, 'context').installContext, 'context.installContext'));
  const result = await askDecision(input, {
    permissions: forgeCallerPermissions,
    versions: openFixVersions,
    release: (project, version) => readRelease(userJiraRest, kvsPullRequests, project, version),
    jira: forgeDecisionJira,
    // The graph answers as the caller, who allowed the app access once already
    preparer: withGraph(templatePreparer, siteGraph(forgeUserGraph, forgeIssueRest, cloudId)),
    now: () => new Date(),
  });
  console.log(`mcp ask ${input.item}: asked ${result.asked}, ${result.decision.status}`);
  return result;
}

export async function mcpReadAnswer(payload: unknown, context: unknown): Promise<DecisionView> {
  const accountId = callerAccountId(context);
  const input = parseItemInput(payload);
  logCall('answer', accountId, input, context);
  return readAnswer(input, { permissions: forgeCallerPermissions, jira: forgeDecisionJira });
}
