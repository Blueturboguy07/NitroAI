/* Note export: markdown file, .doc (Word-compatible HTML), and one-click print-to-PDF. */

import type { Block, Note } from "./types";
import { blocksToMarkdown, renderInline, renderMath } from "./markdown";

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

const PRINT_STYLE = `
  body { font-family: -apple-system, "Segoe UI", sans-serif; padding: 2rem; max-width: 800px; margin: 0 auto; color: #1a1a1a; }
  h1, h2, h3 { margin-top: 1.2em; }
  blockquote { border-left: 3px solid #ccc; margin: 0.5em 0; padding-left: 1em; color: #555; }
  pre { background: #f4f4f4; padding: 0.75em; border-radius: 4px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin: 0.5em 0; }
  th, td { border: 1px solid #ccc; padding: 0.4em 0.6em; text-align: left; }
  hr { border: none; border-top: 1px solid #ccc; margin: 1.5em 0; }
`;

/** A minimal Word-compatible HTML document string (suitable for saving as .doc). */
export function exportDocxHtml(note: Note): string {
  const bodyHtml = note.blocks.map(blockToHtml).join("\n");
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

/** One-click PDF path: open a print window with the rendered note and call print(). */
export function printPdf(note: Note): void {
  if (typeof window === "undefined") return;
  const win = window.open("", "_blank");
  if (!win) return;
  const bodyHtml = note.blocks.map(blockToHtml).join("\n");
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
