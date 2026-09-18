import { describe, expect, it } from "vitest";
import { EngineError } from "./engine/types";
import { balanceLine, creditAction, describeError, dollars, linesToCapabilities, publikUrl } from "./publik";

describe("publik helpers", () => {
  it("dollars() formats micros", () => {
    expect(dollars(4_870_000)).toBe("$4.87");
    expect(dollars(250_000)).toBe("$0.25");
    expect(dollars(1_240)).toBe("$0.0012");
    expect(dollars(0)).toBe("$0.00");
  });

  it("balanceLine() renders the R21 §4.1 shapes", () => {
    expect(balanceLine({})).toBe("");
    expect(balanceLine({ balanceMicros: 3_120_000, weekUsedMicros: 680_000, weekBudgetMicros: null })).toBe("$3.12 left · $0.68 used this week");
    expect(balanceLine({ balanceMicros: 3_120_000, weekUsedMicros: 1_200_000, weekBudgetMicros: 4_620_000, weekResetsAt: "2026-09-25T17:04:11Z" })).toMatch(
      /^\$3\.12 left · \$1\.20 used this week of \$4\.62 · resets /,
    );
  });

  it("creditAction(): a 402 yields exactly one link (top_up_url), labelled by claim_state; other errors none", () => {
    const anon = new EngineError("Not enough publik credit.", "credit", { topUpUrl: "https://publikhq.com/claim/HK7F-2QWD", claimState: "anonymous" });
    expect(creditAction(anon)).toEqual({ label: "Link this computer", url: "https://publikhq.com/claim/HK7F-2QWD" });
    const claimed = new EngineError("x", "credit", { topUpUrl: "https://publikhq.com/dashboard/api/add", claimState: "claimed" });
    expect(creditAction(claimed)).toEqual({ label: "Add credit", url: "https://publikhq.com/dashboard/api/add" });
    expect(creditAction(new EngineError("x", "credit", { topUpUrl: null }))).toBeNull();
    expect(creditAction(new EngineError("x", "rate_limit"))).toBeNull();
    expect(creditAction(new Error("x"))).toBeNull();
  });

  it("contract §11.4: only https://publikhq.com/ links are ever opened", () => {
    expect(publikUrl("https://publikhq.com/claim/X")).toBe("https://publikhq.com/claim/X");
    expect(publikUrl("https://evil.example/claim/X")).toBeNull();
    expect(publikUrl("http://publikhq.com/claim/X")).toBeNull();
    expect(publikUrl("https://publikhq.com.evil.example/")).toBeNull();
    expect(creditAction(new EngineError("x", "credit", { topUpUrl: "https://evil.example/pay" }))).toBeNull();
  });

  it("describeError(): publik states get the R21 §4.1 copy; everything else keeps its message", () => {
    const anon = describeError(new EngineError("Not enough publik credit.", "credit", { topUpUrl: "https://publikhq.com/claim/X", claimState: "anonymous" }));
    expect(anon.message).toMatch(/^publik API needs credit\./);
    expect(anon.message).toMatch(/Link this computer/);
    expect(anon.action?.url).toBe("https://publikhq.com/claim/X");
    const claimed = describeError(new EngineError("$0.00 left.", "credit", { topUpUrl: "https://publikhq.com/dashboard/api/add", claimState: "claimed" }));
    expect(claimed.message).toBe("publik API needs credit. $0.00 left.");
    expect(describeError(new EngineError("removed", "auth", { disconnected: true })).message).toMatch(/publik API is disconnected/);
    expect(describeError(new EngineError("cap", "credit", { retryAfterSeconds: 60 })).message).toBe("cap");
    expect(describeError(new Error("boom"))).toEqual({ message: "boom", action: null });
    expect(describeError("x", "fallback")).toEqual({ message: "fallback", action: null });
  });

  it("linesToCapabilities(): no list = every line; a list narrows", () => {
    expect(linesToCapabilities(null)).toEqual({ chat: true, transcription: true, tts: true, embeddings: true });
    expect(linesToCapabilities(["chat", "audio"])).toEqual({ chat: true, transcription: true, tts: false, embeddings: false });
  });
});
