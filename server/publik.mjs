/* publik API credential for the packaged app (build contract v1, 2026-09-18).
 *
 * Resolution order (publik credential convention):
 *   1. a key the user typed into Settings — never read here, never overwritten
 *      (it lives in the renderer's own slot, see src/lib/engine/keys.ts)
 *   2. PUBLIK_API_KEY / PUBLIK_API_BASE_URL in the environment (developers, CI smoke)
 *   3. the per-app credential file this module owns
 *   4. nothing — the app then behaves exactly like v0.1.6 (local or BYO key)
 *
 * The file is minted once per machine from the app token baked in at build
 * time, and ONLY after the user has accepted the first-run disclosure (the
 * renderer calls POST /api/publik/provision; nothing here mints on its own).
 * The token identifies THIS app build to publikhq.com; it is not a secret in
 * the strong sense (anyone can extract it from the .app) and the gateway
 * rate-limits and caps what it can mint accordingly.
 *
 * The pk_ key never leaves this process: the renderer talks to the gateway
 * through the local proxy in httpServer.mjs, which attaches the key.
 *
 * Pure Node built-ins, same register as ollama.mjs. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const APP_SLUG = "nitroai";
export const PUBLIK_BASE_URL = "https://publikhq.com/api/v1";
/* The version of the cost + data-path disclosure text the user is shown
   (src/lib/publikCopy.ts). Bump it when the copy changes materially so the
   server can re-prompt; the gateway records it and never rejects on it. */
export const DISCLOSURE_VERSION = 2;
export const DEFAULT_MODELS = { fast: "publik-fast", balanced: "publik-balanced", smart: "publik-smart" };
export const KEY_FORMAT = /^pk_(live|test)_[a-z0-9]{12}_[a-z0-9]{32}$/;

export function credentialPath(platform = process.platform, env = process.env, home = os.homedir()) {
  const dir =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support", "publik", "apps")
      : platform === "win32"
        ? path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "publik", "apps")
        : path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "publik", "apps");
  return path.join(dir, `${APP_SLUG}.json`);
}

/* The app token: electron-builder's extraMetadata puts it in the packaged
   package.json; developers can set PUBLIK_APP_TOKEN for `npm run app`. */
export function appToken({ packageJson, env = process.env } = {}) {
  return env.PUBLIK_APP_TOKEN || packageJson?.publik?.appToken || null;
}

/* Maps Node's platform names onto the contract's `os` enum. */
export function contractOs(platform = process.platform) {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

/* A credential file is either a live credential (has a key) or a
   "disconnected" marker left behind by a 401 key_revoked with
   reprovision:false — the app must not silently re-mint in that case. */
export function readCredentialFile(file = credentialPath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw?.version !== 1 || typeof raw.install_id !== "string") return null;
    if (raw.disconnected === true) return raw;
    if (typeof raw.key === "string" && KEY_FORMAT.test(raw.key) && typeof raw.base_url === "string") return raw;
  } catch {
    /* absent or unreadable → no credential */
  }
  return null;
}

export function isLive(c) {
  return !!c && c.disconnected !== true && typeof c.key === "string";
}

function writeCredentialFile(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file); // atomic on the same volume; never a half-written key
}

/* Credential from the environment (developers, CI smoke). Never written to disk. */
export function envCredential(env = process.env) {
  if (!env.PUBLIK_API_KEY) return null;
  return {
    version: 1,
    source: "env",
    key: env.PUBLIK_API_KEY,
    base_url: (env.PUBLIK_API_BASE_URL || PUBLIK_BASE_URL).replace(/\/$/, ""),
    models: { ...DEFAULT_MODELS },
    app_slug: APP_SLUG,
    install_id: "env",
    disclosure_version: DISCLOSURE_VERSION,
  };
}

/* Mint once. Idempotent: a second call with a live file present is a read,
   no network. `force` re-mints with the existing install_id (the 401
   key_revoked + reprovision:true path). A "disconnected" file never
   re-mints unless `force` is set by an explicit user action (Reconnect),
   in which case a fresh install_id is used. */
