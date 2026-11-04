import { invoke } from '@forge/bridge';
import ForgeReconciler, { Button, Heading, Label, SectionMessage, Spinner, Stack, Text, Textfield } from '@forge/react';
import React, { useEffect, useState } from 'react';
import type { Status } from '../resolver';

// Without metadata requested, invoke resolves to the resolver's return value itself
const call = <T,>(key: string, payload?: Record<string, unknown>) => invoke(key, payload) as Promise<T>;

function App() {
  const [status, setStatus] = useState<Status>();
  const [triggerUrl, setTriggerUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    call<Status>('getStatus').then(setStatus, (e: Error) => setError(e.message));
  }, []);

  if (status === undefined && error === undefined) return <Spinner />;

  const pair = () => {
    setBusy(true);
    setError(undefined);
    call<Status>('pair', { triggerUrl, secret })
      .then(setStatus, (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <Stack space="space.200">
      <Heading as="h2">Connect Jira</Heading>
      {status?.pairedWith != null && (
        <SectionMessage appearance="success"><Text>Connected to {status.pairedWith}</Text></SectionMessage>
      )}
      {error !== undefined && <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>}
      <Text>Copy both values from the shipmill Release Decisions page in Jira's app settings.</Text>
      <Label labelFor="trigger-url">Jira address</Label>
      <Textfield id="trigger-url" value={triggerUrl} onChange={(e) => setTriggerUrl(e.target.value)} />
      <Label labelFor="secret">Shared secret</Label>
      <Textfield id="secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
      <Button appearance="primary" isDisabled={busy} onClick={pair}>Test and save</Button>
    </Stack>
  );
}

ForgeReconciler.render(<App />);
