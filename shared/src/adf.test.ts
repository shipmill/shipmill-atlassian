import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphs, plainText } from './adf';

test('one paragraph per line', () => {
  assert.deepEqual(paragraphs(['a', 'b']).content.map((p) => p.content[0]?.text), ['a', 'b']);
});

test('refuses an empty document and an empty line', () => {
  assert.throws(() => paragraphs([]));
  assert.throws(() => paragraphs(['a', '']));
});

test('plain text keeps paragraphs, breaks and mentions', () => {
  const doc = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'a', text: '@Dana' } }, { type: 'text', text: ' which one?' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }, { type: 'hardBreak' }, { type: 'text', text: 'two' }] }] }] },
    ],
  };
  assert.equal(plainText(doc), '@Dana which one?\none\ntwo');
});

test('plain text refuses a node out of shape', () => {
  assert.throws(() => plainText({ type: 'doc', content: [{ type: 'text' }] }), /text node has no text/);
  assert.throws(() => plainText({ type: 'doc', content: 'x' }), /content is not an array/);
  assert.throws(() => plainText(null), /not an object/);
});
