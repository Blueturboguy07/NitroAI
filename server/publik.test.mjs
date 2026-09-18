/* provision() and friends against a LOCAL FAKE GATEWAY (a real http server on
 * 127.0.0.1, not a fetch mock) so the request shape the contract specifies
 * (CONTRACT.md §3.2) is what actually goes over the wire. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  APP_SLUG,
  DISCLOSURE_VERSION,
  appToken,
  contractOs,
  credentialForRenderer,
  credentialPath,
  envCredential,
  forget,
  isLive,
  markDisconnected,
  provision,
  readCredentialFile,
  wallet,
} from "./publik.mjs";

const TOKEN = "pat_nitroai_k3m9x2q7v5n8r4t6w1y0z2b5c8d1f4g7";
const KEY = "pk_live_a8k2m9x4q7v1_h3n6r9t2w5y8z1b4c7d0f3g6j9k2m5p8";
const KEY2 = "pk_live_b9l3n0y5r8w2_i4o7s0u3x6z9a2c5d8e1f4g7h0j3k6l9";

/* A tiny scripted gateway: each test sets `gateway.next` to decide the answer
   and reads `gateway.requests` to assert what was sent. */
const gateway = { server: null, url: "", requests: [], next: null, installs: new Map() };

function mint201(body, extra = {}) {
  return {
    status: 201,
    body: {
      install_id: body.install_id,
      key: KEY,
      key_id: "a8k2m9x4q7v1",
      base_url: gateway.url,
      models: { fast: "publik-fast", balanced: "publik-balanced", smart: "publik-smart" },
      dialects: ["chat_completions", "responses", "messages"],
      claim_code: "HK7F-2QWD",
      claim_url: "https://publikhq.com/claim/HK7F-2QWD",
      claim_expires_at: "2026-10-18T17:04:11Z",
      starter_micros: 250000,
      balance_micros: 250000,
      starting_credit_micros: 250000,
      wallet: { balance_micros: 250000, claim_state: "anonymous" },
      disclosure: { version: DISCLOSURE_VERSION, cost: "…", data_path: "…" },
      ...extra,
    },
  };
}

beforeAll(async () => {
  gateway.server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : null;
      gateway.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const answer = gateway.next ? gateway.next(req, body) : mint201(body);
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise((r) => gateway.server.listen(0, "127.0.0.1", r));
  gateway.url = `http://127.0.0.1:${gateway.server.address().port}`;
});

afterAll(() => gateway.server.close());

let dir;
let file;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-publik-"));
  file = path.join(dir, "apps", "nitroai.json");
  gateway.requests = [];
  gateway.next = null;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.PUBLIK_API_KEY;
  delete process.env.PUBLIK_API_BASE_URL;
});

const base = () => ({ token: TOKEN, file, appVersion: "0.2.0", baseUrl: gateway.url });

