import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp/server.js';
import { generateToolSpec } from '../src/mcp/spec.js';
import { ENCODED_TEST_AUTH, rawTicket, TEST_API_KEY } from './fixtures/tickets.js';
import { jsonResponse, type MockReply } from './helpers/mock-fetch.js';
import { createToolContext } from './helpers/setup.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** Connects a real MCP client to the server over an in-memory transport. */
async function connect(replies: MockReply[] = []) {
  const { context, requests } = createToolContext(replies);
  const server = createMcpServer(context);
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, requests };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function text(result: CallToolResult): string {
  const [first] = result.content;
  if (first?.type !== 'text') throw new Error('Expected text content');
  return first.text;
}

describe('MCP server', () => {
  it('advertises exactly three read-only tools with input and output schemas', async () => {
    const { client } = await connect();

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(['list_tickets', 'get_ticket', 'search_tickets']);
    for (const tool of tools) {
      expect(tool.description).toMatch(/Read-only\.$/);
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.outputSchema).toMatchObject({ type: 'object' });
    }
    expect(tools.find((tool) => tool.name === 'get_ticket')?.inputSchema.required).toEqual(['ticket_id']);
  });

  it('shares usage and safety instructions with the agent', async () => {
    const { client } = await connect();
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('untrusted data');
    expect(instructions).toContain('cannot create, reply to, update, assign, merge or delete');
  });

  it('returns structured content and an equivalent text block on success', async () => {
    const { client } = await connect([jsonResponse([rawTicket()])]);

    const result = await call(client, 'list_tickets', { per_page: 1 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ page: 1, per_page: 1, has_more: false, tickets: [{ id: 1001 }] });
    expect(JSON.parse(text(result))).toEqual(result.structuredContent);
  });

  it('returns invalid arguments as a tool error without calling Freshdesk', async () => {
    const { client, requests } = await connect();

    const result = await call(client, 'get_ticket', { ticket_id: 'abc' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('ticket_id');
    expect(requests).toHaveLength(0);
  });

  it('enforces cross-field rules such as "at least one search filter"', async () => {
    const { client, requests } = await connect();

    const result = await call(client, 'search_tickets', { page: 2 });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Provide at least one filter');
    expect(requests).toHaveLength(0);
  });

  it('returns structured Freshdesk errors the agent can act on', async () => {
    const { client } = await connect([new Response(null, { status: 404 })]);

    const result = await call(client, 'get_ticket', { ticket_id: 404 });

    expect(result.isError).toBe(true);
    expect(JSON.parse(text(result))).toEqual({
      error: {
        code: 'NOT_FOUND',
        http_status: 404,
        retryable: false,
        message: expect.stringContaining('Ticket 404 was not found') as unknown as string,
      },
    });
    expect(text(result)).not.toContain(TEST_API_KEY);
    expect(text(result)).not.toContain(ENCODED_TEST_AUTH);
  });

  it('does not expose any write operations', async () => {
    const { client } = await connect();

    const result = await call(client, 'delete_ticket', { ticket_id: 1001 });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not found/i);
  });

  it('keeps docs/mcp-tools.json in sync with the live tool list (run `npm run spec` to update)', async () => {
    const committed = JSON.parse(await readFile(new URL('../docs/mcp-tools.json', import.meta.url), 'utf8')) as unknown;
    expect(await generateToolSpec()).toEqual(committed);
  });
});
