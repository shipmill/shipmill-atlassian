import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { jiraKey } from '@shipmill-atlassian/shared/jira-key';
import { ParseError } from '@shipmill-atlassian/shared/parse';
import type { Release } from '@shipmill-atlassian/shared/release';
import { askDecisions } from './ask';
import { frameText } from './comment';
import { FakeJira } from './fake-jira';
import { seedRelease } from './fixtures';
import { findDecisions, type Decision } from './finder';
import {
  GRAPH_QUERY,
  GraphError,
  preparerGraph,
  readGraphEvidence,
  siteCloudId,
  siteGraph,
  unavailableGraph,
  workItemAri,
  type TeamworkGraph,
} from './graph';
import type { IssueRest } from './jira-rest';
import { templatePreparer, withGraph } from './prepare';

// Graph responses in the shape the Teamwork Graph documents for cypherQuery, for the seed's
// HRB-2 (issue id 10002). An item or object type with no file answers empty, as a scope
// the admin did not grant does.

const CLOUD = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
const NOW = () => new Date('2026-12-03T09:00:00.000Z');
const DIRECTORY = new URL('./fixtures/graph/', import.meta.url);

function load(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, DIRECTORY), 'utf8'));
}

const OBJECT_FILES: [RegExp, string][] = [
  [/ExternalPullRequest/, 'pull-requests'],
  [/ExternalDeployment/, 'deployments'],
  [/AtlassianTeam/, 'teams'],
];

class RecordedGraph implements TeamworkGraph {
  readonly calls: { query: string; cypher: string; id: string }[] = [];

  constructor(
    readonly recorded: Map<string, string>,
    readonly answer: (file: string | undefined) => unknown = (file) => load(file ?? 'empty.json'),
  ) {}

  async request(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const cypher = variables.cypherQuery as string;
    const id = (variables.params as { id: string }).id;
    this.calls.push({ query, cypher, id });
    const kind = OBJECT_FILES.find(([pattern]) => pattern.test(cypher))?.[1];
    if (kind === undefined) throw new Error(`no recorded kind for ${cypher}`);
    const item = this.recorded.get(id);
    return this.answer(item === undefined ? undefined : `${item}-${kind}.json`);
  }
}

// HRB-2 has every file; HRB-3 and HRB-4 none
const SEED_GRAPH = new Map([[workItemAri(CLOUD, '10002'), 'HRB-2']]);

const ISSUE_IDS: IssueRest = {
  async issue(key) {
    return { id: { 'HRB-2': '10002', 'HRB-3': '10003', 'HRB-4': '10004' }[key as string], key };
  },
};

async function seedDecisions(): Promise<{ release: Release; decisions: Decision[] }> {
  const release = await seedRelease();
  return { release, decisions: await findDecisions(release, { llm: false, implicit: { find: async () => [] } }) };
}

test('the graph reads pull requests, deployments and teams for a work item, each in its own query', async () => {
  const graph = new RecordedGraph(SEED_GRAPH);
  const evidence = await readGraphEvidence(graph, workItemAri(CLOUD, '10002'));
  assert.deepEqual(evidence, {
    pullRequests: [{ title: 'HRB-2 Rejects API v1 tokens with a pointer to the migration guide', url: 'https://bitbucket.org/shipmill-dev/harbor/pull-requests/2', status: 'OPEN' }],
    deployments: [{ name: 'harbor #41', environment: 'Staging', url: 'https://bitbucket.org/shipmill-dev/harbor/deployments/41', state: 'SUCCESSFUL' }],
    teams: [{ name: 'Harbor API', url: 'https://shipmill-dev.atlassian.net/people/team/harbor-api' }],
  });
  assert.equal(graph.calls.length, 3);
  assert.ok(graph.calls.every((call) => call.query === GRAPH_QUERY && call.id === `ari:cloud:jira:${CLOUD}:issue/10002`));
});

test('the prepared comment on a seeded decision cites the graph evidence and who may decide', async () => {
  const { release, decisions } = await seedDecisions();
  const decision = decisions[0]!;
  const item = release.items.find((candidate) => candidate.key === decision.key)!;
  const lines: string[] = [];
  const preparer = withGraph(templatePreparer, siteGraph(new RecordedGraph(SEED_GRAPH), ISSUE_IDS, CLOUD), (line) => lines.push(line));
  const prepared = await preparer.prepare(decision, item, release, decision.askOf!);
  const evidence = frameText(prepared).split('\n').find((line) => line.startsWith('Evidence: '));
  assert.equal(
    evidence,
    'Evidence: asked in the description of HRB-2: "Decision needed: retire v1 tokens in 2.4, or keep them for one more release? Fourteen customers still call the API with a v1 token every week."; ' +
      'in the Teamwork Graph, pull request "HRB-2 Rejects API v1 tokens with a pointer to the migration guide" (open, https://bitbucket.org/shipmill-dev/harbor/pull-requests/2); ' +
      'deployment harbor #41 to Staging (successful, https://bitbucket.org/shipmill-dev/harbor/deployments/41); ' +
      'assigned to team Harbor API, who may decide too',
  );
  assert.deepEqual(lines, []);
});

