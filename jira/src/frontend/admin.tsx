import { invoke } from '@forge/bridge';
import ForgeReconciler, { Button, Code, Heading, Inline, Label, SectionMessage, Spinner, Stack, Text, Textfield, Toggle } from '@forge/react';
import React, { useEffect, useState } from 'react';
import type { Settings } from '../resolver';

// Without metadata requested, invoke resolves to the resolver's return value itself
const call = <T,>(key: string, payload?: Record<string, unknown>) => invoke(key, payload) as Promise<T>;

function App() {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState<string>();
  const [space, setSpace] = useState('');
  const [spaceError, setSpaceError] = useState<string>();

  useEffect(() => {
    call<Settings>('getSettings').then(setSettings, (e: Error) => setError(e.message));
  }, []);

  if (error !== undefined) return <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>;
  if (settings === undefined) return <Spinner />;

  const rotate = () =>
    call<{ secret: string }>('rotateSecret').then(
      ({ secret }) => setSettings({ ...settings, secret }),
      (e: Error) => setError(e.message),
    );
  const toggleLlm = () =>
    call<{ llm: boolean }>('setLlm', { enabled: !settings.llm }).then(
      ({ llm }) => setSettings({ ...settings, llm }),
      (e: Error) => setError(e.message),
    );
  // A wrong space key is reported next to the field and leaves the rest of the page as it is
  const saveSpace = (value: string | null) =>
    call<{ logSpace: string | null }>('setLogSpace', { space: value }).then(
      ({ logSpace }) => {
        setSettings({ ...settings, logSpace });
        setSpace('');
        setSpaceError(undefined);
      },
      (e: Error) => setSpaceError(e.message),
    );

  return (
    <Stack space="space.300">
      <Stack space="space.100">
        <Heading as="h2">Connect Bitbucket</Heading>
        <Text>Paste both values into the shipmill Release Decisions settings of your Bitbucket workspace.</Text>
        <Label labelFor="trigger-url">Jira address</Label>
        <Code>{settings.triggerUrl}</Code>
        <Label labelFor="secret">Shared secret</Label>
        {settings.secret === null ? <Text>No secret yet.</Text> : <Code>{settings.secret}</Code>}
        <Button onClick={rotate}>{settings.secret === null ? 'Generate secret' : 'Generate a new secret'}</Button>
      </Stack>
      <Stack space="space.100">
        <Heading as="h2">Claude</Heading>
        <Label labelFor="llm">Prepare decisions with Claude (Forge LLMs)</Label>
        <Toggle id="llm" isChecked={settings.llm} onChange={toggleLlm} />
        <Text>When off, shipmill works on items labelled needs-decision with template text.</Text>
      </Stack>
      <Stack space="space.100">
        <Heading as="h2">Confluence decision log</Heading>
        <Text>
          {settings.logSpace === null
            ? 'Off. Enter a Confluence space key to record each relayed decision on a page per project in that space.'
            : `On: each relayed decision adds a row to the "Release decisions: <project>" page in space ${settings.logSpace}.`}
        </Text>
        <Label labelFor="log-space">Space key</Label>
        <Textfield id="log-space" value={space} onChange={(e) => setSpace(e.target.value)} />
        <Inline space="space.100">
          <Button onClick={() => saveSpace(space)} isDisabled={space.trim() === ''}>Save space</Button>
          {settings.logSpace !== null && <Button onClick={() => saveSpace(null)}>Turn off</Button>}
        </Inline>
        {spaceError !== undefined && <SectionMessage appearance="error"><Text>{spaceError}</Text></SectionMessage>}
      </Stack>
    </Stack>
  );
}

ForgeReconciler.render(<App />);
