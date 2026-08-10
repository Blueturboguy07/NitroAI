/* Capability routing. Generation code calls supportsTask() before invoking
   an engine method that not every engine implements (e.g. Anthropic has no
   transcription/TTS/embeddings, local has no transcription/TTS yet), and
   falls back to unsupportedMessage() for a clean, user-facing explanation
   instead of letting the raw EngineError surface. */

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
      // Local speech-to-text (whisper.cpp) isn't implemented yet — there's no
      // setting anywhere to point NitroAI at a local Whisper server, so don't
      // suggest one. The one real path today is a cloud key.
      return "Local mode can't transcribe audio yet. Add an OpenAI key in Settings — NitroAI uses OpenAI's Whisper API automatically, nothing else to connect.";
    case "tts":
      return "This engine doesn't support text-to-speech. Add an OpenAI key, or wait for local Kokoro support.";
    case "embeddings":
      return "This engine doesn't support embeddings. Add an OpenAI key or use a local embedding model.";
  }
}
