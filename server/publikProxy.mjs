/* The renderer's only door to publik API. Mounted under /api/publik/ by
 * httpServer.mjs. Why a proxy: the renderer is a plain web page served from
 * http://127.0.0.1:<port>; a direct fetch to publikhq.com would be a
 * cross-origin request the gateway deliberately refuses (contract §1, CORS),
 * and the pk_ key must never enter the renderer anyway. So the local server
 * — the process that owns the credential — forwards the request with the
 * key attached and pipes the (streaming) answer straight back.
 *
 * The credential is the publik module's (publik.mjs): the install key this
 * computer got from POST /installs behind the Sign in with publik gate, and
 * the person's answer to the plan screen (`choice`). Only a "publik" choice
 * lets the proxy use the key; "Use my own key" keeps the key for the sign-in
 * and the usage counts and nothing else.
 *
 *   GET  /api/publik/status                 → is publik available / ready
 *   POST /api/publik/provision              → the person chose publik (Continue with publik API)
 *   POST /api/publik/forget                 → the person chose their own key
 *   POST /api/publik/disconnect             → same as forget
 *   GET  /api/publik/wallet                 → GET <base_url>/wallet (balance line fallback)
 *   POST /api/publik/chat                   → alias of /api/publik/v1/chat/completions
 *   *    /api/publik/v1/<allowlisted path>  → streaming passthrough to <base_url>/<path>
 *
 * Pure Node built-ins. */

import { Readable } from "node:stream";
import { DEFAULT_BASE_URL, MODELS, hasAppToken, provision, readCredential, readWallet, resolveProvider, setChoice } from "./publik.mjs";

/* The version of the cost + data-path disclosure text the renderer shows
   (src/lib/publikCopy.ts). The renderer compares it with its own ack. */
export const DISCLOSURE_VERSION = 2;
/* Key format the gateway mints (contract §1). */
export const KEY_FORMAT = /^pk_(live|test)_[a-z0-9]{12}_[a-z0-9]{32}$/;

/* Contract §1: Vercel answers 413 above 4.5 MB; apps keep requests under 4 MB.
   The renderer chunks audio to stay under this; anything bigger is a bug we
   answer locally instead of paying a round trip for. */
export const MAX_UPSTREAM_BODY = 4 * 1024 * 1024;

/* method + gateway path → allowed. Everything else under /v1/ is 404 so the
   renderer can never turn the proxy into a generic open relay. */
const ALLOWED = new Set([
  "POST chat/completions",
  "POST audio/transcriptions",
  "POST audio/speech",
  "POST embeddings",
  "GET models",
]);

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { code: "too_large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  try {
    const buf = await readBody(req, 64 * 1024);
    return buf.length ? JSON.parse(buf.toString("utf8")) : {};
  } catch {
    return {};
  }
}

/* Headers the renderer is allowed to see. x-publik-* carry the balance line
   (contract §1); the rest keep streaming and error bodies intact. */
function passthroughHeaders(upstream) {
  const out = { "cache-control": "no-store" };
  for (const [k, v] of upstream.headers) {
    const key = k.toLowerCase();
    if (key.startsWith("x-publik-") || key === "content-type" || key === "retry-after") out[key] = v;
  }
  return out;
}

/* The key this computer uses for publik API right now (publik.mjs
   resolveProvider: PUBLIK_API_KEY in the environment, else the install key
   when the stored choice is "publik"), or null. The user's own key is never
   read here. */
function resolveCredential() {
  const p = resolveProvider(null);
  if (p.kind !== "publik") return null;
  return { key: p.apiKey, base_url: p.baseURL, source: process.env.PUBLIK_API_KEY ? "env" : "file" };
}

/* What the renderer may see. The key is deliberately NOT included: the
   renderer reaches the gateway only through this proxy, which attaches it. */
