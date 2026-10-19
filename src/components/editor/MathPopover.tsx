import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import katex from "katex";
import { Trash2 } from "lucide-react";
import Popover, { type Anchor } from "../ui/Popover";

/* The equation editor: LaTeX field, live preview, and a symbol palette. The
   equation in the document stays rendered the whole time; changes are written
   back on Done / Enter / clicking away, and Escape cancels. */

/* "‸" marks where the caret lands after inserting a snippet. */
const PALETTE: { name: string; items: [label: string, snippet: string][] }[] = [
  {
    name: "Basic",
    items: [
      ["\\frac{a}{b}", "\\frac{‸}{}"],
      ["x^{n}", "^{‸}"],
      ["x_{i}", "_{‸}"],
      ["\\sqrt{x}", "\\sqrt{‸}"],
      ["\\sqrt[n]{x}", "\\sqrt[‸]{}"],
      ["\\pm", "\\pm "],
      ["\\times", "\\times "],
      ["\\div", "\\div "],
      ["\\cdot", "\\cdot "],
      ["\\neq", "\\neq "],
      ["\\approx", "\\approx "],
      ["\\infty", "\\infty "],
      ["\\left( x \\right)", "\\left( ‸ \\right)"],
      ["|x|", "\\left| ‸ \\right|"],
      ["\\text{abc}", "\\text{‸}"],
      ["^\\circ", "^\\circ "],
    ],
  },
  {
    name: "Greek",
    items: [
      "alpha", "beta", "gamma", "delta", "epsilon", "theta", "lambda", "mu",
      "pi", "rho", "sigma", "tau", "phi", "omega", "Delta", "Sigma", "Omega", "Phi",
    ].map((g) => [`\\${g}`, `\\${g} `] as [string, string]),
  },
  {
    name: "Calculus",
    items: [
      ["\\int", "\\int "],
      ["\\int_{a}^{b}", "\\int_{‸}^{} "],
      ["\\iint", "\\iint "],
      ["\\oint", "\\oint "],
      ["\\sum_{i=1}^{n}", "\\sum_{‸}^{} "],
      ["\\prod", "\\prod_{‸}^{} "],
      ["\\lim_{x \\to a}", "\\lim_{‸ \\to } "],
      ["\\frac{d}{dx}", "\\frac{d}{d‸}"],
      ["\\frac{\\partial}{\\partial x}", "\\frac{\\partial}{\\partial ‸}"],
      ["\\partial", "\\partial "],
      ["\\nabla", "\\nabla "],
      ["\\Delta x", "\\Delta "],
      ["\\, dx", "\\, d‸"],
      ["\\vec{v}", "\\vec{‸}"],
      ["\\hat{x}", "\\hat{‸}"],
      ["\\dot{x}", "\\dot{‸}"],
    ],
  },
  {
    name: "Relations",
    items: [
      ["\\leq", "\\leq "],
      ["\\geq", "\\geq "],
      ["\\ll", "\\ll "],
      ["\\gg", "\\gg "],
      ["\\equiv", "\\equiv "],
      ["\\propto", "\\propto "],
      ["\\sim", "\\sim "],
      ["\\in", "\\in "],
      ["\\notin", "\\notin "],
      ["\\subset", "\\subset "],
      ["\\cup", "\\cup "],
      ["\\cap", "\\cap "],
      ["\\forall", "\\forall "],
      ["\\exists", "\\exists "],
      ["\\to", "\\to "],
      ["\\Rightarrow", "\\Rightarrow "],
      ["\\Leftrightarrow", "\\Leftrightarrow "],
      ["\\mathbb{R}", "\\mathbb{R} "],
    ],
  },
  {
    name: "Layouts",
    items: [
      ["\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}", "\\begin{pmatrix} ‸ &  \\\\  &  \\end{pmatrix}"],
      ["\\begin{bmatrix} a \\\\ b \\end{bmatrix}", "\\begin{bmatrix} ‸ \\\\  \\end{bmatrix}"],
      ["\\begin{cases} a & x>0 \\\\ b & x\\le 0 \\end{cases}", "\\begin{cases} ‸ & \\\\  & \\end{cases}"],
      ["\\overline{x}", "\\overline{‸}"],
      ["\\binom{n}{k}", "\\binom{‸}{}"],
      ["\\underbrace{x}_{a}", "\\underbrace{‸}_{}"],
    ],
  },
];

function render(latex: string, display: boolean): { html: string; error: string | null } {
  try {
    return {
      html: katex.renderToString(latex, { throwOnError: true, displayMode: display }),
      error: null,
    };
  } catch (e) {
    return {
      html: katex.renderToString(latex, { throwOnError: false, displayMode: display }),
      error: e instanceof Error ? e.message.replace(/^KaTeX parse error:\s*/, "") : "Can't read this LaTeX",
    };
  }
}

