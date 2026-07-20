import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  Download,
  Loader2,
  Mic,
  Play,
  Sparkles,
} from "lucide-react";
import { useApp } from "../lib/app";
import { EngineError } from "../lib/engine/types";
import { contentFor, synthesizePodcastAudio, generatePodcastScript } from "../lib/generation";
import type { Note, Podcast } from "../lib/types";

type Length = Podcast["length"];

const LENGTHS: { key: Length; label: string }[] = [
  { key: "short", label: "Short" },
  { key: "medium", label: "Medium" },
  { key: "long", label: "Long" },
];

/* Best-effort revoke — object URLs from a stale/superseded podcast are no
   longer reachable from state, so leaking them just wastes memory, never
   crashes; swallow any error. */
function revoke(url: string | undefined) {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* ignore */
  }
}

export default function PodcastPanel({ note }: { note: Note }) {
  const { repo, engine } = useApp();

  const [loaded, setLoaded] = useState(false);
  const [podcast, setPodcast] = useState<Podcast | null>(null);
  const [length, setLength] = useState<Length>("short");

  const [generating, setGenerating] = useState(false);
  const [scriptError, setScriptError] = useState<string | null>(null);

  const [audioGenerating, setAudioGenerating] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);

  // Load the most recent podcast for this note whenever the note changes.
  useEffect(() => {
    setLoaded(false);
    setPodcast(null);
    setScriptError(null);
    setAudioError(null);
    if (!repo) return;
    let alive = true;
    (async () => {
      const list = await repo.podcastsFor(note.id);
      if (!alive) return;
      const latest = list.length
        ? [...list].sort((a, b) => b.createdAt - a.createdAt)[0]
        : null;
      setPodcast(latest);
      if (latest) setLength(latest.length);
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [repo, note.id]);

  const content = contentFor(note);
  const isEmpty = !content.trim();
  const ttsAvailable = engine?.capabilities().tts ?? false;

  async function handleGenerate() {
    if (!engine || generating) return;
    setScriptError(null);
    setGenerating(true);
    try {
      const result = await generatePodcastScript(engine, note, length);
      if (repo) await repo.putPodcast(result);
      setPodcast((prev) => {
        revoke(prev?.audioUrl);
        return result;
      });
    } catch (e) {
      setScriptError(
        e instanceof EngineError
          ? e.message
          : "Something went wrong writing the script. Please try again.",
      );
    } finally {
      setGenerating(false);
    }
  }

  async function handleGenerateAudio() {
    if (!engine || !podcast || audioGenerating) return;
    setAudioError(null);
    setAudioGenerating(true);
    try {
      const blob = await synthesizePodcastAudio(engine, podcast);
      const url = URL.createObjectURL(blob);
      const updated: Podcast = { ...podcast, audioUrl: url };
      if (repo) await repo.putPodcast(updated);
      setPodcast((prev) => {
        if (prev?.audioUrl !== url) revoke(prev?.audioUrl);
        return updated;
      });
    } catch (e) {
      setAudioError(
        e instanceof EngineError
          ? e.message
          : "Something went wrong recording the audio. Please try again.",
      );
    } finally {
      setAudioGenerating(false);
    }
  }

  return (
    <div className="px-16 py-12">
      <div className="text-center">
        <h1 className="font-display text-4xl font-bold">
          ✨ Welcome to Podcasts ✨
        </h1>
        <p className="mt-2 text-ink-faint">
          Listen to your notes and bring them to life.
        </p>
      </div>

      {isEmpty ? (
        <div className="mx-auto mt-10 max-w-4xl rounded-card bg-callout-bg p-6">
          <div className="flex items-center gap-3">
            <AlertCircle className="size-5 text-callout-ink" />
            <span className="font-display font-bold">Document is empty!</span>
          </div>
          <p className="mt-3 pl-8 text-ink-dim">
            Add some notes to your document to generate a podcast. Podcasts
            are created based on the notes in your document.
          </p>
        </div>
      ) : !loaded ? (
        <div className="mt-16 flex justify-center text-ink-faint">
          <Loader2 className="size-6 animate-spin" />
        </div>
      ) : (
        <div className="mx-auto mt-10 max-w-3xl">
          <div className="flex flex-col items-center gap-4">
            <div className="flex items-center gap-2">
              {LENGTHS.map((l) => (
                <button
                  key={l.key}
                  onClick={() => setLength(l.key)}
                  disabled={generating}
                  className={`rounded-full px-4 py-1.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
                    length === l.key
                      ? "bg-accent text-white"
                      : "bg-card-hover text-ink-dim hover:text-ink"
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>

            {podcast ? (
              <button
                onClick={handleGenerate}
                disabled={!engine || generating}
                className="flex items-center gap-2 rounded-xl border border-edge bg-card px-4 py-2 text-sm font-semibold text-ink-dim shadow-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
              >
                {generating ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                {generating ? "Writing the script…" : "Regenerate"}
              </button>
            ) : (
              <button
                onClick={handleGenerate}
                disabled={!engine || generating}
                className={`flex items-center gap-2 rounded-xl px-6 py-3 font-display font-bold transition ${
                  engine && !generating
                    ? "bg-accent text-white hover:bg-accent-hover"
                    : "cursor-not-allowed bg-accent-softer text-ink-faint"
                }`}
              >
                {generating ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                {generating ? "Writing the script…" : "Generate podcast"}
              </button>
            )}

            {!engine && (
              <p className="text-sm text-ink-faint">
                <Link
                  to="/settings"
                  className="font-semibold text-accent hover:underline"
                >
                  Set up your engine in Settings
                </Link>{" "}
                first.
              </p>
            )}

            {scriptError && (
              <div className="flex w-full items-start gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-ink">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>{scriptError}</span>
              </div>
            )}
          </div>

          {podcast && (
            <>
              <div className="mt-10 flex flex-col gap-4">
                {podcast.script.map((line, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-3 ${
                      line.speaker === "guest" ? "flex-row-reverse" : ""
                    }`}
                  >
                    <div
                      className={`flex size-8 shrink-0 items-center justify-center rounded-full font-display text-xs font-bold ${
                        line.speaker === "host"
                          ? "bg-accent-soft text-accent"
                          : "bg-card-hover text-ink-dim"
                      }`}
                    >
                      {line.speaker === "host" ? "H" : "G"}
                    </div>
                    <div
                      className={`selectable max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-soft ${
                        line.speaker === "host"
                          ? "bg-accent-softer text-ink"
                          : "border border-edge bg-card text-ink"
                      }`}
                    >
                      {line.text}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-8 rounded-card border border-edge bg-card p-5 shadow-soft">
                <div className="flex items-center gap-2">
                  <Play className="size-4.5 text-accent" />
                  <h3 className="font-display font-bold">Audio</h3>
                </div>

                {ttsAvailable ? (
                  <div className="mt-4 flex flex-col gap-3">
                    {!podcast.audioUrl && (
                      <button
                        onClick={handleGenerateAudio}
                        disabled={audioGenerating}
                        className={`flex w-fit items-center gap-2 rounded-xl px-5 py-2.5 font-display font-bold transition ${
                          !audioGenerating
                            ? "bg-accent text-white hover:bg-accent-hover"
                            : "cursor-not-allowed bg-accent-softer text-ink-faint"
                        }`}
                      >
                        {audioGenerating ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Mic className="size-4" />
                        )}
                        {audioGenerating
                          ? "Recording voices…"
                          : "Generate audio"}
                      </button>
                    )}

                    {audioError && (
                      <div className="flex items-start gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-ink">
                        <AlertCircle className="mt-0.5 size-4 shrink-0" />
                        <span>{audioError}</span>
                      </div>
                    )}

                    {podcast.audioUrl && (
                      <div className="flex flex-col gap-3">
                        <audio
                          controls
                          src={podcast.audioUrl}
                          className="w-full"
                        />
                        <div className="flex items-center gap-2">
                          <a
                            href={podcast.audioUrl}
                            download={`${note.title || "podcast"}.mp3`}
                            className="flex w-fit items-center gap-2 rounded-xl border border-edge bg-card px-4 py-2 text-sm font-semibold text-ink-dim shadow-soft hover:text-ink"
                          >
                            <Download className="size-4" />
                            Download MP3
                          </a>
                          <button
                            onClick={handleGenerateAudio}
                            disabled={audioGenerating}
                            className="flex items-center gap-2 rounded-xl border border-edge bg-card px-4 py-2 text-sm font-semibold text-ink-dim shadow-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {audioGenerating ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Mic className="size-4" />
                            )}
                            {audioGenerating
                              ? "Recording voices…"
                              : "Regenerate audio"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-ink-faint">
                    Audio generation needs an OpenAI key or local Kokoro
                    voices — the script is ready to read above.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
