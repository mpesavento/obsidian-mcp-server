import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  readNote,
  writeNote,
  appendToNote,
  patchNote,
  deleteNote,
  moveNote,
  VaultError,
} from "../vault.js";

export function registerCrudTools(server: McpServer): void {
  server.registerTool(
    "vault_read",
    {
      title: "Read Note",
      description:
        "Read a note from the vault. Returns parsed YAML frontmatter and body content separately.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Vault-relative path to the note (e.g. '00-meta/CLAUDE_BRIEFING' or '60-daily/entry.md'). Extension .md is optional."
          ),
      },
    },
    async ({ path }) => {
      try {
        const note = await readNote(path);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  path: note.path,
                  frontmatter: note.frontmatter,
                  content: note.content,
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
    "vault_write",
    {
      title: "Write Note",
      description:
        "Create or overwrite a note. Auto-manages created/modified timestamps and created_by/last_modified_by in frontmatter. If the file exists, preserves original created/created_by values.",
      inputSchema: {
        path: z
          .string()
          .describe("Vault-relative path for the note"),
        content: z.string().describe("Markdown body content"),
        frontmatter: z
          .record(z.unknown())
          .optional()
          .describe(
            "Additional frontmatter fields to set (created/modified/created_by/last_modified_by are auto-managed)"
          ),
        create_dirs: z
          .boolean()
          .default(false)
          .describe("Create parent directories if they don't exist"),
        agent_name: z
          .string()
          .optional()
          .describe(
            "Agent name for attribution (defaults to server config)"
          ),
      },
    },
    async ({ path, content, frontmatter, create_dirs, agent_name }) => {
      try {
        await writeNote(path, content, {
          frontmatter,
          createDirs: create_dirs,
          agentName: agent_name,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, path }),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // vault_patch registered early - high priority for Claude.ai tool cap
  server.registerTool(
    "vault_patch",
    {
      title: "Patch Note",
      description:
        "Replace a unique string in a note with another string. The old_str must appear exactly once in the file content (not frontmatter). Use for surgical edits: updating links, fixing sections, replacing status fields. Updates modified timestamp.",
      inputSchema: {
        path: z
          .string()
          .describe("Vault-relative path to the note"),
        old_str: z
          .string()
          .describe("Exact string to find and replace (must appear exactly once in content)"),
        new_str: z
          .string()
          .describe("Replacement string"),
        agent_name: z
          .string()
          .optional()
          .describe("Agent name for attribution"),
      },
    },
    async ({ path, old_str, new_str, agent_name }) => {
      try {
        const result = await patchNote(path, old_str, new_str, {
          agentName: agent_name,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                path,
                matches_replaced: result.matchCount,
              }),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "vault_append",
    {
      title: "Append to Note",
      description:
        "Append content to an existing note with a separator. Updates modified timestamp and last_modified_by in frontmatter. Ideal for log entries and incremental additions.",
      inputSchema: {
        path: z
          .string()
          .describe("Vault-relative path to the note"),
        content: z
          .string()
          .describe("Content to append"),
        separator: z
          .string()
          .default("\n\n---\n\n")
          .describe("Separator between existing content and appended content"),
        agent_name: z
          .string()
          .optional()
          .describe("Agent name for attribution"),
      },
    },
    async ({ path, content, separator, agent_name }) => {
      try {
        await appendToNote(path, content, {
          separator,
          agentName: agent_name,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, path }),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "vault_delete",
    {
      title: "Delete Note",
      description:
        "Soft-delete a note by moving it to .trash/. The file can be recovered from .trash/ if needed.",
      inputSchema: {
        path: z
          .string()
          .describe("Vault-relative path to the note to delete"),
      },
    },
    async ({ path }) => {
      try {
        await deleteNote(path);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                path,
                moved_to: ".trash/",
              }),
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "vault_move",
    {
      title: "Move Note",
      description:
        "Move or rename a note within the vault. Creates destination directories if needed.",
      inputSchema: {
        from_path: z
          .string()
          .describe("Current vault-relative path"),
        to_path: z
          .string()
          .describe("New vault-relative path"),
      },
    },
    async ({ from_path, to_path }) => {
      try {
        await moveNote(from_path, to_path);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                from: from_path,
                to: to_path,
              }),
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
