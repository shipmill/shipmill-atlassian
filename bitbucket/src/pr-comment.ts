import { optionLine, type AskedQuestion } from '@shipmill-atlassian/shared/decision';
import type { JiraKey } from '@shipmill-atlassian/shared/jira-key';
import type { Person } from '@shipmill-atlassian/shared/release';
import { DECISION_TASK_PREFIX } from './holds';

// The Markdown shipmill posts on a pull request: the question in the frame of shipmill's
// needs-decision protocol (the decider mentioned, the options numbered with the
// recommendation first, the reply line), the task that holds the merge, the relay "Decision
// by `@x`, relayed by shipmill", and the note asking for a number. The protocol's hidden
// marker line lives in the app's storage instead (see question-store.ts).

export const AGENT = 'shipmill';

// Bitbucket's raw mention of an Atlassian account, which notifies them
function mention(person: Person): string {
  return `@{${person.accountId}}`;
}

// A login in a code span, so the record doesn't notify them again
function quiet(person: Person): string {
  return `\`@${person.displayName.replaceAll('`', "'")}\``;
}

export function questionBody(key: JiraKey, asked: AskedQuestion): string {
  const reply = asked.llm
    ? 'Reply here with a number or your own answer; shipmill takes this up as soon as you reply.'
    : 'Reply here with a number; shipmill takes this up as soon as you reply.';
  return [
    `${mention(asked.decider)} Decision needed: ${asked.question}`,
    '',
    ...asked.options.map((option, index) => `${index + 1}. ${optionLine(option, index)}`),
    '',
    `Evidence: asked on ${key} in Jira, the work item this pull request names; the answer is recorded there.`,
    '',
    reply,
  ].join('\n');
}

export function taskText(asked: AskedQuestion): string {
  return `${DECISION_TASK_PREFIX}${asked.question}`;
}

// where: "on this pull request" or "in Jira"
export function relayBody(decider: Person, answer: string, where: string): string {
  return [`Decision by ${quiet(decider)}, relayed by ${AGENT}`, '', `Answered ${where}: ${answer}`].join('\n');
}

export function unreadBody(decider: Person, options: number): string {
  return `${AGENT} read no option number in the reply by ${quiet(decider)}. Reply with a number from 1 to ${options}; the decision stays open until then.`;
}
