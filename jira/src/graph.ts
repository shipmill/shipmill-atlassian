import api from '@forge/api';
import type { JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { ParseError, array, nonEmpty, object, oneOf, string } from '@shipmill-atlassian/shared/parse';
import { forgeIssueRest, type IssueRest } from './jira-rest';

// What the Teamwork Graph knows about a work item: the pull requests and deployments linked
// to it, and the teams it is assigned to. The preparer cites these as evidence and names the
// teams as who may decide; Jira REST (the reader) stays the source of everything else.
//
// The graph answers only as a user: Forge has no asApp() for it. And a scope the admin did
// not grant does not fail a query, it empties it. So each object type is its own query (a
// missing scope empties only its own list), and an empty list is reported with the scopes
// it needed, never taken as "nothing linked" in silence.

export const PULL_REQUEST_STATUSES = ['DECLINED', 'DRAFT', 'MERGED', 'OPEN', 'UNKNOWN'] as const;
export const DEPLOYMENT_STATES = ['CANCELLED', 'FAILED', 'IN_PROGRESS', 'PENDING', 'ROLLED_BACK', 'SUCCESSFUL', 'UNKNOWN'] as const;

export type GraphPullRequest = { title: string; url: string; status: (typeof PULL_REQUEST_STATUSES)[number] };
export type GraphDeployment = { name: string; environment: string; url: string; state: (typeof DEPLOYMENT_STATES)[number] };
export type GraphTeam = { name: string; url: string };

export type GraphEvidence = { pullRequests: GraphPullRequest[]; deployments: GraphDeployment[]; teams: GraphTeam[] };

export type GraphList = keyof GraphEvidence;

// The granular scopes each query traverses, as manifest.yml declares them
export const QUERY_SCOPES: Record<GraphList, string[]> = {
  pullRequests: ['read:graph:issue:jira', 'read:graph:pull-request:external'],
  deployments: ['read:graph:issue:jira', 'read:graph:deployment:external'],
  teams: ['read:graph:issue:jira', 'read:graph:team:atlassian'],
};

const CYPHER: Record<GraphList, string> = {
  pullRequests: 'MATCH (item:JiraWorkItem {ari: $id})-[:content_entity_links_entity]->(found:ExternalPullRequest) RETURN found LIMIT 10',
  deployments: 'MATCH (item:JiraWorkItem {ari: $id})-[:content_entity_links_entity]->(found:ExternalDeployment) RETURN found LIMIT 10',
  teams: 'MATCH (found:AtlassianTeam)-[:atlassian_team_assigned_jira_work_item]->(item:JiraWorkItem {ari: $id}) RETURN found LIMIT 5',
};

export const GRAPH_QUERY = `query shipmill_workItemGraph($cypherQuery: String!, $params: CypherRequestParams) {
  cypherQuery(query: $cypherQuery, params: $params) {
    edges { node { columns { key value {
      __typename
      ... on CypherQueryResultNode { id data {
        __typename
        ... on ExternalPullRequest { title url status }
        ... on ExternalDeployment { displayName url state environment { displayName } }
        ... on AtlassianTeam { displayName profileUrl }
      } }
    } } } }
  }
}`;

// The transport: one GraphQL request to the Teamwork Graph, the response body as JSON
export interface TeamworkGraph {
  request(query: string, variables: Record<string, unknown>): Promise<unknown>;
}

export class GraphError extends Error {}

// As the user the function runs for. Throws where there is none; callers check first.
export const forgeUserGraph: TeamworkGraph = {
  async request(query, variables) {
    const response = await api.asUser().requestTeamworkGraph(query, variables);
    if (!response.ok) throw new GraphError(`the Teamwork Graph returned ${response.status}: ${await response.text()}`);
    return response.json();
  },
};

// The Jira work item's ARI, from the site's cloud id and the item's numeric id
export function workItemAri(cloudId: string, issueId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(cloudId)) throw new GraphError(`not a cloud id: ${JSON.stringify(cloudId)}`);
  if (!/^\d+$/.test(issueId)) throw new GraphError(`not a Jira issue id: ${JSON.stringify(issueId)}`);
  return `ari:cloud:jira:${cloudId}:issue/${issueId}`;
}

// A consumer's installContext, "ari:cloud:jira::site/<cloudId>", to the cloud id
export function siteCloudId(installContext: string): string {
  const match = /^ari:cloud:jira::site\/([0-9a-f-]{36})$/.exec(installContext);
  if (match?.[1] === undefined) throw new GraphError(`not a Jira site context: ${JSON.stringify(installContext)}`);
  return match[1];
}

