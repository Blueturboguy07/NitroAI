/* Round 6, item 1 (HIGH): /api/publik/* and /api/local/* had no Origin,
 * Host or custom-header check (v0.2.1 and v0.2.2). A web page on any site
 * could spend the user's balance, revoke the install, read the status and
 * the wallet (with a rebinding Host), and start an Ollama download.
 *
 * Each test below replays one request from the verifier's log
 * (verify-nitroai/sec/app-requests.log), with the same method, headers and
 * body type, against startServer() and a LOCAL FAKE GATEWAY. Each one fails
 * on 85f4a40 and passes with the guard (localGuard.mjs). The last block
 * shows that the app's own calls still work.
 *
 * Ollama and yt-dlp are stand-ins here (vi.mock), so no test downloads or
 * installs anything, before or after the fix. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const calls = vi.hoisted(() => ({ provision: 0, status: 0, extract: [] }));

vi.mock("./ollama.mjs", () => ({
  provision: async ({ emit }) => {
    calls.provision += 1;
    emit({ phase: "ready" });
    return { chat: "qwen2.5:3b", embed: "nomic-embed-text" };
  },
  status: async () => {
    calls.status += 1;
    return { installed: false, serving: false, hasChatModel: false, hasEmbedModel: false, models: [] };
  },
  ensureServingIfProvisioned: async () => false,
  shutdown: () => {},
}));
vi.mock("./ytdlp.mjs", () => ({
  extractYoutube: async (url) => {
    calls.extract.push(url);
    return { transcript: "captions", audioBase64: null, audioExt: null, title: "Video" };
  },
}));

const { startServer } = await import("./httpServer.mjs");

const TOKEN = "pat_nitroai_k3m9x2q7v5n8r4t6w1y0z2b5c8d1f4g7";
const KEY = "pk_live_a8k2m9x4q7v1_h3n6r9t2w5y8z1b4c7d0f3g6j9k2m5p8";

/* The fake gateway: mint, chat, wallet, models, revoke. Every hit is kept. */
const gateway = { server: null, url: "", hits: [] };
beforeAll(async () => {
  gateway.server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      gateway.hits.push({ method: req.method, url: req.url, body: raw });
      const json = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/installs") {
        return json(201, { install_id: JSON.parse(raw).install_id, key: KEY, base_url: gateway.url, models: { fast: "publik-fast" }, starter_micros: 0, balance_micros: 0 });
      }
      if (req.url === "/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream", "x-publik-balance": "248760" });
        return res.end('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n');
      }
      if (req.url === "/wallet") return json(200, { balance_micros: 181240, claim_state: "anonymous" });
      if (req.url === "/models") return json(200, { object: "list", data: [{ id: "publik-fast" }] });
      if (req.url === "/installs/revoke") {
        res.writeHead(204);
        return res.end();
      }
      json(404, { error: { type: "not_found" } });
    });
  });
  await new Promise((r) => gateway.server.listen(0, "127.0.0.1", r));
  gateway.url = `http://127.0.0.1:${gateway.server.address().port}`;
});
afterAll(() => gateway.server.close());

