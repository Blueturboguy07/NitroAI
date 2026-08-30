/* Capability routing. Generation code calls supportsTask() before invoking
   an engine method that not every engine implements (e.g. Anthropic has no
   transcription/TTS/embeddings, local has no TTS yet), and falls back to
   unsupportedMessage() for a clean, user-facing explanation instead of letting
   the raw EngineError surface. */

import type { Engine } from "./types";

export type Task = "chat" | "transcription" | "tts" | "embeddings";

export function supportsTask(engine: Engine, task: Task): boolean {
  const caps = engine.capabilities();
  switch (task) {
    case "chat":
      return caps.chat;
    case "transcription":
      return caps.transcription;
    case "tts":
      return caps.tts;
    case "embeddings":
      return caps.embeddings;
  }
}

export function unsupportedMessage(task: Task): string {
  switch (task) {
    case "chat":
      return "This engine doesn't support chat. Switch to a cloud key or a chat-capable local model.";
    case "transcription":
      // Local mode transcribes with its own on-device Whisper, so the only
      // engine that lands here is Anthropic (no transcription endpoint).
      return "This engine can't transcribe audio. Use an OpenAI key, or switch to local mode — NitroAI runs Whisper on your machine.";
    case "tts":
      return "This engine doesn't support text-to-speech. Add an OpenAI key, or wait for local Kokoro support.";
    case "embeddings":
      return "This engine doesn't support embeddings. Add an OpenAI key or use a local embedding model.";
  }
}
