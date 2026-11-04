import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findJiraKey } from './jira-key';

test('finds the first key in a title', () => {
  assert.equal(findJiraKey('KAN-4 Judge check, see also KAN-5'), 'KAN-4');
});

test('finds a key with digits and underscores in the project', () => {
  assert.equal(findJiraKey('fix(OPS_2-17): retry'), 'OPS_2-17');
});

test('finds nothing without a key', () => {
  assert.equal(findJiraKey('Bump deps'), undefined);
});

test('ignores lowercase, one-letter projects and number zero', () => {
  assert.equal(findJiraKey('kan-4 K-4 KAN-0'), undefined);
});
