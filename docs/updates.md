# Updates

NitroAI updates itself on macOS and Windows. The code is `electron/publik-updater.cjs` (the Electron part)
and `electron/publik-update-verify.cjs` (the signature check). Both files are the same in every publik
Electron app. `electron/main.mjs` starts the updater first thing in `app.whenReady()`. Linux (AppImage)
does not update itself: a new version is a manual download, as before.

## How it works

1. The app asks `https://publikhq.com/api/updates/nitroai/` for two files: `latest.yml` (Windows) or
   `latest-mac.yml` (macOS), and the signature of that file (`latest.yml.sig` or `latest-mac.yml.sig`).
   It asks at launch, every 24 hours, and when you click **Check for Updates…** (macOS: the NitroAI menu;
   Windows: the Help menu).
2. The app verifies the signature with the publik update public key, which is in `publik-update-verify.cjs`.
   If the signature is missing or wrong, the app stops there. It downloads nothing.
3. The feed must name this app (`publikApp: nitroai`) and give a sha512 for each file.
4. electron-updater downloads the file that the feed names. It refuses the file if its sha512 is not the
   one in the signed feed. Windows downloads the NSIS installer. macOS downloads the zip for its chip: a
   Mac with Apple silicon takes the file with `arm64` in its name, an Intel Mac takes the other one.
   Squirrel.Mac also refuses an app that does not satisfy the code signature of the running app (same
   bundle ID `com.nitroai.app`, same Developer ID team). This keeps the permissions macOS gave the app.
5. The app asks: "NitroAI X is ready to install. Restart now?" **Later** installs the update when you quit.
   The app never restarts by itself.

A failure in the background is silent (the log has it). A manual check always shows its result.
`PUBLIK_UPDATES=0` in the environment stops the automatic checks. The CI launch tests set it.

## The feed contract (what publik serves)

| Request | Response |
|---|---|
| `GET /api/updates/nitroai/latest.yml` | the release asset `latest.yml`, byte for byte |
| `GET /api/updates/nitroai/latest.yml.sig` | the release asset `latest.yml.sig`, byte for byte |
| `GET /api/updates/nitroai/latest-mac.yml` | the release asset `latest-mac.yml`, byte for byte |
| `GET /api/updates/nitroai/latest-mac.yml.sig` | the release asset `latest-mac.yml.sig`, byte for byte |

The publik listing `turbolarp` points at this repo too and lists the same release files. An app installed
from either listing is the same binary and reads the `nitroai` feed. There is no second feed.

- Serve the files from the scan-approved release without changes. One changed byte breaks the signature.
- The app adds `?noCache=<random>` to each request. Ignore the query string.
- A redirect is fine. A 404 means "no update" for the app.
- The base URL must not carry a query string: electron-updater copies the base query onto every file URL.
- The feed lists ABSOLUTE GitHub asset URLs. electron-updater's generic provider resolves each URL with
  `new URL(url, base)`, so an absolute URL stays as it is (checked in `node_modules/electron-updater`,
  and by the unit tests and the proof). The app downloads the installer from GitHub, not from publik.
- The app does not send electron-updater's `x-user-staging-id` header.

A feed file looks like this (`scripts/publik-update-feed.cjs write` makes it):

```yaml
version: '0.2.7'
publikApp: 'nitroai'
files:
  - url: 'https://github.com/Blueturboguy07/NitroAI/releases/download/v0.2.7/NitroAI-mac-arm64.zip'
    sha512: '<base64>'
    size: 123456789
  - url: 'https://github.com/Blueturboguy07/NitroAI/releases/download/v0.2.7/NitroAI-mac-x64.zip'
    sha512: '<base64>'
    size: 123456789
  - url: 'https://github.com/Blueturboguy07/NitroAI/releases/download/v0.2.7/NitroAI-mac-arm64.dmg'
    sha512: '<base64>'
    size: 123456789
  - url: 'https://github.com/Blueturboguy07/NitroAI/releases/download/v0.2.7/NitroAI-mac-x64.dmg'
    sha512: '<base64>'
    size: 123456789
path: '<the url of the first file>'
sha512: '<the sha512 of the first file>'
releaseDate: '2026-11-18T00:00:00.000Z'
```

