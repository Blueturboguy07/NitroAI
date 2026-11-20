import { useEffect, useState } from "react";
import { AlertCircle, Download, Loader2 } from "lucide-react";
import { fetchLectureVideo, lectureOf, trimSummaryText } from "../lib/ingest/lecture";
import type { Note } from "../lib/types";

/* The trimmed lecture video of a note ("Trim the solve-time gaps"): the
   player, "Original 52:10 → Trimmed 38:42 (9 cuts)" and "Save video".
   Renders nothing for a note that has no trimmed video.

   The file comes from the local server through fetch() with the app header
   (the server refuses a bare <video src>), and plays as a blob. */
export default function LectureVideo({ note }: { note: Note }) {
  const lecture = lectureOf(note);
  const id = lecture?.id;
  const [src, setSrc] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const stop = new AbortController();
    let made: string | null = null;
    setSrc(null);
    setProblem(null);
    fetchLectureVideo(id, stop.signal)
      .then((blob) => {
        if (stop.signal.aborted) return;
        made = URL.createObjectURL(blob);
        setSrc(made);
      })
      .catch((err: unknown) => {
        if (stop.signal.aborted) return;
        setProblem(err instanceof Error ? err.message : "The trimmed video could not be opened.");
      });
    return () => {
      stop.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [id]);

  if (!lecture) return null;

  function save() {
    if (!src) return;
    const a = document.createElement("a");
    a.href = src;
    a.download = `${note.title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "lecture"} (trimmed).mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <section aria-label="Trimmed video" className="mx-6 mb-4 rounded-card border border-edge bg-card p-4 shadow-soft">
      {problem ? (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-danger-ink/30 bg-danger-soft px-3.5 py-3 text-xs font-semibold text-danger-ink">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span>{problem}</span>
        </div>
      ) : src ? (
        <video controls preload="metadata" src={src} className="max-h-80 w-full rounded-xl bg-black" />
      ) : (
        <div className="flex h-24 items-center justify-center gap-2.5 text-sm text-ink-faint">
          <Loader2 className="size-4 animate-spin text-accent" />
          <span>Opening the trimmed video…</span>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-dim">
          <span className="font-semibold text-ink">{trimSummaryText(lecture)}</span>
          {lecture.cuts === 0 && <span className="ml-2 text-ink-faint">NitroAI found no long gap to cut.</span>}
        </p>
        <button
          onClick={save}
          disabled={!src}
          className={`flex items-center gap-2 rounded-xl px-4 py-2 font-display text-sm font-bold transition ${
            src ? "bg-accent text-white hover:bg-accent-hover" : "cursor-not-allowed bg-accent-softer text-ink-faint"
          }`}
        >
          <Download className="size-4" />
          Save video
        </button>
      </div>
    </section>
  );
}
