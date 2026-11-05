import { jiraKey, type JiraKey } from '@shipmill-atlassian/shared/jira-key';
import { list, nonEmpty, object, oneOf } from '@shipmill-atlassian/shared/parse';
import { parseRelease, type Release } from '@shipmill-atlassian/shared/release';
import type { Decision, DecisionSource } from './finder';

// The finder's eval set (jira/evals/cases): a release and the decisions a person sees in it.
// A case passes when the finder finds exactly those, by work item and source: a missing one
// is a decision the release would ship past, an extra one a question nobody needs to answer.

export type Expected = { key: JiraKey; source: DecisionSource };

export type EvalCase = { id: string; about: string; release: Release; expected: Expected[] };

export type Score = { id: string; pass: boolean; missing: Expected[]; wrong: Expected[] };

const SOURCES = ['label', 'llm'] as const;

export function parseEvalCase(value: unknown, path: string): EvalCase {
  const fields = object(value, path);
  const id = nonEmpty(fields.id, `${path}.id`);
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`${path}.id: use lowercase letters, digits and dashes, got ${JSON.stringify(id)}`);
  return {
    id,
    about: nonEmpty(fields.about, `${path}.about`),
    release: parseRelease(fields.release, `${path}.release`),
    expected: list(fields.expected, `${path}.expected`, (entry, at) => {
      const expected = object(entry, at);
      return { key: jiraKey(nonEmpty(expected.key, `${at}.key`)), source: oneOf(expected.source, `${at}.source`, SOURCES) };
    }),
  };
}

function same(a: Expected, b: Expected): boolean {
  return a.key === b.key && a.source === b.source;
}

export function score(evalCase: EvalCase, found: readonly Decision[], options: { llm: boolean }): Score {
  // With the LLM off only the labelled decisions are expected
  const expected = evalCase.expected.filter((entry) => options.llm || entry.source === 'label');
  const got = found.map((decision) => ({ key: decision.key, source: decision.source }));
  const missing = expected.filter((entry) => !got.some((other) => same(entry, other)));
  const wrong = got.filter((entry) => !expected.some((other) => same(entry, other)));
  return { id: evalCase.id, pass: missing.length === 0 && wrong.length === 0, missing, wrong };
}
