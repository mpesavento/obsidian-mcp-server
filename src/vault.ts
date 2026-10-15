import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import matter from "gray-matter";
import yaml from "js-yaml";
import { glob } from "glob";
import { getConfig } from "./config.js";
import { rewriteLinks, compileGlobs, type RewriteContext } from "./links.js";

// Directories excluded from all operations
const EXCLUDED_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);

/**
 * Frontmatter is parsed and written with the YAML JSON schema, so timestamps
 * stay as the strings the author wrote. With gray-matter's default schema a bare
 * `date: 2026-03-02` became a Date and was written back as
 * `2026-03-02T00:00:00.000Z`, and offset datetimes were rewritten to UTC.
 */
const MATTER_OPTIONS = {
  engines: {
    yaml: {
      parse: (str: string): object =>
        (yaml.load(str, { schema: yaml.JSON_SCHEMA }) as object) ?? {},
      stringify: (obj: object): string => yaml.dump(obj, { schema: yaml.JSON_SCHEMA }),
    },
  },
};

function parseNote(raw: string) {
  return matter(raw, MATTER_OPTIONS);
}

function stringifyNote(content: string, fm: NoteFrontmatter): string {
  return matter.stringify(content, fm, MATTER_OPTIONS);
}

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

  const parsed = parseNote(raw);
  return {
    path: relativePath,
    frontmatter: (parsed.data as NoteFrontmatter) || {},
    content: parsed.content,
  };
}

// Maximum content size (500KB default, can be overridden via env)
const MAX_CONTENT_SIZE = parseInt(process.env.MAX_CONTENT_SIZE || "500000", 10);

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
  // Check content size before processing
  if (content.length > MAX_CONTENT_SIZE) {
    throw new VaultError(
      `Content exceeds maximum size of ${Math.round(MAX_CONTENT_SIZE / 1000)}KB (got ${Math.round(content.length / 1000)}KB). Split into smaller files or reduce content.`,
      "CONTENT_TOO_LARGE"
    );
  }

  relativePath = ensureMdExtension(relativePath);
  validateFilePath(relativePath);
  const fullPath = resolveVaultPath(relativePath);
  const agentName = options.agentName || getConfig().AGENT_NAME_DEFAULT;
  const now = new Date().toISOString();

  const callerFm = options.frontmatter;
  let fm: NoteFrontmatter = { ...(callerFm || {}) };

  // Check if file exists to decide created vs modified
  const exists = await fileExists(fullPath);
  if (exists) {
    // Preserve original created/created_by, update modified
    const existing = await readNote(relativePath);
    // If the caller passed no frontmatter (omitted or empty), keep the note's
    // existing fields rather than silently dropping them. Passing a non-empty
    // object still replaces them, as before.
    if (!callerFm || Object.keys(callerFm).length === 0) {
      fm = { ...existing.frontmatter };
    }
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

  const serialized = stringifyNote(content, fm);
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

  // Check resulting size before writing
  if (newContent.length > MAX_CONTENT_SIZE) {
    throw new VaultError(
      `Resulting content would exceed maximum size of ${Math.round(MAX_CONTENT_SIZE / 1000)}KB (would be ${Math.round(newContent.length / 1000)}KB). Consider archiving old content or splitting into a new file.`,
      "CONTENT_TOO_LARGE"
    );
  }

  const serialized = stringifyNote(newContent, fm);
  await atomicWrite(fullPath, serialized);
}

/**
 * Patch a note by replacing a unique string with another.
 * The old_str must appear exactly once in the file content (not frontmatter).
 * Updates modified timestamp and last_modified_by in frontmatter.
 */
export async function patchNote(
  relativePath: string,
  oldStr: string,
  newStr: string,
  options: {
    agentName?: string;
  } = {}
): Promise<{ matchCount: number }> {
  relativePath = ensureMdExtension(relativePath);
  validateFilePath(relativePath);
  const fullPath = resolveVaultPath(relativePath);
  const agentName = options.agentName || getConfig().AGENT_NAME_DEFAULT;
  const now = new Date().toISOString();

  const existing = await readNote(relativePath);

  // Count occurrences of oldStr in content
  const matches = existing.content.split(oldStr).length - 1;

  if (matches === 0) {
    throw new VaultError(
      `String not found in note content: "${oldStr.slice(0, 50)}${oldStr.length > 50 ? "..." : ""}"`,
      "PATCH_NOT_FOUND"
    );
  }

  if (matches > 1) {
    throw new VaultError(
      `String appears ${matches} times in note content (must be unique). Use a more specific match string.`,
      "PATCH_AMBIGUOUS"
    );
  }

  // Replace the string. A replacer function, not a string: in a replacement
  // string JS expands $`, $', $& and $$, which pasted surrounding note text
  // into the note whenever new_str contained them (e.g. a regex ending in "$`").
  const newContent = existing.content.replace(oldStr, () => newStr);

  // Update frontmatter
  const fm: NoteFrontmatter = { ...existing.frontmatter };
  fm.modified = now;
  fm.last_modified_by = agentName;

  const serialized = stringifyNote(newContent, fm);
  await atomicWrite(fullPath, serialized);

  return { matchCount: 1 };
}

