import type { z } from 'zod';
import type { FreshdeskCredentials } from '../auth/credentials.js';
import {
  RawSearchResponseSchema,
  RawTicketListSchema,
  RawTicketSchema,
  type ListTicketsParams,
  type RawTicket,
} from '../types/freshdesk.js';
import { ConnectorError, type FieldError } from '../utils/errors.js';
import { silentLogger, type Logger } from '../utils/logger.js';
import {
  backoffDelay,
  DEFAULT_RETRY_POLICY,
  parseRetryAfter,
  sleep as defaultSleep,
  type RetryPolicy,
} from '../utils/retry.js';

export interface TicketIncludes {
  conversations?: boolean;
  requester?: boolean;
}

export interface TicketPage {
  tickets: RawTicket[];
  /** True when Freshdesk's `Link` header advertises a next page. */
  hasMore: boolean;
}

export interface SearchPage {
  tickets: RawTicket[];
  total: number;
}

/** The read operations the tools depend on. Implemented by FreshdeskClient; easy to stub. */
export interface FreshdeskTicketApi {
  listTickets(params: ListTicketsParams): Promise<TicketPage>;
  getTicket(ticketId: number, include?: TicketIncludes): Promise<RawTicket>;
  searchTickets(query: string, page: number): Promise<SearchPage>;
}

export interface FreshdeskClientOptions {
  credentials: FreshdeskCredentials;
  retry?: Partial<RetryPolicy>;
  /** Per-attempt timeout, covering both the request and reading the body. */
  timeoutMs?: number;
  logger?: Logger;
  /* Injection points so tests run without network access or real waiting. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

interface RawResponse {
  body: unknown;
  headers: Headers;
}

const USER_AGENT = 'freshdesk-mcp-connector/1.0.0';
export const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_UPSTREAM_TEXT = 300;

/**
 * Minimal, read-only Freshdesk API v2 client.
 *
 * Security properties:
 * - Requests only go to the credential's validated origin; tool input never supplies a URL.
 * - Redirects are never followed, so the Authorization header cannot be replayed elsewhere.
 * - Error messages are built from status codes and Freshdesk's JSON error fields, never from
 *   request headers, so they cannot contain the API key.
 */
export class FreshdeskClient implements FreshdeskTicketApi {
  readonly #credentials: FreshdeskCredentials;
  readonly #retry: RetryPolicy;
  readonly #timeoutMs: number;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;

  constructor(options: FreshdeskClientOptions) {
    this.#credentials = options.credentials;
    this.#retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#logger = options.logger ?? silentLogger;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
  }

  /** GET /api/v2/tickets */
  async listTickets(params: ListTicketsParams): Promise<TicketPage> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const { body, headers } = await this.#getCollection('/api/v2/tickets', query.toString());
    return {
      tickets: this.#parse(RawTicketListSchema, body),
      hasMore: hasNextPage(headers.get('link')),
    };
  }

  /** GET /api/v2/tickets/:id */
  async getTicket(ticketId: number, include: TicketIncludes = {}): Promise<RawTicket> {
    if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
      throw new ConnectorError({ code: 'INVALID_INPUT', message: 'ticket_id must be a positive integer.' });
    }

    const embeds = [include.requester && 'requester', include.conversations && 'conversations'].filter(Boolean);
    const query = embeds.length > 0 ? `include=${embeds.join(',')}` : '';

