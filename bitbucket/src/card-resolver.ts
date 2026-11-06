import Resolver from '@forge/resolver';
import { natural, nonEmpty, object } from '@shipmill-atlassian/shared/parse';
import { forgeBitbucket, workspaceUuid } from './bitbucket-rest';
import { NotPairedError, gatherFacts, jiraWorkItems } from './facts';
import { card, type Card } from './holds';

// Backs the pull request card. The pull request comes from the module's context, never from
// the page's payload, so a viewer can only ask about the pull request they are looking at.

export type CardView = { kind: 'card'; card: Card } | { kind: 'not-paired'; message: string };

const resolver = new Resolver();

resolver.define('getCard', async ({ context }): Promise<CardView> => {
  const fields = object(context, 'context');
  const extension = object(fields.extension, 'context.extension');
  const repository = nonEmpty(object(extension.repository, 'context.extension.repository').uuid, 'context.extension.repository.uuid');
  const id = natural(object(extension.pullRequest, 'context.extension.pullRequest').id, 'context.extension.pullRequest.id');
  const rest = forgeBitbucket(workspaceUuid(fields.workspaceId), repository);
  try {
    return { kind: 'card', card: card(await gatherFacts(rest, jiraWorkItems, id)) };
  } catch (error) {
    if (error instanceof NotPairedError) return { kind: 'not-paired', message: error.message };
    throw error;
  }
});

export const cardResolver = resolver.getDefinitions();
