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

// The text a person reads in an ADF body: block nodes end with a line break, mentions and
// emoji keep their visible text, and every other node gives the text of its children
const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock', 'rule', 'panel', 'tableRow']);

export function plainText(document: unknown): string {
  const lines: string[] = [];
  let line = '';
  const visit = (node: unknown, path: string): void => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) throw new Error(`${path}: an ADF node is not an object`);
    const fields = node as Record<string, unknown>;
    const type = fields.type;
    if (typeof type !== 'string') throw new Error(`${path}: an ADF node has no type`);
    if (type === 'text') {
      if (typeof fields.text !== 'string') throw new Error(`${path}: a text node has no text`);
      line += fields.text;
      return;
    }
    if (type === 'hardBreak') {
      lines.push(line);
      line = '';
      return;
    }
    if (type === 'mention' || type === 'emoji') {
      const attrs = fields.attrs as Record<string, unknown> | undefined;
      const text = attrs?.text;
      if (typeof text === 'string') line += text;
      return;
    }
    const content = fields.content ?? [];
    if (!Array.isArray(content)) throw new Error(`${path}: content is not an array`);
    content.forEach((child, index) => visit(child, `${path}.content[${index}]`));
    if (BLOCKS.has(type) && line !== '') {
      lines.push(line);
      line = '';
    }
  };
  visit(document, 'adf');
  if (line !== '') lines.push(line);
  return lines.join('\n');
}
