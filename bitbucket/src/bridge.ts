import { fetch } from '@forge/api';
import { SIGNATURE_HEADER, encode, type BridgeMessage } from '@shipmill-atlassian/shared/bridge';
import type { Pairing } from './settings';

export async function sendToJira({ triggerUrl, secret }: Pairing, message: BridgeMessage): Promise<unknown> {
  const { body, signature } = encode(secret, message);
  const response = await fetch(triggerUrl.href, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER]: signature },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`The Jira app answered ${response.status}: ${text}`);
  return JSON.parse(text);
}
