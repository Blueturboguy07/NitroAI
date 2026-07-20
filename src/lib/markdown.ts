/* Block <-> Markdown model.
   The editor stores note bodies as an ordered Block[] (see types.ts). Generation
   produces markdown text that must round-trip through this module: markdown in
   from LLM output, blocks for the editor, markdown back out for export/search. */

import DOMPurify from "dompurify";
import { marked } from "marked";
import katex from "katex";
import { uuid } from "./ids";
import type { Block, BlockType } from "./types";

/* ---- callout kind <-> emoji ---------------------------------------------- */

const CALLOUT_EMOJI: Record<string, string> = {
  note: "📝",
  tip: "💡",
  important: "❗",
  warning: "⚠️",
  caution: "🔥",
  info: "ℹ️",
};

const KIND_BY_EMOJI: Record<string, string> = Object.fromEntries(
  Object.entries(CALLOUT_EMOJI).map(([kind, emoji]) => [emoji, kind]),
);

const DEFAULT_CALLOUT_EMOJI = "📌";

const HEADING_TYPES: readonly BlockType[] = ["heading1", "heading2", "heading3"];

/* ---- markdown -> blocks --------------------------------------------------- */

const FENCE_RE = /^\s*```\s*([\w+-]*)\s*$/;
const CLOSE_FENCE_RE = /^\s*```\s*$/;
const DIVIDER_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const MATH_FENCE_RE = /^\s*\$\$\s*$/;
const MATH_INLINE_RE = /^\s*\$\$(.+)\$\$\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const TODO_RE = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;
const BULLET_RE = /^\s*[-*]\s+(.*)$/;
const NUMBERED_RE = /^\s*\d+\.\s+(.*)$/;
const CALLOUT_HEAD_RE = /^\[!(\w+)\]\s*(.*)$/i;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim().length > 0;
}

function isTableSeparator(line: string): boolean {
  return TABLE_SEP_RE.test(line) && line.includes("-");
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function newBlock(type: BlockType, text: string, extra: Partial<Block> = {}): Block {
  return { id: uuid(), type, text, ...extra };
}

/** Parse markdown source into an ordered list of editor blocks. */
export function markdownToBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    // fenced code block
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const language = fenceMatch[1] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !CLOSE_FENCE_RE.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence (or EOF)
      blocks.push(newBlock("code", codeLines.join("\n"), { language }));
      continue;
    }

    // divider (checked before table-row heuristics, no pipes involved)
    if (DIVIDER_RE.test(line)) {
      blocks.push(newBlock("divider", ""));
      i++;
      continue;
    }

    // multi-line math block: $$ on its own line ... $$
    if (MATH_FENCE_RE.test(line)) {
      const mathLines: string[] = [];
      i++;
      while (i < lines.length && !MATH_FENCE_RE.test(lines[i])) {
        mathLines.push(lines[i]);
        i++;
      }
      i++; // skip closing $$
      blocks.push(newBlock("math", mathLines.join("\n").trim()));
      continue;
    }

    // single-line math: $$ ... $$
    const mathInline = MATH_INLINE_RE.exec(line);
    if (mathInline) {
      blocks.push(newBlock("math", mathInline[1].trim()));
      i++;
      continue;
    }

    // headings
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 3);
      blocks.push(newBlock(HEADING_TYPES[level - 1], headingMatch[2].trim()));
      i++;
      continue;
    }

    // blockquote / callout — merge consecutive `>` lines
    if (QUOTE_RE.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        const m = QUOTE_RE.exec(lines[i]);
        quoteLines.push(m ? m[1] : "");
        i++;
      }
      const calloutMatch = CALLOUT_HEAD_RE.exec(quoteLines[0] ?? "");
      if (calloutMatch) {
        const kind = calloutMatch[1].toLowerCase();
        const emoji = CALLOUT_EMOJI[kind] ?? DEFAULT_CALLOUT_EMOJI;
        const body = [calloutMatch[2], ...quoteLines.slice(1)].join("\n").trim();
        blocks.push(newBlock("callout", body, { emoji }));
      } else {
        blocks.push(newBlock("quote", quoteLines.join("\n").trim()));
      }
      continue;
    }

    // GitHub-style pipe table: header row + separator row
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const rows: string[][] = [parseTableRow(line)];
      i += 2; // header + separator
      while (i < lines.length && isTableRow(lines[i]) && !isTableSeparator(lines[i])) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      blocks.push(newBlock("table", "", { rows }));
      continue;
    }

    // todo (must be checked before generic bullet)
    const todoMatch = TODO_RE.exec(line);
    if (todoMatch) {
      blocks.push(
        newBlock("todo", todoMatch[2], { checked: todoMatch[1].toLowerCase() === "x" }),
      );
      i++;
      continue;
    }

    // bullet
    const bulletMatch = BULLET_RE.exec(line);
    if (bulletMatch) {
      blocks.push(newBlock("bullet", bulletMatch[1]));
      i++;
      continue;
    }

    // numbered
    const numberedMatch = NUMBERED_RE.exec(line);
    if (numberedMatch) {
      blocks.push(newBlock("numbered", numberedMatch[1]));
      i++;
      continue;
    }

    // paragraph — merge consecutive plain lines until a blank line or another
    // block type starts.
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !FENCE_RE.test(lines[i]) &&
      !DIVIDER_RE.test(lines[i]) &&
      !MATH_FENCE_RE.test(lines[i]) &&
      !MATH_INLINE_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i]) &&
      !TODO_RE.test(lines[i]) &&
      !BULLET_RE.test(lines[i]) &&
      !NUMBERED_RE.test(lines[i]) &&
      !(isTableRow(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(newBlock("paragraph", paraLines.join("\n").trim()));
  }

  return blocks;
}

