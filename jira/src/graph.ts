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
//
// Apps can no longer send Cypher text: the graph refuses cypherQuery to new apps
// (developer.atlassian.com/platform/teamwork-graph/migrate-from-raw-cypher/). The reads use
// the curated queries instead (.../teamwork-graph/curated-queries/), which need no setup.
// The catalog has none from a work item to its teams, and a persisted query (customQuery)
// must first be registered for the app by a contributor, outside Forge; so the teams are
// not read, and the log says so.

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

// The lists the graph is read for, and why the others are not
export const READ_LISTS = ['pullRequests', 'deployments'] as const satisfies readonly GraphList[];
export type ReadList = (typeof READ_LISTS)[number];
export const UNREAD_LISTS: Record<Exclude<GraphList, ReadList>, string> = {
  teams: 'the Teamwork Graph has no curated query from a work item to its teams, and no persisted query is registered for the app',
};

// Curated queries cap a page at 25; the first ten are evidence enough for one comment
const PAGE = 10;

// One curated query per list: its field, and the object type its edges carry
const CURATED: Record<ReadList, { field: string; type: string; fields: string }> = {
  pullRequests: { field: 'jiraWorkItemLinkedExternalPullRequests', type: 'ExternalPullRequest', fields: 'title url status' },
  deployments: { field: 'jiraWorkItemLinkedExternalDeployments', type: 'ExternalDeployment', fields: 'displayName url state environment { displayName }' },
};

function curatedQuery(list: ReadList): string {
  const { field, type, fields } = CURATED[list];
  return `query shipmill_${field}($id: ID!) {
  ${field}(id: $id, first: ${PAGE}) {
    edges { node { __typename ... on ${type} { ${fields} } } }
  }
}`;
}

export const GRAPH_QUERIES: Record<ReadList, string> = { pullRequests: curatedQuery('pullRequests'), deployments: curatedQuery('deployments') };

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

// A consumer's installContext to the cloud id. Usually "ari:cloud:jira::site/<cloudId>"; an MCP
// call on a site where the app is also installed in Confluence (for the decision log) arrives
// on the Confluence install, as "ari:cloud:confluence::site/<cloudId>", the same site id
export function siteCloudId(installContext: string): string {
  const match = /^ari:cloud:(?:jira|confluence)::site\/([0-9a-f-]{36})$/.exec(installContext);
  if (match?.[1] === undefined) throw new GraphError(`not a site context: ${JSON.stringify(installContext)}`);
  return match[1];
}

export async function readGraphEvidence(graph: TeamworkGraph, ari: string): Promise<GraphEvidence> {
  const nodes = async (list: ReadList): Promise<Record<string, unknown>[]> =>
    resultNodes(await graph.request(GRAPH_QUERIES[list], { id: ari }), CURATED[list].field, `graph.${list}`);
  const [pullRequests, deployments] = await Promise.all([nodes('pullRequests'), nodes('deployments')]);
  return {
    pullRequests: pullRequests.map((data, index) => pullRequest(data, `graph.pullRequests[${index}]`)),
    deployments: deployments.map((data, index) => deployment(data, `graph.deployments[${index}]`)),
    teams: [],
  };
}

// The node on every edge of a curated query's connection. A GraphQL error fails the read:
// only an empty list stands for a scope not granted.
export function resultNodes(body: unknown, field: string, path: string): Record<string, unknown>[] {
  const fields = object(body, path);
  if (fields.errors !== undefined) throw new GraphError(`${path}: the Teamwork Graph answered with errors: ${JSON.stringify(fields.errors)}`);
  const connection = object(object(fields.data, `${path}.data`)[field], `${path}.data.${field}`);
  return array(connection.edges, `${path}.edges`).map((edge, row) => object(object(edge, `${path}.edges[${row}]`).node, `${path}.edges[${row}].node`));
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
      const empty = READ_LISTS.filter((list) => evidence[list].length === 0);
      return { status: 'read', evidence, empty };
    },
  };
}

// The prepare consumer's context: the site, and the user the event runs for, where there is one
export type ConsumerContext = { installContext: string; principal?: { accountId: string } };

// The Teamwork Graph answers only as a user (Forge has no asApp() for it). A prepare pushed
// by the dev trigger runs for nobody, so it prepares from Jira REST alone and says so.
// The graph the panel carried in the event comes first; without it (the dev trigger), the
// consumer's own user, where there is one.
export function preparerGraph(context: ConsumerContext, carried?: GraphLookups): WorkItemGraph {
  if (carried !== undefined) return carriedGraph(carried);
  if (context.principal === undefined) return unavailableGraph('the prepare runs for no user, and the Teamwork Graph answers only as one');
  return siteGraph(forgeUserGraph, forgeIssueRest, siteCloudId(context.installContext));
}

// The graph a prepare carries in its queue event. The release panel's resolver runs as the
// user who pressed "Ask decisions", so it reads the graph there and passes what it read to
// the prepare consumer, which may run for no user. Keyed by work item, as JSON.
export type GraphLookups = Record<string, GraphLookup>;

const GRAPH_LISTS = Object.keys(QUERY_SCOPES) as GraphList[];

export function parseGraphLookups(value: unknown, path: string): GraphLookups {
  const fields = object(value, path);
  return Object.fromEntries(Object.entries(fields).map(([key, lookup]) => [key, parseGraphLookup(lookup, `${path}.${key}`)]));
}

function parseGraphLookup(value: unknown, path: string): GraphLookup {
  const fields = object(value, path);
  const status = oneOf(fields.status, `${path}.status`, ['read', 'unavailable'] as const);
  if (status === 'unavailable') return { status, reason: nonEmpty(fields.reason, `${path}.reason`) };
  const evidence = object(fields.evidence, `${path}.evidence`);
  const entries = (list: GraphList): Record<string, unknown>[] =>
    array(evidence[list], `${path}.evidence.${list}`).map((entry, index) => object(entry, `${path}.evidence.${list}[${index}]`));
  return {
    status,
    evidence: {
      pullRequests: entries('pullRequests').map((entry, index) => {
        const at = `${path}.evidence.pullRequests[${index}]`;
        return { title: nonEmpty(entry.title, `${at}.title`), url: nonEmpty(entry.url, `${at}.url`), status: oneOf(entry.status, `${at}.status`, PULL_REQUEST_STATUSES) };
      }),
      deployments: entries('deployments').map((entry, index) => {
        const at = `${path}.evidence.deployments[${index}]`;
        return {
          name: nonEmpty(entry.name, `${at}.name`),
          environment: nonEmpty(entry.environment, `${at}.environment`),
          url: nonEmpty(entry.url, `${at}.url`),
          state: oneOf(entry.state, `${at}.state`, DEPLOYMENT_STATES),
        };
      }),
      teams: entries('teams').map((entry, index) => {
        const at = `${path}.evidence.teams[${index}]`;
        return { name: nonEmpty(entry.name, `${at}.name`), url: string(entry.url, `${at}.url`) };
      }),
    },
    empty: array(fields.empty, `${path}.empty`).map((list, index) => oneOf(list, `${path}.empty[${index}]`, GRAPH_LISTS)),
  };
}

// What the resolver read, for the consumer. An item it did not read (it was already asked
// when the button was pressed) prepares from Jira REST alone, and the log says so.
export function carriedGraph(lookups: GraphLookups): WorkItemGraph {
  return {
    lookup: async (key) =>
      lookups[key] ?? { status: 'unavailable', reason: 'the panel did not read the graph for it, since it was already asked when the button was pressed' },
  };
}
