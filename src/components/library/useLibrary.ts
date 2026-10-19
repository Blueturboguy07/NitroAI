import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../lib/app";
import { useToast } from "../ui/Toast";
import { uuid, now } from "../../lib/ids";
import {
  childrenOf,
  countAll,
  nextColor,
  placeFolder,
  type DropPosition,
} from "../../lib/library";
import type { Folder, Note } from "../../lib/types";

/* Notes hidden while their delete toast is showing. Module-level so every
   view (sidebar, dashboard) hides them until the delete is final. */
const pendingDeletes = new Set<string>();

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* Library data plus every organising action. Each change shows a toast with
   Undo; undo restores the exact previous records. */
export function useLibrary() {
  const { repo, version, bump } = useApp();
  const toast = useToast();
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const latest = useRef({ notes, folders });
  latest.current = { notes, folders };

  useEffect(() => {
    if (!repo) return;
    let alive = true;
    Promise.all([repo.listNotes(), repo.listFolders()]).then(([n, f]) => {
      if (!alive) return;
      setNotes(n.filter((x) => !pendingDeletes.has(x.id)));
      setFolders(f);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [repo, version]);

  const counts = useMemo(() => countAll(folders, notes), [folders, notes]);
  const folderName = useCallback(
    (id: string | undefined) => (id ? (latest.current.folders.find((f) => f.id === id)?.name ?? "folder") : "All notes"),
    [],
  );

  /* Write changed records and offer to put the old versions back. */
  const commit = useCallback(
    async (
      message: string,
      change: { notes?: Note[]; folders?: Folder[]; deleteFolders?: string[] },
    ) => {
      if (!repo) return;
      const { notes: allNotes, folders: allFolders } = latest.current;
      const prevNotes = (change.notes ?? [])
        .map((n) => allNotes.find((x) => x.id === n.id))
        .filter((n): n is Note => !!n);
      const prevFolders = [...(change.folders ?? []), ...(change.deleteFolders ?? []).map((id) => ({ id }))]
        .map((f) => allFolders.find((x) => x.id === f.id))
        .filter((f): f is Folder => !!f);
      const createdFolders = (change.folders ?? []).filter((f) => !allFolders.some((x) => x.id === f.id));

      await Promise.all([
        ...(change.notes ?? []).map((n) => repo.putNote(n)),
        ...(change.folders ?? []).map((f) => repo.putFolder(f)),
        ...(change.deleteFolders ?? []).map((id) => repo.deleteFolder(id)),
      ]);
      bump();
      toast.show({
        message,
        undo: async () => {
          await Promise.all([
            ...prevNotes.map((n) => repo.putNote(n)),
            ...prevFolders.map((f) => repo.putFolder(f)),
            ...createdFolders.map((f) => repo.deleteFolder(f.id)),
          ]);
          bump();
        },
      });
    },
    [repo, bump, toast],
  );

  const createFolder = useCallback(
    async (input: { name: string; parentId?: string; color?: string }): Promise<Folder | null> => {
      if (!repo) return null;
      const name = input.name.trim();
      if (!name) return null;
      const all = latest.current.folders;
      const siblings = childrenOf(all, input.parentId);
      const folder: Folder = {
        id: uuid(),
        name,
        createdAt: now(),
        parentId: input.parentId,
        // Subfolders inherit their course colour unless one is picked.
        color: input.color ?? (input.parentId ? undefined : nextColor(all)),
        order: siblings.length,
      };
      await repo.putFolder(folder);
      bump();
      return folder;
    },
    [repo, bump],
  );

  const updateFolder = useCallback(
    async (id: string, patch: Partial<Folder>) => {
      const f = latest.current.folders.find((x) => x.id === id);
      if (!repo || !f) return;
      await repo.putFolder({ ...f, ...patch });
      bump();
    },
    [repo, bump],
  );

  const moveNotes = useCallback(
    async (ids: string[], folderId: string | undefined) => {
      const moving = latest.current.notes.filter((n) => ids.includes(n.id) && n.folderId !== folderId);
      if (!moving.length) return;
      await commit(
        `Moved ${moving.length === 1 ? `“${moving[0].title}”` : plural(moving.length, "note")} to ${folderName(folderId)}`,
        { notes: moving.map((n) => ({ ...n, folderId })) },
      );
    },
    [commit, folderName],
  );

  const moveFolder = useCallback(
    async (id: string, targetId: string | undefined, position: DropPosition) => {
      const changed = placeFolder(latest.current.folders, id, targetId, position);
      if (!changed.length) return;
      const moved = changed.find((f) => f.id === id);
      const before = latest.current.folders.find((f) => f.id === id);
      const reparented = moved && before && moved.parentId !== before.parentId;
      await commit(
        reparented
          ? `Moved “${before.name}” to ${folderName(moved.parentId)}`
          : `Reordered “${before?.name ?? "folder"}”`,
        { folders: changed },
      );
    },
    [commit, folderName],
  );

  /* Deleting a folder never deletes notes: its notes and subfolders move up
     to the folder's parent. */
  const deleteFolder = useCallback(
    async (id: string) => {
      const { notes: allNotes, folders: allFolders } = latest.current;
      const folder = allFolders.find((f) => f.id === id);
      if (!folder) return;
      const parentId = folder.parentId;
      const notesUp = allNotes.filter((n) => n.folderId === id).map((n) => ({ ...n, folderId: parentId }));
      const base = childrenOf(allFolders, parentId).length;
      const foldersUp = childrenOf(allFolders, id).map((f, i) => ({ ...f, parentId, order: base + i }));
      await commit(`Deleted “${folder.name}”`, {
        notes: notesUp,
        folders: foldersUp,
        deleteFolders: [id],
      });
    },
    [commit],
  );

  const setPinned = useCallback(
    async (ids: string[], pinned: boolean) => {
      const changing = latest.current.notes.filter((n) => ids.includes(n.id) && !!n.pinned !== pinned);
      if (!changing.length) return;
      await commit(
        `${pinned ? "Pinned" : "Unpinned"} ${changing.length === 1 ? `“${changing[0].title}”` : plural(changing.length, "note")}`,
        { notes: changing.map((n) => ({ ...n, pinned })) },
      );
    },
    [commit],
  );

  const renameNote = useCallback(
    async (id: string, title: string) => {
      const n = latest.current.notes.find((x) => x.id === id);
      const t = title.trim();
      if (!repo || !n || !t || t === n.title) return;
      await repo.putNote({ ...n, title: t, updatedAt: now() });
      bump();
    },
    [repo, bump],
  );

  /* Deletes wait for the toast to expire, so Undo is a true undo (flashcards,
     quiz and chat history are only removed once the delete is final). */
  const deleteNotes = useCallback(
    (ids: string[]) => {
      if (!repo || !ids.length) return;
      const titles = latest.current.notes.filter((n) => ids.includes(n.id)).map((n) => n.title);
      ids.forEach((id) => pendingDeletes.add(id));
      setNotes((ns) => ns.filter((n) => !pendingDeletes.has(n.id)));
      bump();
      toast.show({
        message: `Deleted ${titles.length === 1 ? `“${titles[0]}”` : plural(ids.length, "note")}`,
        undo: () => {
          ids.forEach((id) => pendingDeletes.delete(id));
          bump();
        },
        onExpire: async () => {
          await Promise.all(ids.map((id) => repo.deleteNote(id)));
          ids.forEach((id) => pendingDeletes.delete(id));
          bump();
        },
      });
    },
    [repo, bump, toast],
  );

  return {
    notes,
    folders,
    counts,
    loaded,
    createFolder,
    updateFolder,
    moveNotes,
    moveFolder,
    deleteFolder,
    setPinned,
    renameNote,
    deleteNotes,
  };
}

export type Library = ReturnType<typeof useLibrary>;
