import { useState } from "react";
import { AlertCircle, FileAudio, FileText, Info, Link2, Upload, X } from "lucide-react";
import type { IngestInput } from "../lib/ingest";
import { isYoutube } from "../lib/ingest/youtube";
import type { Engine } from "../lib/engine/types";
import { supportsTask } from "../lib/engine/router";
import type { SourceKind } from "../lib/types";

export type NoteSource = "link" | "document" | "audio";

const meta: Record<NoteSource, { icon: typeof Link2; iconBg: string }> = {
  link: { icon: Link2, iconBg: "bg-red-500" },
  document: { icon: FileText, iconBg: "bg-accent" },
  audio: { icon: FileAudio, iconBg: "bg-accent" },
};

/* Only formats ingestion can actually read. Anything else used to fall
   through to "text" and send binary garbage (an image, a .pptx) to the model;
   drag-and-drop skips the picker's accept filter, so this is the real gate. */
const DOCUMENT_KINDS: Record<string, SourceKind> = {
  pdf: "pdf",
  docx: "docx",
  txt: "text",
  md: "text",
  markdown: "text",
};
const AUDIO_EXTS = new Set(["mp3", "m4a", "wav", "aac", "flac", "ogg", "oga", "opus", "webm", "mp4", "mov", "m4v", "mpeg", "mpga", "aiff", "aif"]);

function extOf(name: string): string {
  const parts = name.toLowerCase().split(".");
  return parts.length > 1 ? (parts.pop() ?? "") : "";
}

function kindForFile(name: string): SourceKind | null {
  return DOCUMENT_KINDS[extOf(name)] ?? null;
}

function isAudioFile(file: File): boolean {
  return /^(audio|video)\//.test(file.type) || AUDIO_EXTS.has(extOf(file.name));
}

/* Why a picked file can't be used, or null when it can. */
function rejectReason(file: File, source: NoteSource): string | null {
  if (source === "audio") {
    return isAudioFile(file) ? null : "isn't an audio or video file";
  }
  const ext = extOf(file.name);
  if (ext === "doc") return "is an old Word .doc — save it as .docx or PDF first";
  if (ext === "ppt" || ext === "pptx" || ext === "key") return "is a slide deck — export it as PDF first";
  return kindForFile(file.name) ? null : "isn't a PDF, Word (.docx), .txt or .md file";
}

