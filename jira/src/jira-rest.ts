import api, { route } from '@forge/api';
import type { JiraKey } from '@shipmill-atlassian/shared/jira-key';

// The Jira REST calls the release reader makes, as an interface so tests replay recorded
// responses. Each returns the response body as JSON; the reader checks its shape.

export type SearchRequest = { jql: string; fields: string[]; maxResults: number; nextPageToken?: string };

export interface JiraRest {
  search(request: SearchRequest): Promise<unknown>;
  comments(key: JiraKey, startAt: number, maxResults: number): Promise<unknown>;
}

export const forgeJiraRest: JiraRest = {
  async search(request) {
    const response = await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`Jira returned ${response.status} to a search: ${await response.text()}`);
    return response.json();
  },
  async comments(key, startAt, maxResults) {
    const response = await api
      .asApp()
      .requestJira(route`/rest/api/3/issue/${key}/comment?startAt=${startAt}&maxResults=${maxResults}&orderBy=created`, {
        headers: { Accept: 'application/json' },
      });
    if (!response.ok) throw new Error(`Jira returned ${response.status} listing comments on ${key}: ${await response.text()}`);
    return response.json();
  },
};
