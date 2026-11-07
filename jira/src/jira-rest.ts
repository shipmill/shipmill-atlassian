import api, { route } from '@forge/api';
import type { JiraKey } from '@shipmill-atlassian/shared/jira-key';

// The Jira REST calls the release reader makes, as an interface so tests replay recorded
// responses. Each returns the response body as JSON; the reader checks its shape.

export type SearchRequest = { jql: string; fields: string[]; maxResults: number; nextPageToken?: string };

export interface JiraRest {
  search(request: SearchRequest): Promise<unknown>;
  comments(key: JiraKey, startAt: number, maxResults: number): Promise<unknown>;
}

// Who a request goes as: the app, or the user the function runs for. A read as the user sees
// only what Jira shows them (issue security, project permissions); see permissions.ts.
type Requester = Pick<ReturnType<typeof api.asApp>, 'requestJira'>;

function jiraRestAs(requester: () => Requester): JiraRest {
  return {
    async search(request) {
      const response = await requester().requestJira(route`/rest/api/3/search/jql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw new Error(`Jira returned ${response.status} to a search: ${await response.text()}`);
      return response.json();
    },
    async comments(key, startAt, maxResults) {
      const response = await requester().requestJira(
        route`/rest/api/3/issue/${key}/comment?startAt=${startAt}&maxResults=${maxResults}&orderBy=created`,
        { headers: { Accept: 'application/json' } },
      );
      if (!response.ok) throw new Error(`Jira returned ${response.status} listing comments on ${key}: ${await response.text()}`);
      return response.json();
    },
  };
}

export const forgeJiraRest: JiraRest = jiraRestAs(() => api.asApp());

// As the user the function runs for. Throws NEEDS_AUTHENTICATION_ERR until they allowed the
// app access once, in a Forge UI (the release panel)
export const userJiraRest: JiraRest = jiraRestAs(() => api.asUser());

// One work item by key, or undefined when the site has none by that key (a pull request
// title can name any key). Kept apart from JiraRest so the release fixtures stay as they are.
export interface IssueRest {
  issue(key: JiraKey, fields: string[]): Promise<unknown | undefined>;
}

export const forgeIssueRest: IssueRest = {
  async issue(key, fields) {
    const response = await api
      .asApp()
      .requestJira(route`/rest/api/3/issue/${key}?fields=${fields.join(',')}`, { headers: { Accept: 'application/json' } });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Jira returned ${response.status} reading ${key}: ${await response.text()}`);
    return response.json();
  },
};
