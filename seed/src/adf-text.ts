// The plain text of an Atlassian Document Format body: paragraphs joined by newlines

export function adfText(node: unknown): string {
  if (typeof node !== 'object' || node === null) {
    throw new Error('an ADF node must be an object');
  }
  const { type, text, content } = node as { type?: unknown; text?: unknown; content?: unknown };
  if (typeof type !== 'string') {
    throw new Error('an ADF node needs a type');
  }
  if (type === 'text') {
    if (typeof text !== 'string') {
      throw new Error('an ADF text node needs text');
    }
    return text;
  }
  if (type === 'hardBreak') {
    return '\n';
  }
  if (content === undefined) {
    return '';
  }
  if (!Array.isArray(content)) {
    throw new Error(`ADF ${type} content must be an array`);
  }
  const parts = content.map(adfText);
  return type === 'doc' ? parts.join('\n') : parts.join('');
}
