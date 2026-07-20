import { useEffect, useMemo, useRef, useState } from "react";
import {
  Code2,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Sigma,
  StickyNote,
  Text as TextIcon,
} from "lucide-react";
import { renderMath, renderRichInline } from "../lib/markdown";
import { uuid } from "../lib/ids";
import type { Block, BlockType } from "../lib/types";

/* Custom block editor: click a block to edit its Markdown source; blur to render.
   Typing "/" at the start of a block opens the slash command menu — Turbo's
   editor has no slash menu, so this is a NitroAI differentiator. */

const SLASH_ITEMS: { type: BlockType; label: string; icon: typeof TextIcon }[] = [
  { type: "paragraph", label: "Text", icon: TextIcon },
  { type: "heading1", label: "Heading 1", icon: Heading1 },
  { type: "heading2", label: "Heading 2", icon: Heading2 },
  { type: "heading3", label: "Heading 3", icon: Heading3 },
  { type: "bullet", label: "Bulleted list", icon: List },
  { type: "numbered", label: "Numbered list", icon: ListOrdered },
  { type: "todo", label: "To-do", icon: ListTodo },
  { type: "quote", label: "Quote", icon: Quote },
  { type: "callout", label: "Callout", icon: StickyNote },
  { type: "code", label: "Code", icon: Code2 },
  { type: "math", label: "Equation", icon: Sigma },
  { type: "divider", label: "Divider", icon: Minus },
];

const MULTILINE: BlockType[] = ["code", "math", "table"];
const LIST_TYPES: BlockType[] = ["bullet", "numbered", "todo"];

