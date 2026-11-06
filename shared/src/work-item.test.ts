import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraKey } from './jira-key';
import { ParseError } from './parse';
import { expectKey, parseWorkItemStatus } from './work-item';

const FOUND = {
  key: 'HRB-2',
  found: true,
  summary: 'Retire API v1 tokens',
  fixVersions: ['2.4'],
  openDecisions: ['retire v1 tokens in 2.4, or keep them for one more release?'],
  decider: { accountId: 'dana', displayName: 'Dana Okafor' },
};

test('a found work item reads back as itself', () => {
  assert.deepEqual(parseWorkItemStatus(FOUND), FOUND);
});

test('a missing work item carries only its key', () => {
  assert.deepEqual(parseWorkItemStatus({ key: 'HRB-99', found: false }), { key: 'HRB-99', found: false });
});

test('a found work item without its decisions is refused', () => {
  const { openDecisions: _, ...partial } = FOUND;
  assert.throws(() => parseWorkItemStatus(partial), ParseError);
});

test('an answer about another work item is refused', () => {
  assert.throws(() => expectKey(parseWorkItemStatus(FOUND), jiraKey('HRB-3')), ParseError);
});
