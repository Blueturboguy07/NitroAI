import { useMemo, useState } from "react";
import { Check, Library as LibraryIcon, Search } from "lucide-react";
import Popover, { type Anchor } from "../ui/Popover";
import { childrenOf, effectiveColor } from "../../lib/library";
import { FolderTab } from "./FolderBits";
import type { Library } from "./useLibrary";

/* "Move to…" picker: the folder tree with a filter field. */
export default function MovePicker({
  lib,
  ids,
  anchor,
  onClose,
}: {
  lib: Library;
  ids: string[];
  anchor: Anchor;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const current = useMemo(() => {
    const set = new Set(lib.notes.filter((n) => ids.includes(n.id)).map((n) => n.folderId ?? ""));
    return set.size === 1 ? [...set][0] : null;
  }, [lib.notes, ids]);

  const rows = useMemo(() => {
    const out: { id: string; name: string; depth: number; color?: string }[] = [];
    const walk = (pid: string | undefined, depth: number) => {
      for (const f of childrenOf(lib.folders, pid)) {
        out.push({ id: f.id, name: f.name, depth, color: effectiveColor(lib.folders, f.id) });
        walk(f.id, depth + 1);
      }
    };
    walk(undefined, 0);
    const needle = q.trim().toLowerCase();
    return needle ? out.filter((r) => r.name.toLowerCase().includes(needle)).map((r) => ({ ...r, depth: 0 })) : out;
  }, [lib.folders, q]);

  const move = (folderId: string | undefined) => {
    onClose();
    void lib.moveNotes(ids, folderId);
  };

  return (
    <Popover anchor={anchor} onClose={onClose} className="w-72 p-1.5" label="Move to folder">
      <label className="mb-1 flex items-center gap-2 rounded-lg border border-edge bg-panel px-2.5 py-1.5">
        <Search className="size-3.5 text-ink-faint" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && rows[0]) move(rows[0].id);
          }}
          placeholder="Move to…"
          aria-label="Find a folder"
          className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
        />
      </label>
      <div className="max-h-72 overflow-y-auto" role="listbox" aria-label="Folders">
        {!q && (
          <button
            role="option"
            aria-selected={current === ""}
            onClick={() => move(undefined)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-card-hover"
          >
            <LibraryIcon className="size-3.5 text-ink-dim" />
            <span className="flex-1">No folder</span>
            {current === "" && <Check className="size-3.5 text-accent" />}
          </button>
        )}
        {rows.map((r) => (
          <button
            key={r.id}
            role="option"
            aria-selected={current === r.id}
            onClick={() => move(r.id)}
            className="flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-sm hover:bg-card-hover"
            style={{ paddingLeft: 8 + r.depth * 14 }}
          >
            <FolderTab color={r.color} />
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
            {current === r.id && <Check className="size-3.5 text-accent" />}
          </button>
        ))}
        {rows.length === 0 && (
          <p className="px-2 py-3 text-sm text-ink-faint">
            {lib.folders.length ? "No folder by that name." : "No folders yet. Create one from the sidebar."}
          </p>
        )}
      </div>
    </Popover>
  );
}
