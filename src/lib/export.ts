/* Note export: markdown file, .doc (Word-compatible HTML), and one-click print-to-PDF. */

/* Thrown by printPdf() when the browser refuses to open the print window. */
export class PrintBlockedError extends Error {
  constructor() {
    super(
      "Your browser blocked the print window. Allow pop-ups for NitroAI, then choose Export PDF again.",
    );
    this.name = "PrintBlockedError";
  }
}

import { generateHTML, type JSONContent } from "@tiptap/core";
import katex from "katex";
import type { Block, Note } from "./types";
import { blocksToMarkdown, renderInline, renderMath } from "./markdown";
import { editorExtensions } from "./editor/extensions";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `# title` + the note body as markdown. */
export function exportMarkdown(note: Note): string {
  return `# ${note.title}\n\n${blocksToMarkdown(note.blocks)}`;
}

/** Trigger a browser file download of `text`. No-op outside the browser. */
export function downloadText(filename: string, text: string, mime = "text/plain"): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function blockToHtml(block: Block): string {
  switch (block.type) {
    case "heading1":
      return `<h1>${renderInline(block.text)}</h1>`;
    case "heading2":
      return `<h2>${renderInline(block.text)}</h2>`;
    case "heading3":
      return `<h3>${renderInline(block.text)}</h3>`;
    case "paragraph":
      return `<p>${renderInline(block.text)}</p>`;
    case "bullet":
      return `<ul><li>${renderInline(block.text)}</li></ul>`;
    case "numbered":
      return `<ol><li>${renderInline(block.text)}</li></ol>`;
    case "todo":
      return `<p>${block.checked ? "☑" : "☐"} ${renderInline(block.text)}</p>`;
    case "quote":
      return `<blockquote>${renderInline(block.text)}</blockquote>`;
    case "callout":
      return `<blockquote>${block.emoji ? `${block.emoji} ` : ""}${renderInline(block.text)}</blockquote>`;
    case "code":
      return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
    case "math":
      return `<div>${renderMath(block.text, true)}</div>`;
    case "divider":
      return "<hr/>";
    case "table": {
      const rows = block.rows ?? [];
      if (rows.length === 0) return "";
      const [head, ...body] = rows;
      const headHtml = `<tr>${head.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr>`;
      const bodyHtml = body
        .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
        .join("");
      return `<table border="1" cellspacing="0" cellpadding="4"><thead>${headHtml}</thead><tbody>${bodyHtml}</tbody></table>`;
    }
    default:
      return `<p>${renderInline(block.text)}</p>`;
  }
}

/* Notes edited in the new editor export from their rich document, so
   highlights, colours and alignment survive. Equations become MathML, which
   browsers (and the print-to-PDF path) render without KaTeX's stylesheet. */
function docHtml(note: Note): string | null {
  if (!note.doc || typeof document === "undefined") return null;
  try {
    const html = generateHTML(note.doc as JSONContent, editorExtensions());
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    tpl.content
      .querySelectorAll('[data-type="inline-math"], [data-type="block-math"]')
      .forEach((el) => {
        const display = el.getAttribute("data-type") === "block-math";
        const out = document.createElement(display ? "div" : "span");
        out.innerHTML = katex.renderToString(el.getAttribute("data-latex") ?? "", {
          throwOnError: false,
          displayMode: display,
          output: "mathml",
        });
        el.replaceWith(out);
      });
    return tpl.innerHTML;
  } catch {
    return null;
  }
}

function noteBodyHtml(note: Note): string {
  return docHtml(note) ?? note.blocks.map(blockToHtml).join("\n");
}

const PRINT_STYLE = `
  body { font-family: -apple-system, "Segoe UI", sans-serif; padding: 2rem; max-width: 800px; margin: 0 auto; color: #1a1a1a; }
  h1, h2, h3 { margin-top: 1.2em; }
  blockquote { border-left: 3px solid #ccc; margin: 0.5em 0; padding-left: 1em; color: #555; }
  pre { background: #f4f4f4; padding: 0.75em; border-radius: 4px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin: 0.5em 0; }
  th, td { border: 1px solid #ccc; padding: 0.4em 0.6em; text-align: left; }
  hr { border: none; border-top: 1px solid #ccc; margin: 1.5em 0; }
  mark { background: #fff0a0; color: inherit; padding: 0 0.1em; }
  mark[data-color="green"] { background: #cbf1c4; }
  mark[data-color="blue"] { background: #cde4ff; }
  mark[data-color="pink"] { background: #ffd3e7; }
  mark[data-color="orange"] { background: #ffd9b0; }
  mark[data-color="purple"] { background: #e4d6ff; }
  div[data-type="callout"] { background: #faf3cd; border-radius: 8px; padding: 0.7em 1em; margin: 0.6em 0; }
  div[data-type="callout"]::before { content: attr(data-emoji) "  "; }
  ul[data-type="taskList"] { list-style: none; padding-left: 0.2em; }
  li[data-type="taskItem"] { display: flex; gap: 0.5em; }
  li p, td p, th p { margin: 0; }
  math[display="block"] { margin: 0.8em 0; }
`;

/** A minimal Word-compatible HTML document string (suitable for saving as .doc). */
export function exportDocxHtml(note: Note): string {
  const bodyHtml = noteBodyHtml(note);
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${escapeHtml(note.title)}</title>
<!--[if gte mso 9]>
<xml>
<w:WordDocument>
<w:View>Print</w:View>
<w:Zoom>100</w:Zoom>
</w:WordDocument>
</xml>
<![endif]-->
<style>${PRINT_STYLE}</style>
</head>
<body>
<h1>${escapeHtml(note.title)}</h1>
${bodyHtml}
</body>
</html>`;
}

/** One-click PDF path: open a print window with the rendered note and call print().
    Throws PrintBlockedError when the popup is blocked, so the caller can say so. */
export function printPdf(note: Note): void {
  if (typeof window === "undefined") return;
  const win = window.open("", "_blank");
  if (!win) throw new PrintBlockedError();
  const bodyHtml = noteBodyHtml(note);
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(note.title)}</title>
<style>${PRINT_STYLE}</style>
</head>
<body>
<h1>${escapeHtml(note.title)}</h1>
${bodyHtml}
</body>
</html>`;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
}
