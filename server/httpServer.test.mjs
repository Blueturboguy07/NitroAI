/* The local server end to end: startServer() on a temp dist/, the publik
 * routes, and the streaming proxy against a LOCAL FAKE GATEWAY. Also a
 * regression guard that unknown /api/x is still 404 and that the stable-port
 * fallback works.
 *
 * The publik module (publik.mjs) owns the credential. PUBLIK_ORIGIN points
 * it at the fake gateway (POST /api/v1/installs, GET /api/v1/wallet) and
 * HOME / XDG_CONFIG_HOME / LOCALAPPDATA point its credential file at a temp
 * folder. The module reads PUBLIK_ORIGIN at load, so the server and the
 * module are imported after the fake gateway listens. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const TOKEN = "pat_nitroai_k3m9x2q7v5n8r4t6w1y0z2b5c8d1f4g7";
const KEY = "pk_live_a8k2m9x4q7v1_h3n6r9t2w5y8z1b4c7d0f3g6j9k2m5p8";
const KEY2 = "pk_live_b9l3n0y5r8w2_i4o7s0u3x6z9a2c5d8e1f4g7h0j3k6l9";
const USER_KEY = "pk_test_c0m4o1z6s9x3_j5p8t1v4y7a0b3d6e9f2g5h8i1k4l7m0";
const CLAIM_URL = "https://publikhq.com/claim/HK7F-2QWD";

const ENV_KEYS = ["PUBLIK_ORIGIN", "PUBLIK_APP_TOKEN", "PUBLIK_API_KEY", "PUBLIK_API_BASE_URL", "DO_NOT_TRACK", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "LOCALAPPDATA"];
const savedEnv = {};

const gateway = { server: null, url: "", requests: [], route: null };
let startServer; // ./httpServer.mjs
let readCredential; // ./publik.mjs
let credentialPath;
let DISCLOSURE_VERSION; // ./publikProxy.mjs

function sse(lines) {
  return lines.map((l) => `data: ${typeof l === "string" ? l : JSON.stringify(l)}\n\n`).join("");
}

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  gateway.server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      gateway.requests.push({ method: req.method, url: req.url, headers: req.headers, raw, text: raw.toString("utf8") });
      gateway.route(req, res, raw);
    });
  });
  await new Promise((r) => gateway.server.listen(0, "127.0.0.1", r));
  gateway.url = `http://127.0.0.1:${gateway.server.address().port}`;

  process.env.PUBLIK_ORIGIN = gateway.url;
  process.env.PUBLIK_APP_TOKEN = TOKEN;
  delete process.env.PUBLIK_API_KEY;
  delete process.env.PUBLIK_API_BASE_URL;
  ({ startServer } = await import("./httpServer.mjs"));
  ({ readCredential, credentialPath } = await import("./publik.mjs"));
  ({ DISCLOSURE_VERSION } = await import("./publikProxy.mjs"));
});
afterAll(() => {
  gateway.server.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/* Default gateway behaviour: mint on /api/v1/installs (the module's call),
   answer /api/v1/wallet, stream two tokens on chat with the contract's
   x-publik-* headers, echo on everything else. The install answers with
   base_url = this gateway, so the proxy sends AI calls here too. */
function defaultRoute(req, res, raw) {
  if (req.url === "/api/v1/installs") {
    const body = JSON.parse(raw.toString("utf8"));
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ install_id: body.install_id, key: KEY, base_url: gateway.url, claim_url: CLAIM_URL, claim_state: "anonymous" }));
    return;
  }
  if (req.url === "/api/v1/wallet") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ balance_micros: 181240, claim_state: "anonymous", claim_url: CLAIM_URL, plan: { kind: "none", label: null } }));
    return;
  }
  if (req.url === "/chat/completions") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "x-publik-model": "gpt-5.6-luna",
      "x-publik-balance": "248760",
      "x-publik-reserved-micros": "1240",
      "x-publik-claim-state": "anonymous",
      "x-publik-request-id": "req_1",
      "x-secret-internal": "must-not-pass",
    });
    res.write(sse([{ choices: [{ delta: { content: "Hello" } }] }]));
    setTimeout(() => {
      res.write(sse([{ choices: [{ delta: { content: " world" } }] }, "[DONE]"]));
      res.end();
    }, 20);
    return;
  }
  if (req.url === "/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "publik-fast" }] }));
    return;
  }
  if (req.url === "/audio/transcriptions" || req.url === "/embeddings" || req.url === "/audio/speech") {
    res.writeHead(200, { "content-type": "application/json", "x-publik-charge-micros": "150" });
    res.end(JSON.stringify({ echoed_bytes: raw.length, content_type: req.headers["content-type"] ?? null }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { type: "not_found" } }));
}

