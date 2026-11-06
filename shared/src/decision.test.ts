import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decode, encode, sign, BridgeError, type BridgeMessage } from './bridge';
import { parseDecisionView, parseReplyOutcome } from './decision';
import { jiraKey } from './jira-key';
import { ParseError } from './parse';
import { commentId } from './release';

const SECRET = 'a-shared-secret';
const NOW = 1_800_000_000_000;
const ASKED = {
  key: 'HRB-2',
  status: 'waiting',
  questionId: '20000',
  question: 'retire v1 tokens?',
  options: [{ text: 'Move HRB-2 out of 2.4', reason: 'ships now' }, { text: 'Retire them', reason: 'decided now' }],
  decider: { accountId: '712020:dana', displayName: 'Dana Okafor' },
  llm: false,
};

test('reads a decision view and refuses one out of shape', () => {
  assert.equal(parseDecisionView(ASKED).status, 'waiting');
  assert.deepEqual(parseDecisionView({ key: 'HRB-2', status: 'none' }), { key: 'HRB-2', status: 'none' });
  assert.equal(parseDecisionView({ ...ASKED, status: 'decided', answer: 'option 2' }).status, 'decided');
  assert.throws(() => parseDecisionView({ ...ASKED, status: 'decided' }), ParseError);
  assert.throws(() => parseDecisionView({ ...ASKED, options: [] }), ParseError);
  assert.throws(() => parseDecisionView({ ...ASKED, questionId: 'abc' }));
});

test('reads a reply outcome and refuses an unknown reason', () => {
  assert.deepEqual(parseReplyOutcome({ relayed: true, answer: 'option 2' }), { relayed: true, answer: 'option 2' });
  assert.deepEqual(parseReplyOutcome({ relayed: false, reason: 'unread' }), { relayed: false, reason: 'unread' });
  assert.throws(() => parseReplyOutcome({ relayed: false, reason: 'later' }), ParseError);
});

const REPLY: BridgeMessage = {
  kind: 'decision-reply',
  sentAt: NOW,
  key: jiraKey('HRB-2'),
  questionId: commentId('20000'),
  author: { accountId: '712020:dana', displayName: 'Dana Okafor' },
  text: '2',
  pullRequest: { id: 2, url: 'https://bitbucket.org/shipmill-dev/harbor/pull-requests/2' },
};

test('a decision query and a decision reply decode to themselves', () => {
  for (const message of [{ kind: 'decision', sentAt: NOW, key: jiraKey('HRB-2') } as const, REPLY]) {
    const { body, signature } = encode(SECRET, message);
    assert.deepEqual(decode(SECRET, body, signature, NOW), message);
  }
});

test('a decision reply out of shape is malformed', () => {
  for (const bad of [
    { ...REPLY, questionId: 'x1' },
    { ...REPLY, text: '  ' },
    { ...REPLY, author: { accountId: '712020:dana' } },
    { ...REPLY, pullRequest: { id: -1, url: 'u' } },
  ]) {
    const body = JSON.stringify(bad);
    assert.throws(() => decode(SECRET, body, sign(SECRET, body), NOW), (error) => error instanceof BridgeError && error.code === 'malformed');
  }
});
