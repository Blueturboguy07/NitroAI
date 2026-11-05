import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineError } from "./engine/types";
import {
  balanceLine,
  clearCreditNotice,
  creditAction,
  describeError,
  disconnectPublik,
  dollars,
  fetchPublikStatus,
  fetchPublikWallet,
  forgetPublik,
  getBalance,
  linesToCapabilities,
  provisionPublik,
  publikUrl,
  resetBalance,
  starterIsLow,
  statusToBalance,
  usageToBalance,
} from "./publik";

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
    expect(creditAction(anon)).toEqual({ label: "Link this computer & pick a plan", url: "https://publikhq.com/claim/HK7F-2QWD" });
    const claimed = new EngineError("x", "credit", { topUpUrl: "https://publikhq.com/dashboard/api/add", claimState: "claimed" });
    expect(creditAction(claimed)).toEqual({ label: "Add a plan or pack", url: "https://publikhq.com/dashboard/api/add" });
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

  it("describeError(): a 402 renders the gateway's own message (contract §12.3) plus its one link; local copy only without a message", () => {
    const serverMsg =
      "Not enough publik credit for this request. The model behind this app is billed per use by its provider; publik passes that on at half the list price and nothing is charged behind your back. Link this computer and pick a plan at the link below, or use your own key.";
    const anon = describeError(new EngineError(serverMsg, "credit", { topUpUrl: "https://publikhq.com/claim/X", claimState: "anonymous" }));
    expect(anon.message).toBe(serverMsg);
    expect(anon.action).toEqual({ label: "Link this computer & pick a plan", url: "https://publikhq.com/claim/X" });
    const claimed = describeError(new EngineError("$0.00 left.", "credit", { topUpUrl: "https://publikhq.com/dashboard/api/add", claimState: "claimed" }));
    expect(claimed.message).toBe("$0.00 left.");
    const blank = describeError(new EngineError("", "credit", { topUpUrl: "https://publikhq.com/claim/X", claimState: "anonymous" }));
    // Migration 0059: an unlinked install never had a starter, so the fallback never says "used up".
    expect(blank.message).toBe(
      "publik API has no balance on this computer. Link this computer to your publik account ($0.05 of free use, once), pick a plan, or use your own key.",
    );
    expect(blank.message).not.toMatch(/used up|free starter/i);
    expect(describeError(new EngineError("", "credit", { topUpUrl: "https://publikhq.com/dashboard/api/add", claimState: "claimed" })).message).toBe("publik API needs a plan or pack.");
    expect(describeError(new EngineError("removed", "auth", { disconnected: true })).message).toMatch(/publik API is disconnected/);
    expect(describeError(new EngineError("cap", "credit", { retryAfterSeconds: 60 })).message).toBe("cap");
    expect(describeError(new Error("boom"))).toEqual({ message: "boom", action: null });
    expect(describeError("x", "fallback")).toEqual({ message: "fallback", action: null });
  });

  it("a 402 through describeError() lands in the store as a notice with the server message and one link; the next successful call clears it", () => {
    resetBalance();
    describeError(new EngineError("Not enough publik credit for this request. Link this computer and pick a plan at the link below.", "credit", { topUpUrl: "https://publikhq.com/claim/X", claimState: "anonymous" }));
    expect(getBalance().creditNotice).toMatchObject({ message: expect.stringMatching(/^Not enough publik credit/), url: "https://publikhq.com/claim/X", claimState: "anonymous" });
    usageToBalance({ balanceMicros: 900_000, streamed: false });
    expect(getBalance().creditNotice).toBeNull();
    // Off-domain link → no notice at all.
    describeError(new EngineError("x", "credit", { topUpUrl: "https://evil.example/pay", claimState: "anonymous" }));
    expect(getBalance().creditNotice ?? null).toBeNull();
    // A plain error never touches the store.
    describeError(new Error("boom"));
    expect(getBalance().creditNotice ?? null).toBeNull();
    describeError(new EngineError("m", "credit", { topUpUrl: "https://publikhq.com/claim/X" }));
    clearCreditNotice();
    expect(getBalance().creditNotice).toBeNull();
    resetBalance();
  });

  it("starterIsLow(): below 20% of the server's grant while anonymous (an install minted before 0059); never once claimed, never at a $0.00 mint, never without both numbers", () => {
    resetBalance();
    statusToBalance({ available: true, state: "ready", baseUrl: "/api/publik/v1", starterMicros: 250_000, claimUrl: "https://publikhq.com/claim/X" });
    expect(getBalance()).toMatchObject({ starterMicros: 250_000, claimUrl: "https://publikhq.com/claim/X" });
    expect(starterIsLow({ starterMicros: 250_000, starterRemainingMicros: 60_000 })).toBe(false);
    expect(starterIsLow({ starterMicros: 250_000, starterRemainingMicros: 49_999 })).toBe(true);
    expect(starterIsLow({ starterMicros: 250_000, starterRemainingMicros: 49_999, claimState: "claimed" })).toBe(false);
    expect(starterIsLow({ starterRemainingMicros: 0 })).toBe(false);
    expect(starterIsLow({ starterMicros: 0, starterRemainingMicros: 0 })).toBe(false);
    // An off-domain claim link from status is dropped before it can reach the store.
    resetBalance();
    statusToBalance({ available: true, state: "ready", baseUrl: "/api/publik/v1", claimUrl: "https://evil.example/claim" });
    expect(getBalance().claimUrl).toBeUndefined();
    resetBalance();
  });

  it("linesToCapabilities(): no list = every line; a list narrows", () => {
    expect(linesToCapabilities(null)).toEqual({ chat: true, transcription: true, tts: true, embeddings: true });
    expect(linesToCapabilities(["chat", "audio"])).toEqual({ chat: true, transcription: true, tts: false, embeddings: false });
  });
});

/* Round 6: the local server refuses every /api/* request without the
   app-only header, and a POST without Content-Type application/json. */
describe("publik calls to the local server", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("every call sends x-nitroai-app: 1; every POST sends a JSON body", async () => {
    const seen: Array<{ path: string; method: string; app: string | null; type: string | null; body: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        seen.push({ path, method: init?.method ?? "GET", app: h.get("x-nitroai-app"), type: h.get("content-type"), body: init?.body == null ? null : String(init.body) });
        return new Response(JSON.stringify({ available: true, state: "ready", baseUrl: "/api/publik/v1", balance_micros: 5 }), { headers: { "content-type": "application/json" } });
      }),
    );
    await fetchPublikStatus();
    await provisionPublik(1);
    await forgetPublik();
    await disconnectPublik();
    await fetchPublikWallet();
    expect(seen).toEqual([
      { path: "/api/publik/status", method: "GET", app: "1", type: null, body: null },
      { path: "/api/publik/provision", method: "POST", app: "1", type: "application/json", body: JSON.stringify({ disclosure_version: 1, force: false }) },
      { path: "/api/publik/forget", method: "POST", app: "1", type: "application/json", body: "{}" },
      { path: "/api/publik/disconnect", method: "POST", app: "1", type: "application/json", body: "{}" },
      { path: "/api/publik/wallet", method: "GET", app: "1", type: null, body: null },
    ]);
  });
});
