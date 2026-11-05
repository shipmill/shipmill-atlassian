import { getAppContext } from '@forge/api';
import { Queue } from '@forge/events';
import { kvs } from '@forge/kvs';
import { BridgeError, SIGNATURE_HEADER, verify } from '@shipmill-atlassian/shared/bridge';
import { projectKey } from '@shipmill-atlassian/shared/jira-key';
import { ParseError, list, nonEmpty, object, type Fields } from '@shipmill-atlassian/shared/parse';
import { parseRelease } from '@shipmill-atlassian/shared/release';
import { forgeImplicitFinder, releaseDecisions } from './decisions';
import { ImplicitDecisionError, findDecisions, type Decision } from './finder';
import { bridgeSecret } from './settings';

// A web trigger for development only, signed with the bridge secret like the bridge itself:
// it reads a live release (no LLM) and runs the eval cases through Forge LLM, which bills
// the Developer Space. Every other environment answers 404 before reading the body.

type WebTriggerRequest = { body?: string; headers?: Record<string, string[] | undefined> };
type WebTriggerResponse = { statusCode: number; headers: Record<string, string[]>; body: string };

const QUEUE = 'eval-cases';
const queue = new Queue({ key: QUEUE });

function respond(statusCode: number, body: object): WebTriggerResponse {
  return { statusCode, headers: { 'Content-Type': ['application/json'] }, body: JSON.stringify(body) };
}

export type EvalOutcome = { decisions: Decision[] } | { error: string };

function resultKey(runId: string, caseId: string): string {
  return `eval:${runId}:${caseId}`;
}

export async function onDevRequest(request: WebTriggerRequest): Promise<WebTriggerResponse> {
  if (getAppContext().environmentType !== 'DEVELOPMENT') return respond(404, { error: 'development only' });
  const secret = await bridgeSecret();
  if (secret === undefined) return respond(409, { error: 'not paired: generate a secret on the admin page' });
  let fields: Fields;
  try {
    fields = verify(secret, request.body ?? '', request.headers?.[SIGNATURE_HEADER]?.[0] ?? '', Date.now());
  } catch (error) {
    if (error instanceof BridgeError) return respond(error.code === 'malformed' ? 400 : 401, { error: error.code });
    throw error;
  }
  try {
    return respond(200, await act(fields));
  } catch (error) {
    if (error instanceof ParseError) return respond(400, { error: error.message });
    throw error;
  }
}

async function act(fields: Fields): Promise<object> {
  switch (fields.action) {
    // The live release and its labelled decisions, never the LLM: this runs inside the 55 s
    // a web trigger has, and reading a release should cost nothing
    case 'release': {
      const project = projectKey(nonEmpty(fields.project, 'project'));
      return releaseDecisions(project, nonEmpty(fields.version, 'version'), false);
    }
    // One queue event per case, so each case gets its own 300 s and a slow one holds up no other
    case 'eval-start': {
      const runId = nonEmpty(fields.runId, 'runId');
      const cases = list(fields.cases, 'cases', object);
      for (const entry of cases) {
        nonEmpty(entry.id, 'cases[].id');
        parseRelease(entry.release, `cases.${String(entry.id)}.release`);
      }
      for (let at = 0; at < cases.length; at += 50) {
        await queue.push(cases.slice(at, at + 50).map((entry) => ({ body: { runId, id: entry.id, release: entry.release } })));
      }
      return { queued: cases.length };
    }
    case 'eval-results': {
      const runId = nonEmpty(fields.runId, 'runId');
      const ids = list(fields.ids, 'ids', nonEmpty);
      const results: Record<string, EvalOutcome> = {};
      for (const id of ids) {
        const outcome = await kvs.get<EvalOutcome>(resultKey(runId, id));
        if (outcome !== undefined) results[id] = outcome;
      }
      return { results };
    }
    default:
      throw new ParseError('action', `unknown action ${JSON.stringify(fields.action)}`);
  }
}

// Runs one case with the LLM on, whatever the switch says: the evals are what decide whether
// it should be on. An answer the finder refuses is the case's result; anything else fails
// the invocation (and Forge retries it).
export async function onEvalCase(event: { body: Record<string, unknown> }): Promise<void> {
  const runId = nonEmpty(event.body.runId, 'runId');
  const id = nonEmpty(event.body.id, 'id');
  const release = parseRelease(event.body.release);
  let outcome: EvalOutcome;
  try {
    outcome = { decisions: await findDecisions(release, { llm: true, implicit: forgeImplicitFinder }) };
  } catch (error) {
    if (!(error instanceof ImplicitDecisionError || error instanceof ParseError)) throw error;
    console.warn(`eval ${runId} ${id}: ${error.message}`);
    outcome = { error: error.message };
  }
  await kvs.set(resultKey(runId, id), outcome, { ttl: { value: 7, unit: 'DAYS' } });
}
