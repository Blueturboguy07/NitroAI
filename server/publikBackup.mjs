/* The library backup: one kept file in the person's publik account.
 *
 * NitroAI keeps the library in the browser database of one computer. With
 * this module the local server can save one snapshot of the library to the
 * signed-in person's publik account (publik Files API, a kept file with the
 * path "backup/library.json"), and read it back on any of their computers.
 *
 * The publik calls (all with `Authorization: Bearer <key>`):
 *   POST   <base>/files        → a pending kept file and an upload_url
 *   PUT    upload_url          → the bytes (a storage URL: NO publik key)
 *   GET    <base>/files/<id>   → pending | ready; the first GET after the
 *                                bytes arrived turns it ready and charges it
 *   GET    <base>/files        → the person's kept files of this app
 *   DELETE <base>/files/<id>   → removes one file
 *
 * Rules of this module:
 *   - The old backup is deleted only after the new one is ready.
 *   - The key, the upload_url and the download_url are never logged and
 *     never put in an error message.
 *   - `fetchImpl` and `sleep` are injectable, so tests use a fake.
 *
 * Pure Node built-ins. */

export const BACKUP_PATH = "backup/library.json";
export const BACKUP_FILENAME = "nitroai-library.json";
/* The largest snapshot the local server accepts on POST /api/publik/backup. */
export const MAX_BACKUP_BODY = 64 * 1024 * 1024;

/* publik price for a kept file: $0.13 per GB uploaded, in 0.1 GB steps,
   rounded up. Used only when publik does not say what it charged. */
const STEP_BYTES = 100_000_000;
const STEP_MICROS = 13_000;
export function estimateChargeMicros(bytes) {
  return Math.max(1, Math.ceil(bytes / STEP_BYTES)) * STEP_MICROS;
}

/* An error with an HTTP status and the upstream `error.type`. */
export class BackupError extends Error {
  constructor(status, type, message, extra = {}) {
    super(message);
    this.name = "BackupError";
    this.status = status;
    this.type = type;
    this.extra = extra;
  }
  toJSON() {
    return { error: { type: this.type, message: this.message, ...this.extra } };
  }
}

const UNREACHABLE = "publik is not reachable right now. Your library on this computer did not change.";

function time(v) {
  const t = Date.parse(typeof v === "string" ? v : "");
  return Number.isNaN(t) ? 0 : t;
}

