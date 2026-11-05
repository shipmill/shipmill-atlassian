import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { jiraKey } from '@shipmill-atlassian/shared/jira-key';
import { parseEvalCase, score, type EvalCase } from './evals';
import { findDecisions, type Decision } from './finder';

const CASES = new URL('../evals/cases/', import.meta.url);

function cases(): EvalCase[] {
  return readdirSync(CASES)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => parseEvalCase(JSON.parse(readFileSync(new URL(name, CASES), 'utf8')), name));
}

test('the eval set has 15 cases with distinct ids, and decisions of both sources', () => {
  const all = cases();
  assert.equal(all.length, 15);
  assert.equal(new Set(all.map((entry) => entry.id)).size, 15);
  const expected = all.flatMap((entry) => entry.expected);
  assert.ok(expected.some((entry) => entry.source === 'label'));
  assert.ok(expected.some((entry) => entry.source === 'llm'));
  assert.ok(all.some((entry) => entry.expected.length === 0));
});

test('every expected decision names a work item of its release', () => {
  for (const entry of cases()) {
    for (const expected of entry.expected) {
      assert.ok(entry.release.items.some((item) => item.key === expected.key), `${entry.id}: ${expected.key}`);
    }
  }
});

test('with the LLM off every case finds its labelled decisions and nothing else', async () => {
  for (const entry of cases()) {
    const found = await findDecisions(entry.release, {
      llm: false,
      implicit: {
        async find() {
          throw new Error('called');
        },
      },
    });
    assert.deepEqual(score(entry, found, { llm: false }).pass, true, entry.id);
  }
});

test('a score names the missing and the wrong decisions', () => {
  const [seed] = cases();
  assert.ok(seed);
  const found = (key: string, source: Decision['source']): Decision => ({
    key: jiraKey(key),
    source,
    question: 'q?',
    evidence: { kind: 'summary' },
    askOf: null,
  });
  const result = score(seed, [found('HRB-2', 'label'), found('HRB-3', 'label'), found('HRB-9', 'llm')], { llm: true });
  assert.equal(result.pass, false);
  assert.deepEqual(result.missing, [{ key: 'HRB-4', source: 'llm' }]);
  assert.deepEqual(result.wrong, [{ key: 'HRB-9', source: 'llm' }]);
});
