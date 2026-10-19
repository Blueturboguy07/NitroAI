import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EditorContent,
  getTextBetween,
  getTextSerializersFromSchema,
  useEditor,
  type Editor,
} from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  Bold,
  Code2,
  Eraser,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Sigma,
  Sparkles,
  SquareSigma,
  StickyNote,
  Table,
  Text as TextIcon,
  Underline,
  type LucideIcon,
} from "lucide-react";
import {
  HIGHLIGHT_COLORS,
  MATH_EDIT_EVENT,
  editorExtensions,
  type HighlightColor,
  type MathEditDetail,
} from "../../lib/editor/extensions";
import { blocksToEditorHtml, docToBlocks } from "../../lib/editor/convert";
import { decideHighlight } from "../../lib/editor/highlighter";
import type { Block, EditorDoc, Note } from "../../lib/types";
import Popover, { MenuItem, anchorOf, type Anchor } from "../ui/Popover";
import Toolbar, { MOD, ToolButton } from "./Toolbar";
import MathPopover from "./MathPopover";
import { insertEquation } from "./commands";

/* Word/Docs-style editor for a note. The document (Tiptap JSON) is saved
   600ms after the last change, and on leaving the page, together with the
   Block[] derived from it. */

const HL_KEY = "nitroai.highlightColor";
const SAVE_DELAY = 600;

function loadHighlightColor(): HighlightColor {
  try {
    const v = localStorage.getItem(HL_KEY);
    if (HIGHLIGHT_COLORS.some((c) => c.key === v)) return v as HighlightColor;
  } catch {
    /* storage unavailable */
  }
  return "yellow";
}

interface SlashItem {
  label: string;
  icon: LucideIcon;
  keywords: string;
  run: (editor: Editor) => void;
}

