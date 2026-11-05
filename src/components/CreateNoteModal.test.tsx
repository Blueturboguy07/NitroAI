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

/* D1 (blind verify of 89b3aa4): a drop skips the file dialog's filter, and
   every name that was not .pdf/.doc/.docx was sent as text. A dropped .pptx
   made 8 paid calls. Now the window refuses it on drop and on pick, shows the
   message, and never passes it to onGenerate. */
describe("CreateNoteModal — document types (D1)", () => {
  const EXACT =
    "NitroAI reads PDF, Word (.docx, .doc), .txt and .md files. For slides, save them as PDF and upload that.";

  function pptx(name = "Week 5 slides.pptx"): File {
    const b = new Uint8Array(120 * 1024);
    b.set([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
    return new File([b], name, {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
  }

  function renderDoc() {
    const onGenerate = vi.fn();
    const view = render(
      <CreateNoteModal source="document" engine={fakeEngine(true)} onGenerate={onGenerate} onClose={() => {}} />,
    );
    const zone = screen.getByText(/Drag documents here/).closest("label")!;
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    const generate = screen.getByRole("button", { name: "Generate Notes" });
    return { onGenerate, zone, input, generate };
  }

  const drop = (zone: Element, files: File[]) => fireEvent.drop(zone, { dataTransfer: { files } });

  it("a dropped .pptx shows the message, is not added, and Generate stays off", async () => {
    const { onGenerate, zone, generate } = renderDoc();
    drop(zone, [pptx()]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(EXACT);
    expect(alert).toHaveTextContent("Week 5 slides.pptx");
    expect(screen.queryByText(/file.? selected/)).not.toBeInTheDocument();
    expect(generate).toBeDisabled();
    fireEvent.click(generate);
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it("a picked .pptx (dialog set to All files) is refused the same way", async () => {
    const { input, generate } = renderDoc();
    fireEvent.change(input, { target: { files: [pptx("deck.ppt")] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(EXACT);
    expect(generate).toBeDisabled();
  });

  it("a .txt with binary data and a .txt over 2 MB are refused with words", async () => {
    const { zone, generate } = renderDoc();
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1).fill(0x61)], "huge.txt");
    const renamed = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])], "renamed.txt");
    drop(zone, [big, renamed]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/"huge.txt" is 2.0 MB\. NitroAI reads \.txt and \.md files up to 2 MB/);
    expect(alert).toHaveTextContent(/"renamed.txt" is not plain text/);
    expect(generate).toBeDisabled();
  });

  it("in a mixed drop the good files are added and only the bad one is refused", async () => {
    const { onGenerate, zone, generate } = renderDoc();
    const md = new File(["# Week 3\n\n- C3 plants"], "week3.md");
    const pdf = new File(["%PDF-1.7"], "reading.pdf");
    drop(zone, [md, pptx(), pdf]);
    expect(await screen.findByText("2 files selected")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Week 5 slides.pptx");
    fireEvent.click(generate);
    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onGenerate.mock.calls[0][0].map((i: { kind: string; filename: string }) => [i.kind, i.filename])).toEqual([
      ["text", "week3.md"],
      ["pdf", "reading.pdf"],
    ]);
  });
});
