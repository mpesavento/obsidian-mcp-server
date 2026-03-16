import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// Set up env before importing vault module
const TEST_VAULT = path.join(os.tmpdir(), `vault-test-${Date.now()}`);
process.env.VAULT_PATH = TEST_VAULT;
process.env.AGENT_NAME_DEFAULT = "test-agent";

const {
  resolveVaultPath,
  readNote,
  writeNote,
  appendToNote,
  deleteNote,
  moveNote,
  listFiles,
  recentNotes,
  updateFrontmatter,
  vaultInfo,
  VaultError,
} = await import("../src/vault.js");

describe("vault", () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_VAULT, { recursive: true });
    await fs.mkdir(path.join(TEST_VAULT, "notes"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(TEST_VAULT, { recursive: true, force: true });
  });

  describe("resolveVaultPath", () => {
    it("resolves a simple path within the vault", () => {
      const resolved = resolveVaultPath("notes/test.md");
      expect(resolved).toBe(path.join(TEST_VAULT, "notes/test.md"));
    });

    it("rejects path traversal with ../", () => {
      expect(() => resolveVaultPath("../../../etc/passwd")).toThrow(VaultError);
      expect(() => resolveVaultPath("../../../etc/passwd")).toThrow(
        "Path traversal"
      );
    });

    it("resolves vault root path", () => {
      const resolved = resolveVaultPath("");
      expect(resolved).toBe(TEST_VAULT);
    });
  });

  describe("writeNote + readNote", () => {
    it("writes and reads a note with auto-generated frontmatter", async () => {
      await writeNote("notes/hello.md", "Hello world");

      const note = await readNote("notes/hello.md");
      expect(note.content.trim()).toBe("Hello world");
      expect(note.frontmatter.created).toBeDefined();
      expect(note.frontmatter.modified).toBeDefined();
      expect(note.frontmatter.created_by).toBe("test-agent");
      expect(note.frontmatter.last_modified_by).toBe("test-agent");
    });

    it("auto-adds .md extension", async () => {
      await writeNote("notes/noext", "Content here");
      const note = await readNote("notes/noext");
      expect(note.content.trim()).toBe("Content here");
      expect(note.path).toBe("notes/noext.md");
    });

    it("preserves created fields on overwrite", async () => {
      await writeNote("notes/preserve.md", "First version");
      const first = await readNote("notes/preserve.md");

      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 10));

      await writeNote("notes/preserve.md", "Second version", {
        agentName: "other-agent",
      });
      const second = await readNote("notes/preserve.md");

      expect(second.content.trim()).toBe("Second version");
      expect(second.frontmatter.created).toBe(first.frontmatter.created);
      expect(second.frontmatter.created_by).toBe("test-agent");
      expect(second.frontmatter.last_modified_by).toBe("other-agent");
    });

    it("creates directories when createDirs is true", async () => {
      await writeNote("deep/nested/dir/note.md", "Deep content", {
        createDirs: true,
      });
      const note = await readNote("deep/nested/dir/note.md");
      expect(note.content.trim()).toBe("Deep content");
    });

    it("includes custom frontmatter fields", async () => {
      await writeNote("notes/custom.md", "Tagged content", {
        frontmatter: { tags: ["test", "example"], type: "note" },
      });
      const note = await readNote("notes/custom.md");
      expect(note.frontmatter.tags).toEqual(["test", "example"]);
      expect(note.frontmatter.type).toBe("note");
    });

    it("throws NOT_FOUND for missing files", async () => {
      await expect(readNote("nonexistent.md")).rejects.toThrow(VaultError);
    });
  });

  describe("appendToNote", () => {
    it("appends content with default separator", async () => {
      await writeNote("notes/log.md", "Entry 1");
      await appendToNote("notes/log.md", "Entry 2");

      const note = await readNote("notes/log.md");
      expect(note.content).toContain("Entry 1");
      expect(note.content).toContain("---");
      expect(note.content).toContain("Entry 2");
    });

    it("appends with custom separator", async () => {
      await writeNote("notes/custom-sep.md", "Line 1");
      await appendToNote("notes/custom-sep.md", "Line 2", {
        separator: "\n\n",
      });

      const note = await readNote("notes/custom-sep.md");
      expect(note.content).toContain("Line 1");
      expect(note.content).toContain("Line 2");
      expect(note.content).not.toContain("---");
    });

    it("updates modified timestamp", async () => {
      await writeNote("notes/ts.md", "Original");
      const before = await readNote("notes/ts.md");

      await new Promise((r) => setTimeout(r, 10));
      await appendToNote("notes/ts.md", "Added");
      const after = await readNote("notes/ts.md");

      expect(after.frontmatter.modified).not.toBe(
        before.frontmatter.modified
      );
    });
  });

  describe("deleteNote", () => {
    it("soft-deletes to .trash/", async () => {
      await writeNote("notes/doomed.md", "Goodbye");
      await deleteNote("notes/doomed.md");

      // File should be gone from original location
      await expect(readNote("notes/doomed.md")).rejects.toThrow(VaultError);

      // File should exist in .trash/
      const trashPath = path.join(TEST_VAULT, ".trash", "doomed.md");
      const exists = await fs
        .access(trashPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it("throws NOT_FOUND for missing files", async () => {
      await expect(deleteNote("nonexistent.md")).rejects.toThrow(VaultError);
    });
  });

  describe("moveNote", () => {
    it("moves a note to a new path", async () => {
      await writeNote("notes/original.md", "Moving");
      await moveNote("notes/original.md", "notes/moved.md");

      await expect(readNote("notes/original.md")).rejects.toThrow(VaultError);
      const moved = await readNote("notes/moved.md");
      expect(moved.content.trim()).toBe("Moving");
    });

    it("creates destination directories", async () => {
      await writeNote("notes/src.md", "Data");
      await moveNote("notes/src.md", "archive/2026/src.md");

      const note = await readNote("archive/2026/src.md");
      expect(note.content.trim()).toBe("Data");
    });
  });

  describe("listFiles", () => {
    it("lists files in a directory", async () => {
      await writeNote("notes/a.md", "A");
      await writeNote("notes/b.md", "B");

      const files = await listFiles("notes");
      const names = files.map((f) => f.name);
      expect(names).toContain("a.md");
      expect(names).toContain("b.md");
    });

    it("lists vault root", async () => {
      const files = await listFiles("");
      const names = files.map((f) => f.name);
      expect(names).toContain("notes");
    });

    it("excludes .obsidian and .trash", async () => {
      await fs.mkdir(path.join(TEST_VAULT, ".obsidian"), { recursive: true });
      await fs.writeFile(
        path.join(TEST_VAULT, ".obsidian", "config.json"),
        "{}"
      );

      const files = await listFiles("", { recursive: true });
      const paths = files.map((f) => f.path);
      expect(paths.every((p) => !p.includes(".obsidian"))).toBe(true);
    });
  });

  describe("recentNotes", () => {
    it("returns notes sorted by modification time", async () => {
      await writeNote("notes/old.md", "Old");
      await new Promise((r) => setTimeout(r, 50));
      await writeNote("notes/new.md", "New");

      const recent = await recentNotes(10);
      expect(recent.length).toBe(2);
      expect(recent[0].name).toBe("new.md");
    });

    it("respects the limit", async () => {
      await writeNote("notes/a.md", "A");
      await writeNote("notes/b.md", "B");
      await writeNote("notes/c.md", "C");

      const recent = await recentNotes(2);
      expect(recent.length).toBe(2);
    });
  });

  describe("updateFrontmatter", () => {
    it("reads frontmatter when no updates provided", async () => {
      await writeNote("notes/meta.md", "Content", {
        frontmatter: { tags: ["test"] },
      });

      const fm = await updateFrontmatter("notes/meta.md");
      expect(fm.tags).toEqual(["test"]);
      expect(fm.created).toBeDefined();
    });

    it("atomically updates specific fields", async () => {
      await writeNote("notes/update.md", "Body text");

      const fm = await updateFrontmatter("notes/update.md", {
        tags: ["updated"],
        type: "decision",
      });
      expect(fm.tags).toEqual(["updated"]);
      expect(fm.type).toBe("decision");

      // Body should be unchanged
      const note = await readNote("notes/update.md");
      expect(note.content.trim()).toBe("Body text");
    });
  });

  describe("vaultInfo", () => {
    it("returns vault statistics", async () => {
      await writeNote("notes/a.md", "A");
      await writeNote("notes/b.md", "B");

      const info = await vaultInfo();
      expect(info.vaultPath).toBe(TEST_VAULT);
      expect(info.totalFiles).toBeGreaterThanOrEqual(2);
      expect(info.topLevelDirs).toContain("notes");
    });
  });

  describe("security", () => {
    it("rejects access to .obsidian directory via file operations", async () => {
      await expect(readNote(".obsidian/config")).rejects.toThrow(VaultError);
      await expect(writeNote(".obsidian/test.md", "hack")).rejects.toThrow(
        VaultError
      );
    });

    it("rejects access to .git directory via file operations", async () => {
      await expect(readNote(".git/HEAD")).rejects.toThrow(VaultError);
    });

    it("rejects path traversal", () => {
      expect(() => resolveVaultPath("../../../etc/passwd")).toThrow(VaultError);
    });

    it("rejects non-.md file extensions", async () => {
      await expect(writeNote("notes/script.js", "hack")).rejects.toThrow(
        VaultError
      );
    });
  });
});
