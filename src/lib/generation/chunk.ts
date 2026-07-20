/* Token budgeting + chunking so documents of ANY size can be turned into notes
   without exceeding a model's context window or a low tokens-per-minute (TPM)
   rate limit. Estimation is a conservative chars/4 heuristic (good enough for
   budgeting; the engine's own backoff handles the edges). */

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/* Trim text to at most `maxTokens` (keeps the head, where the important context
   usually is). Used for study-tool grounding where a distilled slice is fine. */
export function capTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

/* Split text into chunks each <= maxTokens, breaking on paragraph then sentence
   then hard-char boundaries so we never split mid-word when avoidable. Optional
   overlap (in tokens) preserves context across chunk seams for coherent notes. */
export function chunkByTokens(
  text: string,
  maxTokens: number,
  overlapTokens = 0,
): string[] {
  const maxChars = Math.max(200, maxTokens * 4);
  if (text.length <= maxChars) return text.trim() ? [text] : [];

  // Break into paragraph-ish units first.
  const units = splitUnits(text, maxChars);
  const chunks: string[] = [];
  let cur = "";
  for (const u of units) {
    if (cur && cur.length + u.length + 2 > maxChars) {
      chunks.push(cur.trim());
      // carry overlap from the tail of the previous chunk
      const overlapChars = overlapTokens * 4;
      cur = overlapChars > 0 ? cur.slice(-overlapChars) + "\n\n" : "";
    }
    cur += (cur ? "\n\n" : "") + u;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

/* Paragraphs, further split if a single paragraph exceeds the budget. */
function splitUnits(text: string, maxChars: number): string[] {
  const paras = text.split(/\n\s*\n/);
  const out: string[] = [];
  for (const p of paras) {
    if (p.length <= maxChars) {
      if (p.trim()) out.push(p.trim());
      continue;
    }
    // huge paragraph: split on sentence boundaries, then hard-slice.
    const sentences = p.split(/(?<=[.!?])\s+/);
    let buf = "";
    for (const s of sentences) {
      if (s.length > maxChars) {
        if (buf.trim()) out.push(buf.trim());
        buf = "";
        for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
        continue;
      }
      if (buf.length + s.length + 1 > maxChars) {
        if (buf.trim()) out.push(buf.trim());
        buf = "";
      }
      buf += (buf ? " " : "") + s;
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out;
}
