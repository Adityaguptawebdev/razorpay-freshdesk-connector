import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests must never depend on a real Freshdesk account.
    env: {
      FRESHDESK_DOMAIN: '',
      FRESHDESK_API_KEY: '',
    },
  },
});
