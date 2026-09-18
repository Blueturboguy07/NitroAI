/* Capability routing. Generation code calls supportsTask() before invoking
   an engine method that not every engine implements (e.g. Anthropic has no
   transcription/TTS/embeddings, local has no transcription/TTS yet), and
   falls back to unsupportedMessage() for a clean, user-facing explanation
   instead of letting the raw EngineError surface. */

import type { Provider } from "../types";
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

export function unsupportedMessage(task: Task, provider?: Provider): string {
  if (provider === "publik") {
    // publik API carries every line the app uses (chat at 50% of list; audio,
    // voices and embeddings at cost). A capability can still be switched off
    // per install by the gateway, and this is what the user then reads.
    switch (task) {
      case "chat":
        return "publik API isn't carrying chat for this install right now. Use your own key or Local mode in Settings.";
      case "transcription":
        return "publik API isn't carrying audio transcription for this install right now. Add your own OpenAI key in Settings for audio and YouTube-without-captions.";
      case "tts":
        return "publik API isn't carrying podcast voices for this install right now. Add your own OpenAI key in Settings for voices.";
      case "embeddings":
        return "publik API isn't carrying embeddings for this install right now.";
    }
  }
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