/* A count of micro-dollars, or null when publik did not send one. */
function micros(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/* A storage URL from publik: https, or http only when the publik base URL
   itself is http (tests and development). */
function storageUrl(value, baseUrl) {
  try {
    const u = new URL(String(value));
    if (u.protocol === "https:") return u.toString();
    if (u.protocol === "http:" && String(baseUrl).startsWith("http://")) return u.toString();
  } catch {
    /* not a URL */
  }
  return null;
}

export function createBackup({ fetchImpl, sleep, readyTries = 6, readyDelayMs = 700, timeoutMs = 30_000, uploadTimeoutMs = 10 * 60_000 } = {}) {
  const doFetch = (...a) => (fetchImpl ?? globalThis.fetch)(...a);
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  /* One publik call. Returns the parsed JSON body; throws BackupError. */
  async function api(cred, method, path, body) {
    let res;
    try {
      res = await doFetch(`${cred.base_url}${path}`, {
        method,
        headers: { authorization: `Bearer ${cred.key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new BackupError(502, "gateway_unreachable", UNREACHABLE);
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) {
      const e = json?.error ?? {};
      const extra = {};
      for (const k of ["quota_bytes", "used_bytes", "top_up_url", "retry_after_seconds"]) {
        const v = e[k] ?? json?.[k];
        if (v !== undefined && v !== null) extra[k] = v;
      }
      throw new BackupError(
        res.status,
        typeof e.type === "string" ? e.type : `http_${res.status}`,
        typeof e.message === "string" && e.message ? e.message : `publik answered ${res.status}.`,
        extra,
      );
    }
    if (!json || typeof json !== "object") throw new BackupError(502, "bad_response", "publik sent an answer this app cannot read.");
    return { json, headers: res.headers };
  }

  /* The person's kept backup files, newest first. */
  async function list(cred) {
    const { json } = await api(cred, "GET", "/files");
    const rows = Array.isArray(json.data) ? json.data : [];
    return rows
      .filter((f) => f && typeof f.id === "string" && f.path === BACKUP_PATH && (f.status === undefined || f.status === "ready"))
      .sort((a, b) => time(b.created_at) - time(a.created_at));
  }

  /* GET /api/publik/backup */
  async function info(cred) {
    const newest = (await list(cred))[0];
    if (!newest) return { available: true, exists: false, id: null, bytes: null, created_at: null };
    return { available: true, exists: true, id: newest.id, bytes: typeof newest.bytes === "number" ? newest.bytes : null, created_at: newest.created_at ?? null };
  }

  /* Best effort: a file that never became a backup is removed. */
  async function discard(cred, id) {
    try {
      await api(cred, "DELETE", `/files/${encodeURIComponent(id)}`);
    } catch {
      /* publik removes a pending file by itself when it expires */
    }
  }

  /* POST /api/publik/backup. `bytes` is a Buffer with the snapshot JSON. */
  async function save(cred, bytes) {
    if (!bytes?.length) throw new BackupError(400, "empty_backup", "There is nothing to back up.");

    const { json: created } = await api(cred, "POST", "/files", {
      filename: BACKUP_FILENAME,
      content_type: "application/json",
      bytes: bytes.length,
      keep: true,
      path: BACKUP_PATH,
    });
    const id = typeof created.id === "string" ? created.id : null;
    const uploadUrl = storageUrl(created.upload_url, cred.base_url);
    if (!id || !uploadUrl) throw new BackupError(502, "bad_response", "publik sent an answer this app cannot read.");

    // The bytes go to the storage URL. No publik key on this request.
    let put;
    try {
      put = await doFetch(uploadUrl, {
        method: typeof created.method === "string" ? created.method : "PUT",
        headers: { "content-type": "application/json" },
        body: bytes,
        signal: AbortSignal.timeout(uploadTimeoutMs),
      });
    } catch {
      await discard(cred, id);
      throw new BackupError(502, "upload_failed", "The upload did not finish. Your earlier backup is still there.");
    }
    if (!put.ok) {
      await discard(cred, id);
      throw new BackupError(502, "upload_failed", `The upload did not finish (storage answered ${put.status}). Your earlier backup is still there.`);
    }

    // The first GET after the bytes arrived turns the file ready.
    let ready = null;
    let charge = null;
    for (let attempt = 0; attempt < readyTries; attempt++) {
      if (attempt > 0) await wait(readyDelayMs * attempt);
      let got;
      try {
        got = await api(cred, "GET", `/files/${encodeURIComponent(id)}`);
      } catch (err) {
        // Out of credit, the daily cap, a deleted file: no more tries.
        if (err instanceof BackupError && err.status >= 400 && err.status < 500) {
          await discard(cred, id);
          throw err;
        }
        continue;
      }
      if (got.json.status === "ready") {
        ready = got.json;
        charge = micros(got.json.charge_micros) ?? micros(got.headers?.get?.("x-publik-charge-micros"));
        break;
      }
      if (got.json.status === "deleted") break;
    }
    if (!ready) {
      await discard(cred, id);
      throw new BackupError(504, "backup_not_ready", "publik did not confirm the backup. Your earlier backup is still there. Try again in a minute.");
    }

    // Only now: remove the older backups. A failure here keeps an old file;
    // the next backup removes it.
    const createdAt = ready.created_at ?? created.created_at ?? null;
    let deleted = 0;
    try {
      const newTime = time(createdAt);
      for (const old of await list(cred)) {
        if (old.id === id) continue;
        if (newTime && time(old.created_at) > newTime) continue; // a newer backup from another computer
        try {
          await api(cred, "DELETE", `/files/${encodeURIComponent(old.id)}`);
          deleted += 1;
        } catch {
          /* kept; the next backup tries again */
        }
      }
    } catch {
      /* the list failed; the new backup is ready all the same */
    }

    return {
      id,
      bytes: typeof ready.bytes === "number" ? ready.bytes : bytes.length,
      created_at: createdAt,
      charge_micros: charge ?? estimateChargeMicros(bytes.length),
      charge_estimated: charge === null,
      deleted_old: deleted,
    };
  }

  /* GET /api/publik/backup/data: the storage response of the newest backup
     (a web Response with a body stream), plus its id and size. */
  async function open(cred) {
    const newest = (await list(cred))[0];
    if (!newest) throw new BackupError(404, "no_backup", "There is no backup in your publik account.");
    const { json: file } = await api(cred, "GET", `/files/${encodeURIComponent(newest.id)}`);
    const url = file.status === "ready" ? storageUrl(file.download_url, cred.base_url) : null;
    if (!url) throw new BackupError(502, "backup_not_ready", "The backup is not ready to download. Try again in a minute.");
    let res;
    try {
      res = await doFetch(url, { method: "GET", signal: AbortSignal.timeout(uploadTimeoutMs) });
    } catch {
      throw new BackupError(502, "download_failed", "The download did not finish. Try again.");
    }
    if (!res.ok || !res.body) throw new BackupError(502, "download_failed", `The download did not finish (storage answered ${res.status}).`);
    return { id: newest.id, bytes: typeof file.bytes === "number" ? file.bytes : null, created_at: file.created_at ?? newest.created_at ?? null, response: res };
  }

  return { info, save, open, list };
}
