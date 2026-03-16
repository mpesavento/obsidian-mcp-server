import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import matter from "gray-matter";
import { glob } from "glob";
import { getConfig } from "./config.js";

// Directories excluded from all operations
const EXCLUDED_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

// Allowed file extensions
const ALLOWED_EXTENSIONS = new Set([".md"]);

export interface NoteFrontmatter {
  [key: string]: unknown;
  created?: string;
  modified?: string;
  created_by?: string;
  last_modified_by?: string;
}

export interface NoteData {
  path: string;
  frontmatter: NoteFrontmatter;
  content: string;
}

export interface FileInfo {
  path: string;
  name: string;
  isDirectory: boolean;
  modified?: string;
  size?: number;
}

/**
 * Resolve a vault-relative path and validate it's within the vault root.
 * Prevents path traversal attacks.
 */
export function resolveVaultPath(relativePath: string): string {
  const config = getConfig();
  const vaultRoot = path.resolve(config.VAULT_PATH);
  const resolved = path.resolve(vaultRoot, relativePath);

  if (!resolved.startsWith(vaultRoot + path.sep) && resolved !== vaultRoot) {
    throw new VaultError(
      `Path traversal detected: "${relativePath}" resolves outside vault`,
      "PATH_TRAVERSAL"
    );
  }

  return resolved;
}

/**
 * Validate that a path is allowed (correct extension, not in excluded dirs).
 */
function validateFilePath(relativePath: string): void {
  const parts = relativePath.split(path.sep);
  for (const part of parts) {
    if (EXCLUDED_DIRS.has(part)) {
      throw new VaultError(
        `Access to "${part}" directory is not allowed`,
        "EXCLUDED_DIR"
      );
    }
  }

  const ext = path.extname(relativePath);
  if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
    throw new VaultError(
      `File extension "${ext}" is not allowed (only ${[...ALLOWED_EXTENSIONS].join(", ")})`,
      "INVALID_EXTENSION"
    );
  }
}

/**
 * Ensure a path has the .md extension.
 */
function ensureMdExtension(filePath: string): string {
  if (!path.extname(filePath)) {
    return filePath + ".md";
  }
  return filePath;
}

/**
 * Read a note from the vault, parsing its frontmatter.
 */
export async function readNote(relativePath: string): Promise<NoteData> {
  relativePath = ensureMdExtension(relativePath);
  validateFilePath(relativePath);
  const fullPath = resolveVaultPath(relativePath);

  let raw: string;
  try {
    raw = await fs.readFile(fullPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new VaultError(`Note not found: ${relativePath}`, "NOT_FOUND");
    }
    throw err;
  }

  const parsed = matter(raw);
  return {
    path: relativePath,
    frontmatter: (parsed.data as NoteFrontmatter) || {},
    content: parsed.content,
  };
}

/**
 * Write a note to the vault with atomic write (write to .tmp, then rename).
 * Auto-manages created/modified/created_by/last_modified_by in frontmatter.
 */
export async function writeNote(
  relativePath: string,
  content: string,
  options: {
    frontmatter?: NoteFrontmatter;
    createDirs?: boolean;
    agentName?: string;
  } = {}
): Promise<void> {
  relativePath = ensureMdExtension(relativePath);
  validateFilePath(relativePath);
  const fullPath = resolveVaultPath(relativePath);
  const agentName = options.agentName || getConfig().AGENT_NAME_DEFAULT;
  const now = new Date().toISOString();

  let fm: NoteFrontmatter = { ...(options.frontmatter || {}) };

  // Check if file exists to decide created vs modified
  const exists = await fileExists(fullPath);
  if (exists) {
    // Preserve original created/created_by, update modified
    const existing = await readNote(relativePath);
    fm.created = existing.frontmatter.created || fm.created || now;
    fm.created_by = existing.frontmatter.created_by || fm.created_by || agentName;
    fm.modified = now;
    fm.last_modified_by = agentName;
  } else {
    fm.created = fm.created || now;
    fm.modified = now;
    fm.created_by = fm.created_by || agentName;
    fm.last_modified_by = agentName;
  }

  if (options.createDirs) {
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
  }

  const serialized = matter.stringify(content, fm);
  await atomicWrite(fullPath, serialized);
}

