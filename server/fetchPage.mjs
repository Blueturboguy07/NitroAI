/* Server-side web page fetch for "Import from URL".
 *
 * The renderer can't fetch arbitrary sites itself: almost no site sends CORS
 * headers, so the browser blocks the read. The local server (desktop shell,
 * `npm run serve`, or the vite dev/preview plugin) fetches the page instead
 * and hands the HTML back over GET /api/fetch-page?url=.
 *
 * A server that fetches URLs for a web page is an SSRF risk, so:
 *   - only http: and https: URLs;
 *   - the host's DNS answers are checked BEFORE connecting, inside the socket's
 *     own lookup, so the address we vet is the address we connect to (no
 *     rebinding window between check and connect); if ANY answer is a private,
 *     loopback, link-local, multicast or reserved address the fetch is refused;
 *     IP-literal hosts are checked directly (Node skips lookup for them);
 *   - redirects are followed by hand (max 5) and every hop is re-validated;
 *   - the body is capped at 5 MB (after decompression) and the whole fetch at
 *     15 s.
 *
 * Pure Node built-ins. */

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

export const FETCH_PAGE_MAX_BYTES = 5 * 1024 * 1024;
export const FETCH_PAGE_TIMEOUT_MS = 15_000;
export const FETCH_PAGE_MAX_REDIRECTS = 5;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 NitroAI";

/* code → HTTP status the local route answers with. */
const HTTP_STATUS = {
  invalid_url: 400,
  blocked_address: 403,
  unsupported_type: 415,
  too_large: 413,
  timeout: 504,
  dns: 502,
  network: 502,
  upstream_status: 502,
  too_many_redirects: 502,
};

export class FetchPageError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "FetchPageError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/* ---------- private-address detection ---------- */

const V4_BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata lives here)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
]) {
  V4_BLOCKED.addSubnet(addr, prefix, "ipv4");
}

const V6_BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo (tunnels to arbitrary IPv4)
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
]) {
  V6_BLOCKED.addSubnet(addr, prefix, "ipv6");
}

/* "::ffff:7f00:1" → [0,0,0,0,0,0xffff,0x7f00,1]. Assumes net.isIPv6(ip). */
function ipv6Hextets(ip) {
  let s = ip.toLowerCase();
  const m = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (m) {
    const [a, b, c, d] = m.slice(1).map(Number);
    s = `${s.slice(0, -m[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const parts =
    tail === undefined ? h : [...h, ...Array(8 - h.length - (tail ? tail.split(":").length : 0)).fill("0"), ...(tail ? tail.split(":") : [])];
  return parts.map((x) => parseInt(x, 16) || 0);
}

function v4From(hi, lo) {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/* True for any address a page fetch must never reach: private, loopback,
   link-local, CGNAT, multicast, reserved — including IPv4 hidden inside IPv6
   (mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, NAT64 64:ff9b::/96, 6to4
   2002::/16). Anything that isn't a valid IP is treated as blocked. */
export function isPrivateAddress(address) {
  if (typeof address !== "string") return true;
  let ip = address.trim();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone); // zone ids only exist on link-local
  const kind = net.isIP(ip);
  if (kind === 4) return V4_BLOCKED.check(ip, "ipv4");
  if (kind !== 6) return true;

  const x = ipv6Hextets(ip);
  if (x.length !== 8) return true;
  const zeros = (from, to) => x.slice(from, to).every((v) => v === 0);
  if (zeros(0, 5) && x[5] === 0xffff) return V4_BLOCKED.check(v4From(x[6], x[7]), "ipv4"); // mapped
  if (zeros(0, 6)) return V4_BLOCKED.check(v4From(x[6], x[7]), "ipv4"); // compatible (also :: and ::1)
  if (x[0] === 0x64 && x[1] === 0xff9b && zeros(2, 6)) return V4_BLOCKED.check(v4From(x[6], x[7]), "ipv4"); // NAT64
  if (x[0] === 0x2002) return V4_BLOCKED.check(v4From(x[1], x[2]), "ipv4"); // 6to4
  return V6_BLOCKED.check(ip, "ipv6");
}

/* ---------- URL validation ---------- */

function bareHostname(u) {
  const h = u.hostname;
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

/* Parse and vet one URL (the original, or a redirect target). */
export function validateTargetUrl(input, isBlocked = isPrivateAddress) {
  if (typeof input !== "string" || !input.trim() || input.length > 4096) {
    throw new FetchPageError("invalid_url", "That isn't a valid web address.");
  }
  let u;
  try {
    u = new URL(input.trim());
  } catch {
    throw new FetchPageError("invalid_url", "That isn't a valid web address.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new FetchPageError("invalid_url", "Only http:// and https:// links can be imported.");
  }
  const host = bareHostname(u).toLowerCase();
  if (!host) throw new FetchPageError("invalid_url", "That isn't a valid web address.");
  if (net.isIP(host) ? isBlocked(host) : host === "localhost" || host.endsWith(".localhost")) {
    throw blockedError();
  }
  u.hash = "";
  return u;
}

function blockedError() {
  return new FetchPageError(
    "blocked_address",
    "That link points to this computer or a private network address, which NitroAI won't fetch.",
  );
}

/* ---------- fetching ---------- */

function defaultResolve(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

/* A net/tls `lookup` that vets every DNS answer before the socket connects. */
function guardedLookup(resolve, isBlocked) {
  return (hostname, options, callback) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    Promise.resolve()
      .then(() => resolve(hostname))
      .then((answers) => {
        let list = (answers ?? []).filter((a) => a && typeof a.address === "string");
        if (list.some((a) => isBlocked(a.address))) throw blockedError();
        if (options?.family === 4 || options?.family === 6) list = list.filter((a) => a.family === options.family);
        if (!list.length) {
          throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND", hostname });
        }
        const norm = list.map((a) => ({ address: a.address, family: a.family ?? net.isIP(a.address) }));
        if (options?.all) callback(null, norm);
        else callback(null, norm[0].address, norm[0].family);
      })
      .catch((err) => callback(err));
  };
}

function requestOnce(u, { lookup, signal }) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      {
        method: "GET",
        agent: false, // no pooled sockets: every hop connects (and is vetted) afresh
        lookup,
        signal,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "en-US,en;q=0.9",
        },
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

const TEXTUAL = /^(text\/|application\/(xhtml\+xml|xml|rss\+xml|atom\+xml)\b)/i;

function readBody(res, maxBytes) {
  return new Promise((resolve, reject) => {
    const enc = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
    let stream = res;
    if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
    else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
    else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      res.destroy();
      if (stream !== res) stream.destroy();
      reject(err);
    };
    stream.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) return fail(tooLarge(maxBytes));
      chunks.push(c);
    });
    stream.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    stream.on("error", fail);
    res.on("error", fail);
    res.on("aborted", () => fail(Object.assign(new Error("aborted"), { code: "ECONNRESET" })));
  });
}

function tooLarge(maxBytes) {
  return new FetchPageError("too_large", `That page is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`);
}

function decode(buf, contentType) {
  let charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? "")?.[1];
  if (!charset) {
    charset = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(buf.subarray(0, 4096).toString("latin1"))?.[1];
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/* Translate low-level failures into a FetchPageError with an honest message. */
function classify(err, u, timedOut, timeoutMs) {
  if (err instanceof FetchPageError) return err;
  if (timedOut) {
    return new FetchPageError("timeout", `The site took longer than ${Math.round(timeoutMs / 1000)} seconds to respond.`);
  }
  const code = err?.code ?? err?.cause?.code;
  const host = u ? bareHostname(u) : "the site";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NODATA" || code === "EAI_NONAME") {
    return new FetchPageError("dns", `Couldn't find the site "${host}". Check the address for typos.`);
  }
  if (typeof code === "string" && (code.startsWith("ERR_TLS") || code.includes("CERT") || code.startsWith("ERR_SSL"))) {
    return new FetchPageError("network", `Couldn't open a secure connection to ${host} (${code}).`);
  }
  return new FetchPageError(
    "network",
    `Couldn't connect to ${host}${code ? ` (${code})` : ""}. The site may be down, or your internet connection may be offline.`,
  );
}

