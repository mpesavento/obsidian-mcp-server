import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCrudTools } from "./tools/crud.js";
import { registerSearchTools } from "./tools/search.js";
import { registerMetadataTools } from "./tools/metadata.js";
import { registerSemanticTools } from "./tools/semantic.js";

/**
 * Create a configured MCP server with all vault tools registered.
 * Transport-agnostic — caller connects the appropriate transport.
 * 
 * Tool registration order matters: Claude.ai may truncate tool lists when
 * multiple MCP servers are connected. High-priority tools are registered first
 * to maximize their chances of being available.
 * 
 * Priority order:
 * 1. CRUD tools (read, write, patch, append) - core operations
 * 2. Metadata tools (frontmatter) - often needed for structured updates
 * 3. Search tools (list, recent, search) - discovery and navigation
 * 4. Semantic tools (unified search) - advanced search modes
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "obsidian-vault",
    version: "0.2.0",  // Bumped to force Claude.ai cache refresh
  });

  // Order matters for Claude.ai tool cap - register highest priority first
  registerCrudTools(server);      // read, write, patch, append, delete, move
  registerMetadataTools(server);  // frontmatter, info
  registerSearchTools(server);    // search, list, recent
  registerSemanticTools(server);  // vault_search (unified), search_status, search_update

  return server;
}
