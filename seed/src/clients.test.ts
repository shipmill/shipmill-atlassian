import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskState } from './bitbucket';
import { itemState } from './jira';

function issue(properties?: object): object {
  return {
    key: 'DEMO-2',
    fields: { labels: ['needs-decision'], fixVersions: [{ id: '10', name: '2.4' }] },
    ...(properties === undefined ? {} : { properties }),
  };
}

test("a work item reads back with its labels, fix versions and shipmill's record", () => {
  assert.deepEqual(itemState(issue({ 'shipmill-decision': { status: 'waiting' } })), {
    key: 'DEMO-2',
    labels: ['needs-decision'],
    fixVersions: ['2.4'],
    asked: true,
  });
  assert.equal(itemState(issue({})).asked, false);
  assert.equal(itemState(issue()).asked, false);
});

test('a task reads back with its text and whether it is resolved', () => {
  assert.deepEqual(taskState({ id: 4, state: 'RESOLVED', content: { raw: 'Decision needed: A, or B?' } }), {
    id: 4,
    text: 'Decision needed: A, or B?',
    resolved: true,
  });
  assert.throws(() => taskState({ id: 4, state: 'OPEN', content: { raw: 'x' } }), /unknown state/);
});
