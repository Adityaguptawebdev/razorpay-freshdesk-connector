import { describe, expect, it } from 'vitest';
import type { FreshdeskTicketApi } from '../src/client/freshdesk-client.js';
import { MAX_DESCRIPTION_CHARS } from '../src/tools/normalize.js';
import { getTicketTool, listTicketsTool, runTool, searchTicketsTool, type ToolResult } from '../src/tools/index.js';
import { silentLogger } from '../src/utils/logger.js';
import {
  ENCODED_TEST_AUTH,
  rawConversations,
  rawRequester,
  rawTicket,
  TEST_API_KEY,
  TEST_ORIGIN,
} from './fixtures/tickets.js';
import { jsonResponse, rateLimited } from './helpers/mock-fetch.js';
import { createToolContext } from './helpers/setup.js';

function expectSuccess(result: ToolResult): Record<string, any> {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
  return result.data;
}

function expectFailure(result: ToolResult) {
  if (result.ok) throw new Error(`Expected failure, got ${JSON.stringify(result.data)}`);
  return result.error.error;
}

describe('list_tickets', () => {
  it('returns normalised ticket summaries with pagination hints', async () => {
    const { context } = createToolContext([
      jsonResponse([rawTicket(), rawTicket({ id: 1002, status: 6, priority: 4, source: 99, tags: null })], {
        headers: { link: `<${TEST_ORIGIN}/api/v2/tickets?page=2>;rel="next"` },
      }),
    ]);

    const data = expectSuccess(await runTool(listTicketsTool, {}, context));

    expect(data).toMatchObject({ page: 1, per_page: 30, has_more: true, next_page: 2 });
    expect(data.tickets[0]).toEqual({
      id: 1001,
      subject: 'Refund not received for order FAKE-ORD-1001',
      status: 'open',
      status_id: 2,
      priority: 'high',
      source: 'email',
      type: 'Refund',
      tags: ['refund', 'upi'],
      requester_id: 5001,
      responder_id: null,
      group_id: 7001,
      company_id: null,
      is_escalated: false,
      created_at: '2026-09-28T10:15:00Z',
      updated_at: '2026-09-29T08:00:00Z',
      due_by: '2026-10-01T10:15:00Z',
      fr_due_by: '2026-09-28T18:15:00Z',
    });
    // Custom status and unknown source fall back to safe labels.
    expect(data.tickets[1]).toMatchObject({ status: 'other', status_id: 6, priority: 'urgent', source: 'other', tags: [] });
    expect(listTicketsTool.outputSchema.safeParse(data).success).toBe(true);
  });

  it('maps agent-friendly filters onto Freshdesk query parameters', async () => {
    const { context, requests } = createToolContext([jsonResponse([])]);

    expectSuccess(
      await runTool(
        listTicketsTool,
        { requester_email: 'jordan.example@example.com', updated_since: '2026-09-01', per_page: 5, page: 3 },
        context,
      ),
    );

    expect(Object.fromEntries(requests[0]!.url.searchParams)).toEqual({
      page: '3',
      per_page: '5',
      email: 'jordan.example@example.com',
      updated_since: '2026-09-01T00:00:00Z',
      order_by: 'created_at',
      order_type: 'desc',
    });
  });

  it('stops advertising pages beyond Freshdesk’s 300-page limit', async () => {
    const { context } = createToolContext([
      jsonResponse([], { headers: { link: `<${TEST_ORIGIN}/api/v2/tickets?page=301>;rel="next"` } }),
    ]);
    const data = expectSuccess(await runTool(listTicketsTool, { page: 300 }, context));
    expect(data).toMatchObject({ has_more: false, next_page: null });
  });

  it.each([
    [{ per_page: 500 }, 'per_page'],
    [{ page: 0 }, 'page'],
    [{ requester_email: 'not-an-email' }, 'requester_email'],
    [{ updated_since: 'last tuesday' }, 'updated_since'],
    [{ updated_since: '2026-02-30' }, 'updated_since'],
    [{ order_by: 'priority' }, 'order_by'],
    [{ status: 'open' }, undefined],
  ])('rejects %j before calling Freshdesk', async (args, field) => {
    const { context, requests } = createToolContext([]);

    const error = expectFailure(await runTool(listTicketsTool, args, context));

    expect(error.code).toBe('INVALID_INPUT');
    expect(error.retryable).toBe(false);
    if (field) expect(error.details?.map((detail) => detail.field)).toContain(field);
    expect(requests).toHaveLength(0);
  });
});

