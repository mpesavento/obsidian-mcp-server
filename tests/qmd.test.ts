import { describe, it, expect } from "vitest";
import { parseVectorCount } from "../src/search/qmd.js";

describe("parseVectorCount", () => {
  it("reads the embedded vector count from qmd status output", () => {
    const out = [
      "Documents",
      "  Total:    706 files indexed",
      "  Vectors:  2635 embedded",
      "  Orphaned: 219 embedding chunks (8%)",
    ].join("\n");
    expect(parseVectorCount(out)).toBe(2635);
  });

  it("returns 0 when there is no vectors line", () => {
    expect(parseVectorCount("Documents\n  Total: 3 files indexed")).toBe(0);
  });
});
