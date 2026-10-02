import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ConfigError } from '../src/utils/errors.js';
import { TEST_API_KEY } from './fixtures/tickets.js';

const validEnv = { FRESHDESK_DOMAIN: 'acme-test', FRESHDESK_API_KEY: TEST_API_KEY };

function configError(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('Expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const config = loadConfig(validEnv);
    expect(config.credentials.host).toBe('acme-test.freshdesk.com');
    expect(config).toMatchObject({
      maxRetries: 3,
      maxRetryWaitMs: 20_000,
      requestTimeoutMs: 10_000,
      includePrivateNotes: false,
      logLevel: 'info',
    });
  });

  it('treats blank optional values as unset', () => {
    const config = loadConfig({ ...validEnv, FRESHDESK_MAX_RETRIES: '', LOG_LEVEL: ' ' });
    expect(config.maxRetries).toBe(3);
    expect(config.logLevel).toBe('info');
  });

  it('reads optional overrides', () => {
    const config = loadConfig({
      ...validEnv,
      FRESHDESK_MAX_RETRIES: '0',
      FRESHDESK_MAX_RETRY_WAIT_MS: '5000',
      FRESHDESK_REQUEST_TIMEOUT_MS: '2000',
      FRESHDESK_INCLUDE_PRIVATE_NOTES: 'true',
      LOG_LEVEL: 'debug',
    });
    expect(config).toMatchObject({
      maxRetries: 0,
      maxRetryWaitMs: 5_000,
      requestTimeoutMs: 2_000,
      includePrivateNotes: true,
      logLevel: 'debug',
    });
  });

  it('reports every missing required variable at once', () => {
    expect(configError({}).problems).toEqual([
      'FRESHDESK_DOMAIN is required.',
      'FRESHDESK_API_KEY is required.',
    ]);
  });

  it('rejects out-of-range and malformed optional values', () => {
    const { problems } = configError({
      ...validEnv,
      FRESHDESK_MAX_RETRIES: '10',
      FRESHDESK_REQUEST_TIMEOUT_MS: 'soon',
      FRESHDESK_INCLUDE_PRIVATE_NOTES: 'yes',
      LOG_LEVEL: 'verbose',
    });
    expect(problems).toHaveLength(4);
    expect(problems.join(' ')).toMatch(/FRESHDESK_MAX_RETRIES.*FRESHDESK_REQUEST_TIMEOUT_MS.*FRESHDESK_INCLUDE_PRIVATE_NOTES.*LOG_LEVEL/);
  });

  it('rejects non-Freshdesk domains', () => {
    expect(configError({ ...validEnv, FRESHDESK_DOMAIN: 'https://attacker.example' }).message).toMatch(
      /Only \*\.freshdesk\.com hosts are allowed/,
    );
  });

  it('never includes the API key in configuration errors', () => {
    const badKey = 'bad key with spaces 123';
    const error = configError({ ...validEnv, FRESHDESK_API_KEY: badKey });
    expect(error.message).toMatch(/FRESHDESK_API_KEY has an unexpected format/);
    expect(error.message).not.toContain(badKey);
  });
});
