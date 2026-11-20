/* The library backup against a FAKE publik Files API (no network). The fake
 * follows the contract: POST /files, PUT upload_url, GET /files/<id> (the
 * first GET after the bytes arrived turns the file ready), GET /files,
 * DELETE /files/<id>. Every call is kept, in order. */
import { describe, expect, it } from "vitest";
import { BACKUP_PATH, BackupError, createBackup, estimateChargeMicros } from "./publikBackup.mjs";

const KEY = "pk_live_a8k2m9x4q7v1_h3n6r9t2w5y8z1b4c7d0f3g6j9k2m5p8";
const BASE = "https://publik.test/api/v1";
const CRED = { key: KEY, base_url: BASE };
const SNAPSHOT = Buffer.from(JSON.stringify({ format: "nitroai-library", version: 1, madeAt: "2026-11-20T10:00:00.000Z", collections: { notes: [{ id: "n1" }] } }));

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/* `files`: kept files already in the account. `over`: (call) => Response |
   undefined, to break one step. */
function fakePublik({ files = [], over = () => undefined, readyAfter = 1 } = {}) {
  const state = { files: files.map((f) => ({ status: "ready", kept: true, path: BACKUP_PATH, ...f })), blobs: new Map(), calls: [], seq: 0, gets: new Map() };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const u = new URL(url);
    const call = { method, url: String(url), path: u.pathname, auth: init.headers?.authorization ?? null, body: init.body };
    state.calls.push(call);
    const broken = await over(call, state);
    if (broken) return broken;

    if (u.host === "storage.test") {
      const id = u.searchParams.get("id");
      if (method === "PUT") {
        state.blobs.set(id, Buffer.from(init.body));
        return new Response("", { status: 200 });
      }
      return new Response(state.blobs.get(id) ?? "", { status: state.blobs.has(id) ? 200 : 404 });
    }
    if (call.auth !== `Bearer ${KEY}`) return json(401, { error: { type: "invalid_api_key", message: "bad key" } });
    if (method === "POST" && u.pathname === "/api/v1/files") {
      const b = JSON.parse(init.body);
      const id = `file_new${++state.seq}`;
      state.files.push({ id, status: "pending", filename: b.filename, bytes: b.bytes, content_type: b.content_type, kept: b.keep, path: b.path, created_at: `2026-11-20T10:00:0${state.seq}.000Z` });
      return json(201, { id, status: "pending", upload_url: `https://storage.test/upload?id=${id}&sig=SECRETSIG`, method: "PUT", expires_at: "2026-11-20T11:00:00.000Z", kept: true, path: b.path });
    }
    if (method === "GET" && u.pathname === "/api/v1/files") {
      const data = state.files.filter((f) => f.status === "ready").sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      return json(200, { object: "list", data, used_bytes: 0, quota_bytes: 1073741824 });
    }
    const m = /^\/api\/v1\/files\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const f = state.files.find((x) => x.id === m[1]);
      if (!f) return json(404, { error: { type: "not_found", message: "no such file" } });
      if (method === "DELETE") {
        f.status = "deleted";
        return json(200, { id: f.id, deleted: true });
      }
      const n = (state.gets.get(f.id) ?? 0) + 1;
      state.gets.set(f.id, n);
      if (f.status === "pending" && state.blobs.has(f.id) && n >= readyAfter) f.status = "ready";
      return json(200, { id: f.id, status: f.status, bytes: f.bytes, kept: true, path: f.path, created_at: f.created_at, expires_at: null, ...(f.status === "ready" ? { download_url: `https://storage.test/download?id=${f.id}&sig=SECRETSIG`, download_expires_at: "2026-11-20T11:00:00.000Z" } : {}) });
    }
    return json(404, { error: { type: "not_found", message: "unknown" } });
  };
  return { state, fetchImpl };
}

const make = (fake, opts = {}) => createBackup({ fetchImpl: fake.fetchImpl, sleep: async () => {}, ...opts });
const deletes = (fake) => fake.state.calls.filter((c) => c.method === "DELETE").map((c) => c.path.split("/").pop());
const live = (fake) => fake.state.files.filter((f) => f.status === "ready").map((f) => f.id);

