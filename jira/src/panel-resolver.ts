import api, { route } from '@forge/api';
import Resolver from '@forge/resolver';
import { projectKey, type ProjectKey } from '@shipmill-atlassian/shared/jira-key';
import { ParseError, nonEmpty, object } from '@shipmill-atlassian/shared/parse';
import { forgeDecisionJira } from './decision-jira';
import { forgeJiraRest } from './jira-rest';
import { kvsPullRequests } from './pull-request-store';
import { readRelease } from './reader';
import { openVersions, parseFixVersions, releasePanel, type ReleasePanel } from './release-panel';

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

export async function panelView(project: ProjectKey, picked: string | undefined): Promise<PanelView> {
  const versions = openVersions(parseFixVersions(await projectVersions(project), `versions(${project})`));
  const version = picked ?? versions[0];
  if (version === undefined) return { versions, panel: null };
  if (!versions.includes(version)) throw new ParseError('version', `${JSON.stringify(version)} is not an open fix version of ${project}`);
  const release = await readRelease(forgeJiraRest, kvsPullRequests, project, version);
  return { versions, panel: await releasePanel(release, forgeDecisionJira) };
}

const resolver = new Resolver();

resolver.define('getPanel', async ({ payload, context }): Promise<PanelView> => {
  const extension = object(context.extension, 'context.extension');
  const project = projectKey(nonEmpty(object(extension.project, 'context.extension.project').key, 'context.extension.project.key'));
  const picked: unknown = payload.version;
  return panelView(project, picked === undefined || picked === null ? undefined : nonEmpty(picked, 'version'));
});

export const panelResolver = resolver.getDefinitions();
