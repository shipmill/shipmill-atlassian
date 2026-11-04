import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphs } from './adf';

test('one paragraph per line', () => {
  assert.deepEqual(paragraphs(['a', 'b']).content.map((p) => p.content[0]?.text), ['a', 'b']);
});

test('refuses an empty document and an empty line', () => {
  assert.throws(() => paragraphs([]));
  assert.throws(() => paragraphs(['a', '']));
});
