import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraTriggerUrl, sharedSecret } from './pairing';

test('accepts a Forge web trigger URL', () => {
  const url = 'https://abc.hello.atlassian-dev.net/x1/token';
  assert.equal(jiraTriggerUrl(` ${url} `).href, url);
});

test('refuses another host, plain http and a non-URL', () => {
  assert.throws(() => jiraTriggerUrl('https://evil.example/x'));
  assert.throws(() => jiraTriggerUrl('https://hello.atlassian-dev.net.evil.example/x'));
  assert.throws(() => jiraTriggerUrl('http://abc.hello.atlassian-dev.net/x'));
  assert.throws(() => jiraTriggerUrl('not a url'));
});

test('accepts a 64-hex secret and refuses anything else', () => {
  const secret = 'ab'.repeat(32);
  assert.equal(sharedSecret(`${secret}\n`), secret);
  assert.throws(() => sharedSecret('ab'.repeat(31)));
  assert.throws(() => sharedSecret('AB'.repeat(32)));
});
