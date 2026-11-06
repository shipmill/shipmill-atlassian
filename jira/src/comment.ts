import type { Person } from '@shipmill-atlassian/shared/release';
import type { DecisionOption, Prepared } from './prepare';

// The comments shipmill posts on a work item, as Jira's ADF. They follow shipmill's
// needs-decision protocol line for line (skills/github-issue-triage/references/
// needs-decision.md in shipmill/shipmill): the question with the decider mentioned, the
// options numbered with the recommendation first, the reply line; and the relay, "Decision
// by `@x`, relayed by shipmill". Jira has no hidden HTML comment, so the protocol's marker
// line lives in the work item's shipmill-decision property instead (see decision-state.ts),
// and frameText gives the text with the marker, as shipmill would post it on GitHub.

type Mark = { type: 'code' };
type Inline =
  | { type: 'text'; text: string; marks?: Mark[] }
  | { type: 'mention'; attrs: { id: string; text: string } };
type Paragraph = { type: 'paragraph'; content: Inline[] };
type OrderedList = { type: 'orderedList'; attrs: { order: 1 }; content: { type: 'listItem'; content: Paragraph[] }[] };
export type Adf = { type: 'doc'; version: 1; content: (Paragraph | OrderedList)[] };

export const MARKER = '<!-- shipmill:needs-decision -->';
export const AGENT = 'shipmill';

function text(value: string, marks?: Mark[]): Inline {
  if (value === '') throw new Error('an ADF text node needs text');
  return marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks };
}

function paragraph(...content: Inline[]): Paragraph {
  return { type: 'paragraph', content };
}

function at(person: Person): string {
  return `@${person.displayName}`;
}

export function optionLine(option: DecisionOption, index: number): string {
  return index === 0 ? `${option.text} (recommended): ${option.reason}` : `${option.text}: ${option.reason}`;
}

function replyLine(prepared: Prepared): string {
  return prepared.llm
    ? 'Reply here with a number or your own answer; shipmill takes this up as soon as you reply.'
    : 'Reply here with a number; shipmill takes this up as soon as you reply.';
}

function evidenceLine(prepared: Prepared): string {
  return `Evidence: ${prepared.evidence}`;
}

// The question, with the decider mentioned so Jira notifies them: the question waits on them
export function questionComment(prepared: Prepared): Adf {
  return {
    type: 'doc',
    version: 1,
    content: [
      paragraph(
        { type: 'mention', attrs: { id: prepared.decider.accountId, text: at(prepared.decider) } },
        text(` Decision needed: ${prepared.question}`),
      ),
      {
        type: 'orderedList',
        attrs: { order: 1 },
        content: prepared.options.map((option, index) => ({ type: 'listItem', content: [paragraph(text(optionLine(option, index)))] })),
      },
      paragraph(text(evidenceLine(prepared))),
      paragraph(text(replyLine(prepared))),
    ],
  };
}

// The question as shipmill's protocol writes it, marker included
export function frameText(prepared: Prepared): string {
  return [
    MARKER,
    `${at(prepared.decider)} Decision needed: ${prepared.question}`,
    '',
    ...prepared.options.map((option, index) => `${index + 1}. ${optionLine(option, index)}`),
    '',
    evidenceLine(prepared),
    '',
    replyLine(prepared),
  ].join('\n');
}

// The record of who decided: the login in a code span, so the record doesn't notify them
export function relayComment(decider: Person, answer: string): Adf {
  return {
    type: 'doc',
    version: 1,
    content: [
      paragraph(text('Decision by '), text(at(decider), [{ type: 'code' }]), text(`, relayed by ${AGENT}`)),
      paragraph(text(`Answered in Jira: ${answer}`)),
    ],
  };
}

// While the LLM is off a reply is read as an option number; say so when one carries none
export function unreadComment(decider: Person, options: number): Adf {
  return {
    type: 'doc',
    version: 1,
    content: [
      paragraph(
        text(`${AGENT} read no option number in the reply by `),
        text(at(decider), [{ type: 'code' }]),
        text(`. Reply with a number from 1 to ${options}; the decision stays open until then.`),
      ),
    ],
  };
}
