import { readFileSync } from 'node:fs';
import { jiraKey, projectKey, type JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { parseLinkedPullRequests, type LinkedPullRequest } from '@shipmill-atlassian/shared/pull-requests';
import type { JiraRest, SearchRequest } from './jira-rest';
import { readRelease, type PullRequestLookup } from './reader';
import type { Release } from '@shipmill-atlassian/shared/release';

// Recorded Jira responses for the demo release the seed (issue #1) makes: project HRB, fix
// version 2.4, 20 work items, HRB-2 and HRB-3 labelled needs-decision, and HRB-4 with a
// question in a comment nobody answered. Tests only; the app never imports this.

const DIRECTORY = new URL('./fixtures/release-2.4/', import.meta.url);

export const SEED_PROJECT = projectKey('HRB');
export const SEED_VERSION = '2.4';

function load(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, DIRECTORY), 'utf8'));
}

// Replays the two search pages in order and records every call it gets
export class RecordedJira implements JiraRest {
  readonly searches: SearchRequest[] = [];
  readonly commentCalls: { key: JiraKey; startAt: number }[] = [];
  readonly #pages = [load('search-page-1.json'), load('search-page-2.json')];
  readonly #comments: Map<JiraKey, unknown[]>;

  constructor(comments = new Map<JiraKey, unknown[]>()) {
    this.#comments = comments;
  }

  async search(request: SearchRequest): Promise<unknown> {
    const page = this.#pages[this.searches.length];
    if (page === undefined) throw new Error(`no recorded search page ${this.searches.length}`);
    this.searches.push(request);
    return page;
  }

  async comments(key: JiraKey, startAt: number): Promise<unknown> {
    this.commentCalls.push({ key, startAt });
    const pages = this.#comments.get(key);
    const page = pages?.[this.commentCalls.filter((call) => call.key === key).length - 1];
    if (page === undefined) throw new Error(`no recorded comment page for ${key} at ${startAt}`);
    return page;
  }
}

export class RecordedPullRequests implements PullRequestLookup {
  readonly #byKey: Map<string, LinkedPullRequest[]>;

  constructor() {
    const raw = load('pull-requests.json') as Record<string, unknown>;
    this.#byKey = new Map(Object.entries(raw).map(([key, value]) => [jiraKey(key), parseLinkedPullRequests(value, key)]));
  }

  async forItem(key: JiraKey): Promise<LinkedPullRequest[]> {
    return this.#byKey.get(key) ?? [];
  }
}

export async function seedRelease(): Promise<Release> {
  return readRelease(new RecordedJira(), new RecordedPullRequests(), SEED_PROJECT, SEED_VERSION);
}
