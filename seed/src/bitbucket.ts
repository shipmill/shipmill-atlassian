// Reads and writes the demo repository in a Bitbucket workspace through REST 2.0

import { Http, list, record, text } from './http';
import type { BitbucketAction, BitbucketState, PullRequestState, TaskState } from './plan';

const PULL_REQUEST_STATES = ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'] as const;
const AUTHOR = 'shipmill seed <seed@shipmill.invalid>';

export class Bitbucket {
  readonly #http: Http;
  readonly #repo: string;
  #main = 'main';

  constructor(workspace: string, email: string, token: string, repository: string) {
    this.#http = new Http('https://api.bitbucket.org/2.0/', email, token);
    this.#repo = `repositories/${workspace}/${repository}`;
  }

  async read(mainFiles: ReadonlyMap<string, string>): Promise<BitbucketState> {
    const repository = await this.#http.find(this.#repo);
    if (repository === undefined) {
      return { repository: false, mainFiles: new Set(), branches: new Set(), pullRequests: new Map() };
    }
    this.#readMain(repository);

    const branches = new Set(
      (await this.#pages(`${this.#repo}/refs/branches?pagelen=100`)).map((branch) =>
        text(record(branch, 'branch').name, 'branch name'),
      ),
    );
    const present = new Set<string>();
    if (branches.has(this.#main)) {
      for (const path of mainFiles.keys()) {
        if ((await this.#http.find(`${this.#repo}/src/${this.#main}/${path}?format=meta`)) !== undefined) {
          present.add(path);
        }
      }
    }
    const states = PULL_REQUEST_STATES.map((state) => `state=${state}`).join('&');
    const pullRequests = await this.#pages(`${this.#repo}/pullrequests?${states}&pagelen=50`);
    const byBranch = new Map<string, PullRequestState[]>();
    for (const value of pullRequests) {
      const pr = record(value, 'pull request');
      const branch = text(record(record(pr.source, 'source').branch, 'source branch').name, 'source branch name');
      const id = pr.id;
      if (typeof id !== 'number') {
        throw new Error(`pull request on ${branch} has no numeric id`);
      }
      const state = pullRequestState(pr.state, id);
      // Tasks matter only while a pull request is open
      const tasks = state === 'OPEN' ? (await this.#pages(`${this.#repo}/pullrequests/${id}/tasks?pagelen=100`)).map(taskState) : [];
      byBranch.set(branch, [...(byBranch.get(branch) ?? []), { id, state, tasks }]);
    }
    return { repository: true, mainFiles: present, branches, pullRequests: byBranch };
  }

  async apply(action: BitbucketAction): Promise<void> {
    switch (action.kind) {
      case 'create-repository': {
        const created = await this.#http.send(
          'POST',
          this.#repo,
          { scm: 'git', is_private: true, description: 'Demo repository for shipmill Release Decisions' },
          [200, 201],
        );
        this.#readMain(created);
        return;
      }
      case 'commit-main':
        return this.#commit(this.#main, action.files, 'Add the release policy', await this.#head(false));
      case 'create-branch': {
        const files = new Map([[action.spec.path, action.spec.content]]);
        return this.#commit(action.spec.branch, files, action.spec.title, await this.#head(true));
      }
      case 'create-pull-request': {
        const created = record(
          await this.#http.send(
            'POST',
            `${this.#repo}/pullrequests`,
            {
              title: action.spec.title,
              description: action.spec.description,
              source: { branch: { name: action.spec.branch } },
              destination: { branch: { name: this.#main } },
            },
            [201],
          ),
          'created pull request',
        );
        if (typeof created.id !== 'number') {
          throw new Error(`the pull request for ${action.spec.branch} came back without a numeric id`);
        }
        if (action.spec.task !== undefined) {
          await this.#openTask(created.id, action.spec.task);
        }
        return;
      }
      case 'open-task':
        return this.#openTask(action.pullRequest, action.text);
      case 'reopen-task':
        return this.#taskState(action.pullRequest, action.task, 'UNRESOLVED');
      case 'resolve-task':
        return this.#taskState(action.pullRequest, action.task, 'RESOLVED');
      case 'merged':
        return;
    }
  }

  async #openTask(pullRequest: number, raw: string): Promise<void> {
    await this.#http.send('POST', `${this.#repo}/pullrequests/${pullRequest}/tasks`, { content: { raw } }, [201]);
  }

  async #taskState(pullRequest: number, task: number, state: 'RESOLVED' | 'UNRESOLVED'): Promise<void> {
    await this.#http.send('PUT', `${this.#repo}/pullrequests/${pullRequest}/tasks/${task}`, { state }, [200]);
  }

  // An empty repository may name no main branch yet; its first commit makes "main"
  #readMain(repository: unknown): void {
    const main = record(repository, 'repository').mainbranch;
    if (main !== undefined && main !== null) {
      this.#main = text(record(main, 'main branch').name, 'main branch name');
    }
  }

  async #head(required: boolean): Promise<string | undefined> {
    const branch = await this.#http.find(`${this.#repo}/refs/branches/${encodeURIComponent(this.#main)}`);
    if (branch === undefined) {
      if (required) {
        throw new Error(`${this.#repo} has no ${this.#main} branch to branch from`);
      }
      return undefined;
    }
    return text(record(record(branch, 'branch').target, 'branch target').hash, 'commit hash');
  }

  async #commit(branch: string, files: ReadonlyMap<string, string>, message: string, parent: string | undefined): Promise<void> {
    const form = new FormData();
    form.append('branch', branch);
    form.append('message', message);
    form.append('author', AUTHOR);
    if (parent !== undefined) {
      form.append('parents', parent);
    }
    for (const [path, content] of files) {
      form.append(path, content);
    }
    await this.#http.sendForm(`${this.#repo}/src`, form, [201]);
  }

  async #pages(first: string): Promise<unknown[]> {
    const values: unknown[] = [];
    let next: string | undefined = first;
    while (next !== undefined) {
      const page = record(await this.#http.get(next), 'page');
      values.push(...list(page.values, 'page values'));
      next = page.next === undefined ? undefined : text(page.next, 'next page');
    }
    return values;
  }
}

function pullRequestState(value: unknown, id: number): PullRequestState['state'] {
  const state = PULL_REQUEST_STATES.find((known) => known === value);
  if (state === undefined) {
    throw new Error(`pull request #${id} has an unknown state ${JSON.stringify(value)}`);
  }
  return state;
}

// A pull request task as Bitbucket returns it
export function taskState(value: unknown): TaskState {
  const task = record(value, 'task');
  if (typeof task.id !== 'number') {
    throw new Error('a task has no numeric id');
  }
  if (task.state !== 'RESOLVED' && task.state !== 'UNRESOLVED') {
    throw new Error(`task ${task.id} has an unknown state ${JSON.stringify(task.state)}`);
  }
  const raw = record(task.content, `task ${task.id} content`).raw;
  if (typeof raw !== 'string') {
    throw new Error(`task ${task.id} has no text`);
  }
  return { id: task.id, text: raw, resolved: task.state === 'RESOLVED' };
}