export default function MathPopover({
  editor,
  pos,
  anchor,
  onClose,
}: {
  editor: Editor;
  pos: number;
  anchor: Anchor;
  onClose: () => void;
}) {
  const node = editor.state.doc.nodeAt(pos);
  const initialLatex = (node?.attrs.latex as string) ?? "";
  const initialDisplay = node?.type.name === "blockMath";
  const [latex, setLatex] = useState(initialLatex);
  const [display, setDisplay] = useState(initialDisplay);
  const [tab, setTab] = useState(0);
  const field = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);

  const preview = useMemo(() => render(latex, display), [latex, display]);

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [latex]);

  function finish(save: boolean) {
    if (done.current) return;
    done.current = true;
    const current = editor.state.doc.nodeAt(pos);
    const isMath = current && (current.type.name === "inlineMath" || current.type.name === "blockMath");
    if (isMath) {
      const value = save ? latex.trim() : initialLatex.trim();
      if (!value) {
        editor.chain().focus().deleteRange({ from: pos, to: pos + current.nodeSize }).run();
      } else {
        const type = save && display !== initialDisplay ? (display ? "blockMath" : "inlineMath") : current.type.name;
        const chain = editor.chain().focus();
        if (type !== current.type.name) {
          chain
            .deleteRange({ from: pos, to: pos + current.nodeSize })
            .insertContentAt(pos, { type, attrs: { latex: value } });
        } else if (value !== current.attrs.latex) {
          chain.command(({ tr }) => {
            tr.setNodeMarkup(pos, undefined, { ...current.attrs, latex: value });
            return true;
          });
        }
        chain.run();
        // Park the caret just after an inline equation so typing continues the sentence.
        const after = editor.state.doc.nodeAt(pos);
        if (after?.type.name === "inlineMath") editor.commands.setTextSelection(pos + after.nodeSize);
      }
    }
    onClose();
  }

  function insert(snippet: string) {
    const el = field.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = latex.slice(start, end);
    const caret = snippet.indexOf("‸");
    // Wrap a selection: \frac{‸}{} with "x" selected becomes \frac{x}{}.
    const text = snippet.replace("‸", selected);
    const next = latex.slice(0, start) + text + latex.slice(end);
    setLatex(next);
    const at = start + (caret >= 0 ? caret + selected.length : text.length);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  }

  return (
    <Popover
      anchor={anchor}
      onClose={() => finish(true)}
      onEscape={() => finish(false)}
      className="w-[400px] max-w-[calc(100vw-16px)] p-3"
      label="Edit equation"
    >
      <div
        className="flex min-h-14 items-center justify-center overflow-x-auto rounded-lg bg-panel px-3 py-2 text-ink"
        aria-live="polite"
      >
        {latex.trim() ? (
          <span dangerouslySetInnerHTML={{ __html: preview.html }} />
        ) : (
          <span className="text-sm text-ink-faint">Your equation appears here</span>
        )}
      </div>

      <textarea
        ref={field}
        value={latex}
        onChange={(e) => setLatex(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            finish(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          }
        }}
        rows={1}
        spellCheck={false}
        placeholder="Type LaTeX, like \frac{1}{2} m v^2"
        aria-label="LaTeX source"
        className="mt-2 w-full resize-none rounded-lg border border-edge bg-card px-3 py-2 font-mono text-[13px] leading-5 outline-none placeholder:text-ink-faint focus:border-accent"
      />
      {preview.error && latex.trim() && (
        <p className="mt-1 text-xs text-danger-ink">{preview.error}</p>
      )}

      <div className="mt-2 flex gap-1 overflow-x-auto" role="tablist" aria-label="Symbol groups">
        {PALETTE.map((g, i) => (
          <button
            key={g.name}
            role="tab"
            aria-selected={tab === i}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setTab(i)}
            className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${
              tab === i ? "bg-accent-softer text-ink" : "text-ink-faint hover:text-ink"
            }`}
          >
            {g.name}
          </button>
        ))}
      </div>
      <div className="mt-1.5 grid max-h-36 grid-cols-6 gap-1 overflow-y-auto">
        {PALETTE[tab].items.map(([label, snippet]) => (
          <button
            key={label}
            title={snippet.replace("‸", "")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insert(snippet)}
            className={`flex h-10 items-center justify-center overflow-hidden rounded-md border border-transparent text-ink hover:border-edge hover:bg-card-hover ${
              PALETTE[tab].name === "Layouts" ? "col-span-2 text-[11px]" : "text-sm"
            }`}
            dangerouslySetInnerHTML={{
              __html: katex.renderToString(label, { throwOnError: false }),
            }}
          />
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <div className="flex rounded-lg border border-edge p-0.5 text-xs font-semibold" role="group" aria-label="Equation layout">
          {(
            [
              [false, "In line"],
              [true, "Own line"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={label}
              aria-pressed={display === value}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setDisplay(value)}
              className={`rounded-md px-2.5 py-1 ${
                display === value ? "bg-accent-softer text-ink" : "text-ink-faint hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            done.current = true;
            const current = editor.state.doc.nodeAt(pos);
            if (current) editor.chain().focus().deleteRange({ from: pos, to: pos + current.nodeSize }).run();
            onClose();
          }}
          className="rounded-lg p-1.5 text-ink-faint hover:bg-danger-soft hover:text-danger-ink"
          aria-label="Delete equation"
          title="Delete equation"
        >
          <Trash2 className="size-4" />
        </button>
        <span className="ml-auto hidden text-[11px] text-ink-faint sm:inline">Enter to save, Esc to cancel</span>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => finish(true)}
          className="rounded-lg bg-accent px-3 py-1.5 font-display text-sm font-bold text-white hover:bg-accent-hover"
        >
          Done
        </button>
      </div>
    </Popover>
  );
}
