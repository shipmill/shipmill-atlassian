// Atlassian Document Format, the body Jira's REST API takes for comments

export type AdfDocument = {
  type: 'doc';
  version: 1;
  content: { type: 'paragraph'; content: { type: 'text'; text: string }[] }[];
};

export function paragraphs(lines: string[]): AdfDocument {
  if (lines.length === 0 || lines.some((line) => line === '')) {
    throw new Error('an ADF paragraph needs non-empty text');
  }
  return {
    type: 'doc',
    version: 1,
    content: lines.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
  };
}
