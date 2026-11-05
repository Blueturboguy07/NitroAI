/* GET /api/fetch-page?url=<http or https URL>
 *
 * The Website-link reader's download. The renderer is a web page served from
 * http://127.0.0.1:<port>, so its own fetch() of most sites fails with
 * "Failed to fetch" (the site sends no CORS header for that origin). This
 * route downloads the page in Node, where CORS does not apply, and gives the
 * bytes back. The renderer still runs the shared text check, the HTML
 * reader and the 2 MB text limit (src/lib/ingest/url.ts).
 *
 *   200  the page bytes; x-nitroai-content-type = the site's content-type,
 *        x-nitroai-final-url = the URL after redirects
 *   4xx/5xx  JSON { error: "bad_url" | "bad_scheme" | "blocked" | "too_large"
 *        | "status" | "network" | "timeout", status?, limit?, reason? }
 *   Every answer has x-nitroai-page: 1, so the renderer can tell this route
 *   from a host that does not have it.
 *
 * Who may call it: the one guard in front of every /api/* route
 * (localGuard.mjs) — only the app itself.
 *
 * Where it may go (round 6): only http and https, and only to public
 * addresses. The host name is resolved, and the request is refused when ANY
 * address is loopback, private, link-local, unspecified, multicast or
 * reserved (blockedAddress below). The check runs inside the connection's
 * own DNS lookup, so the socket connects to the address that was checked:
 * a name that answers a public address to the check and 127.0.0.1 to the
 * connect (DNS rebinding) cannot get past it. Redirects are followed by
 * hand, and every hop is checked the same way. At most MAX_PAGE_BYTES are
 * read, after decompression. Node built-ins only. */

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";

export const MAX_PAGE_BYTES = 8 * 1024 * 1024;
export const PAGE_TIMEOUT_MS = 30_000;
export const MAX_REDIRECTS = 10;

const DEFAULT_UA = "Mozilla/5.0 (compatible; NitroAI)";

/* ---- Addresses ----------------------------------------------------------- */

const V4_BLOCKS = [
  ["0.0.0.0", 8], // "this network", 0.0.0.0 (unspecified)
  ["10.0.0.0", 8], // private (RFC 1918)
  ["100.64.0.0", 10], // shared address space (carrier NAT)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata at 169.254.169.254)
  ["172.16.0.0", 12], // private (RFC 1918)
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private (RFC 1918)
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and 255.255.255.255
];

function v4Number(ip) {
  return ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

function blockedV4(ip) {
  const n = v4Number(ip);
  return V4_BLOCKS.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4Number(base) / 2 ** (32 - bits)));
}

