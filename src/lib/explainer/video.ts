/* The explainer video of a note: script → voice → slides → one .mp4.

   Cheap path only: the script is ONE call on the fast tier
   (generateExplainerScript), the voice is the app's text-to-speech call
   (the same one as the podcast), the slides are drawn in this window, and
   the local server's ffmpeg joins them (POST /api/explainer/render). */

import type { Engine } from "../engine/types";
import type { ExplainerSlide } from "../types";
import { synthesizeExplainerAudio } from "../generation";
import { localFetch } from "../localApi";
import { slideToPng } from "./slides";

export const NO_VIDEO_SERVER_MESSAGE =
  "Making a video needs the NitroAI desktop app (or `npm run preview`). This page has no local server to build the video.";

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export interface BuildHooks {
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  /* Tests: a stand-in for the canvas. */
  draw?: (slide: ExplainerSlide, index: number, total: number) => Promise<Blob>;
}

/* Record the voice, draw the slides, and have the local server join them.
   Returns the video's id on the local server and its length. */
export async function buildExplainerVideo(engine: Engine, slides: ExplainerSlide[], hooks: BuildHooks = {}): Promise<{ id: string; seconds: number }> {
  const draw = hooks.draw ?? slideToPng;
  const clips = await synthesizeExplainerAudio(engine, slides, {
    signal: hooks.signal,
    onSlide: (done, total) => hooks.onProgress?.(`Recording the voice… ${done + 1} of ${total}`),
  });
  hooks.onProgress?.("Drawing the slides…");
  const body: { slides: { png: string; audio: string }[] } = { slides: [] };
  for (let i = 0; i < slides.length; i++) {
    body.slides.push({ png: await toBase64(await draw(slides[i], i, slides.length)), audio: await toBase64(clips[i]) });
  }
  hooks.signal?.throwIfAborted();

  hooks.onProgress?.("Building the video…");
  let res: Response;
  try {
    res = await localFetch("/api/explainer/render", { method: "POST", body: JSON.stringify(body), signal: hooks.signal });
  } catch (err) {
    if (hooks.signal?.aborted) throw err;
    throw new Error(NO_VIDEO_SERVER_MESSAGE);
  }
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) throw new Error(NO_VIDEO_SERVER_MESSAGE);
  const answer = (await res.json()) as { id?: string; seconds?: number; error?: string };
  if (!res.ok || !answer.id) throw new Error(answer.error || "The video could not be made.");
  return { id: answer.id, seconds: Number(answer.seconds) || 0 };
}
