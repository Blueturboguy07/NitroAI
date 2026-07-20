/* electron-builder afterPack hook — properly ad-hoc sign the macOS bundle.
 *
 * Why this exists: without a paid Developer ID cert, electron-builder leaves
 * the app carrying the Electron binary's original *linker* signature, which is
 * INVALID once the bundle is renamed and has our app injected. macOS reports an
 * app with a broken signature as "…is damaged and can't be opened", even though
 * nothing is wrong with it. Re-signing the whole bundle ad-hoc (identity "-")
 * produces a valid signature, so Gatekeeper falls back to the ordinary
 * unsigned-app prompt (right-click → Open, or `xattr -cr`) instead of "damaged".
 *
 * This runs on the packed .app before the .dmg is assembled.
 */

const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  // Always ad-hoc sign here as a FLOOR. If a real Developer ID cert is
  // configured, electron-builder re-signs (with --force) over this afterward
  // and notarizes; if signing gets skipped for any reason, we still ship a
  // VALID ad-hoc signature rather than the broken linker signature that macOS
  // reports as "damaged". This runs before electron-builder's own signing.

  const appName = context.packager.appInfo.productFilename; // "NitroAI"
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[afterPack] ad-hoc signing ${appPath}`);
  // --force replaces the stale linker signature; --deep signs the nested
  // Electron frameworks and helper apps; --sign - is the ad-hoc identity.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
  // Fail the build loudly if the signature isn't valid — better than shipping
  // another "damaged" app.
  execFileSync("codesign", ["--verify", "--strict", "--verbose=2", appPath], {
    stdio: "inherit",
  });
  console.log("[afterPack] signature verified");
};
