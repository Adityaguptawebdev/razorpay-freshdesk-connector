import { vi } from 'vitest';
import { FreshdeskCredentials } from '../../src/auth/credentials.js';
import { FreshdeskClient, type FreshdeskClientOptions } from '../../src/client/freshdesk-client.js';
import type { ToolContext } from '../../src/tools/index.js';
import { createLogger } from '../../src/utils/logger.js';
import { createRedactor } from '../../src/utils/redact.js';
import { FIXED_NOW, TEST_API_KEY, TEST_DOMAIN } from '../fixtures/tickets.js';
import { mockFetch, type MockReply } from './mock-fetch.js';

export const testCredentials = () => new FreshdeskCredentials(TEST_DOMAIN, TEST_API_KEY);

/**
 * A FreshdeskClient wired to a mocked fetch, an instant sleep, deterministic
 * jitter (random = 0.5) and a log sink, so retry behaviour can be asserted
 * exactly and nothing touches the network.
 */
export function createTestClient(replies: MockReply[], options: Partial<FreshdeskClientOptions> = {}) {
  const credentials = testCredentials();
  const { fetch, requests } = mockFetch(...replies);
  const sleep = vi.fn(async (_ms: number) => {});
  const logs: string[] = [];
  const logger = createLogger({
    level: 'debug',
    secrets: credentials.secrets(),
    write: (line) => logs.push(line),
  });

  const client = new FreshdeskClient({
    credentials,
    fetch,
    sleep,
    random: () => 0.5,
    now: () => FIXED_NOW,
    logger,
    ...options,
  });

  return { client, requests, sleep, logs };
}

export function createToolContext(
  replies: MockReply[],
  options: { includePrivateNotes?: boolean; clientOptions?: Partial<FreshdeskClientOptions> } = {},
) {
  const { client, requests, sleep, logs } = createTestClient(replies, options.clientOptions);
  const context: ToolContext = {
    api: client,
    includePrivateNotes: options.includePrivateNotes ?? false,
    logger: createLogger({ level: 'debug', secrets: testCredentials().secrets(), write: (line) => logs.push(line) }),
    redact: createRedactor(testCredentials().secrets()),
  };
  return { context, requests, sleep, logs };
}
