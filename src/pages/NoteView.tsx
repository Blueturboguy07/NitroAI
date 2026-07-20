import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  History,
  Layers,
  ListChecks,
  Loader2,
  Menu,
  MessageCircle,
  Mic,
  MoreVertical,
  Palette,
} from "lucide-react";
import { toggleTheme } from "../lib/theme";
import { useApp } from "../lib/app";
import BlockEditor from "../components/BlockEditor";
import Assistant from "../components/Assistant";
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
import type { Block, Note } from "../lib/types";

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
  const [panelOpen, setPanelOpen] = useState(true);
  const [title, setTitle] = useState(note.title);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function persist(patch: Partial<Note>) {
    const next = { ...note, ...patch, updatedAt: now() };
    onNote(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => repo?.putNote(next), 400);
  }

  function onBlocks(blocks: Block[]) {
    persist({ blocks });
  }

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-6 py-4">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => persist({ title: title.trim() || "Untitled Document" })}
            className="min-w-0 flex-1 bg-transparent font-display text-xl font-bold outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              className="rounded-lg p-2 text-ink-dim hover:bg-card-hover hover:text-ink"
              aria-label="Version history"
            >
              <History className="size-4.5" />
            </button>
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
        <div className="mx-6 mb-6 flex-1 overflow-y-auto rounded-card border border-edge bg-card p-8 shadow-soft">
          <BlockEditor key={note.id} blocks={note.blocks} onChange={onBlocks} />
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
            <Assistant note={note} variant="panel" />
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
  const items: [string, () => void][] = [
    ["Export Markdown", () => downloadText(`${note.title}.md`, exportMarkdown(note), "text/markdown")],
    ["Export PDF", () => printPdf(note)],
    ["Export Word", () => downloadText(`${note.title}.doc`, exportDocxHtml(note), "application/msword")],
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
          <div className="absolute right-0 z-20 mt-1 w-44 rounded-xl border border-edge bg-card p-1 shadow-modal">
            {items.map(([label, fn]) => (
              <button
                key={label}
                onClick={() => {
                  fn();
                  setOpen(false);
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
    </div>
  );
}