/**
 * A path in .trash/ for `basename` that doesn't overwrite an earlier delete.
 * Two notes with the same filename used to land on the same .trash path, and
 * the second delete replaced the first.
 */
async function uniqueTrashPath(trashDir: string, basename: string): Promise<string> {
  const candidate = path.join(trashDir, basename);
  if (!(await fileExists(candidate))) return candidate;
  const ext = path.extname(basename);
  const stem = basename.slice(0, basename.length - ext.length);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? stamp : `${stamp}-${n}`;
    const next = path.join(trashDir, `${stem} (deleted ${suffix})${ext}`);
    if (!(await fileExists(next))) return next;
  }
}

/**
 * Soft-delete a note by moving it to .trash/. Never overwrites an earlier
 * deleted note with the same filename; see uniqueTrashPath.
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

  const trashPath = await uniqueTrashPath(trashDir, path.basename(relativePath));
  await fs.rename(fullPath, trashPath);
}

export interface MoveOptions {
  /** Rewrite links in other notes that point at the moved note (default true). */
  updateLinks?: boolean;
  /** Work out what would change and return it, without touching the vault (default false). */
  dryRun?: boolean;
}

export interface MoveLinkReport {
  path: string;
  count: number;
}

export interface MoveResult {
  from: string;
  to: string;
  updateLinks: boolean;
  dryRun: boolean;
  /** Notes whose links were rewritten (or would be, in a dry run). */
  rewritten: MoveLinkReport[];
  /** Notes in protected zones (LINK_REWRITE_SKIP) that still link to the old path. Left unchanged. */
  protectedSkipped: MoveLinkReport[];
  /** Notes with ambiguous links that might have meant the moved note. Left unchanged. */
  ambiguous: MoveLinkReport[];
  warnings: string[];
  errors: Array<{ path: string; error: string }>;
}

/**
 * Move/rename a note within the vault and keep links to it valid.
 *
 * Unless updateLinks is false, wikilinks, embeds and markdown links in other
 * notes that point at the moved note are rewritten (alias, #heading and ^block
 * suffixes are preserved; links in code are left alone). Edits are made on the
 * raw text, so the frontmatter of rewritten notes is not re-serialized and
 * their modified/last_modified_by fields are not touched. Notes matching
 * LINK_REWRITE_SKIP are never edited; they are reported in protectedSkipped.
 * Ambiguous links (several notes share the name) are reported, not guessed at.
 *
 * Refuses to overwrite an existing note. With dryRun, nothing is changed.
 */
