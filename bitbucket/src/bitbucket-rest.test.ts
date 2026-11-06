import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ParseError } from '@shipmill-atlassian/shared/parse';
import { filePath, parseComment, parsePullRequest, parseStatus, parseTask } from './bitbucket-rest';

// Trimmed from GET /2.0/repositories/{workspace}/{repo}/pullrequests/{id}
const BODY = {
  id: 2,
  title: 'HRB-2 Retire API v1 tokens',
  links: { html: { href: 'https://bitbucket.org/shipmill-dev/harbor/pull-requests/2' } },
  author: { account_id: '712020:sam', display_name: 'Sam Reyes', type: 'user' },
  source: { branch: { name: 'HRB-2-retire-v1-tokens' }, commit: { hash: '0123456789ab', type: 'commit' } },
  destination: { branch: { name: 'main' }, commit: { hash: 'fedcba987654' } },
  participants: [
    { user: { account_id: '712020:dana', display_name: 'Dana Okafor' }, role: 'REVIEWER', approved: true, state: 'approved' },
  ],
};

test('reads a pull request with its head commit, destination and approvals', () => {
  assert.deepEqual(parsePullRequest(BODY), {
    id: 2,
    title: 'HRB-2 Retire API v1 tokens',
    url: 'https://bitbucket.org/shipmill-dev/harbor/pull-requests/2',
    author: { accountId: '712020:sam', displayName: 'Sam Reyes' },
    sourceCommit: '0123456789ab',
    destinationBranch: 'main',
    destinationCommit: 'fedcba987654',
    participants: [{ accountId: '712020:dana', displayName: 'Dana Okafor', approved: true }],
  });
});

test('a pull request without its head commit is refused', () => {
  assert.throws(() => parsePullRequest({ ...BODY, source: { branch: { name: 'x' } } }), ParseError);
});

test('a build status without a name is named by its key; an unknown state is refused', () => {
  assert.deepEqual(parseStatus({ key: 'lint', name: null, state: 'INPROGRESS' }, 's'), { key: 'lint', name: 'lint', state: 'INPROGRESS' });
  assert.throws(() => parseStatus({ key: 'lint', state: 'GREEN' }, 's'), ParseError);
});

test('reads a task', () => {
  assert.deepEqual(parseTask({ id: 1, state: 'UNRESOLVED', content: { raw: 'Decision needed: x?' } }, 't'), {
    id: 1,
    state: 'UNRESOLVED',
    text: 'Decision needed: x?',
  });
});

test('reads a comment with its author', () => {
  const body = {
    id: 712,
    content: { raw: '2', markup: 'markdown', html: '<p>2</p>' },
    user: { account_id: '712020:dana', display_name: 'Dana Okafor', type: 'user' },
    deleted: false,
  };
  assert.deepEqual(parseComment(body, 'c'), { id: 712, author: { accountId: '712020:dana', displayName: 'Dana Okafor' }, text: '2' });
  assert.throws(() => parseComment({ ...body, user: undefined }, 'c'), ParseError);
});

test('a repository path keeps its directories and refuses to climb out', () => {
  assert.equal(filePath('docs/CHANGELOG.md').value, 'docs/CHANGELOG.md');
  for (const bad of ['../secret', 'a//b', '/abs', 'a?b', 'a\\b']) assert.throws(() => filePath(bad), ParseError, bad);
});
