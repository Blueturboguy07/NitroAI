/* Library organisation: folder colours, the folder tree, drag-and-drop
   payloads, and the dashboard's remembered view settings. Pure helpers only;
   the UI wires them up in components/library. */

import type { DragEvent } from "react";
import type { Folder, Note } from "./types";

/* ---- colours -------------------------------------------------------------- */

/* Course colours. Mid-tone so they read as spines, tabs and dots on both
   themes; tints are mixed from them with color-mix() at the point of use. */
export const FOLDER_COLORS = [
  { key: "violet", label: "Violet", hex: "#7c5cff" },
  { key: "tomato", label: "Tomato", hex: "#e5484d" },
  { key: "amber", label: "Amber", hex: "#e8a317" },
  { key: "grass", label: "Grass", hex: "#3a9e5c" },
  { key: "teal", label: "Teal", hex: "#13a091" },
  { key: "sky", label: "Sky", hex: "#2b9bd6" },
  { key: "blue", label: "Blue", hex: "#3e63dd" },
  { key: "plum", label: "Plum", hex: "#a94bbd" },
  { key: "pink", label: "Pink", hex: "#d6409f" },
  { key: "slate", label: "Slate", hex: "#7b8494" },
] as const;
export type FolderColor = (typeof FOLDER_COLORS)[number]["key"];

const FALLBACK = "slate";

export function colorHex(key: string | undefined): string {
  return (FOLDER_COLORS.find((c) => c.key === key) ?? FOLDER_COLORS.find((c) => c.key === FALLBACK)!).hex;
}

/** Soft background tint of a folder colour over the card surface. */
export function tint(key: string | undefined, amount = 14): string {
  return `color-mix(in srgb, ${colorHex(key)} ${amount}%, var(--nitro-card))`;
}

/** A folder's own colour, or the nearest ancestor's. */
export function effectiveColor(folders: Folder[], id: string | undefined): string | undefined {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let cur = id ? byId.get(id) : undefined;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    if (cur.color) return cur.color;
    seen.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return cur?.color;
}

/** The least-used colour among top-level folders, so each new course gets
 *  its own colour until the palette runs out. */
export function nextColor(folders: Folder[]): FolderColor {
  const used = new Map<string, number>();
  for (const f of folders) if (!f.parentId && f.color) used.set(f.color, (used.get(f.color) ?? 0) + 1);
  let best: FolderColor = FOLDER_COLORS[0].key;
  let bestCount = Infinity;
  for (const c of FOLDER_COLORS) {
    if (c.key === "slate") continue;
    const n = used.get(c.key) ?? 0;
    if (n < bestCount) {
      best = c.key;
      bestCount = n;
    }
  }
  return best;
}

/* ---- tree ----------------------------------------------------------------- */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function sortFolders(a: Folder, b: Folder): number {
  const ao = a.order ?? Number.MAX_SAFE_INTEGER;
  const bo = b.order ?? Number.MAX_SAFE_INTEGER;
  return ao !== bo ? ao - bo : collator.compare(a.name, b.name);
}

/** Direct children of `parentId` (undefined = top level), in display order.
 *  Folders whose parent no longer exists are treated as top level. */
export function childrenOf(folders: Folder[], parentId: string | undefined): Folder[] {
  const ids = new Set(folders.map((f) => f.id));
  return folders
    .filter((f) =>
      parentId === undefined
        ? !f.parentId || !ids.has(f.parentId)
        : f.parentId === parentId,
    )
    .sort(sortFolders);
}

/** Root-first chain of folders from the top level down to `id`, inclusive. */
export function pathTo(folders: Folder[], id: string | undefined): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const chain: Folder[] = [];
  const seen = new Set<string>();
  let cur = id ? byId.get(id) : undefined;
  while (cur && !seen.has(cur.id)) {
    chain.unshift(cur);
    seen.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

export function descendantIds(folders: Folder[], id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const f of folders) {
      if (f.parentId === cur && !out.has(f.id)) {
        out.add(f.id);
        stack.push(f.id);
      }
    }
  }
  return out;
}

/** Notes filed in `folderId` or any folder below it; undefined = notes in no
 *  folder (or in one that no longer exists). */
export function notesUnder(folders: Folder[], notes: Note[], folderId: string | undefined): Note[] {
  if (folderId === undefined) {
    const ids = new Set(folders.map((f) => f.id));
    return notes.filter((n) => !n.folderId || !ids.has(n.folderId));
  }
  const inside = descendantIds(folders, folderId).add(folderId);
  return notes.filter((n) => n.folderId !== undefined && inside.has(n.folderId));
}

/** Whether `id` may move under `newParent` (never into itself or below). */
export function canNest(folders: Folder[], id: string, newParent: string | undefined): boolean {
  if (!newParent) return true;
  if (newParent === id) return false;
  return !descendantIds(folders, id).has(newParent);
}

export interface FolderCounts {
  notes: number; // directly inside
  total: number; // inside, including all subfolders
  folders: number; // direct subfolders
}