export default function CreateNoteModal({
  source,
  busy,
  engine,
  initialFiles,
  onGenerate,
  onClose,
}: {
  source: NoteSource;
  busy?: boolean;
  /* Files picked last time, kept after a failed run so they needn't be
     picked again. */
  initialFiles?: File[];
  /* Used only to show an upfront "add a cloud key" hint for audio when the
     active engine can't transcribe (local mode has no speech-to-text yet) —
     surfacing that before the upload, not just as a failure afterward. */
  engine?: Engine | null;
  onGenerate: (inputs: IngestInput[]) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [files, setFiles] = useState<File[]>(initialFiles ?? []);
  const [rejected, setRejected] = useState<string[]>([]);
  const { icon: Icon, iconBg } = meta[source];
  const ready = source === "link" ? url.trim().length > 0 : files.length > 0;
  const canTranscribe = !engine || supportsTask(engine, "transcription");

  function submit() {
    if (!ready || busy) return;
    if (source === "link") {
      const u = url.trim();
      onGenerate([{ kind: isYoutube(u) ? "youtube" : "url", url: u }]);
    } else if (source === "document") {
      onGenerate(
        files.map((f) => ({ kind: kindForFile(f.name) ?? "text", file: f, filename: f.name })),
      );
    } else {
      onGenerate(files.map((f) => ({ kind: "audio", file: f, filename: f.name })));
    }
  }

  /* Keep the readable picks; list the rest with the reason. */
  function addFiles(picked: File[]) {
    const ok: File[] = [];
    const bad: string[] = [];
    for (const f of picked) {
      const reason = rejectReason(f, source);
      if (reason) bad.push(`${f.name} ${reason}.`);
      else if (!files.some((g) => g.name === f.name && g.size === f.size)) ok.push(f);
    }
    setFiles([...files, ...ok]);
    setRejected(bad);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="w-[560px] max-w-[90vw] rounded-modal bg-card p-8 shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-ink-faint hover:bg-card-hover hover:text-ink"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="flex flex-col items-center gap-4 pb-6">
          <span className={`flex size-16 items-center justify-center rounded-2xl ${iconBg}`}>
            <Icon className="size-8 text-white" />
          </span>
          <h2 className="font-display text-2xl font-bold">Create note from source</h2>
        </div>

        {source === "link" && (
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Paste a website or YouTube link..."
            className="w-full rounded-xl border border-edge bg-panel px-4 py-3.5 text-sm outline-none placeholder:text-ink-faint focus:border-accent"
          />
        )}

        {source === "document" && (
          <Dropzone
            label="Drag documents here, or click to upload (PDF, Word .docx, .txt, .md)"
            accept=".pdf,.docx,.txt,.md,.markdown"
            onFiles={addFiles}
            files={files}
            onRemove={(i) => setFiles(files.filter((_, j) => j !== i))}
            rejected={rejected}
          />
        )}

        {source === "audio" && (
          <>
            {!canTranscribe && (
              <div className="mb-3 flex items-start gap-2 rounded-xl border border-edge bg-panel px-3.5 py-3 text-xs text-ink-dim">
                <Info className="mt-0.5 size-3.5 shrink-0 text-accent" />
                <span>
                  {engine?.provider === "publik" ? (
                    <>
                      publik API isn't carrying audio transcription for this install
                      right now. Add your own OpenAI or Gemini key in Settings for
                      audio and YouTube-without-captions.
                    </>
                  ) : (
                    <>
                      {engine?.provider === "anthropic"
                        ? "Anthropic keys can't transcribe audio."
                        : "Local mode can't transcribe audio yet — there's no separate \"Whisper\" setting to connect."}{" "}
                      Add an OpenAI or Gemini key in Settings (or switch to publik API)
                      and NitroAI transcribes automatically.
                    </>
                  )}
                </span>
              </div>
            )}
            <Dropzone
              label="Drag an audio file here, or click to upload (MP3, WAV, M4A, etc.)"
              accept="audio/*,video/*"
              onFiles={addFiles}
              files={files}
              onRemove={(i) => setFiles(files.filter((_, j) => j !== i))}
              rejected={rejected}
            />
          </>
        )}

        <button
          onClick={submit}
          disabled={!ready || busy}
          className={`mt-6 w-full rounded-xl py-3.5 font-display font-bold transition ${
            ready && !busy
              ? "bg-accent text-white hover:bg-accent-hover"
              : "cursor-not-allowed bg-accent-softer text-ink-faint"
          }`}
        >
          {busy ? "Generating…" : "Generate Notes"}
        </button>
      </div>
    </div>
  );
}

function Dropzone({
  label,
  accept,
  files,
  onFiles,
  onRemove,
  rejected,
}: {
  label: string;
  accept: string;
  files: File[];
  /* Newly picked/dropped files (the caller filters and appends them). */
  onFiles: (f: File[]) => void;
  onRemove: (index: number) => void;
  rejected: string[];
}) {
  const [drag, setDrag] = useState(false);

  return (
    <>
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          onFiles(Array.from(e.dataTransfer.files));
        }}
        className={`flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center text-sm ${
          drag ? "border-accent bg-accent-softer" : "border-edge bg-panel text-ink-faint"
        }`}
      >
        <input
          type="file"
          multiple
          accept={accept}
          className="hidden"
          onChange={(e) => {
            onFiles(Array.from(e.target.files ?? []));
            e.target.value = ""; // picking the same file again still fires
          }}
        />
        <span className="flex items-center gap-2">
          <Upload className="size-4 shrink-0" />
          {label}
        </span>
      </label>
      {files.length > 0 && (
        <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto" aria-label="Selected files">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${f.size}-${i}`}
              className="flex items-center gap-2 rounded-lg border border-edge bg-panel px-3 py-1.5 text-sm"
            >
              <span className="min-w-0 flex-1 truncate font-semibold text-ink">{f.name}</span>
              <button
                type="button"
                onClick={() => onRemove(i)}
                aria-label={`Remove ${f.name}`}
                className="shrink-0 rounded p-0.5 text-ink-faint hover:bg-card-hover hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {rejected.length > 0 && (
        <div role="alert" className="mt-3 flex items-start gap-2 text-xs font-semibold text-danger-ink">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {rejected.map((r, i) => (
              <span key={i} className="block">
                Skipped {r}
              </span>
            ))}
          </span>
        </div>
      )}
    </>
  );
}
