// bugfix-lab oracle for nitroai-local-whisper-stt-missing-and-unclear
//
// Exercises the exact runtime path the Dashboard UI hits when a "Fully local"
// user with no OpenAI key clicks "Upload audio": Dashboard.handleGenerate ->
// createNoteFromSources -> pipeline's ingest ("audio" kind sets
// needsTranscription + audio) -> engine.transcribe(). For the local engine
// that call throws synchronously (no Ollama/network involved), and
// Dashboard's catch block sets the banner text to `e.message` verbatim
// (see src/pages/Dashboard.tsx: `setErr(e instanceof Error ? e.message : ...)`).
//
// This is NOT a source grep: it imports the real class and invokes the real
// method, and prints whatever message that method actually throws today.
// No assertion here decides pass/fail -- the surrounding oracle.sh /
// bugfix-lab.ps1 wrapper reads the printed BUGFIX_LAB_MESSAGE line and
// decides PRESENT (exit 1) vs ABSENT (exit 0) by exact string match against
// the reporters' screenshot text.
import { describe, it } from "vitest";
import { writeFileSync } from "node:fs";
import { LocalEngine } from "./local";

// Written next to the repo root (cwd vitest runs from) so the CI wrapper
// script can read it without scraping console/reporter output, which
// reporters are free to buffer, truncate or reformat.
const OUT_FILE = "bugfix-lab-oracle-output.txt";

describe("bugfix-lab oracle: nitroai-local-whisper-stt-missing-and-unclear", () => {
  it("captures the banner text a Fully-local, no-OpenAI-key user sees on Upload audio", async () => {
    const engine = new LocalEngine();
    const audio = new Blob([new Uint8Array([0, 1, 2, 3])], { type: "audio/wav" });
    let message: string;
    try {
      await engine.transcribe(audio);
      message = "__NO_THROW__";
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    writeFileSync(OUT_FILE, message, "utf8");
  });
});
