/**
 * Writes docs/mcp-tools.json: the exact `tools/list` response an MCP client sees,
 * plus server instructions. Useful for platforms that import tool specs instead
 * of speaking MCP, and for reviewing schema changes in pull requests.
 *
 * Usage: npm run spec
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateToolSpec } from '../src/mcp/spec.js';

const outputPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'mcp-tools.json');

const spec = await generateToolSpec();
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');

console.log(`Wrote ${spec.tools.length} tool definitions to ${outputPath}`);
