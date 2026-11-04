// What a workspace admin pastes from the Jira app's admin page, checked before it is stored

const TRIGGER_HOST = '.hello.atlassian-dev.net';

export function jiraTriggerUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch (error) {
    if (error instanceof TypeError) throw new Error('The Jira address is not a URL');
    throw error;
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith(TRIGGER_HOST)) {
    throw new Error(`The Jira address must be an https://…${TRIGGER_HOST} address from the Jira app's settings`);
  }
  return url;
}

export function sharedSecret(input: string): string {
  const secret = input.trim();
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("The shared secret must be the 64-character value from the Jira app's settings");
  return secret;
}
