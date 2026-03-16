import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../server.js";

/**
 * Start the MCP server with stdio transport.
 * Used by Claude Desktop and Claude Code local connections.
 *
 * IMPORTANT: Never use console.log() in stdio mode — stdout is the MCP channel.
 * All logging must go to stderr.
 */
export async function startStdioTransport(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error("[obsidian-mcp] Server started on stdio transport");
}
