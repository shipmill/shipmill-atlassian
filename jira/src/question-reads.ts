import { jiraKey, type JiraKey, type ProjectKey } from '@shipmill-atlassian/shared/jira-key';
import { list, nonEmpty, object } from '@shipmill-atlassian/shared/parse';
import type { DecisionJira } from './decision-jira';
import type { JiraRest } from './jira-rest';
import { PROPERTY, current, isAnswered, parseProperty, type Answered, type AnsweredFromRecord, type Question, type Status, type Waiting } from './question';

// The reads over the question records: the questions waiting on a person, a project's
// answered questions, and the question on one work item. The first two list from Jira's
// index of the shipmill-questions property (manifest.yml, jira:entityProperty): one JQL
// search returns the matching work items with their records, from whichever install runs it.
// Jira's search trails a write by a moment, so a question just asked or answered can be
// missing or stale in a list; every read checks the records it gets back, and the read by
// work item goes to the property itself and is always current.

// What the index can be asked, each field about a work item's current question, except
// answered: the item holds an answered question, the current one or an earlier one
export type IndexQuery = { project?: ProjectKey; status?: Status; askedOf?: string; askedBy?: string; answered?: true };

export interface QuestionIndex {
  find(query: IndexQuery): Promise<{ key: JiraKey; questions: Question[] }[]>;
}

// The names Jira's JQL knows the indexed fields by: the searchAlias of each in manifest.yml
export const ALIAS = {
  status: 'agentQuestionStatus',
  askedOf: 'agentQuestionAskedOf',
  askedBy: 'agentQuestionAskedBy',
  answered: 'agentQuestionsAnswered',
} as const;

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function indexJql(query: IndexQuery): string {
  const clauses: string[] = [];
  if (query.project !== undefined) clauses.push(`project = ${quote(query.project)}`);
  if (query.status !== undefined) clauses.push(`${ALIAS.status} = ${quote(query.status)}`);
  if (query.askedOf !== undefined) clauses.push(`${ALIAS.askedOf} = ${quote(query.askedOf)}`);
  if (query.askedBy !== undefined) clauses.push(`${ALIAS.askedBy} = ${quote(query.askedBy)}`);
  if (query.answered === true) clauses.push(`${ALIAS.answered} > 0`);
  // Jira refuses a search with no restriction, and every question has a status or an answer
  if (query.status === undefined && query.answered !== true) throw new Error('an index query needs a status, or answered');
  return `${clauses.join(' AND ')} ORDER BY key ASC`;
}

const PAGE = 100;

// The index over Jira REST, as whoever the rest goes as: a search as the user returns only
// the work items Jira shows them
export function searchIndex(rest: JiraRest): QuestionIndex {
  return {
    async find(query) {
      const jql = indexJql(query);
      const found: { key: JiraKey; questions: Question[] }[] = [];
      let nextPageToken: string | undefined;
      for (let page = 0; ; page++) {
        const response = object(
          await rest.search({ jql, fields: ['summary'], properties: [PROPERTY], maxResults: PAGE, ...(nextPageToken === undefined ? {} : { nextPageToken }) }),
          `search[${page}]`,
        );
        for (const [index, issue] of list(response.issues, `search[${page}].issues`, object).entries()) {
          const key = jiraKey(nonEmpty(issue.key, `search[${page}].issues[${index}].key`));
          const properties = object(issue.properties, `${key}.properties`);
          // The search matched an older state of the item whose record is gone since (a seed cleared it)
          if (properties[PROPERTY] === undefined) continue;
          found.push({ key, questions: parseProperty(properties[PROPERTY], `${key}.${PROPERTY}`) });
        }
        if (response.isLast === true || response.nextPageToken === undefined) break;
        nextPageToken = nonEmpty(response.nextPageToken, `search[${page}].nextPageToken`);
      }
      return found;
    },
  };
}

export type Listed<Q extends Question = Question> = { key: JiraKey; question: Q };

// ISO timestamps from the same clock sort as text
function byTime<T>(time: (entry: T) => string, direction: 1 | -1): (a: T, b: T) => number {
  return (a, b) => (time(a) < time(b) ? -direction : time(a) > time(b) ? direction : 0);
}

// The questions that wait on an answer, oldest first: all of a project, the ones asked of one
// person (by account id), the ones one person's agents asked, or any of these together
export async function waitingQuestions(
  index: QuestionIndex,
  filter: { project?: ProjectKey; askedOf?: string; askedBy?: string },
): Promise<Listed<Waiting>[]> {
  const found = await index.find({ ...filter, status: 'waiting' });
  const waiting: Listed<Waiting>[] = [];
  for (const { key, questions } of found) {
    const question = current(questions);
    // The index trails the record: a question answered a moment ago still matches the search
    if (question?.status !== 'waiting') continue;
    if (filter.askedOf !== undefined && question.askedOf.accountId !== filter.askedOf) continue;
    if (filter.askedBy !== undefined && question.askedBy.accountId !== filter.askedBy) continue;
    waiting.push({ key, question });
  }
  return waiting.sort(byTime((entry) => entry.question.askedAt, 1));
}

// When a question got its answer: the reply, or the moment the agent took an earlier answer
export function closedAt(question: Answered | AnsweredFromRecord): string {
  return question.status === 'answered' ? question.answeredAt : question.takenAt;
}

// Every answered question of a project, the newest answer first: a work item's earlier
// questions too, not only its current one
export async function answeredQuestions(index: QuestionIndex, project: ProjectKey): Promise<Listed<Answered | AnsweredFromRecord>[]> {
  const found = await index.find({ project, answered: true });
  const answered = found.flatMap(({ key, questions }) => questions.filter(isAnswered).map((question) => ({ key, question })));
  return answered.sort(byTime((entry) => closedAt(entry.question), -1));
}

// The current question on one work item, read from the item itself: undefined when none was asked
export async function questionOn(jira: Pick<DecisionJira, 'questions'>, key: JiraKey): Promise<Question | undefined> {
  return current(await jira.questions(key));
}
