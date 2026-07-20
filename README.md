# NitroAI

**Turn any lecture, PDF, or video into study notes, flashcards, quizzes, and a study chat — free, and private by default.**

NitroAI is an open-source, local-first study app. Point it at a document, a website, a YouTube link, or an audio file and it generates clean notes (with math), spaced-repetition flashcards, quizzes, and a chat that knows your material. You can run it **fully locally** (no account, no cloud, nothing leaves your machine) or **bring your own** OpenAI / Anthropic key for top-tier quality. There is no NitroAI subscription, ever.

> [!IMPORTANT]
> **This is a starting point, not a finished product.** It's an open-source foundation meant to be forked, extended, and improved. It works and it's genuinely useful, but expect rough edges — treat it as a solid base to build on rather than a polished commercial app.

> [!WARNING]
> **Not tested on Windows yet.** The app is developed and tested on macOS. The Windows build is produced by CI and *should* work, but it hasn't been verified on real hardware. Windows feedback and fixes are very welcome. On Windows, automatic setup of the local AI runtime (Ollama) isn't wired up yet — install [Ollama](https://ollama.com/download) once and NitroAI will use it; or just use a cloud key.

## Download

Grab the latest installer from the [**Releases page**](https://github.com/Blueturboguy07/NitroAI/releases/latest):

### 👉 [Click this link to download for Mac](https://github.com/Blueturboguy07/NitroAI/releases/latest/download/NitroAI-mac-arm64.dmg) &nbsp;(Apple Silicon — M1/M2/M3)

Got an older **Intel Mac**? [Download the Intel version instead.](https://github.com/Blueturboguy07/NitroAI/releases/latest/download/NitroAI-mac-x64.dmg)

### 👉 [Click this link to download for Windows](https://github.com/Blueturboguy07/NitroAI/releases/latest/download/NitroAI-Setup-Windows.exe) &nbsp;(untested — see warning above)

Or browse every version on the [Releases page](https://github.com/Blueturboguy07/NitroAI/releases/latest).

Open the installer, drag NitroAI to Applications, launch it, and you're done. On first launch you choose how the AI runs (see below).

**Because these builds aren't signed with a paid Apple/Microsoft certificate, your OS will warn you the first time:**

- **macOS** — you'll see *"NitroAI is damaged and can't be opened."* It isn't damaged; that's just how macOS treats un-notarized downloads. Open **Terminal** and run this once, then launch normally:
  ```bash
  xattr -cr /Applications/NitroAI.app
  ```
  (That removes the "downloaded from the internet" quarantine flag. Adjust the path if you put the app somewhere other than Applications.)
- **Windows** — click *More info → Run anyway* on the SmartScreen prompt.

Signing the apps so these warnings disappear needs a paid Apple Developer ($99/yr) and Windows code-signing certificate — intentionally left out of this starting point.

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

## Tech

React 19 · Vite · Tailwind · Electron shell · Ollama (local) · OpenAI / Anthropic (cloud) · KaTeX · FSRS spaced repetition. No backend, no telemetry, no account.

## License

[AGPL-3.0-or-later](LICENSE). Fork it, ship it, improve it — just keep it open.
