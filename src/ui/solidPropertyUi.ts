/**
 * solidPropertyUi.ts — pure UI-side helpers for editing solid property
 * specs (core/schema.ts `SolidPropertySpec = number | { table } | { material }
 * | { expression, tRange } | { timeTable }`) in the PropertyPanel /
 * ModelTableView.
 *
 * Everything here is pure and DOM-free so the mode/default/summary logic is
 * unit-testable without rendering.  Core semantics (validation constraints,
 * material registry, clamping, expression sampling) come from
 * core/solidProperties.ts — this module never re-implements them, it only
 * adapts them for display.
 */
import type { SolidPropertySpec } from "../core";
import {
  SOLID_MATERIALS,
  getSolidMaterialTable,
  sampleExpressionProperty,
  PiecewiseLinearProperty,
} from "../core";
import type { QuantityKind } from "./units";
import { formatSig } from "./format";

/** The property fields this editor supports (schema SolidPropertySpec sites). */
export type SolidPropertyKind = "cp" | "k";

/** Editing mode of a spec, derived from its shape. */
export type SolidPropertyMode =
  "constant" | "material" | "table" | "expression" | "timeTable";

export interface SolidPropertyUiInfo {
  /** Config-field label used in UI copy ('cp' | 'k'). */
  label: string;
  /** Quantity kind of the property VALUE (for unit-aware display/paste). */
  valueKind: QuantityKind;
  /** Plain-text SI unit for hints/summaries. */
  siUnit: string;
  /**
   * Fallback constant when a mode switch cannot derive a value from the
   * current spec (matches the app's own creation defaults: new solid nodes
   * use cp 500; the conductor kind-switch uses k 1).
   */
  defaultConstant: number;
}

export const SOLID_PROPERTY_INFO: Record<
  SolidPropertyKind,
  SolidPropertyUiInfo
> = {
  cp: {
    label: "cp",
    valueKind: "specificHeat",
    siUnit: "J/(kg·K)",
    defaultConstant: 500,
  },
  k: {
    label: "k",
    valueKind: "thermalConductivity",
    siUnit: "W/(m·K)",
    defaultConstant: 1,
  },
};

/** Human-facing material names (raw registry keys stay the stored value). */
const MATERIAL_LABELS: Record<string, string> = {
  "ofhc-copper": "OFHC copper",
  "grcop-84": "GRCop-84",
  "aluminum-6061-t6": "Aluminum 6061-T6",
  "stainless-steel-304": "Stainless steel 304",
  "stainless-steel-316": "Stainless steel 316",
  "inconel-718": "Inconel 718",
  ptfe: "PTFE (Teflon)",
  "g10-cr-normal": "G-10 CR (normal direction)",
  "g10-cr-warp": "G-10 CR (warp direction)",
};

export function materialLabel(key: string): string {
  return MATERIAL_LABELS[key] ?? key;
}

/** Mode of the current spec; undefined/unknown shapes count as 'constant'
 *  (the legacy editor already treats them as an empty constant field).
 *  Every nonnumeric schema shape maps to its own mode so hand-authored
 *  expression/timeTable specs never render as a blank constant field. */
export function specMode(
  spec: SolidPropertySpec | { expr: string } | undefined,
): SolidPropertyMode {
  if (spec !== undefined && typeof spec === "object" && spec !== null) {
    if ("table" in spec) return "table";
    if ("material" in spec) return "material";
    if ("expression" in spec) return "expression";
    if ("timeTable" in spec) return "timeTable";
    // `{ expr }` is a constant formula (paramBindings), not a T-equation.
  }
  return "constant";
}

/**
 * Property value of a spec at `T` (K) — used for seeding a constant default
 * from a curve on an explicit mode switch.  Undefined when the spec is
 * malformed (validateSolidPropertySpec surfaces the concrete error), and
 * undefined for the timeTable shape (a time-varying property has no
 * temperature value).
 */
export function specValueAt(
  spec: SolidPropertySpec | { expr: string } | undefined,
  property: SolidPropertyKind,
  T: number,
): number | undefined {
  if (spec === undefined) return undefined;
  if (typeof spec === "number") return spec;
  if ("expr" in spec && !("expression" in spec)) return undefined;
  try {
    if ("table" in spec)
      return new PiecewiseLinearProperty(spec.table).value(T);
    if ("material" in spec)
      return new PiecewiseLinearProperty(
        getSolidMaterialTable(spec.material, property),
      ).value(T);
    if ("expression" in spec && "tRange" in spec) {
      return sampleExpressionProperty(spec, property, "property editor").value(
        T,
      );
    }
    return undefined; // timeTable: time-varying, no T value
  } catch {
    return undefined;
  }
}

/** [minT, maxT] of a table spec, or null when not a (non-empty) table. */
export function tableRangeK(
  spec: SolidPropertySpec | undefined,
): [number, number] | null {
  if (
    spec === undefined ||
    typeof spec === "number" ||
    !("table" in spec) ||
    spec.table.length === 0
  )
    return null;
  return [spec.table[0][0], spec.table[spec.table.length - 1][0]];
}

