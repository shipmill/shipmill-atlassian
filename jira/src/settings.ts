import { kvs } from '@forge/kvs';
import { randomBytes } from 'node:crypto';

// Per-install settings: each site that installs the app gets its own secret for the
// Bitbucket bridge and its own LLM switch, so nothing is shared through forge variables

const BRIDGE_SECRET = 'bridge-secret';
const LLM_ENABLED = 'llm-enabled';

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
