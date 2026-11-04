// A Jira work item key as Jira writes it: a project key, a dash and a number
const JIRA_KEY = /\b[A-Z][A-Z0-9_]+-[1-9]\d*\b/;

export function findJiraKey(text: string): string | undefined {
  return JIRA_KEY.exec(text)?.[0];
}
