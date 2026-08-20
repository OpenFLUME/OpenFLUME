import { QuantityKind, UnitId, getUnitDef, getBaseUnit } from "../units";
import { formatSig } from "../format";

/** Okabe-Ito-ish series palette, tuned for the dark console. */
export const SERIES_PALETTE = [
  "#56b4e9",
  "#e69f00",
  "#7ac74f",
  "#cc79a7",
  "#f0e442",
  "#0072b2",
  "#d55e00",
  "#999999",
];

/**
 * Stable series color: the same series id lands on the same palette slot on
 * every chart (FNV-1a hash → index), so "tank" is the same color everywhere.
 */
export function seriesColor(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return SERIES_PALETTE[(h >>> 0) % SERIES_PALETTE.length];
}

export interface SeriesColorInput {
  id: string;
  /** Preferred color (usually the stable hash color). */
  color?: string;
  /** Series locked to another series' resolved color (baseline overlays). */
  matchColorOf?: string;
}

/**
 * Per-chart color assignment: stable per series id ACROSS charts, but hash
 * collisions are resolved WITHIN a chart so two visible series never share a
 * color. Collision resolution walks forward from the preferred palette slot
 * (deterministic). `matchColorOf` followers (e.g. baseline overlays) take
 * exactly their primary's resolved color so a dashed baseline pair is always
 * visually bound to its solid primary.
 */
export function assignSeriesColors(
  series: SeriesColorInput[],
): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const s of series) {
    if (s.matchColorOf) continue;
    let c = s.color ?? seriesColor(s.id);
    if (used.has(c)) {
      const startIdx = Math.max(0, SERIES_PALETTE.indexOf(c));
      let found: string | undefined;
      for (let k = 1; k < SERIES_PALETTE.length; k++) {
        const cand = SERIES_PALETTE[(startIdx + k) % SERIES_PALETTE.length];
        if (!used.has(cand)) {
          found = cand;
          break;
        }
      }
      if (found) c = found;
    }
    out.set(s.id, c);
    used.add(c);
  }
  for (const s of series) {
    if (!s.matchColorOf) continue;
    out.set(s.id, out.get(s.matchColorOf) ?? s.color ?? seriesColor(s.id));
  }
  return out;
}

/**
 * Tick labels that never repeat on a near-degenerate domain: format at the
 * requested precision, and if any two labels collide escalate significant
 * figures (up to 10) until they are distinct.
 */
function tickLabels(ticks: number[], sigFigs = 4): string[] {
  for (let f = sigFigs; f <= 10; f++) {
    const labels = ticks.map((t) => formatSig(t, f));
    if (new Set(labels).size === labels.length) return labels;
  }
  return ticks.map((t) => formatSig(t, 10));
}

/**
 * Pair ticks with their deduplicated labels, dropping ticks whose label
 * duplicates an earlier one even at max precision (truly identical values).
 */
export function dedupeTicks(
  ticks: number[],
  sigFigs = 4,
): Array<{ value: number; label: string }> {
  const labels = tickLabels(ticks, sigFigs);
  const seen = new Set<string>();
  const out: Array<{ value: number; label: string }> = [];
  for (let i = 0; i < ticks.length; i++) {
    if (seen.has(labels[i])) continue;
    seen.add(labels[i]);
    out.push({ value: ticks[i], label: labels[i] });
  }
  return out;
}

/**
 * A domain whose span is within a few ULPs of the data magnitude is
 * DEGENERATE: no representable step can advance the loop (`v + step === v`,
 * which previously produced an unbounded array → RangeError crash). Relative
 * to max(1, |min|, |max|) so genuine tiny ranges near zero (e.g. a 1e-12 kg/s
 * trickle) are still honored — only representation-noise spans are padded.
 */
const DEGENERATE_REL_EPS = Number.EPSILON * 8;
/** Hard cap on emitted ticks, regardless of step/domain arithmetic. */
export const MAX_TICKS = 100;

export function niceTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) && !Number.isFinite(max)) return [0];
  if (!Number.isFinite(min)) return [max];
  if (!Number.isFinite(max)) return [min];
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  const scale = Math.max(1, Math.abs(lo), Math.abs(hi));
  let range = hi - lo;
  if (range === 0) return [lo];
  if (range <= DEGENERATE_REL_EPS * scale) {
    // Sub-ULP span (e.g. 300 vs 300.00000000000006): pad ±1% (±0.01 near 0)
    // so ticks can differ at all instead of looping on an invisible step.
    const pad = Math.max(scale * 0.01, 0.01);
    lo -= pad;
    hi += pad;
    range = hi - lo;
  }
  const roughStep = range / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const msd = roughStep / mag;
  let step = mag;
  if (msd > 5) step = 10 * mag;
  else if (msd > 2) step = 5 * mag;
  else if (msd > 1) step = 2 * mag;
  if (!Number.isFinite(step) || step <= 0) return [lo, hi];
  let start = Math.floor(lo / step) * step;
  if (!Number.isFinite(start)) start = lo;
  const ticks: number[] = [];
  for (let v = start; v <= hi + step * 0.5 && ticks.length < MAX_TICKS;) {
    if (v >= lo - step * 0.5) ticks.push(Number(v.toPrecision(12)));
    const next = v + step;
    if (next === v) break; // step below the ULP of v — can never advance again
    v = next;
  }
  return ticks.length > 0 ? ticks : [lo, hi];
}

export function clampDomain(
  [d0, d1]: [number, number],
  min: number,
  max: number,
): [number, number] {
  let a = d0;
  let b = d1;
  if (a < min) {
    b += min - a;
    a = min;
  }
  if (b > max) {
    a -= b - max;
    b = max;
  }
  if (a < min) a = min;
  if (b < a) b = a;
  return [a, b];
}

export function formatNumber(v: number): string {
  if (!isFinite(v)) return String(v);
  if (v === 0) return "0";
  const s = v.toPrecision(6);
  return parseFloat(s).toString();
}

export function formatValue(
  v: number,
  kind: QuantityKind,
  unitId: UnitId,
): string {
  const def = getUnitDef(kind, unitId);
  const valInUnit = def.fromSI(v);
  const isBase = unitId === getBaseUnit(kind);

  if (isBase) {
    const abs = Math.abs(valInUnit);
    if (kind === "pressure") {
      if (abs >= 1e6) return `${(valInUnit / 1e6).toFixed(2)} MPa`;
      if (abs >= 1e3) return `${(valInUnit / 1e3).toFixed(1)} kPa`;
      return `${valInUnit.toFixed(0)} Pa`;
    }
    if (kind === "massFlow") {
      if (abs >= 1) return `${valInUnit.toFixed(3)} kg/s`;
      if (abs >= 1e-3) return `${(valInUnit * 1000).toFixed(2)} g/s`;
      return `${(valInUnit * 1e6).toFixed(1)} mg/s`;
    }
    if (kind === "temperature") {
      return `${valInUnit.toFixed(1)} K`;
    }
    if (kind === "velocity") {
      return `${valInUnit.toFixed(2)} m/s`;
    }
    if (kind === "density") {
      return `${valInUnit.toFixed(2)} kg/m³`;
    }
  }

  const formatted = formatNumber(valInUnit);
  return `${formatted} ${def.symbol}`;
}
