/* pdf.js runtime data for `vite dev` and `vite build`.
 *
 * pdf.js fetches some data at runtime instead of bundling it: the Adobe CMaps
 * (CJK and other predefined-encoding fonts — without them their text extracts
 * as nothing), the standard fonts, and the wasm image decoders (JBIG2 and
 * JPEG 2000 — the formats most scanned PDFs use; without them a rendered page
 * comes out blank). This plugin serves those files at /pdfjs/<dir>/<file> in
 * dev and copies them to dist/pdfjs/ on build, so the Electron/standalone
 * server and the Tauri shell serve them the same way. src/lib/ingest/pdf.ts
 * points getDocument() at them.
 */

import fs from "node:fs";
import path from "node:path";
import type { Connect, Plugin } from "vite";

const DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"];
/* JavaScript-in-PDF sandbox — the app never runs PDF scripts. */
const SKIP = /^quickjs/;

function files(root: string, dir: string): string[] {
  return fs.readdirSync(path.join(root, dir)).filter((f) => !SKIP.test(f));
}

function middleware(root: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    const m = /^\/pdfjs\/([a-z_]+)\/([^/?#]+)/.exec(req.url ?? "");
    if (!m || !DIRS.includes(m[1]) || SKIP.test(m[2])) return next();
    const file = path.join(root, m[1], decodeURIComponent(m[2]));
    if (path.dirname(file) !== path.join(root, m[1]) || !fs.existsSync(file)) return next();
    res.setHeader("content-type", file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
    res.setHeader("cache-control", "public, max-age=3600");
    fs.createReadStream(file).pipe(res);
  };
}

export function pdfjsAssetsPlugin(): Plugin {
  let root = path.join(process.cwd(), "node_modules", "pdfjs-dist");
  return {
    name: "nitroai-pdfjs-assets",
    configResolved(config) {
      root = path.join(config.root, "node_modules", "pdfjs-dist");
    },
    configureServer(server) {
      server.middlewares.use(middleware(root));
    },
    generateBundle() {
      for (const dir of DIRS) {
        for (const file of files(root, dir)) {
          this.emitFile({
            type: "asset",
            fileName: `pdfjs/${dir}/${file}`,
            source: fs.readFileSync(path.join(root, dir, file)),
          });
        }
      }
    },
  };
}
