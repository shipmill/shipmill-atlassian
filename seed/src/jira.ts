// Reads and writes the demo project on a Jira site through REST v3

import { paragraphs } from '@shipmill-atlassian/shared/adf';
import { adfText } from './adf-text';
import { PROJECT_NAME, type SeedItem } from './demo';
import { Http, list, record, text } from './http';
import type { JiraAction, JiraState } from './plan';

// A project property maps each seed item id to the id of the work item made for it. JQL
// search is eventually consistent, so a second run right after the first could miss new work
// items; a property and work items read by id are not
const MANIFEST = 'shipmill-seed';
const TEMPLATE = 'com.pyxis.greenhopper.jira:gh-simplified-kanban-classic';

export class Jira {
  readonly #http: Http;
  readonly #key: string;
  #projectId: string | undefined;
  readonly #versionIds = new Map<string, string>();
  // Seed item id to work item id, as the manifest stores it
  readonly #manifest = new Map<string, string>();
  // Seed item id to work item key
  readonly #keys = new Map<string, string>();

  constructor(site: string, email: string, token: string, projectKey: string) {
    this.#http = new Http(`https://${site}/`, email, token);
    this.#key = projectKey;
  }

  get keys(): ReadonlyMap<string, string> {
    return this.#keys;
  }

  async read(items: readonly SeedItem[]): Promise<JiraState> {
    const project = await this.#http.find(`rest/api/3/project/${this.#key}`);
    if (project === undefined) {
      return { project: false, versions: new Set(), items: new Map(), comments: new Map() };
    }
    this.#projectId = text(record(project, 'project').id, 'project id');

    const versions = list(await this.#http.get(`rest/api/3/project/${this.#key}/versions`), 'versions');
    for (const version of versions) {
      const fields = record(version, 'version');
      this.#versionIds.set(text(fields.name, 'version name'), text(fields.id, 'version id'));
    }

    const property = await this.#http.find(`rest/api/3/project/${this.#key}/properties/${MANIFEST}`);
    const stored = property === undefined ? {} : record(record(property, 'manifest').value, 'manifest value');
    const comments = new Map<string, string[]>();
    for (const item of items) {
      const id = stored[item.id];
      if (id === undefined) {
        continue;
      }
      // A work item deleted since is made again
      const issue = await this.#http.find(`rest/api/3/issue/${text(id, `manifest ${item.id}`)}?fields=summary`);
      if (issue === undefined) {
        continue;
      }
      const key = text(record(issue, 'work item').key, 'work item key');
      this.#manifest.set(item.id, text(id, 'work item id'));
      this.#keys.set(item.id, key);
      if (item.comments.length > 0) {
        comments.set(key, await this.#comments(key));
      }
    }
    return { project: true, versions: new Set(this.#versionIds.keys()), items: new Map(this.#keys), comments };
  }

  async apply(action: JiraAction, version: string): Promise<void> {
    switch (action.kind) {
      case 'create-project':
        return this.#createProject();
      case 'create-version':
        return this.#createVersion(action.name);
      case 'create-item':
        return this.#createItem(action.item, version);
      case 'add-comment': {
        const key = this.#keys.get(action.itemId);
        if (key === undefined) {
          throw new Error(`no work item for seed item ${action.itemId}`);
        }
        await this.#http.send('POST', `rest/api/3/issue/${key}/comment`, { body: paragraphs([action.text]) }, [201]);
        return;
      }
    }
  }

  async #createProject(): Promise<void> {
    const myself = record(await this.#http.get('rest/api/3/myself'), 'myself');
    const created = await this.#http.send(
      'POST',
      'rest/api/3/project',
      {
        key: this.#key,
        name: PROJECT_NAME,
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
      { name, projectId: Number(this.#requireProject()), description: `${PROJECT_NAME} ${name}` },
      [201],
    );
    this.#versionIds.set(name, text(record(created, 'created version').id, 'version id'));
  }

  async #createItem(item: SeedItem, version: string): Promise<void> {
    const versionId = this.#versionIds.get(version);
    if (versionId === undefined) {
      throw new Error(`fix version ${version} does not exist`);
    }
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

  async #comments(key: string): Promise<string[]> {
    const page = record(await this.#http.get(`rest/api/3/issue/${key}/comment?maxResults=100`), 'comments');
    const total = page.total;
    const comments = list(page.comments, 'comments');
    if (typeof total !== 'number' || total > comments.length) {
      throw new Error(`${key} has more comments than one page; the seed reads one page`);
    }
    return comments.map((comment) => adfText(record(comment, 'comment').body));
  }

  #requireProject(): string {
    if (this.#projectId === undefined) {
      throw new Error(`project ${this.#key} does not exist`);
    }
    return this.#projectId;
  }
}
