/* Bridges between the editor's document (Tiptap JSON) and the Block[] model the
   rest of the app uses. Notes created before the new editor (and every freshly
   generated note) only have blocks, so they are turned into editor HTML on
   open; every save derives blocks back from the document so search, chat
   grounding and Markdown export keep working. */

import DOMPurify from "dompurify";
import { marked } from "marked";
import type { JSONContent } from "@tiptap/core";
import { uuid } from "../ids";
import { normalizeMath } from "../markdown";
import type { Block, BlockType } from "../types";

/* ---- blocks -> editor HTML ------------------------------------------------ */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SANITIZE = {
  ADD_ATTR: ["data-type", "data-latex", "data-color", "data-emoji", "data-checked"],
};

/** Inline markdown (bold, italic, code, links, ==highlight==, $math$) -> HTML
 *  the editor schema understands. */
export function inlineToHtml(text: string): string {
  const stash: string[] = [];
  const keep = (html: string) => `%%NX${stash.push(html) - 1}%%`;
  const math = (latex: string) =>
    keep(`<span data-type="inline-math" data-latex="${escapeHtml(latex.trim())}"></span>`);
  let src = normalizeMath(text);
  src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_m, x: string) => math(x));
  src = src.replace(/\$([^$\n]+?)\$/g, (_m, x: string) => math(x));
  let html = marked.parseInline(src, { async: false }) as string;
  html = html.replace(/==([^=\n]+?)==/g, '<mark data-color="yellow">$1</mark>');
  html = html.replace(/%%NX(\d+)%%/g, (_m, i: string) => stash[Number(i)] ?? "");
  return html;
}

function listHtml(tag: "ul" | "ol" | "task", items: Block[]): string {
  if (tag === "task") {
    const lis = items
      .map(
        (b) =>
          `<li data-type="taskItem" data-checked="${b.checked ? "true" : "false"}"><p>${inlineToHtml(b.text)}</p></li>`,
      )
      .join("");
    return `<ul data-type="taskList">${lis}</ul>`;
  }
  return `<${tag}>${items.map((b) => `<li><p>${inlineToHtml(b.text)}</p></li>`).join("")}</${tag}>`;
}

function blockToHtml(b: Block): string {
  switch (b.type) {
    case "heading1":
      return `<h1>${inlineToHtml(b.text)}</h1>`;
    case "heading2":
      return `<h2>${inlineToHtml(b.text)}</h2>`;
    case "heading3":
      return `<h3>${inlineToHtml(b.text)}</h3>`;
    case "quote":
      return `<blockquote>${b.text
        .split("\n")
        .map((l) => `<p>${inlineToHtml(l)}</p>`)
        .join("")}</blockquote>`;
    case "callout":
      return `<div data-type="callout" data-emoji="${escapeHtml(b.emoji ?? "📌")}">${inlineToHtml(b.text.replace(/\n/g, " "))}</div>`;
    case "code":
      return `<pre><code${b.language ? ` class="language-${escapeHtml(b.language)}"` : ""}>${escapeHtml(b.text)}</code></pre>`;
    case "math":
      return `<div data-type="block-math" data-latex="${escapeHtml(b.text)}"></div>`;
    case "divider":
      return "<hr>";
    case "table": {
      const rows = b.rows ?? [];
      if (!rows.length) return "";
      const tr = rows
        .map(
          (row, r) =>
            `<tr>${row
              .map((cell) => {
                const tag = r === 0 ? "th" : "td";
                return `<${tag}><p>${inlineToHtml(cell)}</p></${tag}>`;
              })
              .join("")}</tr>`,
        )
        .join("");
      return `<table><tbody>${tr}</tbody></table>`;
    }
    default:
      return `<p>${inlineToHtml(b.text)}</p>`;
  }
}

/** Block[] -> sanitized HTML for the editor's initial content. Consecutive list
 *  blocks are grouped into one list. */
export function blocksToEditorHtml(blocks: Block[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    const listKind =
      b.type === "bullet" ? "ul" : b.type === "numbered" ? "ol" : b.type === "todo" ? "task" : null;
    if (listKind) {
      const run: Block[] = [];
      while (i < blocks.length && blocks[i].type === b.type) run.push(blocks[i++]);
      out.push(listHtml(listKind, run));
      continue;
    }
    out.push(blockToHtml(b));
    i++;
  }
  const html = out.join("");
  return typeof window === "undefined" ? html : DOMPurify.sanitize(html, SANITIZE);
}

/* ---- editor JSON -> blocks ------------------------------------------------ */

type Mark = NonNullable<JSONContent["marks"]>[number];

function wrapMark(text: string, mark: Mark): string {
  switch (mark.type) {
    case "bold":
      return `**${text}**`;
    case "italic":
      return `*${text}*`;
    case "strike":
      return `~~${text}~~`;
    case "code":
      return `\`${text}\``;
    case "highlight":
      return `==${text}==`;
    case "link":
      return `[${text}](${(mark.attrs?.href as string) ?? ""})`;
    default:
      return text;
  }
}

const MD_MARKS = new Set(["bold", "italic", "strike", "code", "highlight", "link"]);

