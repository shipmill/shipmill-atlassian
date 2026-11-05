import { jiraKey, type JiraKey } from './jira-key';
import { ParseError, boolean, list, nonEmpty, object } from './parse';
import { parsePerson, type Person } from './release';

// What the Jira app tells the Bitbucket app about the work item a pull request names: its
// release, its open decisions, and who decides them. The merge check and the pull request
// card read it over the bridge.

export type WorkItemStatus =
  | { key: JiraKey; found: false }
  | {
      key: JiraKey;
      found: true;
      summary: string;
      fixVersions: string[];
      // The question of each open decision on the item, oldest first
      openDecisions: string[];
      // Who decides for the item: its owner, else its reporter
      decider: Person | null;
    };

export function parseWorkItemStatus(value: unknown, path = 'workItem'): WorkItemStatus {
  const fields = object(value, path);
  const key = jiraKey(nonEmpty(fields.key, `${path}.key`));
  if (!boolean(fields.found, `${path}.found`)) return { key, found: false };
  return {
    key,
    found: true,
    summary: nonEmpty(fields.summary, `${path}.summary`),
    fixVersions: list(fields.fixVersions, `${path}.fixVersions`, nonEmpty),
    openDecisions: list(fields.openDecisions, `${path}.openDecisions`, nonEmpty),
    decider: fields.decider === null ? null : parsePerson(fields.decider, `${path}.decider`),
  };
}

export function expectKey(status: WorkItemStatus, key: JiraKey, path = 'workItem'): WorkItemStatus {
  if (status.key !== key) throw new ParseError(`${path}.key`, `asked about ${key}, the answer is about ${status.key}`);
  return status;
}
