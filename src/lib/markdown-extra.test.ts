import { describe, expect, it } from "vitest";
import { normalizeMath, stripFence } from "./markdown";

describe("normalizeMath", () => {
  it("converts \\( \\) to inline $ and \\[ \\] to block $$", () => {
    expect(normalizeMath("the force \\( F \\) here")).toBe("the force $ F $ here");
    expect(normalizeMath("\\[ E = mc^2 \\]")).toBe("$$ E = mc^2 $$");
  });

  it("leaves existing $ delimiters untouched", () => {
    expect(normalizeMath("$x^2$ and $$y$$")).toBe("$x^2$ and $$y$$");
  });
});

describe("stripFence", () => {
  it("removes a fence that wraps the whole document", () => {
    const wrapped = "```markdown\n# Title\n\n- item\n```";
    expect(stripFence(wrapped)).toBe("# Title\n\n- item");
  });

  it("leaves a fence that is only part of the document", () => {
    const doc = "# Title\n\n```js\ncode\n```\n\nmore";
    expect(stripFence(doc)).toBe(doc);
  });

  it("returns the text unchanged when there is no fence", () => {
    expect(stripFence("# Title\n\ntext")).toBe("# Title\n\ntext");
  });
});
