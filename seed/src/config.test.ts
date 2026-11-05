import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adfText } from './adf-text';
import { parseConfig } from './config';

const ENV = { ATLASSIAN_EMAIL: 'dev@example.com', JIRA_API_TOKEN: 'jira-token', BITBUCKET_API_TOKEN: 'bb-token' };
const ARGS = ['--jira-site', 'example.atlassian.net', '--bitbucket-workspace', 'example'];

test('arguments name the targets and the environment holds the tokens', () => {
  assert.deepEqual(parseConfig(ARGS, ENV), {
    jiraSite: 'example.atlassian.net',
    workspace: 'example',
    projectKey: 'HRB',
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
  assert.throws(() => parseConfig([...ARGS, '--token', 'x'], ENV), /Unknown option/);
  assert.throws(() => parseConfig([...ARGS, 'extra'], ENV), /unexpected arguments/);
});

test('ADF bodies read back as their text', () => {
  const body = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'One ' }, { type: 'text', text: 'line' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Two' }, { type: 'hardBreak' }, { type: 'text', text: 'x' }] },
      { type: 'rule' },
    ],
  };
  assert.equal(adfText(body), 'One line\nTwo\nx\n');
  assert.throws(() => adfText({ type: 'text' }), /needs text/);
});
