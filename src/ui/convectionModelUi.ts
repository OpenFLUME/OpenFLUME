/**
 * convectionModelUi.ts — pure UI-side helpers for the convection
 * conductor's "Heat-transfer model" selector (PropertyPanel).
 *
 * A convection conductor is `{ kind: 'convection', h?, area, correlation? }`
 * (core/schema.ts): no correlation ⇒ h is specified directly; otherwise
 * `correlation.model` selects a named correlation or the 'custom' safe h
 * expression.  Core validation (core/validate.ts) remains the authority —
 * this module only adapts the schema for display and produces SENSIBLE
 * DEFAULTS for a model switch (one immutable/undoable commit, compatible
 * inputs preserved where possible).
 *
 * SPECIFIED h — one selector entry, one input box.  The schema keeps three
 * ways to say "I supply h myself", and which one a typed value lands in is
 * decided from the value itself, not from a second menu:
 *
 *   number             → `h: 100`
 *   static equation    → `h: { expr }`      resolved once before each solve
 *                                            over the model scope
 *                                            (core/paramBindings.ts)
 *   runtime equation   → `correlation: { model: 'custom', expression }`
 *                                            evaluated at each h-map refresh
 *                                            over the local flow/thermal scope
 *                                            (core/correlations.ts)
 *
 * An equation is RUNTIME when it reads at least one identifier of the custom-h
 * scope (Re, Pr, G, D, Tf, …) and no model accessor; everything else is a
 * static binding.  Defaulting to static is the safe half of that choice: a
 * static binding reports unknown identifiers as validation errors, whereas the
 * runtime path deliberately falls back to the h floor without complaining, so
 * a mixed or misspelled equation surfaces instead of silently degrading.
 *
 * Everything here is pure and DOM-free for unit testing.
 */
import {
  compileExpression,
  CUSTOM_H_SCOPE_IDENTIFIERS,
  isParameterExpression,
  type Conductor,
  type ExprNode,
} from "../core";
import { ACCESSOR_ORDER } from "./formulaCompletion";

/** Convection conductor type union member (schema Conductor['type']). */
export type ConvectionType = Extract<Conductor["type"], { kind: "convection" }>;
/** The correlation block as the UI edits it (formula-bindable diameter/flowArea). */
export type ConvectionCorrelationConfig = NonNullable<
  ConvectionType["correlation"]
>;

export type ConvectionModelKey =
  "specified" | "dittusBoelter" | "miropolskii" | "darrHartwig" | "ttWf";

/** Correlation model keys — every selector entry except specified h. */
export type ConvectionCorrelationKey = Exclude<ConvectionModelKey, "specified">;

export interface ConvectionModelInfo {
  /** Option label in the model select. */
  label: string;
  /** Concise hard requirement needed to run the model (validate.ts) shown
   *  under the select; undefined when the model runs as-is. Model theory,
   *  suitability guidance and equation references live in the docs, not
   *  the UI. */
  warning?: string;
}

export const CONVECTION_MODEL_INFO: Record<
  ConvectionModelKey,
  ConvectionModelInfo
> = {
  specified: {
    label: "Specified h (constant or equation)",
  },
  dittusBoelter: {
    label: "Dittus–Boelter",
    warning: "Requires the realFluid fluid model.",
  },
  miropolskii: {
    label: "Miropolskii film boiling",
    warning: "Requires the realFluid fluid model.",
  },
  darrHartwig: {
    label: "Darr–Hartwig chilldown",
    warning: "Requires the realFluid fluid model.",
  },
  ttWf: {
    label: "TT-WF chilldown",
    warning:
      "Requires the realFluid fluid model, transient mode, and a solid (non-ambient) wall endpoint with thermal mass.",
  },
};

/**
 * Selector key of the current conductor type.  Both "no correlation" (h is a
 * constant or a static binding) and the 'custom' model (h is a runtime
 * equation) are the ONE specified-h entry: they differ in what the user typed
 * into the h box, not in what they chose from the menu.
 */
export function convectionModelOf(type: ConvectionType): ConvectionModelKey {
  const model = type.correlation?.model;
  if (model === undefined || model === "custom") return "specified";
  return model as ConvectionModelKey;
}