let dir;
let file;
let app;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-attacks-"));
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "dist", "index.html"), "<html>app</html>");
  file = path.join(dir, "publik", "apps", "nitroai.json");
  app = await startServer({
    distDir: path.join(dir, "dist"),
    binDir: path.join(dir, "bin"),
    port: 0,
    publik: { token: TOKEN, appVersion: "0.2.3", credentialFile: file, baseUrl: gateway.url },
  });
  calls.provision = 0;
  calls.status = 0;
  calls.extract = [];
});
afterEach(async () => {
  await new Promise((r) => app.server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

/* One raw HTTP request, with exactly these headers (Host too). */
function send({ method = "GET", path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: app.port, method, path: p, headers: { host: `127.0.0.1:${app.port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/* What the app's renderer sends (src/lib/localApi.ts), from its own origin. */
function own(method, p, body, extra = {}) {
  const origin = `http://127.0.0.1:${app.port}`;
  const headers = { "x-nitroai-app": "1", "sec-fetch-site": "same-origin", ...extra };
  if (method !== "GET" && method !== "HEAD") {
    headers.origin = origin;
    headers["content-type"] ??= "application/json";
  }
  return send({ method, path: p, headers, body: method === "GET" || method === "HEAD" ? undefined : (body ?? "{}") });
}

/* The verifier's hostile page: http://localhost:11996/hostile.html. */
const HOSTILE = { origin: "http://localhost:11996", referer: "http://localhost:11996/", "sec-fetch-site": "cross-site", "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140" };

async function provisioned() {
  const r = await own("POST", "/api/publik/provision", JSON.stringify({ disclosure_version: 1 }));
  expect(r.status).toBe(200);
  expect(fs.existsSync(file)).toBe(true);
  gateway.hits = [];
}

const gatewayHits = (url) => gateway.hits.filter((h) => !url || h.url === url);

describe("browser attacks from another site (verifier sec/ log) → 403, the gateway gets 0 hits", () => {
  it("no-cors POST /api/publik/chat with a text/plain JSON body does not spend the balance", async () => {
    await provisioned();
    const r = await send({
      method: "POST",
      path: "/api/publik/chat",
      headers: { ...HOSTILE, "sec-fetch-mode": "no-cors", "content-type": "text/plain" },
      body: JSON.stringify({ model: "publik-balanced", messages: [{ role: "user", content: "verifier csrf probe" }], max_tokens: 5 }),
    });
    expect(r.status).toBe(403);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    expect(gatewayHits()).toHaveLength(0);
  });

  it("no-cors POST /api/publik/disconnect does not revoke the install or delete the credential", async () => {
    await provisioned();
    const r = await send({
      method: "POST",
      path: "/api/publik/disconnect",
      headers: { ...HOSTILE, "sec-fetch-mode": "no-cors", "content-type": "text/plain;charset=UTF-8" },
      body: "",
    });
    expect(r.status).toBe(403);
    expect(gatewayHits()).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("no-cors POST /api/publik/forget does not delete the credential", async () => {
    await provisioned();
    const r = await send({ method: "POST", path: "/api/publik/forget", headers: { ...HOSTILE, "sec-fetch-mode": "no-cors", "content-type": "text/plain" }, body: "" });
    expect(r.status).toBe(403);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("no-cors POST /api/publik/provision does not mint an install", async () => {
    const r = await send({
      method: "POST",
      path: "/api/publik/provision",
      headers: { ...HOSTILE, "sec-fetch-mode": "no-cors", "content-type": "text/plain" },
      body: JSON.stringify({ disclosure_version: 1, force: true }),
    });
    expect(r.status).toBe(403);
    expect(gatewayHits()).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("a form POST (application/x-www-form-urlencoded) to /api/publik/chat is refused", async () => {
    await provisioned();
    const r = await send({ method: "POST", path: "/api/publik/chat", headers: { ...HOSTILE, "sec-fetch-mode": "navigate", "content-type": "application/x-www-form-urlencoded" }, body: "a=b" });
    expect(r.status).toBe(403);
    expect(gatewayHits()).toHaveLength(0);
  });

  it("cors GET /api/publik/wallet does not call the gateway", async () => {
    await provisioned();
    const r = await send({ path: "/api/publik/wallet", headers: { ...HOSTILE, "sec-fetch-mode": "cors" } });
    expect(r.status).toBe(403);
    expect(r.text).not.toContain("balance_micros");
    expect(gatewayHits()).toHaveLength(0);
  });

  it("a CORS preflight (OPTIONS) is never approved, and is not sent on as a POST", async () => {
    await provisioned();
    for (const p of ["/api/publik/chat", "/api/publik/disconnect", "/api/publik/wallet", "/api/local/setup"]) {
      const r = await send({
        method: "OPTIONS",
        path: p,
        headers: { ...HOSTILE, "sec-fetch-mode": "cors", "access-control-request-method": "POST", "access-control-request-headers": "x-nitroai-app,content-type" },
      });
      expect(r.status, p).toBe(403);
      expect(r.headers["access-control-allow-origin"], p).toBeUndefined();
      expect(r.headers["access-control-allow-headers"], p).toBeUndefined();
    }
    expect(gatewayHits()).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(true);
    expect(calls.provision).toBe(0);
  });

  it("an <img> GET /api/local/status (no Origin, cross-site) is refused", async () => {
    const r = await send({ path: "/api/local/status?probe=img", headers: { referer: HOSTILE.referer, "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" } });
    expect(r.status).toBe(403);
    expect(calls.status).toBe(0);
  });

  it("a GET /api/local/setup (an <img> or a link) does not start the Ollama download", async () => {
    const r = await send({ path: "/api/local/setup", headers: { referer: HOSTILE.referer, "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" } });
    expect(r.status).toBe(403);
    // Even the app itself cannot start it with a GET: GET makes no state change.
    const own1 = await own("GET", "/api/local/setup");
    expect(own1.status).toBe(405);
    expect(calls.provision).toBe(0);
  });

  it("a cross-site POST /api/local/setup does not start the Ollama download", async () => {
    const r = await send({ method: "POST", path: "/api/local/setup", headers: { ...HOSTILE, "sec-fetch-mode": "no-cors", "content-type": "text/plain" }, body: "{}" });
    expect(r.status).toBe(403);
    expect(calls.provision).toBe(0);
  });

  it("a GET or cross-site POST /api/youtube-extract does not run yt-dlp", async () => {
    const link = encodeURIComponent("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect((await send({ path: `/api/youtube-extract?url=${link}`, headers: { referer: HOSTILE.referer, "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" } })).status).toBe(403);
    expect((await send({ method: "POST", path: "/api/youtube-extract", headers: { ...HOSTILE, "content-type": "text/plain" }, body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }) })).status).toBe(403);
    expect(calls.extract).toEqual([]);
  });

  it("Sec-Fetch-Site same-site, or an Origin that is not the app, is refused even with the app header", async () => {
    await provisioned();
    const sameSite = await send({ method: "POST", path: "/api/publik/chat", headers: { "x-nitroai-app": "1", "sec-fetch-site": "same-site", "content-type": "application/json" }, body: "{}" });
    expect(sameSite.status).toBe(403);
    const otherOrigin = await send({ method: "POST", path: "/api/publik/chat", headers: { "x-nitroai-app": "1", origin: "http://localhost:11996", "content-type": "application/json" }, body: "{}" });
    expect(otherOrigin.status).toBe(403);
    const nullOrigin = await send({ method: "POST", path: "/api/publik/chat", headers: { "x-nitroai-app": "1", origin: "null", "content-type": "application/json" }, body: "{}" });
    expect(nullOrigin.status).toBe(403);
    expect(gatewayHits()).toHaveLength(0);
  });

  it("a HEAD to /api/publik/chat is not sent on to the gateway as a POST", async () => {
    await provisioned();
    const r = await send({ method: "HEAD", path: "/api/publik/chat", headers: { ...HOSTILE } });
    expect(r.status).toBe(403);
    // Not even from the app: only GET and POST reach the gateway.
    expect((await own("HEAD", "/api/publik/chat")).status).toBe(404);
    expect(gatewayHits()).toHaveLength(0);
  });
});

describe("DNS rebinding (Host evil.example:<port>) → 403, nothing to read, 0 gateway hits", () => {
  it("GET /api/publik/status cannot be read", async () => {
    await provisioned();
    const port = app.port;
    const r = await send({ path: "/api/publik/status", headers: { host: `evil.example:${port}`, origin: `http://evil.example:${port}` } });
    expect(r.status).toBe(403);
    expect(r.text).not.toContain("installId");
    expect(r.text).not.toContain("claimUrl");
  });

  it("GET /api/publik/wallet cannot be read", async () => {
    await provisioned();
    const port = app.port;
    const r = await send({ path: "/api/publik/wallet", headers: { host: `evil.example:${port}`, origin: `http://evil.example:${port}` } });
    expect(r.status).toBe(403);
    expect(r.text).not.toContain("balance_micros");
    expect(gatewayHits()).toHaveLength(0);
  });

  it("POST /api/publik/chat (application/json, same-origin to the rebound name) does not spend the balance", async () => {
    await provisioned();
    const port = app.port;
    // On a rebound name the page IS same-origin, so it can send any header.
    const r = await send({
      method: "POST",
      path: "/api/publik/chat",
      headers: { host: `evil.example:${port}`, origin: `http://evil.example:${port}`, "sec-fetch-site": "same-origin", "x-nitroai-app": "1", "content-type": "application/json" },
      body: JSON.stringify({ model: "publik-fast", messages: [{ role: "user", content: "rebind probe" }] }),
    });
    expect(r.status).toBe(403);
    expect(gatewayHits()).toHaveLength(0);
  });

  it("POST /api/publik/disconnect on a rebound name keeps the install", async () => {
    await provisioned();
    const port = app.port;
    const r = await send({
      method: "POST",
      path: "/api/publik/disconnect",
      headers: { host: `evil.example:${port}`, origin: `http://evil.example:${port}`, "x-nitroai-app": "1", "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(403);
    expect(gatewayHits()).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("a Host with the right name but another port, or no Host, is refused", async () => {
    await provisioned();
    expect((await send({ path: "/api/publik/status", headers: { host: `127.0.0.1:${app.port + 1}`, "x-nitroai-app": "1" } })).status).toBe(403);
    expect((await send({ path: "/api/publik/status", headers: { host: "127.0.0.1", "x-nitroai-app": "1" } })).status).toBe(403);
    expect((await send({ path: "/api/publik/status", headers: { host: `127.0.0.1.evil.example:${app.port}`, "x-nitroai-app": "1" } })).status).toBe(403);
  });
});

describe("the app's own calls still work (positive)", () => {
  it("health, status, provision, wallet, models, chat, forget and disconnect", async () => {
    expect(JSON.parse((await own("GET", "/api/health")).text)).toEqual({ ok: true, service: "nitroai" });
    expect(JSON.parse((await own("GET", "/api/publik/status")).text)).toMatchObject({ available: true, state: "unprovisioned" });
    const minted = JSON.parse((await own("POST", "/api/publik/provision", JSON.stringify({ disclosure_version: 1 }))).text);
    expect(minted).toMatchObject({ ok: true, minted: true, state: "ready" });
    expect(JSON.parse((await own("GET", "/api/publik/wallet")).text)).toMatchObject({ balance_micros: 181240 });
    expect((await own("GET", "/api/publik/v1/models")).status).toBe(200);
    const chat = await own("POST", "/api/publik/chat", JSON.stringify({ messages: [{ role: "user", content: "hi" }] }));
    expect(chat.status).toBe(200);
    expect(chat.text).toContain("Hello");
    expect(gatewayHits("/chat/completions")).toHaveLength(1);
    // Disconnect: the app sends "{}" as JSON (localFetch).
    const off = JSON.parse((await own("POST", "/api/publik/disconnect")).text);
    expect(off).toMatchObject({ ok: true, state: "unprovisioned" });
    expect(gatewayHits("/installs/revoke")).toHaveLength(1);
    expect(fs.existsSync(file)).toBe(false);
    await own("POST", "/api/publik/provision", JSON.stringify({ disclosure_version: 1 }));
    expect(JSON.parse((await own("POST", "/api/publik/forget")).text)).toMatchObject({ ok: true, state: "unprovisioned" });
  });

  it("the audio upload (multipart/form-data) still reaches the gateway", async () => {
    await provisioned();
    const boundary = "----nitroai";
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`;
    const r = await own("POST", "/api/publik/v1/audio/transcriptions", body, { "content-type": `multipart/form-data; boundary=${boundary}` });
    expect(r.status).toBe(404); // the fake gateway has no transcription route; the proxy sent it on
    expect(gatewayHits("/audio/transcriptions")).toHaveLength(1);
    // multipart is allowed for that one path only.
    const chat = await own("POST", "/api/publik/chat", body, { "content-type": `multipart/form-data; boundary=${boundary}` });
    expect(chat.status).toBe(403);
  });

  it("from localhost:<port> too (Settings in a browser via `npm run serve`)", async () => {
    const r = await send({ path: "/api/publik/status", headers: { host: `localhost:${app.port}`, "x-nitroai-app": "1", "sec-fetch-site": "same-origin" } });
    expect(r.status).toBe(200);
  });

  it("local status and setup (POST, JSON models in the body) and youtube-extract (POST JSON)", async () => {
    expect(JSON.parse((await own("GET", "/api/local/status")).text)).toMatchObject({ installed: false });
    const setup = await own("POST", "/api/local/setup", JSON.stringify({ chatModel: "llama3.1:8b" }));
    expect(setup.status).toBe(200);
    expect(setup.text).toContain('"phase":"done"');
    expect(calls.provision).toBe(1);
    const yt = await own("POST", "/api/youtube-extract", JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }));
    expect(JSON.parse(yt.text)).toMatchObject({ transcript: "captions" });
    expect(calls.extract).toEqual(["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
  });

  it("youtube-extract never hands yt-dlp an option: only an http(s) link", async () => {
    for (const bad of ["--exec=touch /tmp/pwned", "-o/tmp/x", "file:///etc/passwd", "javascript:alert(1)"]) {
      const r = await own("POST", "/api/youtube-extract", JSON.stringify({ url: bad }));
      expect(r.status, bad).toBe(400);
    }
    expect(calls.extract).toEqual([]);
  });

  it("the static app (not /api) needs no header", async () => {
    const r = await send({ path: "/", headers: {} });
    expect(r.status).toBe(200);
    expect(r.text).toContain("app");
  });
});
