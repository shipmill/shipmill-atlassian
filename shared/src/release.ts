import { jiraKey, projectKey, type JiraKey, type ProjectKey } from './jira-key';
import { ParseError, list, nonEmpty, object, oneOf, string, type Fields } from './parse';
import { parseLinkedPullRequests, type LinkedPullRequest } from './pull-requests';

// A release as the apps read it: a Jira fix version and its work items, each with what a
// person needs to see whether a decision blocks it

export type CommentId = string & { readonly __brand: 'CommentId' };

export function commentId(text: string): CommentId {
  if (!/^\d+$/.test(text)) throw new Error(`not a Jira comment id: ${JSON.stringify(text)}`);
  return text as CommentId;
}

export type Person = { accountId: string; displayName: string };

export type Comment = { id: CommentId; author: Person; created: string; text: string };

// Jira's status categories by key: to do, in progress, done
export const STATUS_CATEGORIES = ['new', 'indeterminate', 'done'] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

// A link as the item shows it: "is blocked by KAN-3", "relates to KAN-9"
export type IssueLink = { relation: string; key: JiraKey; summary: string; statusCategory: StatusCategory };

export type WorkItem = {
  key: JiraKey;
  summary: string;
  description: string;
  status: string;
  statusCategory: StatusCategory;
  labels: string[];
  owner: Person | null;
  reporter: Person | null;
  comments: Comment[];
  links: IssueLink[];
  pullRequests: LinkedPullRequest[];
};

export type Release = { project: ProjectKey; version: string; items: WorkItem[] };

export const NEEDS_DECISION = 'needs-decision';

// The domain shape back from JSON (eval cases, queue bodies), as strictly as the reader builds it

export function parseRelease(value: unknown, path = 'release'): Release {
  const fields = object(value, path);
  return {
    project: projectKey(nonEmpty(fields.project, `${path}.project`)),
    version: nonEmpty(fields.version, `${path}.version`),
    items: list(fields.items, `${path}.items`, parseWorkItem),
  };
}

function parseWorkItem(value: unknown, path: string): WorkItem {
  const fields = object(value, path);
  return {
    key: jiraKey(nonEmpty(fields.key, `${path}.key`)),
    summary: nonEmpty(fields.summary, `${path}.summary`),
    description: string(fields.description, `${path}.description`),
    status: nonEmpty(fields.status, `${path}.status`),
    statusCategory: oneOf(fields.statusCategory, `${path}.statusCategory`, STATUS_CATEGORIES),
    labels: list(fields.labels, `${path}.labels`, nonEmpty),
    owner: nullablePerson(fields, 'owner', path),
    reporter: nullablePerson(fields, 'reporter', path),
    comments: list(fields.comments, `${path}.comments`, parseComment),
    links: list(fields.links, `${path}.links`, parseLink),
    pullRequests: parseLinkedPullRequests(fields.pullRequests, `${path}.pullRequests`),
  };
}

function nullablePerson(fields: Fields, name: string, path: string): Person | null {
  const value = fields[name];
  return value === null ? null : parsePerson(value, `${path}.${name}`);
}

export function parsePerson(value: unknown, path: string): Person {
  const fields = object(value, path);
  return {
    accountId: nonEmpty(fields.accountId, `${path}.accountId`),
    displayName: nonEmpty(fields.displayName, `${path}.displayName`),
  };
}

function parseComment(value: unknown, path: string): Comment {
  const fields = object(value, path);
  return {
    id: commentId(nonEmpty(fields.id, `${path}.id`)),
    author: parsePerson(fields.author, `${path}.author`),
    created: timestamp(fields.created, `${path}.created`),
    text: string(fields.text, `${path}.text`),
  };
}

function parseLink(value: unknown, path: string): IssueLink {
  const fields = object(value, path);
  return {
    relation: nonEmpty(fields.relation, `${path}.relation`),
    key: jiraKey(nonEmpty(fields.key, `${path}.key`)),
    summary: nonEmpty(fields.summary, `${path}.summary`),
    statusCategory: oneOf(fields.statusCategory, `${path}.statusCategory`, STATUS_CATEGORIES),
  };
}

export function timestamp(value: unknown, path: string): string {
  const text = nonEmpty(value, path);
  if (Number.isNaN(Date.parse(text))) throw new ParseError(path, `not a timestamp: ${JSON.stringify(text)}`);
  return text;
}