/* ---- blocks -> markdown --------------------------------------------------- */

function blockToMarkdown(block: Block, numberedIndex: number): string {
  switch (block.type) {
    case "heading1":
      return `# ${block.text}`;
    case "heading2":
      return `## ${block.text}`;
    case "heading3":
      return `### ${block.text}`;
    case "paragraph":
      return block.text;
    case "bullet":
      return `- ${block.text}`;
    case "numbered":
      return `${numberedIndex}. ${block.text}`;
    case "todo":
      return `- [${block.checked ? "x" : " "}] ${block.text}`;
    case "quote":
      return block.text
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "callout": {
      const kind = (block.emoji && KIND_BY_EMOJI[block.emoji]) || "note";
      const lines = block.text.split("\n");
      const head = `> [!${kind}] ${lines[0] ?? ""}`;
      const rest = lines.slice(1).map((l) => `> ${l}`);
      return [head, ...rest].join("\n");
    }
    case "code":
      return "```" + (block.language ?? "") + "\n" + block.text + "\n```";
    case "math":
      return `$$\n${block.text}\n$$`;
    case "divider":
      return "---";
    case "table": {
      const rows = block.rows ?? [];
      if (rows.length === 0) return "";
      const [header, ...body] = rows;
      const fmt = (row: string[]) => `| ${row.join(" | ")} |`;
      const sep = fmt(header.map(() => "---"));
      return [fmt(header), sep, ...body.map(fmt)].join("\n");
    }
    default:
      return block.text;
  }
}

/** Inverse of markdownToBlocks — round-trips the common block types. */
export function blocksToMarkdown(blocks: Block[]): string {
  const parts: string[] = [];
  let numberedCounter = 0;
  for (const block of blocks) {
    numberedCounter = block.type === "numbered" ? numberedCounter + 1 : 0;
    parts.push(blockToMarkdown(block, numberedCounter));
  }
  return parts.join("\n\n");
}

/* ---- inline / math rendering ---------------------------------------------- */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Inline markdown (bold/italic/code/links) -> sanitized HTML.
 *  In a non-browser environment (no DOM for DOMPurify) this degrades to a
 *  minimal escaped string rather than emitting unsanitized markup. */
