import { chat } from '@forge/llm';
import type { ProjectKey } from '@shipmill-atlassian/shared/jira-key';
import type { Release } from '@shipmill-atlassian/shared/release';
import { findDecisions, type Decision } from './finder';
import { forgeJiraRest } from './jira-rest';
import { llmFinder } from './llm-finder';
import { kvsPullRequests } from './pull-request-store';
import { readRelease } from './reader';
import { llmEnabled } from './settings';

// The reader and the finder wired to Forge: Jira REST, the bridge's pull requests in KVS,
// Forge LLM, and the site's LLM switch. With the LLM on this can run past the 25 s a
// resolver or product trigger has, so call it from an async event consumer.

export const forgeImplicitFinder = llmFinder(chat);

// llm: the site's switch by default; a caller that must not bill (the development trigger) passes false
export async function releaseDecisions(
  project: ProjectKey,
  version: string,
  llm?: boolean,
): Promise<{ release: Release; decisions: Decision[] }> {
  const release = await readRelease(forgeJiraRest, kvsPullRequests, project, version);
  const decisions = await findDecisions(release, { llm: llm ?? (await llmEnabled()), implicit: forgeImplicitFinder });
  return { release, decisions };
}
