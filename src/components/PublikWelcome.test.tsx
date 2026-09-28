/* Migration 0059 (founder, 2026-09-28): a new computer is minted at $0.00 and
   the one free grant ($0.05 per publik account) arrives when it is linked.
   The first-run balance line must say that, never "$0.00 of free use". */
import { describe, expect, it } from "vitest";
import { starterLineFor, unlinkedAtZero } from "./PublikWelcome";

const CLAIM = "https://publikhq.com/claim/HK7F-2QWD";

describe("starterLineFor()", () => {
  it("an unlinked $0.00 mint with a claim link names what linking gives", () => {
    expect(starterLineFor({ starterMicros: 0, balanceMicros: 0, claimUrl: CLAIM })).toBe("$0.00 · link this computer for $0.05 of free use");
    expect(unlinkedAtZero({ starterMicros: 0, balanceMicros: 0, claimUrl: CLAIM })).toBe(true);
    // Only the balance number present (no starter_micros) reads the same way.
    expect(starterLineFor({ balanceMicros: 0, claimUrl: CLAIM })).toBe("$0.00 · link this computer for $0.05 of free use");
  });

  it("$0.00 with no usable claim link promises nothing about linking", () => {
    expect(starterLineFor({ starterMicros: 0, claimUrl: null })).toBe("Your balance starts at $0.00.");
    expect(starterLineFor({ starterMicros: 0, claimUrl: "https://evil.example/claim/X" })).toBe("Your balance starts at $0.00.");
    expect(unlinkedAtZero({ starterMicros: 0, claimUrl: "https://evil.example/claim/X" })).toBe(false);
  });

  it("a starter above $0.00 renders the server's amount as free use", () => {
    expect(starterLineFor({ starterMicros: 50_000, claimUrl: null })).toBe("$0.05 of free use");
    expect(unlinkedAtZero({ starterMicros: 50_000, claimUrl: CLAIM })).toBe(false);
  });

  it("no number at all falls back to the link sentence", () => {
    expect(starterLineFor({ claimUrl: CLAIM })).toBe("Linking your publik account gives $0.05 of free use, once.");
    expect(unlinkedAtZero({ claimUrl: CLAIM })).toBe(false);
  });

  it("never says 'credits', 'free starter' or '$0.00 of free'", () => {
    for (const s of [
      starterLineFor({ starterMicros: 0, claimUrl: CLAIM }),
      starterLineFor({ starterMicros: 0 }),
      starterLineFor({ starterMicros: 50_000 }),
      starterLineFor({}),
    ]) {
      expect(s).not.toMatch(/\bcredits\b|free starter|\$0\.00 of free/i);
    }
  });
});
