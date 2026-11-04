import { invoke } from '@forge/bridge';
import ForgeReconciler, { Button, Code, Heading, Label, SectionMessage, Spinner, Stack, Text, Toggle } from '@forge/react';
import React, { useEffect, useState } from 'react';
import type { Settings } from '../resolver';

// Without metadata requested, invoke resolves to the resolver's return value itself
const call = <T,>(key: string, payload?: Record<string, unknown>) => invoke(key, payload) as Promise<T>;

function App() {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState<string>();

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
    </Stack>
  );
}

ForgeReconciler.render(<App />);