export async function provision({
  token,
  file = credentialPath(),
  appVersion = "dev",
  baseUrl = PUBLIK_BASE_URL,
  disclosureVersion = DISCLOSURE_VERSION,
  force = false,
  fetchImpl = fetch,
  platform = process.platform,
  deviceName = os.hostname(),
  osVersion = os.release(),
  arch = process.arch,
} = {}) {
  const existing = readCredentialFile(file);
  if (existing && isLive(existing) && !force) return { credential: existing, minted: false };
  if (existing && existing.disconnected && !force) {
    return { credential: null, minted: false, reason: "disconnected" };
  }
  if (!token) return { credential: null, minted: false, reason: "no_app_token" };

  const installsUrl = `${baseUrl.replace(/\/$/, "")}/installs`;
  // Re-use the install id on a forced re-mint of a live-but-revoked key; a
  // user-initiated reconnect after a dashboard revoke starts a fresh install.
  let installId = existing && isLive(existing) && force ? existing.install_id : randomUUID();

  const attempt = async (id) => {
    const res = await fetchImpl(installsUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        app_token: token,
        app_slug: APP_SLUG,
        app_version: String(appVersion).slice(0, 32),
        os: contractOs(platform),
        os_version: String(osVersion).slice(0, 64),
        arch,
        device_name: String(deviceName || "NitroAI").slice(0, 120),
        install_id: id,
        disclosure_version: disclosureVersion,
        dialects: ["chat_completions"],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    return { res, body };
  };

  let { res, body } = await attempt(installId);
  // Contract §3.2 [B1]: a replay of an install_id the gateway already knows
  // answers 200 with key:null. If we have no credential file for it (crash
  // between mint and write), mint a fresh install_id exactly once.
  if (res.status === 200 && body && body.key == null) {
    installId = randomUUID();
    ({ res, body } = await attempt(installId));
  }

  if (res.status === 401 || res.status === 403) return { credential: null, minted: false, reason: "token_revoked" };
  if (res.status === 429) return { credential: null, minted: false, reason: "rate_limited" };
  if (res.status === 503) return { credential: null, minted: false, reason: "gateway_unavailable" };
  if (!res.ok) return { credential: null, minted: false, reason: `http_${res.status}` };
  if (!body || typeof body.key !== "string" || !KEY_FORMAT.test(body.key)) {
    return { credential: null, minted: false, reason: "bad_response" };
  }

  const credential = {
    ...body, // the 201 body verbatim: base_url, models, claim_*, starter_micros, wallet, disclosure, …
    version: 1,
    app_slug: APP_SLUG,
    install_id: typeof body.install_id === "string" ? body.install_id : installId,
    base_url: (typeof body.base_url === "string" ? body.base_url : baseUrl).replace(/\/$/, ""),
    models: { ...DEFAULT_MODELS, ...(body.models && typeof body.models === "object" ? body.models : {}) },
    disclosure_version: disclosureVersion,
    minted_at: new Date().toISOString(),
  };
  delete credential.disconnected;
  writeCredentialFile(file, credential);
  return { credential: readCredentialFile(file), minted: true };
}

/* 401 key_revoked with reprovision:false — the user revoked this install from
   the dashboard (or an uninstaller). Keep the install id, drop the key, and
   remember that we must not re-mint on our own. */
export function markDisconnected(file = credentialPath()) {
  const existing = readCredentialFile(file);
  if (!existing) return;
  const { key: _key, ...rest } = existing;
  writeCredentialFile(file, { ...rest, disconnected: true, disconnected_at: new Date().toISOString() });
}

/* "Use my own key instead" / "Forget publik on this computer" → forget the
   credential on this machine. The key is revoked server-side by the idle
   sweep; the app just stops using it. */
export function forget(file = credentialPath()) {
  try {
    fs.rmSync(file);
  } catch {
    /* already gone */
  }
}

/* What the renderer may see. The key is deliberately NOT included: the
   renderer reaches the gateway only through the local proxy, which attaches
   it. Nothing here is ever written to localStorage by the renderer. */
export function credentialForRenderer(c, { available = true } = {}) {
  if (!c) return { available, state: "unprovisioned", baseUrl: "/api/publik/v1" };
  if (c.disconnected) {
    return {
      available,
      state: "disconnected",
      baseUrl: "/api/publik/v1",
      installId: c.install_id,
      disclosureVersion: c.disclosure_version ?? DISCLOSURE_VERSION,
    };
  }
  return {
    available: true,
    state: "ready",
    source: c.source ?? "file",
    baseUrl: "/api/publik/v1",
    models: { ...DEFAULT_MODELS, ...(c.models ?? {}) },
    dialects: Array.isArray(c.dialects) ? c.dialects : ["chat_completions"],
    // Optional: a future gateway can narrow capabilities per install.
    lines: Array.isArray(c.lines) ? c.lines : null,
    claimUrl: typeof c.claim_url === "string" ? c.claim_url : null,
    claimCode: typeof c.claim_code === "string" ? c.claim_code : null,
    installId: c.install_id,
    disclosureVersion: c.disclosure_version ?? DISCLOSURE_VERSION,
    starterMicros: Number.isFinite(c.starter_micros) ? c.starter_micros : null,
    balanceMicros: Number.isFinite(c.balance_micros) ? c.balance_micros : null,
    mintedAt: c.minted_at ?? null,
  };
}

/* Balance line for Settings: GET /wallet (R21 §2.3 shape; the header path
   updates it after every call, this is the fallback + refresh). */
export async function wallet(c, fetchImpl = fetch) {
  const res = await fetchImpl(`${c.base_url}/wallet`, {
    headers: { authorization: `Bearer ${c.key}` },
    signal: AbortSignal.timeout(5000),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, body };
}

/* Self-revoke ("Disconnect publik API" in Settings): POST /installs/revoke
   with the install's own key, then forget the file. Best effort. */
export async function revoke(c, fetchImpl = fetch) {
  try {
    await fetchImpl(`${c.base_url}/installs/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${c.key}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* offline — the idle sweep revokes it eventually */
  }
}
