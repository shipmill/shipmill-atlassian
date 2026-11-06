import api, { route } from '@forge/api';
import Resolver from '@forge/resolver';
import { projectKey, type ProjectKey } from '@shipmill-atlassian/shared/jira-key';
import { ParseError, nonEmpty, object } from '@shipmill-atlassian/shared/parse';
import { forgeDecisionJira } from './decision-jira';
import { pullRequestDecisions } from './finder';
import { forgeUserGraph, siteCloudId, siteGraph, unavailableGraph } from './graph';
import { forgeIssueRest, forgeJiraRest } from './jira-rest';
import { graphForAsk, graphFound } from './panel-ask';
import { kvsReports, reportsFor } from './pull-request-report';
import { kvsPullRequests } from './pull-request-store';
import { readRelease } from './reader';
import { enqueuePrepare } from './relay-trigger';
import { openVersions, parseFixVersions, releasePanel, type ReleasePanel } from './release-panel';
import { llmEnabled } from './settings';

// Backs the release panel on the project page: the project's open fix versions, and the panel
// for the one picked (the first open version when none is). The project comes from the page's
// context, never from the payload.

export type PanelView = { versions: string[]; panel: ReleasePanel | null };

async function projectVersions(project: ProjectKey): Promise<unknown> {
  const response = await api.asApp().requestJira(route`/rest/api/3/project/${project}/versions`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Jira returned ${response.status} listing the versions of ${project}: ${await response.text()}`);
  return response.json();
}

async function openFixVersions(project: ProjectKey): Promise<string[]> {
  return openVersions(parseFixVersions(await projectVersions(project), `versions(${project})`));
}

function checkOpen(project: ProjectKey, versions: readonly string[], version: string): void {
  if (!versions.includes(version)) throw new ParseError('version', `${JSON.stringify(version)} is not an open fix version of ${project}`);
}

export async function panelView(project: ProjectKey, picked: string | undefined): Promise<PanelView> {
  const versions = await openFixVersions(project);
  const version = picked ?? versions[0];
  if (version === undefined) return { versions, panel: null };
  checkOpen(project, versions, version);
  const release = await readRelease(forgeJiraRest, kvsPullRequests, project, version);
  const keys = new Set(release.items.map((item) => item.key));
  const onPullRequests = pullRequestDecisions(release.items, reportsFor(await kvsReports.all(), keys));
  return { versions, panel: await releasePanel(release, forgeDecisionJira, onPullRequests) };
}

// What "Ask decisions" queued: the version, and the items the graph had evidence on
export type AskQueued = { version: string; graphRead: string[] };

// Runs as the user who pressed the button: the graph is read here, as them, and travels to
// the prepare consumer in the event body. The decisions are asked in the background, since
// preparing them can take longer than a resolver's 25 s.
export async function askFromPanel(project: ProjectKey, version: string, installContext: string, accountId: string | undefined): Promise<AskQueued> {
  checkOpen(project, await openFixVersions(project), version);
  const release = await readRelease(forgeJiraRest, kvsPullRequests, project, version);
  const llm = await llmEnabled();
  const graph =
    accountId === undefined
      ? unavailableGraph('the panel was opened by no user, and the Teamwork Graph answers only as one')
      : siteGraph(forgeUserGraph, forgeIssueRest, siteCloudId(installContext));
  const lookups = await graphForAsk(release, llm, forgeDecisionJira, graph);
  await enqueuePrepare(project, version, llm, lookups);
  const graphRead = graphFound(lookups);
  console.log(`ask ${project} ${version} (llm ${llm}) queued; graph read for ${Object.keys(lookups).join(', ') || 'no item'}`);
  return { version, graphRead };
}

const resolver = new Resolver();

function contextProject(context: Record<string, unknown>): ProjectKey {
  const extension = object(context.extension, 'context.extension');
  return projectKey(nonEmpty(object(extension.project, 'context.extension.project').key, 'context.extension.project.key'));
}

resolver.define('ask', async ({ payload, context }): Promise<AskQueued> => {
  const accountId: unknown = context.accountId;
  return askFromPanel(
    contextProject(context),
    nonEmpty(payload.version, 'version'),
    nonEmpty(context.installContext, 'context.installContext'),
    accountId === undefined ? undefined : nonEmpty(accountId, 'context.accountId'),
  );
});

resolver.define('getPanel', async ({ payload, context }): Promise<PanelView> => {
  const project = contextProject(context);
  const picked: unknown = payload.version;
  return panelView(project, picked === undefined || picked === null ? undefined : nonEmpty(picked, 'version'));
});

export const panelResolver = resolver.getDefinitions();
