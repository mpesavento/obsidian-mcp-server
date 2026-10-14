import * as path from "node:path";

/**
 * Link-aware helpers used by moveNote() to keep inbound links valid when a
 * note is moved or renamed.
 *
 * Everything here is pure (no filesystem access) so it can be unit tested.
 * All paths are vault-relative, POSIX-style ("folder/note.md").
 *
 * Supported link forms:
 *   - wikilinks and embeds: [[note]], [[folder/note]], [[../note]],
 *     [[note#Heading]], [[note#^block]], [[note|alias]], [[note\|alias]]
 *     (escaped pipe, used inside tables), ![[note]]
 *   - markdown links to notes: [text](folder/note.md), [text](../note.md#h)
 *     (targets without spaces or angle brackets)
 *
 * Links inside fenced code blocks and inline code spans are never touched.
 * Link resolution is case-insensitive, like Obsidian's.
 *
 * A bare name such as [[README]] is matched by file name anywhere in the
 * vault. If several notes share that name the link is "ambiguous": we cannot
 * tell which one it means, so it is reported and never rewritten.
 */

const posix = path.posix;

export type Resolution =
  | { status: "ok"; path: string }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "none" };

export interface RewriteContext {
  /** Path of the note being moved, before the move. */
  oldPath: string;
  /** Path of the note being moved, after the move. */
  newPath: string;
  /** Path of the note whose text is being rewritten, before the move. */
  sourceOld: string;
  /** Path of the note whose text is being rewritten, after the move. */
  sourceNew: string;
  /** Every note path in the vault before the move. */
  oldPaths: string[];
  /** Every note path in the vault after the move. */
  newPaths: string[];
}

export interface RewriteResult {
  text: string;
  /** Number of links rewritten. */
  count: number;
  /** Links whose target is ambiguous but could have meant the moved note (left unchanged). */
  ambiguous: number;
}

// --- small path helpers ---

export function stripMd(p: string): string {
  return p.replace(/\.md$/i, "");
}

function dirOf(p: string): string {
  const d = posix.dirname(p);
  return d === "." ? "" : d;
}

function baseNoExt(p: string): string {
  return posix.basename(stripMd(p));
}

function isRelative(linkpath: string): boolean {
  return linkpath.startsWith("./") || linkpath.startsWith("../");
}

/** Relative path from the directory of `fromNote` to `toNoteNoExt`, with an explicit ./ when needed. */
function relativeLink(fromNote: string, toNoteNoExt: string): string {
  const rel = posix.relative("/" + dirOf(fromNote), "/" + toNoteNoExt);
  return rel.startsWith("..") ? rel : "./" + rel;
}

const lower = (s: string) => s.toLowerCase();

// --- code masking ---

/**
 * Return a copy of `text` with fenced code blocks and inline code spans
 * replaced by spaces (same length, newlines kept), so that offsets found in
 * the masked copy are valid in the original.
 */
export function maskCode(text: string): string {
  const lines = text.split("\n");
  let fence: { ch: string; len: number } | null = null;
  const out: string[] = [];

  const blank = (s: string) => s.replace(/[^\r]/g, " ");

  for (const line of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        m &&
        m[1][0] === fence.ch &&
        m[1].length >= fence.len &&
        m[2].trim() === ""
      ) {
        fence = null;
      }
      out.push(blank(line));
      continue;
    }
    // A backtick fence's info string cannot contain a backtick, so a line like
    // ```code``` is an inline span, not the start of a block.
    if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
      fence = { ch: m[1][0], len: m[1].length };
      out.push(blank(line));
      continue;
    }
    out.push(
      line.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (s) => blank(s))
    );
  }
  return out.join("\n");
}

// --- resolution ---

/**
 * Resolve a link path (without #heading, ^block or |alias) the way Obsidian
 * does, as far as this server needs.
 *   - ./x or ../x: relative to the linking note
 *   - bare name (no slash): by file name anywhere; duplicates are ambiguous
 *   - folder/x: exact vault-root path, then relative to the linking note,
 *     then a unique shortest-path suffix match
 */
