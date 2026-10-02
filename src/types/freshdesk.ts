import { z } from 'zod';

/*
 * Freshdesk API v2 response shapes.
 *
 * Responses are validated at runtime so an unexpected payload becomes a clear
 * UPSTREAM_ERROR instead of `undefined` leaking into the agent's output.
 * Only fields the connector uses are declared; everything else is stripped.
 * Fields are deliberately lenient (nullish) because Freshdesk omits or nulls
 * many of them depending on account configuration.
 */

const id = z.number().int();

export const RawConversationSchema = z.object({
  id,
  body_text: z.string().nullish(),
  incoming: z.boolean().nullish(),
  private: z.boolean().nullish(),
  user_id: id.nullish(),
  created_at: z.string(),
});

export const RawRequesterSchema = z.object({
  id,
  name: z.string().nullish(),
  email: z.string().nullish(),
});

export const RawTicketSchema = z.object({
  id,
  subject: z.string().nullish(),
  status: id,
  priority: id,
  source: id.nullish(),
  type: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  requester_id: id.nullish(),
  responder_id: id.nullish(),
  group_id: id.nullish(),
  company_id: id.nullish(),
  is_escalated: z.boolean().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  due_by: z.string().nullish(),
  fr_due_by: z.string().nullish(),
  description_text: z.string().nullish(),
  custom_fields: z.record(z.string(), z.unknown()).nullish(),
  requester: RawRequesterSchema.nullish(),
  conversations: z.array(RawConversationSchema).nullish(),
});

export const RawTicketListSchema = z.array(RawTicketSchema);

export const RawSearchResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  results: z.array(RawTicketSchema),
});

export type RawConversation = z.infer<typeof RawConversationSchema>;
export type RawRequester = z.infer<typeof RawRequesterSchema>;
export type RawTicket = z.infer<typeof RawTicketSchema>;
export type RawSearchResponse = z.infer<typeof RawSearchResponseSchema>;

/* Freshdesk's numeric codes, exposed to the agent as lowercase labels. */

export const TICKET_STATUSES = ['open', 'pending', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const STATUS_IDS: Record<TicketStatus, number> = { open: 2, pending: 3, resolved: 4, closed: 5 };

export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const PRIORITY_IDS: Record<TicketPriority, number> = { low: 1, medium: 2, high: 3, urgent: 4 };

export const SOURCE_LABELS: Readonly<Record<number, string>> = {
  1: 'email',
  2: 'portal',
  3: 'phone',
  7: 'chat',
  9: 'feedback_widget',
  10: 'outbound_email',
};

/** Reverse lookup; unknown codes (e.g. custom statuses) fall back to `fallback`. */
export function labelFor<T extends string>(
  ids: Record<T, number>,
  code: number,
  fallback = 'other',
): T | string {
  const match = (Object.entries(ids) as [T, number][]).find(([, value]) => value === code);
  return match ? match[0] : fallback;
}

/* Query parameters accepted by GET /api/v2/tickets. */

export const LIST_FILTERS = ['new_and_my_open', 'watching', 'spam', 'deleted'] as const;
export const LIST_ORDER_BY = ['created_at', 'due_by', 'updated_at', 'status'] as const;
export const ORDER_TYPES = ['asc', 'desc'] as const;

export interface ListTicketsParams {
  page: number;
  per_page: number;
  filter?: (typeof LIST_FILTERS)[number];
  requester_id?: number;
  email?: string;
  company_id?: number;
  updated_since?: string;
  order_by?: (typeof LIST_ORDER_BY)[number];
  order_type?: (typeof ORDER_TYPES)[number];
}

/* Freshdesk API limits that shape the tool schemas. */

export const LIMITS = {
  /** GET /tickets returns at most 300 pages. */
  listMaxPage: 300,
  listMaxPerPage: 100,
  listDefaultPerPage: 30,
  /** GET /search/tickets: fixed 30 results per page, pages 1-10 only. */
  searchPerPage: 30,
  searchMaxPage: 10,
  /** Maximum length of the search `query` string. */
  searchMaxQueryLength: 512,
  /** `include=conversations` returns at most this many conversations. */
  embeddedConversations: 10,
} as const;
