// The demo release every later stage tests on: one Jira project with fix version 2.4, its
// work items (three of them blocking decisions labelled needs-decision), and a Bitbucket
// repository whose pull requests name those work items, one of them carrying a decision task

import { NEEDS_DECISION } from '@shipmill-atlassian/shared/release';

export const FIX_VERSION = '2.4';
export const DECISION_LABEL = NEEDS_DECISION;
export const DEFAULT_PROJECT_NAME = 'Harbor';
export const DEFAULT_PROJECT_KEY = 'HRB';
export const DEFAULT_REPOSITORY = 'harbor';

export type IssueType = 'Story' | 'Task' | 'Bug';

export type SeedItem = {
  // Stable across runs: the seed finds an item it made by this id, never by its key
  id: string;
  type: IssueType;
  summary: string;
  description: string;
  labels: readonly string[];
  // A pull request for the item: the change it carries, one line
  pullRequest?: string;
  // A decision the pull request asks, as a task "Decision needed: <question>" on it
  pullRequestDecision?: string;
};

export const ITEMS: readonly SeedItem[] = [
  {
    id: 'export-csv',
    type: 'Story',
    summary: 'Export invoices as CSV',
    description: 'Accountants want the filtered invoice list as a CSV file.',
    labels: [],
    pullRequest: 'Adds a CSV export to the invoice list',
  },
  {
    id: 'retire-v1-tokens',
    type: 'Task',
    summary: 'Retire API v1 tokens',
    description:
      'Decision needed: retire v1 tokens in 2.4, or keep them for one more release? ' +
      'Fourteen customers still call the API with a v1 token every week.',
    labels: [DECISION_LABEL],
    pullRequest: 'Rejects API v1 tokens with a pointer to the migration guide',
  },
  {
    id: 'pricing-page',
    type: 'Story',
    summary: 'Roll out the new pricing page',
    description:
      'Decision needed: show the new prices to every account in 2.4, or to new sign-ups ' +
      'only? Existing accounts keep their plan either way.',
    labels: [DECISION_LABEL],
    pullRequest: 'Serves the new pricing page behind the new-pricing flag',
  },
  {
    id: 'invoice-migration',
    type: 'Task',
    summary: 'Migrate the invoices table to the new schema',
    description: 'Moves line items into their own table so totals stop drifting.',
    labels: [],
    pullRequest: 'Adds the migration that splits line items out of invoices',
    pullRequestDecision:
      'run this migration during the 2.4 rollout, or in a separate maintenance window? ' +
      'It locks the invoices table for about 20 minutes.',
  },
  {
    id: 'webhook-retries',
    type: 'Story',
    summary: 'Retry failed webhooks with backoff',
    description: 'Retry a failed webhook up to five times over an hour.',
    labels: [],
    pullRequest: 'Retries failed webhooks with exponential backoff',
  },
  {
    id: 'pdf-due-date',
    type: 'Bug',
    summary: 'Invoice PDFs show the wrong due date across time zones',
    description: 'A customer in UTC-8 sees a due date one day earlier than the web app.',
    labels: [],
    pullRequest: 'Renders PDF due dates in the account time zone',
  },
  {
    id: 'search-timeout',
    type: 'Bug',
    summary: 'Customer search times out above 50k records',
    description: 'The search query scans every customer; it needs the name index.',
    labels: [],
    pullRequest: 'Uses the name index for customer search',
  },
  {
    id: 'node-24',
    type: 'Task',
    summary: 'Upgrade the runtime to Node 24',
    description: 'Node 20 leaves maintenance before the next release.',
    labels: [],
    pullRequest: 'Moves the runtime and CI to Node 24',
  },
  {
    id: 'sso-okta',
    type: 'Story',
    summary: 'Sign in with Okta SSO',
    description:
      'Decision needed: require Okta sign-in for every member of a Business workspace, or ' +
      'let each member choose? Two pilot customers asked for opposite defaults.',
    labels: [DECISION_LABEL],
  },
  {
    id: 'dark-mode',
    type: 'Story',
    summary: 'Dark mode for the dashboard',
    description: 'Follow the system setting, with a manual switch in the profile menu.',
    labels: [],
  },
  {
    id: 'audit-log',
    type: 'Story',
    summary: 'Audit log for role changes',
    description: 'Record who changed whose role, and when.',
    labels: [],
  },
  {
    id: 'bulk-archive',
    type: 'Story',
    summary: 'Archive invoices in bulk',
    description: 'Select many paid invoices and archive them in one step.',
    labels: [],
  },
  {
    id: 'reminder-emails',
    type: 'Story',
    summary: 'Payment reminder emails',
    description: 'Remind the customer three days before and on the due date.',
    labels: [],
  },
  {
    id: 'jpy-rounding',
    type: 'Bug',
    summary: 'Rounding error on JPY totals',
    description: 'Totals in a currency without minor units show a fraction.',
    labels: [],
  },
  {
    id: 'rate-limit-headers',
    type: 'Task',
    summary: 'Return rate limit headers on every API response',
    description: 'Clients cannot see their remaining quota today.',
    labels: [],
  },
  {
    id: 'onboarding-checklist',
    type: 'Story',
    summary: 'Onboarding checklist for new workspaces',
    description: 'Five steps from sign-up to the first invoice sent.',
    labels: [],
  },
  {
    id: 'editor-overflow',
    type: 'Bug',
    summary: 'Invoice editor overflows on small screens',
    description: 'The line item table scrolls off the page below 400 px.',
    labels: [],
  },
  {
    id: 'stripe-sdk',
    type: 'Task',
    summary: 'Update the Stripe SDK to the current major version',
    description: 'The pinned major version stops receiving fixes this quarter.',
    labels: [],
  },
  {
    id: 'v2-pagination-docs',
    type: 'Task',
    summary: 'Document the v2 API pagination',
    description: 'Cursor pagination is live but undocumented.',
    labels: [],
  },
  {
    id: 'csv-import-row',
    type: 'Bug',
    summary: 'CSV import reports the wrong row on errors',
    description: 'The row number skips the header, so it is off by one.',
    labels: [],
  },
];

// The files at the root of the repository's main branch
export function mainFiles(projectName: string, repository: string): ReadonlyMap<string, string> {
  return new Map([
    [
      'shipmill.toml',
      [
        '# The release policy shipmill reads for this repository',
        `name = "${repository}"`,
        'mode = "dry-run"',
        'branch = "main"',
        'version_files = "none"',
        '',
        '[changelog]',
        'style = "keep-a-changelog"',
        '',
        '[gates]',
        'blocker_label = "release-blocker"',
        'blocker_lanes = ["stable"]',
        '',
        '[lanes.stable]',
        'quiet_minutes = 30',
        '',
      ].join('\n'),
    ],
    [
      'README.md',
      [
        `# ${projectName}`,
        '',
        'A demo invoicing app for shipmill Release Decisions. The seed script in',
        'shipmill-atlassian made this repository; its pull requests name the work items of',
        `${projectName} ${FIX_VERSION} in Jira.`,
        '',
      ].join('\n'),
    ],
  ]);
}
