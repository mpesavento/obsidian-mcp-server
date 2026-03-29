/**
 * Semantic search tools using QMD (Query Markup Documents).
 * Provides BM25 keyword search and vector similarity search.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  isQmdAvailable,
  qmdSearch,
  qmdVectorSearch,
  qmdHybridQuery,
  qmdStatus,
  qmdUpdateIndex,
} from "../search/qmd.js";

const ZONE_DESCRIPTIONS = `
Zones filter results to specific vault areas:
- meta: 00-meta/ (agent protocols, conventions)
- identity: 10-identity/ (Mike's identity, values)
- context: 20-context/ (projects, entities, platforms)
- knowledge: 30-knowledge/ (reusable knowledge artifacts)
- queues: 50-queues/ (task queues)
- log: 60-log/ (daily logs)
- introspection: 70-introspection/ (insights, patterns)
`.trim();

export function registerSemanticTools(server: McpServer): void {
  server.registerTool(
    "vault_semantic_search",
    {
      title: "Semantic Search",
      description: `Search vault using BM25 keyword matching. Fast, local, cost-free. Use for finding specific terms, names, or phrases. ${ZONE_DESCRIPTIONS}`,
      inputSchema: {
        query: z.string().describe("Search query (keywords matched against document content)"),
        zone: z
          .enum(["meta", "identity", "context", "knowledge", "queues", "log", "introspection"])
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
    async ({ query, zone, max_results }) => {
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

        const results = await qmdSearch(query, {
          maxResults: max_results,
          zone,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  query,
                  zone: zone || "all",
                  engine: "qmd-bm25",
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

  server.registerTool(
    "vault_vector_search",
    {
      title: "Vector Search",
      description: `Search vault using semantic similarity (embeddings). Better for conceptual queries where exact keywords may not match. Requires embeddings to be generated first (qmd embed). ${ZONE_DESCRIPTIONS}`,
      inputSchema: {
        query: z.string().describe("Natural language query (matched by semantic similarity)"),
        zone: z
          .enum(["meta", "identity", "context", "knowledge", "queues", "log", "introspection"])
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
    async ({ query, zone, max_results }) => {
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

        const results = await qmdVectorSearch(query, {
          maxResults: max_results,
          zone,
        });

        if (results.length === 0) {
          // Check if embeddings exist
          const status = await qmdStatus();
          if (!status.hasEmbeddings) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      query,
                      error: "No embeddings found. Run 'qmd embed' to generate vector embeddings.",
                      suggestion: "Use vault_semantic_search for keyword-based search instead.",
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  query,
                  zone: zone || "all",
                  engine: "qmd-vector",
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

  server.registerTool(
    "vault_hybrid_search",
    {
      title: "Hybrid Search",
      description: `Search vault using hybrid approach: BM25 keyword matching + query expansion + LLM reranking. Best quality but slower. Requires embeddings for full functionality. ${ZONE_DESCRIPTIONS}`,
      inputSchema: {
        query: z.string().describe("Search query (will be expanded and results reranked)"),
        zone: z
          .enum(["meta", "identity", "context", "knowledge", "queues", "log", "introspection"])
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
    async ({ query, zone, max_results }) => {
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

        const results = await qmdHybridQuery(query, {
          maxResults: max_results,
          zone,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  query,
                  zone: zone || "all",
                  engine: "qmd-hybrid",
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

  server.registerTool(
    "vault_search_status",
    {
      title: "Search Status",
      description: "Check the status of the QMD search index, including collection info and whether embeddings are available.",
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
                    qmd_available: false,
                    message: "QMD is not installed. Install with: npm install -g @tobilu/qmd",
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
                  qmd_available: true,
                  collection: status.collection,
                  files_indexed: status.files,
                  embeddings_available: status.hasEmbeddings,
                  tools: {
                    vault_semantic_search: "BM25 keyword search (always available)",
                    vault_vector_search: status.hasEmbeddings
                      ? "Vector similarity (available)"
                      : "Vector similarity (requires: qmd embed)",
                    vault_hybrid_search: status.hasEmbeddings
                      ? "Hybrid search (available)"
                      : "Hybrid search (limited without embeddings)",
                  },
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
    "vault_search_update",
    {
      title: "Update Search Index",
      description: "Update the QMD search index to reflect recent vault changes. Run this after adding or modifying notes.",
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
                  message: "Index updated successfully",
                  details: output.trim(),
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
  const message =
    err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}
