/**
 * format.ts — single engineering-number formatting philosophy.
 *
 * Replaces the three ad-hoc styles that had grown in the codebase
 * (toExponential tables, 6-sig-fig canvas floats, per-tick auto-scaled
 * chart axes). Everything numeric the user reads should flow through here:
 *
 *   formatSig(value)                 — one significant-figure rule everywhere
 *   resolveScale(values, kind, ...)  — ONE display unit per column/axis/legend
 *   formatWithUnit(value, kind, ...) — single value honouring user prefs
 *
 * Unit definitions are reused from units.ts — nothing is duplicated here.
 */
import {
  QuantityKind,
  UnitId,
  UnitPreferences,
  UNITS,
  getUnitDef,
  getBaseUnit,
} from "./units";

/** Lower/upper bounds of the plain-notation window for formatSig. */
const EXP_HI = 1e7;
const EXP_LO = 1e-4;

/**
 * Narrow a formula-bindable config field (core/schema.ts
 * `NumberOrExpression`) to its literal SI number for numeric
 * display/editing.  Formula-bound fields return undefined here — the
 * formula-capable editor (components/FormulaUnitInput.tsx) handles the
 * `{ expr }` form itself; plain numeric contexts never see it and the
 * stored model value is never touched (editors only ever WRITE plain
 * numbers or whole formula objects).
 */
export function siNumber(
  value: number | { expr: string } | undefined,
): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Significant-figures formatter.
 *
 * - `sigFigs` significant digits (default 4), trailing zeros stripped.
 * - Thousands separators for |v| >= 1000 (plain-notation window only).
 * - Exponential notation (`1.234e+8` / `1e-12`) only when |v| >= 1e7
 *   or |v| < 1e-4.
 * - 0 → "0"; non-finite → String(value).
 */
export function formatSig(value: number, sigFigs = 4): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= EXP_HI || abs < EXP_LO) {
    const [mant, exp] = value
      .toExponential(Math.max(1, sigFigs) - 1)
      .split("e");
    const cleanMant = mant.includes(".")
      ? mant.replace(/0+$/, "").replace(/\.$/, "")
      : mant;
    return `${cleanMant}e${exp}`;
  }
  // toPrecision can itself emit exponent form inside our window
  // (e.g. (9999.9).toPrecision(4) === '1.000e+4'); parseFloat collapses it
  // back to a plain number and strips insignificant trailing zeros.
  const rounded = parseFloat(value.toPrecision(Math.max(1, sigFigs)));
  const str = String(rounded);
  if (abs < 1000) return str;
  const dot = str.indexOf(".");
  const int = dot === -1 ? str : str.slice(0, dot);
  const withSep = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return dot === -1 ? withSep : `${withSep}${str.slice(dot)}`;
}

export interface ScaleChoice {
  /** Unit id from UNITS[kind] that was chosen. */
  unitId: UnitId;
  /** Display symbol, e.g. "kPa". */
  unitLabel: string;
  /**
   * Slope of the SI→display mapping: display = siValue * factor + offset.
   * Exact for ratio units; for offset units (°C/°F) use `convert` instead.
   */
  factor: number;
  /** Exact SI→display conversion (handles offset units correctly). */
  convert: (siValue: number) => number;
}

/**
 * The SI-prefix family eligible for auto-scaling, per kind. Ids only —
 * conversion factors are looked up in UNITS (units.ts stays the single
 * source of truth). bar/atm/psi, kg/h, L/min, min/h, in/ft etc. are
 * deliberately excluded: auto-scaling only ever picks a true SI-prefix
 * unit. Kinds absent here (temperature, time, angle, velocity, …) are
 * never auto-scaled.
 */
const AUTO_SCALE_FAMILY: Partial<Record<QuantityKind, UnitId[]>> = {
  pressure: ["Pa", "kPa", "MPa"],
  length: ["m", "mm", "cm"],
  area: ["m²", "cm²", "mm²"],
  volume: ["m³", "L"],
  massFlow: ["kg/s", "g/s"],
  density: ["kg/m³", "g/cm³"],
  power: ["W", "kW"],
  heatFlux: ["W/m²", "kW/m²"],
  specificHeat: ["J/(kg·K)", "kJ/(kg·K)"],
  specificEnergy: ["J/kg", "kJ/kg", "MJ/kg"],
  specificEntropy: ["J/(kg·K)", "kJ/(kg·K)"],
  viscosity: ["Pa·s", "cP", "µPa·s"],
};

