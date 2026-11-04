import Resolver from '@forge/resolver';
import { sendToJira } from './bridge';
import { jiraTriggerUrl, sharedSecret } from './pairing';
import { pairing, savePairing } from './settings';

// Backs the workspace settings page: pairing is stored only after a signed ping gets through
export type Status = { pairedWith: string | null };

const resolver = new Resolver();

resolver.define('getStatus', async (): Promise<Status> => ({ pairedWith: (await pairing())?.triggerUrl.hostname ?? null }));

resolver.define('pair', async ({ payload }): Promise<Status> => {
  const { triggerUrl, secret }: { triggerUrl?: unknown; secret?: unknown } = payload;
  if (typeof triggerUrl !== 'string' || typeof secret !== 'string') throw new Error('pair needs triggerUrl and secret strings');
  const candidate = { triggerUrl: jiraTriggerUrl(triggerUrl), secret: sharedSecret(secret) };
  await sendToJira(candidate, { kind: 'ping', sentAt: Date.now() });
  await savePairing(candidate);
  return { pairedWith: candidate.triggerUrl.hostname };
});

export const settingsResolver = resolver.getDefinitions();