/**
 * Correlation block to install when the user picks a new model in the
 * selector.  Sensible VALID defaults per model (validate.ts requirements):
 *
 *  - named models: diameter is required (positive); darrHartwig adds
 *    axialPosition; ttWf adds axialPosition + segmentLength.
 *
 * Compatible inputs are preserved across switches: diameter/flowArea keep
 * their values (including formula bindings). axialPosition (and
 * segmentLength, if set) survive on every model — not only between the
 * chilldown closures — so a value entered while Dittus–Boelter is selected is
 * still there when a sweep later writes `model: 'darrHartwig'`.
 * Model-specific extras that no longer apply (expression, params, fluidFront,
 * …) are dropped so the stored object stays valid.
 */
export function correlationForModel(
  model: ConvectionCorrelationKey,
  current: ConvectionCorrelationConfig | undefined,
): ConvectionCorrelationConfig {
  const diameter = current?.diameter ?? 0.05;
  const flowArea = current?.flowArea;
  const base: ConvectionCorrelationConfig = { model, diameter };
  if (flowArea !== undefined) base.flowArea = flowArea;
  if (current?.axialPosition !== undefined)
    base.axialPosition = current.axialPosition;
  if (current?.segmentLength !== undefined)
    base.segmentLength = current.segmentLength;

  switch (model) {
    case "dittusBoelter":
    case "miropolskii":
      return base;
    case "darrHartwig":
      return {
        ...base,
        axialPosition: current?.axialPosition ?? 1,
        ...(current?.inletLiquidReynolds !== undefined
          ? { inletLiquidReynolds: current.inletLiquidReynolds }
          : {}),
      };
    case "ttWf":
      return {
        ...base,
        axialPosition: current?.axialPosition ?? 1,
        segmentLength: current?.segmentLength ?? 1,
        ...(current?.inletLiquidReynolds !== undefined
          ? { inletLiquidReynolds: current.inletLiquidReynolds }
          : {}),
        ...(current?.frontEnergyFactor !== undefined
          ? { frontEnergyFactor: current.frontEnergyFactor }
          : {}),
        ...(current?.rewetHysteresisOffsetK !== undefined
          ? { rewetHysteresisOffsetK: current.rewetHysteresisOffsetK }
          : {}),
        ...(current?.fluidFront !== undefined
          ? { fluidFront: current.fluidFront }
          : {}),
      };
  }
}

/**
 * Custom-model block for a runtime h equation.  diameter/flowArea are both
 * OPTIONAL here and are never seeded: setting one silently adds D/flowArea
 * (and with them G/Re) to the equation's scope, which must stay the user's
 * explicit choice.  Geometry the user did set, and the named constants a
 * previous equation read, carry over.
 */
function customCorrelationFor(
  expression: string,
  current: ConvectionCorrelationConfig | undefined,
): ConvectionCorrelationConfig {
  return {
    model: "custom",
    ...(current?.diameter !== undefined ? { diameter: current.diameter } : {}),
    ...(current?.flowArea !== undefined ? { flowArea: current.flowArea } : {}),
    ...(current?.axialPosition !== undefined
      ? { axialPosition: current.axialPosition }
      : {}),
    ...(current?.segmentLength !== undefined
      ? { segmentLength: current.segmentLength }
      : {}),
    expression,
    ...(current?.model === "custom" && current.params !== undefined
      ? { params: { ...current.params } }
      : {}),
  };
}

/**
 * Full conductor `type` for a model selection — the ONE immutable/undoable
 * update committed by the UI.  Specified h drops the correlation block (h is
 * kept/seeded); the correlation models keep h as the documented
 * fallback/floor and preserve area (including a formula binding).
 *
 * Keys the selection REMOVES are present and undefined so a patching caller
 * (PropertyPanel's updateComp) deletes them instead of merging the previous
 * model's leftovers back in.
 */
export function convectionTypeForModel(
  model: ConvectionModelKey,
  current: ConvectionType,
): ConvectionType {
  const area = current.area;
  if (model === "specified") {
    // A runtime equation already IS specified h — keep it verbatim.
    if (current.correlation?.model === "custom") return current;
    return {
      kind: "convection",
      area,
      // Same default as the conductor creation / kind switch.
      h: current.h ?? 100,
      correlation: undefined,
    };
  }
  return {
    kind: "convection",
    area,
    h: current.h,
    correlation: correlationForModel(model, current.correlation),
  };
}

/* ------------------------------------------------------------------ */
/* Specified h: one input box, three stored forms                      */
/* ------------------------------------------------------------------ */

