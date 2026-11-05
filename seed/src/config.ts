// The seed's arguments and credentials: arguments name the targets, the environment holds
// the secrets, and anything malformed stops the run before a request is made

import { parseArgs } from 'node:util';
import { DEFAULT_PROJECT_KEY, DEFAULT_REPOSITORY } from './demo';

export const ENV_EMAIL = 'ATLASSIAN_EMAIL';
export const ENV_JIRA_TOKEN = 'JIRA_API_TOKEN';
export const ENV_BITBUCKET_TOKEN = 'BITBUCKET_API_TOKEN';

export const USAGE = `Usage: npm run seed -- --jira-site <name>.atlassian.net --bitbucket-workspace <workspace>
       [--project-key ${DEFAULT_PROJECT_KEY}] [--repository ${DEFAULT_REPOSITORY}] [--dry-run]

Environment: ${ENV_EMAIL}, ${ENV_JIRA_TOKEN}, ${ENV_BITBUCKET_TOKEN}`;

export type Config = {
  jiraSite: string;
  workspace: string;
  projectKey: string;
  repository: string;
  dryRun: boolean;
  email: string;
  jiraToken: string;
  bitbucketToken: string;
};

const JIRA_SITE = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/;
const WORKSPACE = /^[a-z0-9][a-z0-9_-]*$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
const REPOSITORY = /^[a-z0-9][a-z0-9._-]*$/;
const EMAIL = /^[^@\s]+@[^@\s]+$/;

export function parseConfig(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Config {
  const { values, positionals } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: true,
    options: {
      'jira-site': { type: 'string' },
      'bitbucket-workspace': { type: 'string' },
      'project-key': { type: 'string', default: DEFAULT_PROJECT_KEY },
      repository: { type: 'string', default: DEFAULT_REPOSITORY },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (positionals.length > 0) {
    throw new Error(`unexpected arguments: ${positionals.join(' ')}`);
  }
  return {
    jiraSite: match('--jira-site', values['jira-site'], JIRA_SITE),
    workspace: match('--bitbucket-workspace', values['bitbucket-workspace'], WORKSPACE),
    projectKey: match('--project-key', values['project-key'], PROJECT_KEY),
    repository: match('--repository', values.repository, REPOSITORY),
    dryRun: values['dry-run'],
    email: match(ENV_EMAIL, env[ENV_EMAIL], EMAIL),
    jiraToken: secret(ENV_JIRA_TOKEN, env[ENV_JIRA_TOKEN]),
    bitbucketToken: secret(ENV_BITBUCKET_TOKEN, env[ENV_BITBUCKET_TOKEN]),
  };
}

function match(name: string, value: string | undefined, pattern: RegExp): string {
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`);
  }
  if (!pattern.test(value)) {
    throw new Error(`${name} must match ${pattern.source}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function secret(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set`);
  }
  if (value !== value.trim()) {
    throw new Error(`${name} has surrounding whitespace`);
  }
  return value;
}