/**
 * Compact summary for audit surfaces (ModelTableView): constants format bare
 * (callers label the unit), tables as `N-pt table`, materials by name,
 * temperature equations as `T equation`, time tables as `N-pt time table`.
 */
export function specSummaryShort(
  spec: SolidPropertySpec | { expr: string } | undefined,
): string {
  if (spec === undefined) return "—";
  if (typeof spec === "number") return formatSig(spec, 4);
  if ("expr" in spec && !("expression" in spec)) return "formula";
  if ("table" in spec) return `${spec.table.length}-pt table`;
  if ("material" in spec) return materialLabel(spec.material);
  if ("expression" in spec) return "T equation";
  return `${spec.timeTable.length}-pt time table`;
}

/**
 * Spec to install when the user EXPLICITLY picks a new mode in the selector
 * (the only path that may replace a table/material with another shape — the
 * per-mode editors themselves always write back the same shape).
 *
 * Seeding rules (never mutate the current spec):
 *  - constant: keep a current constant; otherwise evaluate the current
 *    table/material curve at `referenceT` (node temperature, default 300 K);
 *    last resort is the property's default constant.
 *  - material: keep a current (known) material; otherwise the first registry
 *    entry.
 *  - table: keep a current table; from a material seed the material curve's
 *    own endpoint knots; from a constant seed a flat 2-point table spanning
 *    [referenceT/2, 2·referenceT] (clamped to positive K).
 *  - expression: keep a current expression spec; otherwise seed a constant
 *    expression from the derivable value with tRange spanning
 *    [referenceT/2, 2·referenceT] (clamped to positive K).
 *  - timeTable: keep a current time table; otherwise seed a flat 2-point
 *    time table [[0, v], [100, v]] from the derivable value.
 */
export function specForMode(
  mode: SolidPropertyMode,
  current: SolidPropertySpec | { expr: string } | undefined,
  property: SolidPropertyKind,
  referenceT = 300,
): SolidPropertySpec {
  const info = SOLID_PROPERTY_INFO[property];
  const Tref = Number.isFinite(referenceT) && referenceT > 0 ? referenceT : 300;
  switch (mode) {
    case "constant": {
      if (typeof current === "number") return current;
      if (
        current !== undefined &&
        typeof current === "object" &&
        "expr" in current &&
        !("expression" in current)
      ) {
        return current as unknown as SolidPropertySpec;
      }
      const v = specValueAt(current, property, Tref);
      return v !== undefined && Number.isFinite(v) && v > 0
        ? v
        : info.defaultConstant;
    }
    case "material": {
      if (
        current !== undefined &&
        typeof current === "object" &&
        "material" in current &&
        SOLID_MATERIALS[current.material]
      ) {
        return current;
      }
      return { material: Object.keys(SOLID_MATERIALS)[0] };
    }
    case "table": {
      if (
        current !== undefined &&
        typeof current === "object" &&
        "table" in current
      ) {
        return {
          table: current.table.map(([T, v]) => [T, v] as [number, number]),
        };
      }
      if (
        current !== undefined &&
        typeof current === "object" &&
        "material" in current &&
        SOLID_MATERIALS[current.material]
      ) {
        const knots = getSolidMaterialTable(current.material, property);
        return {
          table: [
            [knots[0][0], knots[0][1]],
            [knots[knots.length - 1][0], knots[knots.length - 1][1]],
          ],
        };
      }
      const v =
        typeof current === "number" && current > 0 && Number.isFinite(current)
          ? current
          : info.defaultConstant;
      return {
        table: [
          [Math.max(1, Tref / 2), v],
          [Tref * 2, v],
        ],
      };
    }
    case "expression": {
      if (
        current !== undefined &&
        typeof current === "object" &&
        "expression" in current
      ) {
        return {
          expression: current.expression,
          tRange: [current.tRange[0], current.tRange[1]],
        };
      }
      // Seed from the derivable value at the reference temperature (a
      // constant expression), spanning the same T window as the table seed.
      const v = specValueAt(current, property, Tref);
      const seed =
        v !== undefined && Number.isFinite(v) && v > 0
          ? v
          : info.defaultConstant;
      return {
        expression: formatSig(seed, 6),
        tRange: [Math.max(1, Tref / 2), Tref * 2],
      };
    }
    case "timeTable": {
      if (
        current !== undefined &&
        typeof current === "object" &&
        "timeTable" in current
      ) {
        return {
          timeTable: current.timeTable.map(
            ([t, v]) => [t, v] as [number, number],
          ),
        };
      }
      const v = specValueAt(current, property, Tref);
      const seed =
        v !== undefined && Number.isFinite(v) && v > 0
          ? v
          : info.defaultConstant;
      return {
        timeTable: [
          [0, seed],
          [100, seed],
        ],
      };
    }
  }
}
