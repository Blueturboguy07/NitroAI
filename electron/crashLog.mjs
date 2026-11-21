/* A local crash log: one file in the app's data folder, never sent anywhere.
 *
 * Bug report (Windows): "Crashed a couple of times." There was no data. Now
 * every error the main process did not handle, every renderer that ended, and
 * every forced close writes one JSON line to <userData>/crash.log, so the next
 * report can include the file.
 *
 * Without these listeners Electron shows "A JavaScript error occurred in the
 * main process" for an uncaught error. The listeners replace that box: the
 * error is written down and the app keeps running.
 */
import fs from "node:fs";
import path from "node:path";

export const CRASH_LOG_NAME = "crash.log";
/** At this size the file becomes crash.log.1 (one old file is kept). */
export const CRASH_LOG_MAX_BYTES = 256 * 1024;
const TEXT_LIMIT = 8000;

function errorFields(err) {
  if (err === undefined || err === null) return {};
  if (err instanceof Error) {
    return { message: String(err.message).slice(0, TEXT_LIMIT), stack: String(err.stack ?? "").slice(0, TEXT_LIMIT), ...(err.code ? { code: String(err.code) } : {}) };
  }
  let text;
  try {
    text = typeof err === "string" ? err : JSON.stringify(err);
  } catch {
    text = String(err);
  }
  return { message: String(text).slice(0, TEXT_LIMIT) };
}

/**
 * The log. `write(kind, err?, extra?)` appends one line and NEVER throws (a
 * full disk must not become a second crash). `info` goes on every line (the
 * app version, the platform).
 */
export function createCrashLog(file, { info = {}, maxBytes = CRASH_LOG_MAX_BYTES, now = () => new Date() } = {}) {
  return {
    file,
    write(kind, err, extra = {}) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try {
          if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
        } catch {
          /* no file yet */
        }
        fs.appendFileSync(file, `${JSON.stringify({ t: now().toISOString(), kind, ...info, ...errorFields(err), ...extra })}\n`);
      } catch {
        /* the log is best effort */
      }
    },
  };
}

/**
 * Writes down what would stop or silently break the app, and keeps it running:
 *   - an uncaught error and an unhandled rejection in the main process;
 *   - a renderer or a helper process (GPU, network) that ended.
 */
export function installCrashHandlers({ proc = process, app, log }) {
  proc.on("uncaughtException", (err) => {
    log.write("uncaughtException", err);
    console.error("[crash] uncaughtException", err);
  });
  proc.on("unhandledRejection", (reason) => {
    log.write("unhandledRejection", reason);
    console.error("[crash] unhandledRejection", reason);
  });
  app.on("render-process-gone", (_event, _webContents, details) => {
    log.write("render-process-gone", null, { reason: details?.reason, exitCode: details?.exitCode });
  });
  app.on("child-process-gone", (_event, details) => {
    log.write("child-process-gone", null, { type: details?.type, reason: details?.reason, exitCode: details?.exitCode, name: details?.name });
  });
}
