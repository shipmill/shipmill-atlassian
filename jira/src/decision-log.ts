import { jiraKey, projectOf, type JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { nonEmpty, object } from '@shipmill-atlassian/shared/parse';
import { commentId, parsePerson, timestamp, type CommentId, type Person } from '@shipmill-atlassian/shared/release';

// The Confluence decision log: one page per Jira project, in the space an admin picks on the
// app's settings page, with a row per relayed decision. The relay hands each decision to a
// queue (see relay-trigger.ts) and a consumer writes the row, so a failed write is a failed
// consumer run in the logs and never touches the decision itself. No space set, no page.

// A Confluence space key: letters and digits, or a personal space's "~" and account id
const SPACE_KEY = /^(?:[A-Za-z0-9]+|~[A-Za-z0-9:_-]+)$/;

export type SpaceKey = string & { readonly __brand: 'SpaceKey' };

export function spaceKey(text: string): SpaceKey {
  if (!SPACE_KEY.test(text)) throw new Error(`not a Confluence space key: ${JSON.stringify(text)}`);
  return text as SpaceKey;
}

// What the relay hands on once a decision is accepted. replyId is the comment that ended the
// wait: the decider's reply, or shipmill's relay comment for a reply made on a pull request.
export type LoggedDecision = {
  key: JiraKey;
  question: string;
  answer: string;
  decider: Person;
  decidedAt: string;
  replyId: CommentId;
};

export interface DecisionLog {
  record(decision: LoggedDecision): Promise<void>;
}

export function parseLoggedDecision(value: unknown, path: string): LoggedDecision {
  const fields = object(value, path);
  return {
    key: jiraKey(nonEmpty(fields.key, `${path}.key`)),
    question: nonEmpty(fields.question, `${path}.question`),
    answer: nonEmpty(fields.answer, `${path}.answer`),
    decider: parsePerson(fields.decider, `${path}.decider`),
    decidedAt: timestamp(fields.decidedAt, `${path}.decidedAt`),
    replyId: commentId(nonEmpty(fields.replyId, `${path}.replyId`)),
  };
}

export type Page = { id: string; version: number; body: string };

// The Confluence calls the log makes, as an interface so tests run them on a fake
export interface Confluence {
  spaceId(space: SpaceKey): Promise<string | undefined>;
  page(spaceId: string, title: string): Promise<Page | undefined>;
  createPage(spaceId: string, title: string, body: string): Promise<string>;
  updatePage(page: Page, title: string, body: string): Promise<void>;
}

export class DecisionLogError extends Error {}

export function pageTitle(decision: LoggedDecision): string {
  return `Release decisions: ${projectOf(decision.key)}`;
}

function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function link(url: string, text: string): string {
  return `<a href="${escape(url)}">${escape(text)}</a>`;
}

const HEADER = ['Work item', 'Question', 'Decision', 'Decided by', 'When (UTC)', 'Reply'];

// One row in Confluence storage format. The decider is named, not mentioned, so the log
// doesn't notify them again.
export function decisionRow(decision: LoggedDecision, site: string): string {
  const item = `${site}/browse/${decision.key}`;
  const cells = [
    link(item, decision.key),
    escape(decision.question),
    escape(decision.answer),
    escape(decision.decider.displayName),
    escape(decision.decidedAt.slice(0, 16).replace('T', ' ')),
    link(`${item}?focusedCommentId=${decision.replyId}`, 'reply'),
  ];
  return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
}

export function newPage(decision: LoggedDecision, site: string): string {
  return [
    `<p>Decisions on ${escape(projectOf(decision.key))} work items, as relayed by shipmill Release Decisions. One row per decision; shipmill adds the rows.</p>`,
    `<table><tbody><tr>${HEADER.map((cell) => `<th>${cell}</th>`).join('')}</tr>${decisionRow(decision, site)}</tbody></table>`,
  ].join('');
}

// The row goes at the end of the page's last table. Confluence may rewrite the table's
// markup, but it keeps the tbody.
export function appendRow(body: string, decision: LoggedDecision, site: string): string {
  const end = body.lastIndexOf('</tbody>');
  if (end === -1) throw new DecisionLogError(`the decision log page ${JSON.stringify(pageTitle(decision))} has no table to add a row to`);
  return body.slice(0, end) + decisionRow(decision, site) + body.slice(end);
}

export type LogOutcome = { written: false; reason: 'off' } | { written: true; page: string; created: boolean };

export async function writeDecision(
  decision: LoggedDecision,
  deps: { space: SpaceKey | undefined; confluence: Confluence; site: () => Promise<string> },
): Promise<LogOutcome> {
  if (deps.space === undefined) return { written: false, reason: 'off' };
  const spaceId = await deps.confluence.spaceId(deps.space);
  if (spaceId === undefined) throw new DecisionLogError(`no Confluence space ${deps.space} for the decision log`);
  const site = await deps.site();
  const title = pageTitle(decision);
  const page = await deps.confluence.page(spaceId, title);
  if (page === undefined) return { written: true, page: await deps.confluence.createPage(spaceId, title, newPage(decision, site)), created: true };
  await deps.confluence.updatePage(page, title, appendRow(page.body, decision, site));
  return { written: true, page: page.id, created: false };
}