export default function BlockEditor({
  blocks: initial,
  onChange,
}: {
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
}) {
  const [blocks, setBlocks] = useState<Block[]>(() =>
    initial.length ? initial : [{ id: uuid(), type: "paragraph", text: "" }],
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [slash, setSlash] = useState<{ id: string; query: string } | null>(null);

  function commit(next: Block[]) {
    setBlocks(next);
    onChange(next);
  }

  const update = (id: string, patch: Partial<Block>) =>
    commit(blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)));

  function convert(id: string, type: BlockType) {
    commit(
      blocks.map((b) =>
        b.id === id
          ? { ...b, type, text: type === "divider" ? "" : b.text.replace(/^\//, "") }
          : b,
      ),
    );
    setSlash(null);
    setEditingId(type === "divider" ? null : id);
    setFocusId(id);
  }

  function insertAfter(id: string, type: BlockType = "paragraph") {
    const nb: Block = { id: uuid(), type, text: "" };
    const idx = blocks.findIndex((b) => b.id === id);
    const next = [...blocks];
    next.splice(idx + 1, 0, nb);
    commit(next);
    setEditingId(nb.id);
    setFocusId(nb.id);
  }

  function removeBlock(id: string) {
    const idx = blocks.findIndex((b) => b.id === id);
    if (blocks.length === 1) {
      commit([{ id: uuid(), type: "paragraph", text: "" }]);
      return;
    }
    const next = blocks.filter((b) => b.id !== id);
    commit(next);
    const prev = next[Math.max(0, idx - 1)];
    if (prev) {
      setEditingId(prev.id);
      setFocusId(prev.id);
    }
  }

  return (
    <div
      className="selectable mx-auto max-w-3xl space-y-2.5 text-[15px] leading-7 break-words"
      onClick={() => setSlash(null)}
    >
      {blocks.map((b) => (
        <Row
          key={b.id}
          block={b}
          index={numberFor(blocks, b)}
          editing={editingId === b.id}
          focus={focusId === b.id}
          slashQuery={slash?.id === b.id ? slash.query : null}
          onEdit={() => setEditingId(b.id)}
          onBlur={() => {
            setEditingId((cur) => (cur === b.id ? null : cur));
            setSlash((s) => (s?.id === b.id ? null : s));
          }}
          onText={(text) => {
            update(b.id, { text });
            if (text.startsWith("/") && !MULTILINE.includes(b.type)) {
              setSlash({ id: b.id, query: text.slice(1) });
            } else if (slash?.id === b.id) {
              setSlash(null);
            }
          }}
          onEnter={() => {
            if (LIST_TYPES.includes(b.type) && b.text.trim() === "") {
              convert(b.id, "paragraph");
            } else {
              insertAfter(b.id, LIST_TYPES.includes(b.type) ? b.type : "paragraph");
            }
          }}
          onDeleteEmpty={() => removeBlock(b.id)}
          onToggle={() => update(b.id, { checked: !b.checked })}
          onPick={(type) => convert(b.id, type)}
          clearFocus={() => setFocusId(null)}
        />
      ))}
    </div>
  );
}

function numberFor(blocks: Block[], target: Block): number {
  let n = 0;
  for (const b of blocks) {
    if (b.type === "numbered") n++;
    else n = 0;
    if (b.id === target.id) return n;
  }
  return 1;
}

function Row({
  block,
  index,
  editing,
  focus,
  slashQuery,
  onEdit,
  onBlur,
  onText,
  onEnter,
  onDeleteEmpty,
  onToggle,
  onPick,
  clearFocus,
}: {
  block: Block;
  index: number;
  editing: boolean;
  focus: boolean;
  slashQuery: string | null;
  onEdit: () => void;
  onBlur: () => void;
  onText: (t: string) => void;
  onEnter: () => void;
  onDeleteEmpty: () => void;
  onToggle: () => void;
  onPick: (t: BlockType) => void;
  clearFocus: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focus && ref.current) {
      ref.current.focus();
      const len = ref.current.value.length;
      ref.current.setSelectionRange(len, len);
      clearFocus();
    }
  }, [focus, clearFocus]);

  const filtered = useMemo(
    () =>
      slashQuery === null
        ? []
        : SLASH_ITEMS.filter((i) =>
            i.label.toLowerCase().includes(slashQuery.toLowerCase()),
          ),
    [slashQuery],
  );

  if (block.type === "divider") {
    return <hr className="my-3 border-edge" />;
  }

  if (editing) {
    return (
      <div className="relative">
        <textarea
          ref={ref}
          value={block.text}
          onChange={(e) => {
            onText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onBlur={onBlur}
          onKeyDown={(e) => {
            if (slashQuery !== null && filtered.length && e.key === "Enter") {
              e.preventDefault();
              onPick(filtered[0].type);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !MULTILINE.includes(block.type)) {
              e.preventDefault();
              onEnter();
            }
            if (e.key === "Backspace" && block.text === "") {
              e.preventDefault();
              onDeleteEmpty();
            }
          }}
          rows={MULTILINE.includes(block.type) ? 4 : 1}
          placeholder={block.type === "paragraph" ? "Type / for command menu" : ""}
          className={`w-full resize-none bg-transparent outline-none placeholder:text-ink-faint ${editClass(
            block.type,
          )}`}
          autoFocus
        />
        {slashQuery !== null && filtered.length > 0 && (
          <div className="absolute z-30 mt-1 w-56 rounded-xl border border-edge bg-card p-1 shadow-modal">
            {filtered.map((i) => (
              <button
                key={i.type}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(i.type);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-card-hover"
              >
                <i.icon className="size-4 text-ink-dim" />
                {i.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Read view
  const content = block.text.trim() === "" ? null : block;
  const inner = content ? (
    <span dangerouslySetInnerHTML={{ __html: renderRichInline(block.text) }} />
  ) : (
    <span className="text-ink-faint">
      {block.type === "paragraph" ? "Type / for command menu" : "Empty " + block.type}
    </span>
  );

  const clickToEdit = { onClick: onEdit, className: "cursor-text" };

  switch (block.type) {
    case "heading1":
      return <h1 {...clickToEdit} className="cursor-text pt-4 pb-1 font-display text-3xl font-bold tracking-tight">{inner}</h1>;
    case "heading2":
      return <h2 {...clickToEdit} className="cursor-text pt-4 pb-0.5 font-display text-2xl font-bold tracking-tight">{inner}</h2>;
    case "heading3":
      return <h3 {...clickToEdit} className="cursor-text pt-3 font-display text-lg font-bold">{inner}</h3>;
    case "bullet":
      return (
        <div {...clickToEdit} className="flex cursor-text gap-2.5 pl-1">
          <span className="mt-2 size-1.5 shrink-0 rounded-full bg-ink-faint" />
          <div className="flex-1">{inner}</div>
        </div>
      );
    case "numbered":
      return (
        <div {...clickToEdit} className="flex cursor-text gap-2.5 pl-1">
          <span className="shrink-0 font-semibold text-ink-dim tabular-nums">{index}.</span>
          <div className="flex-1">{inner}</div>
        </div>
      );
    case "todo":
      return (
        <div className="flex items-start gap-2.5 pl-1">
          <input
            type="checkbox"
            checked={!!block.checked}
            onChange={onToggle}
            className="mt-1.5 size-4 shrink-0 accent-[var(--color-accent)]"
          />
          <div
            onClick={onEdit}
            className={`flex-1 cursor-text ${block.checked ? "text-ink-faint line-through" : ""}`}
          >
            {inner}
          </div>
        </div>
      );
    case "quote":
      return (
        <blockquote {...clickToEdit} className="cursor-text border-l-[3px] border-accent/60 pl-4 text-ink-dim italic">
          {inner}
        </blockquote>
      );
    case "callout":
      return (
        <div onClick={onEdit} className="flex cursor-text gap-3 rounded-xl bg-callout-bg px-4 py-3.5">
          <span className="text-lg leading-6">{block.emoji ?? "📌"}</span>
          <div className="flex-1 text-callout-ink">{inner}</div>
        </div>
      );
    case "code":
      return (
        <pre
          onClick={onEdit}
          className="cursor-text overflow-x-auto rounded-xl border border-edge bg-panel p-4 font-mono text-[13px] leading-6"
        >
          <code>{block.text || "code"}</code>
        </pre>
      );
    case "math":
      return (
        <div
          onClick={onEdit}
          className="cursor-text overflow-x-auto py-3 text-center"
          dangerouslySetInnerHTML={{ __html: renderMath(block.text || "x", true) }}
        />
      );
    case "table":
      return (
        <div className="overflow-x-auto">
          <table onClick={onEdit} className="w-full cursor-text border-collapse overflow-hidden rounded-lg text-sm">
            <tbody>
              {(block.rows ?? []).map((row, r) => (
                <tr key={r} className={r === 0 ? "bg-panel" : ""}>
                  {row.map((cell, c) => {
                    const Tag = r === 0 ? "th" : "td";
                    return (
                      <Tag
                        key={c}
                        className={`border border-edge px-3 py-2 text-left ${r === 0 ? "font-semibold" : ""}`}
                        dangerouslySetInnerHTML={{ __html: renderRichInline(cell) }}
                      />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return <p {...clickToEdit} className="cursor-text">{inner}</p>;
  }
}

function editClass(type: BlockType): string {
  switch (type) {
    case "heading1":
      return "font-display text-3xl font-bold";
    case "heading2":
      return "font-display text-2xl font-bold";
    case "heading3":
      return "font-display text-xl font-bold";
    case "code":
      return "font-mono text-sm";
    case "quote":
      return "italic text-ink-dim";
    default:
      return "leading-relaxed";
  }
}
