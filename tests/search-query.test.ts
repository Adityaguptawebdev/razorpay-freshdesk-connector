import { describe, expect, it } from 'vitest';
import { buildSearchQuery } from '../src/client/search-query.js';
import { ConnectorError } from '../src/utils/errors.js';

describe('buildSearchQuery', () => {
  it('maps status and priority labels to Freshdesk codes', () => {
    expect(buildSearchQuery({ status: ['open'] })).toBe('status:2');
    expect(buildSearchQuery({ priority: ['urgent'] })).toBe('priority:4');
  });

  it('ORs multiple values for one field and ANDs different fields', () => {
    expect(buildSearchQuery({ status: ['open', 'pending'], priority: ['high', 'urgent'], group_id: 11 })).toBe(
      '(status:2 OR status:3) AND (priority:3 OR priority:4) AND group_id:11',
    );
  });

  it('removes duplicate values', () => {
    expect(buildSearchQuery({ status: ['open', 'open'] })).toBe('status:2');
  });

  it('quotes string values and uses inclusive date operators', () => {
    expect(
      buildSearchQuery({
        tag: 'refund',
        type: 'Feature Request',
        created_from: '2026-09-01',
        created_to: '2026-09-30',
        updated_from: '2026-09-15',
        updated_to: '2026-10-01',
      }),
    ).toBe(
      "tag:'refund' AND type:'Feature Request' AND created_at:>'2026-09-01' AND created_at:<'2026-09-30' " +
        "AND updated_at:>'2026-09-15' AND updated_at:<'2026-10-01'",
    );
  });

  it('supports assigned and unassigned agent filters', () => {
    expect(buildSearchQuery({ agent_id: 8001 })).toBe('agent_id:8001');
    expect(buildSearchQuery({ unassigned: true })).toBe('agent_id:null');
    expect(() => buildSearchQuery({ unassigned: false })).toThrow(ConnectorError);
  });

  it('requires at least one filter', () => {
    expect(() => buildSearchQuery({})).toThrow(/At least one search filter is required/);
  });

  it("rejects queries longer than Freshdesk's 512-character limit", () => {
    expect(() => buildSearchQuery({ tag: 'x'.repeat(520) })).toThrow(/512-character limit/);
  });
});