export function resolveLink(
  linkpath: string,
  sourcePath: string,
  paths: string[]
): Resolution {
  const lp = linkpath.trim();
  if (!lp || /^[a-z][a-z0-9+.-]*:/i.test(lp)) return { status: "none" };

  const target = /\.md$/i.test(lp) ? lp : lp + ".md";

  const pick = (hits: string[]): Resolution =>
    hits.length === 1
      ? { status: "ok", path: hits[0] }
      : hits.length > 1
        ? { status: "ambiguous", candidates: hits }
        : { status: "none" };

  if (isRelative(lp)) {
    const abs = posix.normalize(posix.join(dirOf(sourcePath), target));
    if (abs.startsWith("..")) return { status: "none" };
    return pick(paths.filter((p) => lower(p) === lower(abs)));
  }

  const t = target.replace(/^\/+/, "");

  if (!t.includes("/")) {
    return pick(paths.filter((p) => lower(posix.basename(p)) === lower(t)));
  }

  const exact = paths.filter((p) => lower(p) === lower(t));
  if (exact.length > 0) return pick(exact);

  const rel = lower(posix.join(dirOf(sourcePath), t));
  const relHit = paths.filter((p) => lower(p) === rel);
  if (relHit.length === 1) return pick(relHit);

  return pick(paths.filter((p) => lower(p).endsWith("/" + lower(t))));
}

// --- building the replacement link path ---

/**
 * New link path for a link that used to point at the moved note, keeping the
 * original form where possible. Returns null when the original text is still
 * correct.
 */
function newLinkpath(orig: string, ctx: RewriteContext): string | null {
  const suffix = /\.md$/i.test(orig) ? ".md" : "";
  const newNoExt = stripMd(ctx.newPath);

  if (isRelative(orig)) {
    const out = relativeLink(ctx.sourceNew, newNoExt) + suffix;
    return out === orig ? null : out;
  }

  if (!orig.includes("/")) {
    // Bare name: keep it if it still resolves to exactly the moved note.
    const newBase = baseNoExt(ctx.newPath);
    const clash = ctx.newPaths.filter((p) => lower(baseNoExt(p)) === lower(newBase));
    if (clash.length === 1) {
      const out = newBase + suffix;
      return out === orig ? null : out;
    }
    return newNoExt + suffix;
  }

  const out = newNoExt + suffix;
  return out === orig ? null : out;
}

// --- the rewrite itself ---

interface Edit {
  start: number;
  end: number;
  replacement: string;
}

/**
 * Rewrite every link in `text` that points at ctx.oldPath so it points at
 * ctx.newPath. When the text being rewritten is the moved note itself, its
 * relative outbound links are also adjusted so they keep pointing at the same
 * notes. Frontmatter is treated as ordinary text, so links inside frontmatter
 * values are rewritten too, and no YAML is re-serialized.
 */
