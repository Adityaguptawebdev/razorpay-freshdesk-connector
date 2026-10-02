import { vi } from 'vitest';

/** A queued reply: a Response, an error to throw (network failure, timeout), or a factory. */
export type MockReply = Response | Error | (() => Response);

export interface RecordedRequest {
  url: URL;
  init: RequestInit;
  headers: Headers;
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

export function rateLimited(retryAfter?: string): Response {
  return jsonResponse(
    { message: 'You have exceeded the limit of requests per minute.' },
    { status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } },
  );
}

export function networkError(code = 'ECONNRESET'): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

export function timeoutError(): DOMException {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

/**
 * A fetch replacement that replays queued replies in order and records every
 * request. Throws if the code under test makes more requests than expected.
 */
export function mockFetch(...replies: MockReply[]) {
  const queue = [...replies];
  const requests: RecordedRequest[] = [];

  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push({ url, init, headers: new Headers(init.headers) });

    const reply = queue.shift();
    if (reply === undefined) throw new Error(`Unexpected request to ${url.href}`);
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply() : reply;
  });

  return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
}
