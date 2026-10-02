import { z } from 'zod';
import type { FreshdeskTicketApi } from '../client/freshdesk-client.js';
import { ConnectorError, type ToolErrorPayload } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';

/** Everything a tool needs at run time. Transport-agnostic: MCP is just one adapter. */
export interface ToolContext {
  api: FreshdeskTicketApi;
  /** Deployment policy, not an agent choice: whether private agent notes are visible. */
  includePrivateNotes: boolean;
  logger: Logger;
  /** Scrubs secrets from any text returned to the caller. */
  redact: (text: string) => string;
}

export interface ToolDefinition<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType<Record<string, unknown>> = z.ZodType<Record<string, unknown>>,
> {
  name: string;
  title: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  execute(input: z.output<I>, context: ToolContext): Promise<z.output<O>>;
}

export const defineTool = <I extends z.ZodType, O extends z.ZodType<Record<string, unknown>>>(
  tool: ToolDefinition<I, O>,
): ToolDefinition<I, O> => tool;

export type ToolResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: ToolErrorPayload };

/**
 * Validates arguments, runs the tool and converts every failure into a
 * structured, secret-free error payload. Never throws.
 */
export async function runTool(tool: ToolDefinition, rawArgs: unknown, context: ToolContext): Promise<ToolResult> {
  const startedAt = Date.now();
  const result = await execute(tool, rawArgs, context);

  context.logger.info('Tool call completed', {
    tool: tool.name,
    outcome: result.ok ? 'success' : 'error',
    ...(!result.ok && { errorCode: result.error.error.code }),
    durationMs: Date.now() - startedAt,
  });
  return result;
}

async function execute(tool: ToolDefinition, rawArgs: unknown, context: ToolContext): Promise<ToolResult> {
  const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { ok: false, error: redactPayload(invalidInputError(parsed.error).toPayload(), context) };
  }

  try {
    return { ok: true, data: await tool.execute(parsed.data, context) };
  } catch (error) {
    if (error instanceof ConnectorError) {
      return { ok: false, error: redactPayload(error.toPayload(), context) };
    }
    // Unknown failures may carry internal details; log them, return a generic message.
    context.logger.error('Unexpected error while running tool', {
      tool: tool.name,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    const internal = new ConnectorError({
      code: 'INTERNAL_ERROR',
      message: 'The connector hit an unexpected error. The details were logged for the operator.',
    });
    return { ok: false, error: internal.toPayload() };
  }
}

function invalidInputError(error: z.ZodError): ConnectorError {
  const details = error.issues.map((issue) => ({
    ...(issue.path.length > 0 && { field: issue.path.join('.') }),
    message: issue.message,
    code: issue.code,
  }));
  const summary = details.map((detail) => (detail.field ? `${detail.field}: ${detail.message}` : detail.message));
  return new ConnectorError({
    code: 'INVALID_INPUT',
    message: `Invalid arguments: ${summary.join('; ')}`,
    details,
  });
}

function redactPayload({ error }: ToolErrorPayload, { redact }: ToolContext): ToolErrorPayload {
  return {
    error: {
      ...error,
      message: redact(error.message),
      ...(error.details && {
        details: error.details.map((detail) => ({ ...detail, message: redact(detail.message) })),
      }),
    },
  };
}
