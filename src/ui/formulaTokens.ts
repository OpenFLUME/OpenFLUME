/**
 * formulaTokens.ts — pure, tolerant tokenizer + static-reference segmenter
 * for the visual formula editor.
 *
 * This is NOT a parser and never evaluates anything: it is just enough
 * lexical analysis to find model references of the shape
 *
 *   pipe('inlet').diameter
 *   conductor('wall').correlation.diameter
 *   reg("some name")
 *
 * and lift them out of the source as `FormulaChip`s with exact source spans
 * so a token-field editor can render chips inline.  Everything else — and
 * every malformed or incomplete reference — stays plain text with its exact
 * characters preserved.
 *
 * Guarantees:
 *  - none of these functions ever throw, on any input;
 *  - spans are exact UTF-16 code-unit offsets into the original source;
 *  - `sourceFromSegments(source, segmentFormula(source))` === source.
 */

export type FormulaTokenKind =
  "number" | "string" | "ident" | "op" | "punct" | "unknown";

export interface FormulaToken {
  kind: FormulaTokenKind;
  /** Inclusive start offset (UTF-16 code units) into the source. */
  start: number;
  /** Exclusive end offset into the source. */
  end: number;
  /** Exact source text of the token (never normalized). */
  value: string;
}

export interface FormulaChip {
  /** Model accessor the reference is rooted at. */
  accessor:
    | "pipe"
    | "heatedPipe"
    | "bend"
    | "branch"
    | "node"
    | "conductor"
    | "solid"
    | "reg";
  /** Decoded string-literal id argument (escapes resolved). */
  id: string;
  /** Property chain after the call, in order (may be empty for reg). */
  properties: string[];
  /** Short display label: `${id} · ${last property}` (just the id for reg). */
  label: string;
}

export type FormulaSegment =
  | { type: "text"; start: number; end: number }
  | { type: "chip"; start: number; end: number; chip: FormulaChip };

/** Model accessors that can root a reference chip. */
const ACCESSORS = new Set<FormulaChip["accessor"]>([
  "pipe",
  "heatedPipe",
  "bend",
  "branch",
  "node",
  "conductor",
  "solid",
  "reg",
]);

/** Multi-char operators, longest first (only what segmentation needs). */
const OPS = [
  "&&",
  "||",
  "==",
  "!=",
  "<=",
  ">=",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "!",
  "?",
  ":",
  "=",
];
/** Call / grouping / member-access punctuation. */
const PUNCT = ["(", ")", ",", "."];

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isIdentStart(c: string): boolean {
  return (
    (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$"
  );
}

function isIdentChar(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}

/**
 * Scan one string literal starting at `start` (which must sit on a quote).
 * Returns the token end (exclusive) and whether a closing quote was found.
 * An unterminated literal runs to the end of the source.
 */
function scanString(
  source: string,
  start: number,
): { end: number; terminated: boolean } {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      // Skip the escaped char if there is one; a trailing backslash simply
      // runs into the unterminated-string case below.
      i += i + 1 < source.length ? 2 : 1;
      continue;
    }
    if (c === quote) return { end: i + 1, terminated: true };
    i++;
  }
  return { end: source.length, terminated: false };
}

/**
 * Decode a TERMINATED string literal's raw inner text (the exact characters
 * between the quotes, with the escapes still in place).  Escape handling
 * matches core/usercode/expression.ts: \n and \t are special, any other
 * escaped character stands for itself (\' \" \\ included).
 */
