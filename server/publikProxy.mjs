/* The renderer's only door to publik API. Mounted under /api/publik/ by
 * httpServer.mjs. Why a proxy: the renderer is a plain web page served from
 * http://127.0.0.1:<port>; a direct fetch to publikhq.com would be a
 * cross-origin request the gateway deliberately refuses (contract §1, CORS),
 * and the pk_ key must never enter the renderer anyway. So the local server
 * — the process that owns the credential — forwards the request with the
 * key attached and pipes the (streaming) answer straight back.
 *
 *   GET  /api/publik/status                 → is publik available / provisioned / disconnected
 *   POST /api/publik/provision              → mint (only after the disclosure was accepted)
 *   POST /api/publik/forget                 → drop the credential on this machine
 *   POST /api/publik/disconnect             → self-revoke at the gateway, then forget
 *   GET  /api/publik/wallet                 → GET <base_url>/wallet (balance line fallback)
 *   POST /api/publik/chat                   → alias of /api/publik/v1/chat/completions
 *   *    /api/publik/v1/<allowlisted path>  → streaming passthrough to <base_url>/<path>
 *
 * Pure Node built-ins. */

import { Readable } from "node:stream";
import {
  DISCLOSURE_VERSION,
  PUBLIK_BASE_URL,
  KEY_FORMAT,
  credentialForRenderer,
  credentialPath,
  envCredential,
  forget,
  isLive,
  markDisconnected,
  provision,
  readCredentialFile,
  revoke,
  wallet,
} from "./publik.mjs";

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

export function createPublikHandler(opts = {}) {
  const token = opts.token ?? null;
  const appVersion = opts.appVersion ?? "dev";
  const file = opts.credentialFile ?? credentialPath();
  const baseUrl = (opts.baseUrl ?? PUBLIK_BASE_URL).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;

  /* env → file → nothing. The user's own key is never read here. */
  function resolveCredential() {
    return envCredential() ?? readCredentialFile(file);
  }

  function status() {
    const c = resolveCredential();
    const available = !!token || !!c;
    return { ...credentialForRenderer(c, { available }), disclosureVersion: DISCLOSURE_VERSION };
  }

  /* A pk_ key pasted into the BYO field rides along as Authorization; it wins
     over the machine credential for that request so "my own publik key" is
     honoured exactly like an sk- key would be. */
  function credentialForRequest(req) {
    const m = /^Bearer\s+(pk_[a-z0-9_]+)$/i.exec(req.headers.authorization ?? "");
    if (m && KEY_FORMAT.test(m[1])) return { key: m[1], base_url: baseUrl, source: "header" };
    const c = resolveCredential();
    return c && isLive(c) ? c : null;
  }

  async function proxy(req, res, gatewayPath) {
    const method = req.method === "GET" ? "GET" : "POST";
    if (!ALLOWED.has(`${method} ${gatewayPath}`)) {
      return sendJson(res, 404, { error: { type: "unknown_endpoint", message: "unknown endpoint" } });
    }
    let cred = credentialForRequest(req);
    if (!cred) {
      const s = status();
      return sendJson(res, 401, {
        error: {
          type: s.state === "disconnected" ? "key_revoked" : "no_publik_credential",
          message:
            s.state === "disconnected"
              ? "publik API is disconnected. This computer was removed from your publik account."
              : "publik API is not set up on this computer.",
          reprovision: false,
          disconnected: s.state === "disconnected",
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
      return fetchImpl(`${c.base_url}/${gatewayPath}`, {
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

    /* 401 key_revoked (contract §1): reprovision:true (idle sweep) → silently
       re-mint with the same install_id and retry once; reprovision:false →
       mark disconnected, never re-mint on our own. Only the machine
       credential is eligible; a pasted key is the user's business. */
    if (upstream.status === 401) {
      let errBody = null;
      try {
        errBody = await upstream.json();
      } catch {
        /* not JSON */
      }
      const type = errBody?.error?.type;
      if (type === "key_revoked" && cred.source !== "header" && cred.source !== "env") {
        if (errBody.error.reprovision === true) {
          const r = await provision({ token, file, appVersion, baseUrl, force: true, fetchImpl });
          if (r.credential && isLive(r.credential)) {
            cred = r.credential;
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
        }
        if (errBody?.error?.type === "key_revoked" && errBody.error.reprovision !== true) markDisconnected(file);
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
      // Consent precedes mint (contract §3.2 [S4]): the renderer calls this
      // only after the disclosure was accepted. A user-initiated Reconnect
      // after a dashboard revoke passes {force:true} and starts a fresh install.
      const input = await readJson(req);
      if (envCredential()) {
        sendJson(res, 200, { ok: true, minted: false, ...status() });
        return true;
      }
      try {
        const r = await provision({
          token,
          file,
          appVersion,
          baseUrl,
          disclosureVersion: Number.isInteger(input.disclosure_version) && input.disclosure_version >= 1 ? input.disclosure_version : DISCLOSURE_VERSION,
          force: input.force === true,
          fetchImpl,
        });
        sendJson(res, 200, { ok: !!r.credential, minted: r.minted, reason: r.reason ?? null, ...status() });
      } catch (err) {
        sendJson(res, 200, { ok: false, minted: false, reason: err instanceof Error ? err.message : "provision failed", ...status() });
      }
      return true;
    }

    if (p === "/api/publik/forget" && req.method === "POST") {
      forget(file);
      sendJson(res, 200, { ok: true, ...status() });
      return true;
    }

    if (p === "/api/publik/disconnect" && req.method === "POST") {
      const c = readCredentialFile(file);
      if (c && isLive(c)) await revoke(c, fetchImpl);
      forget(file);
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
        const w = await wallet(c, fetchImpl);
        if (w.status === 401 && w.body?.error?.type === "key_revoked" && c.source !== "header" && c.source !== "env") {
          if (w.body.error.reprovision !== true) markDisconnected(file);
        }
        sendJson(res, w.status, w.body ?? { error: { type: "bad_response", message: `wallet ${w.status}` } });
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

    sendJson(res, 404, { error: "unknown endpoint" });
    return true;
  };
}
