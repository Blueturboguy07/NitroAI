/* Choose what a sample quiz covers: courses (top-level folders), units
   (subfolders) and lessons (notes). Ticking a course or unit ticks every
   lesson under it; a partly ticked one shows as indeterminate. The selection
   itself is only ever a set of note ids. */

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, FileText } from "lucide-react";
import { childrenOf, colorHex, effectiveColor, notesUnder, sortNotes } from "../../lib/library";
import type { Folder, Note } from "../../lib/types";
import { FolderTab } from "../library/FolderBits";

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

export default function ScopePicker({
  folders,
  notes,
  selected,
  onChange,
}: {
  folders: Folder[];
  notes: Note[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  // Courses start open so their units are visible; units start closed.
  const [open, setOpen] = useState<Set<string>>(() => new Set(childrenOf(folders, undefined).map((f) => f.id)));
  const under = useMemo(
    () => new Map(folders.map((f) => [f.id, notesUnder(folders, notes, f.id).map((n) => n.id)])),
    [folders, notes],
  );
  const unfiled = useMemo(() => sortNotes(notesUnder(folders, notes, undefined), "name"), [folders, notes]);

  function setMany(ids: string[], on: boolean) {
    const next = new Set(selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    onChange(next);
  }
  const allOn = (ids: string[]) => ids.length > 0 && ids.every((id) => selected.has(id));
  const toggleOpen = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };

  const lessonRow = (n: Note) => (
    <li key={n.id}>
      <label className="flex cursor-pointer items-center gap-2 rounded-lg py-1 pr-2 pl-6 text-sm text-ink-dim hover:bg-card-hover hover:text-ink">
        <input
          type="checkbox"
          checked={selected.has(n.id)}
          onChange={() => setMany([n.id], !selected.has(n.id))}
          className="accent-accent"
        />
        <FileText className="size-3.5 shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1 truncate">{n.title}</span>
      </label>
    </li>
  );

  const folderRows = (parentId: string | undefined, depth: number) =>
    childrenOf(folders, parentId).map((f) => {
      const ids = under.get(f.id) ?? [];
      const on = ids.filter((id) => selected.has(id)).length;
      const isOpen = open.has(f.id);
      const color = effectiveColor(folders, f.id);
      const lessons = sortNotes(
        notes.filter((n) => n.folderId === f.id),
        "name",
      );
      const hasKids = lessons.length > 0 || childrenOf(folders, f.id).length > 0;
      return (
        <li key={f.id}>
          <div className="flex items-center gap-1 rounded-lg py-1 pr-2 hover:bg-card-hover">
            {hasKids ? (
              <button
                onClick={() => toggleOpen(f.id)}
                aria-label={isOpen ? `Collapse ${f.name}` : `Expand ${f.name}`}
                className="flex size-5 shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink"
              >
                <ChevronRight className={`size-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`} />
              </button>
            ) : (
              <span className="size-5 shrink-0" />
            )}
            <label
              className={`flex min-w-0 flex-1 items-center gap-2 text-sm ${
                ids.length ? "cursor-pointer text-ink" : "cursor-not-allowed text-ink-faint"
              }`}
            >
              <TriCheckbox
                checked={allOn(ids)}
                indeterminate={on > 0 && on < ids.length}
                disabled={!ids.length}
                onChange={() => setMany(ids, !allOn(ids))}
              />
              <FolderTab color={color} />
              <span className={`min-w-0 flex-1 truncate ${depth === 0 ? "font-semibold" : ""}`}>{f.name}</span>
              <span className="shrink-0 text-xs text-ink-faint tabular-nums">
                {on > 0 ? `${on}/${ids.length}` : plural(ids.length, "lesson")}
              </span>
            </label>
          </div>
          {hasKids && isOpen && (
            <ul
              className="my-0.5 ml-[9px] border-l-2 pl-1.5"
              style={{ borderColor: `color-mix(in srgb, ${colorHex(color)} 45%, transparent)` }}
            >
              {folderRows(f.id, depth + 1)}
              {lessons.map(lessonRow)}
            </ul>
          )}
        </li>
      );
    });

  const everything = notes.map((n) => n.id);
  const unfiledIds = unfiled.map((n) => n.id);

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold text-ink-faint">
          {selected.size ? `${plural(selected.size, "lesson")} selected` : "Nothing selected yet"}
        </span>
        <div className="flex gap-3 text-xs font-semibold">
          <button onClick={() => setMany(everything, true)} className="text-accent hover:underline">
            Select all
          </button>
          <button onClick={() => onChange(new Set())} disabled={!selected.size} className="text-ink-faint hover:text-ink disabled:opacity-50">
            Clear
          </button>
        </div>
      </div>
      <ul className="mt-2">
        {folderRows(undefined, 0)}
        {unfiled.length > 0 && (
          <li>
            <div className="flex items-center gap-1 rounded-lg py-1 pr-2 hover:bg-card-hover">
              <button
                onClick={() => toggleOpen("")}
                aria-label={open.has("") ? "Collapse notes not in a course" : "Expand notes not in a course"}
                className="flex size-5 shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink"
              >
                <ChevronRight className={`size-3.5 transition-transform ${open.has("") ? "rotate-90" : ""}`} />
              </button>
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm text-ink">
                <TriCheckbox
                  checked={allOn(unfiledIds)}
                  indeterminate={unfiledIds.some((id) => selected.has(id)) && !allOn(unfiledIds)}
                  onChange={() => setMany(unfiledIds, !allOn(unfiledIds))}
                />
                <span className="min-w-0 flex-1 truncate italic text-ink-dim">Not in a course</span>
                <span className="shrink-0 text-xs text-ink-faint tabular-nums">{plural(unfiled.length, "lesson")}</span>
              </label>
            </div>
            {open.has("") && <ul className="my-0.5 ml-[9px] border-l-2 border-edge pl-1.5">{unfiled.map(lessonRow)}</ul>}
          </li>
        )}
      </ul>
    </div>
  );
}

/* A checkbox whose third, "some of these" state is only settable from JS. */
function TriCheckbox({
  checked,
  indeterminate,
  disabled,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={onChange} className="accent-accent" />
  );
}
