import api, { route } from '@forge/api';
import type { JiraKey, ProjectKey } from '@shipmill-atlassian/shared/jira-key';
import { boolean, object } from '@shipmill-atlassian/shared/parse';

// What the user a function runs for may do in Jira, as Jira itself answers it
// (GET /rest/api/3/mypermissions, asked as that user). The MCP tools and the release panel
// check here before they read or write as the app, so a caller never reads or asks through
// shipmill what Jira would not let them read or comment on themselves.
//
// The call goes as the user, so it needs the user's consent to the app: until they allowed
// access once in a Forge UI (the release panel prompts for it), Forge throws
// NEEDS_AUTHENTICATION_ERR, and an MCP client gets "MCP_UNAUTHENTICATED: User consent required".

export const PERMISSIONS = ['BROWSE_PROJECTS', 'ADD_COMMENTS'] as const;
export type Permission = (typeof PERMISSIONS)[number];

// A project, or one work item (which also weighs its issue security level)
export type PermissionTarget = { project: ProjectKey } | { item: JiraKey };

export interface CallerPermissions {
  // The permissions the caller holds out of these; none when Jira does not show them the target
  held(target: PermissionTarget, permissions: readonly Permission[]): Promise<Permission[]>;
}

export class AccessError extends Error {}

function targetText(target: PermissionTarget): string {
  return 'project' in target ? `project ${target.project}` : target.item;
}

export async function requirePermissions(caller: CallerPermissions, target: PermissionTarget, needed: readonly Permission[]): Promise<void> {
  const held = await caller.held(target, needed);
  const missing = needed.filter((permission) => !held.includes(permission));
  if (missing.length > 0) throw new AccessError(`you lack ${missing.join(' and ')} on ${targetText(target)} in Jira`);
}

export function parseMyPermissions(value: unknown, permissions: readonly Permission[], path: string): Permission[] {
  const all = object(object(value, path).permissions, `${path}.permissions`);
  return permissions.filter((permission) =>
    boolean(object(all[permission], `${path}.permissions.${permission}`).havePermission, `${path}.permissions.${permission}.havePermission`),
  );
}

export const forgeCallerPermissions: CallerPermissions = {
  async held(target, permissions) {
    const list = permissions.join(',');
    const response = await api
      .asUser()
      .requestJira(
        'project' in target
          ? route`/rest/api/3/mypermissions?projectKey=${target.project}&permissions=${list}`
          : route`/rest/api/3/mypermissions?issueKey=${target.item}&permissions=${list}`,
        { headers: { Accept: 'application/json' } },
      );
    // Jira answers 404 for a project or work item the user cannot see
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`Jira returned ${response.status} checking your permissions on ${targetText(target)}: ${await response.text()}`);
    return parseMyPermissions(await response.json(), permissions, `mypermissions(${targetText(target)})`);
  },
};