const SLASH_ITEMS: SlashItem[] = [
  { label: "Text", icon: TextIcon, keywords: "paragraph normal", run: (e) => e.chain().focus().setParagraph().run() },
  { label: "Heading 1", icon: Heading1, keywords: "title h1", run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
  { label: "Heading 2", icon: Heading2, keywords: "subtitle h2", run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
  { label: "Heading 3", icon: Heading3, keywords: "h3", run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
  { label: "Bulleted list", icon: List, keywords: "ul bullet", run: (e) => e.chain().focus().toggleBulletList().run() },
  { label: "Numbered list", icon: ListOrdered, keywords: "ol ordered", run: (e) => e.chain().focus().toggleOrderedList().run() },
  { label: "Checklist", icon: ListTodo, keywords: "todo task checkbox", run: (e) => e.chain().focus().toggleTaskList().run() },
  { label: "Equation", icon: Sigma, keywords: "math latex inline formula", run: (e) => insertEquation(e, false) },
  { label: "Equation on its own line", icon: SquareSigma, keywords: "math latex block display formula", run: (e) => insertEquation(e, true) },
  { label: "Table", icon: Table, keywords: "grid", run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { label: "Callout", icon: StickyNote, keywords: "note tip box", run: (e) => e.chain().focus().setNode("callout").run() },
  { label: "Quote", icon: Quote, keywords: "blockquote", run: (e) => e.chain().focus().toggleBlockquote().run() },
  { label: "Code block", icon: Code2, keywords: "pre monospace", run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { label: "Divider", icon: Minus, keywords: "hr line rule", run: (e) => e.chain().focus().setHorizontalRule().run() },
];

function filterSlash(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((i) => `${i.label} ${i.keywords}`.toLowerCase().includes(q));
}

/* Plain text of the current selection, with equations written as $latex$. */
function selectedText(editor: Editor): string {
  const { from, to } = editor.state.selection;
  return getTextBetween(editor.state.doc, { from, to }, {
    blockSeparator: "\n",
    textSerializers: getTextSerializersFromSchema(editor.schema),
  }).trim();
}

/* Highlight colour of each text run in the current selection. */
function selectionRuns(editor: Editor): (string | null)[] {
  const { from, to } = editor.state.selection;
  const runs: (string | null)[] = [];
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText && node.type.name !== "inlineMath") return true;
    const mark = node.marks.find((m) => m.type.name === "highlight");
    runs.push(mark ? ((mark.attrs.color as string) ?? "yellow") : null);
    return false;
  });
  return runs;
}

export default function DocEditor({
  note,
  onSave,
  onAskAI,
}: {
  note: Note;
  onSave: (doc: EditorDoc, blocks: Block[]) => void;
  /* Called with the selected text when the user asks the assistant about it. */
  onAskAI?: (text: string) => void;
}) {
  const [highlighter, setHighlighter] = useState(false);
  const [hlColor, setHlColor] = useState<HighlightColor>(loadHighlightColor);
  const [math, setMath] = useState<{ pos: number; anchor: Anchor } | null>(null);
  const [link, setLink] = useState<{ anchor: Anchor; href: string } | null>(null);
  const [slash, setSlash] = useState<{ query: string; from: number; to: number; anchor: Anchor; index: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [words, setWords] = useState(0);

  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onAskAIRef = useRef(onAskAI);
  onAskAIRef.current = onAskAI;
  const highlighterRef = useRef(highlighter);
  highlighterRef.current = highlighter;
  const hlColorRef = useRef(hlColor);
  hlColorRef.current = hlColor;
  const slashRef = useRef(slash);
  slashRef.current = slash;
  const slashDismissed = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const editorRef = useRef<Editor | null>(null);

  const extensions = useMemo(() => editorExtensions(), []);

  const countWords = useCallback((e: Editor) => {
    const text = e.state.doc.textBetween(0, e.state.doc.content.size, " ", " ");
    setWords(text.split(/\s+/).filter(Boolean).length);
  }, []);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const e = editorRef.current;
    if (!dirty.current || !e || e.isDestroyed) return;
    dirty.current = false;
    const json = e.getJSON();
    onSaveRef.current(json as EditorDoc, docToBlocks(json));
    countWords(e);
    setSaving(false);
  }, [countWords]);

  const updateSlash = useCallback((e: Editor) => {
    const { selection } = e.state;
    const $from = selection.$from;
    const text =
      selection.empty && $from.parent.type.name === "paragraph"
        ? $from.parent.textBetween(0, $from.parentOffset, undefined, "￼")
        : "";
    const m = /^\/([\w ]{0,24})$/.exec(text);
    if (!m) {
      slashDismissed.current = null;
      if (slashRef.current) setSlash(null);
      return;
    }
    const from = $from.start();
    if (slashDismissed.current === from) return;
    const c = e.view.coordsAtPos($from.pos);
    setSlash((prev) => ({
      query: m[1],
      from,
      to: $from.pos,
      anchor: { left: c.left, top: c.top, bottom: c.bottom },
      index: prev && prev.query === m[1] ? prev.index : 0,
    }));
  }, []);

  function runSlash(item: SlashItem) {
    const e = editorRef.current;
    const s = slashRef.current;
    if (!e || !s) return;
    e.chain().focus().deleteRange({ from: s.from, to: s.to }).run();
    setSlash(null);
    item.run(e);
  }

  function askAI() {
    const e = editorRef.current;
    const ask = onAskAIRef.current;
    if (!e || !ask || e.state.selection.empty) return false;
    const text = selectedText(e);
    if (!text) return false;
    // Collapse the selection so the bubble menu closes while the chat takes over.
    e.commands.setTextSelection(e.state.selection.to);
    ask(text);
    return true;
  }

  function openLink(anchor?: Anchor) {
    const e = editorRef.current;
    if (!e) return;
    let a = anchor;
    if (!a) {
      const c = e.view.coordsAtPos(e.state.selection.from);
      a = { left: c.left, top: c.top, bottom: c.bottom };
    }
    setLink({ anchor: a, href: (e.getAttributes("link").href as string) ?? "" });
  }

  const editor = useEditor({
    extensions,
    content: note.doc ?? blocksToEditorHtml(note.blocks),
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: "nitro-doc",
        spellcheck: "true",
        "aria-label": "Document",
      },
      handleKeyDown: (_view, event) => {
        const e = editorRef.current;
        if (!e) return false;
        const s = slashRef.current;
        if (s) {
          const items = filterSlash(s.query);
          if (items.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            const step = event.key === "ArrowDown" ? 1 : -1;
            setSlash({ ...s, index: (s.index + step + items.length) % items.length });
            return true;
          }
          if (items.length && (event.key === "Enter" || event.key === "Tab")) {
            runSlash(items[Math.min(s.index, items.length - 1)]);
            return true;
          }
        }
        const mod = event.metaKey || event.ctrlKey;
        if (mod && event.shiftKey && event.key.toLowerCase() === "e") {
          insertEquation(e, false);
          return true;
        }
        if (mod && !event.shiftKey && event.key.toLowerCase() === "k") {
          openLink();
          return true;
        }
        if (mod && !event.shiftKey && event.key.toLowerCase() === "j") {
          return askAI();
        }
        if (event.key === "Escape" && highlighterRef.current) {
          setHighlighter(false);
          return true;
        }
        return false;
      },
      handleClick: (_view, _pos, event) => {
        const a = (event.target as HTMLElement).closest("a");
        if (a && (event.metaKey || event.ctrlKey)) {
          window.open(a.href, "_blank", "noopener");
          return true;
        }
        return false;
      },
    },
    onCreate: ({ editor: e }) => {
      editorRef.current = e;
      countWords(e);
    },
    onUpdate: ({ editor: e }) => {
      dirty.current = true;
      setSaving(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY);
      updateSlash(e);
    },
    onSelectionUpdate: ({ editor: e }) => updateSlash(e),
  });
  editorRef.current = editor;

  // Save whatever is pending when leaving the note or hiding the window.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, [flush]);

  // Equation clicks (and new equations) open the popover under the equation.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onEdit = (ev: Event) => {
      const { pos } = (ev as CustomEvent<MathEditDetail>).detail;
      const el = editor.view.nodeDOM(pos) as HTMLElement | null;
      const anchor = anchorOf(el);
      if (anchor) setMath({ pos, anchor });
    };
    dom.addEventListener(MATH_EDIT_EVENT, onEdit);
    return () => dom.removeEventListener(MATH_EDIT_EVENT, onEdit);
  }, [editor]);

  // Highlighter pen: lifting the mouse after a selection applies the pen.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    let pressed = false;
    const onDown = () => {
      pressed = highlighterRef.current;
    };
    const onUp = () => {
      if (!pressed) return;
      pressed = false;
      requestAnimationFrame(() => {
        if (editor.isDestroyed || editor.state.selection.empty) return;
        const action = decideHighlight(selectionRuns(editor), hlColorRef.current);
        const { to } = editor.state.selection;
        const chain = editor.chain();
        if (action.kind === "set") chain.setHighlight({ color: action.color });
        else if (action.kind === "unset") chain.unsetHighlight();
        chain.setTextSelection(to).run();
      });
    };
    dom.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    return () => {
      dom.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
    };
  }, [editor]);

  function pickHighlightColor(c: HighlightColor) {
    setHlColor(c);
    try {
      localStorage.setItem(HL_KEY, c);
    } catch {
      /* storage unavailable */
    }
  }

  if (!editor) return null;
  const slashItems = slash ? filterSlash(slash.query) : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        editor={editor}
        highlighter={highlighter}
        highlightColor={hlColor}
        onHighlighter={setHighlighter}
        onHighlightColor={pickHighlightColor}
        onLink={openLink}
      />

      <div
        className={`selectable min-h-0 flex-1 overflow-y-auto ${highlighter ? "nitro-highlighting" : ""}`}
        style={{ ["--hl-active" as string]: `var(--hl-${hlColor})` }}
        onMouseDown={(e) => {
          // Clicking the empty page area below the text puts the caret at the end.
          if (e.target === e.currentTarget) {
            e.preventDefault();
            editor.commands.focus("end");
          }
        }}
      >
        <div className="mx-auto max-w-3xl px-6 py-8 sm:px-12">
          <EditorContent editor={editor} />
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-edge px-4 py-1.5 text-xs text-ink-faint">
        <span className="tabular-nums">{words.toLocaleString()} {words === 1 ? "word" : "words"}</span>
        {highlighter && (
          <span className="flex items-center gap-1.5 text-ink-dim">
            <span className="size-2.5 rounded-full" style={{ background: `var(--hl-${hlColor})` }} />
            Highlighter on: select text to highlight it, select it again to erase. Esc to stop.
          </span>
        )}
        <span className="ml-auto" aria-live="polite">
          {saving ? "Saving…" : "Saved"}
        </span>
      </div>

      <BubbleMenu
        editor={editor}
        options={{ placement: "top", offset: 8 }}
        shouldShow={({ editor: e, state }) => {
          const sel = state.selection;
          return (
            e.isEditable &&
            !highlighterRef.current &&
            !sel.empty &&
            !(sel as { node?: unknown }).node &&
            !e.isActive("codeBlock")
          );
        }}
        className="flex items-center gap-0.5 rounded-xl border border-edge bg-card p-1 shadow-modal"
      >
        {onAskAI && (
          <>
            <button
              type="button"
              title={`Ask AI about the selection (${MOD}J)`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={askAI}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 font-display text-sm font-bold text-accent transition-colors hover:bg-accent-softer focus-visible:outline-2 focus-visible:outline-accent"
            >
              <Sparkles className="size-4" />
              Ask AI
            </button>
            <span className="mx-0.5 h-5 w-px bg-edge" aria-hidden />
          </>
        )}
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c.key}
            aria-label={`Highlight ${c.label.toLowerCase()}`}
            title={`Highlight ${c.label.toLowerCase()}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              pickHighlightColor(c.key);
              editor.chain().focus().setHighlight({ color: c.key }).run();
            }}
            className="mx-0.5 size-5 rounded-full border border-black/10 hover:scale-110"
            style={{ background: `var(--hl-${c.key})` }}
          />
        ))}
        <ToolButton icon={Eraser} label="Remove highlight" onClick={() => editor.chain().focus().unsetHighlight().run()} />
        <span className="mx-0.5 h-5 w-px bg-edge" aria-hidden />
        <ToolButton icon={Bold} label="Bold" shortcut={`${MOD}B`} onClick={() => editor.chain().focus().toggleBold().run()} />
        <ToolButton icon={Italic} label="Italic" shortcut={`${MOD}I`} onClick={() => editor.chain().focus().toggleItalic().run()} />
        <ToolButton icon={Underline} label="Underline" shortcut={`${MOD}U`} onClick={() => editor.chain().focus().toggleUnderline().run()} />
        <ToolButton icon={Link2} label="Link" shortcut={`${MOD}K`} onClick={() => openLink()} />
        <ToolButton icon={Sigma} label="Turn into equation" shortcut={`${MOD}Shift+E`} onClick={() => insertEquation(editor, false)} />
      </BubbleMenu>

      {math && (
        <MathPopover
          key={math.pos}
          editor={editor}
          pos={math.pos}
          anchor={math.anchor}
          onClose={() => setMath(null)}
        />
      )}

      {slash && slashItems.length > 0 && (
        <Popover
          anchor={slash.anchor}
          onClose={() => {
            slashDismissed.current = slash.from;
            setSlash(null);
          }}
          className="max-h-80 w-60 overflow-y-auto p-1"
          role="menu"
          label="Insert block"
        >
          {slashItems.map((item, i) => (
            <MenuItem
              key={item.label}
              icon={item.icon}
              active={i === Math.min(slash.index, slashItems.length - 1)}
              onSelect={() => runSlash(item)}
            >
              {item.label}
            </MenuItem>
          ))}
        </Popover>
      )}

      {link && (
        <LinkPopover
          anchor={link.anchor}
          initial={link.href}
          onClose={() => setLink(null)}
          onApply={(href) => {
            const chain = editor.chain().focus().extendMarkRange("link");
            if (!href) chain.unsetLink().run();
            else if (editor.state.selection.empty && !editor.isActive("link")) {
              chain.insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
            } else chain.setLink({ href }).run();
            setLink(null);
          }}
        />
      )}
    </div>
  );
}

function LinkPopover({
  anchor,
  initial,
  onApply,
  onClose,
}: {
  anchor: Anchor;
  initial: string;
  onApply: (href: string) => void;
  onClose: () => void;
}) {
  const [href, setHref] = useState(initial);
  const normalized = href.trim() && !/^[a-z]+:/i.test(href.trim()) ? `https://${href.trim()}` : href.trim();
  return (
    <Popover anchor={anchor} onClose={onClose} className="w-80 p-2" label="Link">
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          onApply(normalized);
        }}
      >
        <input
          autoFocus
          value={href}
          onChange={(e) => setHref(e.target.value)}
          placeholder="Paste or type a link"
          aria-label="Link address"
          className="min-w-0 flex-1 rounded-lg border border-edge bg-panel px-2.5 py-1.5 text-sm outline-none placeholder:text-ink-faint focus:border-accent"
        />
        <button type="submit" className="rounded-lg bg-accent px-3 py-1.5 font-display text-sm font-bold text-white hover:bg-accent-hover">
          Apply
        </button>
      </form>
      {initial && (
        <div className="mt-1.5 flex gap-1">
          <button
            onClick={() => window.open(initial, "_blank", "noopener")}
            className="rounded-md px-2 py-1 text-xs font-semibold text-ink-dim hover:bg-card-hover"
          >
            Open link
          </button>
          <button
            onClick={() => onApply("")}
            className="rounded-md px-2 py-1 text-xs font-semibold text-danger-ink hover:bg-danger-soft"
          >
            Remove link
          </button>
        </div>
      )}
    </Popover>
  );
}
