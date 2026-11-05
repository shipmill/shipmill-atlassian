// A Jira work item key as Jira writes it: a project key, a dash and a number
const JIRA_KEY = /\b[A-Z][A-Z0-9_]+-[1-9]\d*\b/;
const WHOLE_JIRA_KEY = /^[A-Z][A-Z0-9_]+-[1-9]\d*$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;

export type JiraKey = string & { readonly __brand: 'JiraKey' };
export type ProjectKey = string & { readonly __brand: 'ProjectKey' };

export function findJiraKey(text: string): JiraKey | undefined {
  return JIRA_KEY.exec(text)?.[0] as JiraKey | undefined;
}

export function jiraKey(text: string): JiraKey {
  if (!WHOLE_JIRA_KEY.test(text)) throw new Error(`not a Jira work item key: ${JSON.stringify(text)}`);
  return text as JiraKey;
}

export function projectKey(text: string): ProjectKey {
  if (!PROJECT_KEY.test(text)) throw new Error(`not a Jira project key: ${JSON.stringify(text)}`);
  return text as ProjectKey;
}

export function projectOf(key: JiraKey): ProjectKey {
  return key.slice(0, key.lastIndexOf('-')) as ProjectKey;
}
