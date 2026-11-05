import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addedBreaking, unreleasedBreaking } from './changelog';

const MAIN = `# Changelog

## [Unreleased]

### Added

- CSV export of invoices

## [2.3.0] - 2026-10-01

### Breaking

- Old breaking entry, already released
`;

const BRANCH = MAIN.replace('### Added', '### Breaking\n\n- API v1 tokens are rejected\n\n### Added');

test('reads only the Unreleased section\'s breaking entries', () => {
  assert.deepEqual(unreleasedBreaking(MAIN), []);
  assert.deepEqual(unreleasedBreaking(BRANCH), ['API v1 tokens are rejected']);
});

test('a breaking entry the destination lacks is added by the pull request', () => {
  assert.deepEqual(addedBreaking(BRANCH, MAIN), ['API v1 tokens are rejected']);
  assert.deepEqual(addedBreaking(BRANCH, BRANCH), []);
});

test('a missing changelog has no breaking entries', () => {
  assert.deepEqual(addedBreaking(undefined, undefined), []);
  assert.deepEqual(addedBreaking(BRANCH, undefined), ['API v1 tokens are rejected']);
});
