import api, { route } from '@forge/api';
import Resolver from '@forge/resolver';
import { projectKey, type ProjectKey } from '@shipmill-atlassian/shared/jira-key';
import { nonEmpty, object } from '@shipmill-atlassian/shared/parse';
import type { AskQueued } from './ask-queued';
import { forgeDecisionJira } from './decision-jira';
import { pullRequestDecisions } from './finder';
import { forgeUserGraph, siteCloudId, siteGraph } from './graph';
import { forgeIssueRest, userJiraRest, type JiraRest } from './jira-rest';
import { graphForAsk, graphFound } from './panel-ask';
import { forgeCallerPermissions, requirePermissions } from './permissions';
import { kvsReports, reportsFor } from './pull-request-report';
import { kvsPullRequests } from './pull-request-store';
import { readRelease } from './reader';
import { enqueuePrepare } from './relay-trigger';
import { checkOpen, openVersions, parseFixVersions, releasePanel, type ReleasePanel } from './release-panel';
import { llmEnabled } from './settings';

// Backs the release panel on the project page: the project's open fix versions, and the panel
// for the one picked (the first open version when none is). The project comes from the page's
// context, never from the payload. The work items are read as the viewing user, after Jira
// says they may browse the project: the panel shows what Jira shows them, and opening it is
// where a user allows the app access once (asUser() needs that consent), which the MCP tools
// (mcp.ts) need too.

export type PanelView = { versions: string[]; panel: ReleasePanel | null };

async function projectVersions(project: ProjectKey): Promise<unknown> {
  const response = await api.asApp().requestJira(route`/rest/api/3/project/${project}/versions`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Jira returned ${response.status} listing the versions of ${project}: ${await response.text()}`);
  return response.json();
}

export async function openFixVersions(project: ProjectKey): Promise<string[]> {
  return openVersions(parseFixVersions(await projectVersions(project), `versions(${project})`));
}

export async function panelView(project: ProjectKey, picked: string | undefined, rest: JiraRest): Promise<PanelView> {
  const versions = await openFixVersions(project);
  const version = picked ?? versions[0];
  if (version === undefined) return { versions, panel: null };
  checkOpen(project, versions, version);
  const release = await readRelease(rest, kvsPullRequests, project, version);
  const keys = new Set(release.items.map((item) => item.key));
  const onPullRequests = pullRequestDecisions(release.items, reportsFor(await kvsReports.all(), keys));
  return { versions, panel: await releasePanel(release, forgeDecisionJira, onPullRequests) };
}

// Runs as the user who pressed the button: the graph is read here, as them, and travels to
// the prepare consumer in the event body. The decisions are asked in the background, since
// preparing them can take longer than a resolver's 25 s. Asking comments on the work items,
// so the user must be able to comment in the project themselves.
export async function askFromPanel(project: ProjectKey, version: string, installContext: string): Promise<AskQueued> {
  await requirePermissions(forgeCallerPermissions, { project }, ['BROWSE_PROJECTS', 'ADD_COMMENTS']);
  checkOpen(project, await openFixVersions(project), version);
  const release = await readRelease(userJiraRest, kvsPullRequests, project, version);
  const llm = await llmEnabled();
  const graph = siteGraph(forgeUserGraph, forgeIssueRest, siteCloudId(installContext));
  const lookups = await graphForAsk(release, llm, forgeDecisionJira, graph);
  await enqueuePrepare(project, version, llm, lookups);
  const asked = Object.keys(lookups);
  const graphRead = graphFound(lookups);
  console.log(`ask ${project} ${version} (llm ${llm}) queued; graph read for ${asked.join(', ') || 'no item'}`);
  return { version, asked, graphRead };
}

const resolver = new Resolver();

function contextProject(context: Record<string, unknown>): ProjectKey {
  const extension = object(context.extension, 'context.extension');
  return projectKey(nonEmpty(object(extension.project, 'context.extension.project').key, 'context.extension.project.key'));
}

// The panel acts for a signed-in user only: an anonymous viewer has no permissions to check
function requireUser(context: Record<string, unknown>): void {
  nonEmpty(context.accountId, 'context.accountId');
}

resolver.define('ask', async ({ payload, context }): Promise<AskQueued> => {
  requireUser(context);
  return askFromPanel(contextProject(context), nonEmpty(payload.version, 'version'), nonEmpty(context.installContext, 'context.installContext'));
});

resolver.define('getPanel', async ({ payload, context }): Promise<PanelView> => {
  requireUser(context);
  const project = contextProject(context);
  await requirePermissions(forgeCallerPermissions, { project }, ['BROWSE_PROJECTS']);
  const picked: unknown = payload.version;
  return panelView(project, picked === undefined || picked === null ? undefined : nonEmpty(picked, 'version'), userJiraRest);
});

export const panelResolver = resolver.getDefinitions();
