import { defineConfig } from "vitest/config";

/* `environmentMatchGlobs` (used to auto-select jsdom for *.test.tsx) was a
   Vitest 2/3 option that no longer exists in Vitest 4 — it's silently
   ignored rather than erroring, so every test quietly ran under "node" and
   any .tsx component test would fail immediately on `document is not
   defined`. Vitest 4's supported per-file mechanism is a docblock pragma:
   put `// @vitest-environment jsdom` as the first line of a *.test.tsx file
   that needs a DOM (see src/pages/Dashboard.test.tsx). */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "server/**/*.test.mjs"],
    setupFiles: [],
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "server/**"],
    },
  },
});
