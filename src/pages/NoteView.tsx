import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Layers,
  ListChecks,
  Loader2,
  Menu,
  MessageCircle,
  Mic,
  MoreVertical,
  Palette,
  X,
} from "lucide-react";
import { toggleTheme } from "../lib/theme";
import { useApp } from "../lib/app";
import DocEditor from "../components/editor/DocEditor";
import Assistant, { type Quote } from "../components/Assistant";
import FlashcardsView from "../components/FlashcardsView";
import QuizView from "../components/QuizView";
import PodcastPanel from "../components/PodcastPanel";
import {
  downloadText,
  exportDocxHtml,
  exportMarkdown,
  printPdf,
} from "../lib/export";
import { now } from "../lib/ids";
import { effectiveColor, pathTo } from "../lib/library";
import { FolderTab } from "../components/library/FolderBits";
import type { Block, EditorDoc, Folder, Note } from "../lib/types";

const railViews = [
  { view: "editor", icon: FileText, label: "Editor" },
  { view: "chat", icon: MessageCircle, label: "Chat" },
  { view: "podcast", icon: Mic, label: "Podcast" },
  { view: "flashcards", icon: Layers, label: "Flashcards" },
  { view: "quiz", icon: ListChecks, label: "Quiz" },
];

export default function NoteView() {
  const { id, view = "editor" } = useParams();
  const navigate = useNavigate();
  const { repo } = useApp();
  const [note, setNote] = useState<Note | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!repo || !id) return;
    let alive = true;
    repo.getNote(id).then((n) => {
      if (!alive) return;
      if (!n) {
        setMissing(true);
        return;
      }
      n.lastOpenedAt = now();
      repo.putNote(n);
      setNote(n);
    });
    return () => {
      alive = false;
    };
  }, [repo, id]);

  useEffect(() => {
    if (missing) navigate("/", { replace: true });
  }, [missing, navigate]);

  return (
    <div className="flex h-full bg-bg">
      <aside className="flex w-16 shrink-0 flex-col items-center border-r border-edge bg-panel py-4">
        <button
          onClick={() => navigate("/")}
          className="rounded-lg p-2 text-ink-dim hover:bg-card-hover hover:text-ink"
          aria-label="Back to dashboard"
        >
          <Menu className="size-5" />
        </button>
        <nav className="mt-6 flex flex-col gap-2">
          {railViews.map(({ view: v, icon: Icon, label }) => (
            <NavLink
              key={v}
              to={`/notes/${id}/${v}`}
              title={label}
              className={({ isActive }) =>
                `rounded-xl p-2.5 ${
                  isActive
                    ? "bg-card text-ink shadow-soft"
                    : "text-ink-dim hover:bg-card-hover hover:text-ink"
                }`
              }
            >
              <Icon className="size-5" />
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex flex-col items-center gap-3">
          <button
            onClick={() => toggleTheme()}
            className="rounded-xl p-2.5 text-ink-dim hover:bg-card-hover hover:text-ink"
            aria-label="Toggle theme"
          >
            <Palette className="size-5" />
          </button>
          <div className="flex size-8 items-center justify-center rounded-full bg-accent-soft font-display text-xs font-bold text-accent">
            N
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {!note ? (
          <div className="flex h-full items-center justify-center gap-2.5 text-ink-faint">
            <Loader2 className="size-5 animate-spin text-accent" />
            <span>Loading…</span>
          </div>
        ) : view === "editor" ? (
          <EditorView note={note} onNote={setNote} />
        ) : view === "chat" ? (
          <Assistant note={note} variant="hero" />
        ) : view === "podcast" ? (
          <PodcastPanel note={note} />
        ) : view === "flashcards" ? (
          <FlashcardsView note={note} />
        ) : view === "quiz" ? (
          <QuizView note={note} />
        ) : null}
      </main>
    </div>
  );
}

function EditorView({
  note,
  onNote,
}: {
  note: Note;
  onNote: (n: Note) => void;
}) {
  const { repo } = useApp();
  const navigate = useNavigate();
  const [panelOpen, setPanelOpen] = useState(true);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [title, setTitle] = useState(note.title);
  const [folders, setFolders] = useState<Folder[]>([]);
  useEffect(() => {
    repo?.listFolders().then(setFolders);
  }, [repo]);
  const path = pathTo(folders, note.folderId);
  // Saves can come from the editor's debounce after other fields changed, so
  // always merge into the latest note rather than the one from an old render.
  const latest = useRef(note);
  latest.current = note;

  function persist(patch: Partial<Note>) {
    const next = { ...latest.current, ...patch, updatedAt: now() };
    latest.current = next;
    onNote(next);
    repo?.putNote(next);
  }

  function onDoc(doc: EditorDoc, blocks: Block[]) {
    persist({ doc, blocks });
  }

  function askAI(text: string) {
    setPanelOpen(true);
    setQuote({ text, nonce: Date.now() });
  }

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="min-w-0 flex-1">
            {path.length > 0 && (
              <button
                onClick={() => navigate(`/?folder=${path[path.length - 1].id}`)}
                className="mb-0.5 flex max-w-full items-center gap-1.5 truncate text-xs font-semibold text-ink-faint hover:text-ink"
              >
                <FolderTab color={effectiveColor(folders, note.folderId)} className="h-2.5 w-1.5" />
                <span className="truncate">{path.map((f) => f.name).join(" / ")}</span>
              </button>
            )}
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                const next = title.trim() || "Untitled Document";
                if (next !== title) setTitle(next);
                // Only a real rename bumps updatedAt (and re-sorts the library).
                if (next !== latest.current.title) persist({ title: next });
              }}
              aria-label="Note title"
              className="w-full bg-transparent font-display text-xl font-bold outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <ExportMenu note={{ ...note, title }} />
            {!panelOpen && (
              <button
                onClick={() => setPanelOpen(true)}
                className="rounded-xl bg-accent-soft px-4 py-1.5 font-display text-sm font-bold text-ink hover:opacity-90"
              >
                Assistant
              </button>
            )}
          </div>
        </div>
        <div className="mx-6 mb-6 min-h-0 flex-1 overflow-hidden rounded-card border border-edge bg-card shadow-soft">
          <DocEditor key={note.id} note={note} onSave={onDoc} onAskAI={askAI} />
        </div>
      </div>

      {panelOpen ? (
        <div className="my-6 mr-6 flex w-[420px] shrink-0 flex-col rounded-card border border-edge bg-card shadow-soft">
          <div className="flex items-center justify-between p-3">
            <span className="pl-1 font-display text-sm font-bold text-ink-dim">Assistant</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPanelOpen(false)}
                className="rounded-xl bg-accent-soft p-2 text-ink hover:opacity-90"
                aria-label="Collapse assistant"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <Assistant note={note} variant="panel" quote={quote} onClearQuote={() => setQuote(null)} />
          </div>
        </div>
      ) : (
        <button
          onClick={() => setPanelOpen(true)}
          className="m-6 h-fit rounded-xl bg-accent-soft p-2 text-ink hover:opacity-90"
          aria-label="Open assistant"
        >
          <ChevronLeft className="size-4" />
        </button>
      )}
    </div>
  );
}

