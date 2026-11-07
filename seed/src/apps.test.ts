// The seeded data read by the apps' own code, so a change on either side that would leave the
// demo with nothing to show fails here, before a live run

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraKey, projectKey } from '@shipmill-atlassian/shared/jira-key';
import type { Release, WorkItem } from '@shipmill-atlassian/shared/release';
import { decisionTaskQuestion } from '../../bitbucket/src/holds';
import { parsePolicy } from '../../bitbucket/src/policy';
import { PROPERTY } from '../../jira/src/decision-state';
import { labelledDecisions } from '../../jira/src/finder';
import { templateOptions } from '../../jira/src/prepare';
import { DECISION_PROPERTY } from './jira';
import { FIX_VERSION, ITEMS, mainFiles } from './demo';
import { pullRequestSpecs } from './plan';

const KEYS = new Map(ITEMS.map((item, index) => [item.id, `DEMO-${index + 1}`]));

function release(): Release {
  const items: WorkItem[] = ITEMS.map((item) => ({
    key: jiraKey(KEYS.get(item.id) ?? ''),
    summary: item.summary,
    description: item.description,
    status: 'To Do',
    statusCategory: 'new',
    labels: [...item.labels],
    owner: null,
    reporter: null,
    comments: [],
    links: [],
    pullRequests: [],
  }));
  return { project: projectKey('DEMO'), version: FIX_VERSION, items };
}

test('the Jira app finds the three labelled decisions, each with its question from the description', () => {
  const decisions = labelledDecisions(release().items);
  assert.equal(decisions.length, 3);
  for (const decision of decisions) {
    assert.equal(decision.evidence.kind, 'description', decision.key);
  }
});

test('with the LLM off, each question gets its two answers as options besides moving the item out', () => {
  const seeded = release();
  for (const decision of labelledDecisions(seeded.items)) {
    assert.equal(templateOptions(decision, seeded).length, 3, decision.question);
  }
});

test('the Bitbucket app reads the seeded task as a decision', () => {
  const [spec] = pullRequestSpecs(ITEMS, KEYS).filter((found) => found.task !== undefined);
  assert.ok(spec?.task);
  const question = decisionTaskQuestion({ id: 1, state: 'UNRESOLVED', text: spec.task });
  assert.ok(question?.endsWith('about 20 minutes.'));
});

test("the Bitbucket app reads the seeded shipmill.toml, and the seed clears the Jira app's record", () => {
  const policy = parsePolicy(mainFiles('Harbor demo', 'harbor-demo').get('shipmill.toml') ?? '');
  assert.deepEqual(policy, { branch: 'main', lanes: ['stable'], changelog: 'CHANGELOG.md' });
  assert.equal(DECISION_PROPERTY, PROPERTY);
});
