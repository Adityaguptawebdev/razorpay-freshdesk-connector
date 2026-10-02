import { describe, expect, it } from 'vitest';
import type { FreshdeskClient } from '../src/client/freshdesk-client.js';
import { ConnectorError } from '../src/utils/errors.js';
import { ENCODED_TEST_AUTH, rawTicket, TEST_API_KEY, TEST_ORIGIN } from './fixtures/tickets.js';
import { jsonResponse, networkError, rateLimited, timeoutError } from './helpers/mock-fetch.js';
import { createTestClient } from './helpers/setup.js';

const LIST_PARAMS = { page: 1, per_page: 30 } as const;

async function captureError(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectorError);
    return error as ConnectorError;
  }
  throw new Error('Expected the call to fail');
}

describe('FreshdeskClient requests', () => {
  it('sends an authenticated, read-only GET to the configured Freshdesk host', async () => {
    const { client, requests } = createTestClient([
      jsonResponse([rawTicket()], { headers: { link: `<${TEST_ORIGIN}/api/v2/tickets?page=2>;rel="next"` } }),
    ]);

    const page = await client.listTickets({ ...LIST_PARAMS, order_by: 'updated_at', order_type: 'asc' });

    expect(page.hasMore).toBe(true);
    expect(page.tickets.map((ticket) => ticket.id)).toEqual([1001]);

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.url.origin).toBe(TEST_ORIGIN);
    expect(request!.url.pathname).toBe('/api/v2/tickets');
    expect(Object.fromEntries(request!.url.searchParams)).toEqual({
      page: '1',
      per_page: '30',
      order_by: 'updated_at',
      order_type: 'asc',
    });
    expect(request!.init.method).toBe('GET');
    expect(request!.init.redirect).toBe('manual');
    expect(request!.init.signal).toBeInstanceOf(AbortSignal);
    expect(request!.headers.get('authorization')).toBe(`Basic ${ENCODED_TEST_AUTH}`);
    expect(request!.headers.get('accept')).toBe('application/json');
  });

  it('reports no further pages when Freshdesk sends no Link header', async () => {
    const { client } = createTestClient([jsonResponse([])]);
    await expect(client.listTickets(LIST_PARAMS)).resolves.toEqual({ tickets: [], hasMore: false });
  });

  it('fetches a single ticket with requested embeds', async () => {
    const { client, requests } = createTestClient([jsonResponse(rawTicket({ id: 1002 }))]);

    const ticket = await client.getTicket(1002, { requester: true, conversations: true });

    expect(ticket.id).toBe(1002);
    expect(requests[0]!.url.pathname).toBe('/api/v2/tickets/1002');
    expect(requests[0]!.url.searchParams.get('include')).toBe('requester,conversations');
  });

  it('refuses invalid ticket IDs without making a request', async () => {
    const { client, requests } = createTestClient([]);
    for (const id of [0, -5, 1.5, Number.NaN]) {
      expect((await captureError(client.getTicket(id))).code).toBe('INVALID_INPUT');
    }
    expect(requests).toHaveLength(0);
  });

  it('sends search queries quoted and percent-encoded', async () => {
    const { client, requests } = createTestClient([jsonResponse({ total: 1, results: [rawTicket()] })]);

    const result = await client.searchTickets("status:2 AND tag:'refund'", 2);

    expect(result).toMatchObject({ total: 1 });
    expect(requests[0]!.url.pathname).toBe('/api/v2/search/tickets');
    expect(requests[0]!.url.searchParams.get('query')).toBe(`"status:2 AND tag:'refund'"`);
    expect(requests[0]!.url.searchParams.get('page')).toBe('2');
    expect(requests[0]!.url.search).toContain('%20AND%20');
    expect(requests[0]!.url.search).not.toContain('+');
  });
});