function markKey(marks: Mark[]): string {
  return marks
    .filter((m) => MD_MARKS.has(m.type))
    .map((m) => `${m.type}:${m.type === "link" ? (m.attrs?.href ?? "") : ""}`)
    .sort()
    .join("|");
}

/** Inline editor content -> inline markdown. Neighbouring runs with the same
 *  formatting (including equations inside a highlight) are wrapped once, and
 *  code marks wrap innermost so `**\`x\`**` stays valid. */
export function inlineToMarkdown(nodes: JSONContent[] = []): string {
  const runs: { text: string; marks: Mark[] }[] = [];
  for (const n of nodes) {
    const text =
      n.type === "text"
        ? (n.text ?? "")
        : n.type === "inlineMath"
          ? `$${(n.attrs?.latex as string) ?? ""}$`
          : n.type === "hardBreak"
            ? "\n"
            : textOf(n);
    const marks = n.type === "hardBreak" ? [] : (n.marks ?? []);
    const last = runs[runs.length - 1];
    if (last && markKey(last.marks) === markKey(marks)) last.text += text;
    else runs.push({ text, marks });
  }
  return runs
    .map(({ text, marks }) => {
      const active = marks
        .filter((m) => MD_MARKS.has(m.type))
        .sort((a, b) => Number(b.type === "code") - Number(a.type === "code"));
      if (!active.length || !text.trim()) return text;
      // Keep surrounding whitespace outside the markers (`** x**` is not bold).
      const lead = text.match(/^\s*/)?.[0] ?? "";
      const trail = text.match(/\s*$/)?.[0] ?? "";
      const core = text.slice(lead.length, text.length - trail.length);
      return lead + active.reduce(wrapMark, core) + trail;
    })
    .join("");
}

function textOf(n: JSONContent): string {
  if (n.type === "text") return n.text ?? "";
  if (n.type === "inlineMath") return `$${(n.attrs?.latex as string) ?? ""}$`;
  return (n.content ?? []).map(textOf).join("");
}

function block(type: BlockType, text: string, extra: Partial<Block> = {}): Block {
  return { id: uuid(), type, text, ...extra };
}

function listItems(list: JSONContent, type: BlockType, out: Block[]) {
  for (const item of list.content ?? []) {
    const children = item.content ?? [];
    const first = children.find((c) => c.type === "paragraph");
    out.push(
      block(type, inlineToMarkdown(first?.content), type === "todo" ? { checked: !!item.attrs?.checked } : {}),
    );
    // Nested lists flatten into the same block run (Block[] has no nesting).
    for (const c of children) {
      if (c.type === "bulletList") listItems(c, "bullet", out);
      else if (c.type === "orderedList") listItems(c, "numbered", out);
      else if (c.type === "taskList") listItems(c, "todo", out);
    }
  }
}

/** Editor document -> Block[] (lossy for colours/alignment; those live in the
 *  document itself). */
export function docToBlocks(doc: JSONContent): Block[] {
  const out: Block[] = [];
  for (const n of doc.content ?? []) {
    switch (n.type) {
      case "heading": {
        const level = Math.min(Math.max(Number(n.attrs?.level) || 1, 1), 3);
        out.push(block(`heading${level}` as BlockType, inlineToMarkdown(n.content)));
        break;
      }
      case "paragraph":
        out.push(block("paragraph", inlineToMarkdown(n.content)));
        break;
      case "bulletList":
        listItems(n, "bullet", out);
        break;
      case "orderedList":
        listItems(n, "numbered", out);
        break;
      case "taskList":
        listItems(n, "todo", out);
        break;
      case "blockquote":
        out.push(
          block(
            "quote",
            (n.content ?? []).map((c) => inlineToMarkdown(c.content)).join("\n"),
          ),
        );
        break;
      case "callout":
        out.push(
          block("callout", inlineToMarkdown(n.content), {
            emoji: (n.attrs?.emoji as string) ?? "📌",
          }),
        );
        break;
      case "codeBlock":
        out.push(
          block("code", textOf(n), { language: (n.attrs?.language as string) ?? "" }),
        );
        break;
      case "blockMath":
        out.push(block("math", (n.attrs?.latex as string) ?? ""));
        break;
      case "horizontalRule":
        out.push(block("divider", ""));
        break;
      case "table":
        out.push(
          block("table", "", {
            rows: (n.content ?? []).map((row) =>
              (row.content ?? []).map((cell) =>
                (cell.content ?? []).map((p) => inlineToMarkdown(p.content)).join(" "),
              ),
            ),
          }),
        );
        break;
      default:
        out.push(block("paragraph", textOf(n)));
    }
  }
  // Drop trailing empty paragraphs the editor keeps for the caret.
  while (out.length && out[out.length - 1].type === "paragraph" && !out[out.length - 1].text.trim()) {
    out.pop();
  }
  return out;
}

/** Word count over the document's text (equations count as one word). */
export function countWords(doc: JSONContent): number {
  let count = 0;
  const walk = (n: JSONContent) => {
    if (n.type === "text") count += (n.text ?? "").split(/\s+/).filter(Boolean).length;
    else if (n.type === "inlineMath" || n.type === "blockMath") count += 1;
    (n.content ?? []).forEach(walk);
  };
  walk(doc);
  return count;
}
