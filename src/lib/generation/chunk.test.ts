import { describe, expect, it } from "vitest";
import { capTokens, chunkByTokens, estimateTokens } from "./chunk";

describe("chunk utilities", () => {
  it("estimateTokens uses ~chars/4", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("capTokens trims to the token budget", () => {
    const text = "x".repeat(1000);
    expect(capTokens(text, 100).length).toBe(400); // 100 tokens * 4
    expect(capTokens("short", 100)).toBe("short");
  });

  it("returns a single chunk when text fits the budget", () => {
    const text = "one paragraph of modest size.";
    expect(chunkByTokens(text, 1000)).toEqual([text]);
  });

  it("splits large text into multiple chunks under budget", () => {
    const para = "This is a sentence that repeats. ".repeat(50); // ~1650 chars
    const doc = Array.from({ length: 20 }, () => para).join("\n\n");
    const chunks = chunkByTokens(doc, 500); // 500 tokens ≈ 2000 chars
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000 + 200);
    // no content lost (roughly): joined length is close to original
    expect(chunks.join(" ").length).toBeGreaterThan(doc.length * 0.8);
  });

  it("hard-splits a single oversized paragraph", () => {
    const huge = "word ".repeat(2000); // one ~10k-char paragraph, no blank lines
    const chunks = chunkByTokens(huge, 300); // ~1200 chars each
    expect(chunks.length).toBeGreaterThan(3);
  });

  it("returns nothing for empty input", () => {
    expect(chunkByTokens("   ", 100)).toEqual([]);
  });
});
