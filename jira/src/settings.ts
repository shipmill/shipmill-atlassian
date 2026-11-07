import { kvs } from '@forge/kvs';
import { randomBytes } from 'node:crypto';
import { spaceKey, type SpaceKey } from './decision-log';

// Per-install settings: each site that installs the app gets its own secret for the
// Bitbucket bridge, its own LLM switch and its own decision log space, so nothing is shared through forge variables

const BRIDGE_SECRET = 'bridge-secret';
const LLM_ENABLED = 'llm-enabled';
const DECISION_LOG_SPACE = 'decision-log-space';

export async function bridgeSecret(): Promise<string | undefined> {
  return kvs.getSecret<string>(BRIDGE_SECRET);
}

export async function rotateBridgeSecret(): Promise<string> {
  const secret = randomBytes(32).toString('hex');
  await kvs.setSecret(BRIDGE_SECRET, secret);
  return secret;
}

// On by default; with it off the app keeps to explicit labels and template text
export async function llmEnabled(): Promise<boolean> {
  return (await kvs.get<boolean>(LLM_ENABLED)) ?? true;
}

export async function setLlmEnabled(enabled: boolean): Promise<void> {
  await kvs.set(LLM_ENABLED, enabled);
}

// The Confluence space of the decision log; none set keeps the log off
export async function decisionLogSpace(): Promise<SpaceKey | undefined> {
  const space = await kvs.get<string>(DECISION_LOG_SPACE);
  return space === undefined ? undefined : spaceKey(space);
}

export async function setDecisionLogSpace(space: SpaceKey | null): Promise<void> {
  if (space === null) await kvs.delete(DECISION_LOG_SPACE);
  else await kvs.set(DECISION_LOG_SPACE, space);
}
