/* Round 5, item 3: Website links failed with "Failed to fetch" on most real
 * sites (en.wikipedia.org too): the renderer's fetch() is cross-origin from
 * http://127.0.0.1:<port> and the sites send no CORS header for it. The
 * local server now downloads the page (GET /api/fetch-page). These tests run
 * startServer() against a LOCAL FAKE SITE with Node's own fetch. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startServer } from "./httpServer.mjs";

const site = { server: null, url: "", requests: [], route: null };

beforeAll(async () => {
  site.server = http.createServer((req, res) => {
    site.requests.push({ url: req.url, headers: req.headers });
    site.route(req, res);
  });
  await new Promise((r) => site.server.listen(0, "127.0.0.1", r));
  site.url = `http://127.0.0.1:${site.server.address().port}`;
});
afterAll(() => site.server.close());

const ARTICLE = "<html><head><title>Photosynthesis</title></head><body><p>Plants fix CO2.</p></body></html>";

function defaultRoute(req, res) {
  if (req.url === "/wiki/Photosynthesis") {
    res.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
    return res.end(ARTICLE);
  }
  if (req.url === "/moved") {
    res.writeHead(301, { location: "/wiki/Photosynthesis" });
    return res.end();
  }
  if (req.url === "/to-file") {
    res.writeHead(302, { location: "file:///etc/passwd" });
    return res.end();
  }
  if (req.url === "/big-declared") {
    res.writeHead(200, { "content-type": "text/html", "content-length": String(5000) });
    return res.end("x".repeat(5000));
  }
  if (req.url === "/big-streamed") {
    res.writeHead(200, { "content-type": "text/html" }); // chunked, no length
    res.write("x".repeat(3000));
    return setTimeout(() => res.end("y".repeat(3000)), 10);
  }
  if (req.url === "/hang") return; // never answers
  res.writeHead(404, { "content-type": "text/html" });
  res.end("<h1>Not found</h1>");
}

let dir;
let app;
async function boot(fetchPage = {}) {
  app = await startServer({ distDir: path.join(dir, "dist"), binDir: path.join(dir, "bin"), port: 0, fetchPage });
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-page-"));
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "dist", "index.html"), "<html>app</html>");
  site.requests = [];
  site.route = defaultRoute;
});
afterEach(async () => {
  await new Promise((r) => app?.server.close(r));
  app = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

/* A request as the renderer makes it: same Host as the app, the app header. */
function get(target, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: app.port,
        path: `/api/fetch-page?url=${encodeURIComponent(target)}`,
        headers: { "x-nitroai-fetch": "1", "user-agent": "Mozilla/5.0 Chrome/140 Electron/43 NitroAI", ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          let json = null;
          if ((res.headers["content-type"] ?? "").includes("json")) json = JSON.parse(body.toString("utf8"));
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("GET /api/fetch-page", () => {
  it("downloads the page in Node and gives back its bytes and content type", async () => {
    await boot();
    const r = await get(`${site.url}/wiki/Photosynthesis`);
    expect(r.status).toBe(200);
    expect(r.headers["x-nitroai-page"]).toBe("1");
    expect(r.headers["x-nitroai-content-type"]).toBe("text/html; charset=UTF-8");
    expect(r.body.toString("utf8")).toBe(ARTICLE);
    // The renderer's own User-Agent goes to the site, as its fetch() would send.
    expect(site.requests[0].headers["user-agent"]).toBe("Mozilla/5.0 Chrome/140 Electron/43 NitroAI");
  });

  it("follows an http redirect and names the final URL", async () => {
    await boot();
    const r = await get(`${site.url}/moved`);
    expect(r.status).toBe(200);
    expect(r.headers["x-nitroai-final-url"]).toBe(`${site.url}/wiki/Photosynthesis`);
  });

  it("allows only http and https", async () => {
    await boot();
    for (const bad of ["file:///etc/passwd", "ftp://example.com/x", "javascript:alert(1)", "data:text/html,hi", "chrome://settings"]) {
      const r = await get(bad);
      expect(r.status, bad).toBe(400);
      expect(r.json.error, bad).toBe("bad_scheme");
    }
    expect((await get("not a url")).json.error).toBe("bad_url");
    expect(site.requests).toHaveLength(0);
  });

  it("does not follow a redirect to file://", async () => {
    await boot();
    const r = await get(`${site.url}/to-file`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.headers["x-nitroai-page"]).toBe("1");
    expect(r.body.toString("utf8")).not.toContain("root:");
  });

  it("stops at the download cap, declared or streamed (413 too_large)", async () => {
    const { MAX_PAGE_BYTES } = await import("./fetchPage.mjs");
    expect(MAX_PAGE_BYTES).toBe(8 * 1024 * 1024);
    await boot({ maxBytes: 4000 });
    for (const p of ["/big-declared", "/big-streamed"]) {
      const r = await get(`${site.url}${p}`);
      expect(r.status, p).toBe(413);
      expect(r.json, p).toEqual({ error: "too_large", limit: 4000 });
    }
  });

  it("an error page from the site is 502 with its status", async () => {
    await boot();
    const r = await get(`${site.url}/nowhere`);
    expect(r.status).toBe(502);
    expect(r.json).toEqual({ error: "status", status: 404 });
  });

  it("a site that cannot be reached, or does not answer, is said in words", async () => {
    const closed = net.createServer();
    await new Promise((r) => closed.listen(0, "127.0.0.1", r));
    const deadPort = closed.address().port;
    await new Promise((r) => closed.close(r));
    await boot({ timeoutMs: 300 });
    const refused = await get(`http://127.0.0.1:${deadPort}/`);
    expect(refused.status).toBe(502);
    expect(refused.json).toEqual({ error: "network", reason: "the site refused the connection" });
    const slow = await get(`${site.url}/hang`);
    expect(slow.status).toBe(504);
    expect(slow.json.error).toBe("timeout");
  });

  it("only the app can use it: a request without the app header, or with another Host, is 403", async () => {
    await boot();
    const noHeader = await get(`${site.url}/wiki/Photosynthesis`, { "x-nitroai-fetch": "" });
    expect(noHeader.status).toBe(403);
    // DNS rebinding: a page on evil.example whose name points at 127.0.0.1.
    const rebound = await get(`${site.url}/wiki/Photosynthesis`, { host: `evil.example:${app.port}` });
    expect(rebound.status).toBe(403);
    expect(site.requests).toHaveLength(0);
    expect((await get(`${site.url}/wiki/Photosynthesis`, { host: `localhost:${app.port}` })).status).toBe(200);
  });
});
