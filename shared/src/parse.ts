// Strict readers for JSON from outside the code (Jira REST, KVS, the LLM, eval files):
// each takes the value and a path for the error, and throws on the first thing out of shape

export class ParseError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.path = path;
  }
}

export type Fields = Record<string, unknown>;

export function object(value: unknown, path: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ParseError(path, `expected an object, got ${describe(value)}`);
  }
  return value as Fields;
}

export function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ParseError(path, `expected an array, got ${describe(value)}`);
  return value;
}

export function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new ParseError(path, `expected a string, got ${describe(value)}`);
  return value;
}

export function nonEmpty(value: unknown, path: string): string {
  const text = string(value, path);
  if (text.trim() === '') throw new ParseError(path, 'expected a non-empty string');
  return text;
}

export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ParseError(path, `expected a boolean, got ${describe(value)}`);
  return value;
}

export function natural(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ParseError(path, `expected a non-negative integer, got ${describe(value)}`);
  }
  return value;
}

export function oneOf<const T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  const text = string(value, path);
  if (!(allowed as readonly string[]).includes(text)) {
    throw new ParseError(path, `expected one of ${allowed.join(', ')}, got ${JSON.stringify(text)}`);
  }
  return text as T;
}

export function list<T>(value: unknown, path: string, item: (value: unknown, path: string) => T): T[] {
  return array(value, path).map((entry, index) => item(entry, `${path}[${index}]`));
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}