/* Fetch a page. Resolves { url, finalUrl, status, contentType, html } or
   rejects with a FetchPageError. Options exist for tests:
   resolve(hostname) → [{address, family}], isBlockedAddress(ip) → bool,
   maxBytes, timeoutMs, maxRedirects. */
export async function fetchPage(input, opts = {}) {
  const {
    resolve = defaultResolve,
    isBlockedAddress = isPrivateAddress,
    maxBytes = FETCH_PAGE_MAX_BYTES,
    timeoutMs = FETCH_PAGE_TIMEOUT_MS,
    maxRedirects = FETCH_PAGE_MAX_REDIRECTS,
  } = opts;

  let u = validateTargetUrl(input, isBlockedAddress);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const lookup = guardedLookup(resolve, isBlockedAddress);

  try {
    for (let hop = 0; ; hop++) {
      const res = await requestOnce(u, { lookup, signal: controller.signal });
      const status = res.statusCode ?? 0;

      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (hop >= maxRedirects) {
          throw new FetchPageError("too_many_redirects", "The site redirected too many times.");
        }
        let next;
        try {
          next = new URL(res.headers.location, u).href;
        } catch {
          throw new FetchPageError("network", "The site redirected to an invalid address.");
        }
        u = validateTargetUrl(next, isBlockedAddress);
        continue;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        throw new FetchPageError("upstream_status", `The site answered with HTTP ${status}.`, { upstreamStatus: status });
      }

      const contentType = String(res.headers["content-type"] ?? "");
      if (contentType && !TEXTUAL.test(contentType)) {
        res.resume();
        const kind = contentType.split(";")[0].trim();
        throw new FetchPageError(
          "unsupported_type",
          kind === "application/pdf"
            ? "That link is a PDF file, not a web page. Download it and import it as a PDF instead."
            : `That link isn't a web page (it's ${kind}).`,
          { contentType: kind },
        );
      }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.resume();
        throw tooLarge(maxBytes);
      }

      const body = await readBody(res, maxBytes);
      return { url: input, finalUrl: u.href, status, contentType, html: decode(body, contentType) };
    }
  } catch (err) {
    throw classify(err, u, timedOut, timeoutMs);
  } finally {
    clearTimeout(timer);
    controller.abort(); // release any socket still open
  }
}

/* The route's whole behaviour, shared by httpServer.mjs and the vite plugin:
   → { status, body } to send as JSON. */
export async function fetchPageResponse(target, opts) {
  if (!target) return { status: 400, body: { error: "Missing url parameter.", code: "invalid_url" } };
  try {
    return { status: 200, body: await fetchPage(target, opts) };
  } catch (err) {
    const e = err instanceof FetchPageError ? err : classify(err, null, false, 0);
    return {
      status: HTTP_STATUS[e.code] ?? 502,
      body: { error: e.message, code: e.code, ...(e.upstreamStatus ? { upstreamStatus: e.upstreamStatus } : {}) },
    };
  }
}
