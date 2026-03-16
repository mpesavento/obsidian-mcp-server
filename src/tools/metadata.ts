import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { updateFrontmatter, vaultInfo, VaultError } from "../vault.js";

export function registerMetadataTools(server: McpServer): void {
  server.registerTool(
    "vault_frontmatter",
    {
      title: "Read/Update Frontmatter",
      description:
        "Read or atomically update specific YAML frontmatter fields on a note without touching the body content. If 'updates' is omitted, returns the current frontmatter. If provided, merges the updates into existing frontmatter.",
      inputSchema: {
        path: z
          .string()
          .describe("Vault-relative path to the note"),
        updates: z
          .record(z.unknown())
          .optional()
          .describe(
            "Key-value pairs to merge into frontmatter (e.g. { tags: ['exobrain/decision'], type: 'decision' })"
          ),
      },
    },
    async ({ path, updates }) => {
      try {
        const fm = await updateFrontmatter(path, updates);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  path,
                  action: updates ? "updated" : "read",
                  frontmatter: fm,
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
    "vault_info",
    {
      title: "Vault Info",
      description:
        "Get vault statistics: total file count, total size, and top-level directory structure.",
      inputSchema: {},
    },
    async () => {
      try {
        const info = await vaultInfo();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(info, null, 2),
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