NitroAI's file names do not carry the version (the README links to `releases/latest/download/<name>`).
The script therefore reads the version INSIDE each installer before it writes a feed: the
`CFBundleShortVersionString` of the app in each mac zip, and the `ProductVersion` of the Windows installer.
A file with another version stops the script. Without this check, a tag that does not match
`package.json` would make every app download the same update again at each check.

The `.sig` file is a minisign signature of the feed file. The app accepts these forms:

| Made with | Algorithm | File form |
|---|---|---|
| `tauri signer sign` (what `scripts/publik-update-feed.cjs` uses) | `ED`: Ed25519 over BLAKE2b-512 of the file | minisign text, wrapped in base64 |
| `minisign -S` (minisign 0.8 and later) | `ED`: Ed25519 over BLAKE2b-512 of the file | minisign text |
| `minisign -S -l` (legacy) | `Ed`: Ed25519 over the file | minisign text |

Electron's crypto has no BLAKE2b-512, so the app computes it with the `blakejs` package. Both algorithms
therefore work in the app; `-l` is not needed. The trusted comment must name the file (`file:latest.yml` or
`file:latest-mac.yml`). tauri and minisign write that by default; do not replace it with `-t`.

## Cut a release

One command, on a Mac with `gh` logged in, from a clean `main`:

```sh
scripts/publik-release.sh 0.2.8
```

NitroAI signs in CI: the repo secrets hold the Developer ID certificate, the Apple notary login and the
publik update key. The script does not sign on the Mac. It drives the CI and checks what comes out:

| Step | What the script does |
|---|---|
| 1. Checks | macOS, `gh` logged in, branch `main`, clean tree, `main` = `origin/main`, the version is newer than `package.json` and every release, the tag is free. At least 1.5 GB free disk (`PUBLIK_RELEASE_MIN_FREE_GB`). |
| 2. Bump | `package.json` and the two version fields of `package-lock.json`, one commit on `main`, then the tag `vX.Y.Z`. Pushes both. No force push. |
| 3. CI | The tag starts `release.yml`: builds, signs with the Developer ID (hardened runtime, `build-resources/entitlements.mac.plist`, inner binaries first), notarizes and staples the apps and the dmgs, makes the zips, the Windows installer and the AppImage, and puts them on a **draft** release. Its feed job (`update-feed.yml`) adds `latest.yml`, `latest-mac.yml` and their `.sig`, signed with the update key. The script waits. A failed run: it runs the failed jobs again, once. A draft without its feed: it runs `update-feed.yml`. |
| 4. Verify | Downloads every file of the draft back from GitHub, one at a time, and deletes each after its checks: exactly the 10 expected files; the feed signatures, with the app's own verifier and public key; feed version, `publikApp`, absolute URLs, sizes and sha512 = the files; GitHub's sha256 of each file; for each mac zip and the app in each dmg: Info.plist version and bundle ID, arch, `codesign --verify --deep --strict`, Developer ID authority and team, secure timestamp, hardened runtime (inner code too), the entitlements, the designated requirement, `spctl` "Notarized Developer ID", `stapler validate`, the publik app token in `app.asar`, not a test build; the same app (CDHash) in the zip and the dmg of each arch; each dmg stapled and accepted by `spctl`; the Windows installer's version; the app token in the build log of each OS. |
| 5. Publish | Only when every check passed: publishes the draft as the latest release and checks that its files are public. |

Any failed check stops the script before step 5: the release stays a draft. Fix the cause and run the same
command again. It continues from where it stopped (a pushed bump, a pushed tag, a running or failed CI run,
a draft without its feed). The script starts no app and prints no secret (the app token is checked, not
printed). The log and the list of checks are in `$TMPDIR/publik-release-nitroai/vX.Y.Z/`.

| Option | Effect |
|---|---|
| `--no-publish` | All steps, but the release stays a draft. |
| `--verify-only` | Only step 4, for a release that exists (draft or public). |
| `RELEASE_COMMIT_TRAILER` (env) | A line added to the bump commit message, e.g. a `Co-Authored-By:` trailer. |

