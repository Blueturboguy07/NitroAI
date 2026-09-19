/* The local server end to end: startServer() on a temp dist/, the publik
 * routes, and the streaming proxy against a LOCAL FAKE GATEWAY. Also a
 * regression guard that unknown /api/x is still 404 and that the stable-port
 * fallback works. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startServer } from "./httpServer.mjs";
import { DISCLOSURE_VERSION, readCredentialFile } from "./publik.mjs";

const TOKEN = "pat_nitroai_k3m9x2q7v5n8r4t6w1y0z2b5c8d1f4g7";
const KEY = "pk_live_a8k2m9x4q7v1_h3n6r9t2w5y8z1b4c7d0f3g6j9k2m5p8";
const KEY2 = "pk_live_b9l3n0y5r8w2_i4o7s0u3x6z9a2c5d8e1f4g7h0j3k6l9";
const USER_KEY = "pk_test_c0m4o1z6s9x3_j5p8t1v4y7a0b3d6e9f2g5h8i1k4l7m0";

const gateway = { server: null, url: "", requests: [], route: null };

function sse(lines) {
  return lines.map((l) => `data: ${typeof l === "string" ? l : JSON.stringify(l)}\n\n`).join("");
}

beforeAll(async () => {
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
});
afterAll(() => gateway.server.close());

/* Default gateway behaviour: mint on /installs, stream two tokens on chat
   with the contract's x-publik-* headers, echo on everything else. */
function defaultRoute(req, res, raw) {
  if (req.url === "/installs") {
    const body = JSON.parse(raw.toString("utf8"));
    res.writeHead(201, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        install_id: body.install_id,
        key: KEY,
        base_url: gateway.url,
        models: { fast: "publik-fast", balanced: "publik-balanced", smart: "publik-smart" },
        claim_url: "https://publikhq.com/claim/HK7F-2QWD",
        starter_micros: 250000,
        balance_micros: 250000,
      }),
    );
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
  if (req.url === "/wallet") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ balance_micros: 181240, claim_state: "anonymous", claim_url: "https://publikhq.com/claim/HK7F-2QWD" }));
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
let file;
let app;
let base;