    try {
      const { body } = await this.#get(`/api/v2/tickets/${ticketId}`, query);
      return this.#parse(RawTicketSchema, body);
    } catch (error) {
      if (error instanceof ConnectorError && error.code === 'NOT_FOUND') {
        throw new ConnectorError({
          code: 'NOT_FOUND',
          httpStatus: 404,
          attempts: error.attempts,
          message:
            `Ticket ${ticketId} was not found. It may not exist, may have been deleted, ` +
            'or may not be visible to the Freshdesk agent that owns this API key.',
        });
      }
      throw error;
    }
  }

  /** GET /api/v2/search/tickets?query="..." */
  async searchTickets(query: string, page: number): Promise<SearchPage> {
    // Freshdesk requires the query wrapped in double quotes. encodeURIComponent
    // (unlike URLSearchParams) encodes spaces as %20, as in Freshdesk's examples.
    const queryString = `query=${encodeURIComponent(`"${query}"`)}&page=${page}`;
    const { body } = await this.#getCollection('/api/v2/search/tickets', queryString);
    const data = this.#parse(RawSearchResponseSchema, body);
    return { tickets: data.results, total: data.total };
  }

  /**
   * GET for an endpoint that exists on every Freshdesk account. A 404 here means the
   * account itself was not found (Freshdesk answers an unknown subdomain with a bare 404),
   * so the message points at FRESHDESK_DOMAIN instead of at missing data.
   */
  async #getCollection(path: string, queryString: string): Promise<RawResponse> {
    try {
      return await this.#get(path, queryString);
    } catch (error) {
      if (error instanceof ConnectorError && error.code === 'NOT_FOUND') {
        throw new ConnectorError({
          code: 'NOT_FOUND',
          httpStatus: 404,
          attempts: error.attempts,
          message:
            `Freshdesk returned HTTP 404 for ${path}, which exists on every Freshdesk account. ` +
            `This usually means FRESHDESK_DOMAIN (${this.#credentials.host}) is not an active Freshdesk account. ` +
            'A human needs to fix the configuration; retrying will not help.',
        });
      }
      throw error;
    }
  }

  /** Sends a GET with retries for 429, 5xx, timeouts and transient network failures. */
  async #get(path: string, queryString: string): Promise<RawResponse> {
    const url = this.#buildUrl(path, queryString);
    let waitedMs = 0;

    for (let attempt = 1; ; attempt++) {
      let error: ConnectorError;
      try {
        return await this.#send(url);
      } catch (caught) {
        error = this.#toConnectorError(caught);
      }

      if (!error.retryable) {
        throw attempt > 1 ? error.afterAttempts(attempt) : error;
      }
      if (attempt > this.#retry.maxRetries) {
        throw error.afterAttempts(attempt, `Gave up after ${plural(attempt, 'attempt')}.`);
      }

      const { baseDelayMs, maxWaitMs } = this.#retry;
      const delayMs =
        error.retryAfterMs ?? backoffDelay(attempt - 1, { baseDelayMs, maxDelayMs: maxWaitMs }, this.#random);
      if (waitedMs + delayMs > maxWaitMs) {
        // Hand the wait we declined to the agent as retry_after_seconds.
        throw error.afterAttempts(
          attempt,
          `Waiting another ${seconds(delayMs)}s would exceed this connector's retry budget of ` +
            `${seconds(maxWaitMs)}s per call; try again later.`,
          delayMs,
        );
      }
      waitedMs += delayMs;

      this.#logger.warn('Freshdesk request failed; retrying', {
        path: url.pathname,
        code: error.code,
        httpStatus: error.httpStatus,
        attempt,
        maxRetries: this.#retry.maxRetries,
        delayMs,
        delaySource: error.retryAfterMs === undefined ? 'backoff' : 'retry-after',
      });
      await this.#sleep(delayMs);
    }
  }

  async #send(url: URL): Promise<RawResponse> {
    const response = await this.#fetch(url, {
      method: 'GET',
      headers: {
        Authorization: this.#credentials.authorizationHeader(),
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    this.#logger.debug('Freshdesk response', {
      path: url.pathname,
      status: response.status,
      rateLimitRemaining: response.headers.get('x-ratelimit-remaining'),
    });

    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel(); // release the connection; the body is never read
      throw new ConnectorError({
        code: 'UPSTREAM_ERROR',
        httpStatus: response.status || undefined,
        message:
          'Freshdesk answered with a redirect, which this connector refuses to follow so the API key ' +
          'is never sent to another host. This usually means FRESHDESK_DOMAIN is wrong or the account is inactive.',
      });
    }

    const text = await response.text();
    if (!response.ok) {
      throw this.#httpError(response, text);
    }

    try {
      return { body: JSON.parse(text) as unknown, headers: response.headers };
    } catch {
      throw new ConnectorError({
        code: 'UPSTREAM_ERROR',
        httpStatus: response.status,
        message: `Freshdesk returned a response that is not valid JSON (HTTP ${response.status}).`,
      });
    }
  }

  #httpError(response: Response, text: string): ConnectorError {
    const status = response.status;
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.#now());
    const upstream = parseErrorBody(text);
    const suffix = upstream.message ? ` Freshdesk said: "${upstream.message}"` : '';

    switch (status) {
      case 400:
        return new ConnectorError({
          code: 'INVALID_REQUEST',
          httpStatus: status,
          message: `Freshdesk rejected the request as invalid (HTTP 400).${suffix}${describeFieldErrors(upstream.details)}`,
          details: upstream.details,
        });
      case 401:
        return new ConnectorError({
          code: 'AUTHENTICATION_FAILED',
          httpStatus: status,
          message:
            'Freshdesk rejected the API key (HTTP 401). Check FRESHDESK_API_KEY and FRESHDESK_DOMAIN. ' +
            'A human needs to fix the configuration; retrying will not help.',
        });
      case 403:
        return new ConnectorError({
          code: 'PERMISSION_DENIED',
          httpStatus: status,
          message:
            'The Freshdesk agent that owns this API key is not allowed to perform this request (HTTP 403). ' +
            `Its role, the account's plan, or a suspended account can cause this.${suffix}`,
        });
      case 404:
        return new ConnectorError({
          code: 'NOT_FOUND',
          httpStatus: status,
          message: 'The requested Freshdesk resource was not found (HTTP 404).',
        });
      case 429:
        return new ConnectorError({
          code: 'RATE_LIMITED',
          httpStatus: status,
          retryable: true,
          retryAfterMs,
          message:
            'Freshdesk API rate limit exceeded (HTTP 429).' +
            (retryAfterMs === undefined ? '' : ` Freshdesk asked to wait ${seconds(retryAfterMs)}s.`),
        });
      default:
        if (status >= 500) {
          return new ConnectorError({
            code: 'UPSTREAM_ERROR',
            httpStatus: status,
            retryable: true,
            retryAfterMs,
            message: `Freshdesk returned a server error (HTTP ${status}).`,
          });
        }
        return new ConnectorError({
          code: 'INVALID_REQUEST',
          httpStatus: status,
          message: `Freshdesk rejected the request (HTTP ${status}).${suffix}`,
        });
    }
  }

  #toConnectorError(caught: unknown): ConnectorError {
    if (caught instanceof ConnectorError) return caught;

    const name = (caught as { name?: unknown } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new ConnectorError({
        code: 'TIMEOUT',
        retryable: true,
        message: `Freshdesk did not respond within ${this.#timeoutMs} ms.`,
      });
    }

    const causeCode = (caught as { cause?: { code?: unknown } } | null)?.cause?.code;
    if (causeCode === 'ENOTFOUND') {
      return new ConnectorError({
        code: 'NETWORK_ERROR',
        message: `Could not resolve ${this.#credentials.host}. Check that FRESHDESK_DOMAIN is your Freshdesk subdomain.`,
      });
    }

    return new ConnectorError({
      code: 'NETWORK_ERROR',
      retryable: true,
      message: `Could not reach Freshdesk${typeof causeCode === 'string' ? ` (${causeCode})` : ''}.`,
    });
  }

  #buildUrl(path: string, queryString: string): URL {
    const url = new URL(path, this.#credentials.origin);
    url.search = queryString;
    // Defence in depth: paths are constants plus validated integers, but never
    // let a bug send the Authorization header anywhere else.
    if (url.origin !== this.#credentials.origin) {
      throw new ConnectorError({ code: 'INTERNAL_ERROR', message: 'Refused to call a non-Freshdesk URL.' });
    }
    return url;
  }

  #parse<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
    const result = schema.safeParse(body);
    if (result.success) return result.data;

    const issue = result.error.issues[0];
    this.#logger.warn('Unexpected Freshdesk response shape', {
      path: issue?.path.join('.'),
      issue: issue?.message,
    });
    throw new ConnectorError({
      code: 'UPSTREAM_ERROR',
      message: 'Freshdesk returned data in an unexpected format, so it was not passed to the agent.',
    });
  }
}