publik takes in new releases once a day, at 10:00 UTC. A release published before then is in the feed after
the intake. Then prove it on real machines (next section).

The Windows installer is not code-signed (no Windows certificate). The update key signs the feed, and the feed
holds the installer's sha512.

For a publik release (a draft that publik scans): build with `publik-build.yml`, check the files, then put
ALL of them on the draft, the mac zips too. Run **Actions › Update feed** with the draft's tag
(`gh workflow run update-feed.yml -f tag=vX.Y.Z`) BEFORE the scan, so the scan sees the feed files too.
Update feed adds only missing feed files. Use **force** after you replace an installer file.

The update key is needed only by `update-feed.yml`: it reads the repo secrets `PUBLIK_UPDATE_KEY` and
`PUBLIK_UPDATE_KEY_PASSWORD`. The build workflows do not need it. Without CI, run the same script on a Mac
that has the key in its keychain:

```sh
PUBLIK_UPDATE_KEY="$(security find-generic-password -s publik-update-key -a mann-private -w)" \
PUBLIK_UPDATE_KEY_PASSWORD="$(security find-generic-password -s publik-update-key -a mann-password -w)" \
node scripts/publik-update-feed.cjs release --tag vX.Y.Z --app nitroai --repo Blueturboguy07/NitroAI
```

## The live proof (a real update from the live feed)

`.github/workflows/live-update-proof.yml` installs a released NitroAI the way a user does and lets it update
itself from publik's live feed, on GitHub's runners: macOS Apple silicon, macOS Intel and Windows.

```sh
gh workflow run live-update-proof.yml -f from_tag=v0.2.7 -f expect_version=0.2.8
```

`expect_version` = the version of `from_tag`: the app must say "no update" and stay there. A newer
`expect_version`: the app must download it by itself and run it after the restart question. One job answers
**Restart Now**, one answers **Later** (then quits). The run stops at once when the live feed does not serve
`expect_version`.

| Check | macOS | Windows |
|---|---|---|
| Download `from_tag` from the GitHub release; hash = the release's | dmg, quarantined; `spctl` "Notarized Developer ID"; stapled | installer |
| Install as a user does | a mouse drag of the NitroAI icon onto Applications in the dmg's Finder window; quarantine kept; macOS must not translocate it (a copy made any other way keeps quarantine flag 0x0080 and runs translocated, where it cannot update) | silent installer (per user) |
| Permissions before | designated requirement; camera, microphone, screen capture, accessibility rows in the TCC databases, with the csreq of that requirement | — |
| Start the normal way, no test hook, no feed override | LaunchServices (`open`); the first-launch Gatekeeper question is answered **Open** | the installed exe |
| The app's own updater | log: the feed's signature OK; the downloaded file = the signed feed's sha512 | the same |
| The answer | **Restart Now** / **Later** + quit, clicked with System Events | the same: a mouse click on the dialog button (found with Win32; the dialog is a task dialog) |
| After | Info.plist version, the running process, its log, **Check for Updates…** clicked in the menu: "You’re up to date." with the version | exe and running process version, Apps list, log; **Help › Check for Updates…** (UI Automation): "You’re up to date." with the version |
| Permissions after | designated requirement unchanged; `spctl`; the four TCC rows are still there, and the app satisfies the stored csreq of each (`codesign --verify -R`) | — |

A runner cannot show a consent prompt. The csreq check is the check that tccd makes, so it is the proof that
the update needs no new permission prompt. The sign-in gate gets a key that is not a real key: it does not
create an install on publik for the runner, and nothing signs in. Each job uploads its assertions, the app's
logs, screenshots, the TCC rows and the updater's cache as an artifact. The unit tests of the 24-hour check
(fake timers) and of the menu handler are in `test/publik-updater-schedule.test.mjs`.

## Roll back

electron-updater never installs an older version. To roll back:

1. Stop the bad update: delete its feed files, and publik stops serving it.
   `gh release delete-asset vX.Y.Z latest.yml -y` (and `latest.yml.sig`, `latest-mac.yml`, `latest-mac.yml.sig`).
   Apps that have not downloaded it yet get a 404 and stay where they are.