let dir;
let app;
let base;
const file = () => credentialPath();
const installs = () => gateway.requests.filter((r) => r.url === "/api/v1/installs");

/* What the renderer sends (src/lib/localApi.ts): the app-only header, and
   a JSON content type on a body that is not FormData. The guard
   (localGuard.mjs) refuses a request without them. */
function api(url, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-nitroai-app", "1");
  const method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  if (method !== "GET" && method !== "HEAD") {
    if (body === undefined) body = "{}";
    if (!(body instanceof FormData) && !headers.has("content-type")) headers.set("content-type", "application/json");
  }
  return fetch(url, { ...init, method, headers, body });
}

async function boot(publik = {}) {
  app = await startServer({
    distDir: path.join(dir, "dist"),
    binDir: path.join(dir, "bin"),
    port: 0,
    publik: { appVersion: "0.2.0", ...publik },
  });
  base = app.url;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-server-"));
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "dist", "index.html"), "<html>app</html>");
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.XDG_CONFIG_HOME = path.join(dir, ".config");
  process.env.LOCALAPPDATA = path.join(dir, "AppData", "Local");
  process.env.PUBLIK_APP_TOKEN = TOKEN;
  delete process.env.PUBLIK_API_KEY;
  delete process.env.PUBLIK_API_BASE_URL;
  gateway.requests = [];
  gateway.route = defaultRoute;
});
afterEach(async () => {
  await new Promise((r) => app?.server.close(r));
  app = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("publik routes", () => {
  it("status → unprovisioned but available when a token exists; never available without one", async () => {
    await boot();
    const s = await (await api(`${base}/api/publik/status`)).json();
    expect(s).toMatchObject({ available: true, state: "unprovisioned", baseUrl: "/api/publik/v1", disclosureVersion: DISCLOSURE_VERSION });
    await new Promise((r) => app.server.close(r));
    delete process.env.PUBLIK_APP_TOKEN;
    await boot();
    const s2 = await (await api(`${base}/api/publik/status`)).json();
    expect(s2).toMatchObject({ available: false, state: "unprovisioned" });
  });

  it("nothing is minted on status/boot; provision stores the choice (and mints only when the gate did not)", async () => {
    await boot();
    await api(`${base}/api/publik/status`);
    await api(`${base}/api/publik/wallet`);
    expect(installs()).toHaveLength(0);
    expect(fs.existsSync(file())).toBe(false);

    const res = await api(`${base}/api/publik/provision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disclosure_version: DISCLOSURE_VERSION }),
    });
    const s = await res.json();
    expect(s).toMatchObject({ ok: true, minted: true, state: "ready", source: "file", claimUrl: CLAIM_URL });
    expect(JSON.stringify(s)).not.toContain("pk_");
    expect(readCredential()).toMatchObject({ key: KEY, choice: "publik" });
    expect(JSON.parse(installs()[0].text)).toMatchObject({ app_token: TOKEN, app_slug: "nitroai" });
    expect(installs()[0].headers.authorization).toBeUndefined();

    // Signed in by the gate, answer changed in Settings: no new install.
    const again = await (await api(`${base}/api/publik/provision`, { method: "POST" })).json();
    expect(again).toMatchObject({ ok: true, minted: false, state: "ready" });
    expect(installs()).toHaveLength(1);
  });

  it("provision without a token answers 200 {ok:false} with the module's reason", async () => {
    delete process.env.PUBLIK_APP_TOKEN;
    await boot();
    const s = await (await api(`${base}/api/publik/provision`, { method: "POST" })).json();
    expect(s).toMatchObject({ ok: false, minted: false, available: false, state: "unprovisioned" });
    expect(s.reason).toMatch(/no publik app token/);
    expect(gateway.requests).toHaveLength(0);
  });

  it("proxy: chat streams through with the key attached and x-publik-* headers exposed", async () => {
    await boot();
    await api(`${base}/api/publik/provision`, { method: "POST" });
    const res = await api(`${base}/api/publik/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "publik-fast", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-publik-balance")).toBe("248760");
    expect(res.headers.get("x-publik-reserved-micros")).toBe("1240");
    expect(res.headers.get("x-publik-claim-state")).toBe("anonymous");
    expect(res.headers.get("x-secret-internal")).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"Hello"');
    expect(text).toContain("[DONE]");
    const up = gateway.requests.find((r) => r.url === "/chat/completions");
    expect(up.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(up.text).model).toBe("publik-fast");
  });

  it("proxy: /api/publik/v1/<path> covers transcription (multipart), speech, embeddings, models; others 404", async () => {
    await boot();
    await api(`${base}/api/publik/provision`, { method: "POST" });
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(1000)]), "chunk.wav");
    form.append("model", "whisper-1");
    const t = await api(`${base}/api/publik/v1/audio/transcriptions`, { method: "POST", body: form });
    expect(t.status).toBe(200);
    expect(t.headers.get("x-publik-charge-micros")).toBe("150");
    const tb = await t.json();
    expect(tb.content_type).toMatch(/^multipart\/form-data; boundary=/);
    expect(tb.echoed_bytes).toBeGreaterThan(1000);

    expect((await api(`${base}/api/publik/v1/embeddings`, { method: "POST", body: "{}" })).status).toBe(200);
    expect((await api(`${base}/api/publik/v1/audio/speech`, { method: "POST", body: "{}" })).status).toBe(200);
    expect((await api(`${base}/api/publik/v1/models`)).status).toBe(200);
    expect((await api(`${base}/api/publik/v1/installs`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await api(`${base}/api/publik/v1/wallet`)).status).toBe(404);
    expect((await api(`${base}/api/publik/v1/chat/completions`)).status).toBe(404); // GET not allowed
  });

  it("proxy: without a credential answers 401 no_publik_credential and never calls the gateway", async () => {
    await boot();
    const res = await api(`${base}/api/publik/chat`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect((await res.json()).error.type).toBe("no_publik_credential");
    expect(gateway.requests).toHaveLength(0);
  });

  it("proxy: a user-pasted pk_ key in Authorization is used instead of the machine credential", async () => {
    await boot();
    await api(`${base}/api/publik/provision`, { method: "POST" });
    await api(`${base}/api/publik/chat`, { method: "POST", headers: { authorization: `Bearer ${USER_KEY}` }, body: "{}" });
    expect(gateway.requests.at(-1).headers.authorization).toBe(`Bearer ${USER_KEY}`);
    // a non-pk_ bearer is ignored, the machine credential is used
    await api(`${base}/api/publik/chat`, { method: "POST", headers: { authorization: "Bearer sk-user" }, body: "{}" });
    expect(gateway.requests.at(-1).headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("proxy: bodies over 4 MB are refused locally with 413", async () => {
    await boot();
    await api(`${base}/api/publik/provision`, { method: "POST" });
    const res = await api(`${base}/api/publik/v1/audio/transcriptions`, {
      method: "POST",
      body: new Uint8Array(4 * 1024 * 1024 + 1),
    }).catch(() => null);
    // Node may surface the early-closed socket as an error OR a 413; either way nothing reached the gateway.
    if (res) {
      expect(res.status).toBe(413);
      expect((await res.json()).error.type).toBe("request_too_large");
    }
    expect(gateway.requests.filter((r) => r.url === "/audio/transcriptions")).toHaveLength(0);
  });

  it("402 passes through untouched (body + headers) so the renderer can render message + top_up_url", async () => {
    await boot();
    await api(`${base}/api/publik/provision`, { method: "POST" });
    gateway.route = (req, res, raw) => {
      if (req.url !== "/chat/completions") return defaultRoute(req, res, raw);
      res.writeHead(402, { "content-type": "application/json", "x-publik-balance": "1240" });
      res.end(
        JSON.stringify({
          error: {
            type: "insufficient_credit",
            message: "Not enough publik credit for this request.",
            available_micros: 1240,
            required_micros: 41000,
            claim_state: "anonymous",
            top_up_url: CLAIM_URL,
            claim_url: CLAIM_URL,
            add_credit_url: "https://publikhq.com/dashboard/api/add",
          },
        }),
      );
    };
    const res = await api(`${base}/api/publik/chat`, { method: "POST", body: "{}" });
    expect(res.status).toBe(402);
    expect(res.headers.get("x-publik-balance")).toBe("1240");
    const body = await res.json();
    expect(body.error.top_up_url).toBe(CLAIM_URL);
  });

  it("401 key_revoked → the module provisions again with the SAME install_id and the call is retried once", async () => {
    await boot();
    await api(`${base}/api/publik/provision`, { method: "POST" });
    const id = readCredential().install_id;
    let chatCalls = 0;
    gateway.route = (req, res, raw) => {
      if (req.url === "/chat/completions") {
        chatCalls++;
        const auth = req.headers.authorization;
        if (auth === `Bearer ${KEY}`) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { type: "key_revoked", message: "revoked (idle)", reprovision: true } }));
          return;
        }
      }
      if (req.url === "/api/v1/installs") {
        const body = JSON.parse(raw.toString("utf8"));
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ install_id: body.install_id, key: KEY2, base_url: gateway.url }));
        return;
      }
      return defaultRoute(req, res, raw);
    };
    const res = await api(`${base}/api/publik/chat`, { method: "POST", body: JSON.stringify({ messages: [] }) });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Hello");
    expect(chatCalls).toBe(2);
    expect(installs()).toHaveLength(2); // initial + reprovision
    expect(JSON.parse(installs()[1].text).install_id).toBe(id);
    expect(readCredential()).toMatchObject({ key: KEY2, choice: "publik" });
  });

  it("401 key_revoked that stays after one new key → 401 with disconnected:true, no loop", async () => {
    await boot();
    await api(`${base}/api/publik/provision`, { method: "POST" });
    let chatCalls = 0;
    gateway.route = (req, res, raw) => {
      if (req.url === "/chat/completions") {
        chatCalls++;
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "key_revoked", message: "removed from dashboard", reprovision: false } }));
        return;
      }
      if (req.url === "/api/v1/installs") {
        const body = JSON.parse(raw.toString("utf8"));
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ install_id: body.install_id, key: KEY2, base_url: gateway.url }));
        return;
      }
      return defaultRoute(req, res, raw);
    };
    const res = await api(`${base}/api/publik/chat`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatchObject({ type: "key_revoked", disconnected: true });
    expect(chatCalls).toBe(2);
    expect(installs()).toHaveLength(2);
    // The next start's gate sees the 401 on GET /wallet and provisions again (publik.mjs ensureSignedIn).
    expect(readCredential().key).toBe(KEY2);
  });

  it("wallet: GET /api/v1/wallet with the key; forget and disconnect keep the key but stop using it for AI", async () => {
    await boot();
    expect((await api(`${base}/api/publik/wallet`)).status).toBe(404);
    await api(`${base}/api/publik/provision`, { method: "POST" });
    const w = await (await api(`${base}/api/publik/wallet`)).json();
    expect(w.balance_micros).toBe(181240);
    expect(gateway.requests.at(-1)).toMatchObject({ url: "/api/v1/wallet", method: "GET" });
    expect(gateway.requests.at(-1).headers.authorization).toBe(`Bearer ${KEY}`);

    // "Use my own key": the credential stays (the sign-in and the usage counts need it) with choice own_key.
    const n = gateway.requests.length;
    const f = await (await api(`${base}/api/publik/forget`, { method: "POST" })).json();
    expect(f).toMatchObject({ ok: true, state: "unprovisioned", available: true });
    expect(readCredential()).toMatchObject({ key: KEY, choice: "own_key" });
    expect((await (await api(`${base}/api/publik/status`)).json()).state).toBe("unprovisioned");
    expect((await api(`${base}/api/publik/chat`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await api(`${base}/api/publik/wallet`)).status).toBe(404);
    expect(gateway.requests).toHaveLength(n); // nothing went to the gateway

    // "Continue with publik API" again: the same key, no new install.
    const r = await (await api(`${base}/api/publik/provision`, { method: "POST" })).json();
    expect(r).toMatchObject({ ok: true, minted: false, state: "ready" });
    expect(installs()).toHaveLength(1);

    await api(`${base}/api/publik/disconnect`, { method: "POST" });
    expect(readCredential()).toMatchObject({ key: KEY, choice: "own_key" });
    expect(gateway.requests.filter((r) => r.url.includes("revoke"))).toHaveLength(0);
  });

  it("PUBLIK_API_KEY in the environment overrides and never writes a file", async () => {
    process.env.PUBLIK_API_KEY = USER_KEY;
    process.env.PUBLIK_API_BASE_URL = gateway.url;
    delete process.env.PUBLIK_APP_TOKEN;
    await boot();
    const s = await (await api(`${base}/api/publik/status`)).json();
    expect(s).toMatchObject({ available: true, state: "ready", source: "env" });
    await api(`${base}/api/publik/chat`, { method: "POST", body: "{}" });
    expect(gateway.requests.at(-1).headers.authorization).toBe(`Bearer ${USER_KEY}`);
    expect(fs.existsSync(file())).toBe(false);
    const p = await (await api(`${base}/api/publik/provision`, { method: "POST" })).json();
    expect(p).toMatchObject({ ok: true, minted: false, state: "ready" });
    expect(fs.existsSync(file())).toBe(false);
  });
});

describe("server basics", () => {
  it("unknown /api/x is still 404 and /api/health still answers", async () => {
    await boot();
    expect((await api(`${base}/api/x`)).status).toBe(404);
    expect((await (await api(`${base}/api/health`)).json()).ok).toBe(true);
    expect((await api(`${base}/api/publik/nope`)).status).toBe(404);
  });

  it("ports: falls through a taken candidate to the next one", async () => {
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
    const taken = blocker.address().port;
    try {
      app = await startServer({ distDir: path.join(dir, "dist"), binDir: path.join(dir, "bin"), ports: [taken, 0] });
      expect(app.port).not.toBe(taken);
      expect(app.port).toBeGreaterThan(0);
    } finally {
      blocker.close();
    }
  });
});
