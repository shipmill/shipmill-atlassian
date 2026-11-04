import { webTrigger } from '@forge/api';
import Resolver from '@forge/resolver';
import { bridgeSecret, llmEnabled, rotateBridgeSecret, setLlmEnabled } from './settings';

// Backs the admin page: the web trigger URL and secret an admin copies into the Bitbucket app
export type Settings = { triggerUrl: string; secret: string | null; llm: boolean };

const resolver = new Resolver();

resolver.define('getSettings', async (): Promise<Settings> => ({
  triggerUrl: await webTrigger.getUrl('bridge'),
  secret: (await bridgeSecret()) ?? null,
  llm: await llmEnabled(),
}));

resolver.define('rotateSecret', async (): Promise<{ secret: string }> => ({ secret: await rotateBridgeSecret() }));

resolver.define('setLlm', async ({ payload }): Promise<{ llm: boolean }> => {
  const enabled: unknown = payload.enabled;
  if (typeof enabled !== 'boolean') throw new Error(`setLlm needs a boolean, got ${JSON.stringify(enabled)}`);
  await setLlmEnabled(enabled);
  return { llm: enabled };
});

export const settingsResolver = resolver.getDefinitions();
