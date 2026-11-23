import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Never let tests touch the live OAuth store (~/.config/obsidian-mcp/oauth-store.json).
// Before 2026-11 they did: the 44 example.com/callback clients found in the
// production store came from test runs.
process.env.OBSIDIAN_MCP_OAUTH_STORE = join(
  mkdtempSync(join(tmpdir(), "obsidian-mcp-test-")),
  "oauth-store.json"
);