/** Auto-scale candidates for a kind: allowlisted ids that exist in UNITS. */
function scaleCandidates(kind: QuantityKind) {
  const ids = AUTO_SCALE_FAMILY[kind] ?? [];
  const defs = UNITS[kind];
  return ids
    .map((id) => defs.find((d) => d.id === id))
    .filter((d): d is NonNullable<typeof d> => !!d);
}

/**
 * Pick ONE display unit for a whole column / axis / legend from the max
 * |value| (values are SI). Honors a non-base user preference verbatim;
 * when the preference is the base SI unit, auto-scales across the SI-prefix
 * family so the largest magnitude lands in [1, 1000) when possible.
 *
 * Degenerate input (empty / all-zero / non-finite) falls back to the base
 * unit. Kinds with fewer than two SI-prefix units (temperature, time, …)
 * are never auto-scaled.
 */
export function resolveScale(
  values: number[],
  kind: QuantityKind,
  unitId?: UnitId,
): ScaleChoice {
  const baseId = getBaseUnit(kind);
  const prefId = unitId ?? baseId;

  const choice = (id: UnitId): ScaleChoice => {
    const def = getUnitDef(kind, id);
    const slope = def.fromSI(1) - def.fromSI(0);
    return {
      unitId: def.id,
      unitLabel: def.symbol,
      factor: slope,
      convert: (v) => def.fromSI(v),
    };
  };

  // A non-base preference is explicit: respect it, no auto-scaling.
  if (prefId !== baseId) return choice(prefId);

  const candidates = scaleCandidates(kind);
  if (candidates.length < 2) return choice(baseId);

  let maxAbs = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    const a = Math.abs(v);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs === 0) return choice(baseId);

  // Ascending by SI factor; choose the largest factor that still keeps
  // maxAbs/factor >= 1 (i.e. display magnitude in [1, 1000) when reachable).
  const sorted = [...candidates].sort((a, b) => a.toSI(1) - b.toSI(1));
  let picked = sorted[0];
  for (const def of sorted) {
    if (maxAbs / def.toSI(1) >= 1) picked = def;
  }
  return choice(picked.id);
}

/**
 * Format a single SI value with its unit, respecting user preferences
 * (auto-scales base-SI preferences via resolveScale).
 */
export function formatWithUnit(
  value: number,
  kind: QuantityKind,
  unitPrefs?: Partial<UnitPreferences>,
  sigFigs = 4,
): string {
  const unitId = unitPrefs?.[kind] ?? getBaseUnit(kind);
  const scale = resolveScale([value], kind, unitId);
  return formatInScale(value, scale, sigFigs);
}

/** Format an SI value in a previously resolved scale (chart ticks, table cells). */
export function formatInScale(
  value: number,
  scale: ScaleChoice,
  sigFigs = 4,
): string {
  const num = formatSig(scale.convert(value), sigFigs);
  return scale.unitLabel === "-" ? num : `${num} ${scale.unitLabel}`;
}

/**
 * Snap a comparison delta (current − baseline, in display units) to +0 when
 * it is below what the display can meaningfully show for the compared
 * magnitude — floating-point / display noise, not a physical change.
 *
 * Guards against `-5.684e-14 K` delta cells between runs that differ only in
 * FP association order (e.g. 300 vs 300.00000000000006 K). The floor is the
 * larger of:
 *   - half of the last displayed digit of the reference at `sigFigs`
 *     (a delta smaller than that cannot be seen in the displayed pair), and
 *   - 16 ULP of the reference magnitude (pure representation noise).
 *
 * Returns canonical +0 for clamped (and signed-zero) deltas so callers
 * render "+0"/"0", never "-0". Non-finite deltas pass through unchanged.
 * CSV exports should carry the RAW full-precision delta — clamp only what is
 * displayed.
 */
export function clampDisplayDelta(
  delta: number,
  reference: number,
  sigFigs = 4,
): number {
  if (!Number.isFinite(delta)) return delta;
  if (delta === 0) return 0;
  const ref = Math.abs(reference);
  const fpFloor = Math.max(1, ref) * Number.EPSILON * 16;
  const mag = ref > 0 ? Math.pow(10, Math.floor(Math.log10(ref))) : 1;
  const displayFloor = (mag * Math.pow(10, -(Math.max(1, sigFigs) - 1))) / 2;
  return Math.abs(delta) <= Math.max(fpFloor, displayFloor) ? 0 : delta;
}
