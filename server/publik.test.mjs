/* The publik module (publik.mjs) against a LOCAL FAKE PUBLIK: a real http
 * server on 127.0.0.1 (not a fetch mock) that answers POST /api/v1/installs,
 * GET /api/v1/wallet and POST /api/v1/telemetry, so what goes over the wire
 * is what the test sees. PUBLIK_ORIGIN points the module at it and HOME /
 * XDG_CONFIG_HOME / LOCALAPPDATA point the credential at a temp folder, so
 * nothing here touches this computer's own publik files. The module reads
 * PUBLIK_ORIGIN at load, so it is imported after the fake publik listens. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const TOKEN = "pat_nitroai_k3m9x2q7v5n8r4t6w1y0z2b5c8d1f4g7";
const KEY = "pk_live_a8k2m9x4q7v1_h3n6r9t2w5y8z1b4c7d0f3g6j9k2m5p8";
const KEY2 = "pk_live_b9l3n0y5r8w2_i4o7s0u3x6z9a2c5d8e1f4g7h0j3k6l9";
const USER_KEY = "pk_test_c0m4o1z6s9x3_j5p8t1v4y7a0b3d6e9f2g5h8i1k4l7m0";
const CLAIM_URL = "https://publikhq.com/claim/HK7F-2QWD";
const PKG_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const ENV_KEYS = ["PUBLIK_ORIGIN", "PUBLIK_APP_TOKEN", "PUBLIK_API_KEY", "PUBLIK_API_BASE_URL", "DO_NOT_TRACK", "PUBLIK_TELEMETRY",
  "PUBLIK_TELEMETRY_URL", "PUBLIK_SELF_TEST", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "LOCALAPPDATA"];
const savedEnv = {};

/* The fake publik. `publik.key` is the key it mints and accepts; `publik.wallet`
   is the body of GET /wallet; `publik.next` overrides any answer. */
const publik = { server: null, url: "", requests: [], next: null, key: KEY, wallet: null };
let mod; // ./publik.mjs, imported once the fake publik listens

function walletBody(extra = {}) {
  return {
    claim_state: "anonymous", claim_url: CLAIM_URL, account: null, plan: { kind: "none", label: null },
    balance_micros: 0, top_up_url: "https://publikhq.com/plans", linked_at: null, ...extra,
  };
}

function defaultAnswer(req, body) {
  if (req.method === "POST" && req.url === "/api/v1/installs") {
    return { status: 201, body: { key: publik.key, install_id: body.install_id, base_url: `${publik.url}/api/v1`, claim_url: CLAIM_URL, claim_state: "anonymous" } };
  }
  if (req.method === "GET" && req.url === "/api/v1/wallet") {
    if (req.headers.authorization !== `Bearer ${publik.key}`) return { status: 401, body: { error: { type: "key_revoked", message: "This key was revoked." } } };
    return { status: 200, body: publik.wallet ?? walletBody() };
  }
  if (req.method === "POST" && req.url === "/api/v1/telemetry") return { status: 204, body: null };
  return { status: 404, body: { error: { type: "not_found" } } };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  publik.server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      publik.requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const a = publik.next ? publik.next(req, body) : defaultAnswer(req, body);
      if (a.body === null) { res.writeHead(a.status); res.end(); return; }
      res.writeHead(a.status, { "content-type": "application/json" });
      res.end(JSON.stringify(a.body));
    });
  });
  await new Promise((r) => publik.server.listen(0, "127.0.0.1", r));
  publik.url = `http://127.0.0.1:${publik.server.address().port}`;

  process.env.PUBLIK_ORIGIN = publik.url;
  process.env.PUBLIK_APP_TOKEN = TOKEN;
  for (const k of ["PUBLIK_API_KEY", "PUBLIK_API_BASE_URL", "DO_NOT_TRACK", "PUBLIK_TELEMETRY", "PUBLIK_TELEMETRY_URL", "PUBLIK_SELF_TEST"]) delete process.env[k];
  mod = await import("./publik.mjs");
});

