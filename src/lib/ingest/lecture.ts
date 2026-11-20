/* "Trim the solve-time gaps": the page's side of server/lecture.mjs.
 *
 * The local server downloads the lecture video, cuts the long stretches
 * where the class works alone, and keeps the shorter video. This file starts
 * that job, reads its progress, and hands the transcript to the usual notes
 * pipeline. Every call goes through localFetch (the app-only header). */

import type { IngestResult } from "./index";
import type { Note } from "../types";
import { localFetch } from "../localApi";
import { withScheme } from "./link";
import { youtubeId } from "./youtube";

export interface TrimSummary {
  originalSeconds: number;
  trimmedSeconds: number;
  cuts: number;
}

export interface LectureInfo extends TrimSummary {
  id: string;
}

interface TrimEvent {
  phase: "download" | "analyze" | "render" | "save" | "done" | "error";
  progress?: number;
  message?: string;
  id?: string;
  title?: string | null;
  transcript?: string;
  hasAudio?: boolean;
  summary?: TrimSummary;
}

export interface TrimHooks {
  /* A line for the progress window, for example "Cutting the video… 40%". */
  onProgress?: (message: string) => void;
  /* Stops the job: the server ends the download or the cut and keeps nothing. */
  signal?: AbortSignal;
}

export const NO_LOCAL_SERVER_MESSAGE =
  "Trimming a video needs the NitroAI desktop app (or `npm run preview`). This page has no local server to download and cut the video.";

/* 3130 → "52:10"; 3725 → "1:02:05". */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/* "Original 52:10 → Trimmed 38:42 (9 cuts)". */
export function trimSummaryText(s: TrimSummary): string {
  return `Original ${formatClock(s.originalSeconds)} → Trimmed ${formatClock(s.trimmedSeconds)} (${s.cuts} cut${s.cuts === 1 ? "" : "s"})`;
}

/* The line shown while the job runs. */
export function trimProgressText(phase: string, progress?: number): string {
  const pct = typeof progress === "number" && progress > 0 && progress < 1 ? ` ${Math.round(progress * 100)}%` : "";
  if (phase === "download") return `Downloading the video…${pct}`;
  if (phase === "analyze") return `Finding the solve-time gaps…${pct}`;
  if (phase === "render") return `Cutting the video…${pct}`;
  return "Saving the trimmed video…";
}

/* The trimmed video of a note, when it has one. */
export function lectureOf(note: Pick<Note, "sourceMeta">): LectureInfo | null {
  const m = note.sourceMeta;
  if (!m || typeof m.lectureId !== "string" || !/^[a-f0-9]{32}$/.test(m.lectureId)) return null;
  return {
    id: m.lectureId,
    originalSeconds: Number(m.originalSeconds) || 0,
    trimmedSeconds: Number(m.trimmedSeconds) || 0,
    cuts: Number(m.cuts) || 0,
  };
}

/* Is ffmpeg on this computer? null: there is no local server here. */
export async function lectureStatus(): Promise<{ ffmpeg: boolean; message: string | null } | null> {
  try {
    const res = await localFetch("/api/lecture/status");
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) return null;
    const body = (await res.json()) as { ffmpeg?: boolean; message?: string | null };
    return { ffmpeg: body.ffmpeg === true, message: body.message ?? null };
  } catch {
    return null;
  }
}

/* The trimmed video's bytes. The server needs the app header, which a bare
   <video src> cannot send, so the page fetches the file and plays the blob. */
export async function fetchLectureVideo(id: string, signal?: AbortSignal): Promise<Blob> {
  const res = await localFetch(`/api/lecture/video?id=${encodeURIComponent(id)}`, { signal });
  if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("video/")) {
    throw new Error("The trimmed video is not on this computer any more.");
  }
  return res.blob();
}

/* Delete a trimmed video (its note was deleted, or was never made). Quiet. */
export async function discardLecture(id: string): Promise<void> {
  try {
    await localFetch("/api/lecture/delete", { method: "POST", body: JSON.stringify({ id }) });
  } catch {
    /* the server is gone; nothing to do */
  }
}

async function* readEvents(res: Response): AsyncGenerator<TrimEvent> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (!block.startsWith("data: ")) continue;
      try {
        yield JSON.parse(block.slice(6)) as TrimEvent;
      } catch {
        /* half a line: skip it */
      }
    }
  }
}

/* Run the trim for a YouTube link and return what the notes pipeline needs:
   the captions as text, or the trimmed sound to transcribe when the video
   has no captions. `meta` carries the video's id and the summary. */
export async function ingestLectureTrim(typed: string, hooks: TrimHooks = {}): Promise<IngestResult> {
  const url = withScheme(typed);
  if (!youtubeId(url)) throw new Error(`"${typed}" doesn't look like a YouTube URL.`);

  let res: Response;
  try {
    res = await localFetch("/api/lecture/trim", { method: "POST", body: JSON.stringify({ url }), signal: hooks.signal });
  } catch (err) {
    if (hooks.signal?.aborted) throw err;
    throw new Error(NO_LOCAL_SERVER_MESSAGE);
  }
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await res.json()) as { error?: string };
    throw new Error(body.error || "The video could not be trimmed.");
  }
  if (!res.ok || !type.includes("text/event-stream") || !res.body) throw new Error(NO_LOCAL_SERVER_MESSAGE);

  let done: TrimEvent | null = null;
  for await (const event of readEvents(res)) {
    if (event.phase === "error") throw new Error(event.message || "The video could not be trimmed.");
    if (event.phase === "done") done = event;
    else hooks.onProgress?.(trimProgressText(event.phase, event.progress));
  }
  if (!done?.id || !done.summary) {
    // The stream ended with no result: stopped, or the server went away.
    hooks.signal?.throwIfAborted();
    throw new Error("The video could not be trimmed. The local server stopped answering.");
  }

  const title = done.title || undefined;
  const meta = {
    url,
    lectureId: done.id,
    originalSeconds: done.summary.originalSeconds,
    trimmedSeconds: done.summary.trimmedSeconds,
    cuts: done.summary.cuts,
  };
  if (done.transcript && done.transcript.trim()) return { text: done.transcript, title, meta };

  try {
    if (!done.hasAudio) throw new Error("This video has no captions and no sound, so there is nothing to make notes from.");
    const audioRes = await localFetch(`/api/lecture/audio?id=${done.id}`, { signal: hooks.signal });
    if (!audioRes.ok) throw new Error("The trimmed video's sound could not be read.");
    const audio = new Blob([await audioRes.arrayBuffer()], { type: "audio/mp4" });
    return { text: "", title, needsTranscription: true, audio, meta: { ...meta, filename: `${title ?? "lecture"}.m4a` } };
  } catch (err) {
    await discardLecture(done.id);
    throw err;
  }
}