function decodeStringLiteral(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\" && i + 1 < raw.length) {
      const esc = raw[i + 1];
      if (esc === "n") out += "\n";
      else if (esc === "t") out += "\t";
      else out += esc;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Tokenize `source` into exact-span tokens.  Whitespace is skipped (it is
 * never part of a chip and segmentation reads the raw source between tokens).
 * Tolerant by construction: unterminated strings become a string token that
 * runs to the end of the source, and characters that fit nothing else become
 * single-char `unknown` tokens.  Never throws.
 */
export function tokenizeFormula(source: string): FormulaToken[] {
  const tokens: FormulaToken[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    // Number: digits with optional fraction/exponent, or leading .digits.
    if (
      isDigit(c) ||
      (c === "." && i + 1 < source.length && isDigit(source[i + 1]))
    ) {
      const start = i;
      while (i < source.length && isDigit(source[i])) i++;
      if (source[i] === ".") {
        i++;
        while (i < source.length && isDigit(source[i])) i++;
      }
      if (source[i] === "e" || source[i] === "E") {
        let j = i + 1;
        if (source[j] === "+" || source[j] === "-") j++;
        if (j < source.length && isDigit(source[j])) {
          i = j;
          while (i < source.length && isDigit(source[i])) i++;
        }
      }
      tokens.push({
        kind: "number",
        start,
        end: i,
        value: source.slice(start, i),
      });
      continue;
    }
    // String literal (terminated or not — either way it is a string token).
    if (c === "'" || c === '"') {
      const { end } = scanString(source, i);
      tokens.push({
        kind: "string",
        start: i,
        end,
        value: source.slice(i, end),
      });
      i = end;
      continue;
    }
    // Identifier.
    if (isIdentStart(c)) {
      const start = i;
      while (i < source.length && isIdentChar(source[i])) i++;
      tokens.push({
        kind: "ident",
        start,
        end: i,
        value: source.slice(start, i),
      });
      continue;
    }
    // Operators / punctuation (longest match first).
    let matched: string | undefined;
    let kind: FormulaTokenKind = "op";
    for (const op of OPS) {
      if (source.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (matched === undefined) {
      for (const p of PUNCT) {
        if (source.startsWith(p, i)) {
          matched = p;
          kind = "punct";
          break;
        }
      }
    }
    if (matched !== undefined) {
      tokens.push({ kind, start: i, end: i + matched.length, value: matched });
      i += matched.length;
      continue;
    }
    // Anything else: single unknown char, always making progress.
    tokens.push({ kind: "unknown", start: i, end: i + 1, value: c });
    i++;
  }
  return tokens;
}

/**
 * Try to match a complete model reference starting at token index `i`
 * (which must be an accessor ident).  On success returns the chip plus the
 * end offsets of its exact source span; on any deviation from the required
 * syntax returns null and the caller treats the tokens as plain text.
 *
 * Required shape: accessor ( <string-literal> ) ( . ident )+
 * — except `reg`, where the property chain is optional.
 */
function matchChip(
  source: string,
  tokens: readonly FormulaToken[],
  i: number,
): { start: number; end: number; chip: FormulaChip } | null {
  const head = tokens[i];
  if (
    head.kind !== "ident" ||
    !ACCESSORS.has(head.value as FormulaChip["accessor"])
  )
    return null;
  const accessor = head.value as FormulaChip["accessor"];

  const open = tokens[i + 1];
  if (open === undefined || open.kind !== "punct" || open.value !== "(")
    return null;

  const arg = tokens[i + 2];
  if (arg === undefined || arg.kind !== "string" || arg.end - arg.start < 2)
    return null;
  // An unterminated literal cannot ground a chip (`pipe('x` stays text).
  const quote = source[arg.start];
  if (source[arg.end - 1] !== quote) return null;
  const id = decodeStringLiteral(source.slice(arg.start + 1, arg.end - 1));

  const close = tokens[i + 3];
  if (close === undefined || close.kind !== "punct" || close.value !== ")")
    return null;

  // Property chain: (. ident)*
  const properties: string[] = [];
  let end = close.end;
  let j = i + 4;
  for (;;) {
    const dot = tokens[j];
    const name = tokens[j + 1];
    if (
      dot !== undefined &&
      name !== undefined &&
      dot.kind === "punct" &&
      dot.value === "." &&
      name.kind === "ident"
    ) {
      properties.push(name.value);
      end = name.end;
      j += 2;
      continue;
    }
    break;
  }

  // A dangling trailing dot (`pipe('a').`) is incomplete: reject the whole
  // reference so it stays plain text, as required.
  if (source[end] === ".") return null;

  // References must read at least one property — except `reg('name')`,
  // which resolves to the registered value on its own.
  if (accessor !== "reg" && properties.length === 0) return null;

  const label =
    properties.length > 0 ? `${id} · ${properties[properties.length - 1]}` : id;
  return { start: head.start, end, chip: { accessor, id, properties, label } };
}

/**
 * Segment `source` into an alternating run of exact-span text and chip
 * segments covering the whole source.  Only syntactically complete model
 * references become chips; everything else (including malformed or
 * incomplete references) stays text.  Never throws.
 */
export function segmentFormula(source: string): FormulaSegment[] {
  const segments: FormulaSegment[] = [];
  const tokens = tokenizeFormula(source);
  let cursor = 0;

  const pushText = (start: number, end: number): void => {
    if (end <= start) return;
    const last = segments[segments.length - 1];
    if (last !== undefined && last.type === "text" && last.end === start) {
      last.end = end;
      return;
    }
    segments.push({ type: "text", start, end });
  };

  let i = 0;
  while (i < tokens.length) {
    const match = matchChip(source, tokens, i);
    if (match !== null) {
      pushText(cursor, match.start);
      segments.push({
        type: "chip",
        start: match.start,
        end: match.end,
        chip: match.chip,
      });
      cursor = match.end;
      // Skip all tokens fully inside the chip span.
      while (i < tokens.length && tokens[i].end <= match.end) i++;
      continue;
    }
    i++;
  }
  pushText(cursor, source.length);
  return segments;
}

/**
 * Rebuild the source from segments.  With segments produced by
 * segmentFormula this reproduces the source EXACTLY; in general it
 * concatenates each span's slice in order.
 */
export function sourceFromSegments(
  source: string,
  segments: readonly FormulaSegment[],
): string {
  let out = "";
  for (const seg of segments) {
    out += source.slice(seg.start, seg.end);
  }
  return out;
}

/**
 * Delete a segment's exact source span.  The caret lands at the deletion
 * point (the removed span's start offset in the new source).  For chip
 * segments the whole reference source goes; for text segments just that
 * span.  Never throws.
 */
export function removeSegmentSource(
  source: string,
  segment: FormulaSegment,
): { source: string; caret: number } {
  const start = Math.max(0, Math.min(segment.start, segment.end));
  const end = Math.min(source.length, Math.max(segment.start, segment.end));
  return { source: source.slice(0, start) + source.slice(end), caret: start };
}

/**
 * Replace a chip segment with its plain-text reference source so the user
 * can edit it as text.  Returns the new source plus a selection covering
 * exactly the exploded text.  Text segments pass through unchanged
 * (selected) since there is nothing to explode.  Never throws.
 */
export function explodeSegmentSource(
  source: string,
  segment: FormulaSegment,
): { source: string; selectionStart: number; selectionEnd: number } {
  const start = Math.max(0, Math.min(segment.start, segment.end));
  const end = Math.min(source.length, Math.max(segment.start, segment.end));
  // The span already holds the exact reference source; keeping it in place
  // IS the explode — the chip rendering is what goes away.
  return { source, selectionStart: start, selectionEnd: end };
}