test('without the graph the prepared comment is unchanged, and the log says why', async () => {
  const { release, decisions } = await seedDecisions();
  const decision = decisions[0]!;
  const item = release.items.find((candidate) => candidate.key === decision.key)!;
  const lines: string[] = [];
  const plain = await templatePreparer.prepare(decision, item, release, decision.askOf!);
  const prepared = await withGraph(templatePreparer, unavailableGraph('no user'), (line) => lines.push(line)).prepare(decision, item, release, decision.askOf!);
  assert.equal(frameText(prepared), frameText(plain));
  assert.deepEqual(lines, ['graph HRB-2: not read, no user']);
});

test('an empty graph never passes in silence: each empty list names its scopes, and a gap with Bitbucket is called out', async () => {
  const { release, decisions } = await seedDecisions();
  const decision = decisions.find((candidate) => candidate.key === 'HRB-3')!;
  const item = release.items.find((candidate) => candidate.key === decision.key)!;
  assert.ok(item.pullRequests.length > 0, 'the seed links HRB-3 to a pull request');
  const lines: string[] = [];
  const preparer = withGraph(templatePreparer, siteGraph(new RecordedGraph(SEED_GRAPH), ISSUE_IDS, CLOUD), (line) => lines.push(line));
  const plain = await templatePreparer.prepare(decision, item, release, decision.askOf ?? release.items[0]!.reporter!);
  const prepared = await preparer.prepare(decision, item, release, decision.askOf ?? release.items[0]!.reporter!);
  assert.equal(prepared.evidence, plain.evidence);
  assert.deepEqual(lines, [
    `graph HRB-3: no pull requests, yet Bitbucket links ${item.pullRequests.length}; check that an admin granted read:graph:issue:jira, read:graph:pull-request:external`,
    'graph HRB-3: no deployments; either none is linked or read:graph:issue:jira, read:graph:deployment:external is not granted',
    'graph HRB-3: no teams; either none is linked or read:graph:issue:jira, read:graph:team:atlassian is not granted',
  ]);
});

test('asking a seeded release with the graph posts the graph evidence only where the graph has some', async () => {
  const { release, decisions } = await seedDecisions();
  const jira = new FakeJira();
  const preparer = withGraph(templatePreparer, siteGraph(new RecordedGraph(SEED_GRAPH), ISSUE_IDS, CLOUD), () => {});
  await askDecisions(release, decisions, { jira, preparer, now: NOW });
  assert.match(jira.posted(jiraKey('HRB-2'))[0]!.text, /in the Teamwork Graph, pull request "HRB-2 Rejects API v1 tokens/);
  assert.doesNotMatch(jira.posted(jiraKey('HRB-3'))[0]!.text, /Teamwork Graph/);
});

test('a GraphQL error fails the read instead of passing for an empty graph', async () => {
  const graph = new RecordedGraph(SEED_GRAPH, () => load('errors.json'));
  await assert.rejects(readGraphEvidence(graph, workItemAri(CLOUD, '10002')), GraphError);
  const odd = new RecordedGraph(SEED_GRAPH, () => ({ data: { cypherQuery: { edges: [{ node: { columns: [{ key: 'found', value: { __typename: 'CypherQueryResultIntObject' } }] } }] } } }));
  await assert.rejects(readGraphEvidence(odd, workItemAri(CLOUD, '10002')), ParseError);
});

test('the graph is read only where the prepare runs for a user', async () => {
  const site = `ari:cloud:jira::site/${CLOUD}`;
  assert.deepEqual(await preparerGraph({ installContext: site }).lookup(jiraKey('HRB-2')), {
    status: 'unavailable',
    reason: 'the prepare runs for no user, and the Teamwork Graph answers only as one',
  });
  assert.equal(siteCloudId(site), CLOUD);
  assert.throws(() => siteCloudId('ari:cloud:bitbucket::workspace/x'), GraphError);
  assert.throws(() => workItemAri(CLOUD, 'HRB-2'), GraphError);
});
