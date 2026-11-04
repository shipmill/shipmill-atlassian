import { createHmac, timingSafeEqual } from 'node:crypto';

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

export type BridgeMessage = Ping | PullRequestOpened;

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
  const expected = sign(secret, body);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new BridgeError('bad-signature', 'the signature does not match the shared secret');
  }
  const message = parse(body);
  if (Math.abs(now - message.sentAt) > MAX_SKEW_MS) {
    throw new BridgeError('stale', `sent ${now - message.sentAt} ms ago, more than ${MAX_SKEW_MS} ms`);
  }
  return message;
}

function parse(body: string): BridgeMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) throw new BridgeError('malformed', `not JSON: ${error.message}`);
    throw error;
  }
  if (typeof raw !== 'object' || raw === null) throw new BridgeError('malformed', 'not an object');
  const fields = raw as Record<string, unknown>;
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
    default:
      throw new BridgeError('malformed', `unknown kind ${JSON.stringify(fields.kind)}`);
  }
}

function text(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  if (typeof value !== 'string' || value === '') throw new BridgeError('malformed', `${name} is not a non-empty string`);
  return value;
}

function integer(fields: Record<string, unknown>, name: string): number {
  const value = fields[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new BridgeError('malformed', `${name} is not a non-negative integer`);
  }
  return value;
}
