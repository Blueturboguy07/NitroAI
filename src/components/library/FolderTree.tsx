import { useEffect, useRef, useState, type DragEvent } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ChevronRight, Library as LibraryIcon, MoreHorizontal, Plus } from "lucide-react";
import {
  activeDrag,
  canNest,
  childrenOf,
  colorHex,
  effectiveColor,
  endDrag,
  beginDrag,
  loadLibraryPrefs,
  pathTo,
  saveLibraryPrefs,
  tint,
  type DropPosition,
} from "../../lib/library";
import type { Folder } from "../../lib/types";
import type { Anchor } from "../ui/Popover";
import { FolderMenu, FolderTab, NewFolderModal, RenameField } from "./FolderBits";
import type { Library } from "./useLibrary";

/* Sidebar folder tree. Each nesting level hangs off a rail in its parent's
   colour, so a subfolder is visibly part of its course. Rows take dropped
   notes (file into), and dropped folders (top/bottom edge = reorder, middle =
   nest inside). */

type DropState = { id: string; pos: DropPosition } | null;

export default function FolderTree({ lib, collapsed }: { lib: Library; collapsed: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const onDashboard = location.pathname === "/";
  const activeId = onDashboard ? params.get("folder") : null;

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(loadLibraryPrefs().expanded));
  const [drop, setDrop] = useState<DropState>(null);
  const [rootDrop, setRootDrop] = useState(false);
  const [menu, setMenu] = useState<{ folder: Folder; anchor: Anchor } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newIn, setNewIn] = useState<{ parentId?: string } | null>(null);
  const expandTimer = useRef<{ id: string; t: ReturnType<typeof setTimeout> } | null>(null);

  function setOpen(next: Set<string>) {
    setExpanded(next);
    saveLibraryPrefs({ expanded: [...next] });
  }
  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };

  // Reveal the open folder: expand its ancestors.
  useEffect(() => {
    if (!activeId) return;
    const chain = pathTo(lib.folders, activeId).slice(0, -1).map((f) => f.id);
    if (chain.some((id) => !expanded.has(id))) setOpen(new Set([...expanded, ...chain]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, lib.folders]);

  function zone(e: DragEvent<HTMLElement>): DropPosition {
    if (activeDrag()?.kind !== "folder") return "inside";
    const r = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - r.top;
    return y < r.height * 0.28 ? "before" : y > r.height * 0.72 ? "after" : "inside";
  }

  function accepts(target: Folder, pos: DropPosition): boolean {
    const p = activeDrag();
    if (!p) return false;
    if (p.kind === "notes") return true;
    if (p.id === target.id) return false;
    return canNest(lib.folders, p.id, pos === "inside" ? target.id : target.parentId);
  }

  function dropOn(target: Folder | undefined, pos: DropPosition) {
    const p = activeDrag();
    endDrag();
    setDrop(null);
    setRootDrop(false);
    if (!p) return;
    if (p.kind === "notes") void lib.moveNotes(p.ids, target?.id);
    else void lib.moveFolder(p.id, target?.id, target ? pos : "inside");
  }

  function hoverExpand(id: string) {
    if (expanded.has(id) || expandTimer.current?.id === id) return;
    if (expandTimer.current) clearTimeout(expandTimer.current.t);
    expandTimer.current = {
      id,
      t: setTimeout(() => {
        setOpen(new Set([...expanded, id]));
        expandTimer.current = null;
      }, 650),
    };
  }

  const totalNotes = lib.notes.length;

  if (collapsed) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-3 pt-4">
        {childrenOf(lib.folders, undefined).map((f) => (
          <button
            key={f.id}
            title={f.name}
            aria-label={f.name}
            onClick={() => navigate(`/?folder=${f.id}`)}
            className={`flex size-9 items-center justify-center rounded-lg hover:bg-card-hover ${
              activeId === f.id ? "bg-card-hover" : ""
            }`}
          >
            <FolderTab color={f.color} className="h-4 w-3" />
          </button>
        ))}
      </div>
    );
  }

  const rows = (parentId: string | undefined, depth: number) =>
    childrenOf(lib.folders, parentId).map((f) => {
      const kids = childrenOf(lib.folders, f.id);
      const open = expanded.has(f.id);
      const color = effectiveColor(lib.folders, f.id);
      const active = activeId === f.id;
      const d = drop?.id === f.id ? drop.pos : null;
      const count = lib.counts.get(f.id)?.total ?? 0;
      return (
        <li key={f.id} role="none">
          <div
            role="treeitem"
            tabIndex={0}
            aria-selected={active}
            aria-expanded={kids.length ? open : undefined}
            aria-level={depth + 1}
            draggable={renaming !== f.id}
            onDragStart={(e) => beginDrag(e, { kind: "folder", id: f.id }, f.name)}
            onDragEnd={() => {
              endDrag();
              setDrop(null);
            }}
            onDragOver={(e) => {
              const pos = zone(e);
              if (!accepts(f, pos)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (d !== pos) setDrop({ id: f.id, pos });
              if (pos === "inside" && kids.length) hoverExpand(f.id);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDrop((cur) => (cur?.id === f.id ? null : cur));
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              dropOn(f, zone(e));
            }}
            onClick={() => navigate(`/?folder=${f.id}`)}
            onDoubleClick={() => setRenaming(f.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ folder: f, anchor: { left: e.clientX, top: e.clientY, bottom: e.clientY } });
            }}
            onKeyDown={(e) => {
              if (renaming === f.id) return;
              if (e.key === "Enter") navigate(`/?folder=${f.id}`);
              else if (e.key === "F2") setRenaming(f.id);
              else if (e.key === "ArrowRight" && kids.length && !open) toggle(f.id);
              else if (e.key === "ArrowLeft" && open) toggle(f.id);
              else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                // Keyboard path to the same menu the ⋯ button / right-click opens.
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ folder: f, anchor: { left: r.left, top: r.top, bottom: r.bottom, right: r.right } });
              }
            }}
            className={`group relative flex cursor-pointer items-center gap-1.5 rounded-lg py-1.5 pr-1 pl-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              active ? "font-semibold text-ink" : "text-ink-dim hover:bg-card-hover hover:text-ink"
            }`}
            style={
              active || d === "inside"
                ? {
                    background: tint(color, d === "inside" ? 22 : 16),
                    boxShadow: d === "inside" ? `inset 0 0 0 1.5px ${colorHex(color)}` : undefined,
                  }
                : undefined
            }
          >
            {kids.length ? (
              <button
                tabIndex={-1}
                aria-label={open ? `Collapse ${f.name}` : `Expand ${f.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(f.id);
                }}
                className="flex size-4 shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink"
              >
                <ChevronRight className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
              </button>
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <FolderTab color={color} />
            {renaming === f.id ? (
              <RenameField
                initial={f.name}
                onDone={(name) => {
                  setRenaming(null);
                  if (name && name !== f.name) void lib.updateFolder(f.id, { name });
                }}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
            )}
            {renaming !== f.id && (
              <>
                {/* The count reserves the slot the ⋯ button floats over, so the
                    name never runs under it. */}
                <span className="min-w-5 shrink-0 pr-1 text-right text-xs font-normal text-ink-faint tabular-nums group-hover:invisible group-focus-visible:invisible group-has-[button:focus-visible]:invisible">
                  {count || ""}
                </span>
                {/* Reachable by Tab (after its row) and shown on hover or
                    keyboard focus; opacity, not display:none, so it stays
                    focusable. */}
                <button
                  aria-label={`${f.name} options`}
                  onKeyDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu({ folder: f, anchor: { left: r.left, top: r.top, bottom: r.bottom, right: r.right } });
                  }}
                  className="pointer-events-none absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded text-ink-faint opacity-0 outline-none hover:bg-card hover:text-ink focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent group-hover:pointer-events-auto group-hover:opacity-100 group-focus-visible:pointer-events-auto group-focus-visible:opacity-100"
                >
                  <MoreHorizontal className="size-4" />
                </button>
              </>
            )}
            {(d === "before" || d === "after") && (
              <span
                aria-hidden
                className={`pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-accent ${
                  d === "before" ? "-top-px" : "-bottom-px"
                }`}
              />
            )}
          </div>
          {kids.length > 0 && open && (
            <ul
              role="group"
              className="my-0.5 ml-[11px] border-l-2 pl-1.5"
              style={{ borderColor: `color-mix(in srgb, ${colorHex(color)} 45%, transparent)` }}
            >
              {rows(f.id, depth + 1)}
            </ul>
          )}
        </li>
      );
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col pt-5">
      <div className="flex items-center justify-between px-5 pb-1.5">
        <span className="text-xs font-semibold text-ink-faint">Folders</span>
        <button
          onClick={() => setNewIn({})}
          aria-label="New folder"
          title="New folder"
          className="rounded-md p-1 text-ink-faint hover:bg-card-hover hover:text-ink"
        >
          <Plus className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div
          role="button"
          tabIndex={0}
          onClick={() => navigate("/")}
          onKeyDown={(e) => e.key === "Enter" && navigate("/")}
          onDragOver={(e) => {
            if (!activeDrag()) return;
            e.preventDefault();
            setRootDrop(true);
          }}
          onDragLeave={() => setRootDrop(false)}
          onDrop={(e) => {
            e.preventDefault();
            dropOn(undefined, "inside");
          }}
          className={`flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            onDashboard && !activeId ? "bg-card-hover font-semibold text-ink" : "text-ink-dim hover:bg-card-hover hover:text-ink"
          } ${rootDrop ? "ring-2 ring-accent ring-inset" : ""}`}
          title="Drop here to take notes out of their folder"
        >
          <LibraryIcon className="size-4 shrink-0" />
          <span className="flex-1">All notes</span>
          <span className="pr-1 text-xs font-normal text-ink-faint tabular-nums">{totalNotes || ""}</span>
        </div>
        {lib.folders.length > 0 ? (
          <ul role="tree" aria-label="Folders" className="mt-0.5">
            {rows(undefined, 0)}
          </ul>
        ) : (
          lib.loaded && (
            <button
              onClick={() => setNewIn({})}
              className="mt-2 w-full rounded-lg border border-dashed border-edge px-3 py-3 text-left text-xs text-ink-faint hover:border-accent hover:text-ink"
            >
              <span className="block font-display text-sm font-semibold text-ink-dim">Make a folder per course</span>
              Then drag notes onto it to file them.
            </button>
          )
        )}
      </div>

      {menu && (
        <FolderMenu
          lib={lib}
          folder={menu.folder}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          onOpen={() => navigate(`/?folder=${menu.folder.id}`)}
          onRename={() => setRenaming(menu.folder.id)}
          onNewInside={() => setNewIn({ parentId: menu.folder.id })}
        />
      )}
      {newIn && (
        <NewFolderModal
          lib={lib}
          parentId={newIn.parentId}
          onClose={() => setNewIn(null)}
          onCreated={(f) => {
            if (f.parentId) setOpen(new Set([...expanded, f.parentId]));
          }}
        />
      )}
    </div>
  );
}
