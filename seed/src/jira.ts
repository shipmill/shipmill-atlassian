// Reads and writes the demo project on a Jira site through REST v3

import { paragraphs } from '@shipmill-atlassian/shared/adf';
import type { SeedItem } from './demo';
import { Http, list, record, text } from './http';
import type { ItemState, JiraAction, JiraState } from './plan';

// A project property maps each seed item id to the id of the work item made for it. JQL
// search is eventually consistent, so a second run right after the first could miss new work
// items; a property and work items read by id are not
const MANIFEST = 'shipmill-seed';
const TEMPLATE = 'com.pyxis.greenhopper.jira:gh-simplified-kanban-classic';
// Where the Jira app records what it asked on a work item (jira/src/decision-state.ts)
export const DECISION_PROPERTY = 'shipmill-decision';

export class Jira {
  readonly #http: Http;
  readonly #key: string;
  readonly #name: string;
  #projectId: string | undefined;
  readonly #versionIds = new Map<string, string>();
  // Seed item id to work item id, as the manifest stores it
  readonly #manifest = new Map<string, string>();
  // Seed item id to work item key
  readonly #keys = new Map<string, string>();

  constructor(site: string, email: string, token: string, projectKey: string, projectName: string) {
    this.#http = new Http(`https://${site}/`, email, token);
    this.#key = projectKey;
    this.#name = projectName;
  }

  get keys(): ReadonlyMap<string, string> {
    return this.#keys;
  }

  async read(items: readonly SeedItem[]): Promise<JiraState> {
    const project = await this.#http.find(`rest/api/3/project/${this.#key}`);
    if (project === undefined) {
      return { project: false, versions: new Set(), items: new Map() };
    }
    const fields = record(project, 'project');
    this.#projectId = text(fields.id, 'project id');
    if (fields.name !== this.#name) {
      throw new Error(`project ${this.#key} is named ${JSON.stringify(fields.name)}, not ${JSON.stringify(this.#name)}`);
    }

    const versions = list(await this.#http.get(`rest/api/3/project/${this.#key}/versions`), 'versions');
    for (const version of versions) {
      const fields = record(version, 'version');
      this.#versionIds.set(text(fields.name, 'version name'), text(fields.id, 'version id'));
    }

    const property = await this.#http.find(`rest/api/3/project/${this.#key}/properties/${MANIFEST}`);
    const stored = property === undefined ? {} : record(record(property, 'manifest').value, 'manifest value');
    const found = new Map<string, ItemState>();
    for (const item of items) {
      const id = stored[item.id];
      if (id === undefined) {
        continue;
      }
      // A work item deleted since is made again
      const issue = await this.#http.find(
        `rest/api/3/issue/${text(id, `manifest ${item.id}`)}?fields=labels,fixVersions&properties=${DECISION_PROPERTY}`,
      );
      if (issue === undefined) {
        continue;
      }
      const state = itemState(issue);
      this.#manifest.set(item.id, text(id, 'work item id'));
      this.#keys.set(item.id, state.key);
      found.set(item.id, state);
    }
    return { project: true, versions: new Set(this.#versionIds.keys()), items: found };
  }

  async apply(action: JiraAction, version: string): Promise<void> {
    switch (action.kind) {
      case 'create-project':
        return this.#createProject();
      case 'create-version':
        return this.#createVersion(action.name);
      case 'create-item':
        return this.#createItem(action.item, version);
      case 'reset-fields':
        await this.#http.send(
          'PUT',
          `rest/api/3/issue/${action.key}`,
          { fields: { labels: [...action.labels], fixVersions: [{ id: this.#versionId(version) }] } },
          [204],
        );
        return;
      case 'clear-question':
        await this.#http.delete(`rest/api/3/issue/${action.key}/properties/${DECISION_PROPERTY}`, [204]);
        return;
    }
  }

  async #createProject(): Promise<void> {
    const myself = record(await this.#http.get('rest/api/3/myself'), 'myself');
    const created = await this.#http.send(
      'POST',
      'rest/api/3/project',
      {
        key: this.#key,
        name: this.#name,
        projectTypeKey: 'software',
        projectTemplateKey: TEMPLATE,
        leadAccountId: text(myself.accountId, 'account id'),
        assigneeType: 'UNASSIGNED',
        description: 'Demo release for shipmill Release Decisions, made by the seed script',
      },
      [201],
    );
    this.#projectId = String(record(created, 'created project').id);
  }

  async #createVersion(name: string): Promise<void> {
    const created = await this.#http.send(
      'POST',
      'rest/api/3/version',
      { name, projectId: Number(this.#requireProject()), description: `${this.#name} ${name}` },
      [201],
    );
    this.#versionIds.set(name, text(record(created, 'created version').id, 'version id'));
  }

  async #createItem(item: SeedItem, version: string): Promise<void> {
    const versionId = this.#versionId(version);
    const created = record(
      await this.#http.send(
        'POST',
        'rest/api/3/issue',
        {
          fields: {
            project: { id: this.#requireProject() },
            issuetype: { name: item.type },
            summary: item.summary,
            description: paragraphs([item.description]),
            labels: [...item.labels],
            fixVersions: [{ id: versionId }],
          },
        },
        [201],
      ),
      'created work item',
    );
    const id = text(created.id, 'work item id');
    this.#keys.set(item.id, text(created.key, 'work item key'));
    this.#manifest.set(item.id, id);
    // Written after every work item, so a run that stops halfway leaves no orphan behind
    await this.#http.send(
      'PUT',
      `rest/api/3/project/${this.#key}/properties/${MANIFEST}`,
      Object.fromEntries(this.#manifest),
      [200, 201],
    );
  }

  #versionId(version: string): string {
    const id = this.#versionIds.get(version);
    if (id === undefined) {
      throw new Error(`fix version ${version} does not exist`);
    }
    return id;
  }

  #requireProject(): string {
    if (this.#projectId === undefined) {
      throw new Error(`project ${this.#key} does not exist`);
    }
    return this.#projectId;
  }
}

// A work item as GET issue returns it with labels, fix versions and the decision property
export function itemState(issue: unknown): ItemState {
  const body = record(issue, 'work item');
  const key = text(body.key, 'work item key');
  const fields = record(body.fields, `${key} fields`);
  const properties = body.properties === undefined ? {} : record(body.properties, `${key} properties`);
  return {
    key,
    labels: list(fields.labels, `${key} labels`).map((label) => text(label, `${key} label`)),
    fixVersions: list(fields.fixVersions, `${key} fix versions`).map((version) =>
      text(record(version, `${key} fix version`).name, `${key} fix version name`),
    ),
    asked: DECISION_PROPERTY in properties,
  };
}
