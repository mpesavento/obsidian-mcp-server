import * as fs from "node:fs/promises";
import * as path from "node:path";
import { glob } from "glob";

export interface SearchResult {
  path: string;
  line: number;
  content: string;
}

/**
 * Pure Node.js full-text search using glob + fs.readFile + regex match.
 * Fallback when ripgrep is not available.
 */
export async function nativeSearch(
  vaultRoot: string,
  query: string,
  options: {
    pathFilter?: string;
    maxResults?: number;
    excludeDirs?: string[];
  } = {}
): Promise<SearchResult[]> {
  const maxResults = options.maxResults ?? 20;
  const excludeDirs = options.excludeDirs ?? [
    ".obsidian",
    ".trash",
    ".git",
    "node_modules",
  ];

  const searchRoot = options.pathFilter
    ? path.resolve(vaultRoot, options.pathFilter)
    : vaultRoot;

  // Validate search root is within vault
  if (!searchRoot.startsWith(path.resolve(vaultRoot))) {
    return [];
  }

  const files = await glob("**/*.md", {
    cwd: searchRoot,
    dot: false,
    ignore: excludeDirs.map((d) => `**/${d}/**`),
  });

  const results: SearchResult[] = [];
  const pattern = new RegExp(escapeRegex(query), "i");

  for (const file of files) {
    if (results.length >= maxResults) break;

    const fullPath = path.join(searchRoot, file);
    try {
      const content = await fs.readFile(fullPath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        if (results.length >= maxResults) break;
        if (pattern.test(lines[i])) {
          results.push({
            path: path.relative(vaultRoot, fullPath),
            line: i + 1,
            content: lines[i].trim(),
          });
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
