/* Capability routing. Generation code calls supportsTask() before invoking
   an engine method that not every engine implements (e.g. Anthropic has no
   transcription/TTS/embeddings, local has no transcription/TTS yet), and
   falls back to unsupportedMessage() for a clean, user-facing explanation
   instead of letting the raw EngineError surface. */

import type { Provider } from "../types";
import type { Engine } from "./types";

export type Task = "chat" | "transcription" | "tts" | "embeddings" | "vision";

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
    case "vision":
      // The method is optional on Engine — both the flag and the method
      // must be there (a wrapper that dropped it would otherwise lie).
      return caps.vision === true && typeof engine.readDocument === "function";
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
        return "publik API isn't carrying audio transcription for this install right now. Add your own OpenAI or Gemini key in Settings for audio and YouTube-without-captions.";
      case "tts":
        return "publik API isn't carrying podcast voices for this install right now. Add your own OpenAI or Gemini key in Settings for voices.";
      case "embeddings":
        return "publik API isn't carrying embeddings for this install right now.";
      case "vision":
        return "publik API isn't carrying image reading for this install right now, so scanned pages can't be read. Add your own Gemini, OpenAI or Anthropic key in Settings — any of them reads scanned PDFs.";
    }
  }
  switch (task) {
    case "chat":
      return "This engine doesn't support chat. Switch to a cloud key or a chat-capable local model.";
    case "transcription":
      // Local speech-to-text (whisper.cpp) isn't implemented yet — there's no
      // setting anywhere to point NitroAI at a local Whisper server, so don't
      // suggest one. The one real path today is a cloud key.
      return "This engine can't transcribe audio. Add an OpenAI or Gemini key in Settings — NitroAI transcribes with it automatically, nothing else to connect.";
    case "tts":
      return "This engine doesn't support text-to-speech. Add an OpenAI or Gemini key, or wait for local Kokoro support.";
    case "embeddings":
      return "This engine doesn't support embeddings. Add an OpenAI or Gemini key or use a local embedding model.";
    case "vision":
      // Only Local mode lands here today: every cloud key reads images.
      return "Your local model can't read images. Add a Gemini, OpenAI or Anthropic key in Settings, or pick a vision model (e.g. qwen2.5vl or llama3.2-vision) as your local model.";
  }
}