afterAll(() => {
  publik.server.close();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nitroai-publik-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.XDG_CONFIG_HOME = path.join(dir, ".config");
  process.env.LOCALAPPDATA = path.join(dir, "AppData", "Local");
  process.env.PUBLIK_APP_TOKEN = TOKEN;
  delete process.env.PUBLIK_API_KEY;
  delete process.env.PUBLIK_API_BASE_URL;
  publik.requests = [];
  publik.next = null;
  publik.key = KEY;
  publik.wallet = null;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const installs = () => publik.requests.filter((r) => r.url === "/api/v1/installs");

describe("the module", () => {
  it("is stamped for this app and reads the version from package.json", () => {
    expect(mod.APP_SLUG).toBe("nitroai");
    expect(mod.APP_VERSION).toBe(PKG_VERSION);
    expect(mod.USES_AI).toBe(true);
    expect(mod.DEFAULT_BASE_URL).toBe(`${publik.url}/api/v1`);
    expect(mod.hasAppToken()).toBe(true);
    // <publik dir>/apps/nitroai.json, under the temp HOME of this test.
    const publikDir = process.platform === "darwin" ? path.join(dir, "Library", "Application Support", "publik")
      : process.platform === "win32" ? path.join(dir, "AppData", "Local", "publik")
      : path.join(dir, ".config", "publik");
    expect(mod.credentialPath()).toBe(path.join(publikDir, "apps", "nitroai.json"));
  });

  it("provision(): POST /api/v1/installs, then the key is on disk (0600) and never anywhere else", async () => {
    expect(mod.readCredential()).toBeNull();
    const c = await mod.provision();
    expect(installs()).toHaveLength(1);
    const req = installs()[0];
    expect(req.body).toMatchObject({ app_token: TOKEN, app_slug: "nitroai", app_version: PKG_VERSION, arch: process.arch, dialects: ["chat_completions"] });
    expect(req.body.install_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(["macos", "windows", "linux"]).toContain(req.body.os);
    expect(typeof req.body.device_name).toBe("string");

    const file = mod.credentialPath();
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written).toMatchObject({ key: KEY, base_url: `${publik.url}/api/v1`, install_id: req.body.install_id, claim_url: CLAIM_URL, choice: null });
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(c.key).toBe(KEY);
    expect(mod.readCredential().key).toBe(KEY);

    // A later call keeps this computer's install id.
    await mod.provision();
    expect(installs()[1].body.install_id).toBe(req.body.install_id);
  });

  it("provision() with no app token throws a readable message, sends nothing and writes nothing", async () => {
    delete process.env.PUBLIK_APP_TOKEN;
    expect(mod.hasAppToken()).toBe(false);
    await expect(mod.provision()).rejects.toThrow(/no publik app token/);
    expect(publik.requests).toHaveLength(0);
    expect(fs.existsSync(mod.credentialPath())).toBe(false);
  });

  it("provision() passes the gateway's error message on and writes nothing", async () => {
    publik.next = () => ({ status: 429, body: { error: { type: "rate_limited", message: "Too many installs. Try again later." } } });
    await expect(mod.provision()).rejects.toThrow("Too many installs. Try again later.");
    expect(mod.readCredential()).toBeNull();
    expect(fs.existsSync(mod.credentialPath())).toBe(false);
  });

  it("readWallet(): GET /api/v1/wallet with the key; 401 → no wallet", async () => {
    publik.wallet = walletBody({ balance_micros: 181240 });
    const w = await mod.readWallet(KEY);
    expect(w.status).toBe(200);
    expect(w.wallet).toMatchObject({ claim_state: "anonymous", balance_micros: 181240, plan: { kind: "none" } });
    expect(publik.requests.at(-1).headers.authorization).toBe(`Bearer ${KEY}`);
    const gone = await mod.readWallet(KEY2);
    expect(gone.status).toBe(401);
    expect(gone.wallet).toBeNull();
  });

  it("resolveProvider(): the stored choice decides; PUBLIK_API_KEY overrides", async () => {
    expect(mod.resolveProvider(null)).toEqual({ kind: "needs_own_key" });
    expect(mod.resolveProvider({ apiKey: "sk-user" })).toMatchObject({ kind: "own", apiKey: "sk-user" });

    await mod.provision();
    // Signed in, no answer yet: the key is not used for AI.
    expect(mod.resolveProvider(null)).toEqual({ kind: "needs_own_key" });
    mod.setChoice("publik");
    expect(mod.resolveProvider({ apiKey: "sk-user" })).toEqual({ kind: "publik", baseURL: `${publik.url}/api/v1`, apiKey: KEY });
    mod.setChoice("own_key");
    expect(mod.resolveProvider({ apiKey: "sk-user" })).toMatchObject({ kind: "own", apiKey: "sk-user" });
    expect(mod.readCredential()).toMatchObject({ key: KEY, choice: "own_key" });

    process.env.PUBLIK_API_KEY = USER_KEY;
    process.env.PUBLIK_API_BASE_URL = "http://127.0.0.1:1/v1";
    expect(mod.resolveProvider(null)).toEqual({ kind: "publik", baseURL: "http://127.0.0.1:1/v1", apiKey: USER_KEY });
  });

  it("gateScreen(): the words of the gate", () => {
    const signIn = mod.gateScreen("sign_in", walletBody());
    expect(signIn.title).toBe("Sign in with publik");
    expect(signIn.buttons).toEqual([{ action: "sign_in", label: "Sign in with publik" }]);
    expect(mod.gateScreen("unreachable", null).body).toBe("publik is not reachable. Check your connection.");

    const choose = mod.gateScreen("choose", walletBody({ claim_state: "claimed" }));
    expect(choose.title).toBe("Choose how to pay for AI");
    expect(choose.buttons.map((b) => b.label)).toEqual(["Get a plan", "Use my own key"]);

    const connect = mod.gateScreen("choose", walletBody({ claim_state: "claimed", account: { handle: "mann" }, plan: { kind: "plan", label: "Pro" } }));
    expect(connect.title).toBe("Connect your plan");
    expect(connect.body).toContain("@mann");
    expect(connect.buttons.map((b) => b.label)).toEqual(["Connect your plan", "Use my own key"]);
  });

  it("ensureSignedIn(): sign in → choose once → the choice is kept and the usage count starts", async () => {
    const shown = [];
    const opened = [];
    const ui = {
      show(screen) {
        shown.push(screen.title);
        if (screen.id === "sign_in") {
          // The person signs in in the browser: the next GET /wallet says claimed.
          publik.wallet = walletBody({ claim_state: "claimed", account: { handle: "mann" } });
          return Promise.resolve("sign_in");
        }
        return Promise.resolve("own_key");
      },
      openUrl(url) { opened.push(url); },
      close() {},
    };
    const gate = await mod.ensureSignedIn(ui);
    expect(shown).toEqual(["Sign in with publik", "Choose how to pay for AI"]);
    expect(opened).toEqual([CLAIM_URL]);
    expect(gate).toMatchObject({ key: KEY, choice: "own_key", wallet: { claim_state: "claimed" } });
    expect(mod.readCredential()).toMatchObject({ key: KEY, choice: "own_key" });

    // app_opened reaches POST /api/v1/telemetry with this computer's key, without content.
    for (let i = 0; i < 40 && !publik.requests.some((r) => r.url === "/api/v1/telemetry"); i++) await new Promise((r) => setTimeout(r, 50));
    const t = publik.requests.find((r) => r.url === "/api/v1/telemetry");
    expect(t).toBeDefined();
    expect(t.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(t.body).toMatchObject({ v: 1, app: "nitroai", event: "app_opened", app_version: PKG_VERSION });
    expect(t.body.install_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(t.body).sort()).toEqual(["app", "app_version", "arch", "event", "install_id", "os", "v"].filter((k) => k !== "arch" || t.body.arch));

    // The answer is kept: the next start shows no screen.
    const again = await mod.ensureSignedIn({ show: () => { throw new Error("no screen expected"); }, openUrl() {}, close() {} });
    expect(again.choice).toBe("own_key");
  });

  it("ensureSignedIn(): a revoked key is provisioned again before the gate", async () => {
    await mod.provision();
    publik.key = KEY2; // publik forgot KEY: GET /wallet with it answers 401
    publik.wallet = walletBody({ claim_state: "claimed", plan: { kind: "plan", label: "Pro" } });
    const ui = { show: (screen) => Promise.resolve(screen.title === "Connect your plan" ? "connect" : "retry"), openUrl() {}, close() {} };
    const gate = await mod.ensureSignedIn(ui);
    expect(gate.key).toBe(KEY2);
    expect(gate.choice).toBe("publik");
    expect(installs()).toHaveLength(2);
    expect(mod.readCredential()).toMatchObject({ key: KEY2, choice: "publik" });
  });

  it("selfTest(): the line the built app prints with PUBLIK_SELF_TEST=1", async () => {
    const line = await mod.selfTest();
    expect(line).toBe(`publik self-test: ok nitroai ${PKG_VERSION}`);
    expect(line).not.toContain("pk_");
    expect(publik.requests.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /api/v1/installs", "GET /api/v1/wallet"]);

    publik.next = (req, body) => (req.url === "/api/v1/wallet" ? { status: 503, body: { error: { message: "down" } } } : defaultAnswer(req, body));
    expect(await mod.selfTest()).toMatch(/^publik self-test: failed: /);
  });

  it("topUpUrlFrom402() and clientConfig()", () => {
    expect(mod.topUpUrlFrom402({ error: { message: "Not enough balance.", top_up_url: "https://publikhq.com/plans" } })).toEqual({ message: "Not enough balance.", url: "https://publikhq.com/plans" });
    expect(mod.topUpUrlFrom402({})).toEqual({ message: "Not enough publik API balance.", url: null });
    expect(mod.clientConfig({ kind: "publik", baseURL: "https://x/api/v1", apiKey: KEY })).toEqual({ baseURL: "https://x/api/v1", apiKey: KEY });
  });
});