/**
 * Append content to an existing note with a separator.
 * Updates modified timestamp and last_modified_by in frontmatter.
 */
export async function appendToNote(
  relativePath: string,
  content: string,
  options: {
    separator?: string;
    agentName?: string;
  } = {}
): Promise<void> {
  relativePath = ensureMdExtension(relativePath);
  validateFilePath(relativePath);
  const fullPath = resolveVaultPath(relativePath);
  const separator = options.separator ?? "\n\n---\n\n";
  const agentName = options.agentName || getConfig().AGENT_NAME_DEFAULT;
  const now = new Date().toISOString();

  const existing = await readNote(relativePath);

  // Update frontmatter
  const fm: NoteFrontmatter = { ...existing.frontmatter };
  fm.modified = now;
  fm.last_modified_by = agentName;

  // Append content
  const newContent = existing.content.trimEnd() + separator + content;

  const serialized = matter.stringify(newContent, fm);
  await atomicWrite(fullPath, serialized);
}

/**
 * Soft-delete a note by moving it to .trash/.
 */
export async function deleteNote(relativePath: string): Promise<void> {
  relativePath = ensureMdExtension(relativePath);
  validateFilePath(relativePath);
  const fullPath = resolveVaultPath(relativePath);

  if (!(await fileExists(fullPath))) {
    throw new VaultError(`Note not found: ${relativePath}`, "NOT_FOUND");
  }

  const config = getConfig();
  const trashDir = path.join(config.VAULT_PATH, ".trash");
  await fs.mkdir(trashDir, { recursive: true });

  const trashPath = path.join(trashDir, path.basename(relativePath));
  await fs.rename(fullPath, trashPath);
}

/**
 * Move/rename a note within the vault.
 */
export async function moveNote(
  fromPath: string,
  toPath: string
): Promise<void> {
  fromPath = ensureMdExtension(fromPath);
  toPath = ensureMdExtension(toPath);
  validateFilePath(fromPath);
  validateFilePath(toPath);

  const fullFrom = resolveVaultPath(fromPath);
  const fullTo = resolveVaultPath(toPath);

  if (!(await fileExists(fullFrom))) {
    throw new VaultError(`Note not found: ${fromPath}`, "NOT_FOUND");
  }

  // Create destination directory if needed
  await fs.mkdir(path.dirname(fullTo), { recursive: true });
  await fs.rename(fullFrom, fullTo);
}

/**
 * List files and directories in a vault path.
 */
export async function listFiles(
  relativePath: string = "",
  options: {
    recursive?: boolean;
    pattern?: string;
  } = {}
): Promise<FileInfo[]> {
  const fullPath = resolveVaultPath(relativePath);

  const stat = await fs.stat(fullPath).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new VaultError(
      `Directory not found: ${relativePath || "/"}`,
      "NOT_FOUND"
    );
  }

  const config = getConfig();
  const vaultRoot = path.resolve(config.VAULT_PATH);

  const globPattern = options.pattern || (options.recursive ? "**/*" : "*");
  const matches = await glob(globPattern, {
    cwd: fullPath,
    dot: false,
    ignore: [...EXCLUDED_DIRS].map((d) => `**/${d}/**`),
  });

  const results: FileInfo[] = [];
  for (const match of matches.sort()) {
    const matchFull = path.join(fullPath, match);
    try {
      const s = await fs.stat(matchFull);
      results.push({
        path: path.relative(vaultRoot, matchFull),
        name: path.basename(match),
        isDirectory: s.isDirectory(),
        modified: s.mtime.toISOString(),
        size: s.isFile() ? s.size : undefined,
      });
    } catch {
      // Skip files that can't be stat'd
    }
  }

  return results;
}

