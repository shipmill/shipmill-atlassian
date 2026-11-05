// Reads and writes the demo repository in a Bitbucket workspace through REST 2.0

import { Http, list, record, text } from './http';
import type { BitbucketAction, BitbucketState } from './plan';

const PULL_REQUEST_STATES = ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'];
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
      return { repository: false, mainFiles: new Set(), branches: new Set(), pullRequestBranches: new Set() };
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
    const pullRequestBranches = new Set(
      pullRequests.map((pr) =>
        text(record(record(record(pr, 'pull request').source, 'source').branch, 'source branch').name, 'source branch name'),
      ),
    );
    return { repository: true, mainFiles: present, branches, pullRequestBranches };
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
      case 'create-pull-request':
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
        );
        return;
    }
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
