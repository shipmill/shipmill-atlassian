// Runs the decision finder's eval set (jira/evals/cases) and prints a score per case.
//
//   npm run evals                 the LLM off, locally: the labelled decisions only, no calls
//   npm run evals -- --live       the LLM on, through the app's development trigger
//
// --live sends the cases to the app deployed in development, which runs each one through
// Forge LLM and bills the Developer Space. It needs SHIPMILL_DEV_TRIGGER_URL (the `dev` web
// trigger's URL, from `forge webtrigger list -e development`) and SHIPMILL_BRIDGE_SECRET (the
// secret on the admin page). Exits 1 when a case fails.

import { readFileSync, readdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { SIGNATURE_HEADER, sign } from '@shipmill-atlassian/shared/bridge';
import { jiraKey } from '@shipmill-atlassian/shared/jira-key';
import { list, nonEmpty, object, oneOf } from '@shipmill-atlassian/shared/parse';
import { parseEvalCase, score, type EvalCase, type Score } from '../src/evals';
import { findDecisions, type Decision, type ImplicitFinder } from '../src/finder';

const CASES = new URL('./cases/', import.meta.url);
const POLL_MS = 5_000;
const WAIT_MS = 10 * 60_000;

function loadCases(): EvalCase[] {
  const files = readdirSync(CASES).filter((name) => name.endsWith('.json')).sort();
  const cases = files.map((name) => parseEvalCase(JSON.parse(readFileSync(new URL(name, CASES), 'utf8')), name));
  const ids = new Set(cases.map((entry) => entry.id));
  if (ids.size !== cases.length) throw new Error('two eval cases share an id');
  return cases;
}

const NO_LLM: ImplicitFinder = {
  async find() {
    throw new Error('the offline run called the LLM');
  },
};

async function offline(cases: EvalCase[]): Promise<Score[]> {
  const scores: Score[] = [];
  for (const entry of cases) {
    scores.push(score(entry, await findDecisions(entry.release, { llm: false, implicit: NO_LLM }), { llm: false }));
  }
  return scores;
}

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`--live needs ${name} in the environment`);
  return value;
}

async function call(url: string, secret: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ ...request, sentAt: Date.now() });
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: sign(secret, body) },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`the dev trigger returned ${response.status}: ${text}`);
  return object(JSON.parse(text), 'response');
}

// Only what scoring reads; the rest of each decision is printed as it came
function foundDecisions(value: unknown, path: string): Decision[] {
  return list(value, path, (entry, at) => {
    const fields = object(entry, at);
    jiraKey(nonEmpty(fields.key, `${at}.key`));
    oneOf(fields.source, `${at}.source`, ['label', 'llm']);
    return fields as unknown as Decision;
  });
}

async function live(cases: EvalCase[]): Promise<Score[]> {
  const url = env('SHIPMILL_DEV_TRIGGER_URL');
  const secret = env('SHIPMILL_BRIDGE_SECRET');
  const runId = `run-${Date.now()}`;
  const ids = cases.map((entry) => entry.id);
  const started = await call(url, secret, { action: 'eval-start', runId, cases });
  console.log(`${runId}: queued ${String(started.queued)} cases`);
  const deadline = Date.now() + WAIT_MS;
  let results: Record<string, unknown> = {};
  while (Object.keys(results).length < ids.length) {
    if (Date.now() > deadline) {
      const waiting = ids.filter((id) => !(id in results));
      throw new Error(`${runId}: no result after ${WAIT_MS / 60_000} min for ${waiting.join(', ')}; see forge logs -e development`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    results = object((await call(url, secret, { action: 'eval-results', runId, ids })).results, 'results');
  }
  return cases.map((entry) => {
    const outcome = object(results[entry.id], entry.id);
    if ('error' in outcome) {
      console.log(`  ${entry.id}: the finder refused the LLM's answer: ${String(outcome.error)}`);
      return { id: entry.id, pass: false, missing: entry.expected, wrong: [] };
    }
    const decisions = foundDecisions(outcome.decisions, `${entry.id}.decisions`);
    for (const decision of decisions.filter((d) => d.source === 'llm')) {
      console.log(`  ${entry.id}: ${decision.key} asks "${decision.question}"`);
    }
    return score(entry, decisions, { llm: true });
  });
}

function show(expected: { key: string; source: string }[]): string {
  return expected.map((entry) => `${entry.key} (${entry.source})`).join(', ');
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { live: { type: 'boolean', default: false } } });
  const cases = loadCases();
  const scores = values.live ? await live(cases) : await offline(cases);
  for (const result of scores) {
    const notes = [
      result.missing.length > 0 ? `missing ${show(result.missing)}` : '',
      result.wrong.length > 0 ? `wrong ${show(result.wrong)}` : '',
    ].filter((note) => note !== '');
    console.log(`${result.pass ? 'pass' : 'FAIL'}  ${result.id}${notes.length > 0 ? `: ${notes.join('; ')}` : ''}`);
  }
  const passed = scores.filter((result) => result.pass).length;
  console.log(`${passed}/${scores.length} cases pass, LLM ${values.live ? 'on' : 'off'}`);
  if (passed !== scores.length) process.exitCode = 1;
}

await main();
