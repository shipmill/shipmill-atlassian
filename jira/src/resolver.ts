import { webTrigger } from '@forge/api';
import Resolver from '@forge/resolver';
import { forgeConfluence } from './confluence';
import { spaceKey } from './decision-log';
import { bridgeSecret, decisionLogSpace, llmEnabled, rotateBridgeSecret, setDecisionLogSpace, setLlmEnabled } from './settings';

// Backs the admin page: the web trigger URL and secret an admin copies into the Bitbucket app,
// the LLM switch and the Confluence space of the decision log
export type Settings = { triggerUrl: string; secret: string | null; llm: boolean; logSpace: string | null };

const resolver = new Resolver();

resolver.define('getSettings', async (): Promise<Settings> => ({
  triggerUrl: await webTrigger.getUrl('bridge'),
  secret: (await bridgeSecret()) ?? null,
  llm: await llmEnabled(),
  logSpace: (await decisionLogSpace()) ?? null,
}));

resolver.define('rotateSecret', async (): Promise<{ secret: string }> => ({ secret: await rotateBridgeSecret() }));

resolver.define('setLlm', async ({ payload }): Promise<{ llm: boolean }> => {
  const enabled: unknown = payload.enabled;
  if (typeof enabled !== 'boolean') throw new Error(`setLlm needs a boolean, got ${JSON.stringify(enabled)}`);
  await setLlmEnabled(enabled);
  return { llm: enabled };
});

// A space key turns the log on, once Confluence shows the space to the app; null turns it off
resolver.define('setLogSpace', async ({ payload }): Promise<{ logSpace: string | null }> => {
  const value: unknown = payload.space;
  if (value === null) {
    await setDecisionLogSpace(null);
    return { logSpace: null };
  }
  if (typeof value !== 'string') throw new Error(`setLogSpace needs a space key or null, got ${JSON.stringify(value)}`);
  const space = spaceKey(value.trim());
  if ((await forgeConfluence.spaceId(space)) === undefined) throw new Error(`Confluence has no space ${space} that shipmill can see`);
  await setDecisionLogSpace(space);
  return { logSpace: space };
});

export const settingsResolver = resolver.getDefinitions();