describe("publikBackup — happy path", () => {
  it("creates a kept file with the exact byte size, uploads without the publik key, waits for ready, answers id, bytes, created_at and the charge", async () => {
    const fake = fakePublik();
    const out = await make(fake).save(CRED, SNAPSHOT);

    const post = fake.state.calls[0];
    expect(post).toMatchObject({ method: "POST", path: "/api/v1/files", auth: `Bearer ${KEY}` });
    expect(JSON.parse(post.body)).toEqual({ filename: "nitroai-library.json", content_type: "application/json", bytes: SNAPSHOT.length, keep: true, path: "backup/library.json" });

    const put = fake.state.calls[1];
    expect(put.method).toBe("PUT");
    expect(put.url).toContain("storage.test/upload");
    expect(put.auth).toBeNull(); // the storage URL never gets the publik key
    expect(fake.state.blobs.get("file_new1").equals(SNAPSHOT)).toBe(true);

    expect(out).toMatchObject({ id: "file_new1", bytes: SNAPSHOT.length, created_at: "2026-11-20T10:00:01.000Z", charge_micros: 13000, charge_estimated: true, deleted_old: 0 });
    expect(live(fake)).toEqual(["file_new1"]);
  });

  it("uses the charge publik reports, when it reports one", async () => {
    const fake = fakePublik({
      over: (call, state) => {
        if (call.method === "GET" && call.path === "/api/v1/files/file_new1" && state.blobs.has("file_new1")) {
          state.files.find((f) => f.id === "file_new1").status = "ready";
          return json(200, { id: "file_new1", status: "ready", bytes: SNAPSHOT.length, created_at: "2026-11-20T10:00:01.000Z" }, { "x-publik-charge-micros": "26000" });
        }
      },
    });
    expect(await make(fake).save(CRED, SNAPSHOT)).toMatchObject({ charge_micros: 26000, charge_estimated: false });
  });

  it("estimateChargeMicros: $0.13 per GB in 0.1 GB steps, rounded up", () => {
    expect(estimateChargeMicros(1)).toBe(13000);
    expect(estimateChargeMicros(100_000_000)).toBe(13000);
    expect(estimateChargeMicros(100_000_001)).toBe(26000);
  });

  it("info: the newest kept file with the backup path; other paths do not count", async () => {
    const fake = fakePublik({
      files: [
        { id: "file_old", bytes: 10, created_at: "2026-11-01T00:00:00.000Z" },
        { id: "file_newer", bytes: 20, created_at: "2026-11-10T00:00:00.000Z" },
        { id: "file_other", bytes: 5, created_at: "2026-11-19T00:00:00.000Z", path: "exports/a.json" },
      ],
    });
    expect(await make(fake).info(CRED)).toEqual({ available: true, exists: true, id: "file_newer", bytes: 20, created_at: "2026-11-10T00:00:00.000Z" });
    expect(await make(fakePublik()).info(CRED)).toEqual({ available: true, exists: false, id: null, bytes: null, created_at: null });
  });

  it("open: streams the newest backup from its download_url, without the publik key", async () => {
    const fake = fakePublik();
    const b = make(fake);
    await b.save(CRED, SNAPSHOT);
    fake.state.calls.length = 0;
    const got = await b.open(CRED);
    expect(Buffer.from(await got.response.arrayBuffer()).equals(SNAPSHOT)).toBe(true);
    const dl = fake.state.calls.at(-1);
    expect(dl.url).toContain("storage.test/download");
    expect(dl.auth).toBeNull();
  });

  it("open: no backup in the account → 404 no_backup", async () => {
    await expect(make(fakePublik()).open(CRED)).rejects.toMatchObject({ status: 404, type: "no_backup" });
  });
});

