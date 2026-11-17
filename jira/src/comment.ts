import { optionLine, optionLines, type DecisionOption } from '@shipmill-atlassian/shared/decision';
import type { Person } from '@shipmill-atlassian/shared/release';
import { evidenceText, type EvidencePart, type Prepared } from './prepare';
import type { Care } from './question';

export { optionLine, optionLines };

// The comments shipmill posts on a work item, as Jira's ADF. They follow shipmill's
// needs-decision protocol line for line (skills/github-issue-triage/references/
// needs-decision.md in shipmill/shipmill): the question with the decider mentioned, the
// options numbered with the recommendation marked, the reply line; and the relay, "Decision
// by `@x`, relayed by shipmill". Jira has no hidden HTML comment, so the protocol's marker
// line lives in the work item's shipmill-questions property instead (see question.ts),
// and frameText gives the text with the marker, as shipmill would post it on GitHub.

type Mark = { type: 'code' } | { type: 'link'; attrs: { href: string } };
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

// What a question comment says. A question shipmill prepares cites its evidence and puts the
// recommended option first; an agent's own question has no evidence line and names the agent
export type QuestionFrame = {
  askedOf: Person;
  question: string;
  options: DecisionOption[];
  // The number of the recommended option, or null when the agent recommends none
  recommended: number | null;
  evidence: EvidencePart[];
  // Whether a free-text reply is read by Claude; with it off the reply is an option number
  llm: boolean;
  // The agent that asked for itself and how careful the answer must be; null for shipmill's own
  agent: { name: string; care: Care } | null;
};

export function preparedFrame(prepared: Prepared): QuestionFrame {
  return {
    askedOf: prepared.decider,
    question: prepared.question,
    options: prepared.options,
    recommended: 1,
    evidence: prepared.evidence,
    llm: prepared.llm,
    agent: null,
  };
}

function replyLine(frame: QuestionFrame): string {
  return frame.llm
    ? 'Reply here with a number or your own answer; shipmill takes this up as soon as you reply.'
    : 'Reply here with a number; shipmill takes this up as soon as you reply.';
}

// careful: the agent says the answer is irreversible, breaking, or outside its mandate
function agentLine(agent: { name: string; care: Care }): string {
  return agent.care === 'careful'
    ? `Asked by ${agent.name}, an agent, which marked this careful: it is answered on its own, never in a batch.`
    : `Asked by ${agent.name}, an agent, which marked this routine.`;
}

// The evidence in ADF: its links as link marks, so a pull request reads as "harbor #5"
function evidenceParagraph(evidence: readonly EvidencePart[]): Paragraph {
  return paragraph(
    text('Evidence: '),
    ...evidence.map((part) => (typeof part === 'string' ? text(part) : text(part.text, [{ type: 'link', attrs: { href: part.url } }]))),
  );
}

// The question, with the person asked mentioned so Jira notifies them: the question waits on them
export function questionComment(frame: QuestionFrame): Adf {
  return {
    type: 'doc',
    version: 1,
    content: [
      paragraph(
        { type: 'mention', attrs: { id: frame.askedOf.accountId, text: at(frame.askedOf) } },
        text(` Decision needed: ${frame.question}`),
      ),
      {
        type: 'orderedList',
        attrs: { order: 1 },
        content: frame.options.map((option, index) => ({
          type: 'listItem',
          content: [paragraph(text(optionLine(option, index + 1 === frame.recommended)))],
        })),
      },
      ...(frame.evidence.length === 0 ? [] : [evidenceParagraph(frame.evidence)]),
      ...(frame.agent === null ? [] : [paragraph(text(agentLine(frame.agent)))]),
      paragraph(text(replyLine(frame))),
    ],
  };
}

// The question as shipmill's protocol writes it, marker included
export function frameText(frame: QuestionFrame): string {
  return [
    MARKER,
    `${at(frame.askedOf)} Decision needed: ${frame.question}`,
    '',
    ...optionLines(frame.options, frame.recommended),
    '',
    ...(frame.evidence.length === 0 ? [] : [`Evidence: ${evidenceText(frame.evidence)}`, '']),
    ...(frame.agent === null ? [] : [agentLine(frame.agent), '']),
    replyLine(frame),
  ].join('\n');
}

// The record of who decided: the login in a code span, so the record doesn't notify them.
// where says where the answer was given: "in Jira", or on a pull request.
export function relayComment(decider: Person, answer: string, where = 'in Jira'): Adf {
  return {
    type: 'doc',
    version: 1,
    content: [
      paragraph(text('Decision by '), text(at(decider), [{ type: 'code' }]), text(`, relayed by ${AGENT}`)),
      paragraph(text(`Answered ${where}: ${answer}`)),
    ],
  };
}

// The asker took the question back: nothing waits on the person any more
export function withdrawnComment(agent: string, askedOf: Person): Adf {
  return {
    type: 'doc',
    version: 1,
    content: [
      paragraph(text(`Question withdrawn by ${agent}: it no longer waits on `), text(at(askedOf), [{ type: 'code' }]), text('.')),
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
