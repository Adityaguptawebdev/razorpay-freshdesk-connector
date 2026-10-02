import { z } from 'zod';
import { LIMITS, LIST_FILTERS, LIST_ORDER_BY, ORDER_TYPES } from '../types/freshdesk.js';
import { toTicketSummary } from './normalize.js';
import { IsoDateOrDateTime, PositiveId, TicketSummarySchema } from './schemas.js';
import { defineTool } from './tool.js';

const inputSchema = z.strictObject({
  page: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.listMaxPage)
    .default(1)
    .describe(`Page number, starting at 1 (Freshdesk serves at most ${LIMITS.listMaxPage} pages).`),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.listMaxPerPage)
    .default(LIMITS.listDefaultPerPage)
    .describe(`Tickets per page, 1-${LIMITS.listMaxPerPage}.`),
  filter: z
    .enum(LIST_FILTERS)
    .optional()
    .describe(
      'Predefined Freshdesk view. new_and_my_open = new tickets plus open tickets assigned to the API key owner; ' +
        'watching = tickets the API key owner watches; spam; deleted.',
    ),
  requester_id: PositiveId.optional().describe('Only tickets raised by this contact ID.'),
  requester_email: z
    .email({ error: 'requester_email must be a valid email address.' })
    .max(254)
    .optional()
    .describe('Only tickets raised by the contact with this email address.'),
  company_id: PositiveId.optional().describe('Only tickets from this company ID.'),
  updated_since: IsoDateOrDateTime.optional()
    .describe(
      'Only tickets updated since this UTC date or date-time. Needed to see tickets created more than 30 days ago.',
    ),
  order_by: z.enum(LIST_ORDER_BY).default('created_at').describe('Sort field.'),
  order_type: z.enum(ORDER_TYPES).default('desc').describe('Sort direction.'),
});

const outputSchema = z.object({
  tickets: z.array(TicketSummarySchema),
  page: z.number().int(),
  per_page: z.number().int(),
  has_more: z.boolean().describe('true when another page is available.'),
  next_page: z.number().int().nullable().describe('Page number to request next, or null when there are no more.'),
});

export const listTicketsTool = defineTool({
  name: 'list_tickets',
  title: 'List Freshdesk tickets',
  description:
    'List Freshdesk support tickets as compact summaries (no description or conversation text), newest first by default. ' +
    'Freshdesk only returns tickets created in the last 30 days unless updated_since is set. ' +
    'Optionally narrow to one requester (requester_id or requester_email), one company, or a predefined view. ' +
    'Use search_tickets to filter by status, priority, tag, type, assignee or date range, and get_ticket to read one ' +
    'ticket in full. Read-only.',
  inputSchema,
  outputSchema,
  async execute(input, { api }) {
    // Freshdesk documents updated_since as a timestamp; expand bare dates to midnight UTC.
    const updatedSince =
      input.updated_since && !input.updated_since.includes('T')
        ? `${input.updated_since}T00:00:00Z`
        : input.updated_since;

    const { tickets, hasMore } = await api.listTickets({
      page: input.page,
      per_page: input.per_page,
      filter: input.filter,
      requester_id: input.requester_id,
      email: input.requester_email,
      company_id: input.company_id,
      updated_since: updatedSince,
      order_by: input.order_by,
      order_type: input.order_type,
    });

    const hasNext = hasMore && input.page < LIMITS.listMaxPage;
    return {
      tickets: tickets.map(toTicketSummary),
      page: input.page,
      per_page: input.per_page,
      has_more: hasNext,
      next_page: hasNext ? input.page + 1 : null,
    };
  },
});
