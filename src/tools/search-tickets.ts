import { z } from 'zod';
import { buildSearchQuery } from '../client/search-query.js';
import { LIMITS, TICKET_PRIORITIES, TICKET_STATUSES } from '../types/freshdesk.js';
import { toTicketSummary } from './normalize.js';
import { IsoDate, PositiveId, SafeFilterText, TicketSummarySchema } from './schemas.js';
import { defineTool } from './tool.js';

const FILTER_KEYS = [
  'status',
  'priority',
  'agent_id',
  'unassigned',
  'group_id',
  'tag',
  'type',
  'created_from',
  'created_to',
  'updated_from',
  'updated_to',
] as const;

const inputSchema = z
  .strictObject({
    status: z
      .array(z.enum(TICKET_STATUSES))
      .min(1)
      .max(TICKET_STATUSES.length)
      .optional()
      .describe('Match tickets in ANY of these statuses.'),
    priority: z
      .array(z.enum(TICKET_PRIORITIES))
      .min(1)
      .max(TICKET_PRIORITIES.length)
      .optional()
      .describe('Match tickets with ANY of these priorities.'),
    agent_id: PositiveId.optional().describe('Only tickets assigned to this agent ID.'),
    unassigned: z.boolean().optional().describe('true = only tickets with no assigned agent.'),
    group_id: PositiveId.optional().describe('Only tickets assigned to this group ID.'),
    tag: SafeFilterText('tag').optional().describe('Only tickets with this tag, e.g. "refund".'),
    type: SafeFilterText('type')
      .optional()
      .describe('Ticket type exactly as configured in Freshdesk, e.g. "Question", "Incident", "Problem", "Refund".'),
    created_from: IsoDate.optional().describe('Created on or after this UTC date (YYYY-MM-DD).'),
    created_to: IsoDate.optional().describe('Created on or before this UTC date (YYYY-MM-DD).'),
    updated_from: IsoDate.optional().describe('Updated on or after this UTC date (YYYY-MM-DD).'),
    updated_to: IsoDate.optional().describe('Updated on or before this UTC date (YYYY-MM-DD).'),
    page: z
      .number()
      .int()
      .min(1)
      .max(LIMITS.searchMaxPage)
      .default(1)
      .describe(`Page number, 1-${LIMITS.searchMaxPage} (${LIMITS.searchPerPage} tickets per page).`),
  })
  .superRefine((input, ctx) => {
    const hasFilter = FILTER_KEYS.some((key) => (key === 'unassigned' ? input.unassigned === true : input[key] !== undefined));
    if (!hasFilter) {
      ctx.addIssue({
        code: 'custom',
        message: `Provide at least one filter: ${FILTER_KEYS.join(', ')}. To browse recent tickets without filters, use list_tickets.`,
      });
    }
    if (input.agent_id !== undefined && input.unassigned) {
      ctx.addIssue({ code: 'custom', path: ['unassigned'], message: 'Use either agent_id or unassigned=true, not both.' });
    }
    for (const [from, to] of [
      ['created_from', 'created_to'],
      ['updated_from', 'updated_to'],
    ] as const) {
      const start = input[from];
      const end = input[to];
      if (start && end && start > end) {
        ctx.addIssue({ code: 'custom', path: [from], message: `${from} must be on or before ${to}.` });
      }
    }
  });

const outputSchema = z.object({
  tickets: z.array(TicketSummarySchema),
  total: z
    .number()
    .int()
    .describe(
      `Total matching tickets according to Freshdesk. Only the first ${LIMITS.searchMaxPage * LIMITS.searchPerPage} can be paged through.`,
    ),
  page: z.number().int(),
  per_page: z.number().int(),
  has_more: z.boolean().describe('true when another page can be requested.'),
  next_page: z.number().int().nullable().describe('Page number to request next, or null when there are no more.'),
  query: z.string().describe('The Freshdesk filter query the connector executed (for transparency and debugging).'),
});

export const searchTicketsTool = defineTool({
  name: 'search_tickets',
  title: 'Search Freshdesk tickets',
  description:
    'Find Freshdesk tickets using structured filters: status, priority, assigned agent or group, unassigned, tag, type, ' +
    'and created/updated date ranges. Different filters are combined with AND; multiple values in one list are combined ' +
    'with OR (e.g. status ["open","pending"]). At least one filter is required. Dates are UTC calendar dates and ranges ' +
    `are inclusive. Returns ${LIMITS.searchPerPage} summaries per page plus the total match count; Freshdesk caps results at ` +
    `${LIMITS.searchMaxPage} pages, so narrow the filters when total is large. Read-only.`,
  inputSchema,
  outputSchema,
  async execute(input, { api }) {
    const query = buildSearchQuery(input);
    const { tickets, total } = await api.searchTickets(query, input.page);

    const hasNext =
      input.page < LIMITS.searchMaxPage && input.page * LIMITS.searchPerPage < total;
    return {
      tickets: tickets.map(toTicketSummary),
      total,
      page: input.page,
      per_page: LIMITS.searchPerPage,
      has_more: hasNext,
      next_page: hasNext ? input.page + 1 : null,
      query,
    };
  },
});
