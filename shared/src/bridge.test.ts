import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeError, MAX_SKEW_MS, decode, encode, sign, verify, type BridgeMessage } from './bridge';

const SECRET = 'a-shared-secret';
const NOW = 1_800_000_000_000;
const OPENED: BridgeMessage = {
  kind: 'pullrequest-opened',
  sentAt: NOW,
  workspace: '{w}',
  repository: '{r}',
  id: 7,
  title: 'KAN-4 Judge check',
  url: 'https://bitbucket.org/w/r/pull-requests/7',
};

function rejects(code: string, run: () => unknown): void {
  assert.throws(run, (error) => error instanceof BridgeError && error.code === code);
}

test('a signed message decodes to itself', () => {
  const { body, signature } = encode(SECRET, OPENED);
  assert.deepEqual(decode(SECRET, body, signature, NOW + 1000), OPENED);
});

test('a ping decodes', () => {
  const { body, signature } = encode(SECRET, { kind: 'ping', sentAt: NOW });
  assert.deepEqual(decode(SECRET, body, signature, NOW), { kind: 'ping', sentAt: NOW });
});

test('another secret is refused', () => {
  const { body } = encode(SECRET, OPENED);
  rejects('bad-signature', () => decode(SECRET, body, sign('other', body), NOW));
});

test('a changed body is refused', () => {
  const { body, signature } = encode(SECRET, OPENED);
  rejects('bad-signature', () => decode(SECRET, body.replace('KAN-4', 'KAN-5'), signature, NOW));
});

test('a signature of another length is refused', () => {
  const { body } = encode(SECRET, OPENED);
  rejects('bad-signature', () => decode(SECRET, body, 'abc', NOW));
});

test('an old message is refused', () => {
  const { body, signature } = encode(SECRET, OPENED);
  rejects('stale', () => decode(SECRET, body, signature, NOW + MAX_SKEW_MS + 1));
});

test('a message from the future is refused', () => {
  const { body, signature } = encode(SECRET, OPENED);
  rejects('stale', () => decode(SECRET, body, signature, NOW - MAX_SKEW_MS - 1));
});

test('a signed body that is not JSON is refused', () => {
  rejects('malformed', () => decode(SECRET, 'nope', sign(SECRET, 'nope'), NOW));
});

test('a signed message of an unknown kind is refused', () => {
  const body = JSON.stringify({ kind: 'merged', sentAt: NOW });
  rejects('malformed', () => decode(SECRET, body, sign(SECRET, body), NOW));
});

test('a signed message missing a field is refused', () => {
  const body = JSON.stringify({ ...OPENED, title: '' });
  rejects('malformed', () => decode(SECRET, body, sign(SECRET, body), NOW));
});

test('verify accepts any signed object and refuses arrays and stale bodies', () => {
  const body = JSON.stringify({ action: 'release', sentAt: NOW });
  assert.deepEqual(verify(SECRET, body, sign(SECRET, body), NOW), { action: 'release', sentAt: NOW });
  const list = JSON.stringify([1]);
  rejects('malformed', () => verify(SECRET, list, sign(SECRET, list), NOW));
  rejects('stale', () => verify(SECRET, body, sign(SECRET, body), NOW + MAX_SKEW_MS + 1));
  rejects('bad-signature', () => verify(SECRET, body, sign('other', body), NOW));
});