describe("provision()", () => {
  it("with no token → no_app_token and no network", async () => {
    const r = await provision({ ...base(), token: null });
    expect(r).toEqual({ credential: null, minted: false, reason: "no_app_token" });
    expect(gateway.requests).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("sends the contract §3.2 request shape and writes the 201 body verbatim + install_id", async () => {
    const r = await provision(base());
    expect(r.minted).toBe(true);
    expect(gateway.requests).toHaveLength(1);
    const req = gateway.requests[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/installs");
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.body).toMatchObject({
      app_token: TOKEN,
      app_slug: APP_SLUG,
      app_version: "0.2.0",
      os: contractOs(),
      arch: process.arch,
      disclosure_version: DISCLOSURE_VERSION,
      dialects: ["chat_completions"],
    });
    expect(req.body.install_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof req.body.device_name).toBe("string");
    expect(typeof req.body.os_version).toBe("string");

    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written.key).toBe(KEY);
    expect(written.install_id).toBe(req.body.install_id);
    expect(written.version).toBe(1);
    expect(written.base_url).toBe(gateway.url);
    expect(written.claim_url).toBe("https://publikhq.com/claim/HK7F-2QWD");
    expect(written.starter_micros).toBe(250000);
    expect(written.models.balanced).toBe("publik-balanced");
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(r.credential.key).toBe(KEY);
  });

  it("is idempotent: a second call is a read, no network", async () => {
    await provision(base());
    const r = await provision(base());
    expect(r.minted).toBe(false);
    expect(r.credential.key).toBe(KEY);
    expect(gateway.requests).toHaveLength(1);
  });

  it("honours base_url and models from the response over the compiled default", async () => {
    gateway.next = (_req, body) =>
      mint201(body, { base_url: "https://api.publikhq.com/v1/", models: { fast: "publik-turbo", balanced: "publik-mid" } });
    const r = await provision(base());
    expect(r.credential.base_url).toBe("https://api.publikhq.com/v1");
    expect(r.credential.models).toEqual({ fast: "publik-turbo", balanced: "publik-mid", smart: "publik-smart" });
  });

  it("replay (200, key:null) with no file → mints a fresh install_id exactly once", async () => {
    let calls = 0;
    gateway.next = (_req, body) => {
      calls++;
      if (calls === 1) return { status: 200, body: { install_id: body.install_id, key: null, starter_micros: 0, claim_state: "anonymous" } };
      return mint201(body);
    };
    const r = await provision(base());
    expect(r.minted).toBe(true);
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[0].body.install_id).not.toBe(gateway.requests[1].body.install_id);
    expect(readCredentialFile(file).install_id).toBe(gateway.requests[1].body.install_id);
  });

  it("401/403 → token_revoked, no file; 429 → rate_limited; 503 → gateway_unavailable", async () => {
    for (const [status, reason] of [
      [401, "token_revoked"],
      [403, "token_revoked"],
      [429, "rate_limited"],
      [503, "gateway_unavailable"],
    ]) {
      gateway.next = () => ({ status, body: { error: { type: "x" } } });
      const r = await provision(base());
      expect(r).toEqual({ credential: null, minted: false, reason });
      expect(fs.existsSync(file)).toBe(false);
    }
  });

  it("malformed 201 (no pk_ key) → bad_response, no file", async () => {
    gateway.next = (_req, body) => ({ status: 201, body: { install_id: body.install_id, key: "sk-nope" } });
    const r = await provision(base());
    expect(r.reason).toBe("bad_response");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("force re-mint (idle-sweep reprovision) keeps the install_id; a disconnected file never re-mints on its own", async () => {
    await provision(base());
    const id = readCredentialFile(file).install_id;
    gateway.next = (_req, body) => mint201(body, { key: KEY2 });
    const r = await provision({ ...base(), force: true });
    expect(r.minted).toBe(true);
    expect(gateway.requests[1].body.install_id).toBe(id);
    expect(readCredentialFile(file).key).toBe(KEY2);

    markDisconnected(file);
    const d = readCredentialFile(file);
    expect(d.disconnected).toBe(true);
    expect(d.key).toBeUndefined();
    expect(isLive(d)).toBe(false);
    const r2 = await provision(base());
    expect(r2).toEqual({ credential: null, minted: false, reason: "disconnected" });
    expect(gateway.requests).toHaveLength(2);

    // Reconnect = explicit user action → fresh install.
    const r3 = await provision({ ...base(), force: true });
    expect(r3.minted).toBe(true);
    expect(gateway.requests[2].body.install_id).not.toBe(id);
  });

  it("forget() removes the file", async () => {
    await provision(base());
    forget(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(() => forget(file)).not.toThrow();
  });
});

describe("credential helpers", () => {
  it("credentialPath() per platform", () => {
    expect(credentialPath("darwin", {}, "/Users/x")).toBe("/Users/x/Library/Application Support/publik/apps/nitroai.json");
    expect(credentialPath("linux", {}, "/home/x")).toBe("/home/x/.config/publik/apps/nitroai.json");
    expect(credentialPath("linux", { XDG_CONFIG_HOME: "/xdg" }, "/home/x")).toBe("/xdg/publik/apps/nitroai.json");
    expect(credentialPath("win32", { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, "C:\\Users\\x")).toMatch(
      /publik[\\/]apps[\\/]nitroai\.json$/,
    );
  });

  it("appToken(): env beats package.json; absent → null", () => {
    expect(appToken({ env: { PUBLIK_APP_TOKEN: "pat_env" }, packageJson: { publik: { appToken: "pat_pkg" } } })).toBe("pat_env");
    expect(appToken({ env: {}, packageJson: { publik: { appToken: "pat_pkg" } } })).toBe("pat_pkg");
    expect(appToken({ env: {}, packageJson: { publik: { appToken: null } } })).toBeNull();
    expect(appToken({ env: {}, packageJson: {} })).toBeNull();
  });

  it("envCredential(): PUBLIK_API_KEY overrides, never written to disk", () => {
    expect(envCredential({})).toBeNull();
    const c = envCredential({ PUBLIK_API_KEY: KEY, PUBLIK_API_BASE_URL: "http://127.0.0.1:1/v1/" });
    expect(c.key).toBe(KEY);
    expect(c.base_url).toBe("http://127.0.0.1:1/v1");
    expect(c.source).toBe("env");
  });

  it("credentialForRenderer() never includes the key", async () => {
    await provision(base());
    const view = credentialForRenderer(readCredentialFile(file));
    expect(JSON.stringify(view)).not.toContain("pk_");
    expect(view).toMatchObject({
      available: true,
      state: "ready",
      baseUrl: "/api/publik/v1",
      models: { fast: "publik-fast", balanced: "publik-balanced", smart: "publik-smart" },
      claimUrl: "https://publikhq.com/claim/HK7F-2QWD",
      starterMicros: 250000,
    });
    expect(credentialForRenderer(null, { available: false })).toEqual({ available: false, state: "unprovisioned", baseUrl: "/api/publik/v1" });
  });

  it("wallet() GETs <base_url>/wallet with the key", async () => {
    await provision(base());
    gateway.next = () => ({ status: 200, body: { balance_micros: 181240, claim_state: "anonymous" } });
    const w = await wallet(readCredentialFile(file));
    expect(w.status).toBe(200);
    expect(w.body.balance_micros).toBe(181240);
    const req = gateway.requests.at(-1);
    expect(req.url).toBe("/wallet");
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
  });
});
