import { createHmac, timingSafeEqual } from 'node:crypto';
import { findJiraKey, type JiraKey } from './jira-key';
import type { CommentId, Person } from './release';

// The Bitbucket app tells the Jira app about pull requests through the Jira app's web trigger.
// The trigger URL is public, so each body is signed with a secret the two installs share,
// and carries its send time so a captured request can't be replayed later.

export const SIGNATURE_HEADER = 'x-shipmill-signature';
export const MAX_SKEW_MS = 5 * 60 * 1000;

export type PullRequestOpened = {
  kind: 'pullrequest-opened';
  sentAt: number;
  workspace: string;
  repository: string;
  id: number;
  title: string;
  url: string;
};

export type Ping = { kind: 'ping'; sentAt: number };

// Asks for the work item a pull request names; the Jira app answers with a WorkItemStatus
export type WorkItemQuery = { kind: 'work-item'; sentAt: number; key: JiraKey };

// Asks what shipmill asked on a work item; the Jira app answers with a DecisionView
export type DecisionQuery = { kind: 'decision'; sentAt: number; key: JiraKey };

// A reply made on a pull request to the question asked there; the Jira app relays it as it
// would a comment on the work item and answers with a ReplyOutcome
export type DecisionReply = {
  kind: 'decision-reply';
  sentAt: number;
  key: JiraKey;
  questionId: CommentId;
  author: Person;
  text: string;
  pullRequest: { id: number; url: string };
};

export type BridgeMessage = Ping | PullRequestOpened | WorkItemQuery | DecisionQuery | DecisionReply;

export type BridgeErrorCode = 'bad-signature' | 'stale' | 'malformed';

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;

  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function encode(secret: string, message: BridgeMessage): { body: string; signature: string } {
  const body = JSON.stringify(message);
  return { body, signature: sign(secret, body) };
}

export function decode(secret: string, body: string, signature: string, now: number): BridgeMessage {
  return parse(verify(secret, body, signature, now));
}

// Checks a signed body of any shape (the bridge's messages, the development trigger's
// requests): the signature first, then that it is a JSON object sent within MAX_SKEW_MS
export function verify(secret: string, body: string, signature: string, now: number): Record<string, unknown> {
  const expected = sign(secret, body);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new BridgeError('bad-signature', 'the signature does not match the shared secret');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) throw new BridgeError('malformed', `not JSON: ${error.message}`);
    throw error;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BridgeError('malformed', 'not an object');
  const fields = raw as Record<string, unknown>;
  const sentAt = integer(fields, 'sentAt');
  if (Math.abs(now - sentAt) > MAX_SKEW_MS) {
    throw new BridgeError('stale', `sent ${now - sentAt} ms ago, more than ${MAX_SKEW_MS} ms`);
  }
  return fields;
}

function parse(fields: Record<string, unknown>): BridgeMessage {
  const sentAt = integer(fields, 'sentAt');
  switch (fields.kind) {
    case 'ping':
      return { kind: 'ping', sentAt };
    case 'pullrequest-opened':
      return {
        kind: 'pullrequest-opened',
        sentAt,
        workspace: text(fields, 'workspace'),
        repository: text(fields, 'repository'),
        id: integer(fields, 'id'),
        title: text(fields, 'title'),
        url: text(fields, 'url'),
      };
    case 'work-item':
      return { kind: 'work-item', sentAt, key: workItemKey(fields) };
    case 'decision':
      return { kind: 'decision', sentAt, key: workItemKey(fields) };
    case 'decision-reply': {
      const questionId = text(fields, 'questionId');
      if (!/^\d+$/.test(questionId)) throw new BridgeError('malformed', 'questionId is not a Jira comment id');
      const author = nested(fields, 'author');
      const pullRequest = nested(fields, 'pullRequest');
      return {
        kind: 'decision-reply',
        sentAt,
        key: workItemKey(fields),
        questionId: questionId as CommentId,
        author: { accountId: text(author, 'author.accountId', 'accountId'), displayName: text(author, 'author.displayName', 'displayName') },
        text: text(fields, 'text'),
        pullRequest: { id: integer(pullRequest, 'id'), url: text(pullRequest, 'pullRequest.url', 'url') },
      };
    }
    default:
      throw new BridgeError('malformed', `unknown kind ${JSON.stringify(fields.kind)}`);
  }
}

function text(fields: Record<string, unknown>, name: string, field = name): string {
  const value = fields[field];
  if (typeof value !== 'string' || value.trim() === '') throw new BridgeError('malformed', `${name} is not a non-empty string`);
  return value;
}

function nested(fields: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = fields[name];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BridgeError('malformed', `${name} is not an object`);
  return value as Record<string, unknown>;
}

function workItemKey(fields: Record<string, unknown>): JiraKey {
  const value = text(fields, 'key');
  if (findJiraKey(value) !== value) throw new BridgeError('malformed', `key ${JSON.stringify(value)} is not a Jira work item key`);
  return value as JiraKey;
}

function integer(fields: Record<string, unknown>, name: string): number {
  const value = fields[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new BridgeError('malformed', `${name} is not a non-negative integer`);
  }
  return value;
}