export function countAll(folders: Folder[], notes: Note[]): Map<string, FolderCounts> {
  const counts = new Map<string, FolderCounts>(
    folders.map((f) => [f.id, { notes: 0, total: 0, folders: 0 }]),
  );
  const byId = new Map(folders.map((f) => [f.id, f]));
  for (const f of folders) if (f.parentId && counts.has(f.parentId)) counts.get(f.parentId)!.folders++;
  for (const n of notes) {
    if (!n.folderId || !counts.has(n.folderId)) continue;
    counts.get(n.folderId)!.notes++;
    const seen = new Set<string>();
    let cur = byId.get(n.folderId);
    while (cur && !seen.has(cur.id)) {
      counts.get(cur.id)!.total++;
      seen.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return counts;
}

export type DropPosition = "before" | "inside" | "after";

/** Folders whose parentId/order change when `id` is dropped relative to
 *  `targetId`. Siblings at the destination are renumbered 0..n. */
export function placeFolder(
  folders: Folder[],
  id: string,
  targetId: string | undefined,
  position: DropPosition,
): Folder[] {
  const moving = folders.find((f) => f.id === id);
  if (!moving) return [];
  const target = targetId ? folders.find((f) => f.id === targetId) : undefined;
  const parentId = position === "inside" || !target ? targetId : target.parentId;
  if (!canNest(folders, id, parentId)) return [];
  const siblings = childrenOf(folders, parentId).filter((f) => f.id !== id);
  let index = siblings.length;
  if (target && position !== "inside") {
    const at = siblings.findIndex((f) => f.id === target.id);
    index = at < 0 ? siblings.length : position === "before" ? at : at + 1;
  }
  siblings.splice(index, 0, moving);
  const changed: Folder[] = [];
  siblings.forEach((f, i) => {
    const nextParent = f.id === id ? parentId : f.parentId;
    if (f.order !== i || f.parentId !== nextParent) {
      changed.push({ ...f, order: i, parentId: nextParent });
    }
  });
  return changed;
}

/* ---- notes ---------------------------------------------------------------- */

export type SortKey = "opened" | "edited" | "name" | "created";

export const SORTS: { key: SortKey; label: string }[] = [
  { key: "opened", label: "Last opened" },
  { key: "edited", label: "Last edited" },
  { key: "created", label: "Date created" },
  { key: "name", label: "Name" },
];

export function sortNotes(notes: Note[], key: SortKey): Note[] {
  const out = [...notes];
  switch (key) {
    case "name":
      return out.sort((a, b) => collator.compare(a.title, b.title));
    case "created":
      return out.sort((a, b) => b.createdAt - a.createdAt);
    case "edited":
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    default:
      return out.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }
}

/** The uploaded files a note came from. Notes made before `sourceFiles`
 *  existed only kept the first file's name in `sourceMeta.filename`. */
export function sourceFileNames(note: Note): string[] {
  if (note.sourceFiles?.length) return note.sourceFiles;
  const legacy = note.sourceMeta?.filename;
  return typeof legacy === "string" && legacy ? [legacy] : [];
}

/** Short label for a note card's file line, e.g. for one or many uploads.
 *  Returns null when the note has no source files (blank / link notes). */
export function sourceFilesLabel(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return names[0];
  return `${names[0]} +${names.length - 1} more`;
}

/** Time buckets for date-based sorts. */
export function bucketOf(ms: number, now = Date.now()): "Today" | "This week" | "Earlier" {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (ms >= start.getTime()) return "Today";
  if (ms >= start.getTime() - 6 * 86400000) return "This week";
  return "Earlier";
}

/* ---- drag and drop -------------------------------------------------------- */

/* HTML5 drag data can't be read during dragover, so the active payload is
   also kept here for drop-target validation. */
export type DragPayload = { kind: "notes"; ids: string[] } | { kind: "folder"; id: string };

export const DRAG_MIME = "application/x-nitro-library";
let active: DragPayload | null = null;

export function beginDrag(e: DragEvent, payload: DragPayload, label: string) {
  active = payload;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
  e.dataTransfer.setData("text/plain", label);
  // A compact pill as the drag image instead of a ghost of the whole row.
  const ghost = document.createElement("div");
  ghost.textContent = label;
  ghost.className = "nitro-drag-ghost";
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 14, 14);
  requestAnimationFrame(() => ghost.remove());
}

export function activeDrag(): DragPayload | null {
  return active;
}

export function endDrag() {
  active = null;
}

/* ---- remembered view settings --------------------------------------------- */

const PREFS_KEY = "nitroai.library";

export interface LibraryPrefs {
  expanded: string[];
  sort: SortKey;
}

export function loadLibraryPrefs(): LibraryPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<LibraryPrefs>;
    return {
      expanded: Array.isArray(raw.expanded) ? raw.expanded : [],
      sort: SORTS.some((s) => s.key === raw.sort) ? (raw.sort as SortKey) : "opened",
    };
  } catch {
    return { expanded: [], sort: "opened" };
  }
}

export function saveLibraryPrefs(patch: Partial<LibraryPrefs>) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadLibraryPrefs(), ...patch }));
  } catch {
    /* storage unavailable */
  }
}
