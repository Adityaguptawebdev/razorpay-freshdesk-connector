import {
  LIMITS,
  PRIORITY_IDS,
  STATUS_IDS,
  type TicketPriority,
  type TicketStatus,
} from '../types/freshdesk.js';
import { ConnectorError } from '../utils/errors.js';

/** Structured filters; the agent never writes raw Freshdesk query syntax. */
export interface TicketSearchFilters {
  status?: readonly TicketStatus[];
  priority?: readonly TicketPriority[];
  agent_id?: number;
  unassigned?: boolean;
  group_id?: number;
  tag?: string;
  type?: string;
  /** YYYY-MM-DD, inclusive. */
  created_from?: string;
  created_to?: string;
  updated_from?: string;
  updated_to?: string;
}

/**
 * Builds a Freshdesk filter query, e.g.
 * `(status:2 OR status:3) AND priority:4 AND tag:'refund' AND created_at:>'2026-01-01'`.
 *
 * Values for different fields are ANDed; multiple values for one field are ORed.
 * String values are expected to be pre-validated (no quotes or backslashes), so
 * they cannot break out of their single-quoted literal.
 * Freshdesk's `:>` and `:<` operators are inclusive (>= and <=).
 */
export function buildSearchQuery(filters: TicketSearchFilters): string {
  const clauses: string[] = [];

  if (filters.status?.length) {
    clauses.push(anyOf(filters.status.map((status) => `status:${STATUS_IDS[status]}`)));
  }
  if (filters.priority?.length) {
    clauses.push(anyOf(filters.priority.map((priority) => `priority:${PRIORITY_IDS[priority]}`)));
  }
  if (filters.unassigned) clauses.push('agent_id:null');
  if (filters.agent_id !== undefined) clauses.push(`agent_id:${filters.agent_id}`);
  if (filters.group_id !== undefined) clauses.push(`group_id:${filters.group_id}`);
  if (filters.tag !== undefined) clauses.push(`tag:'${filters.tag}'`);
  if (filters.type !== undefined) clauses.push(`type:'${filters.type}'`);
  if (filters.created_from) clauses.push(`created_at:>'${filters.created_from}'`);
  if (filters.created_to) clauses.push(`created_at:<'${filters.created_to}'`);
  if (filters.updated_from) clauses.push(`updated_at:>'${filters.updated_from}'`);
  if (filters.updated_to) clauses.push(`updated_at:<'${filters.updated_to}'`);

  if (clauses.length === 0) {
    throw new ConnectorError({
      code: 'INVALID_INPUT',
      message: 'At least one search filter is required.',
    });
  }

  const query = clauses.join(' AND ');
  if (query.length > LIMITS.searchMaxQueryLength) {
    throw new ConnectorError({
      code: 'INVALID_INPUT',
      message: `The combined filters produce a query longer than Freshdesk's ${LIMITS.searchMaxQueryLength}-character limit. Use fewer or shorter filters.`,
    });
  }
  return query;
}

function anyOf(terms: string[]): string {
  const unique = [...new Set(terms)];
  return unique.length === 1 ? unique[0]! : `(${unique.join(' OR ')})`;
}
