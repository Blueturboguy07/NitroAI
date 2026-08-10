/* Client-side contract for the local-model detection/persistence fix: status
   and setup requests must carry the CALLER's desired model (so a returning
   user's already-chosen/pulled model is respected instead of only ever
   checking the hardcoded default), and the "done" event must report back
   which model actually got provisioned so it can be persisted to prefs. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { localSetupStatus, runLocalSetup } from "./localSetup";

/* Typed wrapper around vi.fn() so `.mock.calls[n]` comes back as
   [url, init?] instead of an inferred empty tuple (matches the pattern in
   src/lib/engine/engine.test.ts). */
function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(impl);
}

function jsonResponse(body: unknown, init: { ok?: boolean; contentType?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.ok === false ? 500 : 200,
    headers: { "content-type": init.contentType ?? "application/json" },
  });
}

function sseResponse(events: Record<string, unknown>[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("localSetupStatus", () => {
  it("requests the shipped default when no model is specified", async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ installed: true, serving: true, hasChatModel: true, hasEmbedModel: true, models: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await localSetupStatus();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/local/status");
  });

  it("forwards the caller's chosen chat/embed model as query params", async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ installed: true, serving: true, hasChatModel: true, hasEmbedModel: true, models: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await localSetupStatus({ chatModel: "llama3.1:8b", embedModel: "nomic-embed-text" });

    const url = new URL(fetchMock.mock.calls[0][0] as string, "http://x");
    expect(url.pathname).toBe("/api/local/status");
    expect(url.searchParams.get("chatModel")).toBe("llama3.1:8b");
    expect(url.searchParams.get("embedModel")).toBe("nomic-embed-text");
  });

  it("returns the pulled-models list from the server so the UI can offer a real picker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          installed: true,
          serving: true,
          hasChatModel: true,
          hasEmbedModel: true,
          models: ["llama3.1:8b", "nomic-embed-text"],
        }),
      ),
    );

    const status = await localSetupStatus({ chatModel: "llama3.1:8b" });
    expect(status?.models).toEqual(["llama3.1:8b", "nomic-embed-text"]);
  });

  it("defaults models to [] if an older/minimal server response omits it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ installed: true, serving: true, hasChatModel: true, hasEmbedModel: true })),
    );
    const status = await localSetupStatus();
    expect(status?.models).toEqual([]);
  });

  it("returns null when there's no provisioning server (static host SPA fallback)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ html: true }, { contentType: "text/html" })),
    );
    expect(await localSetupStatus()).toBeNull();
  });

  it("returns null on a network failure instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(localSetupStatus()).resolves.toBeNull();
  });
});

describe("runLocalSetup", () => {
  it("forwards the desired model to /api/local/setup as query params", async () => {
    const fetchMock = mockFetch(async () => sseResponse([{ phase: "ready" }, { phase: "done", chat: "llama3.1:8b" }]));
    vi.stubGlobal("fetch", fetchMock);

    await runLocalSetup(() => {}, undefined, { chatModel: "llama3.1:8b" });

    const url = new URL(fetchMock.mock.calls[0][0] as string, "http://x");
    expect(url.pathname).toBe("/api/local/setup");
    expect(url.searchParams.get("chatModel")).toBe("llama3.1:8b");
  });

  it("reports the actually-provisioned chat model on the terminal 'done' event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([{ phase: "pulling", model: "llama3.1:8b" }, { phase: "done", chat: "llama3.1:8b", embed: "nomic-embed-text" }])),
    );

    const events: { phase: string; chat?: string }[] = [];
    await runLocalSetup((e) => events.push(e), undefined, { chatModel: "llama3.1:8b" });

    const done = events.find((e) => e.phase === "done");
    expect(done?.chat).toBe("llama3.1:8b");
  });

  it("rejects when the stream reports an error event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([{ phase: "error", message: "Couldn't pull llama3.1:8b" }])),
    );
    await expect(runLocalSetup(() => {})).rejects.toThrow("Couldn't pull llama3.1:8b");
  });
});
