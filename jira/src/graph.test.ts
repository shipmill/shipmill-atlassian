import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { jiraKey } from '@shipmill-atlassian/shared/jira-key';
import { ParseError } from '@shipmill-atlassian/shared/parse';
import type { Release } from '@shipmill-atlassian/shared/release';
import { askDecisions } from './ask';
import { queuedText } from './ask-queued';
import { frameText } from './comment';
import { FakeJira } from './fake-jira';
import { seedRelease } from './fixtures';
import { findDecisions, type Decision } from './finder';
import {
  GRAPH_QUERIES,
  GraphError,
  carriedGraph,
  parseGraphLookups,
  preparerGraph,
  readGraphEvidence,
  siteCloudId,
  siteGraph,
  unavailableGraph,
  workItemAri,
  type GraphLookups,
  type TeamworkGraph,
} from './graph';
import { graphForAsk, graphFound } from './panel-ask';
import type { IssueRest } from './jira-rest';
import { templatePreparer, withGraph } from './prepare';

// Graph responses in the shape the Teamwork Graph documents for its curated queries, for the
// seed's HRB-2 (issue id 10002). An item or object type with no file answers an empty
// connection, as a scope the admin did not grant does.

const CLOUD = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
const NOW = () => new Date('2026-12-03T09:00:00.000Z');
const DIRECTORY = new URL('./fixtures/graph/', import.meta.url);

function load(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, DIRECTORY), 'utf8'));
}

// The curated field each query reads, and the fixture name of what it returns
const FIELD_FILES: [string, string][] = [
  ['jiraWorkItemLinkedExternalPullRequests', 'pull-requests'],
  ['jiraWorkItemLinkedExternalDeployments', 'deployments'],
];

class RecordedGraph implements TeamworkGraph {
  readonly calls: { query: string; id: string }[] = [];

  constructor(
    readonly recorded: Map<string, string>,
    readonly answer: (file: string | undefined, field: string) => unknown = (file, field) =>
      file === undefined ? { data: { [field]: { edges: [] } } } : load(file),
  ) {}

  async request(query: string, variables: Record<string, unknown>): Promise<unknown> {
    assert.deepEqual(Object.keys(variables), ['id']);
    const id = variables.id as string;
    this.calls.push({ query, id });
    const found = FIELD_FILES.find(([field]) => query.includes(`${field}(id: $id, first: 10)`));
    if (found === undefined) throw new Error(`no recorded field in ${query}`);
    const item = this.recorded.get(id);
    return this.answer(item === undefined ? undefined : `${item}-${found[1]}.json`, found[0]);
  }
}

// The teams have no curated query, so every read item logs why they were not read
const TEAMS_UNREAD = (key: string): string =>
  `graph ${key}: teams not read, the Teamwork Graph has no curated query from a work item to its teams, and no persisted query is registered for the app`;

// HRB-2 has every file; HRB-3 and HRB-4 none
const SEED_GRAPH = new Map([[workItemAri(CLOUD, '10002'), 'HRB-2']]);

const ISSUE_IDS: IssueRest = {
  async issue(key) {
    // HRB-2 is 10002, as on the seed
    return { id: String(10000 + Number(key.split('-')[1])), key };
  },
};

async function seedDecisions(): Promise<{ release: Release; decisions: Decision[] }> {
  const release = await seedRelease();
  return { release, decisions: await findDecisions(release, { llm: false, implicit: { find: async () => [] } }) };
}