describe('get_ticket', () => {
  const fullTicket = rawTicket({ requester: rawRequester, conversations: rawConversations });

  it('returns the ticket with requester and public conversations, hiding private notes by default', async () => {
    const { context, requests } = createToolContext([jsonResponse(fullTicket)]);

    const data = expectSuccess(
      await runTool(getTicketTool, { ticket_id: 1001, include_conversations: true, include_requester: true }, context),
    );

    expect(requests[0]!.url.searchParams.get('include')).toBe('requester,conversations');
    const { ticket } = data;
    expect(ticket).toMatchObject({
      id: 1001,
      status: 'open',
      description_text: 'I was charged but the refund has not arrived.',
      custom_fields: { cf_order_id: 'FAKE-ORD-1001' },
      requester: { id: 5001, name: 'Jordan Example', email: 'jordan.example@example.com' },
      private_notes_hidden: 1,
    });
    // Data minimisation: phone numbers and HTML bodies are not passed through.
    expect(ticket.requester).not.toHaveProperty('phone');
    expect(ticket).not.toHaveProperty('description');
    expect(ticket.conversations).toEqual([
      {
        id: 9001,
        author_role: 'customer',
        private: false,
        user_id: 5001,
        created_at: '2026-09-28T12:00:00Z',
        body_text: 'Any update on my refund?',
      },
      {
        id: 9003,
        author_role: 'agent',
        private: false,
        user_id: 8001,
        created_at: '2026-09-28T13:05:00Z',
        body_text: 'Hi Jordan, your refund was initiated and should arrive within 5-7 business days.',
      },
    ]);
    expect(getTicketTool.outputSchema.safeParse(data).success).toBe(true);
  });

  it('includes private notes only when the deployment explicitly allows it', async () => {
    const { context } = createToolContext([jsonResponse(fullTicket)], { includePrivateNotes: true });
    const { ticket } = expectSuccess(await runTool(getTicketTool, { ticket_id: 1001, include_conversations: true }, context));
    expect(ticket.conversations.map((conversation: { id: number }) => conversation.id)).toEqual([9001, 9002, 9003]);
    expect(ticket.private_notes_hidden).toBe(0);
  });

  it('does not request or return embeds the agent did not ask for', async () => {
    const { context, requests } = createToolContext([jsonResponse(rawTicket())]);
    const { ticket } = expectSuccess(await runTool(getTicketTool, { ticket_id: 1001 }, context));
    expect(requests[0]!.url.search).toBe('');
    expect(ticket).toMatchObject({ requester: null, conversations: null, private_notes_hidden: 0 });
  });

  it('truncates very long descriptions to protect the agent’s context window', async () => {
    const longText = 'a'.repeat(MAX_DESCRIPTION_CHARS + 500);
    const { context } = createToolContext([jsonResponse(rawTicket({ description_text: longText }))]);
    const { ticket } = expectSuccess(await runTool(getTicketTool, { ticket_id: 1001 }, context));
    expect(ticket.description_text).toHaveLength(MAX_DESCRIPTION_CHARS + '… [truncated 500 characters]'.length);
    expect(ticket.description_text.endsWith('… [truncated 500 characters]')).toBe(true);
  });

  it.each([[{}], [{ ticket_id: 0 }], [{ ticket_id: -1 }], [{ ticket_id: 1.5 }], [{ ticket_id: '1001' }], [{ ticket_id: null }]])(
    'rejects invalid arguments %j',
    async (args) => {
      const { context, requests } = createToolContext([]);
      const error = expectFailure(await runTool(getTicketTool, args, context));
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.details?.[0]?.field).toBe('ticket_id');
      expect(requests).toHaveLength(0);
    },
  );

  it('returns NOT_FOUND for a ticket that does not exist', async () => {
    const { context } = createToolContext([new Response(null, { status: 404 })]);
    const error = expectFailure(await runTool(getTicketTool, { ticket_id: 999999 }, context));
    expect(error).toMatchObject({ code: 'NOT_FOUND', http_status: 404, retryable: false });
    expect(error.message).toContain('Ticket 999999 was not found');
  });
});

