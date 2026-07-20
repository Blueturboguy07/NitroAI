# NitroAI

**Turn any lecture, PDF, or video into study notes, flashcards, quizzes, and a study chat — free, and private by default.**

NitroAI is an open-source, local-first study app. Point it at a document, a website, a YouTube link, or an audio file and it generates clean notes (with math), spaced-repetition flashcards, quizzes, and a chat that knows your material. You can run it **fully locally** (no account, no cloud, nothing leaves your machine) or **bring your own** OpenAI / Anthropic key for top-tier quality. There is no NitroAI subscription, ever.

> [!IMPORTANT]
> **This is a starting point, not a finished product.** It's an open-source foundation meant to be forked, extended, and improved. It works and it's genuinely useful, but expect rough edges — treat it as a solid base to build on rather than a polished commercial app.

> [!NOTE]
> **Windows and macOS are both tested and working.** One Windows caveat: automatic setup of the local AI runtime (Ollama) isn't wired up there yet — on Windows, install [Ollama](https://ollama.com/download) once and NitroAI will use it, or just use a cloud key. (On macOS it's fully automatic.)

## Download

**This section is for people who just want to use the app.** If you're a developer, don't download the installer — [run it from source](#for-developers) instead, so you get the code and can change it.

Grab the latest installer:

### 👉 [Click this link to download for Mac](https://github.com/Blueturboguy07/NitroAI/releases/latest/download/NitroAI-mac-arm64.dmg) &nbsp;(Apple Silicon — M1/M2/M3)

Got an older **Intel Mac**? [Download the Intel version instead.](https://github.com/Blueturboguy07/NitroAI/releases/latest/download/NitroAI-mac-x64.dmg)

### 👉 [Click this link to download for Windows](https://github.com/Blueturboguy07/NitroAI/releases/latest/download/NitroAI-Setup-Windows.exe)

Or browse every version on the [Releases page](https://github.com/Blueturboguy07/NitroAI/releases/latest).

Open the installer, drag NitroAI to Applications, launch it, and you're done. On first launch you choose how the AI runs (see below).

- **macOS** — the app is **signed with an Apple Developer ID and notarized by Apple**, so it just opens on a normal double-click, no warnings. 🎉
- **Windows** — the installer is **not code-signed yet**, so Windows Defender **SmartScreen** will stop it the first time with a blue popup: *"Windows protected your PC."* This is expected for any new app without a (paid) Windows certificate — the app is fine. To run it:
  1. Click the small **More info** link in that popup.
  2. A **Run anyway** button appears at the bottom — click it. That's it; Windows remembers your choice and won't ask again.

  If you don't see "Run anyway," you can instead **right-click the downloaded `NitroAI-Setup-Windows.exe` → Properties**, tick **Unblock** near the bottom, click **OK**, then run it.

> **Maintainers:** the SmartScreen warning disappears entirely once the Windows build is signed with an Authenticode certificate (macOS is already signed/notarized in this repo). See [Signing your own builds](#signing-your-own-builds) — add the `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` secrets and it's automatic. (Note: brand-new Windows certs can still show SmartScreen until they build up download "reputation," unless you buy an EV certificate.)

## How it works

NitroAI is a small desktop shell around a local web app. When you open it, the app **starts a tiny local server on your machine**, shows it in a window, keeps it alive, and shuts it down when you quit. That local server is what does the things a plain web page can't — extracting YouTube transcripts with `yt-dlp` and managing the local AI runtime — so **you never install those tools by hand.**

### Two ways to run the AI

You pick one on first launch (and can switch any time in Settings):

- **Fully local** — when you choose this, NitroAI automatically downloads and starts a local AI runtime ([Ollama](https://ollama.com)) and pulls a small, capable model (~2 GB, one time). Everything then runs on your device: no key, no cloud, no cost. *Provisioning only ever happens if you pick local — cloud users never download a model.*
- **Bring your own key** — paste an OpenAI (`sk-…`) or Anthropic (`sk-ant-…`) key for the highest-quality notes, quizzes, chat, and podcast voices. The key is stored in your OS keychain and used only to call your provider directly.

Your notes and generated content live only on your machine (in the app's local database); you can export everything from Settings at any time.

## For developers

Requires **Node ≥ 20.19** (Node 21.x is not supported — use 20.19+ or 22 LTS).

```bash
git clone https://github.com/Blueturboguy07/NitroAI.git
cd NitroAI
npm install

npm run dev      # Vite dev server (hot reload) — includes the YouTube helper
npm run serve    # build once, then serve the app + helpers at http://localhost:4180
npm run app      # build, then launch the full desktop shell (Electron)
```

Build installers locally:

```bash
npm run dist:mac   # → release/NitroAI-<version>-<arch>.dmg
npm run dist:win   # → release/NitroAI-Setup-<version>.exe
```

Or let CI do it: push a tag (`git tag v0.1.0 && git push --tags`) and the
[release workflow](.github/workflows/release.yml) builds macOS + Windows
installers and attaches them to a GitHub Release.

Other scripts: `npm test` (Vitest), `npm run typecheck`.

### Project layout

```
src/            React app (UI + all generation/engine/ingest logic, TypeScript)
  lib/engine/   provider abstraction: OpenAI, Anthropic, and local Ollama
  lib/ingest/   text / url / youtube / pdf / docx / audio → normalized text
  lib/generation/  notes, flashcards, quiz, podcast, chat
server/         the local server the desktop shell runs
  httpServer.mjs  serves the built app + /api/youtube-extract + /api/local/*
  ytdlp.mjs       yt-dlp download + caption/audio extraction
  ollama.mjs      Ollama install / serve / model-pull lifecycle
electron/       the desktop shell (starts the server, opens the window)
```

## Signing your own builds

By default the release workflow produces **ad-hoc-signed** builds — valid, but not notarized, so users get a one-time OS warning. If you have signing certificates, add them as **GitHub repo secrets** (Settings → Secrets and variables → Actions) and every tagged build is automatically signed and notarized — installers then open with **no warning at all**. No code changes needed; the build detects the secrets.

**macOS** (needs a paid [Apple Developer](https://developer.apple.com) account and a *Developer ID Application* certificate):

| Secret | What it is |
| --- | --- |
| `CSC_LINK` | Your Developer ID Application cert, exported from Keychain as a `.p12`, then base64-encoded: `base64 -i cert.p12 \| pbcopy` |
| `CSC_KEY_PASSWORD` | The password you set when exporting the `.p12` |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | An [app-specific password](https://support.apple.com/en-us/102654) for that Apple ID (not your login password) |
| `APPLE_TEAM_ID` | Your 10-character Team ID (Apple Developer → Membership) |

**Windows** (optional — needs an Authenticode code-signing certificate):

| Secret | What it is |
| --- | --- |
| `WIN_CSC_LINK` | Your code-signing cert as a base64-encoded `.pfx` |
| `WIN_CSC_KEY_PASSWORD` | The `.pfx` password |

Then cut a release: `git tag v0.1.3 && git push --tags`. That's it — nothing else to configure.

## Tech

React 19 · Vite · Tailwind · Electron shell · Ollama (local) · OpenAI / Anthropic (cloud) · KaTeX · FSRS spaced repetition. No backend, no telemetry, no account.

## License

[AGPL-3.0-or-later](LICENSE). Fork it, ship it, improve it — just keep it open.
