import { describe, expect, it } from "vitest";
import { blocksToEditorHtml, docToBlocks, inlineToMarkdown } from "./convert";
import type { Block } from "../types";

const b = (type: Block["type"], text: string, extra: Partial<Block> = {}): Block => ({ id: type, type, text, ...extra });

describe("blocks -> editor HTML", () => {
  it("turns $…$ into equation nodes instead of raw LaTeX", () => {
    const html = blocksToEditorHtml([b("paragraph", "Torque $\\tau = I\\alpha$ here")]);
    expect(html).toContain('data-type="inline-math"');
    expect(html).toContain('data-latex="\\tau = I\\alpha"');
    expect(html).not.toContain("$");
  });

  it("groups consecutive list blocks into one list", () => {
    const html = blocksToEditorHtml([b("bullet", "a"), b("bullet", "b"), b("paragraph", "c"), b("todo", "d", { checked: true })]);
    expect(html.match(/<ul>/g)).toHaveLength(1);
    expect(html).toContain('<ul data-type="taskList"><li data-type="taskItem" data-checked="true">');
  });

  it("keeps display equations and tables", () => {
    const html = blocksToEditorHtml([
      b("math", "E = mc^2"),
      b("table", "", { rows: [["Shape", "I"], ["Hoop", "$MR^2$"]] }),
    ]);
    expect(html).toContain('<div data-type="block-math" data-latex="E = mc^2">');
    expect(html).toContain("<th><p>Shape</p></th>");
    expect(html).toContain('data-latex="MR^2"');
  });
});

describe("editor document -> blocks", () => {
  it("wraps a highlight once across an equation inside it", () => {
    const hl = [{ type: "highlight", attrs: { color: "yellow" } }];
    const md = inlineToMarkdown([
      { type: "text", text: "Net torque " , marks: hl },
      { type: "inlineMath", attrs: { latex: "\\tau" }, marks: hl },
      { type: "text", text: " is key", marks: hl },
      { type: "text", text: "." },
    ]);
    expect(md).toBe("==Net torque $\\tau$ is key==.");
  });

  it("keeps whitespace outside emphasis markers", () => {
    expect(inlineToMarkdown([{ type: "text", text: "bold ", marks: [{ type: "bold" }] }, { type: "text", text: "word" }])).toBe(
      "**bold** word",
    );
  });

  it("converts the main node types", () => {
    const blocks = docToBlocks({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Energy" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
        {
          type: "taskList",
          content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "done" }] }] }],
        },
        { type: "blockMath", attrs: { latex: "K = \\frac12 mv^2" } },
        { type: "callout", attrs: { emoji: "💡" }, content: [{ type: "text", text: "Tip" }] },
        {
          type: "table",
          content: [
            { type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] }] },
            { type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }] }] },
          ],
        },
        { type: "paragraph" },
      ],
    });
    expect(blocks.map((x) => x.type)).toEqual(["heading2", "bullet", "todo", "math", "callout", "table"]);
    expect(blocks[2].checked).toBe(true);
    expect(blocks[3].text).toBe("K = \\frac12 mv^2");
    expect(blocks[4].emoji).toBe("💡");
    expect(blocks[5].rows).toEqual([["A"], ["1"]]);
  });
});
