// A REST client with basic auth that fails on any status it was not told to expect

export class Http {
  readonly #base: string;
  readonly #authorization: string;

  constructor(base: string, user: string, token: string) {
    this.#base = base;
    this.#authorization = `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
  }

  // The JSON body, or undefined on 404
  async find(path: string): Promise<unknown> {
    const response = await this.#send('GET', path, undefined, undefined);
    if (response.status === 404) {
      return undefined;
    }
    return this.#json(response, 'GET', path, [200]);
  }

  async get(path: string): Promise<unknown> {
    return this.#json(await this.#send('GET', path, undefined, undefined), 'GET', path, [200]);
  }

  async delete(path: string, expect: readonly number[]): Promise<void> {
    await this.#check(await this.#send('DELETE', path, undefined, undefined), 'DELETE', path, expect);
  }

  async send(method: 'POST' | 'PUT', path: string, body: unknown, expect: readonly number[]): Promise<unknown> {
    const response = await this.#send(method, path, JSON.stringify(body), 'application/json');
    return this.#json(response, method, path, expect);
  }

  // Multipart form fields; Bitbucket's /src takes files this way
  async sendForm(path: string, form: FormData, expect: readonly number[]): Promise<void> {
    const response = await this.#send('POST', path, form, undefined);
    await this.#check(response, 'POST', path, expect);
  }

  async #send(method: string, path: string, body: string | FormData | undefined, type: string | undefined): Promise<Response> {
    const headers: Record<string, string> = { Authorization: this.#authorization, Accept: 'application/json' };
    if (type !== undefined) {
      headers['Content-Type'] = type;
    }
    return fetch(new URL(path, this.#base), { method, headers, ...(body === undefined ? {} : { body }) });
  }

  async #json(response: Response, method: string, path: string, expect: readonly number[]): Promise<unknown> {
    await this.#check(response, method, path, expect);
    const text = await response.text();
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  }

  async #check(response: Response, method: string, path: string, expect: readonly number[]): Promise<void> {
    if (!expect.includes(response.status)) {
      const text = await response.text();
      throw new Error(`${method} ${path} returned ${response.status}: ${text.slice(0, 500)}`);
    }
  }
}

// Narrowing for the parts of a response the seed reads
export function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

export function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${what} is not an array`);
  }
  return value;
}

export function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${what} is not a non-empty string`);
  }
  return value;
}
