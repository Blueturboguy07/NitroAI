import type { IngestResult } from "./index";

const MAX_TITLE_LEN = 80;

/* First non-empty line, capped to MAX_TITLE_LEN chars. */
function deriveTitle(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed.length > MAX_TITLE_LEN ? trimmed.slice(0, MAX_TITLE_LEN).trim() : trimmed;
    }
  }
  return undefined;
}

export function ingestText(text: string): IngestResult {
  const trimmed = text.trim();
  return { text: trimmed, title: deriveTitle(trimmed) };
}