export function renderInline(text: string): string {
  if (typeof window === "undefined") {
    return escapeHtml(text);
  }
  const html = marked.parseInline(text, { async: false }) as string;
  return DOMPurify.sanitize(html);
}

/** KaTeX render of a LaTeX string to an HTML string. Pure string generation —
 *  safe to call in any environment (no DOM required by KaTeX itself). */
export function renderMath(latex: string, display = true): string {
  return katex.renderToString(latex, {
    throwOnError: false,
    displayMode: display,
    output: "html",
  });
}

const MATH_BLOCK_RE = /\$\$([\s\S]+?)\$\$/g;
const MATH_INLINE_RENDER_RE = /\$([^$\n]+?)\$/g;

/** LLMs frequently emit LaTeX with `\( … \)` / `\[ … \]` (or ```` ```markdown ````
 *  fences) instead of the `$`/`$$` KaTeX delimiters. Normalize so our renderers
 *  catch the math regardless of which convention the model used. */
export function normalizeMath(text: string): string {
  return text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, x: string) => `$$${x}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, x: string) => `$${x}$`);
}

/** Strip a code fence that wraps the ENTIRE string — models often wrap their
 *  markdown answer in ```` ```markdown … ``` ````, which would otherwise render as
 *  one monospace code block. */
export function stripFence(md: string): string {
  const t = md.trim();
  const m = t.match(/^```[\w+-]*\r?\n([\s\S]*?)\r?\n```$/);
  return m ? m[1] : md;
}

/** Full block-level Markdown (headings, lists, tables, code, $-math) -> sanitized
 *  HTML. Used for chat answers. Math is stashed before Markdown parsing so KaTeX
 *  markup survives, then reinserted and sanitized. */
export function renderMarkdown(md: string): string {
  if (typeof window === "undefined") return escapeHtml(md);
  const stash: string[] = [];
  const keep = (html: string): string => `%%NITROMATH${stash.push(html) - 1}%%`;
  let src = normalizeMath(md);
  src = src.replace(MATH_BLOCK_RE, (_m, x: string) => keep(renderMath(x.trim(), true)));
  src = src.replace(MATH_INLINE_RENDER_RE, (_m, x: string) => keep(renderMath(x.trim(), false)));
  let html = marked.parse(src, { async: false }) as string;
  html = html.replace(/%%NITROMATH(\d+)%%/g, (_m, i: string) => stash[Number(i)] ?? "");
  return DOMPurify.sanitize(html, { ADD_ATTR: ["class", "style"] });
}

/** Inline markdown + inline math ($…$ and \(…\)) -> sanitized HTML. Used by the
 *  editor read-view so bold terms, code, and equations all render in place. */
export function renderRichInline(text: string): string {
  if (typeof window === "undefined") return escapeHtml(text);
  const stash: string[] = [];
  const keep = (html: string): string => `%%NM${stash.push(html) - 1}%%`;
  let src = normalizeMath(text);
  src = src.replace(MATH_BLOCK_RE, (_m, x: string) => keep(renderMath(x.trim(), true)));
  src = src.replace(MATH_INLINE_RENDER_RE, (_m, x: string) => keep(renderMath(x.trim(), false)));
  let html = marked.parseInline(src, { async: false }) as string;
  html = html.replace(/%%NM(\d+)%%/g, (_m, i: string) => stash[Number(i)] ?? "");
  return DOMPurify.sanitize(html, { ADD_ATTR: ["class", "style"] });
}

/* ---- plain text ------------------------------------------------------------ */

/** Concatenated text of all blocks, for embeddings/search. */
export function plainText(blocks: Block[]): string {
  const parts = blocks.map((block) => {
    if (block.type === "table") {
      return (block.rows ?? []).map((row) => row.join(" ")).join(" ");
    }
    return block.text;
  });
  return parts.filter((t) => t.trim().length > 0).join(" ");
}
