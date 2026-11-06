import type { JiraKey } from '@shipmill-atlassian/shared/jira-key';
import type { WorkItemStatus } from '@shipmill-atlassian/shared/work-item';
import type { BuildStatus, PullRequest, Task } from './bitbucket-rest';
import type { Lane } from './policy';

// What holds a pull request back from merging, worked out from facts the check and the card
// gather the same way. Pure, so each hold is tested failing and then lifted.

export type Facts = {
  pullRequest: PullRequest;
  // The work item the title names; null when it names none
  workItem: WorkItemStatus | null;
  // The build statuses on the pull request's head commit
  statuses: BuildStatus[];
  tasks: Task[];
  // The breaking entries the pull request adds to the changelog
  breaking: string[];
  // The lanes a merge releases in; null when the destination has no shipmill.toml
  lanes: Lane[] | null;
};

export type HoldKind = 'work-item' | 'decision' | 'build' | 'breaking';

export type Hold = { kind: HoldKind; message: string; waitsOn: string };

// shipmill's way of asking on a pull request: a task "Decision needed: <question>"
export const DECISION_TASK_PREFIX = 'Decision needed: ';
const DECISION_TASK = /^\s*Decision needed:\s*(.+)$/is;

// The question a task asks, when it is a decision task
export function decisionTaskQuestion(task: Task): string | undefined {
  const asked = DECISION_TASK.exec(task.text)?.[1];
  return asked === undefined ? undefined : oneLine(asked);
}

function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function short(commit: string): string {
  return commit.slice(0, 12);
}

function deciderName(workItem: WorkItemStatus | null): string {
  if (workItem === null) return 'a decider: name a Jira work item in the title';
  if (!workItem.found) return `a decider: ${workItem.key} is not on the paired Jira site`;
  return workItem.decider?.displayName ?? `an owner for ${workItem.key}`;
}

export function holds(facts: Facts): Hold[] {
  const { pullRequest, workItem } = facts;
  const found: Hold[] = [];
  const decider = deciderName(workItem);

  if (workItem !== null && !workItem.found) {
    found.push({ kind: 'work-item', message: `${workItem.key} is not a work item on the paired Jira site`, waitsOn: pullRequest.author.displayName });
  }
  if (workItem?.found === true) {
    for (const question of workItem.openDecisions) {
      found.push({ kind: 'decision', message: `${workItem.key} waits on a decision: ${question}`, waitsOn: decider });
    }
  }
  // shipmill asks the work item's decision on its pull requests too: that task is the same hold
  const onItem = new Set(workItem?.found === true ? workItem.openDecisions.map(oneLine) : []);
  for (const task of facts.tasks) {
    const asked = decisionTaskQuestion(task);
    if (task.state === 'UNRESOLVED' && asked !== undefined && !onItem.has(asked)) {
      found.push({ kind: 'decision', message: `this pull request waits on a decision: ${asked}`, waitsOn: decider });
    }
  }

  const head = short(pullRequest.sourceCommit);
  if (facts.statuses.length === 0) {
    found.push({ kind: 'build', message: `no build has reported on ${head}`, waitsOn: 'the build' });
  }
  for (const status of facts.statuses) {
    if (status.state === 'SUCCESSFUL') continue;
    const running = status.state === 'INPROGRESS';
    found.push({
      kind: 'build',
      message: `build ${status.name} is ${running ? 'still running' : status.state.toLowerCase()} on ${head}`,
      waitsOn: running ? 'the build' : pullRequest.author.displayName,
    });
  }

  if (facts.breaking.length > 0) {
    const deciderId = workItem?.found === true ? workItem.decider?.accountId : undefined;
    const approved = deciderId !== undefined && pullRequest.participants.some((p) => p.accountId === deciderId && p.approved);
    if (!approved) {
      const entries = facts.breaking.map((entry) => `"${entry}"`).join(', ');
      const how = deciderId === undefined ? 'nobody can decide it yet' : `${decider} has not approved it`;
      found.push({ kind: 'breaking', message: `the breaking change ${entries} is undecided: ${how}`, waitsOn: decider });
    }
  }
  return found;
}

// A merge check result. On a free workspace the check can't be Required (Bitbucket
// Premium), so a failure only warns: the message says so rather than claiming a block.
export type CheckResult = { success: boolean; message: string };

export function checkResult(facts: Facts): CheckResult {
  const found = holds(facts);
  if (found.length === 0) {
    return { success: true, message: `shipmill: clear to merge, no open decision and the build is green on ${short(facts.pullRequest.sourceCommit)}` };
  }
  const listed = found.map((hold) => hold.message).join('; ');
  return {
    success: false,
    message: `shipmill advises waiting: ${listed}. Waits on ${waitsOn(found).join(', ')}. This blocks the merge only where the check is Required (Bitbucket Premium)`,
  };
}

function waitsOn(found: Hold[]): string[] {
  return [...new Set(found.map((hold) => hold.waitsOn))];
}

// The pull request card: the release the work goes out in, the lane, and who it waits on
export type Card = {
  workItem: { key: JiraKey; summary: string } | null;
  release: string;
  lane: string;
  waitsOn: string[];
  holds: string[];
};

export function card(facts: Facts): Card {
  const { workItem, lanes } = facts;
  let release: string;
  if (workItem === null) release = 'none: the title names no Jira work item';
  else if (!workItem.found) release = `unknown: ${workItem.key} is not on the paired Jira site`;
  else if (workItem.fixVersions.length === 0) release = `none: ${workItem.key} has no fix version`;
  else release = workItem.fixVersions.join(', ');

  let lane: string;
  if (lanes === null) lane = `none: ${facts.pullRequest.destinationBranch} has no shipmill.toml`;
  else if (lanes.length === 0) lane = `none: ${facts.pullRequest.destinationBranch} is not released by shipmill`;
  else lane = lanes.join(', ');

  const found = holds(facts);
  return {
    workItem: workItem?.found === true ? { key: workItem.key, summary: workItem.summary } : null,
    release,
    lane,
    waitsOn: found.length === 0 ? [] : waitsOn(found),
    holds: found.map((hold) => hold.message),
  };
}
