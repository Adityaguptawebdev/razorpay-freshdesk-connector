import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CredentialsError, FreshdeskCredentials, normalizeFreshdeskHost } from '../src/auth/credentials.js';
import { ENCODED_TEST_AUTH, TEST_API_KEY } from './fixtures/tickets.js';

describe('normalizeFreshdeskHost', () => {
  it.each([
    ['acme', 'acme.freshdesk.com'],
    ['ACME', 'acme.freshdesk.com'],
    ['  acme-support  ', 'acme-support.freshdesk.com'],
    ['acme.freshdesk.com', 'acme.freshdesk.com'],
    ['acme.freshdesk.com/', 'acme.freshdesk.com'],
    ['https://acme.freshdesk.com', 'acme.freshdesk.com'],
    ['https://acme.freshdesk.com/', 'acme.freshdesk.com'],
  ])('accepts %j', (input, expected) => {
    expect(normalizeFreshdeskHost(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['evil.com', 'non-Freshdesk host'],
    ['acme.freshdesk.com.evil.com', 'lookalike host'],
    ['evil.com/acme.freshdesk.com', 'path trick'],
    ['http://acme.freshdesk.com', 'plain http'],
    ['https://acme.freshdesk.com:8443', 'custom port'],
    ['https://user:pass@acme.freshdesk.com', 'embedded credentials'],
    ['https://acme.freshdesk.com/api/v2', 'path'],
    ['https://acme.freshdesk.com/?x=1', 'query string'],
    ['-acme', 'invalid subdomain'],
    ['a..b.freshdesk.com', 'nested subdomain'],
  ])('rejects %j (%s)', (input) => {
    expect(() => normalizeFreshdeskHost(input)).toThrow(CredentialsError);
  });
});

describe('FreshdeskCredentials', () => {
  const credentials = new FreshdeskCredentials('acme-test', TEST_API_KEY);

  it('builds a Basic auth header with the API key as username and X as password', () => {
    expect(credentials.authorizationHeader()).toBe(`Basic ${ENCODED_TEST_AUTH}`);
    expect(credentials.origin).toBe('https://acme-test.freshdesk.com');
  });

  it('never serialises the API key', () => {
    const renderings = [
      JSON.stringify(credentials),
      JSON.stringify({ nested: credentials }),
      String(credentials),
      `${credentials}`,
      inspect(credentials),
      inspect({ nested: credentials }, { depth: 5 }),
    ];
    for (const text of renderings) {
      expect(text).not.toContain(TEST_API_KEY);
      expect(text).not.toContain(ENCODED_TEST_AUTH);
    }
    expect(JSON.parse(JSON.stringify(credentials))).toEqual({
      host: 'acme-test.freshdesk.com',
      apiKey: '[REDACTED]',
    });
  });

  it('exposes the key and encoded header as secrets for redaction', () => {
    expect(credentials.secrets()).toEqual([TEST_API_KEY, ENCODED_TEST_AUTH]);
  });

  it.each([
    ['', 'empty'],
    ['your_api_key_here', '.env.example placeholder'],
    ['short', 'too short'],
    ['has space in key', 'whitespace'],
    ['abc:defghijk', 'colon breaks Basic auth'],
    ['abc"defghijk', 'quote'],
  ])('rejects API key %j (%s) without echoing it', (key) => {
    let message = '';
    try {
      new FreshdeskCredentials('acme', key);
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialsError);
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    if (key.length > 0) expect(message).not.toContain(key);
  });
});
