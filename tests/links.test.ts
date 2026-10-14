import { describe, it, expect } from "vitest";
import {
  maskCode,
  resolveLink,
  rewriteLinks,
  compileGlobs,
} from "../src/links.js";

const BASE = [
  "00-meta/AGENTS.md",
  "00-meta/README.md",
  "35-playbooks/README.md",
  "35-playbooks/old-name.md",
  "20-context/a/overview.md",
  "20-context/b/overview.md",
  "notes/source.md",
];

function run(
  text: string,
  o: { from: string; to: string; source?: string; paths?: string[] }
) {
  const oldPaths = [...new Set([...(o.paths ?? BASE), o.from])];
  const newPaths = oldPaths.map((p) => (p === o.from ? o.to : p));
  const source = o.source ?? "notes/source.md";
  return rewriteLinks(text, {
    oldPath: o.from,
    newPath: o.to,
    sourceOld: source,
    sourceNew: source === o.from ? o.to : source,
    oldPaths,
    newPaths,
  });
}

const OLD = "35-playbooks/old-name.md";

describe("maskCode", () => {
  it("blanks fenced blocks and inline code but keeps length", () => {
    const t = "a [[x]]\n```\n[[y]]\n```\n`[[z]]` b [[w]]";
    const m = maskCode(t);
    expect(m.length).toBe(t.length);
    expect(m).toContain("[[x]]");
    expect(m).toContain("[[w]]");
    expect(m).not.toContain("[[y]]");
    expect(m).not.toContain("[[z]]");
  });

  it("does not treat ```inline``` on one line as the start of a block", () => {
    const m = maskCode("```code``` [[k]]\n[[after]]");
    expect(m).toContain("[[k]]");
    expect(m).toContain("[[after]]");
  });

  it("handles ~~~ fences and longer closing fences", () => {
    const m = maskCode("~~~\n[[a]]\n~~~~\n[[b]]");
    expect(m).not.toContain("[[a]]");
    expect(m).toContain("[[b]]");
  });
});

describe("resolveLink", () => {
  it("resolves a unique bare name", () => {
    expect(resolveLink("AGENTS", "notes/source.md", BASE)).toEqual({
      status: "ok",
      path: "00-meta/AGENTS.md",
    });
  });

  it("reports duplicate bare names as ambiguous", () => {
    const r = resolveLink("README", "notes/source.md", BASE);
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") expect(r.candidates).toHaveLength(2);
  });

  it("resolves vault-root paths, suffix paths and relative paths", () => {
    expect(resolveLink("35-playbooks/README", "x.md", BASE)).toMatchObject({
      status: "ok",
      path: "35-playbooks/README.md",
    });
    expect(resolveLink("a/overview", "x.md", BASE)).toMatchObject({
      status: "ok",
      path: "20-context/a/overview.md",
    });
    expect(
      resolveLink("../00-meta/AGENTS", "35-playbooks/x.md", BASE)
    ).toMatchObject({ status: "ok", path: "00-meta/AGENTS.md" });
  });

  it("is case-insensitive and ignores URLs and unknown notes", () => {
    expect(resolveLink("agents", "x.md", BASE)).toMatchObject({ status: "ok" });
    expect(resolveLink("https://example.com/a", "x.md", BASE).status).toBe(
      "none"
    );
    expect(resolveLink("nope", "x.md", BASE).status).toBe("none");
  });
});

