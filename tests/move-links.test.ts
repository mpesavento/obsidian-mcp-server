import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const TEST_VAULT = path.join(os.tmpdir(), `vault-move-links-${Date.now()}`);
process.env.VAULT_PATH = TEST_VAULT;
process.env.AGENT_NAME_DEFAULT = "test-agent";
delete process.env.LINK_REWRITE_SKIP; // exercise the default protected zones

const { moveNote, writeNote, readNote, VaultError } = await import(
  "../src/vault.js"
);

async function put(rel: string, text: string) {
  const full = path.join(TEST_VAULT, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text, "utf-8");
}
const get = (rel: string) => fs.readFile(path.join(TEST_VAULT, rel), "utf-8");
const exists = (rel: string) =>
  fs
    .access(path.join(TEST_VAULT, rel))
    .then(() => true)
    .catch(() => false);

const TARGET = [
  "---",
  "type: context",
  "last-updated: 2026-04-30",
  "---",
  "# Target",
  "",
  "## Section",
  "",
  "See [[../other/sibling]].",
  "",
].join("\n");

const LINKER = [
  "---",
  'related: ["[[notes/target]]"]',
  "last-updated: 2026-04-30",
  "created: 2026-04-01T10:00:00-07:00",
  "---",
  "bare [[target]] | path [[notes/target#Section|see]] | embed ![[notes/target]] | rel [[../notes/target]]",
  "`[[notes/target]]` in code",
  "[md](notes/target.md)",
  "",
].join("\n");

beforeEach(async () => {
  await fs.mkdir(TEST_VAULT, { recursive: true });
  await put("notes/target.md", TARGET);
  await put("other/sibling.md", "sibling\n");
  await put("other/linker.md", LINKER);
  await put("10-identity/mike.md", "---\ntype: identity\n---\nSee [[notes/target]].\n");
  await put("60-daily/2026-10-14.md", "See [[notes/target]] and [[target]].\n");
});

afterEach(async () => {
  await fs.rm(TEST_VAULT, { recursive: true, force: true });
});

