import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRelease } from './release';

const ITEM = {
  key: 'KAN-1',
  summary: 'One',
  description: '',
  status: 'To Do',
  statusCategory: 'new',
  labels: [],
  owner: null,
  reporter: { accountId: 'a', displayName: 'A' },
  comments: [{ id: '10', author: { accountId: 'a', displayName: 'A' }, created: '2026-11-03T09:00:00.000+0000', text: 'hi' }],
  links: [],
  pullRequests: [],
};

test('a release reads back from JSON', () => {
  const release = parseRelease({ project: 'KAN', version: '1.0', items: [ITEM] });
  assert.equal(release.items[0]?.comments[0]?.id, '10');
});

test('refuses a release out of shape, naming the field', () => {
  assert.throws(() => parseRelease({ project: 'KAN', version: '1.0', items: [{ ...ITEM, statusCategory: 'open' }] }), /items\[0\]\.statusCategory/);
  assert.throws(() => parseRelease({ project: 'KAN', version: '1.0', items: [{ ...ITEM, owner: undefined }] }), /items\[0\]\.owner/);
  assert.throws(() => parseRelease({ project: 'kan', version: '1.0', items: [] }), /project key/);
  assert.throws(
    () => parseRelease({ project: 'KAN', version: '1.0', items: [{ ...ITEM, comments: [{ ...ITEM.comments[0], created: 'yesterday' }] }] }),
    /created/,
  );
});
