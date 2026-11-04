import { kvs } from '@forge/kvs';

// Per-install pairing with one Jira site, stored as secrets: the trigger URL is a credential too

const JIRA_TRIGGER_URL = 'jira-trigger-url';
const BRIDGE_SECRET = 'bridge-secret';

export type Pairing = { triggerUrl: URL; secret: string };

export async function pairing(): Promise<Pairing | undefined> {
  const [triggerUrl, secret] = await Promise.all([
    kvs.getSecret<string>(JIRA_TRIGGER_URL),
    kvs.getSecret<string>(BRIDGE_SECRET),
  ]);
  if (triggerUrl === undefined || secret === undefined) return undefined;
  return { triggerUrl: new URL(triggerUrl), secret };
}

export async function savePairing({ triggerUrl, secret }: Pairing): Promise<void> {
  await Promise.all([kvs.setSecret(JIRA_TRIGGER_URL, triggerUrl.href), kvs.setSecret(BRIDGE_SECRET, secret)]);
}