describe("rewriteLinks", () => {
  it("rewrites path-qualified links in every form, keeping suffixes", () => {
    const text = [
      "[[35-playbooks/old-name]]",
      "[[35-playbooks/old-name|alias]]",
      "[[35-playbooks/old-name#Sec]]",
      "![[35-playbooks/old-name]]",
      "| [[35-playbooks/old-name\\|tbl]] |",
      "[[35-playbooks/old-name#^blk|x]]",
      "[[35-playbooks/old-name.md]]",
    ].join(" ");
    const r = run(text, { from: OLD, to: "40-references/new-name.md" });
    expect(r.count).toBe(7);
    expect(r.text).toBe(
      [
        "[[40-references/new-name]]",
        "[[40-references/new-name|alias]]",
        "[[40-references/new-name#Sec]]",
        "![[40-references/new-name]]",
        "| [[40-references/new-name\\|tbl]] |",
        "[[40-references/new-name#^blk|x]]",
        "[[40-references/new-name.md]]",
      ].join(" ")
    );
  });

  it("leaves a bare link alone when only the folder changes", () => {
    const r = run("[[old-name]]", { from: OLD, to: "archive/old-name.md" });
    expect(r.count).toBe(0);
    expect(r.text).toBe("[[old-name]]");
  });

  it("renames a bare link when the file name changes", () => {
    const r = run("[[old-name|x]] and [[old-name#H]]", {
      from: OLD,
      to: "35-playbooks/renamed.md",
    });
    expect(r.text).toBe("[[renamed|x]] and [[renamed#H]]");
  });

  it("switches a bare link to a path when the new name would be ambiguous", () => {
    const r = run("[[old-name]]", { from: OLD, to: "35-playbooks/overview.md" });
    expect(r.text).toBe("[[35-playbooks/overview]]");
  });

  it("rewrites relative links so they still resolve", () => {
    const a = run("[[./old-name]]", {
      from: OLD,
      to: "archive/old-name.md",
      source: "35-playbooks/x.md",
      paths: [...BASE, "35-playbooks/x.md"],
    });
    expect(a.text).toBe("[[../archive/old-name]]");
    const b = run("[[../35-playbooks/old-name#H]]", {
      from: OLD,
      to: "archive/old-name.md",
      source: "00-meta/AGENTS.md",
    });
    expect(b.text).toBe("[[../archive/old-name#H]]");
  });

  it("never touches links inside code", () => {
    const text = "`[[35-playbooks/old-name]]`\n```\n[[35-playbooks/old-name]]\n```";
    const r = run(text, { from: OLD, to: "archive/old-name.md" });
    expect(r.count).toBe(0);
    expect(r.text).toBe(text);
  });

  it("rewrites markdown links to notes but not external ones", () => {
    const r = run(
      "[a](35-playbooks/old-name.md#h) [b](https://example.com/old-name.md) [c](./old-name.md)",
      {
        from: OLD,
        to: "archive/old-name.md",
        source: "35-playbooks/x.md",
        paths: [...BASE, "35-playbooks/x.md"],
      }
    );
    expect(r.text).toBe(
      "[a](archive/old-name.md#h) [b](https://example.com/old-name.md) [c](../archive/old-name.md)"
    );
  });

  it("adjusts the moved note's own relative links and self-links", () => {
    const text = "[[../00-meta/AGENTS]] [[old-name]] [[./README]] [[35-playbooks/old-name#H]]";
    const r = run(text, {
      from: OLD,
      to: "archive/deep/old-name.md",
      source: OLD,
    });
    expect(r.text).toBe(
      "[[../../00-meta/AGENTS]] [[old-name]] [[../../35-playbooks/README]] [[archive/deep/old-name#H]]"
    );
  });

  it("reports ambiguous links that might mean the moved note, and leaves them", () => {
    const r = run("[[README]]", {
      from: "35-playbooks/README.md",
      to: "35-playbooks/readme-new.md",
    });
    expect(r.count).toBe(0);
    expect(r.ambiguous).toBe(1);
    expect(r.text).toBe("[[README]]");
  });

  it("rewrites links inside frontmatter values without touching anything else", () => {
    const text =
      '---\nrelated: ["[[35-playbooks/old-name]]"]\nlast-updated: 2026-04-30\n---\nbody';
    const r = run(text, { from: OLD, to: "archive/old-name.md" });
    expect(r.text).toBe(
      '---\nrelated: ["[[archive/old-name]]"]\nlast-updated: 2026-04-30\n---\nbody'
    );
  });

  it("ignores same-note anchors", () => {
    const r = run("[[#Heading]]", { from: OLD, to: "archive/old-name.md" });
    expect(r.count).toBe(0);
  });
});

describe("compileGlobs", () => {
  const m = compileGlobs("10-identity/**, **/decisions.md ,60-daily/**,a/*.md");
  it("matches ** across folders and * within one folder", () => {
    expect(m("10-identity/mike.md")).toBe(true);
    expect(m("20-context/x/decisions.md")).toBe(true);
    expect(m("decisions.md")).toBe(true);
    expect(m("60-daily/2026-01-01.md")).toBe(true);
    expect(m("a/b.md")).toBe(true);
    expect(m("a/b/c.md")).toBe(false);
    expect(m("20-context/x/decisions-old.md")).toBe(false);
    expect(m("notes/a.md")).toBe(false);
  });
  it("an empty list protects nothing", () => {
    expect(compileGlobs("")("10-identity/mike.md")).toBe(false);
  });
});
