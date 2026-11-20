// @vitest-environment jsdom
/* The trimmed lecture video on a note ("Trim the solve-time gaps"): the
   player, the summary line and "Save video". The local server is a stand-in. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import LectureVideo from "./LectureVideo";
import type { Note } from "../lib/types";

const ID = "0123456789abcdef0123456789abcdef";

function note(sourceMeta: Note["sourceMeta"]): Note {
  return { id: "n1", title: "Calculus 1: limits", sourceKind: "youtube", sourceText: "", sourceMeta, blocks: [], createdAt: 0, updatedAt: 0, lastOpenedAt: 0 };
}

let seen: Array<{ path: string; app: string | null }>;
function server(answer: () => Response) {
  seen = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      seen.push({ path, app: new Headers(init?.headers).get("x-nitroai-app") });
      return answer();
    }),
  );
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:trimmed-video");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LectureVideo", () => {
  it("shows the video from the local server (with the app header), the summary, and Save video", async () => {
    server(() => new Response(new Uint8Array([0, 0, 0, 1]), { headers: { "content-type": "video/mp4" } }));
    const { container } = render(<LectureVideo note={note({ lectureId: ID, originalSeconds: 3130, trimmedSeconds: 2322, cuts: 9 })} />);
    expect(screen.getByText("Original 52:10 → Trimmed 38:42 (9 cuts)")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: /save video/i });
    expect(save).toBeDisabled(); // not before the video is here

    await vi.waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    const video = container.querySelector("video")!;
    expect(video.getAttribute("src")).toBe("blob:trimmed-video");
    expect(video).toHaveAttribute("controls");
    expect(seen).toEqual([{ path: `/api/lecture/video?id=${ID}`, app: "1" }]);
    expect(save).toBeEnabled();

    // Save video: a download of the same file, named after the note.
    const clicked: Array<{ href: string; download: string }> = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute("href") ?? "", download: this.download });
    });
    fireEvent.click(save);
    expect(clicked).toEqual([{ href: "blob:trimmed-video", download: "Calculus 1 limits (trimmed).mp4" }]);
    click.mockRestore();
  });

  it("0 cuts: says that no long gap was found", async () => {
    server(() => new Response(new Uint8Array([1]), { headers: { "content-type": "video/mp4" } }));
    render(<LectureVideo note={note({ lectureId: ID, originalSeconds: 600, trimmedSeconds: 600, cuts: 0 })} />);
    expect(screen.getByText("Original 10:00 → Trimmed 10:00 (0 cuts)")).toBeInTheDocument();
    expect(screen.getByText("NitroAI found no long gap to cut.")).toBeInTheDocument();
  });

  it("a video that is gone: words, no player, Save video stays off", async () => {
    server(() => new Response(JSON.stringify({ error: "gone" }), { status: 404, headers: { "content-type": "application/json" } }));
    const { container } = render(<LectureVideo note={note({ lectureId: ID, originalSeconds: 600, trimmedSeconds: 480, cuts: 2 })} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The trimmed video is not on this computer any more.");
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByRole("button", { name: /save video/i })).toBeDisabled();
  });

  it("a note with no trimmed video renders nothing and asks the server nothing", () => {
    server(() => new Response(""));
    const { container } = render(<LectureVideo note={note({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })} />);
    expect(container).toBeEmptyDOMElement();
    expect(seen).toEqual([]);
  });
});
