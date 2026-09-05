/**
 * rewriteIds.ts — entity-id rewriting inside user formula expressions.
 *
 * Used by core-side authoring transforms (e.g. repeating/discretizing a
 * subgraph, where every reference to an original entity must be repointed
 * at its per-copy counterpart) without leaving core or re-serializing the
 * whole expression.
 *
 * Built on the tolerant segmenter of ./formulaTokens: only syntactically
 * complete model references are rewritten; everything else — whitespace,
 * operators, property chains, quote style, and any malformed or partial
 * reference — is preserved byte-for-byte.
 */

import { quoteFormulaId, segmentFormula } from "./formulaTokens";

/**
 * Rewrite entity ids inside a user formula expression.
 *
 * Every syntactically complete model reference whose DECODED id argument
 * has an entry in `idMap` gets its id string literal re-encoded in place
 * (escapes resolved, original quote character kept); the rest of the source
 * — whitespace, operators, the property chain, and any malformed or
 * incomplete reference — is preserved EXACTLY.  Only the id literal span
 * (quotes included) is ever replaced.
 *
 * Semantics and caveats:
 *  - The map is keyed by PLAIN id and applies to every entity accessor
 *    (pipe, heatedPipe, bend, branch, node, conductor, solid).  Ids are not
 *    matched per-accessor: fluid and solid nodes share one id namespace and
 *    branches another, but nothing stops an id string from colliding ACROSS
 *    accessors (a pipe 'n1' next to a node 'n1') — such a string is
 *    remapped wherever it appears.  Callers are expected to build a
 *    disjoint map per authoring operation, so this cannot bite in practice.
 *  - `reg('name')` references a REGISTER, not an entity.  Register names
 *    live in their own namespace (config.registers) and are never remapped
 *    by an entity id map, so reg chips are always skipped.
 *  - Identity: if `idMap` is empty or no reference matches, `source` is
 *    returned unchanged.
 *  - Never throws, on any input (the segmenter it is built on is tolerant
 *    by design).
 */
export function rewriteExpressionIds(
  source: string,
  idMap: ReadonlyMap<string, string>,
): string {
  if (typeof source !== "string") return "";
  // A null/undefined map (JS callers) degrades to "nothing to rewrite".
  if (idMap == null || source.length === 0 || idMap.size === 0) return source;

  const segments = segmentFormula(source);
  let out = source;
  // Splice from the END of the source backwards: chip spans are offsets
  // into the original source, and replacing later spans first keeps every
  // earlier span valid in `out`.
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg.type !== "chip") continue;
    if (seg.chip.accessor === "reg") continue; // registers, not entities
    const replacement = idMap.get(seg.chip.id);
    if (typeof replacement !== "string") continue;
    const { idStart, idEnd } = seg.chip;
    // Keep the reference's original quote style; escapeFormulaId escapes
    // the active quote, so this always yields a valid literal.
    const quote = source[idStart] === '"' ? '"' : "'";
    out =
      out.slice(0, idStart) +
      quoteFormulaId(replacement, quote) +
      out.slice(idEnd);
  }
  return out;
}
