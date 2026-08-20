/**
 * formulaBinding.ts — pure UI-side helpers for formula-capable numeric
 * fields (core/schema.ts `NumberOrExpression`; core/paramBindings.ts is the
 * resolution authority).
 *
 * Everything here is pure and DOM-free so the parse/preview/error logic is
 * unit-testable without rendering.  The preview path ALWAYS goes through
 * core's previewNetworkParameters — it never re-implements the static scope,
 * and it never mutates the config (resolveNetworkParameters is pure; the
 * probe clone built for candidate previews is discarded).
 *
 * UX contract implemented by FormulaUnitInput on top of these helpers:
 *  - literal text behaves exactly like UnitInput (parse on blur/Enter, SI
 *    conversion in the field's display unit);
 *  - expressions are recognized with or without a leading `=` and stored as
 *    `{ expr }`; plain finite numbers remain literals;
 *  - a formula-bound field shows an ƒ badge, the expression, and a resolved
 *    preview in the current display unit (`→ 0.152 m²`);
 *  - parse/dependency/range errors render inline WITHOUT deleting the
 *    formula (the stored model value is only replaced by an explicit
 *    commit);
 *  - "Use resolved value" reverts the field to the resolved literal.
 */
import type { NetworkConfig } from "../core";
import {
  compileExpression,
  ExpressionError,
  isParameterExpression,
  previewNetworkParameters,
} from "../core";

/** Value of a formula-bindable numeric field (NumberOrExpression, optional). */
export type BindableValue = number | { expr: string } | undefined;

/** Result of classifying raw input text (BEFORE any unit conversion). */
export type FormulaInputParse =
  | { kind: "empty" }
  | { kind: "literal"; text: string }
  | { kind: "formula"; expr: string };

/**
 * Classify raw field text. A leading `=` remains accepted, but users do not
 * need to know that convention: any non-numeric text is an expression.
 * Transitional numeric edits such as `-` stay literal so typing a negative
 * number never flips into formula mode prematurely.
 */
export function parseFormulaInput(raw: string): FormulaInputParse {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "empty" };
  if (trimmed.startsWith("="))
    return { kind: "formula", expr: trimmed.slice(1).trim() };
  const finiteNumber = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(
    trimmed,
  );
  const partialNumber =
    /^[+-]?(?:\.|(?:\d+\.?\d*|\.\d+)[eE][+-]?)$/.test(trimmed) ||
    /^[+-]$/.test(trimmed);
  if (finiteNumber || partialNumber) {
    return { kind: "literal", text: trimmed };
  }
  return { kind: "formula", expr: trimmed };
}

/** Fast parse-only check of a candidate expression (no model scope). */
export function expressionParseError(expr: string): string | null {
  try {
    compileExpression(expr);
    return null;
  } catch (e) {
    return e instanceof ExpressionError ? e.message : String(e);
  }
}

/** Field-local preview of a COMMITTED formula binding. */
export type FormulaPreview =
  { status: "ok"; value: number } | { status: "error"; errors: string[] };

/**
 * Preview the formula bound at `path` against the static model scope.
 *
 * Pure: previewNetworkParameters never mutates `config` and is never routed
 * through the store/history.  `path` is the readable field path used as the
 * `resolved` map key and the error prefix, e.g. "branch 'seg1'.diameter"
 * (see core/paramBindings.ts collectBindings).
 *
 * Errors are filtered to this field: a broken formula ELSEWHERE in the
 * model must not mask this field's own preview (its own error is still
 * reported, since resolveNetworkParameters attributes every failure to its
 * field path).
 */
export function previewBoundField(
  config: NetworkConfig,
  path: string,
): FormulaPreview {
  const result = previewNetworkParameters(config);
  if (result.ok) {
    const value = result.resolved[path];
    if (value === undefined) {
      return {
        status: "error",
        errors: [`${path}: no formula binding is stored here`],
      };
    }
    return { status: "ok", value };
  }
  const prefix = `Parameter binding ${path}: `;
  const own = result.errors
    .filter((e) => e.startsWith(prefix))
    .map((e) => e.slice(prefix.length));
  if (own.length > 0) return { status: "error", errors: own };
  const cyclePrefix = "Parameter binding cycle: ";
  const cyclic = result.errors
    .filter((e) => e.startsWith(cyclePrefix) && e.includes(path))
    .map((e) => e.slice(cyclePrefix.length));
  if (cyclic.length > 0) return { status: "error", errors: cyclic };
  // The failure belongs to another field; this field's own value is simply
  // not resolvable until that is fixed.
  return {
    status: "error",
    errors: [`unresolved while another formula in the model has errors`],
  };
}

/** True when the value holds a formula object. */
export function isFormulaBound(value: unknown): value is { expr: string } {
  return isParameterExpression(value);
}

/** One-line scope reminder shown under formula-capable fields. */
export const FORMULA_SCOPE_HELP =
  "Browse clickable model values and functions with f(x). Scope: pipe('id').length/.diameter/.area/.volume/.surfaceArea, " +
  "heatedPipe('id').ua, node('id').volume, conductor('id').area/…, reg('name'); helpers circleArea(d), circleDiameter(a), " +
  "cylinderVolume(L,d), cylinderArea(L,d); builtins min/max/sqrt/exp/log/…/pi.";

/** Static-semantics note: resolved once, SI, no solver state. */
export const FORMULA_SEMANTICS_HELP =
  "Formulas use SI units and are resolved once against the static model before each solve — " +
  "no t, no solver state (P/T/ṁ/…), no schedules.";