export async function readGraphEvidence(graph: TeamworkGraph, ari: string): Promise<GraphEvidence> {
  const nodes = async (list: GraphList): Promise<Record<string, unknown>[]> =>
    resultNodes(await graph.request(GRAPH_QUERY, { cypherQuery: CYPHER[list], params: { id: ari } }), `graph.${list}`);
  const [pullRequests, deployments, teams] = await Promise.all([nodes('pullRequests'), nodes('deployments'), nodes('teams')]);
  return {
    pullRequests: pullRequests.map((data, index) => pullRequest(data, `graph.pullRequests[${index}]`)),
    deployments: deployments.map((data, index) => deployment(data, `graph.deployments[${index}]`)),
    teams: teams.map((data, index) => team(data, `graph.teams[${index}]`)),
  };
}

// The data of every node a cypherQuery returned. A GraphQL error fails the read: only an
// empty list stands for a scope not granted.
export function resultNodes(body: unknown, path: string): Record<string, unknown>[] {
  const fields = object(body, path);
  if (fields.errors !== undefined) throw new GraphError(`${path}: the Teamwork Graph answered with errors: ${JSON.stringify(fields.errors)}`);
  const query = object(object(fields.data, `${path}.data`).cypherQuery, `${path}.data.cypherQuery`);
  return array(query.edges, `${path}.edges`).flatMap((edge, row) => {
    const columns = array(object(object(edge, `${path}.edges[${row}]`).node, `${path}.edges[${row}].node`).columns, `${path}.edges[${row}].columns`);
    return columns.map((column, index) => {
      const at = `${path}.edges[${row}].columns[${index}]`;
      const value = object(object(column, at).value, `${at}.value`);
      if (value.__typename !== 'CypherQueryResultNode') throw new ParseError(`${at}.value`, `is a ${String(value.__typename)}, not a node`);
      return object(value.data, `${at}.value.data`);
    });
  });
}

function typed(data: Record<string, unknown>, path: string, name: string): void {
  if (data.__typename !== name) throw new ParseError(path, `is a ${String(data.__typename)}, not an ${name}`);
}

function pullRequest(data: Record<string, unknown>, path: string): GraphPullRequest {
  typed(data, path, 'ExternalPullRequest');
  return { title: nonEmpty(data.title, `${path}.title`), url: nonEmpty(data.url, `${path}.url`), status: oneOf(data.status, `${path}.status`, PULL_REQUEST_STATUSES) };
}

function deployment(data: Record<string, unknown>, path: string): GraphDeployment {
  typed(data, path, 'ExternalDeployment');
  return {
    name: nonEmpty(data.displayName, `${path}.displayName`),
    environment: nonEmpty(object(data.environment, `${path}.environment`).displayName, `${path}.environment.displayName`),
    url: nonEmpty(data.url, `${path}.url`),
    state: oneOf(data.state, `${path}.state`, DEPLOYMENT_STATES),
  };
}

function team(data: Record<string, unknown>, path: string): GraphTeam {
  typed(data, path, 'AtlassianTeam');
  return { name: nonEmpty(data.displayName, `${path}.displayName`), url: string(data.profileUrl, `${path}.profileUrl`) };
}

// The preparer's view: the graph's evidence for a work item, or why there is none. An
// unavailable graph is not an error: Jira REST alone prepares the decision, as before.
export type GraphLookup =
  | { status: 'read'; evidence: GraphEvidence; empty: GraphList[] }
  | { status: 'unavailable'; reason: string };

export interface WorkItemGraph {
  lookup(key: JiraKey): Promise<GraphLookup>;
}

export function unavailableGraph(reason: string): WorkItemGraph {
  return { lookup: async () => ({ status: 'unavailable', reason }) };
}

// The graph for the work items of one site: the item's id from Jira REST, then the graph
export function siteGraph(graph: TeamworkGraph, issues: IssueRest, cloudId: string): WorkItemGraph {
  return {
    async lookup(key) {
      const issue = await issues.issue(key, ['summary']);
      if (issue === undefined) throw new GraphError(`${key} is not on the site`);
      const evidence = await readGraphEvidence(graph, workItemAri(cloudId, nonEmpty(object(issue, key).id, `${key}.id`)));
      const empty = (Object.keys(QUERY_SCOPES) as GraphList[]).filter((list) => evidence[list].length === 0);
      return { status: 'read', evidence, empty };
    },
  };
}

// The prepare consumer's context: the site, and the user the event runs for, where there is one
export type ConsumerContext = { installContext: string; principal?: { accountId: string } };

// The Teamwork Graph answers only as a user (Forge has no asApp() for it). A prepare pushed
// by the dev trigger runs for nobody, so it prepares from Jira REST alone and says so.
export function preparerGraph(context: ConsumerContext): WorkItemGraph {
  if (context.principal === undefined) return unavailableGraph('the prepare runs for no user, and the Teamwork Graph answers only as one');
  return siteGraph(forgeUserGraph, forgeIssueRest, siteCloudId(context.installContext));
}