describe("moveNote link rewriting", () => {
  it("rewrites inbound links, preserves frontmatter bytes, skips protected notes", async () => {
    const r = await moveNote("notes/target.md", "archive/2026/target.md");

    expect(await exists("notes/target.md")).toBe(false);
    expect(await exists("archive/2026/target.md")).toBe(true);

    const linker = await get("other/linker.md");
    expect(linker).toContain('related: ["[[archive/2026/target]]"]');
    expect(linker).toContain("bare [[target]]"); // folder-only move: bare name still valid
    expect(linker).toContain("[[archive/2026/target#Section|see]]");
    expect(linker).toContain("![[archive/2026/target]]");
    expect(linker).toContain("[[../archive/2026/target]]");
    expect(linker).toContain("`[[notes/target]]` in code"); // code untouched
    expect(linker).toContain("[md](archive/2026/target.md)");
    // Frontmatter is not re-serialized: bare dates stay bare, offsets stay put.
    expect(linker).toContain("last-updated: 2026-04-30\n");
    expect(linker).toContain("created: 2026-04-01T10:00:00-07:00\n");
    expect(linker).not.toContain("modified:");

    // Protected zones are reported, not edited.
    expect(await get("10-identity/mike.md")).toContain("[[notes/target]]");
    expect(await get("60-daily/2026-10-14.md")).toContain("[[notes/target]]");
    expect(r.protectedSkipped.map((x) => x.path).sort()).toEqual([
      "10-identity/mike.md",
      "60-daily/2026-10-14.md",
    ]);

    expect(r.rewritten.find((x) => x.path === "other/linker.md")?.count).toBe(5);
    expect(r.errors).toEqual([]);

    // The moved note's own relative link still points at the same sibling.
    const moved = await get("archive/2026/target.md");
    expect(moved).toContain("[[../../other/sibling]]");
    expect(moved).toContain("last-updated: 2026-04-30\n");
  });

  it("renames bare links when the file name changes", async () => {
    await moveNote("notes/target.md", "notes/renamed.md");
    const linker = await get("other/linker.md");
    expect(linker).toContain("bare [[renamed]]");
    expect(linker).toContain("[[notes/renamed#Section|see]]");
  });

  it("dry_run reports the plan and changes nothing", async () => {
    const before = await get("other/linker.md");
    const r = await moveNote("notes/target.md", "archive/target.md", {
      dryRun: true,
    });
    expect(r.dryRun).toBe(true);
    expect(r.rewritten.length).toBeGreaterThan(0);
    expect(await get("other/linker.md")).toBe(before);
    expect(await exists("notes/target.md")).toBe(true);
    expect(await exists("archive/target.md")).toBe(false);
  });

  it("update_links: false is a plain move", async () => {
    const before = await get("other/linker.md");
    const r = await moveNote("notes/target.md", "archive/target.md", {
      updateLinks: false,
    });
    expect(r.rewritten).toEqual([]);
    expect(await get("other/linker.md")).toBe(before);
    expect(await exists("archive/target.md")).toBe(true);
  });

  it("refuses to overwrite an existing note", async () => {
    await put("archive/target.md", "precious\n");
    await expect(
      moveNote("notes/target.md", "archive/target.md")
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    expect(await get("archive/target.md")).toBe("precious\n");
    expect(await exists("notes/target.md")).toBe(true);
    expect(await get("other/linker.md")).toBe(LINKER);
  });

  it("rejects moving a note onto itself", async () => {
    await expect(
      moveNote("notes/target.md", "notes/target.md")
    ).rejects.toThrow(VaultError);
  });

  it("allows a case-only rename", async () => {
    await put("notes/Case.md", "x\n");
    await moveNote("notes/Case.md", "notes/case.md");
    expect(await exists("notes/case.md")).toBe(true);
  });

  it("reports ambiguous links and warns about a new duplicate name", async () => {
    await put("a/dup.md", "a\n");
    await put("b/dup.md", "b\n");
    await put("other/ambig.md", "[[dup]]\n");
    const r = await moveNote("a/dup.md", "c/dup.md");
    expect(await get("other/ambig.md")).toBe("[[dup]]\n");
    expect(r.ambiguous.map((x) => x.path)).toContain("other/ambig.md");
    expect(r.warnings.join(" ")).toContain("already named");
  });

  it("still moves a note with no inbound links", async () => {
    const r = await moveNote("other/sibling.md", "other/sibling2.md");
    expect(r.rewritten.map((x) => x.path)).not.toContain("other/sibling2.md");
    expect(await exists("other/sibling2.md")).toBe(true);
  });
});

describe("writeNote frontmatter handling", () => {
  it("keeps existing frontmatter when none is passed", async () => {
    await writeNote("wn.md", "one", {
      frontmatter: { type: "playbook", tags: ["a", "b"] },
    });
    await writeNote("wn.md", "two");
    const n = await readNote("wn.md");
    expect(n.content.trim()).toBe("two");
    expect(n.frontmatter.type).toBe("playbook");
    expect(n.frontmatter.tags).toEqual(["a", "b"]);
  });

  it("treats an empty frontmatter object as 'not provided'", async () => {
    await writeNote("wn.md", "one", { frontmatter: { type: "playbook" } });
    await writeNote("wn.md", "two", { frontmatter: {} });
    expect((await readNote("wn.md")).frontmatter.type).toBe("playbook");
  });

  it("replaces existing fields when frontmatter is passed", async () => {
    await writeNote("wn.md", "one", {
      frontmatter: { type: "playbook", tags: ["a"] },
    });
    await writeNote("wn.md", "two", { frontmatter: { type: "reference" } });
    const n = await readNote("wn.md");
    expect(n.frontmatter.type).toBe("reference");
    expect(n.frontmatter.tags).toBeUndefined();
    expect(n.frontmatter.created).toBeDefined(); // auto-managed fields survive
  });
});