describe("publikBackup — the old backup is deleted only after the new one is ready", () => {
  const OLD = [
    { id: "file_old1", bytes: 10, created_at: "2026-11-01T00:00:00.000Z" },
    { id: "file_old2", bytes: 10, created_at: "2026-11-02T00:00:00.000Z" },
    { id: "file_other", bytes: 5, created_at: "2026-11-03T00:00:00.000Z", path: "exports/a.json" },
  ];

  it("deletes every older backup after ready, in that order, and never a file with another path", async () => {
    const fake = fakePublik({ files: OLD, readyAfter: 3 });
    const out = await make(fake).save(CRED, SNAPSHOT);
    expect(out.deleted_old).toBe(2);
    expect(deletes(fake).sort()).toEqual(["file_old1", "file_old2"]);
    expect(live(fake).sort()).toEqual(["file_new1", "file_other"]);

    // Order: no DELETE before the GET that answered "ready".
    const firstDelete = fake.state.calls.findIndex((c) => c.method === "DELETE");
    const gets = fake.state.calls.map((c, i) => ({ c, i })).filter(({ c }) => c.method === "GET" && c.path === "/api/v1/files/file_new1");
    expect(gets).toHaveLength(3); // pending, pending, ready
    expect(firstDelete).toBeGreaterThan(gets.at(-1).i);
  });

  it("keeps a backup that is newer than the new one (another computer was faster)", async () => {
    const fake = fakePublik({ files: [{ id: "file_future", bytes: 10, created_at: "2026-12-01T00:00:00.000Z" }] });
    const out = await make(fake).save(CRED, SNAPSHOT);
    expect(out.deleted_old).toBe(0);
    expect(live(fake).sort()).toEqual(["file_future", "file_new1"]);
  });

  it("a failed delete of an old backup does not fail the new backup", async () => {
    const fake = fakePublik({ files: OLD, over: (c) => (c.method === "DELETE" ? json(500, { error: { type: "server_error", message: "x" } }) : undefined) });
    const out = await make(fake).save(CRED, SNAPSHOT);
    expect(out).toMatchObject({ id: "file_new1", deleted_old: 0 });
  });

  it("the upload PUT fails → 502 upload_failed, the old backups stay, only the new pending file is removed", async () => {
    const fake = fakePublik({ files: OLD, over: (c) => (c.method === "PUT" ? new Response("no", { status: 500 }) : undefined) });
    await expect(make(fake).save(CRED, SNAPSHOT)).rejects.toMatchObject({ status: 502, type: "upload_failed" });
    expect(deletes(fake)).toEqual(["file_new1"]);
    expect(live(fake).sort()).toEqual(["file_old1", "file_old2", "file_other"]);
  });

  it("the upload PUT throws (network) → 502 upload_failed, the old backups stay", async () => {
    const fake = fakePublik({
      files: OLD,
      over: (c) => {
        if (c.method === "PUT") throw new TypeError("fetch failed");
      },
    });
    await expect(make(fake).save(CRED, SNAPSHOT)).rejects.toMatchObject({ status: 502, type: "upload_failed" });
    expect(live(fake).sort()).toEqual(["file_old1", "file_old2", "file_other"]);
  });

  it("the file never turns ready → 504 backup_not_ready after the tries, the old backups stay", async () => {
    const sleeps = [];
    const fake = fakePublik({ files: OLD, readyAfter: 99 });
    const b = createBackup({ fetchImpl: fake.fetchImpl, sleep: async (ms) => void sleeps.push(ms), readyTries: 4, readyDelayMs: 100 });
    await expect(b.save(CRED, SNAPSHOT)).rejects.toMatchObject({ status: 504, type: "backup_not_ready" });
    expect(fake.state.calls.filter((c) => c.method === "GET" && c.path === "/api/v1/files/file_new1")).toHaveLength(4);
    expect(sleeps).toEqual([100, 200, 300]); // a short backoff between tries
    expect(deletes(fake)).toEqual(["file_new1"]);
    expect(live(fake).sort()).toEqual(["file_old1", "file_old2", "file_other"]);
  });

  it("out of credit on the GET that would charge → the 402 and its type, the old backups stay", async () => {
    const fake = fakePublik({
      files: OLD,
      over: (c) => (c.method === "GET" && c.path === "/api/v1/files/file_new1" ? json(402, { error: { type: "insufficient_credit", message: "Not enough publik API balance.", top_up_url: "https://publikhq.com/wallet" } }) : undefined),
    });
    const err = await make(fake).save(CRED, SNAPSHOT).catch((e) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect(err.toJSON()).toEqual({ error: { type: "insufficient_credit", message: "Not enough publik API balance.", top_up_url: "https://publikhq.com/wallet" } });
    expect(err.status).toBe(402);
    expect(live(fake).sort()).toEqual(["file_old1", "file_old2", "file_other"]);
  });
});

describe("publikBackup — publik refuses the new file", () => {
  it("403 sign_in_required: no upload, no delete", async () => {
    const fake = fakePublik({ files: [{ id: "file_old", bytes: 1, created_at: "2026-11-01T00:00:00.000Z" }], over: (c) => (c.method === "POST" ? json(403, { error: { type: "sign_in_required", message: "Sign in to publik." } }) : undefined) });
    await expect(make(fake).save(CRED, SNAPSHOT)).rejects.toMatchObject({ status: 403, type: "sign_in_required", message: "Sign in to publik." });
    expect(fake.state.calls).toHaveLength(1);
    expect(live(fake)).toEqual(["file_old"]);
  });

  it("413 storage_quota_exceeded: the type and the quota numbers, no upload, no delete", async () => {
    const fake = fakePublik({ over: (c) => (c.method === "POST" ? json(413, { error: { type: "storage_quota_exceeded", message: "Storage is full.", quota_bytes: 1073741824, used_bytes: 1073741000 } }) : undefined) });
    const err = await make(fake).save(CRED, SNAPSHOT).catch((e) => e);
    expect(err.status).toBe(413);
    expect(err.toJSON()).toEqual({ error: { type: "storage_quota_exceeded", message: "Storage is full.", quota_bytes: 1073741824, used_bytes: 1073741000 } });
    expect(fake.state.calls).toHaveLength(1);
  });

  it("503 (not switched on) and a network failure give a clear error", async () => {
    const off = fakePublik({ over: (c) => (c.method === "POST" ? json(503, { error: { type: "files_disabled", message: "Files are not switched on." } }) : undefined) });
    await expect(make(off).save(CRED, SNAPSHOT)).rejects.toMatchObject({ status: 503, type: "files_disabled" });
    const down = fakePublik({
      over: () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(make(down).save(CRED, SNAPSHOT)).rejects.toMatchObject({ status: 502, type: "gateway_unreachable" });
    await expect(make(down).info(CRED)).rejects.toMatchObject({ status: 502, type: "gateway_unreachable" });
  });

  it("an upload_url that is not https is refused before any byte is sent", async () => {
    const fake = fakePublik({ over: (c) => (c.method === "POST" ? json(201, { id: "file_x", status: "pending", upload_url: "http://169.254.169.254/latest", method: "PUT" }) : undefined) });
    await expect(make(fake).save(CRED, SNAPSHOT)).rejects.toMatchObject({ status: 502, type: "bad_response" });
    expect(fake.state.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("no error message or JSON carries the key, the upload_url or the download_url", async () => {
    const seen = [];
    for (const over of [
      (c) => (c.method === "PUT" ? new Response("no", { status: 500 }) : undefined),
      (c) => {
        if (c.method === "PUT") throw new TypeError(`fetch failed for ${c.url}`);
      },
      (c) => {
        if (c.url.includes("storage.test/download")) throw new TypeError(`fetch failed for ${c.url}`);
      },
    ]) {
      const fake = fakePublik({ over });
      const b = make(fake, { readyTries: 2 });
      const e1 = await b.save(CRED, SNAPSHOT).catch((e) => e);
      if (e1 instanceof Error) seen.push(e1.message, JSON.stringify(e1));
      else seen.push(JSON.stringify(e1));
      const e2 = await b.open(CRED).catch((e) => e);
      if (e2 instanceof Error) seen.push(e2.message, JSON.stringify(e2));
    }
    const all = seen.join("\n");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("SECRETSIG");
    expect(all).not.toContain("storage.test");
  });
});
