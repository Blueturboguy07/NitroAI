// @vitest-environment jsdom
/* "how tf do i connect whisper ai to nitro" — there is no separate Whisper
   setting to connect; local mode simply can't transcribe yet, and the only
   real path is adding a cloud key. This used to be discoverable only as a
   failure message AFTER attempting an upload. These tests pin the upfront
   in-app hint added to the audio upload step. */
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CreateNoteModal from "./CreateNoteModal";
import type { Engine } from "../lib/engine/types";

afterEach(cleanup);

function fakeEngine(transcription: boolean): Engine {
  return {
    mode: "local",
    capabilities: () => ({ chat: true, transcription, tts: false, embeddings: true }),
    complete: async () => "",
    structured: async () => ({}) as never,
    transcribe: async () => ({ text: "", segments: [] }),
    tts: async () => new Blob(),
    embed: async () => [],
    validate: async () => {},
  };
}

describe("CreateNoteModal — audio source Whisper hint", () => {
  it("shows a hint when the active engine can't transcribe (local mode)", () => {
    render(
      <CreateNoteModal
        source="audio"
        engine={fakeEngine(false)}
        onGenerate={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Local mode can't transcribe audio yet/)).toBeInTheDocument();
    expect(screen.getByText(/Add an OpenAI key in Settings/)).toBeInTheDocument();
  });

  it("hides the hint when the active engine can transcribe (cloud mode)", () => {
    render(
      <CreateNoteModal
        source="audio"
        engine={fakeEngine(true)}
        onGenerate={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/Local mode can't transcribe audio yet/)).not.toBeInTheDocument();
  });

  it("hides the hint when no engine is configured yet (nothing to warn about)", () => {
    render(
      <CreateNoteModal source="audio" engine={null} onGenerate={() => {}} onClose={() => {}} />,
    );
    expect(screen.queryByText(/Local mode can't transcribe audio yet/)).not.toBeInTheDocument();
  });

  it("never shows the audio hint for a non-audio source", () => {
    render(
      <CreateNoteModal
        source="document"
        engine={fakeEngine(false)}
        onGenerate={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/Local mode can't transcribe audio yet/)).not.toBeInTheDocument();
  });
});
