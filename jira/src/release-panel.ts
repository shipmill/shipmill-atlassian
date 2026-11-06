import type { JiraKey, ProjectKey } from '@shipmill-atlassian/shared/jira-key';
import { boolean, list, nonEmpty, object } from '@shipmill-atlassian/shared/parse';
import type { LinkedPullRequest } from '@shipmill-atlassian/shared/pull-requests';
import type { Person, Release } from '@shipmill-atlassian/shared/release';
import type { DecisionJira } from './decision-jira';
import { labelledDecisions } from './finder';

// The release panel: what a fix version still waits on, oldest first, and who each decision
// waits on. A decision blocks while its work item is labelled needs-decision, as the merge
// check counts it, so the panel never calls the LLM and answers inside a resolver's 25 s. What
// shipmill asked (the question, the person asked, when) comes from the item's
// shipmill-decision property; the answer can come from Jira or from a pull request in
// Bitbucket, so the panel names the item's pull requests as the other place to answer.

export type PanelDecision = {
  key: JiraKey;
  summary: string;
  question: string;
  waitsOn: Person;
  // When shipmill asked; null while the item is labelled but not asked yet
  askedAt: string | null;
  pullRequests: LinkedPullRequest[];
};

export type ReleasePanel = {
  project: ProjectKey;
  version: string;
  decisions: PanelDecision[];
  ready: boolean;
};

export async function releasePanel(release: Release, jira: Pick<DecisionJira, 'state' | 'projectLead'>): Promise<ReleasePanel> {
  let lead: Person | undefined;
  const asked: (PanelDecision & { askedAt: string })[] = [];
  const unasked: PanelDecision[] = [];
  for (const decision of labelledDecisions(release.items)) {
    const item = release.items.find((candidate) => candidate.key === decision.key);
    if (item === undefined) throw new Error(`${decision.key} is not in ${release.project} ${release.version}`);
    const base = { key: item.key, summary: item.summary, pullRequests: item.pullRequests };
    const state = await jira.state(item.key);
    if (state?.status === 'waiting') {
      asked.push({ ...base, question: state.question, waitsOn: state.decider, askedAt: state.askedAt });
      continue;
    }
    // Labelled but not asked, or labelled again after an answer: the finder's question, and
    // the person shipmill will ask, the project lead when nobody is on the item
    const waitsOn = decision.askOf ?? (lead ??= await jira.projectLead(release.project));
    unasked.push({ ...base, question: decision.question, waitsOn, askedAt: null });
  }
  // Oldest first; ISO timestamps from the same clock sort as text. A decision not asked yet
  // is the newest, so it comes last, in key order
  asked.sort((a, b) => (a.askedAt < b.askedAt ? -1 : a.askedAt > b.askedAt ? 1 : 0));
  const decisions = [...asked, ...unasked];
  return { project: release.project, version: release.version, decisions, ready: decisions.length === 0 };
}

// A project's fix versions, for the panel's picker. Jira lists them in the order the project
// arranges them; the panel opens on the first that is neither released nor archived.

export type FixVersion = { name: string; released: boolean; archived: boolean };

export function parseFixVersions(value: unknown, path: string): FixVersion[] {
  return list(value, path, (entry, at) => {
    const fields = object(entry, at);
    return {
      name: nonEmpty(fields.name, `${at}.name`),
      released: boolean(fields.released, `${at}.released`),
      archived: boolean(fields.archived, `${at}.archived`),
    };
  });
}

export function openVersions(versions: readonly FixVersion[]): string[] {
  return versions.filter((version) => !version.released && !version.archived).map((version) => version.name);
}
