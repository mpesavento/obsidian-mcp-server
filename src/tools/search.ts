import { z } from "zod";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listFiles, recentNotes, VaultError } from "../vault.js";
import { getConfig } from "../config.js";
import {
  isRipgrepAvailable,
  ripgrepSearch,
} from "../search/ripgrep.js";
import { nativeSearch } from "../search/native.js";

export function registerSearchTools(server: McpServer): void {
  server.registerTool(
    "vault_grep",
    {
      title: "Grep Vault",
      description:
        "Full-text grep search across vault notes. Uses ripgrep if available, falls back to pure Node.js search. Case-insensitive. Use vault_search for semantic/keyword search instead.",
      inputSchema: {
        query: z.string().describe("Search query (plain text, matched case-insensitively)"),
        path_filter: z
          .string()
          .optional()
          .describe(
            "Restrict search to a subdirectory (e.g. '60-daily' or '20-context/entities')"
          ),
        max_results: z
          .number()
          .int()
          .positive()
          .default(20)
          .describe("Maximum number of results to return"),
      },
    },
    async ({ query, path_filter, max_results }) => {
      try {
        const config = getConfig();
        const vaultRoot = path.resolve(config.VAULT_PATH);

        let results;
        if (await isRipgrepAvailable()) {
          results = await ripgrepSearch(vaultRoot, query, {
            pathFilter: path_filter,
            maxResults: max_results,
          });
        } else {
          results = await nativeSearch(vaultRoot, query, {
            pathFilter: path_filter,
            maxResults: max_results,
          });
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  query,
                  total: results.length,
                  engine: (await isRipgrepAvailable())
                    ? "ripgrep"
                    : "native",
                  results,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "vault_list",
    {
      title: "List Vault Contents",
      description:
        "List files and folders in a vault directory. Excludes .obsidian, .trash, and .git directories.",
      inputSchema: {
        path: z
          .string()
          .default("")
          .describe(
            "Vault-relative directory path (empty string for vault root)"
          ),
        recursive: z
          .boolean()
          .default(false)
          .describe("List recursively"),
        depth: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum depth when recursive (1 = immediate children only, 2 = children and grandchildren, etc.)"),
        pattern: z
          .string()
          .optional()
          .describe("Glob pattern to filter results (e.g. '*.md', '**/*task*')"),
      },
    },
    async ({ path: dirPath, recursive, depth, pattern }) => {
      try {
        const files = await listFiles(dirPath, { recursive, pattern, depth });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { path: dirPath || "/", total: files.length, depth: depth || (recursive ? "unlimited" : 1), files },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "vault_recent",
    {
      title: "Recent Notes",
      description:
        "Get the most recently modified notes in the vault, sorted by modification time (newest first).",
      inputSchema: {
        n: z
          .number()
          .int()
          .positive()
          .default(10)
          .describe("Number of recent notes to return"),
        path_filter: z
          .string()
          .optional()
          .describe("Restrict to a subdirectory"),
      },
    },
    async ({ n, path_filter }) => {
      try {
        const notes = await recentNotes(n, path_filter);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { total: notes.length, notes },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

function errorResult(err: unknown) {
  const message =
    err instanceof VaultError
      ? `${err.code}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}