export async function moveNote(
  fromPath: string,
  toPath: string,
  options: MoveOptions = {}
): Promise<MoveResult> {
  fromPath = ensureMdExtension(fromPath);
  toPath = ensureMdExtension(toPath);
  validateFilePath(fromPath);
  validateFilePath(toPath);

  const fullFrom = resolveVaultPath(fromPath);
  const fullTo = resolveVaultPath(toPath);
  const updateLinks = options.updateLinks ?? true;
  const dryRun = options.dryRun ?? false;

  if (!(await fileExists(fullFrom))) {
    throw new VaultError(`Note not found: ${fromPath}`, "NOT_FOUND");
  }
  if (fullFrom === fullTo) {
    throw new VaultError(
      `Source and destination are the same: ${fromPath}`,
      "ALREADY_EXISTS"
    );
  }
  if (await fileExists(fullTo)) {
    // A case-only rename on a case-insensitive filesystem points at the same
    // file and is fine; anything else would silently overwrite another note.
    const [a, b] = await Promise.all([fs.stat(fullFrom), fs.stat(fullTo)]);
    if (a.ino !== b.ino || a.dev !== b.dev) {
      throw new VaultError(
        `Destination already exists: ${toPath}`,
        "ALREADY_EXISTS"
      );
    }
  }

  const result: MoveResult = {
    from: fromPath,
    to: toPath,
    updateLinks,
    dryRun,
    rewritten: [],
    protectedSkipped: [],
    ambiguous: [],
    warnings: [],
    errors: [],
  };

  const from = toPosix(fromPath);
  const to = toPosix(toPath);
  let oldPaths: string[] = [];
  let newPaths: string[] = [];
  const ctxFor = (p: string): RewriteContext => ({
    oldPath: from,
    newPath: to,
    sourceOld: p,
    sourceNew: p === from ? to : p,
    oldPaths,
    newPaths,
  });
  const toEdit: string[] = [];

  if (updateLinks) {
    oldPaths = await listNotePaths();
    newPaths = oldPaths.map((p) => (p === from ? to : p));

    const newBase = path.posix.basename(to, ".md");
    const clashes = oldPaths.filter(
      (p) =>
        p !== from &&
        path.posix.basename(p, ".md").toLowerCase() === newBase.toLowerCase()
    );
    if (clashes.length > 0) {
      result.warnings.push(
        `Another note is already named "${newBase}" (${clashes.slice(0, 5).join(", ")}). ` +
          `Bare [[${newBase}]] links are now ambiguous; prefer path-qualified links.`
      );
    }

    const isProtected = compileGlobs(getConfig().LINK_REWRITE_SKIP);
    const needle = path.posix.basename(from, ".md").toLowerCase();

    await mapLimit(oldPaths, 32, async (p) => {
      let raw: string;
      try {
        raw = await fs.readFile(resolveVaultPath(p), "utf-8");
      } catch (err) {
        result.warnings.push(`Could not scan ${p}: ${errorMessage(err)}`);
        return;
      }
      // The moved note is always processed (its own relative links may need
      // adjusting); others only if they mention the old name at all.
      if (p !== from && !raw.toLowerCase().includes(needle)) return;

      const r = rewriteLinks(raw, ctxFor(p));
      if (r.ambiguous > 0) result.ambiguous.push({ path: p, count: r.ambiguous });
      if (r.count === 0) return;
      if (p !== from && isProtected(p)) {
        result.protectedSkipped.push({ path: p, count: r.count });
      } else {
        result.rewritten.push({ path: p, count: r.count });
        toEdit.push(p);
      }
    });

    const byPath = (a: MoveLinkReport, b: MoveLinkReport) =>
      a.path.localeCompare(b.path);
    result.rewritten.sort(byPath);
    result.protectedSkipped.sort(byPath);
    result.ambiguous.sort(byPath);
    result.warnings.sort();
  }

  if (dryRun) return result;

  // Create destination directory if needed, then move.
  await fs.mkdir(path.dirname(fullTo), { recursive: true });
  await fs.rename(fullFrom, fullTo);

  // Rewrite links. Each note is re-read and re-processed right before writing,
  // so edits made by another agent since the scan are not overwritten.
  for (const p of toEdit) {
    const actual = p === from ? to : p;
    try {
      const full = resolveVaultPath(actual);
      const raw = await fs.readFile(full, "utf-8");
      const r = rewriteLinks(raw, ctxFor(p));
      if (r.count > 0) await atomicWrite(full, r.text);
    } catch (err) {
      result.errors.push({ path: actual, error: errorMessage(err) });
    }
  }

  return result;
}

/**
 * List files and directories in a vault path.
 */
export async function listFiles(
  relativePath: string = "",
  options: {
    recursive?: boolean;
    pattern?: string;
    depth?: number;
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
    // Apply depth filter if specified
    if (options.depth !== undefined && options.recursive) {
      const depth = match.split(path.sep).length;
      if (depth > options.depth) {
        continue;
      }
    }

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

  const serialized = stringifyNote(note.content, fm);
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

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Vault-relative POSIX paths of every note, sorted. */
async function listNotePaths(): Promise<string[]> {
  const vaultRoot = path.resolve(getConfig().VAULT_PATH);
  const matches = await glob("**/*.md", {
    cwd: vaultRoot,
    dot: false,
    ignore: [...EXCLUDED_DIRS].map((d) => `**/${d}/**`),
  });
  return matches.map(toPosix).sort();
}

/** Run fn over items with at most `limit` in flight. */
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next++];
        await fn(item);
      }
    }
  );
  await Promise.all(workers);
}

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
  | "ALREADY_EXISTS"
  | "PATCH_NOT_FOUND"
  | "PATCH_AMBIGUOUS"
  | "CONTENT_TOO_LARGE";

export class VaultError extends Error {
  code: VaultErrorCode;

  constructor(message: string, code: VaultErrorCode) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}
