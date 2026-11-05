import { ParseError, nonEmpty, object, string } from '@shipmill-atlassian/shared/parse';
import { TomlError, parse } from 'smol-toml';

// The part of a repository's shipmill.toml the card and the check read: the branch the
// lanes release from, the lanes it enables, and where its changelog is. It is read at the
// destination commit, so a pull request can't change the policy it is judged by.

export const POLICY_FILE = 'shipmill.toml';
export const LANES = ['dev', 'rc', 'stable', 'hotfix'] as const;
export type Lane = (typeof LANES)[number];

export type Policy = { branch: string; lanes: Lane[]; changelog: string };

export function parsePolicy(text: string): Policy {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    if (error instanceof TomlError) throw new ParseError(POLICY_FILE, `not TOML: ${error.message}`);
    throw error;
  }
  const top = object(raw, POLICY_FILE);
  const lanes = top.lanes === undefined ? {} : object(top.lanes, `${POLICY_FILE}.lanes`);
  for (const lane of Object.keys(lanes)) {
    if (!(LANES as readonly string[]).includes(lane)) {
      throw new ParseError(`${POLICY_FILE}.lanes`, `unknown lane ${JSON.stringify(lane)}; lanes are ${LANES.join(', ')}`);
    }
  }
  const changelog = top.changelog === undefined ? {} : object(top.changelog, `${POLICY_FILE}.changelog`);
  return {
    branch: top.branch === undefined ? 'main' : nonEmpty(top.branch, `${POLICY_FILE}.branch`),
    lanes: LANES.filter((lane) => lane in lanes),
    changelog: changelog.path === undefined ? 'CHANGELOG.md' : nonEmpty(string(changelog.path, `${POLICY_FILE}.changelog.path`), `${POLICY_FILE}.changelog.path`),
  };
}

// The lanes a merge into this branch can release in: the release branch feeds every lane
// but hotfix, a release/X.Y branch feeds the hotfix lane, and any other branch none
export function lanesFor(policy: Policy, destination: string): Lane[] {
  if (destination === policy.branch) return policy.lanes.filter((lane) => lane !== 'hotfix');
  if (/^release\/\d+\.\d+$/.test(destination) && policy.lanes.includes('hotfix')) return ['hotfix'];
  return [];
}
