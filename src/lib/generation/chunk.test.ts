import { describe, expect, it } from "vitest";
import { capTokens, chunkByTokens, estimateTokens, lessonBudgets } from "./chunk";

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

describe("lessonBudgets", () => {
  it("sends every lesson whole when they all fit", () => {
    expect(lessonBudgets([100, 9000], 12000)).toEqual([100, 9000]);
  });

  it("keeps short lessons whole and splits what's left among the long ones", () => {
    expect(lessonBudgets([20000, 100, 30000], 12000)).toEqual([5950, 100, 5950]);
  });

  it("never goes over the shared budget, whatever the mix", () => {
    const sizes = [7, 1234, 50, 99999, 3000, 0, 640];
    const caps = lessonBudgets(sizes, 4000);
    expect(caps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(4000);
    caps.forEach((c, i) => expect(c).toBeLessThanOrEqual(sizes[i]));
    expect(caps[5]).toBe(0);
  });

  it("handles no lessons", () => {
    expect(lessonBudgets([], 12000)).toEqual([]);
  });
});
