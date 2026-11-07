import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskState } from './bitbucket';
import { itemState } from './jira';

function issue(comment: object, properties?: object): object {
  return {
    key: 'DEMO-2',
    fields: { labels: ['needs-decision'], fixVersions: [{ id: '10', name: '2.4' }], comment },
    ...(properties === undefined ? {} : { properties }),
  };
}

test("a work item reads back with its labels, fix versions, comments and shipmill's record", () => {
  const comments = { comments: [{ id: '10001' }, { id: '10002' }], total: 2, maxResults: 5000 };
  assert.deepEqual(itemState(issue(comments, { 'shipmill-decision': { status: 'waiting' } })), {
    key: 'DEMO-2',
    labels: ['needs-decision'],
    fixVersions: ['2.4'],
    comments: ['10001', '10002'],
    asked: true,
  });
  assert.equal(itemState(issue({ comments: [], total: 0 }, {})).asked, false);
});

test('a work item whose comments do not all come back stops the run', () => {
  assert.throws(() => itemState(issue({ comments: [{ id: '1' }], total: 2 })), /has 2 comments/);
});

test('a task reads back with its text and whether it is resolved', () => {
  assert.deepEqual(taskState({ id: 4, state: 'RESOLVED', content: { raw: 'Decision needed: A, or B?' } }), {
    id: 4,
    text: 'Decision needed: A, or B?',
    resolved: true,
  });
  assert.throws(() => taskState({ id: 4, state: 'OPEN', content: { raw: 'x' } }), /unknown state/);
});
