/**
 * QMD (Query Markup Documents) search integration.
 * Provides BM25 keyword search and semantic vector search via QMD CLI.
 */

import { spawn } from "node:child_process";
import { getConfig } from "../config.js";

export interface QmdSearchResult {
  docid: string;
  score: number;
  file: string;
  title: string;
  snippet: string;
}

export interface QmdSearchOptions {
  maxResults?: number;
  collection?: string;
  zone?: string;
}

// Zone to path prefix mapping
const ZONE_PREFIXES: Record<string, string> = {
  meta: "00-meta",
  identity: "10-identity",
  context: "20-context",
  knowledge: "30-knowledge",
  queues: "50-queues",
  log: "60-daily",
  introspection: "70-introspection",
};

/**
 * Check if QMD CLI is available
 */
export async function isQmdAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("qmd", ["--help"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.on("error", () => resolve(false));
    proc.on("exit", (code) => resolve(code === 0));
  });
}

/**
 * Get collection name for the vault
 */
export function getCollectionName(): string {
  // Use "exobrain" as the default collection name
  // This assumes the vault has been indexed with: qmd collection add <vault_path> --name exobrain
  return process.env.QMD_COLLECTION || "exobrain";
}

/**
 * Run QMD search (BM25 keyword search)
 */
export async function qmdSearch(
  query: string,
  options: QmdSearchOptions = {}
): Promise<QmdSearchResult[]> {
  const { maxResults = 10, collection, zone } = options;
  const collectionName = collection || getCollectionName();

  const args = ["search", query, "-c", collectionName, "-n", String(maxResults), "--json"];

  const output = await runQmd(args);
  
  if (!output || output.trim() === "No results found.") {
    return [];
  }

  try {
    let results: QmdSearchResult[] = JSON.parse(output);
    
    // Filter by zone if specified
    if (zone) {
      const prefix = ZONE_PREFIXES[zone];
      if (prefix) {
        results = results.filter((r) => r.file.includes(prefix));
      }
    }
    
    return results;
  } catch {
    // If JSON parse fails, return empty
    return [];
  }
}

/**
 * Run QMD vector search (semantic similarity)
 */
export async function qmdVectorSearch(
  query: string,
  options: QmdSearchOptions = {}
): Promise<QmdSearchResult[]> {
  const { maxResults = 10, collection, zone } = options;
  const collectionName = collection || getCollectionName();

  const args = ["vsearch", query, "-c", collectionName, "-n", String(maxResults), "--json"];

  const output = await runQmd(args);
  
  if (!output || output.trim() === "No results found.") {
    return [];
  }

  try {
    let results: QmdSearchResult[] = JSON.parse(output);
    
    // Filter by zone if specified
    if (zone) {
      const prefix = ZONE_PREFIXES[zone];
      if (prefix) {
        results = results.filter((r) => r.file.includes(prefix));
      }
    }
    
    return results;
  } catch {
    return [];
  }
}

/**
 * Run QMD hybrid query (BM25 + reranking)
 */
export async function qmdHybridQuery(
  query: string,
  options: QmdSearchOptions = {}
): Promise<QmdSearchResult[]> {
  const { maxResults = 10, collection, zone } = options;
  const collectionName = collection || getCollectionName();

  const args = ["query", query, "-c", collectionName, "-n", String(maxResults), "--json"];

  const output = await runQmd(args);
  
  if (!output || output.trim() === "No results found.") {
    return [];
  }

  try {
    let results: QmdSearchResult[] = JSON.parse(output);
    
    // Filter by zone if specified
    if (zone) {
      const prefix = ZONE_PREFIXES[zone];
      if (prefix) {
        results = results.filter((r) => r.file.includes(prefix));
      }
    }
    
    return results;
  } catch {
    return [];
  }
}

/**
 * Get collection status
 */
export async function qmdStatus(): Promise<{
  collection: string;
  files: number;
  hasEmbeddings: boolean;
}> {
  const collectionName = getCollectionName();
  const output = await runQmd(["collection", "list"]);
  
  // Parse collection info from output
  const lines = output.split("\n");
  let files = 0;
  let hasEmbeddings = false;
  
  let inCollection = false;
  for (const line of lines) {
    if (line.includes(`${collectionName} (`)) {
      inCollection = true;
    }
    if (inCollection && line.includes("Files:")) {
      const match = line.match(/Files:\s+(\d+)/);
      if (match) files = parseInt(match[1], 10);
    }
    if (inCollection && line.includes("Embeddings:")) {
      hasEmbeddings = !line.includes("none");
    }
  }
  
  return { collection: collectionName, files, hasEmbeddings };
}

/**
 * Update the QMD index
 */
export async function qmdUpdateIndex(): Promise<string> {
  const output = await runQmd(["update"]);
  return output;
}

/**
 * Run QMD CLI command and return stdout
 */
async function runQmd(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("qmd", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Disable CUDA to prevent node-llama-cpp from trying to build with CUDA
        // on systems without proper CUDA toolkit (like Raspberry Pi with gstreamer-cuda libs)
        NODE_LLAMA_CPP_SKIP_CUDA: "true",
        GGML_CUDA: "0",
      },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to run qmd: ${err.message}`));
    });

    proc.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        // Some commands return non-zero for "no results" - handle gracefully
        if (stdout.includes("No results found")) {
          resolve(stdout);
        } else {
          reject(new Error(`qmd exited with code ${code}: ${stderr || stdout}`));
        }
      }
    });
  });
}
