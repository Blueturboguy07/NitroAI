import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowDownUp,
  Check,
  ChevronRight,
  Download,
  FileAudio,
  FilePlus2,
  FileText,
  FolderInput,
  FolderPlus,
  Link2,
  Loader2,
  MoreHorizontal,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Play,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
  Trash2,
  X,
} from "lucide-react";
import CreateNoteModal, { type NoteSource } from "../components/CreateNoteModal";
import { useApp } from "../lib/app";
import type { IngestInput } from "../lib/ingest";
import { createNoteFromSources, SourcesUnreadableError, partialFailureMessage } from "../lib/generation/pipeline";
import { describeError, type ShownError } from "../lib/publik";
import { ErrorNotice } from "../components/PublikNotice";
import { exportMarkdown, downloadText } from "../lib/export";
import { plainText } from "../lib/markdown";
import { uuid, now } from "../lib/ids";
import {
  SORTS,
  activeDrag,
  beginDrag,
  bucketOf,
  canNest,
  childrenOf,
  colorHex,
  effectiveColor,
  endDrag,
  loadLibraryPrefs,
  pathTo,
  saveLibraryPrefs,
  sortNotes,
  sourceFileNames,
  sourceFilesLabel,
  tint,
  type SortKey,
} from "../lib/library";
import { useLibrary, type Library } from "../components/library/useLibrary";
import { FolderMenu, FolderTab, NewFolderModal, RenameField } from "../components/library/FolderBits";
import MovePicker from "../components/library/MovePicker";
import Popover, { MenuDivider, MenuItem, anchorOf, type Anchor } from "../components/ui/Popover";
import type { Folder, Job, Note, SourceKind } from "../lib/types";

const creationCards: {
  source: NoteSource | "blank";
  title: string;
  subtitle: string;
  icon: typeof FilePlus2;
}[] = [
  { source: "blank", title: "Blank document", subtitle: "Start from scratch", icon: FilePlus2 },
  { source: "audio", title: "Upload audio", subtitle: "Transcribe an audio file", icon: FileAudio },
  { source: "document", title: "Document upload", subtitle: "PDF, DOCX, TXT, or Markdown", icon: FileText },
  { source: "link", title: "Website link", subtitle: "YouTube or website link", icon: Link2 },
];

