import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

export interface SearchResult {
  path: string;
  line: number;
  content: string;
}

let _rgAvailable: boolean | null = null;

/**
 * Check if ripgrep is available on the system.
 */
export async function isRipgrepAvailable(): Promise<boolean> {
  if (_rgAvailable !== null) return _rgAvailable;

  try {
    await execFileAsync("rg", ["--version"]);
    _rgAvailable = true;
  } catch {
    _rgAvailable = false;
  }
  return _rgAvailable;
}

/**
 * Search vault using ripgrep subprocess with JSON output.
 */
export async function ripgrepSearch(
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

  const args = [
    "--json",
    "--max-count",
    String(maxResults),
    "--type",
    "md",
    "--ignore-case",
    ...excludeDirs.flatMap((d) => ["--glob", `!${d}`]),
    "--",
    query,
    searchRoot,
  ];

  try {
    const { stdout } = await execFileAsync("rg", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10000,
    });

    const results: SearchResult[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "match") {
          const data = parsed.data;
          results.push({
            path: path.relative(vaultRoot, data.path.text),
            line: data.line_number,
            content: data.lines.text.trim(),
          });
          if (results.length >= maxResults) break;
        }
      } catch {
        // Skip unparseable lines
      }
    }

    return results;
  } catch (err: unknown) {
    // rg exits with code 1 when no matches found — not an error
    const exitCode = (err as { code?: number }).code;
    if (exitCode === 1) return [];
    throw err;
  }
}