describe('FreshdeskClient error mapping', () => {
  it('maps 400 validation errors, including Freshdesk field details', async () => {
    const { client, requests } = createTestClient([
      jsonResponse(
        {
          description: 'Validation failed',
          errors: [{ field: 'email', message: 'It should be a valid email address', code: 'invalid_value' }],
        },
        { status: 400 },
      ),
    ]);

    const error = await captureError(client.listTickets({ ...LIST_PARAMS, email: 'x@example.com' }));

    expect(error).toMatchObject({ code: 'INVALID_REQUEST', httpStatus: 400, retryable: false });
    expect(error.message).toContain('Validation failed');
    expect(error.message).toContain('email: It should be a valid email address');
    expect(error.details).toEqual([
      { field: 'email', message: 'It should be a valid email address', code: 'invalid_value' },
    ]);
    expect(requests).toHaveLength(1);
  });

  it('maps 401 to AUTHENTICATION_FAILED without retrying or leaking the key', async () => {
    const { client, requests, logs } = createTestClient([
      jsonResponse({ code: 'invalid_credentials', message: 'You have to be logged in to perform this action.' }, { status: 401 }),
    ]);

    const error = await captureError(client.listTickets(LIST_PARAMS));

    expect(error).toMatchObject({ code: 'AUTHENTICATION_FAILED', httpStatus: 401, retryable: false });
    expect(requests).toHaveLength(1);
    for (const text of [error.message, JSON.stringify(error.toPayload()), ...logs]) {
      expect(text).not.toContain(TEST_API_KEY);
      expect(text).not.toContain(ENCODED_TEST_AUTH);
    }
  });

  it('maps 403 to PERMISSION_DENIED and includes Freshdesk’s reason', async () => {
    const { client } = createTestClient([
      jsonResponse({ code: 'access_denied', message: 'You are not authorized to perform this action.' }, { status: 403 }),
    ]);
    const error = await captureError(client.listTickets(LIST_PARAMS));
    expect(error).toMatchObject({ code: 'PERMISSION_DENIED', httpStatus: 403, retryable: false });
    expect(error.message).toContain('You are not authorized to perform this action.');
  });

  it('maps a missing ticket to NOT_FOUND with a ticket-specific message', async () => {
    const { client, requests } = createTestClient([new Response(null, { status: 404 })]);
    const error = await captureError(client.getTicket(424242));
    expect(error).toMatchObject({ code: 'NOT_FOUND', httpStatus: 404, retryable: false });
    expect(error.message).toContain('Ticket 424242 was not found');
    expect(requests).toHaveLength(1);
  });

  it.each([
    ['listTickets', (client: FreshdeskClient) => client.listTickets(LIST_PARAMS)],
    ['searchTickets', (client: FreshdeskClient) => client.searchTickets('status:2', 1)],
  ])('points a 404 from %s at FRESHDESK_DOMAIN', async (_name, call) => {
    const { client, requests } = createTestClient([new Response(null, { status: 404 })]);
    const error = await captureError(call(client));
    expect(error).toMatchObject({ code: 'NOT_FOUND', httpStatus: 404, retryable: false });
    expect(error.message).toContain('FRESHDESK_DOMAIN');
    expect(error.message).toContain(new URL(TEST_ORIGIN).host);
    expect(requests).toHaveLength(1);
  });

  it('maps other 4xx responses to INVALID_REQUEST', async () => {
    const { client } = createTestClient([jsonResponse({ message: 'Method not allowed' }, { status: 405 })]);
    expect(await captureError(client.listTickets(LIST_PARAMS))).toMatchObject({
      code: 'INVALID_REQUEST',
      httpStatus: 405,
      retryable: false,
    });
  });

  it('does not echo non-JSON error pages', async () => {
    const { client } = createTestClient([
      new Response('<html><body>Internal details</body></html>', { status: 403, headers: { 'content-type': 'text/html' } }),
    ]);
    const error = await captureError(client.listTickets(LIST_PARAMS));
    expect(error.message).not.toContain('<html>');
  });

  it('refuses to follow redirects so the API key never leaves the Freshdesk host', async () => {
    const { client, requests } = createTestClient([
      new Response(null, { status: 302, headers: { location: 'https://attacker.example/collect' } }),
    ]);
    const error = await captureError(client.listTickets(LIST_PARAMS));
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', httpStatus: 302, retryable: false });
    expect(requests).toHaveLength(1);
  });

  it('rejects responses that are not JSON', async () => {
    const { client } = createTestClient([new Response('not json', { status: 200 })]);
    const error = await captureError(client.listTickets(LIST_PARAMS));
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: false });
    expect(error.message).toContain('not valid JSON');
  });

  it('rejects JSON with an unexpected shape instead of passing it to the agent', async () => {
    const { client } = createTestClient([jsonResponse({ tickets: 'not-an-array' })]);
    const error = await captureError(client.listTickets(LIST_PARAMS));
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: false });
    expect(error.message).toContain('unexpected format');
  });

  it('does not retry when the Freshdesk host cannot be resolved', async () => {
    const { client, requests, sleep } = createTestClient([networkError('ENOTFOUND')]);
    const error = await captureError(client.listTickets(LIST_PARAMS));
    expect(error).toMatchObject({ code: 'NETWORK_ERROR', retryable: false });
    expect(error.message).toContain('acme-test.freshdesk.com');
    expect(requests).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('FreshdeskClient rate limiting and retries', () => {
  it('waits for Retry-After and then succeeds', async () => {
    const { client, requests, sleep, logs } = createTestClient([rateLimited('2'), jsonResponse([rawTicket()])]);

    const page = await client.listTickets(LIST_PARAMS);

    expect(page.tickets).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2_000);
    const retryLog = logs.map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => entry.level === 'warn');
    expect(retryLog).toMatchObject({ code: 'RATE_LIMITED', httpStatus: 429, delayMs: 2_000, delaySource: 'retry-after' });
  });

  it('honours Retry-After given as an HTTP-date', async () => {
    const { client, sleep } = createTestClient([
      rateLimited('Fri, 02 Oct 2026 10:00:05 GMT'),
      jsonResponse([]),
    ]);
    await client.listTickets(LIST_PARAMS);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('falls back to exponential backoff with jitter when Retry-After is missing', async () => {
    const { client, sleep } = createTestClient([rateLimited(), rateLimited(), rateLimited(), jsonResponse([])]);

    await client.listTickets(LIST_PARAMS);

    // base 1000ms doubling per retry; equal jitter with random()=0.5 gives 75% of each step.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([750, 1_500, 3_000]);
  });

  it('stops backing off once the per-call wait budget would be exceeded', async () => {
    const { client, requests, sleep } = createTestClient([rateLimited(), rateLimited(), rateLimited()], {
      retry: { maxRetries: 3, baseDelayMs: 1_000, maxWaitMs: 3_000 },
    });

    const error = await captureError(client.listTickets(LIST_PARAMS));

    // Waits 750 + 1500 = 2250ms; the next step (2250ms) would push the total past 3000ms.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([750, 1_500]);
    expect(requests).toHaveLength(3);
    expect(error).toMatchObject({ code: 'RATE_LIMITED', retryable: true, attempts: 3, retryAfterMs: 2_250 });
    expect(error.message).toContain('retry budget of 3s per call');
  });

  it('counts Retry-After waits against the per-call budget', async () => {
    const { client, requests, sleep } = createTestClient([rateLimited('15'), rateLimited('15')]);

    const error = await captureError(client.listTickets(LIST_PARAMS));

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([15_000]);
    expect(requests).toHaveLength(2);
    expect(error).toMatchObject({ code: 'RATE_LIMITED', attempts: 2 });
    expect(error.toPayload().error.retry_after_seconds).toBe(15);
  });

  it('gives up with RATE_LIMITED after maxRetries and tells the agent when to retry', async () => {
    const { client, requests, sleep } = createTestClient([
      rateLimited('1'),
      rateLimited('1'),
      rateLimited('1'),
      rateLimited('7'),
    ]);

    const error = await captureError(client.listTickets(LIST_PARAMS));

    expect(error).toMatchObject({ code: 'RATE_LIMITED', httpStatus: 429, retryable: true, attempts: 4 });
    expect(error.message).toContain('Gave up after 4 attempts');
    expect(error.toPayload().error.retry_after_seconds).toBe(7);
    expect(requests).toHaveLength(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('fails fast when Retry-After is longer than the connector is willing to wait', async () => {
    const { client, requests, sleep } = createTestClient([rateLimited('120')]);

    const error = await captureError(client.listTickets(LIST_PARAMS));

    expect(error).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterMs: 120_000, attempts: 1 });
    expect(error.message).toContain('Freshdesk asked to wait 120s');
    expect(error.message).toContain("would exceed this connector's retry budget of 20s per call; try again later");
    expect(requests).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('makes exactly one attempt when maxRetries is 0', async () => {
    const { client, requests } = createTestClient([rateLimited('1')], { retry: { maxRetries: 0 } });
    const error = await captureError(client.listTickets(LIST_PARAMS));
    expect(error.message).toContain('Gave up after 1 attempt.');
    expect(requests).toHaveLength(1);
  });

  it('retries transient 5xx errors', async () => {
    const { client, requests } = createTestClient([
      jsonResponse({ message: 'Service Unavailable' }, { status: 503 }),
      jsonResponse([rawTicket()]),
    ]);
    await expect(client.listTickets(LIST_PARAMS)).resolves.toMatchObject({ hasMore: false });
    expect(requests).toHaveLength(2);
  });

  it('returns UPSTREAM_ERROR when 5xx errors persist', async () => {
    const serverError = () => jsonResponse({}, { status: 500 });
    const { client, requests } = createTestClient([serverError, serverError, serverError, serverError]);
    const error = await captureError(client.listTickets(LIST_PARAMS));
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', httpStatus: 500, attempts: 4 });
    expect(requests).toHaveLength(4);
  });

  it('retries network failures', async () => {
    const { client, requests } = createTestClient([networkError('ECONNRESET'), jsonResponse([])]);
    await expect(client.listTickets(LIST_PARAMS)).resolves.toEqual({ tickets: [], hasMore: false });
    expect(requests).toHaveLength(2);
  });

  it('returns TIMEOUT after repeated timeouts', async () => {
    const { client, requests } = createTestClient(
      [timeoutError(), timeoutError(), timeoutError()],
      { retry: { maxRetries: 2 }, timeoutMs: 5_000 },
    );
    const error = await captureError(client.listTickets(LIST_PARAMS));
    expect(error).toMatchObject({ code: 'TIMEOUT', retryable: true, attempts: 3 });
    expect(error.message).toContain('within 5000 ms');
    expect(requests).toHaveLength(3);
  });

  it('stops retrying as soon as a non-retryable error occurs', async () => {
    const { client, requests } = createTestClient([rateLimited('1'), new Response(null, { status: 404 })]);
    const error = await captureError(client.getTicket(1001));
    expect(error.code).toBe('NOT_FOUND');
    expect(requests).toHaveLength(2);
  });
});