2. Release the good code again with a HIGHER version (for example 0.1.4 with the code of 0.1.2), with its
   feed. Apps that installed the bad version update to it.

## Rotate the key

Every installed app trusts only the keys in `PUBLIK_UPDATE_PUBLIC_KEYS` (`electron/publik-update-verify.cjs`).

1. Make a new key: `npx @tauri-apps/cli@2.12.4 signer generate -w new.key`. Put the private key and its
   password in the keychain and in the repo secrets. Do not delete the old key yet.
2. Add the new public key (the `RW…` line of `new.key.pub`, base64-decoded) to `PUBLIK_UPDATE_PUBLIC_KEYS`,
   next to the old key. Release that version, signed with the OLD key.
3. Wait until most users run that version. Then sign the feeds with the new key (change the secrets).
4. In a later release, remove the old key from the list.

Users who skip the transition release cannot verify feeds that the new key signs. They must install
again by hand. If the old private key leaks, do the same steps at once. Until users have the new list,
a leaked key lets an attacker sign a feed. On Windows the installer is not code-signed, so the key is
the only protection there. On macOS, Squirrel.Mac still requires the Developer ID signature.

## Test builds and the proof

`.github/workflows/updater-proof.yml` proves the updater on GitHub's macOS runners (Apple silicon and
Intel) and on a Windows runner. It builds two test versions, N and N+1, with `"publikUpdaterTest": true`
in `package.json`. Only a test build reads these environment variables:

| Variable | Effect (test builds only) |
|---|---|
| `PUBLIK_UPDATE_URL` | replaces `https://publikhq.com/api/updates/<slug>/` |
| `PUBLIK_UPDATER_TEST=report` | writes the running version to `PUBLIK_UPDATER_RESULT` and exits |
| `PUBLIK_UPDATER_TEST=update` | runs the same check, download and install, writes the result, quits to install |

On macOS the proof builds N and N+1 as `release.yml` does: Developer ID signature from the repo secrets,
hardened runtime, notarized and stapled (a push whose commit message holds `[proof-no-notarize]` skips the
notarization). Only the refused "other identity" case uses an identity made on the runner.

Test versions are `0.0.0-updtest.*`. A test feed that the real key signs is therefore never newer than a
real release. The proof puts N+1 on a prerelease with a `v0.0.0-updtest.*` tag and deletes it at the end.
`release.yml` ignores these tags.

## Copy to another Electron app

NitroAI copied these files from the SurfCam template. Differences: the two updater files are in `electron/`
(the main process is ESM and loads them with `createRequire`), the tests run in vitest, the mac build has
one zip per arch instead of a universal one, and the feed script reads the version inside each file
because the file names do not carry it.

1. Copy `publik-updater.cjs`, `publik-update-verify.cjs`, `scripts/publik-update-feed.cjs`,
   `.github/workflows/update-feed.yml`, `.github/workflows/updater-proof.yml`,
   `.github/scripts/updater-proof.cjs`, `.github/scripts/updater-electron-crypto.cjs` and this file.
2. `npm install electron-updater blakejs`.
3. In `package.json` › `build`: add the two `.cjs` files to `files`; set `publish` to
   `{ "provider": "generic", "url": "https://publikhq.com/api/updates/<slug>/" }`; add a `zip` target next
   to the mac `dmg` target.
4. In the main process, first thing in `app.whenReady()`:
   `if (startUpdates({ slug: '<slug>', appName: '<Name>' }).testHook) return;`
   If the app has its own menu, call `startUpdates({ ..., menu: false })` and add `updates.menuItem()`.
5. Replace `surfcam`, `SurfCam` and the file names in `update-feed.yml`, `updater-proof.yml` and
   `updater-proof.cjs` (bundle ID check, installer names, the Windows uninstall entry name).
6. Add the repo secrets `PUBLIK_UPDATE_KEY` and `PUBLIK_UPDATE_KEY_PASSWORD`.
7. Add `PUBLIK_UPDATES: '0'` to the workflows that launch the app, and exclude `v*-updtest*` tags from
   any workflow that a `v*` tag starts.
8. Push, and check that the proof passes on both runners.
