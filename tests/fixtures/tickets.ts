/*
 * Fictional test data only. Names, emails and order IDs are made up;
 * email addresses use the reserved example.com domain.
 */

/** Obviously fake key used only by tests; it is never sent anywhere. */
export const TEST_API_KEY = 'fake_test_api_key_0001';
export const TEST_DOMAIN = 'acme-test';
export const TEST_ORIGIN = 'https://acme-test.freshdesk.com';
export const ENCODED_TEST_AUTH = Buffer.from(`${TEST_API_KEY}:X`).toString('base64');

/** Fixed clock for Retry-After HTTP-date parsing. */
export const FIXED_NOW = Date.parse('2026-10-02T10:00:00Z');

export function rawTicket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1001,
    subject: 'Refund not received for order FAKE-ORD-1001',
    status: 2,
    priority: 3,
    source: 1,
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
    description: '<div>I was charged but the refund has not arrived.</div>',
    description_text: 'I was charged but the refund has not arrived.',
    custom_fields: { cf_order_id: 'FAKE-ORD-1001' },
    // Fields Freshdesk returns that the connector intentionally drops.
    fr_escalated: false,
    spam: false,
    email_config_id: 42,
    cc_emails: ['cc.person@example.com'],
    ...overrides,
  };
}

export const rawRequester = {
  id: 5001,
  name: 'Jordan Example',
  email: 'jordan.example@example.com',
  phone: '+00 0000 000000',
  mobile: null,
};

export const rawConversations = [
  {
    id: 9001,
    body: '<div>Any update on my refund?</div>',
    body_text: 'Any update on my refund?',
    incoming: true,
    private: false,
    user_id: 5001,
    created_at: '2026-09-28T12:00:00Z',
  },
  {
    id: 9002,
    body_text: 'Internal: payment gateway shows refund initiated on 26 Sep.',
    incoming: false,
    private: true,
    user_id: 8001,
    created_at: '2026-09-28T13:00:00Z',
  },
  {
    id: 9003,
    body_text: 'Hi Jordan, your refund was initiated and should arrive within 5-7 business days.',
    incoming: false,
    private: false,
    user_id: 8001,
    created_at: '2026-09-28T13:05:00Z',
  },
];