function ExportMenu({ note }: { note: Note }) {
  const [open, setOpen] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  /* The Word export is Word-compatible HTML saved as .doc (no .docx writer is
     bundled) — the label says so rather than promising a .docx. */
  const items: [string, () => void][] = [
    ["Export Markdown", () => downloadText(`${note.title}.md`, exportMarkdown(note), "text/markdown")],
    ["Export PDF", () => printPdf(note)],
    ["Export Word (.doc, HTML)", () => downloadText(`${note.title}.doc`, exportDocxHtml(note), "application/msword")],
  ];
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg p-2 text-ink-dim hover:bg-card-hover hover:text-ink"
        aria-label="More"
      >
        <MoreVertical className="size-4.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-56 rounded-xl border border-edge bg-card p-1 shadow-modal">
            {items.map(([label, fn]) => (
              <button
                key={label}
                onClick={() => {
                  setOpen(false);
                  try {
                    setExportErr(null);
                    fn();
                  } catch (e) {
                    setExportErr(e instanceof Error ? e.message : "Export failed. Please try again.");
                  }
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-card-hover"
              >
                <Download className="size-3.5 text-ink-dim" />
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      {exportErr && (
        <div
          role="alert"
          className="absolute right-0 z-20 mt-1 flex w-72 items-start gap-2 rounded-xl border border-danger-ink/30 bg-danger-soft px-3 py-2 text-xs font-semibold text-danger-ink shadow-modal"
        >
          <span className="min-w-0 flex-1">{exportErr}</span>
          <button
            type="button"
            onClick={() => setExportErr(null)}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5 hover:bg-danger-ink/10"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
