export interface RetryPolicy {
  /** Retries after the first attempt. 3 means up to 4 requests in total. */
  maxRetries: number;
  /** Starting delay for exponential backoff when Freshdesk gives no Retry-After. */
  baseDelayMs: number;
  /**
   * Total time one tool call may spend waiting between attempts. If honouring a
   * Retry-After (or the next backoff step) would exceed it, the call fails fast
   * with RATE_LIMITED + retry_after_seconds instead of blocking the agent.
   * The default keeps a call well inside the 60s request timeout common in MCP clients.
   */
  maxWaitMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxWaitMs: 20_000,
};

/**
 * Parses a Retry-After header into milliseconds.
 * Freshdesk sends delta-seconds ("30"); RFC 9110 also allows an HTTP-date.
 * Returns undefined when the header is absent or unparseable.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1_000;
  }

  // Only treat it as a date if it looks like one ("Wed, 21 Oct 2015 07:28:00 GMT");
  // Date.parse is lenient enough to turn strings like "1.5" into a timestamp.
  if (/[a-z]{3}/i.test(trimmed)) {
    const date = Date.parse(trimmed);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }

  return undefined;
}

/**
 * Exponential backoff with "equal jitter": half the delay is fixed, half is random.
 * Jitter keeps concurrent tool calls from retrying in lockstep.
 *
 * @param retryNumber 0 for the first retry, 1 for the second, ...
 */
export function backoffDelay(
  retryNumber: number,
  options: { baseDelayMs: number; maxDelayMs: number },
  random: () => number = Math.random,
): number {
  const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** retryNumber);
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
