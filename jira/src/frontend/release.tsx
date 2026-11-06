import { invoke } from '@forge/bridge';
import ForgeReconciler, {
  Box,
  Button,
  Heading,
  Inline,
  Label,
  Link,
  Lozenge,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Text,
} from '@forge/react';
import React, { useEffect, useState } from 'react';
import type { PanelView } from '../panel-resolver';
import type { PanelDecision } from '../release-panel';

// Without metadata requested, invoke resolves to the resolver's return value itself
const getPanel = (version?: string) => invoke('getPanel', version === undefined ? {} : { version }) as Promise<PanelView>;

function asked(decision: PanelDecision): string {
  return decision.askedAt === null ? 'not asked yet' : `asked ${decision.askedAt.slice(0, 10)}`;
}

function Decision({ decision }: { decision: PanelDecision }) {
  return (
    <Box padding="space.150" xcss={{ borderColor: 'color.border', borderStyle: 'solid', borderWidth: 'border.width', borderRadius: 'radius.medium' }}>
      <Stack space="space.075">
        <Inline space="space.100" alignBlock="center">
          <Link href={`/browse/${decision.key}`}>{decision.key}</Link>
          <Text>{decision.summary}</Text>
        </Inline>
        <Text weight="medium">{decision.question}</Text>
        <Text>
          Waits on {decision.waitsOn.displayName}, {asked(decision)}
        </Text>
        {decision.pullRequests.length > 0 && (
          <Inline space="space.100">
            <Text>Answer in Jira or on</Text>
            {decision.pullRequests.map((pullRequest) => (
              <Link key={pullRequest.url} href={pullRequest.url} openNewTab>
                {`${pullRequest.repository} #${pullRequest.id}`}
              </Link>
            ))}
          </Inline>
        )}
      </Stack>
    </Box>
  );
}

function App() {
  const [view, setView] = useState<PanelView>();
  const [picked, setPicked] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = (version?: string) => {
    setLoading(true);
    getPanel(version).then(
      (next) => {
        setView(next);
        setPicked(next.panel?.version);
        setLoading(false);
      },
      (e: Error) => setError(e.message),
    );
  };

  useEffect(() => load(), []);

  if (error !== undefined) return <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>;
  if (view === undefined) return <Spinner />;
  if (view.panel === null) return <Text>This project has no open fix version.</Text>;

  const { panel } = view;
  const options = view.versions.map((name) => ({ label: name, value: name }));
  return (
    <Stack space="space.200">
      <Inline space="space.150" alignBlock="end">
        <Box xcss={{ width: '200px' }}>
          <Label labelFor="version">Fix version</Label>
          <Select
            inputId="version"
            options={options}
            value={options.find((option) => option.value === picked)}
            onChange={(option: { value: string }) => load(option.value)}
          />
        </Box>
        <Button onClick={() => load(picked)} isDisabled={loading}>
          Refresh
        </Button>
      </Inline>
      {loading ? (
        <Spinner />
      ) : panel.ready ? (
        <Inline space="space.100" alignBlock="center">
          <Lozenge appearance="success" isBold>
            Ready to ship
          </Lozenge>
          <Text>{`No decision blocks ${panel.version}.`}</Text>
        </Inline>
      ) : (
        <Stack space="space.150">
          <Inline space="space.100" alignBlock="center">
            <Lozenge appearance="moved" isBold>
              Blocked
            </Lozenge>
            <Heading as="h3">{`${panel.decisions.length} ${panel.decisions.length === 1 ? 'decision blocks' : 'decisions block'} ${panel.version}, oldest first`}</Heading>
          </Inline>
          {panel.decisions.map((decision) => (
            <Decision key={decision.key} decision={decision} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

ForgeReconciler.render(<App />);