async function boot(publik = {}) {
  app = await startServer({
    distDir: path.join(dir, "dist"),
    binDir: path.join(dir, "bin"),
    port: 0,
    publik: { token: TOKEN, appVersion: "0.2.0", credentialFile: file, baseUrl: gateway.url, ...publik },
  });
  base = app.url;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-server-"));
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "dist", "index.html"), "<html>app</html>");
  file = path.join(dir, "publik", "apps", "nitroai.json");
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
    const s = await (await fetch(`${base}/api/publik/status`)).json();
    expect(s).toMatchObject({ available: true, state: "unprovisioned", baseUrl: "/api/publik/v1", disclosureVersion: DISCLOSURE_VERSION });
    await new Promise((r) => app.server.close(r));
    await boot({ token: null });
    const s2 = await (await fetch(`${base}/api/publik/status`)).json();
    expect(s2).toMatchObject({ available: false, state: "unprovisioned" });
  });

  it("nothing is minted on status/boot; provision mints only when called (consent first)", async () => {
    await boot();
    await fetch(`${base}/api/publik/status`);
    await fetch(`${base}/api/publik/wallet`);
    expect(gateway.requests.filter((r) => r.url === "/installs")).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(false);

    const res = await fetch(`${base}/api/publik/provision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disclosure_version: DISCLOSURE_VERSION }),
    });
    const s = await res.json();
    expect(s).toMatchObject({ ok: true, minted: true, state: "ready", starterMicros: 250000, claimUrl: "https://publikhq.com/claim/HK7F-2QWD" });
    expect(JSON.stringify(s)).not.toContain("pk_");
    expect(readCredentialFile(file).key).toBe(KEY);
    expect(JSON.parse(gateway.requests.find((r) => r.url === "/installs").text).disclosure_version).toBe(DISCLOSURE_VERSION);
  });

  it("provision without a token answers 200 {ok:false, reason:no_app_token}", async () => {
    await boot({ token: null });
    const s = await (await fetch(`${base}/api/publik/provision`, { method: "POST" })).json();
    expect(s).toMatchObject({ ok: false, reason: "no_app_token", available: false });
  });

  it("proxy: chat streams through with the key attached and x-publik-* headers exposed", async () => {
    await boot();
    await fetch(`${base}/api/publik/provision`, { method: "POST" });
    const res = await fetch(`${base}/api/publik/chat`, {
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
    await fetch(`${base}/api/publik/provision`, { method: "POST" });
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(1000)]), "chunk.wav");
    form.append("model", "whisper-1");
    const t = await fetch(`${base}/api/publik/v1/audio/transcriptions`, { method: "POST", body: form });
    expect(t.status).toBe(200);
    expect(t.headers.get("x-publik-charge-micros")).toBe("150");
    const tb = await t.json();
    expect(tb.content_type).toMatch(/^multipart\/form-data; boundary=/);
    expect(tb.echoed_bytes).toBeGreaterThan(1000);

    expect((await fetch(`${base}/api/publik/v1/embeddings`, { method: "POST", body: "{}" })).status).toBe(200);
    expect((await fetch(`${base}/api/publik/v1/audio/speech`, { method: "POST", body: "{}" })).status).toBe(200);
    expect((await fetch(`${base}/api/publik/v1/models`)).status).toBe(200);
    expect((await fetch(`${base}/api/publik/v1/installs`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(`${base}/api/publik/v1/wallet`)).status).toBe(404);
    expect((await fetch(`${base}/api/publik/v1/chat/completions`)).status).toBe(404); // GET not allowed
  });

  it("proxy: without a credential answers 401 no_publik_credential and never calls the gateway", async () => {
    await boot();
    const res = await fetch(`${base}/api/publik/chat`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect((await res.json()).error.type).toBe("no_publik_credential");
    expect(gateway.requests).toHaveLength(0);
  });

  it("proxy: a user-pasted pk_ key in Authorization is used instead of the machine credential", async () => {
    await boot();
    await fetch(`${base}/api/publik/provision`, { method: "POST" });
    await fetch(`${base}/api/publik/chat`, { method: "POST", headers: { authorization: `Bearer ${USER_KEY}` }, body: "{}" });
    expect(gateway.requests.at(-1).headers.authorization).toBe(`Bearer ${USER_KEY}`);
    // a non-pk_ bearer is ignored, the machine credential is used
    await fetch(`${base}/api/publik/chat`, { method: "POST", headers: { authorization: "Bearer sk-user" }, body: "{}" });
    expect(gateway.requests.at(-1).headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("proxy: bodies over 4 MB are refused locally with 413", async () => {
    await boot();
    await fetch(`${base}/api/publik/provision`, { method: "POST" });
    const res = await fetch(`${base}/api/publik/v1/audio/transcriptions`, {
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
    await fetch(`${base}/api/publik/provision`, { method: "POST" });
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
            top_up_url: "https://publikhq.com/claim/HK7F-2QWD",
            claim_url: "https://publikhq.com/claim/HK7F-2QWD",
            add_credit_url: "https://publikhq.com/dashboard/api/add",
          },
        }),
      );
    };
    const res = await fetch(`${base}/api/publik/chat`, { method: "POST", body: "{}" });
    expect(res.status).toBe(402);
    expect(res.headers.get("x-publik-balance")).toBe("1240");
    const body = await res.json();
    expect(body.error.top_up_url).toBe("https://publikhq.com/claim/HK7F-2QWD");
  });

  it("401 key_revoked reprovision:true → re-mints with the SAME install_id and retries once", async () => {
    await boot();
    await fetch(`${base}/api/publik/provision`, { method: "POST" });
    const id = readCredentialFile(file).install_id;
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
      if (req.url === "/installs") {
        const body = JSON.parse(raw.toString("utf8"));
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ install_id: body.install_id, key: KEY2, base_url: gateway.url }));
        return;
      }
      return defaultRoute(req, res, raw);
    };
    const res = await fetch(`${base}/api/publik/chat`, { method: "POST", body: JSON.stringify({ messages: [] }) });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Hello");
    expect(chatCalls).toBe(2);
    const mint = gateway.requests.filter((r) => r.url === "/installs");
    expect(mint).toHaveLength(2); // initial + reprovision
    expect(JSON.parse(mint[1].text).install_id).toBe(id);
    expect(readCredentialFile(file).key).toBe(KEY2);
  });

  it("401 key_revoked reprovision:false → marks disconnected, does NOT re-mint, later calls 401 without the gateway", async () => {
    await boot();
    await fetch(`${base}/api/publik/provision`, { method: "POST" });
    gateway.route = (req, res, raw) => {
      if (req.url === "/chat/completions") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "key_revoked", message: "removed from dashboard", reprovision: false } }));
        return;
      }
      return defaultRoute(req, res, raw);
    };
    const res = await fetch(`${base}/api/publik/chat`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatchObject({ type: "key_revoked", reprovision: false, disconnected: true });
    expect(readCredentialFile(file)).toMatchObject({ disconnected: true });
    expect(gateway.requests.filter((r) => r.url === "/installs")).toHaveLength(1);

    const s = await (await fetch(`${base}/api/publik/status`)).json();
    expect(s.state).toBe("disconnected");
    const n = gateway.requests.length;
    const again = await fetch(`${base}/api/publik/chat`, { method: "POST", body: "{}" });
    expect(again.status).toBe(401);
    expect((await again.json()).error.disconnected).toBe(true);
    expect(gateway.requests).toHaveLength(n);

    // Reconnect is explicit: provision {force:true} starts a fresh install.
    gateway.route = defaultRoute;
    const r = await (await fetch(`${base}/api/publik/provision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: true }) })).json();
    expect(r).toMatchObject({ ok: true, minted: true, state: "ready" });
  });

  it("wallet falls back to GET /wallet; forget and disconnect drop the file", async () => {
    await boot();
    expect((await fetch(`${base}/api/publik/wallet`)).status).toBe(404);
    await fetch(`${base}/api/publik/provision`, { method: "POST" });
    const w = await (await fetch(`${base}/api/publik/wallet`)).json();
    expect(w.balance_micros).toBe(181240);
    expect(gateway.requests.at(-1).headers.authorization).toBe(`Bearer ${KEY}`);

    await fetch(`${base}/api/publik/forget`, { method: "POST" });
    expect(fs.existsSync(file)).toBe(false);
    expect((await (await fetch(`${base}/api/publik/status`)).json()).state).toBe("unprovisioned");

    await fetch(`${base}/api/publik/provision`, { method: "POST" });
    gateway.route = (req, res, raw) => {
      if (req.url === "/installs/revoke") {
        res.writeHead(204);
        res.end();
        return;
      }
      return defaultRoute(req, res, raw);
    };
    await fetch(`${base}/api/publik/disconnect`, { method: "POST" });
    expect(gateway.requests.at(-1)).toMatchObject({ url: "/installs/revoke", method: "POST" });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("PUBLIK_API_KEY in the environment overrides and never writes a file", async () => {
    process.env.PUBLIK_API_KEY = USER_KEY;
    process.env.PUBLIK_API_BASE_URL = gateway.url;
    try {
      await boot({ token: null });
      const s = await (await fetch(`${base}/api/publik/status`)).json();
      expect(s).toMatchObject({ available: true, state: "ready", source: "env" });
      await fetch(`${base}/api/publik/chat`, { method: "POST", body: "{}" });
      expect(gateway.requests.at(-1).headers.authorization).toBe(`Bearer ${USER_KEY}`);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      delete process.env.PUBLIK_API_KEY;
      delete process.env.PUBLIK_API_BASE_URL;
    }
  });
});

describe("server basics", () => {
  it("unknown /api/x is still 404 and /api/health still answers", async () => {
    await boot();
    expect((await fetch(`${base}/api/x`)).status).toBe(404);
    expect((await (await fetch(`${base}/api/health`)).json()).ok).toBe(true);
    expect((await fetch(`${base}/api/publik/nope`)).status).toBe(404);
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
