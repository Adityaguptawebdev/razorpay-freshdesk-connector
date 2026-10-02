/**
 * Minimal MCP client for manual testing against a real Freshdesk account.
 * It launches the built server (dist/index.js) over stdio, exactly as an
 * agent platform would, then lists the tools or calls one of them.
 *
 * Usage (after `npm run build` and creating .env):
 *   npm run demo                                   # list tools
 *   npm run demo -- list_tickets '{"per_page":5}'
 *   npm run demo -- get_ticket '{"ticket_id":1,"include_conversations":true}'
 *   npm run demo -- search_tickets '{"status":["open"],"priority":["high","urgent"]}'
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY = resolve('dist/index.js');

/** Only forward connector settings to the server, not the whole parent environment. */
const FORWARDED_ENV = [
  'FRESHDESK_DOMAIN',
  'FRESHDESK_API_KEY',
  'FRESHDESK_MAX_RETRIES',
  'FRESHDESK_MAX_RETRY_WAIT_MS',
  'FRESHDESK_REQUEST_TIMEOUT_MS',
  'FRESHDESK_INCLUDE_PRIVATE_NOTES',
  'LOG_LEVEL',
];

async function main(): Promise<void> {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error('dist/index.js not found. Run `npm run build` first.');
  }

  const [toolName, rawArgs = '{}'] = process.argv.slice(2);
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    throw new Error(`Tool arguments must be a JSON object, e.g. '{"per_page":5}'. Got: ${rawArgs}`);
  }

  const env: Record<string, string> = { ...getDefaultEnvironment() };
  for (const key of FORWARDED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env,
    stderr: 'inherit', // server logs (JSON lines) appear in this terminal
  });
  const client = new Client({ name: 'freshdesk-demo-client', version: '1.0.0' });
  await client.connect(transport);

  try {
    if (!toolName) {
      const { tools } = await client.listTools();
      console.log(`Connected. ${tools.length} tools available:\n`);
      for (const tool of tools) {
        console.log(`- ${tool.name}: ${tool.description}\n`);
      }
      return;
    }

    const result = await client.callTool({ name: toolName, arguments: args });
    const text =
      Array.isArray(result.content) && result.content[0]?.type === 'text'
        ? (result.content[0].text as string)
        : undefined;
    const output = result.structuredContent ?? (text === undefined ? result.content : parseJsonOrText(text));

    // SDK-level input validation errors arrive as plain text ("MCP error -32602: ..."), not JSON.
    console.log(typeof output === 'string' ? output : JSON.stringify(output, null, 2));
    if (result.isError) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
