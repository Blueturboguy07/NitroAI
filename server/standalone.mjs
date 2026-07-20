/* Run the local server without Electron: `node server/standalone.mjs`.
 * Serves the built dist/ plus the native-helper endpoints. Useful for
 * developers, headless testing, or anyone who'd rather open the app in their
 * own browser than in the desktop shell. */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./httpServer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 4180;

const { url } = await startServer({
  distDir: path.join(__dirname, "..", "dist"),
  binDir: path.join(__dirname, "..", "node_modules", ".cache", "nitroai"),
  port,
});

console.log(`NitroAI server running at ${url}`);
console.log("Open that URL in your browser, or run the desktop shell with `npm run app`.");
