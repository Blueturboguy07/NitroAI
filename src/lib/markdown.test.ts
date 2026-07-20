import { describe, expect, it } from "vitest";
import { blocksToMarkdown, markdownToBlocks, plainText, renderInline } from "./markdown";
import type { Block } from "./types";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const DOC = `# Title Heading

## Subheading

### Sub-subheading

This is a paragraph with **bold** and _italic_ text.

- First bullet
- Second bullet

1. First numbered
2. Second numbered

- [ ] Todo not done
- [x] Todo done

> A simple quote
> spanning two lines

> [!note] This is a callout
> with a second line

\`\`\`js
const x = 1;
\`\`\`

$$
E = mc^2
$$

---

| Col A | Col B |
| --- | --- |
| 1 | 2 |
| 3 | 4 |
`;

describe("markdownToBlocks", () => {
  const blocks = markdownToBlocks(DOC);

  it("gives every block a uuid id", () => {
    for (const b of blocks) {
      expect(typeof b.id).toBe("string");
      expect(b.id.length).toBeGreaterThan(0);
    }
    // ids are unique
    expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
  });

  it("parses headings 1-3", () => {
    expect(blocks[0]).toMatchObject({ type: "heading1", text: "Title Heading" });
    expect(blocks[1]).toMatchObject({ type: "heading2", text: "Subheading" });
    expect(blocks[2]).toMatchObject({ type: "heading3", text: "Sub-subheading" });
  });

  it("parses a paragraph", () => {
    expect(blocks[3]).toMatchObject({
      type: "paragraph",
      text: "This is a paragraph with **bold** and _italic_ text.",
    });
  });

  it("parses bullets", () => {
    expect(blocks[4]).toMatchObject({ type: "bullet", text: "First bullet" });
    expect(blocks[5]).toMatchObject({ type: "bullet", text: "Second bullet" });
  });

  it("parses numbered items", () => {
    expect(blocks[6]).toMatchObject({ type: "numbered", text: "First numbered" });
    expect(blocks[7]).toMatchObject({ type: "numbered", text: "Second numbered" });
  });

  it("parses todos with checked state", () => {
    expect(blocks[8]).toMatchObject({ type: "todo", text: "Todo not done", checked: false });
    expect(blocks[9]).toMatchObject({ type: "todo", text: "Todo done", checked: true });
  });

  it("parses a multi-line quote", () => {
    expect(blocks[10]).toMatchObject({
      type: "quote",
      text: "A simple quote\nspanning two lines",
    });
  });

  it("merges callout syntax into a callout block with emoji", () => {
    expect(blocks[11]).toMatchObject({
      type: "callout",
      text: "This is a callout\nwith a second line",
      emoji: "📝",
    });
  });

  it("parses a fenced code block with language", () => {
    expect(blocks[12]).toMatchObject({
      type: "code",
      text: "const x = 1;",
      language: "js",
    });
  });

  it("parses a math block", () => {
    expect(blocks[13]).toMatchObject({ type: "math", text: "E = mc^2" });
  });

  it("parses a divider", () => {
    expect(blocks[14]).toMatchObject({ type: "divider" });
  });

  it("parses a GitHub-style pipe table into rows", () => {
    expect(blocks[15].type).toBe("table");
    expect(blocks[15].rows).toEqual([
      ["Col A", "Col B"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("total block count matches the document", () => {
    expect(blocks).toHaveLength(16);
  });
});

describe("blocksToMarkdown", () => {
  it("round-trips a representative document back to equivalent markdown", () => {
    const blocks = markdownToBlocks(DOC);
    const out = blocksToMarkdown(blocks);
    expect(norm(out)).toBe(norm(DOC));
  });

  it("re-parsing the round-tripped markdown yields structurally equal blocks", () => {
    const blocks = markdownToBlocks(DOC);
    const out = blocksToMarkdown(blocks);
    const reparsed = markdownToBlocks(out);
    // ignore ids, compare the rest
    const strip = (bs: typeof blocks) => bs.map(({ id: _id, ...rest }) => rest);
    expect(strip(reparsed)).toEqual(strip(blocks));
  });

  it("auto-numbers consecutive numbered blocks regardless of stored text", () => {
    const blocks: Block[] = [
      { id: "a", type: "numbered", text: "alpha" },
      { id: "b", type: "numbered", text: "beta" },
      { id: "c", type: "paragraph", text: "break" },
      { id: "d", type: "numbered", text: "gamma" },
    ];
    const out = blocksToMarkdown(blocks);
    expect(out).toContain("1. alpha");
    expect(out).toContain("2. beta");
    expect(out).toContain("1. gamma");
  });
});

describe("plainText", () => {
  it("concatenates block text, including table cells, and drops empties", () => {
    const blocks: Block[] = [
      { id: "1", type: "heading1", text: "Title" },
      { id: "2", type: "paragraph", text: "Hello world" },
      { id: "3", type: "divider", text: "" },
      {
        id: "4",
        type: "table",
        text: "",
        rows: [
          ["a", "b"],
          ["c", "d"],
        ],
      },
    ];
    expect(plainText(blocks)).toBe("Title Hello world a b c d");
  });

  it("returns an empty string for no blocks", () => {
    expect(plainText([])).toBe("");
  });
});

describe("renderInline (node-safe)", () => {
  it("returns a string without requiring a DOM", () => {
    const out = renderInline("**bold** text");
    expect(typeof out).toBe("string");
  });

  it("escapes raw HTML when no window is present", () => {
    const out = renderInline("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
});
