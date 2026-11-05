import { useState } from "react";
import { AlertCircle, FileAudio, FileText, Info, Link2, Upload, X } from "lucide-react";
import type { IngestInput } from "../lib/ingest";
import { DOCUMENT_ACCEPT, documentFileProblem, documentKind } from "../lib/ingest/fileTypes";
import { isYoutube } from "../lib/ingest/youtube";
import type { Engine } from "../lib/engine/types";
import { supportsTask } from "../lib/engine/router";

export type NoteSource = "link" | "document" | "audio";

const meta: Record<NoteSource, { icon: typeof Link2; iconBg: string }> = {
  link: { icon: Link2, iconBg: "bg-red-500" },
  document: { icon: FileText, iconBg: "bg-accent" },
  audio: { icon: FileAudio, iconBg: "bg-accent" },
};


export default function CreateNoteModal({
  source,
  busy,
  engine,
  onGenerate,
  onClose,
}: {
  source: NoteSource;
  busy?: boolean;
  /* Used only to show an upfront "add a cloud key" hint for audio when the
     active engine can't transcribe (local mode has no speech-to-text yet) —
     surfacing that before the upload, not just as a failure afterward. */
  engine?: Engine | null;
  onGenerate: (inputs: IngestInput[]) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  /* Why a picked or dropped document was not added. Shown before anything is
     sent to a model; a drop skips the file dialog's type filter, so every
     added document is checked here. */
  const [refused, setRefused] = useState<string[]>([]);
  const { icon: Icon, iconBg } = meta[source];
  const ready = source === "link" ? url.trim().length > 0 : files.length > 0;
  const canTranscribe = !engine || supportsTask(engine, "transcription");

  async function addDocuments(added: File[]) {
    const checked = await Promise.all(
      added.map(async (file) => ({ file, problem: await documentFileProblem(file) })),
    );
    const ok = checked.filter((c) => !c.problem).map((c) => c.file);
    setRefused(checked.flatMap((c) => (c.problem ? [c.problem] : [])));
    if (ok.length) setFiles((prev) => [...prev, ...ok]);
  }

  function submit() {
    if (!ready || busy) return;
    if (source === "link") {
      const u = url.trim();
      onGenerate([{ kind: isYoutube(u) ? "youtube" : "url", url: u }]);
    } else if (source === "document") {
      onGenerate(
        files.flatMap((f) => {
          const kind = documentKind(f.name);
          return kind ? [{ kind, file: f, filename: f.name }] : [];
        }),
      );
    } else {
      onGenerate(files.map((f) => ({ kind: "audio", file: f, filename: f.name })));
    }
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
          <>
            <Dropzone
              label="Drag documents here, or click to upload (PDF, Word, .txt, .md)"
              accept={DOCUMENT_ACCEPT}
              onAdd={(added) => void addDocuments(added)}
              files={files}
            />
            {refused.length > 0 && (
              <div
                role="alert"
                className="mt-3 flex items-start gap-2 rounded-xl border border-danger-ink/30 bg-danger-soft px-3.5 py-3 text-xs font-semibold text-danger-ink"
              >
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <span className="flex flex-col gap-1">
                  {refused.map((m, i) => (
                    <span key={i}>{m}</span>
                  ))}
                </span>
              </div>
            )}
          </>
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
                      right now. Add your own OpenAI key in Settings for audio and
                      YouTube-without-captions.
                    </>
                  ) : (
                    <>
                      Local mode can't transcribe audio yet — there's no separate
                      "Whisper" setting to connect. Add an OpenAI key in Settings (or
                      switch to publik API) and NitroAI transcribes automatically.
                    </>
                  )}
                </span>
              </div>
            )}
            <Dropzone
              label="Drag an audio file here, or click to upload (MP3, WAV, M4A, etc.)"
              accept="audio/*,video/*"
              onAdd={(added) => setFiles((prev) => [...prev, ...added])}
              files={files}
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
  onAdd,
}: {
  label: string;
  accept: string;
  files: File[];
  onAdd: (added: File[]) => void;
}) {
  const [drag, setDrag] = useState(false);

  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        onAdd(Array.from(e.dataTransfer.files));
      }}
      className={`flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-sm ${
        drag ? "border-accent bg-accent-softer" : "border-edge bg-panel text-ink-faint"
      }`}
    >
      <input
        type="file"
        multiple
        accept={accept}
        className="hidden"
        onChange={(e) => {
          onAdd(Array.from(e.target.files ?? []));
          // The same file can be picked again after it was refused.
          e.target.value = "";
        }}
      />
      <span className="flex items-center gap-2">
        <Upload className="size-4" />
        {label}
      </span>
      {files.length > 0 && (
        <span className="font-semibold text-ink">
          {files.length} file{files.length > 1 ? "s" : ""} selected
        </span>
      )}
    </label>
  );
}
