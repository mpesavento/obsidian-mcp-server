import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCrudTools } from "./tools/crud.js";
import { registerSearchTools } from "./tools/search.js";
import { registerMetadataTools } from "./tools/metadata.js";
import { registerSemanticTools } from "./tools/semantic.js";

/**
 * Create a configured MCP server with all vault tools registered.
 * Transport-agnostic — caller connects the appropriate transport.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "obsidian-vault",
    version: "0.1.0",
  });

  registerCrudTools(server);
  registerSearchTools(server);
  registerMetadataTools(server);
  registerSemanticTools(server);

  return server;
}
