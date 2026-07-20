import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronRight,
  FileAudio,
  FilePlus2,
  FileText,
  FolderPlus,
  Link2,
  Loader2,
  MoreVertical,
  Play,
  Search,
  Trash2,
} from "lucide-react";
import CreateNoteModal, { type NoteSource } from "../components/CreateNoteModal";
import { useApp } from "../lib/app";
import type { IngestInput } from "../lib/ingest";
import { createNoteFromSources } from "../lib/generation/pipeline";
import { exportMarkdown, downloadText } from "../lib/export";
import { uuid, now } from "../lib/ids";
import type { Job, Note, SourceKind } from "../lib/types";

const creationCards: {
  source: NoteSource | "blank";
  title: string;
  subtitle: string;
  icon: typeof FilePlus2;
}[] = [
  { source: "blank", title: "Blank document", subtitle: "Start from scratch", icon: FilePlus2 },
  { source: "audio", title: "Upload audio", subtitle: "Transcribe an audio file", icon: FileAudio },
  { source: "document", title: "Document upload", subtitle: "Any PDF, DOC, PPT, etc", icon: FileText },
  { source: "link", title: "Website link", subtitle: "YouTube or website link", icon: Link2 },
];

function sourceIcon(kind: SourceKind) {
  if (kind === "youtube") return { Icon: Play, color: "text-red-500 bg-red-500/10" };
  if (kind === "audio") return { Icon: FileAudio, color: "text-accent bg-accent-softer" };
  if (kind === "pdf" || kind === "docx") return { Icon: FileText, color: "text-accent bg-accent-softer" };
  if (kind === "url") return { Icon: Link2, color: "text-accent bg-accent-softer" };
  return { Icon: FileText, color: "text-accent bg-accent-softer" };
}

