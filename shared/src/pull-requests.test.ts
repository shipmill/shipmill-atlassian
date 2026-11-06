import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLinkedPullRequest, parseLinkedPullRequests, pullRequestLabel, remember, type LinkedPullRequest } from './pull-requests';

const PR: LinkedPullRequest = { workspace: 'w', repository: '{cd0fce65-d4df-4d6e-8f6d-cee7cbc7c6a2}', repositorySlug: 'harbor', id: 1, title: 'KAN-1 One', url: 'https://bitbucket.org/w/harbor/pull-requests/1' };

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

test('labels a pull request by its repository slug, not the uuid that identifies it', () => {
  assert.equal(pullRequestLabel({ ...PR, id: 2 }), 'harbor #2');
});

test('the same id under another slug of the same repository is the same pull request', () => {
  const renamed = { ...PR, repositorySlug: 'harbour' };
  assert.deepEqual(remember([PR], renamed), [renamed]);
});

test('migrates a value stored without a slug from its own URL, and refuses one it cannot', () => {
  const { repositorySlug: _, ...legacy } = PR;
  assert.deepEqual(parseLinkedPullRequest(legacy, 'stored'), PR);
  assert.throws(() => parseLinkedPullRequest({ ...legacy, url: 'https://bitbucket.org/w/harbor/pull-requests/9' }, 'stored'), /stored\.repositorySlug/);
  assert.throws(() => parseLinkedPullRequest({ ...legacy, url: 'https://example.com/harbor/1' }, 'stored'), /stored\.repositorySlug/);
  assert.throws(() => parseLinkedPullRequest({ ...PR, repositorySlug: '' }, 'stored'), /stored\.repositorySlug/);
});
