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
 *   4xx/5xx  JSON { error: "bad_url" | "bad_scheme" | "too_large" | "status"
 *        | "network" | "timeout" | "forbidden", status?, limit?, reason? }
 *   Every answer has x-nitroai-page: 1, so the renderer can tell this route
 *   from a host that does not have it.
 *
 * Only http and https. At most MAX_PAGE_BYTES are downloaded. Requests must
 * come from the app itself: the Host must be this server (a page on another
 * site that points a DNS name at 127.0.0.1 cannot read the answer) and the
 * x-nitroai-fetch header must be set (a page on another site cannot send it
 * without a CORS preflight, which this server never allows). Pure Node. */

export const MAX_PAGE_BYTES = 8 * 1024 * 1024;
export const PAGE_TIMEOUT_MS = 30_000;

const DEFAULT_UA = "Mozilla/5.0 (compatible; NitroAI)";

function answer(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-nitroai-page": "1" });
  res.end(JSON.stringify(body));
}

/* The cause of a Node fetch failure, in words. */
function networkReason(err) {
  const code = err?.cause?.code ?? err?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "the site was not found";
  if (code === "ECONNREFUSED") return "the site refused the connection";
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "the connection was closed";
  if (/CERT|SSL|TLS/i.test(String(code))) return "the site's security certificate is not valid";
  if (/redirect/i.test(String(err?.cause?.message ?? err?.message ?? ""))) return "the site redirected too many times";
  return "the site could not be reached";
}

/* `opts.port()` → the port this server listens on (for the Host check);
   `opts.fetchImpl` → a fetch for tests (default: the global one). */
export async function handleFetchPage(req, res, url, opts = {}) {
  const port = opts.port?.();
  const host = String(req.headers.host ?? "").toLowerCase();
  const fromApp = req.headers["x-nitroai-fetch"] === "1";
  if (!fromApp || (port && host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
    return answer(res, 403, { error: "forbidden" });
  }
  if (req.method !== "GET") return answer(res, 405, { error: "bad_url" });

  let target;
  try {
    target = new URL(url.searchParams.get("url") ?? "");
  } catch {
    return answer(res, 400, { error: "bad_url" });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return answer(res, 400, { error: "bad_scheme" });
  if (target.username || target.password) return answer(res, 400, { error: "bad_url" });

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? PAGE_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetchImpl(target.href, {
      redirect: "follow",
      signal,
      headers: {
        // The renderer's own User-Agent, as its fetch() would have sent.
        "user-agent": String(req.headers["user-agent"] || DEFAULT_UA),
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "accept-language": String(req.headers["accept-language"] || "en"),
      },
    });
  } catch (err) {
    if (signal.aborted) return answer(res, 504, { error: "timeout" });
    return answer(res, 502, { error: "network", reason: networkReason(err) });
  }
  // fetch follows only http and https redirects; check the end anyway.
  const finalUrl = upstream.url || target.href;
  if (!/^https?:/i.test(finalUrl)) {
    void upstream.body?.cancel();
    return answer(res, 400, { error: "bad_scheme" });
  }
  if (!upstream.ok) {
    void upstream.body?.cancel();
    return answer(res, 502, { error: "status", status: upstream.status });
  }

  const limit = opts.maxBytes ?? MAX_PAGE_BYTES;
  const declared = Number(upstream.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    void upstream.body?.cancel();
    return answer(res, 413, { error: "too_large", limit });
  }
  const parts = [];
  let total = 0;
  try {
    if (upstream.body) {
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > limit) {
          void reader.cancel();
          return answer(res, 413, { error: "too_large", limit });
        }
        parts.push(value);
      }
    }
  } catch (err) {
    if (signal.aborted) return answer(res, 504, { error: "timeout" });
    return answer(res, 502, { error: "network", reason: networkReason(err) });
  }

  const body = Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(body.length),
    "cache-control": "no-store",
    "x-nitroai-page": "1",
    "x-nitroai-content-type": upstream.headers.get("content-type") ?? "",
    "x-nitroai-final-url": finalUrl,
  });
  res.end(body);
}
