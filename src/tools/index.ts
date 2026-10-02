import { getTicketTool } from './get-ticket.js';
import { listTicketsTool } from './list-tickets.js';
import { searchTicketsTool } from './search-tickets.js';
import type { ToolDefinition } from './tool.js';

/** Every tool the connector exposes. All of them are read-only by design. */
export const tools: readonly ToolDefinition[] = [listTicketsTool, getTicketTool, searchTicketsTool];

export { getTicketTool, listTicketsTool, searchTicketsTool };
export { runTool, type ToolContext, type ToolDefinition, type ToolResult } from './tool.js';
