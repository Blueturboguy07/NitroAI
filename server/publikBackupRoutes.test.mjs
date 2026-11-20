/* The library backup routes (/api/publik/backup, /api/publik/backup/data)
 * sit behind the same guard as every /api/* route (localGuard.mjs) and use
 * the same credential rule as /api/publik/chat: the install key, and only
 * when the person's choice is "publik".
 *
 * Same method as attacks.test.mjs: raw HTTP requests against startServer()
 * and a LOCAL FAKE GATEWAY that follows the publik Files API contract. No
 * request leaves this computer. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

vi.mock("./ollama.mjs", () => ({
  provision: async () => ({}),
  status: async () => ({ installed: false, serving: false, hasChatModel: false, hasEmbedModel: false, models: [] }),
  ensureServingIfProvisioned: async () => false,
  shutdown: () => {},
}));
vi.mock("./ytdlp.mjs", () => ({ cleanOldYtdlp: () => [], extractYoutube: async () => ({}) }));

const TOKEN = "pat_nitroai_k3m9x2q7v5n8r4t6w1y0z2b5c8d1f4g7";
const KEY = "pk_live_a8k2m9x4q7v1_h3n6r9t2w5y8z1b4c7d0f3g6j9k2m5p8";

const ENV_KEYS = ["PUBLIK_ORIGIN", "PUBLIK_APP_TOKEN", "PUBLIK_API_KEY", "PUBLIK_API_BASE_URL", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "LOCALAPPDATA"];
const savedEnv = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

/* The fake gateway: mint, the Files API, and the storage (upload/download). */
const gateway = { server: null, url: "", hits: [], files: [], blobs: new Map(), seq: 0 };
gateway.server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    gateway.hits.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, bytes: raw.length });
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const u = new URL(req.url, gateway.url);
    if (u.pathname === "/api/v1/installs") {
      return json(201, { install_id: JSON.parse(raw.toString("utf8")).install_id, key: KEY, base_url: gateway.url, claim_state: "claimed" });
    }
    if (u.pathname.startsWith("/storage/")) {
      const id = u.pathname.split("/").pop();
      if (req.method === "PUT") {
        gateway.blobs.set(id, raw);
        res.writeHead(200);
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(gateway.blobs.get(id));
    }
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: { type: "invalid_api_key", message: "bad key" } });
    if (req.method === "POST" && u.pathname === "/files") {
      const b = JSON.parse(raw.toString("utf8"));
      const id = `file_${++gateway.seq}`;
      gateway.files.push({ id, status: "pending", filename: b.filename, bytes: b.bytes, content_type: b.content_type, kept: true, path: b.path, created_at: new Date(Date.UTC(2026, 10, 20, 10, 0, gateway.seq)).toISOString() });
      return json(201, { id, status: "pending", upload_url: `${gateway.url}/storage/${id}?sig=UPLOADSIG`, method: "PUT", kept: true, path: b.path });
    }
    if (req.method === "GET" && u.pathname === "/files") {
      const data = gateway.files.filter((f) => f.status === "ready").sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      return json(200, { object: "list", data, used_bytes: 0, quota_bytes: 1073741824 });
    }
    const m = /^\/files\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const f = gateway.files.find((x) => x.id === m[1]);
      if (!f) return json(404, { error: { type: "not_found", message: "no such file" } });
      if (req.method === "DELETE") {
        f.status = "deleted";
        return json(200, { id: f.id, deleted: true });
      }
      if (f.status === "pending" && gateway.blobs.has(f.id)) f.status = "ready";
      return json(200, { id: f.id, status: f.status, bytes: f.bytes, kept: true, path: f.path, created_at: f.created_at, expires_at: null, ...(f.status === "ready" ? { download_url: `${gateway.url}/storage/${f.id}?sig=DOWNLOADSIG` } : {}) });
    }
    json(404, { error: { type: "not_found" } });
  });
});
await new Promise((r) => gateway.server.listen(0, "127.0.0.1", r));
gateway.url = `http://127.0.0.1:${gateway.server.address().port}`;
process.env.PUBLIK_ORIGIN = gateway.url;
process.env.PUBLIK_APP_TOKEN = TOKEN;
delete process.env.PUBLIK_API_KEY;
delete process.env.PUBLIK_API_BASE_URL;

