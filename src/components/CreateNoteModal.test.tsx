// @vitest-environment jsdom
/* "how tf do i connect whisper ai to nitro" — the answer used to be "you
   can't": local mode had no speech-to-text at all, and the audio step told
   every local user to go get a cloud key. Local mode now runs Whisper on the
   device, so the only engine that still can't transcribe is Anthropic.

   These tests pin both halves: the warning appears for an engine that genuinely
   can't transcribe, and — the regression that matters — it does NOT appear for
   local mode, which would otherwise send users off to buy a key they don't
   need. */
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CreateNoteModal from "./CreateNoteModal";
import { unsupportedMessage } from "../lib/engine/router";
import type { Engine } from "../lib/engine/types";

afterEach(cleanup);

const WARNING = unsupportedMessage("transcription");

function fakeEngine(transcription: boolean, mode: "local" | "cloud" = "cloud"): Engine {
  return {
    mode,
    capabilities: () => ({ chat: true, transcription, tts: false, embeddings: true }),
    complete: async () => "",
    structured: async () => ({}) as never,
    transcribe: async () => ({ text: "", segments: [] }),
    tts: async () => new Blob(),
    embed: async () => [],
    validate: async () => {},
  };
}

describe("CreateNoteModal — audio source transcription warning", () => {
  it("warns when the active engine can't transcribe (e.g. an Anthropic key)", () => {
    render(
      <CreateNoteModal
        source="audio"
        engine={fakeEngine(false)}
        onGenerate={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  it("does not warn in local mode — Whisper runs on the device", () => {
    render(
      <CreateNoteModal
        source="audio"
        engine={fakeEngine(true, "local")}
        onGenerate={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it("does not warn when no engine is configured yet (nothing to warn about)", () => {
    render(
      <CreateNoteModal source="audio" engine={null} onGenerate={() => {}} onClose={() => {}} />,
    );
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it("never shows the audio warning for a non-audio source", () => {
    render(
      <CreateNoteModal
        source="document"
        engine={fakeEngine(false)}
        onGenerate={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });
});

/* The message itself must not send a local user to a cloud key — that was the
   original bug's copy, and it is now wrong as well as unhelpful. */
describe("unsupportedMessage('transcription')", () => {
  it("points at local mode as a real option", () => {
    expect(WARNING).toMatch(/local mode/i);
    expect(WARNING).toMatch(/Whisper/);
  });
});
