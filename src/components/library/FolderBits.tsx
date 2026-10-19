import { useState } from "react";
import { Check, FolderOpen, FolderPlus, FolderUp, Pencil, Trash2, X } from "lucide-react";
import Popover, { MenuDivider, MenuItem, type Anchor } from "../ui/Popover";
import { FOLDER_COLORS, childrenOf, colorHex, effectiveColor, nextColor } from "../../lib/library";
import type { Folder } from "../../lib/types";
import type { Library } from "./useLibrary";

/* The coloured index tab that marks a folder everywhere it appears. */
export function FolderTab({ color, className = "" }: { color: string | undefined; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 rounded-[3px] ${className || "h-3.5 w-2"}`}
      style={{ background: colorHex(color) }}
    />
  );
}

export function ColorSwatches({
  value,
  onChange,
  allowInherit,
  inheritColor,
}: {
  value: string | undefined;
  onChange: (c: string | undefined) => void;
  allowInherit?: boolean;
  inheritColor?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Folder colour">
      {allowInherit && (
        <button
          type="button"
          role="radio"
          aria-checked={!value}
          title="Same as parent folder"
          onClick={() => onChange(undefined)}
          className={`relative flex size-6 items-center justify-center rounded-full border-2 border-dashed ${
            !value ? "ring-2 ring-accent ring-offset-2 ring-offset-card" : ""
          }`}
          style={{ borderColor: colorHex(inheritColor) }}
        >
          <span className="sr-only">Same as parent folder</span>
        </button>
      )}
      {FOLDER_COLORS.map((c) => (
        <button
          key={c.key}
          type="button"
          role="radio"
          aria-checked={value === c.key}
          aria-label={c.label}
          title={c.label}
          onClick={() => onChange(c.key)}
          className={`flex size-6 items-center justify-center rounded-full ${
            value === c.key ? "ring-2 ring-accent ring-offset-2 ring-offset-card" : "hover:scale-110"
          } transition-transform`}
          style={{ background: c.hex }}
        >
          {value === c.key && <Check className="size-3.5 text-white" strokeWidth={3} />}
        </button>
      ))}
    </div>
  );
}

/* Right-click / ⋯ menu for a folder. */
export function FolderMenu({
  lib,
  folder,
  anchor,
  onClose,
  onOpen,
  onRename,
  onNewInside,
}: {
  lib: Library;
  folder: Folder;
  anchor: Anchor;
  onClose: () => void;
  onOpen: () => void;
  onRename: () => void;
  onNewInside: () => void;
}) {
  const inherited = folder.parentId ? effectiveColor(lib.folders, folder.parentId) : undefined;
  return (
    <Popover anchor={anchor} onClose={onClose} className="w-64 p-1" role="menu" label={`${folder.name} options`}>
      <MenuItem icon={FolderOpen} onSelect={() => { onClose(); onOpen(); }}>Open</MenuItem>
      <MenuItem icon={FolderPlus} onSelect={() => { onClose(); onNewInside(); }}>New folder inside</MenuItem>
      <MenuItem icon={Pencil} onSelect={() => { onClose(); onRename(); }}>Rename</MenuItem>
      {folder.parentId && (
        <MenuItem icon={FolderUp} onSelect={() => { onClose(); void lib.moveFolder(folder.id, undefined, "inside"); }}>
          Move to top level
        </MenuItem>
      )}
      <MenuDivider />
      <div className="px-2.5 pt-1 pb-2">
        <p className="mb-2 text-xs font-semibold text-ink-faint">Colour</p>
        <ColorSwatches
          value={folder.color}
          allowInherit={!!folder.parentId}
          inheritColor={inherited}
          onChange={(c) => void lib.updateFolder(folder.id, { color: c })}
        />
      </div>
      <MenuDivider />
      <MenuItem icon={Trash2} danger onSelect={() => { onClose(); void lib.deleteFolder(folder.id); }}>
        Delete folder, keep its notes
      </MenuItem>
    </Popover>
  );
}

/* Inline rename field used by tree rows and folder tiles. */
export function RenameField({
  initial,
  onDone,
  className = "",
}: {
  initial: string;
  onDone: (name: string | null) => void;
  className?: string;
}) {
  const [name, setName] = useState(initial);
  return (
    <input
      autoFocus
      value={name}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setName(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onDone(name.trim() || null);
        if (e.key === "Escape") onDone(null);
      }}
      onBlur={() => onDone(name.trim() || null)}
      aria-label="Folder name"
      className={`min-w-0 flex-1 rounded-md border border-accent bg-card px-1.5 py-0.5 text-sm outline-none ${className}`}
    />
  );
}

/* New folder dialog: name, location and colour. */
export function NewFolderModal({
  lib,
  parentId: initialParent,
  onClose,
  onCreated,
}: {
  lib: Library;
  parentId?: string;
  onClose: () => void;
  onCreated?: (f: Folder) => void;
}) {
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string | undefined>(initialParent);
  // Top-level folders start on the next unused course colour; subfolders
  // start on "same as parent".
  const [color, setColor] = useState<string | undefined>(() =>
    initialParent ? undefined : nextColor(lib.folders),
  );
  const inherited = parentId ? effectiveColor(lib.folders, parentId) : undefined;

  async function create() {
    const f = await lib.createFolder({ name, parentId, color });
    if (f) {
      onCreated?.(f);
      onClose();
    }
  }

  // Flattened tree for the location picker.
  const options: { id: string; label: string; depth: number }[] = [];
  const walk = (pid: string | undefined, depth: number) => {
    for (const f of childrenOf(lib.folders, pid)) {
      options.push({ id: f.id, label: f.name, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(undefined, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-folder-title"
        className="w-[420px] max-w-[90vw] rounded-modal bg-card p-6 shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 id="new-folder-title" className="font-display text-lg font-bold">New folder</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-ink-faint hover:bg-card-hover hover:text-ink" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
          placeholder="Folder name"
          className="mt-4 w-full rounded-xl border border-edge bg-panel px-4 py-3 text-sm outline-none placeholder:text-ink-faint focus:border-accent"
        />
        {options.length > 0 && (
          <label className="mt-4 block">
            <span className="mb-1.5 block text-xs font-semibold text-ink-dim">Location</span>
            <select
              value={parentId ?? ""}
              onChange={(e) => {
                const next = e.target.value || undefined;
                setParentId(next);
                setColor(next ? undefined : nextColor(lib.folders));
              }}
              className="w-full rounded-xl border border-edge bg-panel px-3 py-2.5 text-sm outline-none focus:border-accent"
            >
              <option value="">Top level</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {" ".repeat(o.depth * 2)}
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="mt-4">
          <span className="mb-2 block text-xs font-semibold text-ink-dim">Colour</span>
          <ColorSwatches value={color} onChange={setColor} allowInherit={!!parentId} inheritColor={inherited} />
        </div>
        <button
          onClick={() => void create()}
          disabled={!name.trim()}
          className={`mt-5 w-full rounded-xl py-3 font-display font-bold transition ${
            name.trim() ? "bg-accent text-white hover:bg-accent-hover" : "cursor-not-allowed bg-accent-softer text-ink-faint"
          }`}
        >
          Create folder
        </button>
      </div>
    </div>
  );
}
