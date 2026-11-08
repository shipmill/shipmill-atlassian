import { kvs } from '@forge/kvs';
import { jiraKey, type JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { natural, nonEmpty, object, oneOf } from '@shipmill-atlassian/shared/parse';
import { commentId, parsePerson, timestamp, type CommentId, type Person } from '@shipmill-atlassian/shared/release';

// The question shipmill asked on a pull request, one KVS value per pull request. It stands
// in for the protocol's hidden marker line, which a Bitbucket comment can't carry: it names
// the comment that asked, the task that holds the merge, and the Jira question they repeat.

export type PullRequestQuestion = {
  // asking: claimed by one invocation, which posts the comment and the task next
  // relaying: likewise, for the relay comment and resolving the task
  status: 'asking' | 'waiting' | 'relaying' | 'decided';
  key: JiraKey;
  questionId: CommentId;
  decider: Person;
  // How many options the question numbers, for the note when a reply names none
  options: number;
  // The Bitbucket comment and task; 0 while asking
  commentId: number;
  taskId: number;
  at: string;
};

export type PullRequestRef = { repository: string; id: number };

export interface QuestionStore {
  get(pullRequest: PullRequestRef): Promise<PullRequestQuestion | undefined>;
  // Writes the question and gives the one it replaced, in one step, so of two invocations
  // asking at once only the one that saw nothing there goes on
  swap(pullRequest: PullRequestRef, question: PullRequestQuestion): Promise<PullRequestQuestion | undefined>;
  set(pullRequest: PullRequestRef, question: PullRequestQuestion): Promise<void>;
}

export function parsePullRequestQuestion(value: unknown, path: string): PullRequestQuestion {
  const fields = object(value, path);
  return {
    status: oneOf(fields.status, `${path}.status`, ['asking', 'waiting', 'relaying', 'decided'] as const),
    key: jiraKey(nonEmpty(fields.key, `${path}.key`)),
    questionId: commentId(nonEmpty(fields.questionId, `${path}.questionId`)),
    decider: parsePerson(fields.decider, `${path}.decider`),
    options: natural(fields.options, `${path}.options`),
    commentId: natural(fields.commentId, `${path}.commentId`),
    taskId: natural(fields.taskId, `${path}.taskId`),
    at: timestamp(fields.at, `${path}.at`),
  };
}

// KVS keys allow letters, digits and ":._-#", so the repository uuid loses its braces; Forge
// gives it with them in events and may give it bare in a module's context
export function storageKey({ repository, id }: PullRequestRef): string {
  const uuid = /^\{?([0-9a-f-]{36})\}?$/i.exec(repository)?.[1]?.toLowerCase();
  if (uuid === undefined) throw new Error(`not a repository uuid: ${JSON.stringify(repository)}`);
  return `question:${uuid}:${id}`;
}

export const kvsQuestions: QuestionStore = {
  async get(pullRequest) {
    const key = storageKey(pullRequest);
    const stored = await kvs.get<unknown>(key);
    return stored === undefined ? undefined : parsePullRequestQuestion(stored, key);
  },
  async swap(pullRequest, question) {
    const key = storageKey(pullRequest);
    const previous = await kvs.set<PullRequestQuestion, unknown>(key, question, { keyPolicy: 'OVERRIDE', returnValue: 'PREVIOUS' });
    return previous === undefined ? undefined : parsePullRequestQuestion(previous.value, key);
  },
  async set(pullRequest, question) {
    await kvs.set(storageKey(pullRequest), question);
  },
};
