import type { Editor } from "@tiptap/react";
import { MATH_EDIT_EVENT, type MathEditDetail } from "../../lib/editor/extensions";

/* Ask the editor component to open the equation popover for the node at pos. */
export function openMathEditor(editor: Editor, pos: number) {
  editor.view.dom.dispatchEvent(
    new CustomEvent<MathEditDetail>(MATH_EDIT_EVENT, { detail: { pos } }),
  );
}

/* Position of the closest equation that ends at or before `pos`. */
function mathBefore(editor: Editor, pos: number): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, at) => {
    if (at > pos) return false;
    if ((node.type.name === "inlineMath" || node.type.name === "blockMath") && at + node.nodeSize <= pos + 1) {
      found = at;
    }
    return true;
  });
  return found;
}

/** Insert an equation at the selection and open its editor. Selected text
 *  becomes the starting LaTeX, so "x^2" can be turned into an equation. */
export function insertEquation(editor: Editor, display: boolean) {
  const { from, to, empty } = editor.state.selection;
  const selected = empty ? "" : editor.state.doc.textBetween(from, to, " ").trim();
  const type = display ? "blockMath" : "inlineMath";
  editor
    .chain()
    .focus()
    .insertContentAt({ from, to }, { type, attrs: { latex: selected } })
    .run();
  const pos = mathBefore(editor, editor.state.selection.from);
  if (pos !== null) {
    editor.commands.setNodeSelection(pos);
    openMathEditor(editor, pos);
  }
}
