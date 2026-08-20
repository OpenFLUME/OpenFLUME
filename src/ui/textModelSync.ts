/**
 * Text-model selection-sync helpers (Stage 5).
 *
 * Pure, DOM-free policy for TextModelView: line/offset math over the
 * serialized text, and the two directional selection-sync decisions:
 *
 *  - store selection → text reveal (`revealTargetForSelection`): which line
 *    range to highlight for an external selection change, or null when the
 *    view must stay put (dirty buffer, caret echo, non-entity selection);
 *  - caret → store selection (`selectionForCaretLine`): which entity the
 *    caret line denotes, or null when the store selection must not change
 *    (dirty buffer, non-entity chrome line, already-selected entity).
 *
 * Both directions are no-ops while the buffer differs from the canonical
 * `modelText` — the LineMap is only valid against canonical text.
 */
import type { LineMap, LineRange } from "../substrate/textProjection";
import type { Selection } from "./types";

/** Editor line height in px — mirrored by the textarea's inline style and
 *  used for scroll-to-line math. */
export const TEXT_LINE_HEIGHT = 18;

/** 0-based char offset of each line start; `offsets[0]` is line 1's start. */
export function lineStartOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

/** 1-based line number containing char `offset` (clamped into range). */
export function lineForOffset(offsets: number[], offset: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans + 1;
}

/** Char offset of the first character of 1-based `line` (clamped). */
export function offsetForLine(offsets: number[], line: number): number {
  const idx = Math.min(Math.max(line, 1), offsets.length) - 1;
  return offsets[idx];
}

/** End offset (exclusive, i.e. before the newline) of 1-based `line`. */
export function lineEndOffset(
  text: string,
  offsets: number[],
  line: number,
): number {
  const idx = Math.min(Math.max(line, 1), offsets.length) - 1;
  return idx + 1 < offsets.length ? offsets[idx + 1] - 1 : text.length;
}

/** LineMap key for a selection (`solidNode` maps to the `solid:` prefix);
 *  null for the empty selection. */
export function lineMapKeyForSelection(sel: Selection): string | null {
  switch (sel.kind) {
    case "node":
      return `node:${sel.id}`;
    case "branch":
      return `branch:${sel.id}`;
    case "solidNode":
      return `solid:${sel.id}`;
    case "conductor":
      return `conductor:${sel.id}`;
    case "group":
      return `group:${sel.id}`;
    case "note":
      return `note:${sel.id}`;
    case "multi":
    case "none":
      return null;
  }
}

/** Inverse of lineMapKeyForSelection; null for unknown prefixes. */
export function selectionForLineMapKey(key: string): Selection | null {
  const i = key.indexOf(":");
  if (i <= 0) return null;
  const prefix = key.slice(0, i);
  const id = key.slice(i + 1);
  switch (prefix) {
    case "node":
      return { kind: "node", id };
    case "branch":
      return { kind: "branch", id };
    case "solid":
      return { kind: "solidNode", id };
    case "conductor":
      return { kind: "conductor", id };
    case "group":
      return { kind: "group", id };
    case "note":
      return { kind: "note", id };
    default:
      return null;
  }
}

/** Entity whose range contains 1-based `line`; null on chrome lines (header,
 *  network line, singleton fields, empty markers, closing brace). */
export function entityAtLine(lineMap: LineMap, line: number): Selection | null {
  for (const [key, range] of lineMap) {
    if (line >= range.startLine && line <= range.endLine) {
      return selectionForLineMapKey(key);
    }
  }
  return null;
}

export function sameSelection(a: Selection, b: Selection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "none") return true;
  if (a.kind === "multi") {
    const other = (b as Extract<Selection, { kind: "multi" }>).items;
    return (
      a.items.length === other.length &&
      a.items.every(
        (item, i) => item.kind === other[i].kind && item.id === other[i].id,
      )
    );
  }
  return (
    a.id === (b as Exclude<Selection, { kind: "none" } | { kind: "multi" }>).id
  );
}

/**
 * Store→text policy: the line range the text view should reveal for an
 * external selection change.  Null when the view must NOT move:
 *  - the buffer is dirty/non-canonical (never disrupt in-progress edits);
 *  - the selection is 'none' or has no corresponding record;
 *  - the selection is the echo of our own caret-driven update (`caretEcho`).
 */
export function revealTargetForSelection(
  selection: Selection,
  lineMap: LineMap,
  opts: { canonical: boolean; caretEcho: Selection | null },
): LineRange | null {
  if (!opts.canonical) return null;
  if (selection.kind === "none") return null;
  if (opts.caretEcho && sameSelection(selection, opts.caretEcho)) return null;
  const key = lineMapKeyForSelection(selection);
  if (!key) return null;
  return lineMap.get(key) ?? null;
}

/**
 * Text→store policy: the selection the store should adopt for a caret on
 * 1-based `line`.  Null when the store must NOT be updated:
 *  - the buffer is dirty/non-canonical (line map is unreliable);
 *  - the line is chrome (header/fields/brace) — caret there leaves the
 *    current selection alone rather than clearing it;
 *  - the entity is already the current selection (no redundant updates).
 */
export function selectionForCaretLine(
  line: number,
  lineMap: LineMap,
  current: Selection,
  opts: { canonical: boolean },
): Selection | null {
  if (!opts.canonical) return null;
  const entity = entityAtLine(lineMap, line);
  if (!entity) return null;
  return sameSelection(entity, current) ? null : entity;
}
