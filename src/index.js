#!/usr/bin/env node

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { TOOLS, HANDLERS, MODULE_NAMES } from './registry.js';
import { ArcError } from './jxa.js';

// Single source of truth for the version. Hardcoding it here once let the
// server report 0.2.0 while package.json still said 0.1.0.
const HERE = dirname(fileURLToPath(import.meta.url));
const { version: VERSION } = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));

const flag = process.argv[2];
if (flag === '--version' || flag === '-v') {
  console.log(VERSION);
  process.exit(0);
}
if (flag === '--help' || flag === '-h') {
  console.log(`arc-control-mcp ${VERSION}

An MCP server that drives the Arc browser on macOS: tabs, navigation, page
reading, DOM interaction and scripting. Speaks MCP over stdio, so it is started
by an MCP client rather than run by hand.

Register it with Claude Code:
  claude mcp add arc --scope user -- node "${join(HERE, 'index.js')}"

Environment:
  ARC_MCP_LABEL      names this agent's tab ownership (default "default")
  ARC_MCP_SPACE      Arc space new tabs open into (default "Agent")
  ARC_MCP_STATE_DIR  where per-session tab ownership is stored

Exposes ${TOOLS.length} tools from ${MODULE_NAMES.length} modules.`);
  process.exit(0);
}

const server = new Server(
  { name: 'arc-control', version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const handler = HANDLERS[name];

  if (!handler) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}. Available: ${Object.keys(HANDLERS).join(', ')}` }],
      isError: true
    };
  }

  try {
    const result = await handler(args);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    // ArcError messages are written for the caller and already explain the
    // remedy. Anything else is a bug in this server, so say so rather than
    // leaving the caller to guess whether retrying could help.
    const detail = error instanceof ArcError
      ? error.message
      : `${error.message}\n(This is an internal arc-control error, not an Arc or page problem.)`;
    console.error(`arc-control ${name} failed:`, error);
    return { content: [{ type: 'text', text: `Error in ${name}: ${detail}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`arc-control ${VERSION} running on stdio (${TOOLS.length} tools from ${MODULE_NAMES.length} modules)`);
