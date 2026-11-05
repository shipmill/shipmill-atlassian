import { invoke } from '@forge/bridge';
import ForgeReconciler, { Heading, Lozenge, SectionMessage, Spinner, Stack, Text } from '@forge/react';
import React, { useEffect, useState } from 'react';
import type { CardView } from '../card-resolver';

// The pull request card: release, lane, and who the pull request waits on
function App() {
  const [view, setView] = useState<CardView>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    (invoke('getCard') as Promise<CardView>).then(setView, (e: Error) => setError(e.message));
  }, []);

  if (error !== undefined) return <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>;
  if (view === undefined) return <Spinner />;
  if (view.kind === 'not-paired') return <SectionMessage appearance="warning"><Text>{view.message}</Text></SectionMessage>;

  const { card } = view;
  const clear = card.holds.length === 0;
  return (
    <Stack space="space.100">
      {card.workItem !== null && <Heading as="h4">{card.workItem.key} {card.workItem.summary}</Heading>}
      <Text>Release: {card.release}</Text>
      <Text>Lane: {card.lane}</Text>
      {clear ? (
        <Lozenge appearance="success">Clear to merge</Lozenge>
      ) : (
        <Stack space="space.050">
          <Text>Waits on: {card.waitsOn.join(', ')}</Text>
          {card.holds.map((hold) => (
            <Text key={hold}>• {hold}</Text>
          ))}
          <Text>
            shipmill's merge check shows these as advice. It blocks the merge only where a workspace
            admin made it Required, which needs Bitbucket Premium.
          </Text>
        </Stack>
      )}
    </Stack>
  );
}

ForgeReconciler.render(<App />);
