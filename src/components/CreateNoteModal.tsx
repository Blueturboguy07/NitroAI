import { useState } from "react";
import { FileAudio, FileText, Link2, Upload, X } from "lucide-react";
import type { IngestInput } from "../lib/ingest";
import { isYoutube } from "../lib/ingest/youtube";
import type { SourceKind } from "../lib/types";

export type NoteSource = "link" | "document" | "audio";

const meta: Record<NoteSource, { icon: typeof Link2; iconBg: string }> = {
  link: { icon: Link2, iconBg: "bg-red-500" },
  document: { icon: FileText, iconBg: "bg-accent" },
  audio: { icon: FileAudio, iconBg: "bg-accent" },
};

function kindForFile(name: string): SourceKind {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "pdf") return "pdf";
  if (ext === "docx" || ext === "doc") return "docx";
  return "text";
}

export default function CreateNoteModal({
  source,
  busy,
  onGenerate,
  onClose,
}: {
  source: NoteSource;
  busy?: boolean;
  onGenerate: (inputs: IngestInput[]) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const { icon: Icon, iconBg } = meta[source];
  const ready = source === "link" ? url.trim().length > 0 : files.length > 0;

  function submit() {
    if (!ready || busy) return;
    if (source === "link") {
      const u = url.trim();
      onGenerate([{ kind: isYoutube(u) ? "youtube" : "url", url: u }]);
    } else if (source === "document") {
      onGenerate(
        files.map((f) => ({ kind: kindForFile(f.name), file: f, filename: f.name })),
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
          <Dropzone
            label="Drag documents here, or click to upload"
            accept=".pdf,.doc,.docx,.txt,.md"
            onFiles={setFiles}
            files={files}
          />
        )}

        {source === "audio" && (
          <Dropzone
            label="Drag an audio file here, or click to upload (MP3, WAV, M4A, etc.)"
            accept="audio/*,video/*"
            onFiles={setFiles}
            files={files}
          />
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
}: {
  label: string;
  accept: string;
  files: File[];
  onFiles: (f: File[]) => void;
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
        onFiles([...files, ...Array.from(e.dataTransfer.files)]);
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
        onChange={(e) => onFiles([...files, ...Array.from(e.target.files ?? [])])}
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
