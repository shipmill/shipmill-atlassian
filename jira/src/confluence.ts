import api, { route, type APIResponse } from '@forge/api';
import { array, natural, nonEmpty, object, string } from '@shipmill-atlassian/shared/parse';
import type { Confluence } from './decision-log';

// The Confluence REST v2 calls of the decision log, as the app, so the page shows as written
// by shipmill. They need Confluence on the same site and the app's Confluence scopes.

async function checked(response: APIResponse, what: string): Promise<APIResponse> {
  if (!response.ok) throw new Error(`Confluence returned ${response.status} ${what}: ${await response.text()}`);
  return response;
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

async function results(response: APIResponse, what: string): Promise<unknown[]> {
  return array(object(await (await checked(response, what)).json(), what).results, `${what}.results`);
}

export const forgeConfluence: Confluence = {
  async spaceId(space) {
    const what = `reading space ${space}`;
    const found = await results(await api.asApp().requestConfluence(route`/wiki/api/v2/spaces?keys=${space}`, { headers: { Accept: 'application/json' } }), what);
    const first = found[0];
    return first === undefined ? undefined : nonEmpty(object(first, what).id, `${what}.id`);
  },
  async page(spaceId, title) {
    const what = `finding page ${JSON.stringify(title)}`;
    const found = await results(
      await api
        .asApp()
        .requestConfluence(route`/wiki/api/v2/spaces/${spaceId}/pages?title=${title}&body-format=storage`, { headers: { Accept: 'application/json' } }),
      what,
    );
    if (found.length > 1) throw new Error(`${found.length} pages titled ${JSON.stringify(title)} in space ${spaceId}`);
    const first = found[0];
    if (first === undefined) return undefined;
    const page = object(first, what);
    const storage = object(object(page.body, `${what}.body`).storage, `${what}.body.storage`);
    return {
      id: nonEmpty(page.id, `${what}.id`),
      version: natural(object(page.version, `${what}.version`).number, `${what}.version.number`),
      body: string(storage.value, `${what}.body.storage.value`),
    };
  },
  async createPage(spaceId, title, body) {
    const what = `creating page ${JSON.stringify(title)}`;
    const response = await api.asApp().requestConfluence(route`/wiki/api/v2/pages`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ spaceId, status: 'current', title, body: { representation: 'storage', value: body } }),
    });
    return nonEmpty(object(await (await checked(response, what)).json(), what).id, `${what}.id`);
  },
  async updatePage(page, title, body) {
    await checked(
      await api.asApp().requestConfluence(route`/wiki/api/v2/pages/${page.id}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          id: page.id,
          status: 'current',
          title,
          body: { representation: 'storage', value: body },
          version: { number: page.version + 1, message: 'shipmill added a decision' },
        }),
      }),
      `updating page ${page.id}`,
    );
  },
};

// The site's address, for links to work items: the base URL Jira reports
export async function siteUrl(): Promise<string> {
  const response = await api.asApp().requestJira(route`/rest/api/3/serverInfo`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Jira returned ${response.status} reading serverInfo: ${await response.text()}`);
  return nonEmpty(object(await response.json(), 'serverInfo').baseUrl, 'serverInfo.baseUrl');
}