const { startServer } = await import("./httpServer.mjs");
const { readCredential } = await import("./publik.mjs");
const { MAX_UPSTREAM_BODY } = await import("./publikProxy.mjs");

afterAll(() => {
  gateway.server.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

let dir;
let app;
let logged;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-backup-"));
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "dist", "index.html"), "<html>app</html>");
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.XDG_CONFIG_HOME = path.join(dir, ".config");
  process.env.LOCALAPPDATA = path.join(dir, "AppData", "Local");
  gateway.files = [];
  gateway.blobs = new Map();
  gateway.seq = 0;
  // Everything the server process prints, to prove that no secret is logged.
  logged = [];
  for (const m of ["log", "info", "warn", "error", "debug"]) vi.spyOn(console, m).mockImplementation((...a) => void logged.push(a.map(String).join(" ")));
  app = await startServer({ distDir: path.join(dir, "dist"), binDir: path.join(dir, "bin"), port: 0, publik: { backup: { readyDelayMs: 1 } } });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((r) => app.server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

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
function own(method, p, body) {
  const headers = { "x-nitroai-app": "1", "sec-fetch-site": "same-origin" };
  if (method !== "GET") {
    headers.origin = `http://127.0.0.1:${app.port}`;
    headers["content-type"] = "application/json";
  }
  return send({ method, path: p, headers, body: method === "GET" ? undefined : (body ?? "{}") });
}

const HOSTILE = { origin: "http://localhost:11996", referer: "http://localhost:11996/", "sec-fetch-site": "cross-site" };
const snapshot = (notes = [{ id: "n1", title: "Cells" }]) => JSON.stringify({ format: "nitroai-library", version: 1, madeAt: "2026-11-20T10:00:00.000Z", collections: { notes, folders: [], flashcards: [], quiz: [], attempts: [], chat: [], podcasts: [] } });

async function chosePublik() {
  const r = await own("POST", "/api/publik/provision", JSON.stringify({ disclosure_version: 1 }));
  expect(r.status).toBe(200);
  expect(readCredential()).toMatchObject({ key: KEY, choice: "publik" });
  gateway.hits = [];
}

const ROUTES = [
  ["GET", "/api/publik/backup"],
  ["POST", "/api/publik/backup"],
  ["GET", "/api/publik/backup/data"],
];

describe("the backup routes sit behind the local guard → 403, the gateway gets 0 hits", () => {
  it("a page on another site (cross-site, no app header) cannot read, write or download the backup", async () => {
    await chosePublik();
    await own("POST", "/api/publik/backup", snapshot());
    gateway.hits = [];
    for (const [method, p] of ROUTES) {
      const r = await send({ method, path: p, headers: { ...HOSTILE, "sec-fetch-mode": "no-cors", ...(method === "POST" ? { "content-type": "text/plain" } : {}) }, body: method === "POST" ? snapshot() : undefined });
      expect(r.status, `${method} ${p}`).toBe(403);
      expect(r.headers["access-control-allow-origin"], p).toBeUndefined();
      expect(r.text).not.toContain("Cells");
      expect(r.text).not.toContain("file_");
    }
    expect(gateway.hits).toHaveLength(0);
    expect(gateway.files.filter((f) => f.status === "ready")).toHaveLength(1);
  });

  it("no app header, a foreign Origin, Sec-Fetch-Site same-site, or a text/plain body is refused", async () => {
    await chosePublik();
    const origin = `http://127.0.0.1:${app.port}`;
    for (const [method, p] of ROUTES) {
      const body = method === "POST" ? snapshot() : undefined;
      const type = method === "POST" ? { "content-type": "application/json" } : {};
      expect((await send({ method, path: p, headers: { origin, ...type }, body })).status, `${p} no app header`).toBe(403);
      expect((await send({ method, path: p, headers: { "x-nitroai-app": "1", origin: "http://localhost:11996", ...type }, body })).status, `${p} foreign origin`).toBe(403);
      expect((await send({ method, path: p, headers: { "x-nitroai-app": "1", origin: "null", ...type }, body })).status, `${p} null origin`).toBe(403);
      expect((await send({ method, path: p, headers: { "x-nitroai-app": "1", "sec-fetch-site": "same-site", ...type }, body })).status, `${p} same-site`).toBe(403);
    }
    expect((await send({ method: "POST", path: "/api/publik/backup", headers: { "x-nitroai-app": "1", origin, "content-type": "text/plain" }, body: snapshot() })).status).toBe(403);
    expect(gateway.hits).toHaveLength(0);
  });

  it("DNS rebinding (Host evil.example:<port>) and a CORS preflight are refused", async () => {
    await chosePublik();
    for (const [method, p] of ROUTES) {
      const evil = await send({ method, path: p, headers: { host: `evil.example:${app.port}`, origin: `http://evil.example:${app.port}`, "x-nitroai-app": "1", "content-type": "application/json" }, body: method === "POST" ? snapshot() : undefined });
      expect(evil.status, `${p} rebinding`).toBe(403);
      const pre = await send({ method: "OPTIONS", path: p, headers: { ...HOSTILE, "access-control-request-method": method, "access-control-request-headers": "x-nitroai-app,content-type" } });
      expect(pre.status, `${p} preflight`).toBe(403);
      expect(pre.headers["access-control-allow-headers"]).toBeUndefined();
    }
    expect(gateway.hits).toHaveLength(0);
  });
});

describe("the credential rule: only when the person's choice is publik", () => {
  it("no credential at all: available false, no write, no download, 0 gateway hits", async () => {
    gateway.hits = [];
    expect(JSON.parse((await own("GET", "/api/publik/backup")).text)).toEqual({ available: false, exists: false, id: null, bytes: null, created_at: null });
    expect((await own("POST", "/api/publik/backup", snapshot())).status).toBe(401);
    expect((await own("GET", "/api/publik/backup/data")).status).toBe(401);
    expect(gateway.hits).toHaveLength(0);
  });

  it("choice \"own_key\": the install key is on disk, and the backup routes do not use it", async () => {
    await chosePublik();
    await own("POST", "/api/publik/forget");
    expect(readCredential()).toMatchObject({ key: KEY, choice: "own_key" });
    gateway.hits = [];
    expect(JSON.parse((await own("GET", "/api/publik/backup")).text)).toMatchObject({ available: false, exists: false });
    const post = await own("POST", "/api/publik/backup", snapshot());
    expect(post.status).toBe(401);
    expect(JSON.parse(post.text).error.type).toBe("no_publik_credential");
    expect((await own("GET", "/api/publik/backup/data")).status).toBe(401);
    expect(gateway.hits).toHaveLength(0);
  });

  it("a pk_ key pasted in a request header does not open the backup routes", async () => {
    gateway.hits = [];
    const r = await send({ path: "/api/publik/backup", headers: { "x-nitroai-app": "1", authorization: `Bearer ${KEY}` } });
    expect(JSON.parse(r.text)).toMatchObject({ available: false });
    expect(gateway.hits).toHaveLength(0);
  });
});

describe("the app's own backup calls (positive)", () => {
  it("save, look, download, save again: the new backup replaces the old one", async () => {
    await chosePublik();
    expect(JSON.parse((await own("GET", "/api/publik/backup")).text)).toEqual({ available: true, exists: false, id: null, bytes: null, created_at: null });
    expect((await own("GET", "/api/publik/backup/data")).status).toBe(404);

    const first = snapshot();
    const saved = await own("POST", "/api/publik/backup", first);
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.text)).toMatchObject({ id: "file_1", bytes: Buffer.byteLength(first), charge_micros: 13000 });
    expect(JSON.parse((await own("GET", "/api/publik/backup")).text)).toMatchObject({ available: true, exists: true, id: "file_1", bytes: Buffer.byteLength(first) });

    const data = await own("GET", "/api/publik/backup/data");
    expect(data.status).toBe(200);
    expect(data.headers["content-type"]).toBe("application/json");
    expect(data.text).toBe(first);

    const second = snapshot([{ id: "n1", title: "Cells" }, { id: "n2", title: "Genes" }]);
    expect(JSON.parse((await own("POST", "/api/publik/backup", second)).text)).toMatchObject({ id: "file_2", deleted_old: 1 });
    expect(gateway.files.map((f) => `${f.id}:${f.status}`)).toEqual(["file_1:deleted", "file_2:ready"]);
    expect((await own("GET", "/api/publik/backup/data")).text).toBe(second);

    // The storage calls carry no publik key; the publik calls do.
    for (const h of gateway.hits) {
      if (h.url.startsWith("/storage/")) expect(h.auth).toBeNull();
      else expect(h.auth).toBe(`Bearer ${KEY}`);
    }
  });

  it("a snapshot over the 4 MB gateway limit is accepted on this route; the gateway limit itself did not change", async () => {
    await chosePublik();
    expect(MAX_UPSTREAM_BODY).toBe(4 * 1024 * 1024);
    const big = snapshot([{ id: "n1", title: "Cells", sourceText: "x".repeat(5 * 1024 * 1024) }]);
    const saved = await own("POST", "/api/publik/backup", big);
    expect(saved.status).toBe(200);
    expect(JSON.parse(saved.text).bytes).toBe(Buffer.byteLength(big));
    expect(gateway.blobs.get("file_1").length).toBe(Buffer.byteLength(big));
  });

  it("a body that is not a NitroAI snapshot is refused with 400; nothing goes to publik", async () => {
    await chosePublik();
    for (const body of ["{}", "not json", JSON.stringify({ format: "other", collections: {} }), JSON.stringify([1, 2])]) {
      const r = await own("POST", "/api/publik/backup", body);
      expect(r.status, body).toBe(400);
      expect(JSON.parse(r.text).error.type).toBe("bad_snapshot");
    }
    expect(gateway.hits).toHaveLength(0);
  });

  it("a publik error keeps its type and status, and the earlier backup stays", async () => {
    await chosePublik();
    await own("POST", "/api/publik/backup", snapshot());
    // The next new file is refused: storage full.
    const realFiles = gateway.files;
    const handler = gateway.server.listeners("request")[0];
    gateway.server.removeAllListeners("request");
    gateway.server.on("request", (req, res) => {
      if (req.method === "POST" && req.url === "/files") {
        req.resume();
        res.writeHead(413, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { type: "storage_quota_exceeded", message: "Storage is full.", quota_bytes: 1073741824, used_bytes: 1073741824 } }));
      }
      handler(req, res);
    });
    try {
      const r = await own("POST", "/api/publik/backup", snapshot([{ id: "n9" }]));
      expect(r.status).toBe(413);
      expect(JSON.parse(r.text)).toEqual({ error: { type: "storage_quota_exceeded", message: "Storage is full.", quota_bytes: 1073741824, used_bytes: 1073741824 } });
      expect(realFiles.map((f) => `${f.id}:${f.status}`)).toEqual(["file_1:ready"]);
    } finally {
      gateway.server.removeAllListeners("request");
      gateway.server.on("request", handler);
    }
  });

  it("no answer and no log line carries the key, the upload_url or the download_url", async () => {
    await chosePublik();
    const texts = [];
    texts.push((await own("POST", "/api/publik/backup", snapshot())).text);
    texts.push((await own("GET", "/api/publik/backup")).text);
    texts.push((await own("POST", "/api/publik/backup", snapshot([{ id: "n2" }]))).text);
    const all = [...texts, ...logged].join("\n");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("UPLOADSIG");
    expect(all).not.toContain("DOWNLOADSIG");
    expect(all).not.toContain("/storage/");
    expect(logged).toEqual([]);
  });
});
