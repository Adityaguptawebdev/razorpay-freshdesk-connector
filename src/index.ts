#!/usr/bin/env node
/**
 * Entry point: runs the Freshdesk connector as an MCP server over stdio.
 *
 * Configuration comes from environment variables (see .env.example). The
 * process exits with a clear message if configuration is missing or invalid.
 * stdout carries the MCP protocol, so all logging goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FreshdeskClient } from './client/freshdesk-client.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp/server.js';
import { tools } from './tools/index.js';
import { createLogger } from './utils/logger.js';
import { createRedactor } from './utils/redact.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const secrets = config.credentials.secrets();
  const logger = createLogger({ level: config.logLevel, secrets });

  const client = new FreshdeskClient({
    credentials: config.credentials,
    retry: { maxRetries: config.maxRetries, maxWaitMs: config.maxRetryWaitMs },
    timeoutMs: config.requestTimeoutMs,
    logger,
  });

  const server = createMcpServer({
    api: client,
    includePrivateNotes: config.includePrivateNotes,
    logger,
    redact: createRedactor(secrets),
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Shutting down', { signal });
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await server.connect(new StdioServerTransport());
  logger.info('Freshdesk MCP connector ready', {
    host: config.credentials.host,
    tools: tools.map((tool) => tool.name),
    includePrivateNotes: config.includePrivateNotes,
  });
}

main().catch((error: unknown) => {
  // Startup errors (e.g. ConfigError) are written without secrets by construction.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`freshdesk-mcp-connector failed to start.\n${message}\n`);
  process.exit(1);
});
