import {
  labelFor,
  PRIORITY_IDS,
  SOURCE_LABELS,
  STATUS_IDS,
  type RawConversation,
  type RawTicket,
} from '../types/freshdesk.js';
import { truncate } from '../utils/text.js';
import type { Conversation, TicketDetail, TicketSummary } from './schemas.js';

/** Caps that keep one ticket from flooding the agent's context window. */
export const MAX_DESCRIPTION_CHARS = 4_000;
export const MAX_CONVERSATION_CHARS = 2_000;

export function toTicketSummary(ticket: RawTicket): TicketSummary {
  return {
    id: ticket.id,
    subject: ticket.subject ?? '',
    status: labelFor(STATUS_IDS, ticket.status),
    status_id: ticket.status,
    priority: labelFor(PRIORITY_IDS, ticket.priority),
    source: (ticket.source != null && SOURCE_LABELS[ticket.source]) || 'other',
    type: ticket.type ?? null,
    tags: ticket.tags ?? [],
    requester_id: ticket.requester_id ?? null,
    responder_id: ticket.responder_id ?? null,
    group_id: ticket.group_id ?? null,
    company_id: ticket.company_id ?? null,
    is_escalated: ticket.is_escalated ?? false,
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
    due_by: ticket.due_by ?? null,
    fr_due_by: ticket.fr_due_by ?? null,
  };
}

export interface DetailOptions {
  requesterRequested: boolean;
  conversationsRequested: boolean;
  includePrivateNotes: boolean;
}

export function toTicketDetail(ticket: RawTicket, options: DetailOptions): TicketDetail {
  const allConversations = ticket.conversations ?? [];
  const visibleConversations = options.includePrivateNotes
    ? allConversations
    : allConversations.filter((conversation) => !conversation.private);

  return {
    ...toTicketSummary(ticket),
    description_text: truncate(ticket.description_text ?? '', MAX_DESCRIPTION_CHARS),
    custom_fields: ticket.custom_fields ?? {},
    requester:
      options.requesterRequested && ticket.requester
        ? {
            id: ticket.requester.id,
            name: ticket.requester.name ?? null,
            email: ticket.requester.email ?? null,
          }
        : null,
    conversations: options.conversationsRequested ? visibleConversations.map(toConversation) : null,
    private_notes_hidden: allConversations.length - visibleConversations.length,
  };
}

function toConversation(conversation: RawConversation): Conversation {
  return {
    id: conversation.id,
    author_role: conversation.incoming ? 'customer' : 'agent',
    private: conversation.private ?? false,
    user_id: conversation.user_id ?? null,
    created_at: conversation.created_at,
    body_text: truncate(conversation.body_text ?? '', MAX_CONVERSATION_CHARS),
  };
}
