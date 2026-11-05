import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLinkedPullRequests, remember, type LinkedPullRequest } from './pull-requests';

const PR: LinkedPullRequest = { workspace: 'w', repository: 'r', id: 1, title: 'KAN-1 One', url: 'https://bitbucket.org/w/r/pull-requests/1' };

test('remembers a new pull request after the known ones', () => {
  const other = { ...PR, id: 2 };
  assert.deepEqual(remember([PR], other), [PR, other]);
});

test('replaces the same pull request in place, so a redelivered event adds nothing', () => {
  const retitled = { ...PR, title: 'KAN-1 One, renamed' };
  assert.deepEqual(remember([PR, { ...PR, id: 2 }], retitled), [retitled, { ...PR, id: 2 }]);
  assert.deepEqual(remember([PR], PR), [PR]);
});

test('the same id in another repository is another pull request', () => {
  assert.equal(remember([PR], { ...PR, repository: 'other' }).length, 2);
});

test('refuses a stored list out of shape', () => {
  assert.deepEqual(parseLinkedPullRequests([PR], 'stored'), [PR]);
  assert.throws(() => parseLinkedPullRequests([{ ...PR, id: -1 }], 'stored'), /stored\[0\]\.id/);
  assert.throws(() => parseLinkedPullRequests({}, 'stored'), /expected an array/);
});
