import { plainText } from '@shipmill-atlassian/shared/adf';
import { jiraKey, type JiraKey, type ProjectKey } from '@shipmill-atlassian/shared/jira-key';
import { list, natural, nonEmpty, object, oneOf, type Fields } from '@shipmill-atlassian/shared/parse';
import type { LinkedPullRequest } from '@shipmill-atlassian/shared/pull-requests';
import {
  STATUS_CATEGORIES,
  commentId,
  parsePerson,
  timestamp,
  type Comment,
  type IssueLink,
  type Person,
  type Release,
  type WorkItem,
} from '@shipmill-atlassian/shared/release';
import type { JiraRest } from './jira-rest';

// The release reader: a fix version to its work items, with their comments, links, owners
// and the pull requests the bridge linked to them

export interface PullRequestLookup {
  forItem(key: JiraKey): Promise<LinkedPullRequest[]>;
}

const FIELDS = ['summary', 'description', 'status', 'labels', 'assignee', 'reporter', 'issuelinks', 'comment'];
const PAGE = 50;
const COMMENT_PAGE = 100;

export function releaseJql(project: ProjectKey, version: string): string {
  return `project = ${quote(project)} AND fixVersion = ${quote(version)} ORDER BY key ASC`;
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export async function readRelease(
  rest: JiraRest,
  pullRequests: PullRequestLookup,
  project: ProjectKey,
  version: string,
): Promise<Release> {
  if (version.trim() === '') throw new Error('a fix version needs a name');
  const jql = releaseJql(project, version);
  const raw: Fields[] = [];
  let nextPageToken: string | undefined;
  for (let page = 0; ; page++) {
    const response = object(
      await rest.search({ jql, fields: FIELDS, maxResults: PAGE, ...(nextPageToken === undefined ? {} : { nextPageToken }) }),
      `search[${page}]`,
    );
    raw.push(...list(response.issues, `search[${page}].issues`, object));
    if (response.isLast === true || response.nextPageToken === undefined) break;
    nextPageToken = nonEmpty(response.nextPageToken, `search[${page}].nextPageToken`);
  }
  const items: WorkItem[] = [];
  for (const [index, issue] of raw.entries()) {
    items.push(await workItem(rest, pullRequests, issue, `issues[${index}]`));
  }
  return { project, version, items };
}

async function workItem(rest: JiraRest, pullRequests: PullRequestLookup, issue: Fields, path: string): Promise<WorkItem> {
  const key = jiraKey(nonEmpty(issue.key, `${path}.key`));
  const at = `${path}(${key})`;
  const fields = object(issue.fields, `${at}.fields`);
  const status = object(fields.status, `${at}.fields.status`);
  return {
    key,
    summary: nonEmpty(fields.summary, `${at}.fields.summary`),
    description: fields.description === null || fields.description === undefined ? '' : plainText(fields.description),
    status: nonEmpty(status.name, `${at}.fields.status.name`),
    statusCategory: statusCategory(status, `${at}.fields.status`),
    labels: list(fields.labels, `${at}.fields.labels`, nonEmpty),
    owner: person(fields.assignee, `${at}.fields.assignee`),
    reporter: person(fields.reporter, `${at}.fields.reporter`),
    comments: await comments(rest, key, object(fields.comment, `${at}.fields.comment`), `${at}.fields.comment`),
    links: list(fields.issuelinks, `${at}.fields.issuelinks`, link),
    pullRequests: await pullRequests.forItem(key),
  };
}

function statusCategory(status: Fields, path: string) {
  return oneOf(object(status.statusCategory, `${path}.statusCategory`).key, `${path}.statusCategory.key`, STATUS_CATEGORIES);
}

function person(value: unknown, path: string): Person | null {
  return value === null || value === undefined ? null : parsePerson(value, path);
}

// The search embeds the first comments only; past them the reader pages through the item's comments
async function comments(rest: JiraRest, key: JiraKey, embedded: Fields, path: string): Promise<Comment[]> {
  const total = natural(embedded.total, `${path}.total`);
  const first = list(embedded.comments, `${path}.comments`, jiraComment);
  if (first.length === total) return first;
  const all: Comment[] = [];
  while (all.length < total) {
    const at = `comments(${key}, ${all.length})`;
    const page = object(await rest.comments(key, all.length, COMMENT_PAGE), at);
    const entries = list(page.comments, `${at}.comments`, jiraComment);
    if (entries.length === 0) throw new Error(`${at}: Jira reported ${total} comments but returned none past ${all.length}`);
    all.push(...entries);
  }
  return all;
}

export function jiraComment(value: unknown, path: string): Comment {
  const fields = object(value, path);
  return {
    id: commentId(nonEmpty(fields.id, `${path}.id`)),
    author: parsePerson(fields.author, `${path}.author`),
    created: timestamp(fields.created, `${path}.created`),
    text: plainText(fields.body),
  };
}

// Jira gives a link from the item's side: an outward issue reads "blocks X", an inward one "is blocked by X"
function link(value: unknown, path: string): IssueLink {
  const fields = object(value, path);
  const type = object(fields.type, `${path}.type`);
  const outward = fields.outwardIssue !== undefined;
  const other = object(outward ? fields.outwardIssue : fields.inwardIssue, `${path}.${outward ? 'outward' : 'inward'}Issue`);
  const otherFields = object(other.fields, `${path}.issue.fields`);
  return {
    relation: nonEmpty(outward ? type.outward : type.inward, `${path}.type.${outward ? 'outward' : 'inward'}`),
    key: jiraKey(nonEmpty(other.key, `${path}.issue.key`)),
    summary: nonEmpty(otherFields.summary, `${path}.issue.fields.summary`),
    statusCategory: statusCategory(object(otherFields.status, `${path}.issue.fields.status`), `${path}.issue.fields.status`),
  };
}