describe('search_tickets', () => {
  it('translates structured filters into a Freshdesk query and reports pagination', async () => {
    const { context, requests } = createToolContext([jsonResponse({ total: 45, results: [rawTicket()] })]);

    const data = expectSuccess(
      await runTool(
        searchTicketsTool,
        { status: ['open', 'pending'], priority: ['urgent'], tag: 'refund', created_from: '2026-09-01' },
        context,
      ),
    );

    const expectedQuery = "(status:2 OR status:3) AND priority:4 AND tag:'refund' AND created_at:>'2026-09-01'";
    expect(requests[0]!.url.searchParams.get('query')).toBe(`"${expectedQuery}"`);
    expect(data).toMatchObject({ total: 45, page: 1, per_page: 30, has_more: true, next_page: 2, query: expectedQuery });
    expect(data.tickets[0]).toMatchObject({ id: 1001, status: 'open' });
    expect(searchTicketsTool.outputSchema.safeParse(data).success).toBe(true);
  });

  it('finds unassigned tickets', async () => {
    const { context, requests } = createToolContext([jsonResponse({ total: 0, results: [] })]);
    expectSuccess(await runTool(searchTicketsTool, { unassigned: true, status: ['open'] }, context));
    expect(requests[0]!.url.searchParams.get('query')).toBe('"status:2 AND agent_id:null"');
  });

  it.each([
    [{ page: 2 }, 60, false],
    [{ page: 2 }, 61, true],
    [{ page: 10 }, 900, false],
  ])('computes has_more for %j with total %i', async (args, total, hasMore) => {
    const { context } = createToolContext([jsonResponse({ total, results: [] })]);
    const data = expectSuccess(await runTool(searchTicketsTool, { status: ['open'], ...args }, context));
    expect(data.has_more).toBe(hasMore);
  });

  it.each([
    [{}, 'no filters'],
    [{ unassigned: false, page: 2 }, 'only non-filter fields'],
    [{ tag: "refund' OR status:5" }, 'quote injection'],
    [{ type: 'Question) OR (status:5' }, 'parenthesis injection'],
    [{ tag: 'a\\b' }, 'backslash'],
    [{ tag: '   ' }, 'blank tag'],
    [{ status: [] }, 'empty status list'],
    [{ status: ['escalated'] }, 'unknown status'],
    [{ created_from: '2026-09-30', created_to: '2026-09-01' }, 'reversed date range'],
    [{ updated_from: '2026/09/01' }, 'wrong date format'],
    [{ agent_id: 8001, unassigned: true }, 'contradictory assignment filters'],
    [{ status: ['open'], page: 11 }, 'page beyond Freshdesk limit'],
    [{ status: ['open'], query: 'priority:4' }, 'raw query not accepted'],
  ])('rejects %j (%s) before calling Freshdesk', async (args, _reason) => {
    const { context, requests } = createToolContext([]);
    const error = expectFailure(await runTool(searchTicketsTool, args, context));
    expect(error.code).toBe('INVALID_INPUT');
    expect(requests).toHaveLength(0);
  });
});

describe('error handling across tools', () => {
  it('returns AUTHENTICATION_FAILED without exposing credentials', async () => {
    const { context, logs } = createToolContext([
      jsonResponse({ code: 'invalid_credentials', message: 'You have to be logged in to perform this action.' }, { status: 401 }),
    ]);

    const result = await runTool(listTicketsTool, {}, context);
    const error = expectFailure(result);

    expect(error).toMatchObject({ code: 'AUTHENTICATION_FAILED', http_status: 401, retryable: false });
    for (const text of [JSON.stringify(result), ...logs]) {
      expect(text).not.toContain(TEST_API_KEY);
      expect(text).not.toContain(ENCODED_TEST_AUTH);
    }
  });

  it('returns RATE_LIMITED with a retry hint once retries are exhausted', async () => {
    const { context, sleep } = createToolContext([rateLimited('3'), rateLimited('3'), rateLimited('3'), rateLimited('3')]);
    const error = expectFailure(await runTool(searchTicketsTool, { priority: ['urgent'] }, context));
    expect(error).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retry_after_seconds: 3, attempts: 4 });
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('hides unexpected internal errors behind a generic INTERNAL_ERROR', async () => {
    const failingApi: FreshdeskTicketApi = {
      listTickets: async () => {
        throw new Error(`database exploded with key ${TEST_API_KEY}`);
      },
      getTicket: async () => rawTicket() as never,
      searchTickets: async () => ({ total: 0, tickets: [] }),
    };
    const result = await runTool(listTicketsTool, {}, {
      api: failingApi,
      includePrivateNotes: false,
      logger: silentLogger,
      redact: (text) => text,
    });

    const error = expectFailure(result);
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(result)).not.toContain('database exploded');
    expect(JSON.stringify(result)).not.toContain(TEST_API_KEY);
  });
});
