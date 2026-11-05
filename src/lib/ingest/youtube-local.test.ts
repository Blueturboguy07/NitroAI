/* Round 6: GET /api/youtube-extract?url= ran yt-dlp (and downloaded it on
   first use) for any web page that asked. The route is now POST with a JSON
   body and the app-only header, behind the server's guard. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestYoutube } from "./youtube";
import { ingest } from "./index";

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

  /* Round 8, D1: a bare link (no scheme) was found to be YouTube but was
     sent to the server as typed. The server takes only a full http(s)
     YouTube link, so the user saw "not a link". */
  it("D1: a bare youtu.be or youtube.com link is sent as https://", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path: string, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response(JSON.stringify({ transcript: "the captions of the video", title: "Me at the zoo" }), { headers: { "content-type": "application/json" } });
      }),
    );
    const cases: Array<[string, string]> = [
      ["youtu.be/jNQXAC9IVRw", "https://youtu.be/jNQXAC9IVRw"],
      [" www.youtube.com/watch?v=jNQXAC9IVRw ", "https://www.youtube.com/watch?v=jNQXAC9IVRw"],
      ["m.youtube.com/shorts/jNQXAC9IVRw", "https://m.youtube.com/shorts/jNQXAC9IVRw"],
    ];
    for (const [typed, sent] of cases) {
      const res = await ingest({ kind: "youtube", url: typed });
      expect(res.text, typed).toBe("the captions of the video");
      expect(res.meta?.url, typed).toBe(sent);
    }
    expect(bodies).toEqual(cases.map(([, sent]) => JSON.stringify({ url: sent })));
  });
});