function hasNextPage(link: string | null): boolean {
  return link !== null && /rel="?next"?/i.test(link);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function seconds(ms: number): number {
  return Math.ceil(ms / 1000);
}

interface UpstreamError {
  message?: string;
  details?: FieldError[];
}

/**
 * Extracts Freshdesk's error description and field errors, e.g.
 * `{"description":"Validation failed","errors":[{"field":"email","message":"...","code":"invalid_value"}]}`.
 * Non-JSON bodies (HTML error pages) are ignored rather than echoed.
 */
function parseErrorBody(text: string): UpstreamError {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof body !== 'object' || body === null) return {};

  const record = body as Record<string, unknown>;
  const rawMessage = record.description ?? record.message;
  const message = typeof rawMessage === 'string' ? rawMessage.slice(0, MAX_UPSTREAM_TEXT) : undefined;

  const details = Array.isArray(record.errors)
    ? record.errors
        .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
        .slice(0, 10)
        .map((entry) => ({
          ...(typeof entry.field === 'string' && { field: entry.field }),
          message: typeof entry.message === 'string' ? entry.message.slice(0, MAX_UPSTREAM_TEXT) : 'Invalid value',
          ...(typeof entry.code === 'string' && { code: entry.code }),
        }))
    : undefined;

  return { message, details: details?.length ? details : undefined };
}

function describeFieldErrors(details: FieldError[] | undefined): string {
  if (!details?.length) return '';
  const list = details.map((detail) => (detail.field ? `${detail.field}: ${detail.message}` : detail.message));
  return ` (${list.join('; ')})`;
}
