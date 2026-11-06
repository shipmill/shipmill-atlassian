import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ParseError } from '@shipmill-atlassian/shared/parse';
import { lanesFor, parsePolicy } from './policy';

// The policy the seed writes into the harbor repository
const HARBOR = `# The release policy shipmill reads for this repository
name = "harbor"
mode = "dry-run"
branch = "main"
version_files = "none"

[changelog]
style = "keep-a-changelog"

[gates]
blocker_label = "release-blocker"
blocker_lanes = ["stable"]

[lanes.stable]
quiet_minutes = 30
`;

test("reads the seed's policy", () => {
  assert.deepEqual(parsePolicy(HARBOR), { branch: 'main', lanes: ['stable'], changelog: 'CHANGELOG.md' });
});

test('a merge into the release branch releases in every lane but hotfix, in order', () => {
  const policy = parsePolicy('[lanes.stable]\n[lanes.hotfix]\n[lanes.dev]\n[changelog]\npath = "docs/CHANGES.md"\n');
  assert.deepEqual(policy, { branch: 'main', lanes: ['dev', 'stable', 'hotfix'], changelog: 'docs/CHANGES.md' });
  assert.deepEqual(lanesFor(policy, 'main'), ['dev', 'stable']);
  assert.deepEqual(lanesFor(policy, 'release/2.4'), ['hotfix']);
  assert.deepEqual(lanesFor(policy, 'feature/x'), []);
});

test('a release branch without a hotfix lane releases nothing', () => {
  assert.deepEqual(lanesFor(parsePolicy(HARBOR), 'release/2.4'), []);
});

test('an unknown lane or broken TOML is refused', () => {
  assert.throws(() => parsePolicy('[lanes.nightly]\n'), ParseError);
  assert.throws(() => parsePolicy('branch = '), ParseError);
});