export function status() {
  const c = readCredential();
  const live = resolveCredential();
  const available = hasAppToken() || !!c || !!process.env.PUBLIK_API_KEY;
  const base = { available, baseUrl: "/api/publik/v1", disclosureVersion: DISCLOSURE_VERSION };
  if (!live) return { ...base, state: "unprovisioned" };
  return {
    ...base,
    state: "ready",
    source: live.source,
    models: { ...MODELS },
    dialects: ["chat_completions"],
    lines: null,
    // Contract §11.4: claim links live on https://publikhq.com/ only.
    claimUrl: c && typeof c.claim_url === "string" && /^https:\/\/publikhq\.com\//.test(c.claim_url) ? c.claim_url : null,
    claimCode: null,
    installId: c?.install_id ?? (live.source === "env" ? "env" : undefined),
    starterMicros: null,
    balanceMicros: null,
    mintedAt: null,
  };
}

export function createPublikHandler(opts = {}) {
  // Older callers pass { token, appVersion, credentialFile, baseUrl, fetchImpl };
  // the module reads the token, the version and the credential itself.
  void opts;
  const baseUrl = DEFAULT_BASE_URL.replace(/\/$/, "");

  /* A pk_ key pasted into the BYO field rides along as Authorization; it wins
     over the machine credential for that request so "my own publik key" is
     honoured exactly like an sk- key would be. */
  function credentialForRequest(req) {
    const m = /^Bearer\s+(pk_[a-z0-9_]+)$/i.exec(req.headers.authorization ?? "");
    if (m && KEY_FORMAT.test(m[1])) return { key: m[1], base_url: baseUrl, source: "header" };
    return resolveCredential();
  }

  async function proxy(req, res, gatewayPath) {
    // Only GET and POST. (HEAD, PUT and the rest were sent on as POST before.)
    const method = req.method;
    if (!ALLOWED.has(`${method} ${gatewayPath}`)) {
      return sendJson(res, 404, { error: { type: "unknown_endpoint", message: "unknown endpoint" } });
    }
    let cred = credentialForRequest(req);
    if (!cred) {
      return sendJson(res, 401, {
        error: {
          type: "no_publik_credential",
          message: "publik API is not set up on this computer.",
          reprovision: false,
          disconnected: false,
        },
      });
    }

    let body = null;
    if (method !== "GET") {
      try {
        body = await readBody(req, MAX_UPSTREAM_BODY);
      } catch (err) {
        if (err?.code === "too_large") {
          return sendJson(res, 413, {
            error: {
              type: "request_too_large",
              message: "This request is over 4 MB. Split the audio into shorter clips and try again.",
            },
          });
        }
        return sendJson(res, 400, { error: { type: "bad_request", message: "could not read request body" } });
      }
    }

    const controller = new AbortController();
    // The renderer going away (navigation, cancel) aborts our upstream read.
    // The gateway keeps consuming the model stream and settles regardless
    // (contract §3.1) — this only saves bandwidth.
    req.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    const send = async (c) => {
      const headers = { authorization: `Bearer ${c.key}`, accept: req.headers.accept ?? "*/*" };
      if (body) headers["content-type"] = req.headers["content-type"] ?? "application/json";
      return fetch(`${c.base_url}/${gatewayPath}`, {
        method,
        headers,
        body: body ?? undefined,
        signal: controller.signal,
      });
    };

    let upstream;
    try {
      upstream = await send(cred);
    } catch (err) {
      if (controller.signal.aborted) return res.destroy();
      return sendJson(res, 502, {
        error: {
          type: "gateway_unreachable",
          message: "publik API is unreachable right now. Nothing is being charged. Try again in a minute, or use your own key.",
          detail: err instanceof Error ? err.message : String(err),
        },
      });
    }

    /* 401 key_revoked (contract §1): the install key is gone. The module
       provisions a new one (publik.mjs provision(): the same install id, or a
       fresh one when the install was revoked) and the request is sent once
       more. Only the machine credential is eligible; a pasted key is the
       user's business, and PUBLIK_API_KEY is the developer's. */
    if (upstream.status === 401) {
      let errBody = null;
      try {
        errBody = await upstream.json();
      } catch {
        /* not JSON */
      }
      const type = errBody?.error?.type;
      // A GET (GET /models) never changes state: no re-provision.
      if (type === "key_revoked" && method === "GET") {
        return sendJson(res, 401, errBody, passthroughHeaders(upstream));
      }
      if (type === "key_revoked" && cred.source === "file") {
        let fresh = null;
        try {
          fresh = await provision();
        } catch {
          fresh = null;
        }
        if (fresh) {
          cred = { key: fresh.key, base_url: fresh.base_url || baseUrl, source: "file" };
          try {
            upstream = await send(cred);
          } catch {
            return sendJson(res, 502, { error: { type: "gateway_unreachable", message: "publik API is unreachable right now." } });
          }
          if (upstream.status !== 401) return pipe(upstream, res);
          try {
            errBody = await upstream.json();
          } catch {
            errBody = null;
          }
        }
        return sendJson(
          res,
          401,
          { error: { ...(errBody?.error ?? { type: "key_revoked", message: "publik API is disconnected." }), disconnected: true } },
          passthroughHeaders(upstream),
        );
      }
      return sendJson(res, 401, errBody ?? { error: { type: "invalid_api_key", message: "publik API rejected this key." } }, passthroughHeaders(upstream));
    }

    return pipe(upstream, res);
  }

  function pipe(upstream, res) {
    res.writeHead(upstream.status, passthroughHeaders(upstream));
    if (!upstream.body) return res.end();
    const stream = Readable.fromWeb(upstream.body);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  /* Returns true when the request was handled. */
  return async function handlePublik(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith("/api/publik/")) return false;

    if (p === "/api/publik/status" && req.method === "GET") {
      sendJson(res, 200, status());
      return true;
    }

    if (p === "/api/publik/provision" && req.method === "POST") {
      // "Continue with publik API": the person chose publik for this app. The
      // install key exists since the Sign in with publik gate; when it does
      // not (a dev run with no gate), the module provisions it here.
      await readJson(req);
      if (process.env.PUBLIK_API_KEY) {
        sendJson(res, 200, { ok: true, minted: false, reason: null, ...status() });
        return true;
      }
      let minted = false;
      try {
        if (!readCredential()) {
          await provision();
          minted = true;
        }
        setChoice("publik");
        const s = status();
        sendJson(res, 200, { ok: s.state === "ready", minted, reason: s.state === "ready" ? null : "no_publik_credential", ...s });
      } catch (err) {
        sendJson(res, 200, { ok: false, minted: false, reason: err instanceof Error ? err.message : "provision failed", ...status() });
      }
      return true;
    }

    if (p === "/api/publik/forget" || p === "/api/publik/disconnect") {
      if (req.method !== "POST") return false;
      // "Use my own key": the key stays on this computer for the sign-in and
      // the usage counts; the app stops using it for AI.
      setChoice("own_key");
      sendJson(res, 200, { ok: true, ...status() });
      return true;
    }

    if (p === "/api/publik/wallet" && req.method === "GET") {
      const c = credentialForRequest(req);
      if (!c) {
        sendJson(res, 404, { error: { type: "no_publik_credential", message: "publik API is not set up on this computer." } });
        return true;
      }
      try {
        const w = await readWallet(c.key);
        sendJson(res, w.status, w.wallet ?? { error: { type: w.status === 401 ? "key_revoked" : "bad_response", message: w.message ?? `wallet ${w.status}` } });
      } catch (err) {
        sendJson(res, 502, { error: { type: "gateway_unreachable", message: err instanceof Error ? err.message : "wallet failed" } });
      }
      return true;
    }

    if (p === "/api/publik/chat") {
      await proxy(req, res, "chat/completions");
      return true;
    }

    if (p.startsWith("/api/publik/v1/")) {
      await proxy(req, res, p.slice("/api/publik/v1/".length).replace(/\/+$/, ""));
      return true;
    }

    sendJson(res, 404, { error: { type: "unknown_endpoint", message: "unknown endpoint" } });
    return true;
  };
}
