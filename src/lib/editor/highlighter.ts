/* Highlighter-pen behaviour: what happens to a selection when the pen is
   lifted (mouseup) while highlighter mode is on. Kept pure so it is easy to
   test and to change. */

import type { HighlightColor } from "./extensions";

export type HighlightAction =
  | { kind: "set"; color: HighlightColor }
  | { kind: "unset" }
  | { kind: "none" };

/**
 * @param runs  the highlight colour of each text run inside the selection,
 *              in document order; `null` = that run is not highlighted.
 * @param pen   the pen's current colour.
 */
export function decideHighlight(
  runs: (string | null)[],
  pen: HighlightColor,
): HighlightAction {
  if (runs.length === 0) return { kind: "none" };
  // TODO(human): decide how the pen treats text that is already highlighted.
  // Current default: dragging over text that is *entirely* the pen's colour
  // erases it; anything else (plain, mixed, or another colour) gets painted.
  if (runs.every((c) => c === pen)) return { kind: "unset" };
  return { kind: "set", color: pen };
}