function relTime(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m > 1 ? "s" : ""} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h > 1 ? "s" : ""} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d > 1 ? "s" : ""} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo > 1 ? "s" : ""} ago`;
  return `${Math.floor(mo / 12)} year${mo >= 24 ? "s" : ""} ago`;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { repo, engine, prefs, version, bump } = useApp();
  const [tab, setTab] = useState<"mine" | "shared">("mine");
  const [modal, setModal] = useState<NoteSource | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [query, setQuery] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    repo?.listNotes().then(setNotes);
  }, [repo, version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function createBlank() {
    if (!repo) return;
    const note: Note = {
      id: uuid(),
      title: "Untitled Document",
      sourceKind: "blank",
      sourceText: "",
      blocks: [],
      createdAt: now(),
      updatedAt: now(),
      lastOpenedAt: now(),
    };
    await repo.putNote(note);
    bump();
    navigate(`/notes/${note.id}/editor`);
  }

  async function handleGenerate(inputs: IngestInput[]) {
    if (!repo) return;
    if (!engine) {
      setModal(null);
      setErr("Set up your engine in Settings first (pick Local or add a key).");
      return;
    }
    setErr(null);
    try {
      const id = await createNoteFromSources({
        repo,
        engine,
        inputs,
        language: prefs.language,
        onProgress: setJob,
      });
      setModal(null);
      setJob(null);
      bump();
      navigate(`/notes/${id}/editor`);
    } catch (e) {
      setJob(null);
      setModal(null);
      setErr(e instanceof Error ? e.message : "Generation failed.");
    }
  }

  const filtered = notes.filter((n) =>
    n.title.toLowerCase().includes(query.toLowerCase()),
  );
  const today = filtered.filter((n) => Date.now() - n.lastOpenedAt < 86400000);
  const earlier = filtered.filter((n) => Date.now() - n.lastOpenedAt >= 86400000);

  return (
    <div className="px-10 py-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-4xl font-bold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-lg text-ink-faint">Create new notes</p>
        </div>
        <label className="flex w-72 items-center gap-2 rounded-xl border border-edge bg-card px-3 py-2 text-ink-faint shadow-soft">
          <Search className="size-4" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search (⌘K)"
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
          />
        </label>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 xl:grid-cols-4">
        {creationCards.map(({ source, title, subtitle, icon: Icon }) => (
          <button
            key={title}
            onClick={() => (source === "blank" ? createBlank() : setModal(source))}
            className="group flex items-center gap-4 rounded-card border border-edge bg-card p-4 text-left shadow-soft transition hover:bg-card-hover"
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-softer">
              <Icon className="size-5 text-accent" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-display font-bold">{title}</span>
              <span className="block truncate text-sm text-ink-faint">{subtitle}</span>
            </span>
            <ChevronRight className="size-5 shrink-0 text-ink-faint transition group-hover:translate-x-0.5" />
          </button>
        ))}
      </div>

      {err && (
        <div className="mt-4 rounded-xl border border-danger-ink/30 bg-danger-soft px-4 py-3 text-sm font-semibold text-danger-ink">
          {err}
        </div>
      )}

      <div className="mt-8 flex items-center justify-between">
        <div className="flex rounded-full border border-edge bg-panel p-1">
          {(
            [
              ["mine", "My Notes"],
              ["shared", "Shared with Me"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold ${
                tab === key ? "bg-card text-ink shadow-soft" : "text-ink-faint hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <button className="flex items-center gap-2 rounded-xl border border-edge bg-card px-4 py-2 text-sm font-semibold shadow-soft hover:bg-card-hover">
          <FolderPlus className="size-4" />
          New Folder
        </button>
      </div>

      {tab === "shared" ? (
        <Empty
          title="Nothing shared with you yet"
          sub="Notes classmates share with you will appear here."
        />
      ) : filtered.length === 0 ? (
        <Empty
          title={query ? "No matching notes" : "No notes yet"}
          sub={
            query
              ? "Try a different search."
              : "Create your first note from a recording, document, or link above."
          }
        />
      ) : (
        <div className="mt-6 space-y-6">
          {today.length > 0 && (
            <Group label="Today" notes={today} repo={repo} bump={bump} navigate={navigate} />
          )}
          {earlier.length > 0 && (
            <Group label="Earlier" notes={earlier} repo={repo} bump={bump} navigate={navigate} />
          )}
        </div>
      )}

      {modal && (
        <CreateNoteModal
          source={modal}
          busy={!!job}
          onGenerate={handleGenerate}
          onClose={() => setModal(null)}
        />
      )}
      {job && <JobOverlay job={job} />}
    </div>
  );
}

function Group({
  label,
  notes,
  repo,
  bump,
  navigate,
}: {
  label: string;
  notes: Note[];
  repo: ReturnType<typeof useApp>["repo"];
  bump: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-semibold text-ink-faint">{label}</p>
      <div className="space-y-3">
        {notes.map((n) => {
          const { Icon, color } = sourceIcon(n.sourceKind);
          return (
            <div
              key={n.id}
              onClick={() => navigate(`/notes/${n.id}/editor`)}
              className="group flex cursor-pointer items-center gap-4 rounded-card border border-edge bg-card p-4 shadow-soft transition hover:bg-card-hover"
            >
              <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${color}`}>
                <Icon className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-display font-bold">{n.title}</p>
                <p className="text-sm text-ink-faint">Last opened {relTime(n.lastOpenedAt)}</p>
              </div>
              <RowMenu
                onExport={() =>
                  downloadText(`${n.title}.md`, exportMarkdown(n), "text/markdown")
                }
                onDelete={async () => {
                  await repo?.deleteNote(n.id);
                  bump();
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RowMenu({ onExport, onDelete }: { onExport: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg p-2 text-ink-faint opacity-0 transition hover:bg-card-hover hover:text-ink group-hover:opacity-100"
        aria-label="More"
      >
        <MoreVertical className="size-4.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-40 rounded-xl border border-edge bg-card p-1 shadow-modal">
            <button
              onClick={() => {
                onExport();
                setOpen(false);
              }}
              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-card-hover"
            >
              Export Markdown
            </button>
            <button
              onClick={() => {
                onDelete();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-danger-ink hover:bg-danger-soft"
            >
              <Trash2 className="size-3.5" /> Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Empty({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mt-10 flex flex-col items-center gap-1 py-16 text-center">
      <p className="font-display text-lg font-semibold text-ink-dim">{title}</p>
      <p className="text-sm text-ink-faint">{sub}</p>
    </div>
  );
}

function JobOverlay({ job }: { job: Job }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[440px] max-w-[90vw] rounded-modal bg-card p-8 shadow-modal">
        {/* A spinner only, deliberately: long steps (YouTube pulls, big PDFs)
            can't report granular progress, and a stalled bar reads as frozen. */}
        <div className="flex items-center gap-3">
          <Loader2 className="size-6 animate-spin text-accent" />
          <h2 className="font-display text-xl font-bold">{job.message}</h2>
        </div>
        {job.files && job.files.length > 1 && (
          <ul className="mt-4 space-y-1.5">
            {job.files.map((f, i) => (
              <li key={i} className="flex items-center justify-between text-sm">
                <span className="truncate text-ink-dim">{f.name}</span>
                <span
                  className={
                    f.status === "done"
                      ? "text-green-600"
                      : f.status === "error"
                        ? "text-danger-ink"
                        : "text-ink-faint"
                  }
                >
                  {f.status === "done"
                    ? "✓"
                    : f.status === "error"
                      ? f.error || "failed"
                      : f.status === "running"
                        ? "…"
                        : "queued"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
