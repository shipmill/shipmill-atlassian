import Resolver from '@forge/resolver';
import { natural, nonEmpty, object } from '@shipmill-atlassian/shared/parse';
import { workspaceUuid } from './bitbucket-rest';
import { NotPairedError, gatherFacts, jiraWorkItems } from './facts';
import { card, type Card } from './holds';
import { forgeQuestions, reportToJira } from './jira-decisions';
import { syncQuestion } from './pr-decision';

// Backs the pull request card. The pull request comes from the module's context, never from
// the page's payload, so a viewer can only ask about the pull request they are looking at.
// Like the merge check, it first brings the pull request's question in line with Jira, and
// tells Jira the decisions open on the pull request.

export type CardView = { kind: 'card'; card: Card } | { kind: 'not-paired'; message: string };

const resolver = new Resolver();

resolver.define('getCard', async ({ context }): Promise<CardView> => {
  const fields = object(context, 'context');
  const extension = object(fields.extension, 'context.extension');
  const repository = nonEmpty(object(extension.repository, 'context.extension.repository').uuid, 'context.extension.repository.uuid');
  const id = natural(object(extension.pullRequest, 'context.extension.pullRequest').id, 'context.extension.pullRequest.id');
  const workspace = workspaceUuid(fields.workspaceId);
  const questions = forgeQuestions(workspace, repository);
  try {
    await syncQuestion(questions, await questions.rest.pullRequest(id));
    const facts = await gatherFacts(questions.rest, jiraWorkItems, id);
    await reportToJira(workspace, questions, facts.pullRequest, facts.tasks);
    return { kind: 'card', card: card(facts) };
  } catch (error) {
    if (error instanceof NotPairedError) return { kind: 'not-paired', message: error.message };
    throw error;
  }
});

export const cardResolver = resolver.getDefinitions();
