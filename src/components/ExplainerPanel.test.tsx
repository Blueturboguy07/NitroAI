// @vitest-environment jsdom
/* The "Explainer video" view of a note: write the script (cheap), see how
   much the voice will read, then make the video. The engine, the canvas and
   the local server are stand-ins. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Note } from "../lib/types";

const ID = "0123456789abcdef0123456789abcdef";
const SLIDES = [
  { title: "What is a limit?", bullets: ["A value a function gets close to", "Not always the value at the point"], narration: "A limit is the value that a function gets close to." },
  { title: "Why limits matter", bullets: ["They define the derivative", "They define the integral"], narration: "Limits are the base of calculus." },
];

const state = vi.hoisted(() => ({
  tts: true,
  engine: true,
  saved: [] as unknown[],
  script: vi.fn(),
  build: vi.fn(),
}));

vi.mock("../lib/app", () => ({
  useApp: () => ({
    repo: { putNote: async (n: unknown) => void state.saved.push(n) },
    engine: state.engine ? { capabilities: () => ({ chat: true, transcription: true, tts: state.tts, embeddings: false }) } : null,
  }),
}));
vi.mock("../lib/generation", async (orig) => ({ ...(await orig<typeof import("../lib/generation")>()), generateExplainerScript: state.script }));
vi.mock("../lib/explainer/video", () => ({ buildExplainerVideo: state.build }));

const { default: ExplainerPanel } = await import("./ExplainerPanel");

function note(extra: Partial<Note> = {}): Note {
  return { id: "n1", title: "Limits", sourceKind: "pdf", sourceText: "A limit is…", blocks: [{ id: "b1", type: "paragraph", text: "A limit is the value a function gets close to." }], createdAt: 0, updatedAt: 0, lastOpenedAt: 0, ...extra };
}

/* The panel with a parent that keeps the note, as NoteView does. */
function show(first: Note) {
  let current = first;
  const view = render(
    <MemoryRouter>
      <ExplainerPanel note={current} onNote={(n) => { current = n; view.rerender(<MemoryRouter><ExplainerPanel note={current} onNote={() => {}} /></MemoryRouter>); }} />
    </MemoryRouter>,
  );
  return view;
}

let fetched: string[];
beforeEach(() => {
  state.tts = true;
  state.engine = true;
  state.saved = [];
  state.script.mockReset().mockResolvedValue(SLIDES);
  state.build.mockReset().mockResolvedValue({ id: ID, seconds: 42 });
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      fetched.push(path);
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } });
    }),
  );
  URL.createObjectURL = vi.fn(() => "blob:explainer");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ExplainerPanel", () => {
  it("step 1 writes the script and saves it on the note; no voice is recorded yet", async () => {
    show(note());
    expect(screen.queryByRole("button", { name: /make the video/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Write the script" }));
    expect(await screen.findByText("What is a limit?")).toBeInTheDocument();
    expect(screen.getByText("Limits are the base of calculus.")).toBeInTheDocument();
    expect(state.script).toHaveBeenCalledTimes(1);
    expect(state.build).not.toHaveBeenCalled();
    expect(state.saved).toHaveLength(1);
    expect((state.saved[0] as Note).explainer?.slides).toEqual(SLIDES);
    // Before the paid step: how much the voice will read.
    const chars = SLIDES[0].narration.length + SLIDES[1].narration.length;
    expect(screen.getByText(new RegExp(`2 slides\\. The voice reads ${chars} characters; text-to-speech is paid per character\\.`))).toBeInTheDocument();
  });

  it("step 2 makes the video on a click, saves its id, and shows the player and Save video", async () => {
    const { container } = show(note({ explainer: { slides: SLIDES, createdAt: 1 } }));
    fireEvent.click(screen.getByRole("button", { name: "Make the video" }));
    await vi.waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    expect(state.build).toHaveBeenCalledTimes(1);
    expect(state.build.mock.calls[0][1]).toEqual(SLIDES);
    expect((state.saved[0] as Note).explainer).toMatchObject({ videoId: ID, seconds: 42, slides: SLIDES });
    expect(fetched).toEqual([`/api/lecture/video?id=${ID}`]);
    expect(container.querySelector("video")!.getAttribute("src")).toBe("blob:explainer");
    expect(screen.getByText(/Length 0:42\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save video/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make the video again" })).toBeInTheDocument();
  });

  it("a failure is shown in words and nothing is saved", async () => {
    state.build.mockRejectedValue(new Error("Making a video needs ffmpeg on this computer."));
    show(note({ explainer: { slides: SLIDES, createdAt: 1 } }));
    fireEvent.click(screen.getByRole("button", { name: "Make the video" }));
    expect(await screen.findByText("Making a video needs ffmpeg on this computer.")).toBeInTheDocument();
    expect(state.saved).toEqual([]);
    expect(screen.getByRole("button", { name: "Make the video" })).toBeEnabled();
  });

  it("an engine with no text-to-speech: the script still shows, the video step says what is needed", () => {
    state.tts = false;
    show(note({ explainer: { slides: SLIDES, createdAt: 1 } }));
    expect(screen.getByText("What is a limit?")).toBeInTheDocument();
    expect(screen.getByText(/The voice needs publik API or an OpenAI key/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /make the video/i })).not.toBeInTheDocument();
  });

  it("an empty note, and no engine", () => {
    show(note({ blocks: [], sourceText: "" }));
    expect(screen.getByText("Document is empty!")).toBeInTheDocument();
    cleanup();
    state.engine = false;
    show(note());
    expect(screen.getByRole("button", { name: "Write the script" })).toBeDisabled();
    expect(screen.getByText(/Set up your engine in Settings/)).toBeInTheDocument();
  });
});
