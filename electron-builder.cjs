/* electron-builder configuration.
 *
 * Two signing paths, chosen automatically by whether signing secrets are set:
 *
 *   • Signed + notarized (recommended for public downloads) — when CSC_LINK is
 *     present (your Developer ID .p12, base64), electron-builder signs with your
 *     real certificate, enables the hardened runtime, and notarizes with Apple
 *     using APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID. The app then
 *     opens on the first double-click with no warning at all.
 *
 *   • Ad-hoc fallback (no cert) — when those aren't set, the app is ad-hoc
 *     signed (see scripts/afterPack.cjs) so it's valid (not "damaged") but
 *     un-notarized; the user right-clicks → Open, or runs `xattr -cr` once.
 *
 * See the "Signing your own builds" section in README.md for how to add the
 * secrets on GitHub.
 */

// The release workflow sets MAC_SIGN=1 after it has built a signing keychain
// that contains the Developer ID cert AND Apple's intermediate (a bare .p12
// lacks the intermediate, so gating on CSC_LINK let untrusted certs through).
const hasCert = process.env.MAC_SIGN === "1";
const canNotarize =
  hasCert &&
  !!process.env.APPLE_ID &&
  !!process.env.APPLE_APP_SPECIFIC_PASSWORD &&
  !!process.env.APPLE_TEAM_ID;

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "com.nitroai.app",
  productName: "NitroAI",
  copyright: "NitroAI contributors",
  // Publishing is handled by the release workflow, not electron-builder.
  publish: null,
  files: ["dist/**", "server/**", "electron/**", "!**/*.map"],
  extraMetadata: { main: "electron/main.mjs" },
  // Ad-hoc signs the mac bundle when there's no real cert (no-op otherwise).
  afterPack: "./scripts/afterPack.cjs",
  directories: { output: "release", buildResources: "build-resources" },
  mac: {
    target: [{ target: "dmg", arch: ["arm64", "x64"] }],
    category: "public.app-category.education",
    artifactName: "NitroAI-mac-${arch}.${ext}",
    // With a real cert: let electron-builder discover it from CSC_LINK and
    // apply the hardened runtime (required for notarization). Without one:
    // identity:null so electron-builder skips, and afterPack ad-hoc signs.
    identity: hasCert ? undefined : null,
    hardenedRuntime: hasCert,
    entitlements: "build-resources/entitlements.mac.plist",
    entitlementsInherit: "build-resources/entitlements.mac.plist",
    // electron-builder 26 wants a boolean here; notarization reads
    // APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID from the env
    // (passed by the release workflow).
    notarize: canNotarize,
  },
  dmg: { title: "NitroAI ${version}" },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    artifactName: "NitroAI-Setup-Windows.${ext}",
    // Windows Authenticode signing activates automatically when these are set.
    // (WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD — see README.)
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },
  linux: {
    target: ["AppImage"],
    category: "Education",
  },
};