test('the graph reads pull requests and deployments for a work item, each through its own curated query', async () => {
  const graph = new RecordedGraph(SEED_GRAPH);
  const evidence = await readGraphEvidence(graph, workItemAri(CLOUD, '10002'));
  assert.deepEqual(evidence, {
    pullRequests: [{ title: 'HRB-2 Rejects API v1 tokens with a pointer to the migration guide', url: 'https://bitbucket.org/shipmill-dev/harbor/pull-requests/2', status: 'OPEN' }],
    deployments: [{ name: 'harbor #41', environment: 'Staging', url: 'https://bitbucket.org/shipmill-dev/harbor/deployments/41', state: 'SUCCESSFUL' }],
    teams: [],
  });
  assert.deepEqual(graph.calls.map((call) => call.query).sort(), Object.values(GRAPH_QUERIES).sort());
  assert.ok(graph.calls.every((call) => call.id === `ari:cloud:jira:${CLOUD}:issue/10002`));
  assert.ok(graph.calls.every((call) => !call.query.includes('cypherQuery')), 'the graph refuses Cypher text from the app');
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
      'deployment harbor #41 to Staging (successful, https://bitbucket.org/shipmill-dev/harbor/deployments/41)',
  );
  assert.deepEqual(lines, [TEAMS_UNREAD('HRB-2')]);
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
    TEAMS_UNREAD('HRB-3'),
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
  const odd = new RecordedGraph(SEED_GRAPH, (_file, field) => ({ data: { [field]: { edges: [{ node: { __typename: 'JiraWorkItem', key: 'HRB-2' } }] } } }));
  await assert.rejects(readGraphEvidence(odd, workItemAri(CLOUD, '10002')), ParseError);
  const refused = new RecordedGraph(SEED_GRAPH, (_file, field) => ({ data: { [field]: null } }));
  await assert.rejects(readGraphEvidence(refused, workItemAri(CLOUD, '10002')), ParseError);
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

// "Ask decisions" on the release panel: the resolver reads the graph as the user, and the
// prepare consumer, which runs for no user, cites what came in the queue event

async function carriedThroughQueue(lookups: GraphLookups): Promise<GraphLookups> {
  // The event body is JSON on the queue
  return parseGraphLookups(JSON.parse(JSON.stringify(lookups)), 'graph');
}

test('the panel reads the graph for the labelled items not asked yet, and for every item with the LLM on', async () => {
  const release = await seedRelease();
  const graph = new RecordedGraph(SEED_GRAPH);
  const lookups = await graphForAsk(release, false, new FakeJira(), siteGraph(graph, ISSUE_IDS, CLOUD));
  assert.deepEqual(Object.keys(lookups).sort(), ['HRB-2', 'HRB-3']);
  assert.deepEqual(graphFound(lookups), ['HRB-2']);

  const jira = new FakeJira();
  const { decisions } = await seedDecisions();
  await askDecisions(release, decisions.filter((decision) => decision.key === 'HRB-2'), { jira, preparer: templatePreparer, now: NOW });
  const afterAsked = await graphForAsk(release, false, jira, siteGraph(new RecordedGraph(SEED_GRAPH), ISSUE_IDS, CLOUD));
  assert.deepEqual(Object.keys(afterAsked), ['HRB-3'], 'HRB-2 waits on an answer, so it is not asked again');

  const withLlm = await graphForAsk(release, true, new FakeJira(), siteGraph(new RecordedGraph(SEED_GRAPH), ISSUE_IDS, CLOUD));
  assert.deepEqual(Object.keys(withLlm).sort(), release.items.map((item) => item.key).sort());
});

test('the graph the panel read reaches the comment through the queue, with no user on the consumer', async () => {
  const { release, decisions } = await seedDecisions();
  const lookups = await graphForAsk(release, false, new FakeJira(), siteGraph(new RecordedGraph(SEED_GRAPH), ISSUE_IDS, CLOUD));
  const carried = await carriedThroughQueue(lookups);
  assert.deepEqual(carried, lookups);

  const direct = new FakeJira();
  await askDecisions(release, decisions, { jira: direct, preparer: withGraph(templatePreparer, siteGraph(new RecordedGraph(SEED_GRAPH), ISSUE_IDS, CLOUD), () => {}), now: NOW });
  const queued = new FakeJira();
  const lines: string[] = [];
  const graph = preparerGraph({ installContext: `ari:cloud:jira::site/${CLOUD}` }, carried);
  await askDecisions(release, decisions, { jira: queued, preparer: withGraph(templatePreparer, graph, (line) => lines.push(line)), now: NOW });
  for (const key of [jiraKey('HRB-2'), jiraKey('HRB-3')]) assert.deepEqual(queued.posted(key).map((entry) => entry.text), direct.posted(key).map((entry) => entry.text));
  assert.match(queued.posted(jiraKey('HRB-2'))[0]!.text, /in the Teamwork Graph, pull request "HRB-2 Rejects API v1 tokens/);
  assert.ok(lines.filter((line) => line !== TEAMS_UNREAD('HRB-2')).every((line) => line.startsWith('graph HRB-3: ')), 'only HRB-3 has empty lists to explain');
});

test('without graph scopes or results, the comment from the panel is unchanged and the log says why', async () => {
  const { release, decisions } = await seedDecisions();
  // A scope the admin did not grant empties every query
  const lookups = await carriedThroughQueue(await graphForAsk(release, false, new FakeJira(), siteGraph(new RecordedGraph(new Map()), ISSUE_IDS, CLOUD)));
  assert.deepEqual(graphFound(lookups), []);
  const plain = new FakeJira();
  await askDecisions(release, decisions, { jira: plain, preparer: templatePreparer, now: NOW });
  const queued = new FakeJira();
  const lines: string[] = [];
  await askDecisions(release, decisions, { jira: queued, preparer: withGraph(templatePreparer, carriedGraph(lookups), (line) => lines.push(line)), now: NOW });
  for (const key of [jiraKey('HRB-2'), jiraKey('HRB-3')]) assert.deepEqual(queued.posted(key).map((entry) => entry.text), plain.posted(key).map((entry) => entry.text));
  assert.ok(lines.includes('graph HRB-2: no deployments; either none is linked or read:graph:issue:jira, read:graph:deployment:external is not granted'));

  const unread = await carriedGraph({}).lookup(jiraKey('HRB-2'));
  assert.equal(unread.status, 'unavailable');
  const noUser = await graphForAsk(release, false, new FakeJira(), unavailableGraph('the panel was opened by no user'));
  assert.deepEqual(await carriedGraph(await carriedThroughQueue(noUser)).lookup(jiraKey('HRB-2')), { status: 'unavailable', reason: 'the panel was opened by no user' });
});

test('a malformed graph in the queue event fails the prepare', () => {
  assert.throws(() => parseGraphLookups([], 'graph'), ParseError);
  assert.throws(() => parseGraphLookups({ 'HRB-2': { status: 'read', evidence: { pullRequests: [], deployments: [], teams: [] }, empty: ['commits'] } }, 'graph'), ParseError);
  assert.throws(() => parseGraphLookups({ 'HRB-2': { status: 'read', evidence: { pullRequests: [{ title: 't', url: 'u', status: 'open' }], deployments: [], teams: [] }, empty: [] } }, 'graph'), ParseError);
  assert.throws(() => parseGraphLookups({ 'HRB-2': { status: 'unavailable', reason: '' } }, 'graph'), ParseError);
});

test('the panel says there was nothing new to ask when the graph was read for no item, not that it had no evidence', () => {
  assert.equal(queuedText({ version: '2.4', asked: [], graphRead: [] }), 'Nothing new to ask in 2.4: every open decision already waits on an answer.');
  assert.match(queuedText({ version: '2.4', asked: ['HRB-21'], graphRead: [] }), /The Teamwork Graph had no evidence to cite\.$/);
  assert.match(queuedText({ version: '2.4', asked: ['HRB-2', 'HRB-3'], graphRead: ['HRB-2'] }), /The comments cite the Teamwork Graph on HRB-2\.$/);
});
