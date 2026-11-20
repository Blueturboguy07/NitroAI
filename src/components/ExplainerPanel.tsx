import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Clapperboard, Download, Loader2, Sparkles } from "lucide-react";
import { useApp } from "../lib/app";
import { EngineError } from "../lib/engine/types";
import { describeError, type ShownError } from "../lib/publik";
import { ErrorNotice } from "./PublikNotice";
import { contentFor, explainerVoiceChars, generateExplainerScript } from "../lib/generation";
import { buildExplainerVideo } from "../lib/explainer/video";
import { discardLecture, fetchLectureVideo, formatClock } from "../lib/ingest/lecture";
import { now } from "../lib/ids";
import type { Explainer, Note } from "../lib/types";

/* "Explainer video": a short slide video with a voice, made from the note.
   Two steps, as for the podcast: write the script (one cheap call), then
   make the video (the voice is the paid part, so it starts only on a click,
   after the user has seen how much text will be read). */
export default function ExplainerPanel({ note, onNote }: { note: Note; onNote: (n: Note) => void }) {
  const { repo, engine } = useApp();
  const explainer = note.explainer ?? null;
  const [writing, setWriting] = useState(false);
  const [building, setBuilding] = useState<string | null>(null); // the progress line
  const [err, setErr] = useState<ShownError | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  const isEmpty = !contentFor(note).trim();
  const ttsAvailable = engine?.capabilities().tts ?? false;
  const videoId = explainer?.videoId;

  // Play the finished video from the local server (a blob: the server needs the app header).
  useEffect(() => {
    setSrc(null);
    setGone(false);
    if (!videoId) return;
    const stop = new AbortController();
    let made: string | null = null;
    fetchLectureVideo(videoId, stop.signal)
      .then((blob) => {
        if (stop.signal.aborted) return;
        made = URL.createObjectURL(blob);
        setSrc(made);
      })
      .catch(() => {
        if (!stop.signal.aborted) setGone(true);
      });
    return () => {
      stop.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [videoId]);

  async function save(next: Explainer) {
    const updated = { ...note, explainer: next, updatedAt: now() };
    await repo?.putNote(updated);
    onNote(updated);
  }

  function shown(e: unknown, fallback: string): ShownError {
    if (e instanceof EngineError) return describeError(e);
    return { message: e instanceof Error && e.message ? e.message : fallback, action: null };
  }

  async function writeScript() {
    if (!engine || writing || building) return;
    setErr(null);
    setWriting(true);
    try {
      const slides = await generateExplainerScript(engine, note);
      // A new script: the old video no longer matches it.
      if (explainer?.videoId) void discardLecture(explainer.videoId);
      await save({ slides, createdAt: now() });
    } catch (e) {
      setErr(shown(e, "Something went wrong writing the script. Please try again."));
    } finally {
      setWriting(false);
    }
  }

  async function makeVideo() {
    if (!engine || !explainer || building || writing) return;
    setErr(null);
    setBuilding("Recording the voice…");
    try {
      const made = await buildExplainerVideo(engine, explainer.slides, { onProgress: setBuilding });
      if (explainer.videoId) void discardLecture(explainer.videoId);
      await save({ ...explainer, videoId: made.id, seconds: made.seconds });
    } catch (e) {
      setErr(shown(e, "Something went wrong making the video. Please try again."));
    } finally {
      setBuilding(null);
    }
  }

  function saveVideo() {
    if (!src) return;
    const a = document.createElement("a");
    a.href = src;
    a.download = `${note.title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "explainer"} (explainer).mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  const primary = "flex items-center gap-2 rounded-xl px-6 py-3 font-display font-bold transition";
  const on = "bg-accent text-white hover:bg-accent-hover";
  const off = "cursor-not-allowed bg-accent-softer text-ink-faint";

  return (
    <div className="px-16 py-12">
      <div className="text-center">
        <h1 className="font-display text-4xl font-bold">Explainer video</h1>
        <p className="mt-2 text-ink-faint">A short slide video with a voice, made from your notes.</p>
      </div>

      {isEmpty ? (
        <div className="mx-auto mt-10 max-w-4xl rounded-card bg-callout-bg p-6">
          <div className="flex items-center gap-3">
            <AlertCircle className="size-5 text-callout-ink" />
            <span className="font-display font-bold">Document is empty!</span>
          </div>
          <p className="mt-3 pl-8 text-ink-dim">Add some notes to your document first. The video is made from the notes.</p>
        </div>
      ) : (
        <div className="mx-auto mt-10 max-w-3xl">
          <div className="flex flex-col items-center gap-4">
            <button onClick={writeScript} disabled={!engine || writing || !!building} className={explainer ? "flex items-center gap-2 rounded-xl border border-edge bg-card px-4 py-2 text-sm font-semibold text-ink-dim shadow-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-60" : `${primary} ${engine && !writing ? on : off}`}>
              {writing ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {writing ? "Writing the script…" : explainer ? "Write a new script" : "Write the script"}
            </button>
            {!engine && (
              <p className="text-sm text-ink-faint">
                <Link to="/settings" className="font-semibold text-accent hover:underline">
                  Set up your engine in Settings
                </Link>{" "}
                first.
              </p>
            )}
            {err && (
              <div className="w-full">
                <ErrorNotice err={err} />
              </div>
            )}
          </div>

          {explainer && (
            <>
              <ol className="mt-10 flex flex-col gap-4">
                {explainer.slides.map((slide, i) => (
                  <li key={i} className="rounded-card border border-edge bg-card p-5 shadow-soft">
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Slide {i + 1}</p>
                    <h3 className="mt-1 font-display text-lg font-bold">{slide.title}</h3>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-dim">
                      {slide.bullets.map((b, j) => (
                        <li key={j}>{b}</li>
                      ))}
                    </ul>
                    <p className="selectable mt-3 rounded-xl bg-accent-softer px-4 py-3 text-sm leading-relaxed text-ink">{slide.narration}</p>
                  </li>
                ))}
              </ol>

              <div className="mt-8 rounded-card border border-edge bg-card p-5 shadow-soft">
                <div className="flex items-center gap-2">
                  <Clapperboard className="size-4.5 text-accent" />
                  <h3 className="font-display font-bold">Video</h3>
                </div>

                {!ttsAvailable ? (
                  <p className="mt-3 text-sm text-ink-faint">
                    The voice needs publik API or an OpenAI key. The script is ready to read above.
                  </p>
                ) : (
                  <div className="mt-4 flex flex-col gap-3">
                    {src && <video controls preload="metadata" src={src} className="max-h-96 w-full rounded-xl bg-black" />}
                    {videoId && !src && !gone && (
                      <div className="flex h-24 items-center justify-center gap-2.5 text-sm text-ink-faint">
                        <Loader2 className="size-4 animate-spin text-accent" />
                        <span>Opening the video…</span>
                      </div>
                    )}
                    {gone && <p className="text-sm text-ink-faint">The video is not on this computer any more. You can make it again.</p>}
                    <p className="text-sm text-ink-dim">
                      {explainer.slides.length} slide{explainer.slides.length === 1 ? "" : "s"}. The voice reads{" "}
                      {explainerVoiceChars(explainer.slides).toLocaleString("en-US")} characters; text-to-speech is paid per character.
                      {videoId && explainer.seconds ? ` Length ${formatClock(explainer.seconds)}.` : ""}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <button onClick={makeVideo} disabled={!!building || writing} className={`w-fit ${primary.replace("px-6 py-3", "px-5 py-2.5")} ${!building && !writing ? on : off}`}>
                        {building ? <Loader2 className="size-4 animate-spin" /> : <Clapperboard className="size-4" />}
                        {building ?? (videoId ? "Make the video again" : "Make the video")}
                      </button>
                      {src && (
                        <button onClick={saveVideo} className="flex w-fit items-center gap-2 rounded-xl border border-edge bg-card px-4 py-2 text-sm font-semibold text-ink-dim shadow-soft hover:text-ink">
                          <Download className="size-4" />
                          Save video
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