/** What the specified-h box holds, read off the stored conductor type. */
export type SpecifiedH =
  /** Literal SI value, or unset. */
  | { kind: "constant"; value: number | undefined }
  /** `h: { expr }` — resolved once per solve over the model scope. */
  | { kind: "static"; expr: string }
  /** `correlation.expression` — evaluated per h-map refresh, local scope. */
  | { kind: "runtime"; expr: string };

const RUNTIME_H_IDENTIFIERS = new Set<string>(CUSTOM_H_SCOPE_IDENTIFIERS);
const MODEL_ACCESSORS = new Set<string>(ACCESSOR_ORDER);

export function specifiedHOf(type: ConvectionType): SpecifiedH {
  const corr = type.correlation;
  if (corr?.model === "custom") {
    return {
      kind: "runtime",
      expr: typeof corr.expression === "string" ? corr.expression : "",
    };
  }
  // `h` is declared a number but carries a binding when one is stored.
  const h = type.h as number | { expr: string } | undefined;
  if (isParameterExpression(h)) return { kind: "static", expr: h.expr };
  return { kind: "constant", value: typeof h === "number" ? h : undefined };
}

/**
 * Where a typed h equation belongs: 'runtime' when it reads the local
 * flow/thermal scope and nothing from the model scope, else 'static'.
 * Source that does not compile is neither — a half-typed equation must stay
 * in whichever form it is already stored in, so an in-progress edit cannot
 * discard the geometry/params the finished equation will read.
 */
export function classifyHEquation(
  expr: string,
): "static" | "runtime" | "unparseable" {
  let ast: ExprNode;
  try {
    ast = compileExpression(expr).ast;
  } catch {
    return "unparseable";
  }
  let runtime = false;
  let modelScope = false;
  const visit = (node: ExprNode): void => {
    switch (node.type) {
      case "ident":
        if (RUNTIME_H_IDENTIFIERS.has(node.name)) runtime = true;
        return;
      case "call":
        if (
          node.callee.type === "ident" &&
          MODEL_ACCESSORS.has(node.callee.name)
        )
          modelScope = true;
        visit(node.callee);
        node.args.forEach(visit);
        return;
      case "prop":
        visit(node.object);
        return;
      case "unary":
        visit(node.arg);
        return;
      case "binary":
        visit(node.left);
        visit(node.right);
        return;
      case "cond":
        visit(node.cond);
        visit(node.then);
        visit(node.else);
        return;
      default:
        return;
    }
  };
  visit(ast);
  return runtime && !modelScope ? "runtime" : "static";
}

/**
 * Conductor `type` for a value committed in the specified-h box — the ONE
 * immutable/undoable update.  A constant or static equation clears the
 * correlation; a runtime equation moves into a custom correlation and clears
 * `h`, so the box the user is looking at is the only place h comes from (a
 * floor is written into the equation itself, e.g. `max(<eq>, 100)`).
 *
 * Source that does not compile is stored verbatim in the form it already had
 * — never discarded, exactly like a broken formula in any other field: the
 * editor and validate.ts report the parse error against it.
 */
export function convectionTypeForSpecifiedH(
  next: number | { expr: string } | undefined,
  current: ConvectionType,
): ConvectionType {
  const base = { kind: "convection" as const, area: current.area };
  if (next !== undefined && isParameterExpression(next)) {
    const kind = classifyHEquation(next.expr);
    const runtime =
      kind === "runtime" ||
      (kind === "unparseable" && current.correlation?.model === "custom");
    if (runtime) {
      return {
        ...base,
        h: undefined,
        correlation: customCorrelationFor(next.expr, current.correlation),
      };
    }
  }
  // schema.ts declares `h` as a number even though it is in the static
  // binding allowlist (core/formulaFields.ts) — the same loose typing every
  // bindable field uses, since resolution runs before the solver reads it.
  return { ...base, h: next as number | undefined, correlation: undefined };
}

/** Parse the params editor text: JSON object mapping names to finite
 *  numbers, or empty/blank for "no params". */
export function parseParamsText(
  text: string,
):
  | { ok: true; params: Record<string, number> | undefined }
  | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, params: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return {
      ok: false,
      error: `params must be a JSON object: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error:
        'params must be a JSON object mapping names to finite numbers, e.g. {"C": 0.023}',
    };
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, error: `param "${key}" must be a finite number` };
    }
  }
  return { ok: true, params: parsed as Record<string, number> };
}