export function rewriteLinks(text: string, ctx: RewriteContext): RewriteResult {
  const masked = maskCode(text);
  const edits: Edit[] = [];
  let ambiguous = 0;
  const selfIsMoved = ctx.sourceOld === ctx.oldPath;

  // 1. Wikilinks and embeds
  const wiki = /(!?)\[\[([^\[\]\n]+)\]\]/g;
  for (let m: RegExpExecArray | null; (m = wiki.exec(masked)); ) {
    const innerStart = m.index + m[1].length + 2;
    const inner = text.slice(innerStart, innerStart + m[2].length);

    const pipe = inner.search(/\\?\|/);
    const left = pipe === -1 ? inner : inner.slice(0, pipe);
    const rest = pipe === -1 ? "" : inner.slice(pipe);
    const hash = left.indexOf("#");
    const linkpath = hash === -1 ? left : left.slice(0, hash);
    const anchor = hash === -1 ? "" : left.slice(hash);
    if (!linkpath.trim()) continue; // [[#heading]] links to the same note

    const res = resolveLink(linkpath, ctx.sourceOld, ctx.oldPaths);
    let replacement: string | null = null;

    if (res.status === "ok" && res.path === ctx.oldPath) {
      replacement = newLinkpath(linkpath, ctx);
    } else if (res.status === "ambiguous") {
      if (res.candidates.includes(ctx.oldPath)) ambiguous++;
    } else if (res.status === "ok" && selfIsMoved && isRelative(linkpath)) {
      // Outbound relative link of the moved note: keep pointing at the same target.
      const suffix = /\.md$/i.test(linkpath) ? ".md" : "";
      const out = relativeLink(ctx.sourceNew, stripMd(res.path)) + suffix;
      if (out !== linkpath) replacement = out;
    }

    if (replacement !== null) {
      edits.push({
        start: innerStart,
        end: innerStart + inner.length,
        replacement: replacement + anchor + rest,
      });
    }
  }

  // 2. Markdown links to notes: [text](path/to/note.md#anchor)
  const md = /\]\(([^)\s<>]+)\)/g;
  for (let m: RegExpExecArray | null; (m = md.exec(masked)); ) {
    const tStart = m.index + 2;
    const raw = text.slice(tStart, tStart + m[1].length);
    const hash = raw.indexOf("#");
    const filePart = hash === -1 ? raw : raw.slice(0, hash);
    const anchor = hash === -1 ? "" : raw.slice(hash);
    if (!/\.md$/i.test(filePart) || /^[a-z][a-z0-9+.-]*:/i.test(filePart)) {
      continue;
    }

    let decoded = filePart;
    try {
      decoded = decodeURIComponent(filePart);
    } catch {
      /* keep raw */
    }
    const encoded = decoded !== filePart;

    const res = resolveMarkdownTarget(decoded, ctx.sourceOld, ctx.oldPaths);
    if (res === null) continue;

    let out: string | null = null;
    if (res === ctx.oldPath) {
      out = isRelative(decoded)
        ? relativeLink(ctx.sourceNew, stripMd(ctx.newPath)) + ".md"
        : ctx.newPath;
    } else if (selfIsMoved && isRelative(decoded)) {
      out = relativeLink(ctx.sourceNew, stripMd(res)) + ".md";
    }
    if (out === null || out === decoded) continue;
    if (encoded || out.includes(" ")) out = out.replace(/ /g, "%20");
    edits.push({
      start: tStart,
      end: tStart + raw.length,
      replacement: out + anchor,
    });
  }

  if (edits.length === 0) return { text, count: 0, ambiguous };

  edits.sort((a, b) => b.start - a.start);
  let result = text;
  for (const e of edits) {
    result = result.slice(0, e.start) + e.replacement + result.slice(e.end);
  }
  return { text: result, count: edits.length, ambiguous };
}

/** Resolve a markdown-link target: relative to the linking note, else from the vault root. */
function resolveMarkdownTarget(
  target: string,
  sourcePath: string,
  paths: string[]
): string | null {
  const find = (candidate: string) => {
    const hit = paths.filter((p) => lower(p) === lower(candidate));
    return hit.length === 1 ? hit[0] : null;
  };
  if (isRelative(target)) {
    const abs = posix.normalize(posix.join(dirOf(sourcePath), target));
    return abs.startsWith("..") ? null : find(abs);
  }
  return (
    find(target.replace(/^\/+/, "")) ??
    find(posix.normalize(posix.join(dirOf(sourcePath), target)))
  );
}

// --- protected-zone globs ---

/** Compile a comma-separated list of simple globs (`*`, `**`) into a matcher. */
export function compileGlobs(list: string): (p: string) => boolean {
  const regexes = list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((g) => {
      const re = g
        .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
        .replace(/\*\*\//g, "\u0000")
        .replace(/\*\*/g, "\u0001")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, "(?:.*/)?")
        .replace(/\u0001/g, ".*");
      return new RegExp("^" + re + "$", "i");
    });
  return (p) => regexes.some((r) => r.test(p));
}
