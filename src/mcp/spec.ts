import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { FreshdeskTicketApi } from '../client/freshdesk-client.js';
import { ConnectorError } from '../utils/errors.js';
import { silentLogger } from '../utils/logger.js';
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';

export interface ToolSpec {
  server: { name: string; version: string; instructions: string | undefined };
  tools: Tool[];
}

const notAvailable = (): never => {
  throw new ConnectorError({ code: 'INTERNAL_ERROR', message: 'Freshdesk is not available while generating the tool spec.' });
};

/** Listing tools never touches Freshdesk, so no credentials are needed. */
const offlineApi: FreshdeskTicketApi = {
  listTickets: notAvailable,
  getTicket: notAvailable,
  searchTickets: notAvailable,
};

/**
 * Returns exactly what an MCP client receives from `initialize` + `tools/list`,
 * by connecting a real MCP client to the server over an in-memory transport.
 * Used to produce docs/mcp-tools.json for platforms that import tool specs.
 */
export async function generateToolSpec(): Promise<ToolSpec> {
  const server = createMcpServer({
    api: offlineApi,
    includePrivateNotes: false,
    logger: silentLogger,
    redact: (text) => text,
  });
  const client = new Client({ name: 'tool-spec-generator', version: SERVER_VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return {
      server: { name: SERVER_NAME, version: SERVER_VERSION, instructions: client.getInstructions() },
      tools,
    };
  } finally {
    await client.close();
    await server.close();
  }
}
