import type { ChatResponse } from '@forge/llm';
import { projectOf, type JiraKey, type ProjectKey } from '@shipmill-atlassian/shared/jira-key';
import { commentId, type Comment, type CommentId, type Person } from '@shipmill-atlassian/shared/release';
import { plainText } from '@shipmill-atlassian/shared/adf';
import type { Adf } from './comment';
import type { DecisionJira } from './decision-jira';
import type { DecisionLog, LoggedDecision } from './decision-log';
import { current, parseProperty, propertyValue, type PropertyValue, type Question } from './question';
import type { IndexQuery, QuestionIndex } from './question-reads';

// An in-memory Jira for the preparer and relay tests. Tests only; the app never imports this.

export const APP: Person = { accountId: 'app:shipmill', displayName: 'shipmill Release Decisions' };
export const LEAD: Person = { accountId: '557058:lead', displayName: 'Project Lead' };

export class FakeJira implements DecisionJira {
  readonly comments = new Map<CommentId, { key: JiraKey; comment: Comment; body: Adf | null }>();
  // The shipmill-questions property of each work item, as Jira stores it
  readonly properties = new Map<JiraKey, PropertyValue>();
  readonly labels: { key: JiraKey; present: boolean }[] = [];
  leadCalls = 0;
  #next = 20000;

  async questions(key: JiraKey): Promise<Question[]> {
    const stored = this.properties.get(key);
    // Round-trip through JSON and the parser, as the entity property does
    return stored === undefined ? [] : parseProperty(JSON.parse(JSON.stringify(stored)));
  }

  async setQuestions(key: JiraKey, questions: readonly Question[]): Promise<void> {
    const { value } = propertyValue(questions);
    parseProperty(JSON.parse(JSON.stringify(value)));
    this.properties.set(key, JSON.parse(JSON.stringify(value)) as PropertyValue);
  }

  // The current question on a work item, for a test to look at
  current(key: JiraKey): Question | undefined {
    const stored = this.properties.get(key);
    return stored === undefined ? undefined : current(parseProperty(JSON.parse(JSON.stringify(stored))));
  }

  // Jira's JQL index of the property: it matches on the indexed fields alone, as the search does
  readonly index: QuestionIndex = {
    find: async (query: IndexQuery) =>
      [...this.properties.entries()]
        .filter(
          ([key, stored]) =>
            (query.project === undefined || projectOf(key) === query.project) &&
            (query.status === undefined || stored.status === query.status) &&
            (query.askedOf === undefined || stored.askedOf === query.askedOf) &&
            (query.askedBy === undefined || stored.askedBy === query.askedBy) &&
            (query.answered !== true || stored.answered > 0),
        )
        .map(([key, stored]) => ({ key, questions: parseProperty(JSON.parse(JSON.stringify(stored))) })),
  };

  async comment(key: JiraKey, id: CommentId): Promise<Comment> {
    const found = this.comments.get(id);
    if (found === undefined || found.key !== key) throw new Error(`no comment ${id} on ${key}`);
    return found.comment;
  }

  async postComment(key: JiraKey, body: Adf): Promise<CommentId> {
    return this.add(key, APP, plainText(body), body);
  }

  async label(key: JiraKey, present: boolean): Promise<void> {
    this.labels.push({ key, present });
  }

  async projectLead(_project: ProjectKey): Promise<Person> {
    this.leadCalls++;
    return LEAD;
  }

  // A comment by a person, as Jira would number it
  reply(key: JiraKey, author: Person, text: string): CommentId {
    return this.add(key, author, text, null);
  }

  posted(key: JiraKey): { text: string; body: Adf }[] {
    return [...this.comments.values()]
      .filter((entry) => entry.key === key && entry.body !== null)
      .map((entry) => ({ text: entry.comment.text, body: entry.body as Adf }));
  }

  private add(key: JiraKey, author: Person, text: string, body: Adf | null): CommentId {
    const id = commentId(String(this.#next++));
    this.comments.set(id, { key, comment: { id, author, created: '2026-12-03T10:00:00.000+0000', text }, body });
    return id;
  }
}

// A Forge LLM response that calls one tool with these arguments
export function toolResponse(name: string, args: object): ChatResponse {
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', index: 0, function: { name, arguments: args } }] },
      },
    ],
    usage: { input_tokens: 900, output_tokens: 120 },
  };
}

// The decisions the relay handed to the Confluence log
export class FakeLog implements DecisionLog {
  readonly recorded: LoggedDecision[] = [];

  async record(decision: LoggedDecision): Promise<void> {
    this.recorded.push(decision);
  }
}
