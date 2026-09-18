// @vitest-environment jsdom
/* buildEngine() resolution rules the publik default must never break:
     - "cloud" with a user key NEVER consults the publik credential
     - "publik" with no credential degrades to null (no throw, no dialog)
     - "publik" never reads or writes the user's own key slot */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const status = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildEngine", () => {
  it("mode cloud + sk- key → OpenAI engine; /api/publik is never called", async () => {
    localStorage.setItem("nitroai.apikey", "sk-x");
    const fetchMock = vi.fn(async () => status({ available: true, state: "ready", baseUrl: "/api/publik/v1" }));
    vi.stubGlobal("fetch", fetchMock);
    const { buildEngine } = await import("./app");
    const e = await buildEngine({ mode: "cloud", onboarded: true, language: "English" });
    expect(e?.provider).toBe("openai");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mode cloud + pasted pk_ key → publik provider through the proxy", async () => {
    localStorage.setItem("nitroai.apikey", "pk_live_a8k2m9x4q7v1_h3n6r9t2w5y8z1b4c7d0f3g6j9k2m5p8");
    vi.stubGlobal("fetch", vi.fn());
    const { buildEngine } = await import("./app");
    const e = await buildEngine({ mode: "cloud", onboarded: true, language: "English" });
    expect(e?.provider).toBe("publik");
  });

  it("mode publik with the probe saying unavailable / not ready → null, no throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => status({ available: false, state: "unprovisioned", baseUrl: "/api/publik/v1" })));
    const { buildEngine } = await import("./app");
    await expect(buildEngine({ mode: "publik", onboarded: true, language: "English" })).resolves.toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => status({ available: true, state: "disconnected", baseUrl: "/api/publik/v1" })));
    await expect(buildEngine({ mode: "publik", onboarded: true, language: "English" })).resolves.toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })));
    await expect(buildEngine({ mode: "publik", onboarded: true, language: "English" })).resolves.toBeNull();
  });

  it("mode publik ready → publik engine using the credential's aliases; the user's key slot is untouched", async () => {
    localStorage.setItem("nitroai.apikey", "sk-user-key-stays");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === "/api/publik/status") {
        return status({
          available: true,
          state: "ready",
          baseUrl: "/api/publik/v1",
          models: { fast: "publik-fast", balanced: "publik-balanced", smart: "publik-smart" },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { buildEngine } = await import("./app");
    const e = await buildEngine({ mode: "publik", onboarded: true, language: "English" });
    expect(e?.provider).toBe("publik");
    expect(e?.capabilities()).toEqual({ chat: true, transcription: true, tts: true, embeddings: true });
    await e!.structured({ messages: [{ role: "user", content: "x" }], schema: {}, schemaName: "s", tier: "strong" });
    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/publik/v1/chat/completions")!;
    expect(JSON.parse((call[1] as RequestInit).body as string).model).toBe("publik-balanced");
    expect(localStorage.getItem("nitroai.apikey")).toBe("sk-user-key-stays");
  });

  it("an optional per-install lines list narrows capabilities", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => status({ available: true, state: "ready", baseUrl: "/api/publik/v1", lines: ["chat"] })));
    const { buildEngine } = await import("./app");
    const e = await buildEngine({ mode: "publik", onboarded: true, language: "English" });
    expect(e?.capabilities()).toEqual({ chat: true, transcription: false, tts: false, embeddings: false });
  });
});
