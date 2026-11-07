import type { Release } from '@shipmill-atlassian/shared/release';
import type { DecisionJira } from './decision-jira';
import { labelledDecisions } from './finder';
import { hasGraphEvidence } from './prepare';
import type { GraphLookups, WorkItemGraph } from './graph';

// "Ask decisions" on the release panel: the resolver runs as the user who pressed it, the only
// place the Teamwork Graph answers, so it reads the graph here for the items the prepare may
// ask, and the prepare consumer cites what it read. The items are the labelled ones, and with
// the LLM on every item, since the LLM may find a decision on any of them. An item already
// waiting on an answer is not asked again, so its graph is not read.

export async function graphForAsk(
  release: Release,
  llm: boolean,
  jira: Pick<DecisionJira, 'state'>,
  graph: WorkItemGraph,
): Promise<GraphLookups> {
  const candidates = llm ? release.items.map((item) => item.key) : labelledDecisions(release.items).map((decision) => decision.key);
  const unasked = [];
  for (const key of candidates) if ((await jira.state(key))?.status !== 'waiting') unasked.push(key);
  const lookups = await Promise.all(unasked.map(async (key) => [key, await graph.lookup(key)] as const));
  return Object.fromEntries(lookups);
}

// The items the graph had any evidence on, for the panel to say so
export function graphFound(lookups: GraphLookups): string[] {
  return Object.entries(lookups).flatMap(([key, lookup]) => (lookup.status === 'read' && hasGraphEvidence(lookup.evidence) ? [key] : []));
}
