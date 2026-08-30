/* Messages exchanged with the transcription worker. Kept in their own module so
   the main thread can talk about them without importing the worker (and, with
   it, all of transformers.js) at module load. */

export const WHISPER_SAMPLE_RATE = 16000;

/* Whisper's own receptive field is 30 s; longer audio is cut into overlapping
   windows and stitched back together. The worker derives its progress from
   these, so they live here rather than inline. */
export const CHUNK_LENGTH_S = 30;
export const STRIDE_LENGTH_S = 5;

export interface WhisperRequest {
  type: "transcribe";
  id: number;
  pcm: Float32Array;
  model: string;
  /* Where the installed model files are served from (the local server's
     /api/local/models/). Empty means "no provisioning server here" — the worker
     then loads the model straight from Hugging Face, which is what a plain
     `npm run dev` without the server does. */
  modelPath: string;
}

export type WhisperResponse =
  | { type: "progress"; id: number; message: string; percent?: number }
  | { type: "result"; id: number; text: string; segments: WhisperSegment[]; language?: string }
  | { type: "error"; id: number; message: string };

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}
