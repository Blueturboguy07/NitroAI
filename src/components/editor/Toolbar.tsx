import { useState, type ReactNode } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Baseline,
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Bold,
  ChevronDown,
  Code2,
  Highlighter,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Plus,
  Quote,
  Redo2,
  RemoveFormatting,
  Sigma,
  SquareSigma,
  StickyNote,
  Strikethrough,
  Subscript,
  Superscript,
  Table,
  Trash2,
  Underline,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import Popover, { MenuDivider, MenuItem, anchorOf, type Anchor } from "../ui/Popover";
import { HIGHLIGHT_COLORS, TEXT_COLORS, type HighlightColor } from "../../lib/editor/extensions";
import { insertEquation } from "./commands";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl+";

const STYLES = [
  { label: "Normal text", level: 0 },
  { label: "Heading 1", level: 1 },
  { label: "Heading 2", level: 2 },
  { label: "Heading 3", level: 3 },
] as const;

export function ToolButton({
  icon: Icon,
  label,
  shortcut,
  active,
  disabled,
  onClick,
  children,
  style,
}: {
  icon?: LucideIcon;
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children?: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={shortcut ? `${label} (${shortcut})` : label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={style}
      className={`flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded-lg px-1.5 text-ink-dim transition-colors hover:bg-card-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-35 disabled:hover:bg-transparent ${
        active ? "bg-accent-softer text-ink" : ""
      }`}
    >
      {Icon && <Icon className="size-4" />}
      {children}
    </button>
  );
}

function Sep() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-edge" aria-hidden />;
}