/* "fe80::1%en0", "::ffff:127.0.0.1" → 8 numbers. */
function v6Groups(ip) {
  let s = ip.split("%")[0].toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const n = v4Number(tail[1]);
    s = s.slice(0, -tail[1].length) + `${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const [head, rest] = s.split("::");
  const a = head ? head.split(":") : [];
  const b = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const fill = rest !== undefined ? 8 - a.length - b.length : 0;
  return [...a, ...Array(fill).fill("0"), ...b].map((g) => parseInt(g || "0", 16));
}

function blockedV6(ip) {
  const g = v6Groups(ip);
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.every((x) => x === 0)) return true; // :: unspecified
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1 loopback
  // IPv6 forms with an IPv4 address inside: the inner address is checked.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return blockedV4(v4(g[6], g[7])); // ::ffff:a.b.c.d (mapped)
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return blockedV4(v4(g[6], g[7])); // ::ffff:0:a.b.c.d (translated, ::ffff:0:0/96)
  if (g.slice(0, 6).every((x) => x === 0)) return blockedV4(v4(g[6], g[7])); // ::a.b.c.d (old form)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return blockedV4(v4(g[6], g[7])); // 64:ff9b::/96 NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  if (g[0] === 0x2002) return blockedV4(v4(g[1], g[2])); // 2002::/16 6to4
  if (g[0] === 0x2001 && g[1] === 0) {
    // 2001::/32 Teredo: the server's IPv4 in plain, the client's inverted.
    return blockedV4(v4(g[2], g[3])) || blockedV4(v4(~g[6] & 0xffff, ~g[7] & 0xffff));
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (private)
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 old site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

/* True for an address a public web page never has. */
export function blockedAddress(ip) {
  const bare = String(ip).replace(/^\[|\]$/g, "");
  const family = net.isIP(bare.split("%")[0]);
  if (family === 4) return blockedV4(bare);
  if (family === 6) return blockedV6(bare);
  return true; // not an address
}

/* ---- Download ------------------------------------------------------------ */

class PageError extends Error {
  constructor(code, fields = {}) {
    super(code);
    this.code = code;
    this.fields = fields;
  }
}

function answer(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-nitroai-page": "1" });
  res.end(JSON.stringify(body));
}

/* The cause of a failure, in words. */
function networkReason(err) {
  const code = String(err?.code ?? err?.cause?.code ?? "");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NODATA" || code === "EAI_NONAME") return "the site was not found";
  if (code === "ECONNREFUSED") return "the site refused the connection";
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ERR_STREAM_PREMATURE_CLOSE") return "the connection was closed";
  if (/CERT|SSL|TLS/i.test(code)) return "the site's security certificate is not valid";
  if (/^Z_|^ERR_ZLIB|^ERR_BROTLI/i.test(code)) return "the site sent data NitroAI cannot unpack";
  return "the site could not be reached";
}

/* A DNS lookup for http.request that refuses blocked addresses. It is the
   lookup the socket itself uses, so the address checked is the address the
   socket connects to. `resolve` and `allowHosts` are test hooks. */
export function checkedLookup(resolve, allowed) {
  return (hostname, options, callback) => {
    const opts = typeof options === "object" && options ? options : {};
    resolve(hostname, { all: true, family: opts.family ?? 0 }, (err, addresses) => {
      if (err) return callback(err);
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }]).filter((a) => a && a.address);
      const bad = list.find((a) => blockedAddress(a.address));
      if (!list.length || (bad && !allowed)) {
        return callback(Object.assign(new Error(`blocked address ${bad?.address ?? "none"}`), { code: "EBLOCKED" }));
      }
      if (opts.all) return callback(null, list.map((a) => ({ address: a.address, family: a.family || net.isIP(a.address) })));
      callback(null, list[0].address, list[0].family || net.isIP(list[0].address));
    });
  };
}

/* One GET, no redirects followed. */
function getOnce(target, headers, signal, opts) {
  return new Promise((resolve, reject) => {
    const host = target.hostname.replace(/^\[|\]$/g, "");
    const allowed = (opts.allowHosts ?? []).includes(`${host}:${target.port || (target.protocol === "https:" ? 443 : 80)}`);
    // An address in the URL is not looked up, so it is checked here.
    if (net.isIP(host) && blockedAddress(host) && !allowed) return reject(new PageError("blocked"));
    const mod = target.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: host,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers,
        agent: false, // a new, checked connection for every request
        lookup: checkedLookup(opts.resolve ?? dns.lookup, allowed),
        servername: net.isIP(host) ? undefined : host,
        signal,
      },
      resolve,
    );
    req.on("error", (err) => reject(err?.code === "EBLOCKED" ? new PageError("blocked") : err));
    req.end();
  });
}

function checkTarget(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new PageError("bad_scheme");
  if (u.username || u.password) throw new PageError("bad_url");
}

/* At most this many Content-Encoding layers are unpacked (round 8, I2). */
export const MAX_ENCODINGS = 2;

function decoders(encoding) {
  const list = String(encoding ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e && e !== "identity");
  if (list.length > MAX_ENCODINGS) {
    throw new PageError("network", {
      reason: `the site packed the page ${list.length} times, and NitroAI unpacks a page at most ${MAX_ENCODINGS} times`,
    });
  }
  if (list.some((e) => !["gzip", "x-gzip", "deflate", "br"].includes(e))) {
    throw new PageError("network", { reason: "the site sent data NitroAI cannot unpack" });
  }
  return list.reverse().map((e) => {
    if (e === "gzip" || e === "x-gzip") return zlib.createGunzip();
    if (e === "deflate") return zlib.createInflate();
    if (e === "br") return zlib.createBrotliDecompress();
    throw new PageError("network", { reason: "the site sent data NitroAI cannot unpack" });
  });
}

async function download(start, headers, signal, limit, opts) {
  let current = start;
  for (let hop = 0; ; hop++) {
    checkTarget(current);
    const res = await getOnce(current, { ...headers, host: current.host }, signal, opts);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= MAX_REDIRECTS) throw new PageError("network", { reason: "the site redirected too many times" });
      try {
        current = new URL(res.headers.location, current);
      } catch {
        throw new PageError("network", { reason: "the site redirected to a link that is not valid" });
      }
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new PageError("status", { status });
    }
    const declared = Number(res.headers["content-length"] ?? "");
    let unpack;
    try {
      unpack = decoders(res.headers["content-encoding"]);
    } catch (err) {
      res.destroy();
      throw err;
    }
    if (!unpack.length && Number.isFinite(declared) && declared > limit) {
      res.destroy();
      throw new PageError("too_large", { limit });
    }
    const parts = [];
    let total = 0;
    let over = false;
    try {
      await pipeline(
        res,
        ...unpack,
        async function (source) {
          for await (const chunk of source) {
            total += chunk.length;
            if (total > limit) {
              over = true;
              throw new PageError("too_large", { limit });
            }
            parts.push(chunk);
          }
        },
        { signal },
      );
    } catch (err) {
      // Some Node versions (seen: 18.20, 21.5, 22.23 and 24.7; not 24.18)
      // report the stop as an AbortError, not as the error thrown above
      // (round 8, D2). The flag says what happened.
      if (over) throw new PageError("too_large", { limit });
      throw err;
    }
    return { body: Buffer.concat(parts), contentType: res.headers["content-type"] ?? "", finalUrl: current.href };
  }
}

/* `opts` (tests only): maxBytes, timeoutMs, resolve (a dns.lookup stand-in),
   allowHosts ("host:port" names that skip the address check). */
export async function handleFetchPage(req, res, url, opts = {}) {
  if (req.method !== "GET") return answer(res, 405, { error: "bad_url" });

  let target;
  try {
    target = new URL(url.searchParams.get("url") ?? "");
    checkTarget(target);
  } catch (err) {
    return answer(res, 400, { error: err instanceof PageError ? err.code : "bad_url" });
  }

  const signal = AbortSignal.timeout(opts.timeoutMs ?? PAGE_TIMEOUT_MS);
  const headers = {
    // The renderer's own User-Agent, as its fetch() would have sent.
    "user-agent": String(req.headers["user-agent"] || DEFAULT_UA),
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
    "accept-language": String(req.headers["accept-language"] || "en"),
    "accept-encoding": "gzip, deflate, br",
  };
  let page;
  try {
    page = await download(target, headers, signal, opts.maxBytes ?? MAX_PAGE_BYTES, opts);
  } catch (err) {
    if (err instanceof PageError) {
      if (err.code === "blocked") {
        return answer(res, 403, { error: "blocked", reason: "the link points to this computer or a private network" });
      }
      if (err.code === "too_large") return answer(res, 413, { error: "too_large", ...err.fields });
      if (err.code === "status") return answer(res, 502, { error: "status", ...err.fields });
      if (err.code === "bad_scheme" || err.code === "bad_url") return answer(res, 400, { error: err.code });
      return answer(res, 502, { error: "network", reason: err.fields.reason ?? "the site could not be reached" });
    }
    if (signal.aborted) return answer(res, 504, { error: "timeout" });
    return answer(res, 502, { error: "network", reason: networkReason(err) });
  }

  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(page.body.length),
    "cache-control": "no-store",
    "x-nitroai-page": "1",
    "x-nitroai-content-type": page.contentType,
    "x-nitroai-final-url": page.finalUrl,
  });
  res.end(page.body);
}
