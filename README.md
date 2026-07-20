# NitroAI

A free, open-source, local-first study app — turn lectures, PDFs, YouTube links,
and audio into AI notes, flashcards, quizzes, podcasts, and a source-grounded
chat. Desktop app for macOS + Windows (Tauri), and it runs in any browser for
development. **No subscription, no paywalls, no billing** — pick a fully-local
engine or bring your own OpenAI/Anthropic key.

Licensed **AGPL-3.0**.

## Features

| Surface | What it does |
|---|---|
| **Dashboard** | Create notes from a blank doc, audio, document (PDF/DOCX), or a website/YouTube link. Search (⌘K), folders, date-grouped recents. |
| **AI Notes editor** | Block editor with a **`/` command menu** (headings, lists, to-do, quote, callout, code, equation, divider), KaTeX math, live-saved to local storage. |
| **Assistant / Chat** | Source-grounded streaming chat about the note, as a full page or a collapsible side panel. |
| **Flashcards** | Auto-generated, one concept per card, tagged by topic, with an FSRS spaced-repetition study loop (New / Learning / Mastered). |
| **Quiz** | MCQ + true/false + fill-in-the-blank, difficulty levels, per-answer explanations, per-topic mastery, reset & retake. |
| **Podcast** | Two-host dialogue generated from the note, with pronunciation-normalized TTS and MP3 download. |
| **Export** | Any note to Markdown, PDF, or Word — your data is never locked in. |

## Engine: local or bring-your-own-key

You choose at onboarding (no default is forced):

- **Local** — everything runs on your machine via [Ollama](https://ollama.com)
  for text/chat/embeddings. Private, offline, zero cost. (Local Whisper/Kokoro
  for audio transcription + TTS is wired behind the same interface; install a
  local Whisper server / Kokoro to enable those, or use a cloud key.)
- **Bring your own key** — paste an OpenAI (`sk-…`) or Anthropic (`sk-ant-…`)
  key; the provider is auto-detected. One key powers every feature. On the
  desktop build the key is stored in the OS keychain; in the browser build it
  falls back to `localStorage`.

Every feature is engine-agnostic — the same code streams tokens whether they
come from local or cloud.

### Large documents & YouTube

- **Any-size documents:** note generation splits large sources into token-budgeted
  sections (map), writes notes per section, and merges them (reduce), and every
  model call retries with backoff on rate limits — so a big PDF or a low
  tokens-per-minute key just runs slower instead of failing. Study tools generate
  from the distilled notes, keeping their inputs small.
- **YouTube:** YouTube's 2026 bot-gating makes browser caption fetches return
  empty, so the reliable free path is **desktop-only**: the app runs `yt-dlp`
  (captions first, else it extracts the audio) and transcribes with Whisper.
  Install `yt-dlp` on your PATH (or bundle it as a Tauri sidecar). In the browser
  build, paste-a-YouTube-link can't work — download the audio and use
  "Record or upload audio" instead. (Note: automated YouTube extraction carries
  real 2026 DMCA §1201 legal risk — keep it client-local and transient.)
- **Audio size:** cloud Whisper caps uploads at ~25 MB; longer lectures need local
  transcription (no cap) or splitting the file.

## Run it

**Requirements:** Node **≥ 20.19** or **≥ 22.12** (the Vite 7 dev server needs
`crypto.hash`; Node 21.5 is too old for `npm run dev` specifically — the build
still works on it). Rust + the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
only for the native desktop build.

```bash
npm install

# Web dev (fastest; needs Node ≥ 20.19 / 22.12)
npm run dev            # http://localhost:1420

# Or preview a production build (works on any Node)
npm run build
npm run preview        # http://localhost:4173

# Desktop app (macOS/Windows) — first Rust build takes a few minutes
npm run tauri dev
npm run tauri build    # ship ONLY via this, never bare cargo
```

To actually generate content you need an engine: either add a cloud key in
onboarding/Settings, or run `ollama serve` with a model pulled (e.g.
`ollama pull qwen2.5:7b`) and choose **Local**.

## Test

```bash
npm test          # vitest — 94 unit/integration tests
npm run typecheck # tsc --noEmit
```

Covered: engine providers (mocked streaming/structured/transcribe), storage +
repository, FSRS scheduler + quiz mastery, ingestion routing + YouTube parsing,
markdown↔blocks round-trip, and the full note-creation pipeline (multi-source
ingest with per-file status, transcription, blank notes) against a fake engine.

## Architecture

```
src/lib/
  types.ts            domain model (Note, Block, Flashcard, QuizQuestion, Job…)
  engine/             Engine interface + OpenAI / Anthropic / Local (Ollama) impls
  db/                 Store interface + IndexedDB (app) and in-memory (test) impls, Repo
  prompts/            versioned prompt templates + JSON schemas
  generation/         notes, flashcards, quiz, chat, podcast tasks + note pipeline
  study/              FSRS scheduler + per-topic quiz mastery
  ingest/             text / url / youtube / pdf / docx / audio → normalized text
  markdown.ts         blocks ↔ markdown, inline/block/KaTeX rendering
  export.ts           Markdown / PDF / Word export
  app.tsx             React context: opens the DB, builds the active engine
src/components/        BlockEditor, Assistant, Flashcards/Quiz/Podcast views, modals
src/pages/             Dashboard, NoteView, Settings, Onboarding
src-tauri/             Tauri shell + OS-keychain commands for the API key
```

The app logic lives in TypeScript so every feature works in the browser and is
unit-testable without a Rust build or model download. Native local inference
(whisper.cpp / llama.cpp / Kokoro via Rust FFI) slots in behind the existing
`Engine` interface.
