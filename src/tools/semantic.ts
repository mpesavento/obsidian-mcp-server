/**
 * Semantic search tools using QMD (Query Markup Documents).
 * Provides BM25 keyword search, vector similarity search, and hybrid search.
 * 
 * Consolidated to reduce tool count for Claude.ai tool cap limitations.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  isQmdAvailable,
  qmdSearch,
  qmdVectorSearch,
  qmdStatus,
  qmdUpdateIndex,
} from "../search/qmd.js";

const ZONE_DESCRIPTIONS = `
Zones filter results to specific vault areas:
- meta: 00-meta/ (agent protocols, conventions)
- identity: 10-identity/ (Mike's identity, values)
- people: 15-people/ (entity files for people)
- context: 20-context/ (projects, platforms)
- knowledge: 30-knowledge/ (reusable knowledge artifacts)
- playbooks: 35-playbooks/ (operational runbooks, how-to guides)
- queues: 50-queues/ (task queues)
- daily: 60-daily/ (daily notes)
- introspection: 70-introspection/ (insights, patterns)
- archive: 90-archive/ (completed/inactive items)
`.trim();

const ZONE_ENUM = ["meta", "identity", "people", "context", "knowledge", "playbooks", "queues", "daily", "introspection", "archive"] as const;

export function registerSemanticTools(server: McpServer): void {
  // Unified search tool - consolidates keyword and vector search
  // Note: hybrid mode disabled until better hardware (requires local LLM inference)
  server.registerTool(
    "vault_search",
    {
      title: "Search Vault (Unified)",
      description: `Search vault with multiple modes. 'vector' (default) = semantic similarity via embeddings, best for conceptual queries. 'keyword' = BM25 text matching, best for exact terms/names. ${ZONE_DESCRIPTIONS}`,
      inputSchema: {
        query: z.string().describe("Search query"),
        mode: z
          .enum(["keyword", "vector"])
          .default("vector")
          .describe("Search mode: 'vector' (semantic similarity, default), 'keyword' (BM25 exact matching)"),
        zone: z
          .enum(ZONE_ENUM)
          .optional()
          .describe("Filter results to a specific vault zone"),
        max_results: z
          .number()
          .int()
          .positive()
          .default(10)
          .describe("Maximum number of results to return"),
      },
    },
    async ({ query, mode, zone, max_results }) => {
      try {
        if (!(await isQmdAvailable())) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "QMD is not available. Install with: npm install -g @tobilu/qmd",
              },
            ],
          };
        }

        let results;
        let engine: string;

        switch (mode) {
          case "vector": {
            results = await qmdVectorSearch(query, { maxResults: max_results, zone });
            engine = "qmd-vector";
            
            if (results.length === 0) {
              const status = await qmdStatus();
              if (!status.hasEmbeddings) {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify(
                        {
                          query,
                          mode,
                          error: "No embeddings found. Run 'qmd embed' to generate vector embeddings.",
                          suggestion: "Use mode='keyword' for keyword-based search instead.",
                        },
                        null,
                        2
                      ),
                    },
                  ],
                };
              }
            }
            break;
          }

          case "keyword":
          default: {
            results = await qmdSearch(query, { maxResults: max_results, zone });
            engine = "qmd-bm25";
            break;
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  query,
                  mode,
                  zone: zone || "all",
                  engine,
                  total: results.length,
                  results: results.map((r) => ({
                    file: r.file.replace("qmd://exobrain/", ""),
                    score: Math.round(r.score * 100) + "%",
                    title: r.title,
                    snippet: r.snippet,
                  })),
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

  // Search status tool
  server.registerTool(
    "vault_search_status",
    {
      title: "Search Index Status",
      description:
        "Check the status of the vault search index (QMD). Shows whether the index exists, when it was last updated, and if embeddings are available for vector search.",
      inputSchema: {},
    },
    async () => {
      try {
        if (!(await isQmdAvailable())) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    available: false,
                    error: "QMD is not installed. Install with: npm install -g @tobilu/qmd",
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const status = await qmdStatus();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  available: true,
                  ...status,
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

  // Search index update tool
  server.registerTool(
    "vault_search_update",
    {
      title: "Update Search Index",
      description:
        "Update the vault search index to reflect recent file changes. Run this after adding or modifying many files to ensure search results are current.",
      inputSchema: {},
    },
    async () => {
      try {
        if (!(await isQmdAvailable())) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "QMD is not available. Install with: npm install -g @tobilu/qmd",
              },
            ],
          };
        }

        const output = await qmdUpdateIndex();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  message: output.trim() || "Index updated",
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
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}
