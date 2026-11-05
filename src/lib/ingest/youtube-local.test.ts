/* Round 6: GET /api/youtube-extract?url= ran yt-dlp (and downloaded it on
   first use) for any web page that asked. The route is now POST with a JSON
   body and the app-only header, behind the server's guard. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestYoutube } from "./youtube";

afterEach(() => vi.unstubAllGlobals());

describe("YouTube through the local server", () => {
  it("POSTs {url} as JSON with x-nitroai-app: 1", async () => {
    const seen: Array<{ path: string; method?: string; app: string | null; type: string | null; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        seen.push({ path, method: init?.method, app: h.get("x-nitroai-app"), type: h.get("content-type"), body: String(init?.body) });
        return new Response(JSON.stringify({ transcript: "the captions of the video", title: "A talk" }), { headers: { "content-type": "application/json" } });
      }),
    );
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const res = await ingestYoutube(url);
    expect(res.text).toBe("the captions of the video");
    expect(seen).toEqual([{ path: "/api/youtube-extract", method: "POST", app: "1", type: "application/json", body: JSON.stringify({ url }) }]);
  });
});
