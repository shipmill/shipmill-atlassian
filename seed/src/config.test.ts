import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from './config';

const ENV = { ATLASSIAN_EMAIL: 'dev@example.com', JIRA_API_TOKEN: 'jira-token', BITBUCKET_API_TOKEN: 'bb-token' };
const ARGS = ['--jira-site', 'example.atlassian.net', '--bitbucket-workspace', 'example'];

test('arguments name the targets and the environment holds the tokens', () => {
  assert.deepEqual(parseConfig(ARGS, ENV), {
    jiraSite: 'example.atlassian.net',
    workspace: 'example',
    projectKey: 'HRB',
    projectName: 'Harbor',
    repository: 'harbor',
    dryRun: false,
    email: 'dev@example.com',
    jiraToken: 'jira-token',
    bitbucketToken: 'bb-token',
  });
});

test('a missing token stops the run', () => {
  assert.throws(() => parseConfig(ARGS, { ...ENV, BITBUCKET_API_TOKEN: '' }), /BITBUCKET_API_TOKEN is not set/);
  assert.throws(() => parseConfig(ARGS, { ...ENV, JIRA_API_TOKEN: ' x ' }), /surrounding whitespace/);
});

test('malformed targets stop the run', () => {
  assert.throws(() => parseConfig(['--bitbucket-workspace', 'example'], ENV), /--jira-site is required/);
  assert.throws(
    () => parseConfig(['--jira-site', 'https://example.atlassian.net', '--bitbucket-workspace', 'example'], ENV),
    /--jira-site must match/,
  );
  assert.throws(() => parseConfig([...ARGS, '--project-key', 'hrb'], ENV), /--project-key must match/);
  assert.throws(() => parseConfig([...ARGS, '--project-name', ' Harbor'], ENV), /--project-name must match/);
  assert.throws(() => parseConfig([...ARGS, '--token', 'x'], ENV), /Unknown option/);
  assert.throws(() => parseConfig([...ARGS, 'extra'], ENV), /unexpected arguments/);
});

test('a second demo project gets its own key, name and repository', () => {
  const config = parseConfig([...ARGS, '--project-key', 'DEMO', '--project-name', 'Harbor demo', '--repository', 'harbor-demo'], ENV);
  assert.deepEqual([config.projectKey, config.projectName, config.repository], ['DEMO', 'Harbor demo', 'harbor-demo']);
});
