/* Copy rule (contract §1, PRD §1.3, critic S17): the provider is "publik API";
   never "OpenAI API access" / "ChatGPT credits"; no hourly cost figure and no
   hardcoded starter dollar figure in publik-facing copy; the false "system
   keychain" line is gone. Reads the real files so a future edit can't
   quietly regress it. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !/\.test\.(ts|tsx|mjs)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const sources = [...walk(path.join(root, "src")), ...walk(path.join(root, "server")), path.join(root, "README.md")];
const publikFacing = [
  "src/lib/publikCopy.ts",
  "src/lib/publik.ts",
  "src/components/PublikNotice.tsx",
  "src/components/PublikSettings.tsx",
  "src/pages/Onboarding.tsx",
  "src/pages/Settings.tsx",
].map((f) => path.join(root, f));

describe("publik copy rule", () => {
  it("never says 'OpenAI API access' or 'ChatGPT credits' anywhere", () => {
    for (const f of sources) {
      const text = fs.readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/OpenAI API access|ChatGPT credits/i);
    }
  });

  it("publik-facing copy states the rate, never an hourly or per-token figure, never a hardcoded starter amount, never 'credits' as a unit", () => {
    for (const f of publikFacing) {
      const text = fs.readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/\$\d[\d.]*\s*(per|an|a|\/)\s*hour/i);
      expect(text, f).not.toMatch(/about a cent/i);
      expect(text, f).not.toMatch(/per (million )?tokens?/i);
      expect(text, f).not.toMatch(/\$0\.(25|50)\b/);
      expect(text, f).not.toMatch(/\bcredits\b/i);
    }
  });

  it("the disclosure carries the contract sentences", () => {
    const text = fs.readFileSync(path.join(root, "src/lib/publikCopy.ts"), "utf8");
    expect(text).toContain("priced per use at 50% of the model's published list price");
    expect(text).toContain("Most people spend under $2 a month");
    expect(text).toContain("never trains on them");
    expect(text).toContain("at cost");
  });

  it("no page claims the key lives in the system keychain", () => {
    for (const f of walk(path.join(root, "src", "pages"))) {
      expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/system keychain/i);
    }
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).not.toMatch(/stored in your OS keychain/i);
  });
});
