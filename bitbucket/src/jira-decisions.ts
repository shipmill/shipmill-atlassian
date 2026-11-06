import { parseDecisionView, parseReplyOutcome } from '@shipmill-atlassian/shared/decision';
import { ParseError } from '@shipmill-atlassian/shared/parse';
import { forgeBitbucket } from './bitbucket-rest';
import { sendToJira } from './bridge';
import { NotPairedError } from './facts';
import type { Decisions, QuestionDeps } from './pr-decision';
import { kvsQuestions } from './question-store';
import { pairing } from './settings';

// The paired Jira app's decisions over the signed bridge

async function paired() {
  const found = await pairing();
  if (found === undefined) throw new NotPairedError();
  return found;
}

export const jiraDecisions: Decisions = {
  async view(key) {
    const view = parseDecisionView(await sendToJira(await paired(), { kind: 'decision', sentAt: Date.now(), key }));
    if (view.key !== key) throw new ParseError('decision.key', `asked about ${key}, the answer is about ${view.key}`);
    return view;
  },
  async reply(reply) {
    return parseReplyOutcome(await sendToJira(await paired(), { kind: 'decision-reply', sentAt: Date.now(), ...reply }));
  },
};

export function forgeQuestions(workspace: string, repository: string): QuestionDeps {
  return { rest: forgeBitbucket(workspace, repository), store: kvsQuestions, decisions: jiraDecisions, repository, now: () => new Date() };
}