export default function Toolbar({
  editor,
  highlighter,
  highlightColor,
  onHighlighter,
  onHighlightColor,
  onLink,
}: {
  editor: Editor;
  highlighter: boolean;
  highlightColor: HighlightColor;
  onHighlighter: (on: boolean) => void;
  onHighlightColor: (c: HighlightColor) => void;
  onLink: (anchor: Anchor) => void;
}) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
      level: ([1, 2, 3] as const).find((l) => e.isActive("heading", { level: l })) ?? 0,
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      color: (e.getAttributes("textStyle").color as string | undefined) ?? null,
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      task: e.isActive("taskList"),
      align: (["center", "right", "justify"] as const).find((a) => e.isActive({ textAlign: a })) ?? "left",
      link: e.isActive("link"),
      sup: e.isActive("superscript"),
      sub: e.isActive("subscript"),
      table: e.isActive("table"),
    }),
  });

  const [menu, setMenu] = useState<{ kind: "style" | "color" | "hl" | "align" | "insert"; anchor: Anchor } | null>(
    null,
  );
  const open = (kind: NonNullable<typeof menu>["kind"]) => (e: React.MouseEvent<HTMLButtonElement>) => {
    const a = anchorOf(e.currentTarget);
    if (a) setMenu((m) => (m?.kind === kind ? null : { kind, anchor: a }));
  };
  const close = () => setMenu(null);
  const chain = () => editor.chain().focus();

  const AlignIcon: LucideIcon =
    s.align === "center" ? AlignCenter : s.align === "right" ? AlignRight : s.align === "justify" ? AlignJustify : AlignLeft;
  const hlSwatch = `var(--hl-${highlightColor})`;

  return (
    <div className="@container border-b border-edge">
      <div
        role="toolbar"
        aria-label="Formatting"
        className="flex flex-wrap items-center gap-0.5 px-3 py-1.5"
      >
        <ToolButton icon={Undo2} label="Undo" shortcut={`${MOD}Z`} disabled={!s.canUndo} onClick={() => chain().undo().run()} />
        <ToolButton icon={Redo2} label="Redo" shortcut={`${MOD}Shift+Z`} disabled={!s.canRedo} onClick={() => chain().redo().run()} />
        <Sep />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={open("style")}
          aria-haspopup="menu"
          aria-expanded={menu?.kind === "style"}
          className="flex h-8 w-[118px] shrink-0 items-center justify-between rounded-lg px-2 text-sm font-semibold text-ink hover:bg-card-hover"
        >
          {STYLES[s.level].label}
          <ChevronDown className="size-3.5 text-ink-faint" />
        </button>
        <Sep />
        <ToolButton icon={Bold} label="Bold" shortcut={`${MOD}B`} active={s.bold} onClick={() => chain().toggleBold().run()} />
        <ToolButton icon={Italic} label="Italic" shortcut={`${MOD}I`} active={s.italic} onClick={() => chain().toggleItalic().run()} />
        <ToolButton icon={Underline} label="Underline" shortcut={`${MOD}U`} active={s.underline} onClick={() => chain().toggleUnderline().run()} />
        <ToolButton icon={Strikethrough} label="Strikethrough" shortcut={`${MOD}Shift+S`} active={s.strike} onClick={() => chain().toggleStrike().run()} />
        <ToolButton label="Text colour" onClick={open("color")}>
          <span className="flex flex-col items-center">
            <Baseline className="size-4" />
            <span className="-mt-0.5 h-[3px] w-4 rounded-full" style={{ background: s.color ?? "var(--color-ink)" }} />
          </span>
        </ToolButton>

        {/* Highlighter: the pen toggles "highlight as you select"; the
            chevron picks the colour. */}
        <span className="flex shrink-0 items-center rounded-lg" style={highlighter ? { background: hlSwatch } : undefined}>
          <ToolButton
            label={highlighter ? "Stop highlighting" : "Highlighter: select text to highlight it"}
            active={false}
            onClick={() => onHighlighter(!highlighter)}
          >
            <span className="flex flex-col items-center">
              <Highlighter className={`size-4 ${highlighter ? "text-ink" : ""}`} />
              <span className="-mt-0.5 h-[3px] w-4 rounded-full" style={{ background: hlSwatch }} />
            </span>
          </ToolButton>
          <ToolButton label="Highlight colour" onClick={open("hl")}>
            <ChevronDown className="size-3" />
          </ToolButton>
        </span>
        <Sep />
        <ToolButton icon={List} label="Bulleted list" shortcut={`${MOD}Shift+8`} active={s.bullet} onClick={() => chain().toggleBulletList().run()} />
        <ToolButton icon={ListOrdered} label="Numbered list" shortcut={`${MOD}Shift+7`} active={s.ordered} onClick={() => chain().toggleOrderedList().run()} />
        <ToolButton icon={ListTodo} label="Checklist" shortcut={`${MOD}Shift+9`} active={s.task} onClick={() => chain().toggleTaskList().run()} />
        <ToolButton label="Alignment" onClick={open("align")}>
          <AlignIcon className="size-4" />
          <ChevronDown className="size-3" />
        </ToolButton>
        <Sep />
        <ToolButton
          icon={Link2}
          label="Link"
          shortcut={`${MOD}K`}
          active={s.link}
          onClick={(e) => {
            const a = anchorOf(e.currentTarget);
            if (a) onLink(a);
          }}
        />
        <ToolButton icon={Sigma} label="Equation" shortcut={`${MOD}Shift+E`} onClick={() => insertEquation(editor, false)}>
          <span className="hidden pr-0.5 text-[13px] font-semibold @min-[58rem]:inline">Equation</span>
        </ToolButton>
        <ToolButton label="Insert" onClick={open("insert")}>
          <Plus className="size-4" />
          <span className="hidden text-[13px] font-semibold @min-[58rem]:inline">Insert</span>
          <ChevronDown className="size-3" />
        </ToolButton>
        <Sep />
        <ToolButton icon={Superscript} label="Superscript" shortcut={`${MOD}.`} active={s.sup} onClick={() => chain().toggleSuperscript().run()} />
        <ToolButton icon={Subscript} label="Subscript" shortcut={`${MOD},`} active={s.sub} onClick={() => chain().toggleSubscript().run()} />
        <ToolButton icon={RemoveFormatting} label="Clear formatting" onClick={() => chain().unsetAllMarks().clearNodes().run()} />
      </div>

      {s.table && (
        <div className="flex flex-wrap items-center gap-0.5 border-t border-edge bg-panel px-3 py-1" role="toolbar" aria-label="Table">
          <span className="mr-1 text-xs font-semibold text-ink-faint">Table</span>
          <ToolButton icon={BetweenHorizontalStart} label="Insert row above" onClick={() => chain().addRowBefore().run()} />
          <ToolButton icon={BetweenHorizontalEnd} label="Insert row below" onClick={() => chain().addRowAfter().run()} />
          <ToolButton icon={BetweenVerticalStart} label="Insert column left" onClick={() => chain().addColumnBefore().run()} />
          <ToolButton icon={BetweenVerticalEnd} label="Insert column right" onClick={() => chain().addColumnAfter().run()} />
          <Sep />
          <ToolButton label="Delete row" onClick={() => chain().deleteRow().run()}>
            <span className="px-1 text-xs font-semibold">Delete row</span>
          </ToolButton>
          <ToolButton label="Delete column" onClick={() => chain().deleteColumn().run()}>
            <span className="px-1 text-xs font-semibold">Delete column</span>
          </ToolButton>
          <ToolButton label="Header row" onClick={() => chain().toggleHeaderRow().run()}>
            <span className="px-1 text-xs font-semibold">Header row</span>
          </ToolButton>
          <ToolButton icon={Trash2} label="Delete table" onClick={() => chain().deleteTable().run()} />
        </div>
      )}

      {menu?.kind === "style" && (
        <Popover anchor={menu.anchor} onClose={close} className="w-48 p-1" role="menu">
          {STYLES.map((st) => (
            <MenuItem
              key={st.level}
              active={s.level === st.level}
              onSelect={() => {
                if (st.level === 0) chain().setParagraph().run();
                else chain().setHeading({ level: st.level }).run();
                close();
              }}
            >
              <span
                className={
                  st.level === 1
                    ? "font-display text-xl font-bold"
                    : st.level === 2
                      ? "font-display text-lg font-bold"
                      : st.level === 3
                        ? "font-display font-bold"
                        : ""
                }
              >
                {st.label}
              </span>
            </MenuItem>
          ))}
        </Popover>
      )}

      {menu?.kind === "color" && (
        <Popover anchor={menu.anchor} onClose={close} className="p-2" label="Text colour">
          <div className="flex items-center gap-1.5">
            {TEXT_COLORS.map((c) => (
              <button
                key={c.value}
                aria-label={c.label}
                title={c.label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  chain().setColor(c.value).run();
                  close();
                }}
                className={`size-6 rounded-full ring-offset-2 ring-offset-card hover:ring-2 hover:ring-edge ${
                  s.color === c.value ? "ring-2 ring-accent" : ""
                }`}
                style={{ background: c.value }}
              />
            ))}
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                chain().unsetColor().run();
                close();
              }}
              className="ml-1 rounded-md px-2 py-1 text-xs font-semibold text-ink-dim hover:bg-card-hover"
            >
              Default
            </button>
          </div>
        </Popover>
      )}

      {menu?.kind === "hl" && (
        <Popover anchor={menu.anchor} onClose={close} className="w-56 p-2" label="Highlight colour">
          <div className="flex items-center gap-1.5">
            {HIGHLIGHT_COLORS.map((c) => (
              <button
                key={c.key}
                aria-label={`${c.label} highlight`}
                title={c.label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onHighlightColor(c.key);
                  if (!editor.state.selection.empty) chain().setHighlight({ color: c.key }).run();
                  close();
                }}
                className={`size-6 rounded-full border border-black/5 ring-offset-2 ring-offset-card hover:ring-2 hover:ring-edge ${
                  highlightColor === c.key ? "ring-2 ring-accent" : ""
                }`}
                style={{ background: `var(--hl-${c.key})` }}
              />
            ))}
          </div>
          <MenuDivider />
          <MenuItem
            onSelect={() => {
              chain().unsetHighlight().run();
              close();
            }}
          >
            Remove highlight from selection
          </MenuItem>
        </Popover>
      )}

      {menu?.kind === "align" && (
        <Popover anchor={menu.anchor} onClose={close} className="w-44 p-1" role="menu">
          {(
            [
              ["left", "Left", AlignLeft],
              ["center", "Center", AlignCenter],
              ["right", "Right", AlignRight],
              ["justify", "Justify", AlignJustify],
            ] as const
          ).map(([value, label, Icon]) => (
            <MenuItem
              key={value}
              icon={Icon}
              active={s.align === value}
              onSelect={() => {
                chain().setTextAlign(value).run();
                close();
              }}
            >
              {label}
            </MenuItem>
          ))}
        </Popover>
      )}

      {menu?.kind === "insert" && (
        <Popover anchor={menu.anchor} onClose={close} className="w-56 p-1" role="menu">
          <MenuItem icon={SquareSigma} hint="$$ space" onSelect={() => { close(); insertEquation(editor, true); }}>
            Equation on its own line
          </MenuItem>
          <MenuItem icon={Table} onSelect={() => { chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); close(); }}>
            Table
          </MenuItem>
          <MenuItem icon={StickyNote} onSelect={() => { chain().setNode("callout").run(); close(); }}>
            Callout
          </MenuItem>
          <MenuItem icon={Quote} hint="> space" onSelect={() => { chain().toggleBlockquote().run(); close(); }}>
            Quote
          </MenuItem>
          <MenuItem icon={Code2} hint="```" onSelect={() => { chain().toggleCodeBlock().run(); close(); }}>
            Code block
          </MenuItem>
          <MenuItem icon={Minus} hint="---" onSelect={() => { chain().setHorizontalRule().run(); close(); }}>
            Divider
          </MenuItem>
        </Popover>
      )}
    </div>
  );
}
