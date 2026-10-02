import { z } from 'zod';
import { CredentialsError, FreshdeskCredentials } from './auth/credentials.js';
import { DEFAULT_TIMEOUT_MS } from './client/freshdesk-client.js';
import { ConfigError } from './utils/errors.js';
import { LOG_LEVELS, type LogLevel } from './utils/logger.js';
import { DEFAULT_RETRY_POLICY } from './utils/retry.js';

export interface AppConfig {
  credentials: FreshdeskCredentials;
  maxRetries: number;
  maxRetryWaitMs: number;
  requestTimeoutMs: number;
  includePrivateNotes: boolean;
  logLevel: LogLevel;
}

/** Empty strings (e.g. `FRESHDESK_MAX_RETRIES=`) mean "use the default". */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema);

const integerInRange = (name: string, min: number, max: number, fallback: number) =>
  optional(
    z.coerce
      .number({ error: `${name} must be a number.` })
      .int({ error: `${name} must be a whole number.` })
      .min(min, { error: `${name} must be between ${min} and ${max}.` })
      .max(max, { error: `${name} must be between ${min} and ${max}.` })
      .default(fallback),
  );

// Credentials are only checked for presence here; FreshdeskCredentials does the
// format validation so its messages are guaranteed not to echo the key.
const EnvSchema = z.object({
  FRESHDESK_DOMAIN: optional(z.string({ error: 'FRESHDESK_DOMAIN is required.' })),
  FRESHDESK_API_KEY: optional(z.string({ error: 'FRESHDESK_API_KEY is required.' })),
  FRESHDESK_MAX_RETRIES: integerInRange('FRESHDESK_MAX_RETRIES', 0, 5, DEFAULT_RETRY_POLICY.maxRetries),
  FRESHDESK_MAX_RETRY_WAIT_MS: integerInRange(
    'FRESHDESK_MAX_RETRY_WAIT_MS',
    1_000,
    60_000,
    DEFAULT_RETRY_POLICY.maxWaitMs,
  ),
  FRESHDESK_REQUEST_TIMEOUT_MS: integerInRange(
    'FRESHDESK_REQUEST_TIMEOUT_MS',
    1_000,
    60_000,
    DEFAULT_TIMEOUT_MS,
  ),
  FRESHDESK_INCLUDE_PRIVATE_NOTES: optional(
    z
      .enum(['true', 'false'], { error: 'FRESHDESK_INCLUDE_PRIVATE_NOTES must be "true" or "false".' })
      .default('false'),
  ),
  LOG_LEVEL: optional(
    z.enum(LOG_LEVELS, { error: `LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}.` }).default('info'),
  ),
});

/**
 * Reads and validates configuration from environment variables.
 * Reports every problem at once so a misconfigured deployment is fixed in one pass.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => issue.message));
  }

  const values = parsed.data;
  let credentials: FreshdeskCredentials;
  try {
    credentials = new FreshdeskCredentials(values.FRESHDESK_DOMAIN, values.FRESHDESK_API_KEY);
  } catch (error) {
    if (error instanceof CredentialsError) throw new ConfigError([error.message]);
    throw error;
  }

  return {
    credentials,
    maxRetries: values.FRESHDESK_MAX_RETRIES,
    maxRetryWaitMs: values.FRESHDESK_MAX_RETRY_WAIT_MS,
    requestTimeoutMs: values.FRESHDESK_REQUEST_TIMEOUT_MS,
    includePrivateNotes: values.FRESHDESK_INCLUDE_PRIVATE_NOTES === 'true',
    logLevel: values.LOG_LEVEL,
  };
}
