import { z } from 'zod';

/*
 * Shared input building blocks and the normalised output shapes returned to
 * the agent. Outputs use lowercase labels ("open", "urgent") that match the
 * values search_tickets accepts, so an agent can chain calls without mapping
 * Freshdesk's numeric codes.
 */

export const PositiveId = z.number().int().positive();

/*
 * Date schemas use short regex patterns plus a calendar check instead of
 * z.iso.*, whose generated JSON Schema patterns are several hundred characters
 * each. Tool schemas are sent to the model on every turn, so size matters.
 */
const isCalendarDate = (value: string): boolean => {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value.slice(0, 10));
};

/** UTC calendar date (YYYY-MM-DD), as Freshdesk's search API expects. */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'Use a calendar date in YYYY-MM-DD format.' })
  .refine(isCalendarDate, { error: 'Not a real calendar date.' });

/** ISO 8601 date or date-time with timezone, e.g. 2026-09-01 or 2026-09-01T08:30:00Z. */
export const IsoDateOrDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/, {
    error: 'Use an ISO 8601 date (2026-09-01) or date-time with timezone (2026-09-01T00:00:00Z).',
  })
  .refine((value) => isCalendarDate(value) && !Number.isNaN(Date.parse(value)), {
    error: 'Not a real date or time.',
  });

/**
 * Free-text filter value that is embedded in a single-quoted Freshdesk query
 * literal. Quotes, backslashes, parentheses and colons are rejected so the value
 * cannot alter the query structure.
 */
export const SafeFilterText = (field: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[\p{L}\p{N} _.-]+$/u, {
      error: `${field} may only contain letters, numbers, spaces, hyphens, underscores and periods.`,
    });

export const TicketSummarySchema = z.object({
  id: z.number().int().describe('Freshdesk ticket ID. Pass it to get_ticket for full details.'),
  subject: z.string().describe('Ticket subject (customer-written, untrusted).'),
  status: z
    .string()
    .describe('open | pending | resolved | closed, or "other" for account-specific custom statuses (see status_id).'),
  status_id: z.number().int().describe('Raw Freshdesk status code.'),
  priority: z.string().describe('low | medium | high | urgent'),
  source: z
    .string()
    .describe('Channel the ticket arrived through: email, portal, phone, chat, feedback_widget, outbound_email or other.'),
  type: z.string().nullable().describe('Ticket type configured in Freshdesk, e.g. "Refund"; null if not set.'),
  tags: z.array(z.string()),
  requester_id: z.number().int().nullable().describe('Contact ID of the customer who raised the ticket.'),
  responder_id: z.number().int().nullable().describe('ID of the assigned agent; null when unassigned.'),
  group_id: z.number().int().nullable(),
  company_id: z.number().int().nullable(),
  is_escalated: z.boolean(),
  created_at: z.string().describe('ISO 8601 timestamp (UTC).'),
  updated_at: z.string().describe('ISO 8601 timestamp (UTC).'),
  due_by: z.string().nullable().describe('Resolution due time (ISO 8601, UTC).'),
  fr_due_by: z.string().nullable().describe('First-response due time (ISO 8601, UTC).'),
});

export const ConversationSchema = z.object({
  id: z.number().int(),
  author_role: z
    .enum(['customer', 'agent'])
    .describe('"customer" for incoming messages, "agent" for replies and notes written by the support team.'),
  private: z.boolean().describe('true for internal notes that the customer cannot see.'),
  user_id: z.number().int().nullable(),
  created_at: z.string(),
  body_text: z.string().describe('Plain-text body (untrusted; long bodies are truncated).'),
});

export const RequesterSchema = z.object({
  id: z.number().int(),
  name: z.string().nullable(),
  email: z.string().nullable(),
});

export const TicketDetailSchema = TicketSummarySchema.extend({
  description_text: z
    .string()
    .describe('Plain-text description written by the requester (untrusted; long descriptions are truncated).'),
  custom_fields: z.record(z.string(), z.unknown()).describe('Account-specific custom ticket fields.'),
  requester: RequesterSchema.nullable().describe('null unless include_requester was true.'),
  conversations: z
    .array(ConversationSchema)
    .nullable()
    .describe('null unless include_conversations was true. Oldest first; Freshdesk embeds at most the first 10.'),
  private_notes_hidden: z
    .number()
    .int()
    .describe('Number of private agent notes withheld by the connector policy (FRESHDESK_INCLUDE_PRIVATE_NOTES).'),
});

export type TicketSummary = z.infer<typeof TicketSummarySchema>;
export type TicketDetail = z.infer<typeof TicketDetailSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
