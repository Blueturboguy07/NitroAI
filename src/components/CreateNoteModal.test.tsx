// @vitest-environment jsdom
/* "how tf do i connect whisper ai to nitro" — there is no separate Whisper
   setting to connect; local mode simply can't transcribe yet, and the only
   real path is adding a cloud key. This used to be discoverable only as a
   failure message AFTER attempting an upload. These tests pin the upfront
   in-app hint added to the audio upload step. */
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.getByText(/Add an OpenAI or Gemini key in Settings/)).toBeInTheDocument();
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

describe("CreateNoteModal — which files it accepts", () => {
  function drop(files: File[]) {
    const zone = screen.getByText(/Drag (documents|an audio file) here/).closest("label")!;
    fireEvent.drop(zone, { dataTransfer: { files } });
  }

  it("lists dropped documents, skips unreadable formats with a reason, and generates only readable ones", () => {
    const onGenerate = vi.fn();
    render(<CreateNoteModal source="document" engine={null} onGenerate={onGenerate} onClose={() => {}} />);
    drop([
      new File(["%PDF"], "slides.pdf", { type: "application/pdf" }),
      new File(["x"], "photo.png", { type: "image/png" }),
      new File(["x"], "essay.doc"),
      new File(["x"], "deck.pptx"),
    ]);
    expect(screen.getByText("slides.pdf")).toBeInTheDocument();
    expect(screen.getByText(/Skipped photo\.png isn't a PDF, Word \(\.docx\), \.txt or \.md file/)).toBeInTheDocument();
    expect(screen.getByText(/Skipped essay\.doc is an old Word \.doc — save it as \.docx or PDF first/)).toBeInTheDocument();
    expect(screen.getByText(/Skipped deck\.pptx is a slide deck — export it as PDF first/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Generate Notes"));
    expect(onGenerate).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "pdf", filename: "slides.pdf" }),
    ]);
  });

  it("removes a picked file and keeps files from a failed run", () => {
    const kept = new File(["text"], "week1.md", { type: "text/markdown" });
    render(
      <CreateNoteModal source="document" engine={null} initialFiles={[kept]} onGenerate={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByText("week1.md")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Remove week1.md"));
    expect(screen.queryByText("week1.md")).not.toBeInTheDocument();
    expect(screen.getByText("Generate Notes")).toBeDisabled();
  });

  it("accepts only audio/video on the audio card", () => {
    render(<CreateNoteModal source="audio" engine={null} onGenerate={() => {}} onClose={() => {}} />);
    drop([new File(["x"], "lecture.m4a"), new File(["x"], "notes.pdf", { type: "application/pdf" })]);
    expect(screen.getByText("lecture.m4a")).toBeInTheDocument();
    expect(screen.getByText(/Skipped notes\.pdf isn't an audio or video file/)).toBeInTheDocument();
  });
});