function sourceIcon(kind: SourceKind) {
  if (kind === "youtube") return { Icon: Play, color: "text-red-500 bg-red-500/10" };
  if (kind === "audio") return { Icon: FileAudio, color: "text-accent bg-accent-softer" };
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

const DATE_FIELD: Record<Exclude<SortKey, "name">, { field: keyof Note; verb: string }> = {
  opened: { field: "lastOpenedAt", verb: "Last opened" },
  edited: { field: "updatedAt", verb: "Edited" },
  created: { field: "createdAt", verb: "Created" },
};

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export default function Dashboard() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { repo, engine, prefs, bump } = useApp();
  const lib = useLibrary();
  const folderParam = params.get("folder");
  const folder = folderParam ? lib.folders.find((f) => f.id === folderParam) : undefined;
  const folderId = folder?.id;

  const [tab, setTab] = useState<"mine" | "shared">("mine");
  const [modal, setModal] = useState<NoteSource | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [query, setQuery] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<ShownError | null>(null);
  /* What the error banner can offer: the inputs to retry with, whether
     changing the engine in Settings would fix it, or (when some files of a
     multi-upload failed) the note that was made from the rest. */
  const [errFix, setErrFix] = useState<{ retry?: IngestInput[]; settings?: boolean; openNote?: string }>({});
  const abortRef = useRef<AbortController | null>(null);
  /* Files from a run that failed, so reopening the same upload card still
     has them picked. */
  const [lastPicks, setLastPicks] = useState<{ source: NoteSource; files: File[] } | null>(null);
  const [sort, setSort] = useState<SortKey>(() => loadLibraryPrefs().sort);
  const [sortMenu, setSortMenu] = useState<Anchor | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClicked = useRef<string | null>(null);
  const [noteMenu, setNoteMenu] = useState<{ note: Note; anchor: Anchor } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ folder: Folder; anchor: Anchor } | null>(null);
  const [mover, setMover] = useState<{ ids: string[]; anchor: Anchor } | null>(null);
  const [renamingNote, setRenamingNote] = useState<string | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [newInside, setNewInside] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // A folder link that no longer exists (deleted elsewhere) falls back to All notes.
  useEffect(() => {
    if (lib.loaded && folderParam && !folder) navigate("/", { replace: true });
  }, [lib.loaded, folderParam, folder, navigate]);

  // Changing folder or search starts a fresh selection.
  useEffect(() => setSelected(new Set()), [folderId, query]);

  // An error belongs to the folder it happened in; don't carry it along.
  useEffect(() => {
    setErr(null);
    setErrFix({});
  }, [folderId]);

  /* ---- what's on screen ---- */

  const q = query.trim().toLowerCase();
  const searchText = useMemo(() => {
    if (!q) return null;
    return new Map(lib.notes.map((n) => [n.id, `${n.title}\n${plainText(n.blocks)}`.toLowerCase()]));
  }, [lib.notes, q]);

  const visible = useMemo(() => {
    const base = searchText
      ? lib.notes.filter((n) => searchText.get(n.id)?.includes(q))
      : folderId
        ? lib.notes.filter((n) => n.folderId === folderId)
        : lib.notes;
    return sortNotes(base, sort);
  }, [lib.notes, searchText, q, folderId, sort]);

  const shelf = useMemo(
    () =>
      q
        ? lib.folders.filter((f) => f.name.toLowerCase().includes(q)).slice(0, 12)
        : childrenOf(lib.folders, folderId),
    [lib.folders, q, folderId],
  );

  const sections = useMemo(() => {
    const pinned = visible.filter((n) => n.pinned);
    const rest = visible.filter((n) => !n.pinned);
    const out: { label: string; notes: Note[] }[] = [];
    if (pinned.length) out.push({ label: "Pinned", notes: pinned });
    if (sort === "name") {
      if (rest.length) out.push({ label: pinned.length ? "Notes" : "", notes: rest });
    } else {
      const { field } = DATE_FIELD[sort];
      for (const label of ["Today", "This week", "Earlier"] as const) {
        const group = rest.filter((n) => bucketOf(n[field] as number) === label);
        if (group.length) out.push({ label, notes: group });
      }
    }
    return out;
  }, [visible, sort]);
  const ordered = useMemo(() => sections.flatMap((s) => s.notes), [sections]);

  /* ---- keyboard ---- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (isTyping(e.target) || document.querySelector('[role="dialog"], [role="menu"]')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && ordered.length) {
        e.preventDefault();
        setSelected(new Set(ordered.map((n) => n.id)));
      } else if (e.key === "Escape") {
        setSelected(new Set());
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected.size) {
        e.preventDefault();
        lib.deleteNotes([...selected]);
        setSelected(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ordered, selected, lib]);

  /* ---- creating notes (into the open folder) ---- */

  async function createBlank() {
    if (!repo) return;
    const note: Note = {
      id: uuid(),
      title: "Untitled Document",
      sourceKind: "blank",
      sourceText: "",
      blocks: [],
      folderId,
      createdAt: now(),
      updatedAt: now(),
      lastOpenedAt: now(),
    };
    await repo.putNote(note);
    bump();
    navigate(`/notes/${note.id}/editor`);
  }

  /* Remember the files of a run that didn't go through (see lastPicks). */
  function rememberPicks(inputs: IngestInput[]) {
    const picked = inputs.map((i) => i.file).filter((f): f is File => typeof File !== "undefined" && f instanceof File);
    if (modal && modal !== "link" && picked.length) setLastPicks({ source: modal, files: picked });
  }

  async function handleGenerate(inputs: IngestInput[]) {
    if (!repo) return;
    if (!engine) {
      rememberPicks(inputs);
      setModal(null);
      setErr({ message: "Set up your engine in Settings first (pick publik API, Local, or add a key).", action: null });
      setErrFix({ settings: true });
      return;
    }
    setErr(null);
    setErrFix({});
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let last: Job | null = null;
    try {
      const id = await createNoteFromSources({
        repo,
        engine,
        inputs,
        language: prefs.language,
        signal: ctrl.signal,
        onProgress: (j) => {
          last = j;
          setJob({ ...j, files: j.files?.map((f) => ({ ...f })) });
        },
      });
      if (folderId) {
        const n = await repo.getNote(id);
        if (n) await repo.putNote({ ...n, folderId });
      }
      setModal(null);
      setJob(null);
      setLastPicks(null);
      bump();
      // Some files failed but the note was made from the rest: stay here and
      // say which, instead of silently leaving them out.
      const files = (last as Job | null)?.files ?? [];
      const warning = partialFailureMessage(files);
      if (warning) {
        setErr({ message: warning, action: null });
        // "Try again" re-runs just the files that failed (as a new note).
        setErrFix({ openNote: id, retry: inputs.filter((_, i) => files[i]?.status === "error") });
        return;
      }
      navigate(`/notes/${id}/editor`);
    } catch (e) {
      setJob(null);
      rememberPicks(inputs);
      setModal(null);
      if (ctrl.signal.aborted) return; // the user cancelled — nothing to report
      const shown = describeError(e, "Generation failed.");
      const failures = e instanceof SourcesUnreadableError ? e.failures : [];
      setErr(
        failures.length > 1
          ? { ...shown, details: failures.map((f) => (f.name ? `${f.name} — ${f.error}` : f.error)) }
          : shown,
      );
      setErrFix({ retry: inputs, settings: e instanceof SourcesUnreadableError && e.fix === "settings" });
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  }

  /* ---- selection ---- */

  function clickNote(note: Note, e: MouseEvent) {
    const range = e.shiftKey && lastClicked.current;
    if (e.metaKey || e.ctrlKey || range || selected.size) {
      e.preventDefault();
      const next = new Set(selected);
      if (range) {
        const a = ordered.findIndex((n) => n.id === lastClicked.current);
        const b = ordered.findIndex((n) => n.id === note.id);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        ordered.slice(lo, hi + 1).forEach((n) => next.add(n.id));
      } else if (next.has(note.id)) next.delete(note.id);
      else next.add(note.id);
      lastClicked.current = note.id;
      setSelected(next);
      return;
    }
    navigate(`/notes/${note.id}/editor`);
  }

  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    lastClicked.current = id;
    setSelected(next);
  }

  const selectedIds = [...selected];
  const allPinned = selectedIds.length > 0 && selectedIds.every((id) => lib.notes.find((n) => n.id === id)?.pinned);

  /* ---- rendering ---- */

  const crumbs = pathTo(lib.folders, folderId);
  const counts = folderId ? lib.counts.get(folderId) : undefined;
  const folderColor = effectiveColor(lib.folders, folderId);

  return (
    <div className="px-10 py-8">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          {folder ? (
            <>
              <nav aria-label="Folder path" className="mb-1 flex flex-wrap items-center gap-1 text-sm text-ink-faint">
                <Crumb lib={lib} label="All notes" onClick={() => navigate("/")} />
                {crumbs.slice(0, -1).map((c) => (
                  <Fragment key={c.id}>
                    <ChevronRight className="size-3.5" />
                    <Crumb lib={lib} folder={c} label={c.name} onClick={() => navigate(`/?folder=${c.id}`)} />
                  </Fragment>
                ))}
              </nav>
              <div className="flex items-center gap-3">
                <FolderTab color={folderColor} className="h-8 w-3.5 rounded-[4px]" />
                {renamingFolder === folder.id ? (
                  <RenameField
                    initial={folder.name}
                    className="!text-3xl font-bold"
                    onDone={(name) => {
                      setRenamingFolder(null);
                      if (name && name !== folder.name) void lib.updateFolder(folder.id, { name });
                    }}
                  />
                ) : (
                  <h1 className="truncate text-4xl font-bold tracking-tight" onDoubleClick={() => setRenamingFolder(folder.id)}>
                    {folder.name}
                  </h1>
                )}
                <button
                  onClick={(e) => {
                    const a = anchorOf(e.currentTarget);
                    if (a) setFolderMenu({ folder, anchor: a });
                  }}
                  aria-label={`${folder.name} options`}
                  className="rounded-lg p-1.5 text-ink-faint hover:bg-card-hover hover:text-ink"
                >
                  <MoreHorizontal className="size-5" />
                </button>
              </div>
              <p className="mt-1 text-lg text-ink-faint">
                {counts && (counts.notes || counts.folders)
                  ? `${[
                      counts.notes ? `${counts.notes} note${counts.notes === 1 ? "" : "s"}` : "",
                      counts.folders ? `${counts.folders} folder${counts.folders === 1 ? "" : "s"}` : "",
                    ]
                      .filter(Boolean)
                      .join(" and ")}. New notes you create here are saved in this folder.`
                  : "New notes you create here are saved in this folder."}
              </p>
            </>
          ) : (
            <>
              <h1 className="text-4xl font-bold tracking-tight">Dashboard</h1>
              <p className="mt-1 text-lg text-ink-faint">Create new notes</p>
            </>
          )}
        </div>
        <label className="flex w-72 shrink-0 items-center gap-2 rounded-xl border border-edge bg-card px-3 py-2 text-ink-faint shadow-soft focus-within:border-accent">
          <Search className="size-4" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Search all notes (⌘K)"
            className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label="Clear search" className="rounded p-0.5 hover:text-ink">
              <X className="size-3.5" />
            </button>
          )}
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
        <div className="mt-4">
          <ErrorNotice
            err={err}
            onDismiss={() => {
              setErr(null);
              setErrFix({});
            }}
          >
            {errFix.settings && (
              <button
                type="button"
                onClick={() => navigate("/settings")}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-white hover:bg-accent-hover"
              >
                <SettingsIcon className="size-3" />
                Open Settings
              </button>
            )}
            {errFix.openNote && (
              <button
                type="button"
                onClick={() => navigate(`/notes/${errFix.openNote}/editor`)}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-white hover:bg-accent-hover"
              >
                <FileText className="size-3" />
                Open note
              </button>
            )}
            {errFix.retry && errFix.retry.length > 0 && (
              <button
                type="button"
                onClick={() => handleGenerate(errFix.retry!)}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-danger-ink/30 bg-card px-3 py-1.5 text-xs font-bold text-danger-ink hover:bg-card-hover"
              >
                <RotateCcw className="size-3" />
                Try again
              </button>
            )}
          </ErrorNotice>
        </div>
      )}

      {/* Toolbar; becomes the bulk-action bar while notes are selected. */}
      <div className="sticky top-0 z-20 -mx-10 mt-8 bg-bg/95 px-10 py-2 backdrop-blur">
        {selected.size > 0 ? (
          <div className="flex items-center gap-2 rounded-xl border border-accent/40 bg-accent-softer px-2 py-1.5" role="toolbar" aria-label="Selected notes">
            <button
              onClick={() => setSelected(new Set())}
              aria-label="Clear selection"
              className="rounded-lg p-1.5 text-ink-dim hover:bg-card hover:text-ink"
            >
              <X className="size-4" />
            </button>
            <span className="font-display text-sm font-bold">
              {selected.size} selected
            </span>
            <span className="hidden text-xs text-ink-faint md:inline">Drag them onto a folder, or</span>
            <div className="ml-auto flex items-center gap-1">
              <BarButton
                icon={FolderInput}
                onClick={(e) => {
                  const a = anchorOf(e.currentTarget);
                  if (a) setMover({ ids: selectedIds, anchor: a });
                }}
              >
                Move to…
              </BarButton>
              <BarButton
                icon={allPinned ? PinOff : Pin}
                onClick={() => {
                  void lib.setPinned(selectedIds, !allPinned);
                  setSelected(new Set());
                }}
              >
                {allPinned ? "Unpin" : "Pin"}
              </BarButton>
              <BarButton
                icon={Trash2}
                danger
                onClick={() => {
                  lib.deleteNotes(selectedIds);
                  setSelected(new Set());
                }}
              >
                Delete
              </BarButton>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
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
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => setSortMenu(anchorOf(e.currentTarget))}
                aria-haspopup="menu"
                className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold text-ink-dim hover:bg-card-hover hover:text-ink"
              >
                <ArrowDownUp className="size-4" />
                {SORTS.find((s) => s.key === sort)?.label}
              </button>
              <button
                onClick={() => setNewFolder(true)}
                className="flex items-center gap-2 rounded-xl border border-edge bg-card px-4 py-2 text-sm font-semibold shadow-soft hover:bg-card-hover"
              >
                <FolderPlus className="size-4" />
                New folder
              </button>
            </div>
          </div>
        )}
      </div>

      {tab === "shared" ? (
        <Empty title="Nothing shared with you yet" sub="Notes classmates share with you will appear here." />
      ) : (
        <>
          {shelf.length > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5" role="list" aria-label="Folders">
              {shelf.map((f) => (
                <FolderTile
                  key={f.id}
                  lib={lib}
                  folder={f}
                  showPath={!!q}
                  renaming={renamingFolder === f.id}
                  onRenamed={(name) => {
                    setRenamingFolder(null);
                    if (name && name !== f.name) void lib.updateFolder(f.id, { name });
                  }}
                  onOpen={() => navigate(`/?folder=${f.id}`)}
                  onMenu={(anchor) => setFolderMenu({ folder: f, anchor })}
                />
              ))}
            </div>
          )}

          {visible.length === 0 ? (
            q ? (
              <Empty
                title={`No notes match “${query.trim()}”`}
                sub="Search looks through titles and note text in every folder."
              />
            ) : folder ? (
              shelf.length === 0 && (
                <Empty
                  title={`Nothing in ${folder.name} yet`}
                  sub="Drag notes onto this folder in the sidebar, or create one above. It will be saved here."
                />
              )
            ) : (
              <Empty
                title="No notes yet"
                sub="Create your first note from a recording, document, or link above."
              />
            )
          ) : (
            <div className="mt-6 space-y-6">
              {sections.map((s) => (
                <section key={s.label || "notes"} aria-label={s.label || "Notes"}>
                  {s.label && <h2 className="mb-2 text-sm font-semibold text-ink-faint">{s.label}</h2>}
                  <div className="space-y-3">
                    {s.notes.map((n) => (
                      <NoteRow
                        key={n.id}
                        note={n}
                        lib={lib}
                        sort={sort}
                        showPath={!!n.folderId && (!!q || n.folderId !== folderId)}
                        selected={selected.has(n.id)}
                        selecting={selected.size > 0}
                        renaming={renamingNote === n.id}
                        onClick={(e) => clickNote(n, e)}
                        onToggle={() => toggleOne(n.id)}
                        onMenu={(anchor) => setNoteMenu({ note: n, anchor })}
                        onRenamed={(title) => {
                          setRenamingNote(null);
                          if (title) void lib.renameNote(n.id, title);
                        }}
                        dragIds={() => (selected.has(n.id) ? selectedIds : [n.id])}
                        onOpenFolder={(id) => navigate(`/?folder=${id}`)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      {sortMenu && (
        <Popover anchor={sortMenu} onClose={() => setSortMenu(null)} align="end" className="w-48 p-1" role="menu">
          {SORTS.map((s) => (
            <MenuItem
              key={s.key}
              active={s.key === sort}
              onSelect={() => {
                setSort(s.key);
                saveLibraryPrefs({ sort: s.key });
                setSortMenu(null);
              }}
            >
              {s.label}
            </MenuItem>
          ))}
        </Popover>
      )}

      {noteMenu && (
        <Popover anchor={noteMenu.anchor} onClose={() => setNoteMenu(null)} align="end" className="w-52 p-1" role="menu">
          <MenuItem icon={Pencil} onSelect={() => { setRenamingNote(noteMenu.note.id); setNoteMenu(null); }}>
            Rename
          </MenuItem>
          <MenuItem
            icon={noteMenu.note.pinned ? PinOff : Pin}
            onSelect={() => {
              void lib.setPinned([noteMenu.note.id], !noteMenu.note.pinned);
              setNoteMenu(null);
            }}
          >
            {noteMenu.note.pinned ? "Unpin" : "Pin to top"}
          </MenuItem>
          <MenuItem
            icon={FolderInput}
            onSelect={() => {
              setMover({ ids: [noteMenu.note.id], anchor: noteMenu.anchor });
              setNoteMenu(null);
            }}
          >
            Move to…
          </MenuItem>
          <MenuItem
            icon={Download}
            onSelect={() => {
              downloadText(`${noteMenu.note.title}.md`, exportMarkdown(noteMenu.note), "text/markdown");
              setNoteMenu(null);
            }}
          >
            Export Markdown
          </MenuItem>
          <MenuDivider />
          <MenuItem
            icon={Trash2}
            danger
            onSelect={() => {
              lib.deleteNotes([noteMenu.note.id]);
              setNoteMenu(null);
            }}
          >
            Delete
          </MenuItem>
        </Popover>
      )}

      {folderMenu && (
        <FolderMenu
          lib={lib}
          folder={folderMenu.folder}
          anchor={folderMenu.anchor}
          onClose={() => setFolderMenu(null)}
          onOpen={() => navigate(`/?folder=${folderMenu.folder.id}`)}
          onRename={() => setRenamingFolder(folderMenu.folder.id)}
          onNewInside={() => setNewInside(folderMenu.folder.id)}
        />
      )}

      {mover && (
        <MovePicker
          lib={lib}
          ids={mover.ids}
          anchor={mover.anchor}
          onClose={() => {
            setMover(null);
            setSelected(new Set());
          }}
        />
      )}

      {modal && (
        <CreateNoteModal
          source={modal}
          busy={!!job}
          engine={engine}
          initialFiles={lastPicks?.source === modal ? lastPicks.files : undefined}
          onGenerate={handleGenerate}
          onClose={() => setModal(null)}
        />
      )}
      {job && <JobOverlay job={job} onCancel={() => abortRef.current?.abort()} />}
      {(newFolder || newInside) && (
        <NewFolderModal
          lib={lib}
          parentId={newInside ?? folderId}
          onClose={() => {
            setNewFolder(false);
            setNewInside(null);
          }}
        />
      )}
    </div>
  );
}

/* ---- drop-target helper ---------------------------------------------------- */

/* Dropping notes files them into `target` (undefined = no folder); dropping a
   folder nests it inside. Returns handlers plus the "is over" flag. */
function useDropTarget(lib: Library, target: Folder | undefined) {
  const [over, setOver] = useState(false);
  const accepts = () => {
    const p = activeDrag();
    if (!p) return false;
    if (p.kind === "notes") return true;
    return p.id !== target?.id && canNest(lib.folders, p.id, target?.id);
  };
  return {
    over,
    handlers: {
      onDragOver: (e: DragEvent) => {
        if (!accepts()) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        const p = activeDrag();
        endDrag();
        if (!p) return;
        if (p.kind === "notes") void lib.moveNotes(p.ids, target?.id);
        else void lib.moveFolder(p.id, target?.id, "inside");
      },
    },
  };
}

function Crumb({ lib, folder, label, onClick }: { lib: Library; folder?: Folder; label: string; onClick: () => void }) {
  const { over, handlers } = useDropTarget(lib, folder);
  return (
    <button
      {...handlers}
      onClick={onClick}
      className={`rounded-md px-1.5 py-0.5 hover:bg-card-hover hover:text-ink ${over ? "bg-accent-softer text-ink ring-2 ring-accent" : ""}`}
    >
      {label}
    </button>
  );
}

/* ---- folder tile -------------------------------------------------------------- */

/* A folder on the shelf, drawn as a file folder: an index tab in the course
   colour above a card whose top edge carries the same colour. */
function FolderTile({
  lib,
  folder,
  showPath,
  renaming,
  onRenamed,
  onOpen,
  onMenu,
}: {
  lib: Library;
  folder: Folder;
  showPath: boolean;
  renaming: boolean;
  onRenamed: (name: string | null) => void;
  onOpen: () => void;
  onMenu: (a: Anchor) => void;
}) {
  const { over, handlers } = useDropTarget(lib, folder);
  const color = effectiveColor(lib.folders, folder.id);
  const hex = colorHex(color);
  const c = lib.counts.get(folder.id);
  const parts = [
    c?.total ? `${c.total} note${c.total === 1 ? "" : "s"}` : "",
    c?.folders ? `${c.folders} folder${c.folders === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  const parentPath = showPath ? pathTo(lib.folders, folder.parentId).map((f) => f.name).join(" / ") : "";
  const metaId = `folder-meta-${folder.id}`;

  return (
    <div
      role="listitem"
      className="relative pt-2.5"
      {...handlers}
    >
      <span
        aria-hidden
        className="absolute top-0 left-0 h-3 w-16 rounded-t-[7px] transition-transform duration-150"
        style={{ background: hex, transform: over ? "translateY(-3px)" : undefined }}
      />
      <div
        role="button"
        tabIndex={0}
        aria-label={folder.name}
        aria-describedby={metaId}
        draggable={!renaming}
        onDragStart={(e) => beginDrag(e, { kind: "folder", id: folder.id }, folder.name)}
        onDragEnd={endDrag}
        onClick={() => !renaming && onOpen()}
        onKeyDown={(e) => {
          if (renaming) return;
          if (e.key === "Enter") onOpen();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu({ left: e.clientX, top: e.clientY, bottom: e.clientY });
        }}
        className="group relative flex cursor-pointer items-start gap-2 rounded-xl rounded-tl-none border border-edge bg-card px-4 pt-3.5 pb-3 shadow-soft outline-none transition-colors hover:bg-card-hover focus-visible:ring-2 focus-visible:ring-accent"
        style={{
          borderTop: `3px solid ${hex}`,
          background: over ? tint(color, 18) : undefined,
          boxShadow: over ? `0 0 0 2px ${hex}` : undefined,
        }}
      >
        <div className="min-w-0 flex-1">
          {renaming ? (
            <RenameField initial={folder.name} onDone={onRenamed} />
          ) : (
            <p className="truncate font-display font-bold">{folder.name}</p>
          )}
          <p id={metaId} className="truncate text-sm text-ink-faint">
            {parentPath ? `In ${parentPath}. ` : ""}
            {parts.length ? parts.join(", ") : "Empty"}
          </p>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            const a = anchorOf(e.currentTarget);
            if (a) onMenu(a);
          }}
          aria-label={`${folder.name} options`}
          className="-mr-1.5 rounded-lg p-1 text-ink-faint opacity-0 transition hover:bg-card hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </div>
    </div>
  );
}

/* ---- note row ----------------------------------------------------------------- */

function NoteRow({
  note,
  lib,
  sort,
  showPath,
  selected,
  selecting,
  renaming,
  onClick,
  onToggle,
  onMenu,
  onRenamed,
  dragIds,
  onOpenFolder,
}: {
  note: Note;
  lib: Library;
  sort: SortKey;
  showPath: boolean;
  selected: boolean;
  selecting: boolean;
  renaming: boolean;
  onClick: (e: MouseEvent) => void;
  onToggle: () => void;
  onMenu: (a: Anchor) => void;
  onRenamed: (title: string | null) => void;
  dragIds: () => string[];
  onOpenFolder: (id: string) => void;
}) {
  const { Icon, color: iconColor } = sourceIcon(note.sourceKind);
  const course = note.folderId ? effectiveColor(lib.folders, note.folderId) : undefined;
  const path = showPath ? pathTo(lib.folders, note.folderId) : [];
  const date = sort === "name" ? DATE_FIELD.opened : DATE_FIELD[sort];
  const files = sourceFileNames(note);
  const filesLabel = sourceFilesLabel(files);
  const [title, setTitle] = useState(note.title);
  // Re-seed on every rename: the row outlives title changes made elsewhere
  // (the editor, an earlier rename), and useState only reads its initial value.
  useEffect(() => {
    if (renaming) setTitle(note.title);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a rename starts
  }, [renaming]);

  return (
    <div
      draggable={!renaming}
      onDragStart={(e) => {
        const ids = dragIds();
        beginDrag(e, { kind: "notes", ids }, ids.length > 1 ? `${ids.length} notes` : note.title);
      }}
      onDragEnd={endDrag}
      onClick={(e) => !renaming && onClick(e)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ left: e.clientX, top: e.clientY, bottom: e.clientY, right: e.clientX });
      }}
      aria-selected={selecting ? selected : undefined}
      className={`group relative flex cursor-pointer items-center gap-4 overflow-hidden rounded-card border bg-card p-4 pl-5 shadow-soft transition-colors ${
        selected ? "border-accent bg-accent-softer" : "border-edge hover:bg-card-hover"
      }`}
    >
      {course && (
        <span aria-hidden className="absolute inset-y-0 left-0 w-1.5" style={{ background: colorHex(course) }} />
      )}
      <span className="relative flex size-10 shrink-0 items-center justify-center">
        <span
          className={`flex size-10 items-center justify-center rounded-xl ${iconColor} ${
            selecting || selected ? "opacity-0" : "group-hover:opacity-0"
          }`}
        >
          <Icon className="size-5" />
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          role="checkbox"
          aria-checked={selected}
          aria-label={`Select ${note.title}`}
          className={`absolute inset-0 m-auto flex size-6 items-center justify-center rounded-md border-2 transition-opacity ${
            selected ? "border-accent bg-accent text-white" : "border-ink-faint bg-card"
          } ${selecting || selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
        >
          {selected && <Check className="size-4" strokeWidth={3} />}
        </button>
      </span>
      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            autoFocus
            value={title}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setTitle(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRenamed(title.trim() || null);
              if (e.key === "Escape") onRenamed(null);
            }}
            onBlur={() => onRenamed(title.trim() || null)}
            aria-label="Note title"
            className="w-full rounded-md border border-accent bg-card px-1.5 py-0.5 font-display font-bold outline-none"
          />
        ) : (
          <p className="flex items-center gap-1.5 truncate font-display font-bold">
            {note.pinned && <Pin className="size-3.5 shrink-0 fill-current text-accent" aria-label="Pinned" />}
            <span className="truncate">{note.title}</span>
          </p>
        )}
        <p className="flex min-w-0 items-center gap-1.5 text-sm text-ink-faint">
          <span className="shrink-0">
            {date.verb} {relTime(note[date.field] as number)}
          </span>
          {filesLabel && (
            <>
              <span aria-hidden>·</span>
              <span className="flex min-w-0 items-center gap-1" title={files.join("\n")}>
                <FileText className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{filesLabel}</span>
              </span>
            </>
          )}
        </p>
      </div>
      {path.length > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenFolder(path[path.length - 1].id);
          }}
          title={`Open ${path.map((p) => p.name).join(" / ")}`}
          className="hidden max-w-[40%] shrink items-center gap-1.5 truncate rounded-lg px-2 py-1 text-xs font-semibold sm:flex"
          style={{ background: tint(course, 14), color: `color-mix(in srgb, ${colorHex(course)} 65%, var(--nitro-ink))` }}
        >
          <FolderTab color={course} className="h-2.5 w-1.5" />
          <span className="truncate">{path.map((p) => p.name).join(" / ")}</span>
        </button>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          const a = anchorOf(e.currentTarget);
          if (a) onMenu(a);
        }}
        className="rounded-lg p-2 text-ink-faint opacity-0 transition hover:bg-card-hover hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
        aria-label="More"
      >
        <MoreVertical className="size-4.5" />
      </button>
    </div>
  );
}

function BarButton({
  icon: Icon,
  children,
  onClick,
  danger,
}: {
  icon: typeof Pin;
  children: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold ${
        danger ? "text-danger-ink hover:bg-danger-soft" : "text-ink hover:bg-card"
      }`}
    >
      <Icon className="size-4" />
      {children}
    </button>
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

function JobOverlay({ job, onCancel }: { job: Job; onCancel?: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[440px] max-w-[90vw] rounded-modal bg-card p-8 shadow-modal" role="status" aria-live="polite">
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
        {onCancel && (
          <div className="mt-6 flex justify-end">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-xl border border-edge bg-panel px-4 py-2 text-sm font-bold text-ink-dim hover:text-ink"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
