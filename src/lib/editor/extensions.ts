/* Tiptap schema for the note editor. Equations are atom nodes: they always
   render with KaTeX and are edited in a popover (see MathPopover), so
   selecting or clicking a sentence never drops it back to raw LaTeX. */

import { InputRule, Node, mergeAttributes, type AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import { Color, TextStyle } from "@tiptap/extension-text-style";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Placeholder } from "@tiptap/extensions";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import katex from "katex";

/* Fired on the editor DOM when an equation is clicked or inserted; the
   editor component listens and opens the equation popover for `pos`. */
export const MATH_EDIT_EVENT = "nitro:math-edit";
export interface MathEditDetail {
  pos: number;
}

export const HIGHLIGHT_COLORS = [
  { key: "yellow", label: "Yellow" },
  { key: "green", label: "Green" },
  { key: "blue", label: "Blue" },
  { key: "pink", label: "Pink" },
  { key: "orange", label: "Orange" },
  { key: "purple", label: "Purple" },
] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number]["key"];

/* Mid-tone text colours that stay readable on both themes. */
export const TEXT_COLORS = [
  { value: "#dc2626", label: "Red" },
  { value: "#ea580c", label: "Orange" },
  { value: "#16a34a", label: "Green" },
  { value: "#2563eb", label: "Blue" },
  { value: "#7c3aed", label: "Purple" },
  { value: "#71717a", label: "Grey" },
] as const;

function renderLatex(el: HTMLElement, latex: string, display: boolean) {
  if (!latex.trim()) {
    el.textContent = display ? "Empty equation" : "?";
    el.classList.add("is-blank");
    return;
  }
  el.classList.remove("is-blank");
  try {
    katex.render(latex, el, { throwOnError: false, displayMode: display });
  } catch {
    el.textContent = latex;
  }
}

function makeMathNode(name: "inlineMath" | "blockMath", display: boolean) {
  const dataType = display ? "block-math" : "inline-math";
  return Node.create({
    name,
    group: display ? "block" : "inline",
    inline: !display,
    atom: true,
    selectable: true,
    draggable: false,

    addAttributes() {
      return {
        latex: {
          default: "",
          parseHTML: (el) => el.getAttribute("data-latex") ?? "",
          renderHTML: (attrs) => ({ "data-latex": attrs.latex }),
        },
      };
    },

    parseHTML() {
      return [{ tag: `${display ? "div" : "span"}[data-type="${dataType}"]` }];
    },

    renderHTML({ HTMLAttributes, node }) {
      return [
        display ? "div" : "span",
        mergeAttributes(HTMLAttributes, { "data-type": dataType }),
        node.attrs.latex as string,
      ];
    },

    renderText({ node }) {
      return display ? `$$${node.attrs.latex}$$` : `$${node.attrs.latex}$`;
    },

    addNodeView() {
      return ({ node: initial, getPos, editor }) => {
        let node = initial;
        const dom = document.createElement(display ? "div" : "span");
        dom.className = `nitro-math ${display ? "nitro-math-block" : "nitro-math-inline"}`;
        dom.contentEditable = "false";
        dom.title = "Click to edit equation";
        renderLatex(dom, node.attrs.latex, display);

        dom.addEventListener("click", () => {
          const pos = getPos();
          if (typeof pos !== "number" || !editor.isEditable) return;
          editor.commands.setNodeSelection(pos);
          editor.view.dom.dispatchEvent(
            new CustomEvent<MathEditDetail>(MATH_EDIT_EVENT, { detail: { pos } }),
          );
        });

        return {
          dom,
          update(next) {
            if (next.type !== node.type) return false;
            if (next.attrs.latex !== node.attrs.latex) {
              renderLatex(dom, next.attrs.latex, display);
            }
            node = next;
            return true;
          },
          selectNode: () => dom.classList.add("is-selected"),
          deselectNode: () => dom.classList.remove("is-selected"),
          ignoreMutation: () => true,
        };
      };
    },

    addKeyboardShortcuts() {
      return {
        // Enter on a selected equation opens its editor instead of replacing it.
        Enter: ({ editor }) => {
          const { selection } = editor.state;
          const selected = (selection as { node?: { type: { name: string } } }).node;
          if (selected?.type.name !== name) return false;
          editor.view.dom.dispatchEvent(
            new CustomEvent<MathEditDetail>(MATH_EDIT_EVENT, {
              detail: { pos: selection.from },
            }),
          );
          return true;
        },
      };
    },

    addInputRules() {
      if (display) {
        // "$$ " at the start of an empty line starts an equation block.
        return [
          new InputRule({
            find: /^\$\$\s$/,
            handler: ({ state, range, chain }) => {
              const $from = state.doc.resolve(range.from);
              // Only on an otherwise empty line, so text after the caret is never lost.
              if (!/^\$\$\s?$/.test($from.parent.textContent)) return null;
              const start = $from.before();
              const end = $from.after();
              chain()
                .deleteRange({ from: start, to: end })
                .insertContentAt(start, { type: name, attrs: { latex: "" } })
                .setNodeSelection(start)
                .run();
              queueMicrotask(() =>
                this.editor.view.dom.dispatchEvent(
                  new CustomEvent<MathEditDetail>(MATH_EDIT_EVENT, { detail: { pos: start } }),
                ),
              );
            },
          }),
        ];
      }
      // $x^2$ typed inline becomes a rendered equation. No space just inside
      // the dollars, so prices like "$5 and $10" are left alone.
      return [
        new InputRule({
          find: /(?:^|[^$\\])(\$([^\s$](?:[^$\n]*?[^\s$])?)\$)$/,
          handler: ({ state, range, match }) => {
            // range.from is where match[0] starts; skip the one-char prefix
            // the regex used to check the opening "$" isn't escaped.
            const from = range.from + (match[0].length - match[1].length);
            state.tr.replaceWith(from, range.to, this.type.create({ latex: match[2] }));
          },
        }),
      ];
    },
  });
}

export const InlineMath = makeMathNode("inlineMath", false);
export const BlockMath = makeMathNode("blockMath", true);

/* Callout: one line of inline content with an emoji marker. */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "inline*",
  defining: true,

  addAttributes() {
    return {
      emoji: {
        default: "📌",
        parseHTML: (el) => el.getAttribute("data-emoji") || "📌",
        renderHTML: (attrs) => ({ "data-emoji": attrs.emoji }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "callout" }), 0];
  },
});

/* Highlights store a colour key ("yellow"), not a hex value, so the theme
   decides the actual shade and dark mode stays readable. */
export const Highlighter = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: "yellow",
        parseHTML: (el) => el.getAttribute("data-color") || "yellow",
        renderHTML: (attrs) => ({ "data-color": attrs.color }),
      },
    };
  },
}).configure({ multicolor: true });

export function editorExtensions(opts: { placeholder?: string } = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
      },
    }),
    Highlighter,
    TextStyle,
    Color,
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Subscript,
    Superscript,
    Callout,
    InlineMath,
    BlockMath,
    Placeholder.configure({
      placeholder: ({ node }) =>
        node.type.name === "heading"
          ? "Heading"
          : (opts.placeholder ?? "Type / for commands, or just start writing"),
    }),
  ];
}
