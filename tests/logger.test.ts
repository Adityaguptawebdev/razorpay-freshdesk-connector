import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/utils/logger.js';
import { createRedactor } from '../src/utils/redact.js';
import { ENCODED_TEST_AUTH, TEST_API_KEY } from './fixtures/tickets.js';

describe('createRedactor', () => {
  it('replaces every occurrence of every secret', () => {
    const redact = createRedactor([TEST_API_KEY, ENCODED_TEST_AUTH]);
    expect(redact(`key=${TEST_API_KEY} again=${TEST_API_KEY} header=Basic ${ENCODED_TEST_AUTH}`)).toBe(
      'key=[REDACTED] again=[REDACTED] header=Basic [REDACTED]',
    );
  });

  it('ignores secrets too short to redact safely', () => {
    expect(createRedactor(['', 'abc'])('abc abc')).toBe('abc abc');
  });
});

describe('createLogger', () => {
  it('writes JSON lines, filters by level and redacts secrets in messages and fields', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', secrets: [TEST_API_KEY], write: (line) => lines.push(line) });

    logger.debug('hidden');
    logger.info(`using ${TEST_API_KEY}`, { header: `Basic ${TEST_API_KEY}` });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry).toMatchObject({ level: 'info', message: 'using [REDACTED]', header: 'Basic [REDACTED]' });
    expect(lines[0]).not.toContain(TEST_API_KEY);
  });
});
