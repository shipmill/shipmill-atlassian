import type { Account, BitbucketRest, BitbucketWrites, BuildStatus, PullRequest, PullRequestComment, Task } from './bitbucket-rest';
import type { PullRequestQuestion, PullRequestRef, QuestionStore } from './question-store';
import { parsePullRequestQuestion, storageKey } from './question-store';

// An in-memory Bitbucket repository and question store for the pull request decision tests.
// Tests only; the app never imports this.

export const APP: Account = { accountId: 'app:shipmill', displayName: 'shipmill Release Decisions' };
export const REPOSITORY = '{6e4f1d2a-9c3b-4f5e-8a7d-1b2c3d4e5f60}';

export class FakeRepository implements BitbucketRest, BitbucketWrites {
  readonly comments = new Map<number, PullRequestComment & { pullRequest: number }>();
  readonly taskById = new Map<number, Task & { pullRequest: number; comment: number }>();
  readonly pullRequests = new Map<number, PullRequest>();
  #next = 500;

  constructor(...pullRequests: PullRequest[]) {
    for (const pullRequest of pullRequests) this.pullRequests.set(pullRequest.id, pullRequest);
  }

  async pullRequest(id: number): Promise<PullRequest> {
    const found = this.pullRequests.get(id);
    if (found === undefined) throw new Error(`no pull request ${id}`);
    return found;
  }

  async statuses(_commit: string): Promise<BuildStatus[]> {
    return [{ key: 'pipelines', name: 'Pipeline #7', state: 'SUCCESSFUL' }];
  }

  async tasks(pullRequest: number): Promise<Task[]> {
    return [...this.taskById.values()].filter((task) => task.pullRequest === pullRequest).map(({ id, state, text }) => ({ id, state, text }));
  }

  async file(_commit: string, _path: string): Promise<string | undefined> {
    return undefined;
  }

  async comment(pullRequest: number, id: number): Promise<PullRequestComment> {
    const found = this.comments.get(id);
    if (found === undefined || found.pullRequest !== pullRequest) throw new Error(`no comment ${id} on pull request ${pullRequest}`);
    return { id: found.id, author: found.author, text: found.text };
  }

  async postComment(pullRequest: number, markdown: string): Promise<number> {
    return this.reply(pullRequest, APP, markdown);
  }

  async createTask(pullRequest: number, text: string, comment: number): Promise<number> {
    if (this.comments.get(comment)?.pullRequest !== pullRequest) throw new Error(`no comment ${comment} on pull request ${pullRequest}`);
    const id = this.#next++;
    this.taskById.set(id, { id, state: 'UNRESOLVED', text, pullRequest, comment });
    return id;
  }

  async resolveTask(pullRequest: number, task: number): Promise<void> {
    const found = this.taskById.get(task);
    if (found === undefined || found.pullRequest !== pullRequest) throw new Error(`no task ${task} on pull request ${pullRequest}`);
    this.taskById.set(task, { ...found, state: 'RESOLVED' });
  }

  // A comment by a person, numbered as Bitbucket would
  reply(pullRequest: number, author: Account, text: string): number {
    const id = this.#next++;
    this.comments.set(id, { id, author, text, pullRequest });
    return id;
  }

  posted(pullRequest: number): string[] {
    return [...this.comments.values()].filter((entry) => entry.pullRequest === pullRequest && entry.author === APP).map((entry) => entry.text);
  }
}

export class FakeQuestions implements QuestionStore {
  readonly values = new Map<string, unknown>();

  async get(pullRequest: PullRequestRef): Promise<PullRequestQuestion | undefined> {
    const key = storageKey(pullRequest);
    const stored = this.values.get(key);
    return stored === undefined ? undefined : parsePullRequestQuestion(stored, key);
  }

  async swap(pullRequest: PullRequestRef, question: PullRequestQuestion): Promise<PullRequestQuestion | undefined> {
    // One step, as KVS does it: nothing can run between the read and the write
    const key = storageKey(pullRequest);
    const stored = this.values.get(key);
    this.values.set(key, JSON.parse(JSON.stringify(question)));
    return stored === undefined ? undefined : parsePullRequestQuestion(stored, key);
  }

  async set(pullRequest: PullRequestRef, question: PullRequestQuestion): Promise<void> {
    // Round-trip through JSON, as KVS does
    this.values.set(storageKey(pullRequest), JSON.parse(JSON.stringify(question)));
  }
}
