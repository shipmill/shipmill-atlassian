import api, { route, type APIResponse } from '@forge/api';
import type { JiraKey, ProjectKey } from '@shipmill-atlassian/shared/jira-key';
import { nonEmpty, object } from '@shipmill-atlassian/shared/parse';
import { NEEDS_DECISION, commentId, parsePerson, type Comment, type CommentId, type Person } from '@shipmill-atlassian/shared/release';
import type { Adf } from './comment';
import { PROPERTY, parseDecisionState, type DecisionState } from './decision-state';
import { jiraComment } from './reader';

// The Jira writes the preparer and the relay make, as an interface so tests run them on a
// fake. Every call is as the app, so the comments show as shipmill's.

export interface DecisionJira {
  state(key: JiraKey): Promise<DecisionState | undefined>;
  setState(key: JiraKey, state: DecisionState): Promise<void>;
  comment(key: JiraKey, id: CommentId): Promise<Comment>;
  postComment(key: JiraKey, body: Adf): Promise<CommentId>;
  label(key: JiraKey, present: boolean): Promise<void>;
  projectLead(project: ProjectKey): Promise<Person>;
}

async function checked(response: APIResponse, what: string): Promise<APIResponse> {
  if (!response.ok) throw new Error(`Jira returned ${response.status} ${what}: ${await response.text()}`);
  return response;
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

export const forgeDecisionJira: DecisionJira = {
  async state(key) {
    const response = await api.asApp().requestJira(route`/rest/api/3/issue/${key}/properties/${PROPERTY}`, {
      headers: { Accept: 'application/json' },
    });
    if (response.status === 404) return undefined;
    const body = object(await (await checked(response, `reading ${PROPERTY} on ${key}`)).json(), `${key}.${PROPERTY}`);
    return parseDecisionState(body.value, `${key}.${PROPERTY}`);
  },
  async setState(key, state) {
    await checked(
      await api.asApp().requestJira(route`/rest/api/3/issue/${key}/properties/${PROPERTY}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(state),
      }),
      `writing ${PROPERTY} on ${key}`,
    );
  },
  async comment(key, id) {
    const response = await api.asApp().requestJira(route`/rest/api/3/issue/${key}/comment/${id}`, {
      headers: { Accept: 'application/json' },
    });
    return jiraComment(await (await checked(response, `reading comment ${id} on ${key}`)).json(), `${key}.comment(${id})`);
  },
  async postComment(key, body) {
    const response = await api.asApp().requestJira(route`/rest/api/3/issue/${key}/comment`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ body }),
    });
    const created = object(await (await checked(response, `commenting on ${key}`)).json(), `${key}.comment`);
    return commentId(nonEmpty(created.id, `${key}.comment.id`));
  },
  async label(key, present) {
    await checked(
      await api.asApp().requestJira(route`/rest/api/3/issue/${key}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ update: { labels: [present ? { add: NEEDS_DECISION } : { remove: NEEDS_DECISION }] } }),
      }),
      `${present ? 'adding' : 'removing'} ${NEEDS_DECISION} on ${key}`,
    );
  },
  async projectLead(project) {
    const response = await api.asApp().requestJira(route`/rest/api/3/project/${project}`, { headers: { Accept: 'application/json' } });
    const body = object(await (await checked(response, `reading project ${project}`)).json(), `project(${project})`);
    return parsePerson(body.lead, `project(${project}).lead`);
  },
};