/**
 * Get recently modified notes.
 */
export async function recentNotes(
  n: number = 10,
  pathFilter?: string
): Promise<FileInfo[]> {
  const config = getConfig();
  const vaultRoot = path.resolve(config.VAULT_PATH);
  const searchRoot = pathFilter
    ? resolveVaultPath(pathFilter)
    : vaultRoot;

  const matches = await glob("**/*.md", {
    cwd: searchRoot,
    dot: false,
    ignore: [...EXCLUDED_DIRS].map((d) => `**/${d}/**`),
  });

  const filesWithStats: FileInfo[] = [];
  for (const match of matches) {
    const fullPath = path.join(searchRoot, match);
    try {
      const s = await fs.stat(fullPath);
      filesWithStats.push({
        path: path.relative(vaultRoot, fullPath),
        name: path.basename(match),
        isDirectory: false,
        modified: s.mtime.toISOString(),
        size: s.size,
      });
    } catch {
      // Skip
    }
  }

  filesWithStats.sort(
    (a, b) =>
      new Date(b.modified!).getTime() - new Date(a.modified!).getTime()
  );

  return filesWithStats.slice(0, n);
}

/**
 * Read or update frontmatter fields without touching the body content.
 */
export async function updateFrontmatter(
  relativePath: string,
  updates?: Record<string, unknown>
): Promise<NoteFrontmatter> {
  relativePath = ensureMdExtension(relativePath);
  validateFilePath(relativePath);

  const note = await readNote(relativePath);

  if (!updates || Object.keys(updates).length === 0) {
    return note.frontmatter;
  }

  const fullPath = resolveVaultPath(relativePath);
  const fm: NoteFrontmatter = { ...note.frontmatter, ...updates };

  const serialized = matter.stringify(note.content, fm);
  await atomicWrite(fullPath, serialized);

  return fm;
}

/**
 * Get vault stats and folder structure.
 */
export async function vaultInfo(): Promise<{
  vaultPath: string;
  totalFiles: number;
  totalSize: number;
  topLevelDirs: string[];
}> {
  const config = getConfig();
  const vaultRoot = path.resolve(config.VAULT_PATH);

  const allFiles = await glob("**/*.md", {
    cwd: vaultRoot,
    dot: false,
    ignore: [...EXCLUDED_DIRS].map((d) => `**/${d}/**`),
  });

  let totalSize = 0;
  for (const f of allFiles) {
    try {
      const s = await fs.stat(path.join(vaultRoot, f));
      totalSize += s.size;
    } catch {
      // Skip
    }
  }

  const entries = await fs.readdir(vaultRoot, { withFileTypes: true });
  const topLevelDirs = entries
    .filter((e) => e.isDirectory() && !EXCLUDED_DIRS.has(e.name) && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();

  return {
    vaultPath: vaultRoot,
    totalFiles: allFiles.length,
    totalSize,
    topLevelDirs,
  };
}

// --- Internal helpers ---

async function fileExists(fullPath: string): Promise<boolean> {
  try {
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(fullPath: string, content: string): Promise<void> {
  const tmpPath = fullPath + `.tmp.${randomUUID().slice(0, 8)}`;
  try {
    await fs.writeFile(tmpPath, content, "utf-8");
    await fs.rename(tmpPath, fullPath);
  } catch (err) {
    // Clean up temp file on failure
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

// --- Error class ---

export type VaultErrorCode =
  | "PATH_TRAVERSAL"
  | "EXCLUDED_DIR"
  | "INVALID_EXTENSION"
  | "NOT_FOUND"
  | "ALREADY_EXISTS";

export class VaultError extends Error {
  code: VaultErrorCode;

  constructor(message: string, code: VaultErrorCode) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}
