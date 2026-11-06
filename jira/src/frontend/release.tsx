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
import { pullRequestLabel } from '@shipmill-atlassian/shared/pull-requests';
import type { AskQueued, PanelView } from '../panel-resolver';
import type { PullRequestDecision } from '../finder';
import type { PanelDecision } from '../release-panel';

// Without metadata requested, invoke resolves to the resolver's return value itself
const getPanel = (version?: string) => invoke('getPanel', version === undefined ? {} : { version }) as Promise<PanelView>;
const ask = (version: string) => invoke('ask', { version }) as Promise<AskQueued>;

function queuedText(queued: AskQueued): string {
  const graph = queued.graphRead.length === 0 ? 'The Teamwork Graph had no evidence to cite.' : `The comments cite the Teamwork Graph on ${queued.graphRead.join(', ')}.`;
  return `Asking the open decisions of ${queued.version} in the background; refresh in a minute to see them asked. ${graph}`;
}

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
                {pullRequestLabel(pullRequest)}
              </Link>
            ))}
          </Inline>
        )}
      </Stack>
    </Box>
  );
}

// Opened on the pull request as a "Decision needed:" task, and answered there
function OnPullRequest({ decision }: { decision: PullRequestDecision }) {
  const { pullRequest } = decision;
  return (
    <Box padding="space.150" xcss={{ borderColor: 'color.border', borderStyle: 'solid', borderWidth: 'border.width', borderRadius: 'radius.medium' }}>
      <Stack space="space.075">
        <Inline space="space.100" alignBlock="center">
          <Link href={`/browse/${decision.key}`}>{decision.key}</Link>
          <Text>on</Text>
          <Link href={pullRequest.url} openNewTab>
            {pullRequestLabel(pullRequest)}
          </Link>
        </Inline>
        <Text weight="medium">{decision.question}</Text>
        <Text>
          {decision.askOf === null ? 'Answer by resolving the task on the pull request' : `Waits on ${decision.askOf.displayName}, answer by resolving the task on the pull request`}
        </Text>
      </Stack>
    </Box>
  );
}

function App() {
  const [view, setView] = useState<PanelView>();
  const [picked, setPicked] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [queued, setQueued] = useState<AskQueued>();

  const load = (version?: string) => {
    setLoading(true);
    setQueued(undefined);
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

  // Runs as the viewing user, so the resolver can read the Teamwork Graph
  const askPicked = (version: string) => {
    setAsking(true);
    ask(version).then(
      (next) => {
        setQueued(next);
        setAsking(false);
      },
      (e: Error) => setError(e.message),
    );
  };

  if (error !== undefined) return <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>;
  if (view === undefined) return <Spinner />;
  if (view.panel === null) return <Text>This project has no open fix version.</Text>;

  const { panel } = view;
  const blocking = panel.decisions.length + panel.pullRequestDecisions.length;
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
        <Button appearance="primary" onClick={() => askPicked(panel.version)} isDisabled={loading || asking}>
          Ask decisions
        </Button>
      </Inline>
      {queued !== undefined && (
        <SectionMessage appearance="information">
          <Text>{queuedText(queued)}</Text>
        </SectionMessage>
      )}
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
            <Heading as="h3">{`${blocking} ${blocking === 1 ? 'decision blocks' : 'decisions block'} ${panel.version}`}</Heading>
          </Inline>
          {panel.decisions.map((decision) => (
            <Decision key={decision.key} decision={decision} />
          ))}
          {panel.pullRequestDecisions.length > 0 && <Heading as="h4">Opened on pull requests</Heading>}
          {panel.pullRequestDecisions.map((decision) => (
            <OnPullRequest key={`${decision.pullRequest.url}#${decision.taskId}`} decision={decision} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

ForgeReconciler.render(<App />);
