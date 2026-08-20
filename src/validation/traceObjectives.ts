/**
 * Trace objectives — pure functions comparing model-predicted wall-
 * temperature traces against the digitized NBS-9264 corpus, per the
 * pre-registered calibration protocol
 * (§6).  NO calibration lives here; these are the metric/feature primitives
 * a future fit will compose.
 *
 * ============================================================================
 * CONVENTIONS (all binding, all documented in the protocol)
 * ============================================================================
 * 1. ALIGNMENT (§6.1): model and data are compared on the MODEL's own time
 *    samples restricted to the support OVERLAP window; the data trace is
 *    linearly interpolated onto those times.  The experiment is NEVER
 *    extrapolated beyond its recorded support, and the model is compared
 *    at its native samples (no interpolation error added to the model).
 *    Robust to nonuniform timesteps on both sides.
 * 2. SMOOTH CROSSINGS ONLY (§6.2): every arrival/crossing time uses
 *    stationInterp.thresholdCrossingTime (linear interpolation between the
 *    bracketing samples).  The naive first-below crossing is a measured
 *    zero-gradient trap and is banned.
 * 3. RUN-LEVEL AGGREGATION (§4.3/§6.3): the physical RUN is the
 *    independent unit.  Stations are pooled WITHIN a run first (quality-
 *    weighted); runs are then aggregated with EQUAL weight — one 4-station
 *    run never outweighs a 1-usable-station run.
 * 4. QC-DRIVEN AVAILABILITY: features that need the cold tail (50 K
 *    crossing, knee, plateau, 150→50 K drop, chilldown time) are
 *    categorically UNAVAILABLE for traces flagged `coldTailUsable: false`
 *    (truncated / ambiguous tails).  Unavailable is reported with a reason
 *    — never extrapolated or invented.  A crossing landing in the FINAL
 *    sample interval of a record is always treated as unavailable (the
 *    record ends there; a true crossing cannot be distinguished from a
 *    truncation artifact).
 * 5. WEIGHTS: the per-trace `qualityWeight` comes from the corpus'
 *    documented provisional policy (nbsTraceCorpus.ts
 *    TRACE_QUALITY_WEIGHT_POLICY).  This is NOT a formal uncertainty
 *    model.
 */

import { interpolateAtPosition, thresholdCrossingTime } from './stationInterp';

// ---------------------------------------------------------------------------
// Basic shapes
// ---------------------------------------------------------------------------

/** A sampled trace: SI seconds + kelvin, equal length, ascending times. */
export interface TraceSample {
  timesS: number[];
  valuesK: number[];
}

/**
 * Minimal structural shape of a digitized DATA trace accepted by the
 * objectives.  `CorpusWallTempTrace` (nbsTraceCorpus.ts) satisfies this
 * structurally — no import needed, and the objectives stay pure/generic.
 */
export interface DataTraceLike extends TraceSample {
  station: 1 | 2 | 3 | 4;
  /** Provisional quality weight in [0.25, 1] (corpus QC policy). */
  qualityWeight: number;
  qc: { coldTailUsable: boolean };
}

// ---------------------------------------------------------------------------
// 1. Alignment + pointwise trace metrics
// ---------------------------------------------------------------------------

export interface AlignedTraces {
  /** Common grid: the model's time samples inside the overlap window. */
  timesS: number[];
  /** Model values at its native samples. */
  modelK: number[];
  /** Data values linearly interpolated onto the common grid. */
  dataK: number[];
  /** Overlap window [s].  Empty grid ⇒ start === end === NaN... */
  overlapStartS: number;
  overlapEndS: number;
}

function checkSample(name: string, tr: TraceSample): void {
  if (tr.timesS.length !== tr.valuesK.length) {
    throw new Error(`${name}: times (${tr.timesS.length}) / values (${tr.valuesK.length}) length mismatch`);
  }
  for (let i = 0; i < tr.timesS.length; i++) {
    if (!Number.isFinite(tr.timesS[i]) || !Number.isFinite(tr.valuesK[i])) {
      throw new Error(`${name}: non-finite sample at index ${i}`);
    }
    if (i > 0 && !(tr.timesS[i] > tr.timesS[i - 1])) {
      throw new Error(`${name}: times not strictly ascending at index ${i}`);
    }
  }
}

/**
 * Time-align a model trace and a data trace on a common domain.
 *
 * Common grid = the model's own time samples inside
 * [max(model.t0, data.t0), min(model.tEnd, data.tEnd)] — the support
 * overlap.  Data is linearly interpolated onto the grid
 * (interpolateAtPosition; inside the overlap this is exact interpolation,
 * never clamping/extrapolation).  If fewer than `minSamples` (default 2)
 * model samples fall inside the overlap, an EMPTY alignment is returned
 * and every downstream metric is `undefined` — a truncated/missing
 * comparison is reported, never padded.
 */
export function alignTraces(
  model: TraceSample,
  data: TraceSample,
  opts?: { minSamples?: number }
): AlignedTraces {
  checkSample('alignTraces(model)', model);
  checkSample('alignTraces(data)', data);
  const minSamples = opts?.minSamples ?? 2;
  const start = Math.max(model.timesS[0] ?? NaN, data.timesS[0] ?? NaN);
  const end = Math.min(
    model.timesS[model.timesS.length - 1] ?? NaN,
    data.timesS[data.timesS.length - 1] ?? NaN
  );
  const timesS: number[] = [];
  const modelK: number[] = [];
  const dataK: number[] = [];
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    for (let k = 0; k < model.timesS.length; k++) {
      const t = model.timesS[k];
      if (t < start || t > end) continue;
      timesS.push(t);
      modelK.push(model.valuesK[k]);
      dataK.push(interpolateAtPosition(data.timesS, data.valuesK, t));
    }
  }
  if (timesS.length < minSamples) {
    return { timesS: [], modelK: [], dataK: [], overlapStartS: start, overlapEndS: end };
  }
  return { timesS, modelK, dataK, overlapStartS: start, overlapEndS: end };
}

/** Root-mean-square model-minus-data error (K); undefined if no samples. */
export function traceRmseK(a: AlignedTraces): number | undefined {
  if (a.timesS.length === 0) return undefined;
  let acc = 0;
  for (let k = 0; k < a.timesS.length; k++) {
    const e = a.modelK[k] - a.dataK[k];
    acc += e * e;
  }
  return Math.sqrt(acc / a.timesS.length);
}

/** Mean absolute model-minus-data error (K); undefined if no samples. */
export function traceMaeK(a: AlignedTraces): number | undefined {
  if (a.timesS.length === 0) return undefined;
  let acc = 0;
  for (let k = 0; k < a.timesS.length; k++) acc += Math.abs(a.modelK[k] - a.dataK[k]);
  return acc / a.timesS.length;
}

/**
 * Normalized RMSE (dimensionless): RMSE / scaleK.
 *
 * Documented scale (protocol §6.1: "a fixed reference so runs contribute
 * comparably"): use `observedTemperatureSpanK` — the data trace's observed
 * initial-to-coldest span.  Returns undefined if RMSE is undefined or the
 * scale is not positive.
 */
export function traceNrmseK(a: AlignedTraces, scaleK: number): number | undefined {
  const rmse = traceRmseK(a);
  if (rmse === undefined || !(scaleK > 0)) return undefined;
  return rmse / scaleK;
}

/**
 * Observed temperature span (K) of a trace: max − min over its full
 * record — the per-run initial-to-coldest reference scale for NRMSE.
 */
export function observedTemperatureSpanK(tr: TraceSample): number {
  checkSample('observedTemperatureSpanK', tr);
  if (tr.valuesK.length === 0) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of tr.valuesK) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo;
}

// ---------------------------------------------------------------------------
// 2. Station → run → campaign aggregation (run = independent unit)
// ---------------------------------------------------------------------------

export interface StationTraceMetrics {
  station: 1 | 2 | 3 | 4;
  /** Quality weight carried from the corpus QC policy. */
  qualityWeight: number;
  /** Aligned sample count (0 ⇒ metrics undefined). */
  nSamples: number;
  overlapStartS: number;
  overlapEndS: number;
  rmseK?: number;
  maeK?: number;
  /** NRMSE with the per-trace observed-span scale (documented above). */
  nrmse?: number;
}

/** Per-station objective: align + RMSE/MAE/NRMSE, honoring QC weight. */
export function stationTraceMetrics(
  model: TraceSample,
  data: DataTraceLike,
  opts?: { scaleK?: number }
): StationTraceMetrics {
  const a = alignTraces(model, data);
  const scaleK = opts?.scaleK ?? observedTemperatureSpanK(data);
  return {
    station: data.station,
    qualityWeight: data.qualityWeight,
    nSamples: a.timesS.length,
    overlapStartS: a.overlapStartS,
    overlapEndS: a.overlapEndS,
    rmseK: traceRmseK(a),
    maeK: traceMaeK(a),
    nrmse: traceNrmseK(a, scaleK),
  };
}

export interface RunTraceMetrics {
  /** Stations that contributed (defined RMSE). */
  nStations: number;
  /** Total aligned samples across contributing stations. */
  nSamples: number;
  /** Σ qualityWeight·nSamples over contributing stations. */
  weightSum: number;
  /**
   * Within-run pooled mean-squared error (K²):
   *   Σ_s w_s·n_s·rmse_s² / Σ_s w_s·n_s
   * (quality-weighted pooling WITHIN the run — protocol §6.3).
   */
  mseK2?: number;
  rmseK?: number;
  /** Within-run quality-weighted MAE (K). */
  maeK?: number;
}

/**
 * Pool station metrics WITHIN one run (quality-weighted).  Stations
 * without a defined RMSE (no overlap) are skipped.
 */
export function poolRunMetrics(stations: StationTraceMetrics[]): RunTraceMetrics {
  let wn = 0;
  let mse = 0;
  let mae = 0;
  let nSamples = 0;
  let nStations = 0;
  for (const s of stations) {
    if (s.rmseK === undefined || s.maeK === undefined) continue;
    const w = s.qualityWeight * s.nSamples;
    mse += w * s.rmseK * s.rmseK;
    mae += w * s.maeK;
    wn += w;
    nSamples += s.nSamples;
    nStations += 1;
  }
  return {
    nStations,
    nSamples,
    weightSum: wn,
    mseK2: wn > 0 ? mse / wn : undefined,
    rmseK: wn > 0 ? Math.sqrt(mse / wn) : undefined,
    maeK: wn > 0 ? mae / wn : undefined,
  };
}

export interface CampaignTraceMetrics {
  /** Runs that contributed (defined run RMSE). */
  nRuns: number;
  /**
   * Campaign mean-squared error (K²): the EQUAL-WEIGHT mean of per-run
   * MSEs.  Each physical run counts once — a 4-station run never
   * outweighs a run with a single usable station (protocol §4.3/§6.3).
   */
  mseK2?: number;
  rmseK?: number;
  /** Equal-weight mean of per-run MAEs (K). */
  maeK?: number;
}

/** Aggregate runs into a campaign objective — EQUAL weight per run. */
export function aggregateRunLevelMetrics(runs: RunTraceMetrics[]): CampaignTraceMetrics {
  let nRuns = 0;
  let mse = 0;
  let mae = 0;
  for (const r of runs) {
    if (r.mseK2 === undefined || r.maeK === undefined) continue;
    mse += r.mseK2;
    mae += r.maeK;
    nRuns += 1;
  }
  return {
    nRuns,
    mseK2: nRuns > 0 ? mse / nRuns : undefined,
    rmseK: nRuns > 0 ? Math.sqrt(mse / nRuns) : undefined,
    maeK: nRuns > 0 ? mae / nRuns : undefined,
  };
}

// ---------------------------------------------------------------------------
// 3. Feature observables (morphology family of the protocol §6.2)
// ---------------------------------------------------------------------------

/** A feature is either available (with value) or unavailable (with reason). */
export type Feature<T> = { available: true; value: T } | { available: false; reason: string };

function available<T>(value: T): Feature<T> {
  return { available: true, value };
}
function unavailable<T>(reason: string): Feature<T> {
  return { available: false, reason };
}

export interface TraceFeatureOptions {
  /**
   * Onset-of-cooling convention.  'belowThreshold' (default 290 K) mirrors
   * the repo's pre-registered morphology tables
   * ("onset<290 K") and suits model
   * traces starting near ambient (~293–300 K).  'dropFromStart' (default
   * 5 K) suits digitized traces whose record starts already below 290 K.
   */
  onset?: { mode: 'belowThreshold'; thresholdK?: number } | { mode: 'dropFromStart'; dropK?: number };
  /**
   * Knee threshold (K), e.g. Tsat_local + marginK per the chilldown-time
   * definition.  If omitted, kneeTimeS and plateauFractionPreKnee are
   * unavailable (a knee threshold is a caller-supplied definition, not
   * something this module invents).
   */
  kneeThresholdK?: number;
  /**
   * From the corpus QC (default true).  False ⇒ cold-side features
   * (50 K crossing, knee, 150→50 K drop, plateau) are categorically
   * unavailable: the record does not trustworthily reach them.
   */
  coldTailUsable?: boolean;
  /**
   * Half-window (s) of the sliding least-squares derivative used for
   * cooling rates.  Default: adaptive max(3·median dt, span/50).  The
   * window is part of the objective DEFINITION — apply the same window to
   * model and data, and report window sensitivity.
   */
  rateHalfWindowS?: number;
}

export interface TraceFeatures {
  /** Onset-of-cooling time (s), smooth crossing; threshold used is echoed. */
  onsetTimeS: Feature<number>;
  onsetThresholdK?: number;
  /** Smooth first crossing of 150 K (mid-front morphology marker). */
  crossing150KS: Feature<number>;
  /** Smooth first crossing of 50 K (cold-side; gated by coldTailUsable). */
  crossing50KS: Feature<number>;
  /** Smooth first crossing of kneeThresholdK (cold-side). */
  kneeTimeS: Feature<number>;
  /** t(50 K) − t(150 K) (s) — the steep-drop duration (cold-side). */
  drop150to50S: Feature<number>;
  /** Peak cooling rate (K/s, positive = cooling) and the time it occurs. */
  peakCoolingRate: Feature<{ rateKperS: number; timeS: number }>;
  /**
   * Plateau fraction of the pre-knee interval: share of pre-knee samples
   * whose |dT/dt| is below 10 % of the pre-knee peak rate (the repo's
   * morphology convention, tmp_dh_morph.ts).  Cold-side (needs the knee).
   */
  plateauFractionPreKnee: Feature<number>;
  /** Half-window actually used for the derivative (s). */
  rateHalfWindowS?: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
}

/**
 * Robust cooling-rate estimate: the slope of a least-squares line fit over
 * a sliding time window [t−h, t+h] (K/s, positive = cooling).  Works on
 * nonuniform timesteps; substantially less noise-amplifying than raw
 * central differences on digitized data.  Samples whose window contains
 * < 2 points or a degenerate time spread are NaN.
 */
export function coolingRateProfileKperS(
  timesS: number[],
  valuesK: number[],
  halfWindowS: number
): number[] {
  checkSample('coolingRateProfileKperS', { timesS, valuesK });
  const n = timesS.length;
  const rate = new Array<number>(n).fill(NaN);
  let lo = 0;
  let hi = 0;
  for (let k = 0; k < n; k++) {
    const t0 = timesS[k] - halfWindowS;
    const t1 = timesS[k] + halfWindowS;
    while (lo > 0 && timesS[lo - 1] >= t0) lo--;
    while (lo < k && timesS[lo] < t0) lo++;
    while (hi < n - 1 && timesS[hi + 1] <= t1) hi++;
    while (hi > k && timesS[hi] > t1) hi--;
    let st = 0;
    let sv = 0;
    let m = 0;
    for (let j = lo; j <= hi; j++) {
      st += timesS[j];
      sv += valuesK[j];
      m++;
    }
    if (m < 2) continue;
    const mt = st / m;
    const mv = sv / m;
    let num = 0;
    let den = 0;
    for (let j = lo; j <= hi; j++) {
      const dt = timesS[j] - mt;
      num += dt * (valuesK[j] - mv);
      den += dt * dt;
    }
    if (den > 0) rate[k] = -num / den; // positive = cooling
  }
  return rate;
}

/**
 * The default adaptive derivative half-window (s):
 * max(3·median dt, span/50).  Exported because the rate window is part of
 * the objective DEFINITION (TraceFeatureOptions.rateHalfWindowS): a caller
 * comparing model vs data traces must compute both adaptive values and
 * apply a single agreed window (e.g. the max) to both sides.
 */
export function adaptiveHalfWindowS(timesS: number[]): number {
  const n = timesS.length;
  const dts: number[] = [];
  for (let i = 1; i < n; i++) dts.push(timesS[i] - timesS[i - 1]);
  const medDt = dts.length > 0 ? median(dts) : 1;
  const span = n > 1 ? timesS[n - 1] - timesS[0] : 1;
  return Math.max(3 * medDt, span / 50);
}

/** Smooth crossing with the boundary guard (convention 4 in the header). */
function guardedCrossing(
  timesS: number[],
  valuesK: number[],
  thresholdK: number,
  featureName: string
): Feature<number> {
  const t = thresholdCrossingTime(timesS, valuesK, thresholdK, 'below');
  if (t === undefined) {
    return unavailable(`${featureName}: threshold ${thresholdK} K never crossed within the recorded support`);
  }
  const n = timesS.length;
  if (n >= 2 && t > timesS[n - 2]) {
    return unavailable(
      `${featureName}: crossing falls in the final sample interval (record ends at ` +
        `${timesS[n - 1]} s) — cannot distinguish a true crossing from a truncation artifact`
    );
  }
  return available(t);
}

const COLD_TAIL_REASON =
  'cold tail flagged unusable by QC (truncated/ambiguous record) — ' +
  'feature not computed, never extrapolated';

/**
 * Extract the pre-registered morphology feature set from one trace
 * (protocol §6.2).
 */
export function extractTraceFeatures(
  trace: TraceSample,
  opts?: TraceFeatureOptions
): TraceFeatures {
  checkSample('extractTraceFeatures', trace);
  const { timesS, valuesK } = trace;
  const n = timesS.length;
  const coldTailUsable = opts?.coldTailUsable ?? true;

  // Onset of cooling.
  const onsetMode = opts?.onset?.mode ?? 'belowThreshold';
  const onsetThresholdK =
    onsetMode === 'belowThreshold'
      ? (opts?.onset as { thresholdK?: number } | undefined)?.thresholdK ?? 290
      : valuesK[0] - ((opts?.onset as { dropK?: number } | undefined)?.dropK ?? 5);
  const onsetTimeS =
    n === 0
      ? unavailable<number>('onset: empty trace')
      : guardedCrossing(timesS, valuesK, onsetThresholdK, 'onset');

  // Mid-front marker: 150 K crossing (available even on truncated traces —
  // early/mid-front morphology remains usable per the trace audit).
  const crossing150KS =
    n === 0
      ? unavailable<number>('crossing150K: empty trace')
      : guardedCrossing(timesS, valuesK, 150, 'crossing150K');

  // Cold-side features: categorically gated by the QC cold-tail flag.
  const crossing50KS: Feature<number> = !coldTailUsable
    ? unavailable(`crossing50K: ${COLD_TAIL_REASON}`)
    : n === 0
      ? unavailable('crossing50K: empty trace')
      : guardedCrossing(timesS, valuesK, 50, 'crossing50K');

  const kneeTimeS: Feature<number> = !coldTailUsable
    ? unavailable(`knee: ${COLD_TAIL_REASON}`)
    : opts?.kneeThresholdK === undefined
      ? unavailable('knee: no kneeThresholdK supplied (the knee threshold is a caller definition)')
      : n === 0
        ? unavailable('knee: empty trace')
        : guardedCrossing(timesS, valuesK, opts.kneeThresholdK, 'knee');

  const drop150to50S: Feature<number> =
    crossing150KS.available && crossing50KS.available
      ? available(crossing50KS.value - crossing150KS.value)
      : unavailable(
          `drop150to50: requires both 150 K and 50 K crossings (${
            !crossing150KS.available ? crossing150KS.reason : crossing50KS.available ? '' : (crossing50KS as { reason: string }).reason
          })`
        );

  // Peak cooling rate (robust sliding-window least-squares derivative).
  const halfWindowS = opts?.rateHalfWindowS ?? (n > 1 ? adaptiveHalfWindowS(timesS) : 1);
  let peakCoolingRate: TraceFeatures['peakCoolingRate'];
  if (n < 5) {
    peakCoolingRate = unavailable(`peakCoolingRate: only ${n} samples (need ≥ 5)`);
  } else if (timesS[n - 1] - timesS[0] < 2 * halfWindowS) {
    peakCoolingRate = unavailable(
      `peakCoolingRate: record span ${(timesS[n - 1] - timesS[0]).toFixed(3)} s < 2×halfWindow (${(2 * halfWindowS).toFixed(3)} s)`
    );
  } else {
    const rate = coolingRateProfileKperS(timesS, valuesK, halfWindowS);
    let kMax = -1;
    for (let k = 0; k < n; k++) {
      if (!Number.isFinite(rate[k])) continue;
      if (kMax < 0 || rate[k] > rate[kMax]) kMax = k;
    }
    peakCoolingRate =
      kMax < 0
        ? unavailable('peakCoolingRate: no valid derivative window')
        : available({ rateKperS: rate[kMax], timeS: timesS[kMax] });
  }

  // Plateau fraction of the pre-knee interval (repo morphology convention).
  let plateauFractionPreKnee: Feature<number>;
  if (!kneeTimeS.available) {
    plateauFractionPreKnee = unavailable(
      `plateauFractionPreKnee: needs the knee crossing (${kneeTimeS.reason})`
    );
  } else {
    const rate = coolingRateProfileKperS(timesS, valuesK, halfWindowS);
    let peak = -Infinity;
    for (let k = 0; k < n; k++) {
      if (timesS[k] > kneeTimeS.value) break;
      if (Number.isFinite(rate[k]) && rate[k] > peak) peak = rate[k];
    }
    if (!(peak > 0)) {
      plateauFractionPreKnee = unavailable('plateauFractionPreKnee: no positive pre-knee cooling rate');
    } else {
      let slow = 0;
      let total = 0;
      for (let k = 0; k < n; k++) {
        if (timesS[k] > kneeTimeS.value) break;
        if (!Number.isFinite(rate[k])) continue;
        total++;
        if (rate[k] < 0.1 * peak) slow++;
      }
      plateauFractionPreKnee =
        total === 0
          ? unavailable('plateauFractionPreKnee: no pre-knee samples')
          : available(slow / total);
    }
  }

  return {
    onsetTimeS,
    onsetThresholdK,
    crossing150KS,
    crossing50KS,
    kneeTimeS,
    drop150to50S,
    peakCoolingRate,
    plateauFractionPreKnee,
    rateHalfWindowS: halfWindowS,
  };
}

// ---------------------------------------------------------------------------
// 4. Front-arrival ordering (per run, at a fixed threshold)
// ---------------------------------------------------------------------------

export interface FrontArrival {
  station: 1 | 2 | 3 | 4;
  timeS: number;
}

export interface FrontArrivalOrdering {
  thresholdK: number;
  /** Arrivals sorted by crossing time. */
  arrivals: FrontArrival[];
  /** True only if ALL supplied traces crossed within their support. */
  complete: boolean;
  /** Stations that never crossed within their record. */
  missingStations: (1 | 2 | 3 | 4)[];
}

/**
 * Front-arrival ordering across the stations of one run at a fixed
 * threshold — smooth crossings only (stationInterp.thresholdCrossingTime).
 * Traces that never crossed are listed in `missingStations`, not
 * extrapolated.
 */
export function frontArrivalOrdering(
  traces: { station: 1 | 2 | 3 | 4; timesS: number[]; valuesK: number[] }[],
  thresholdK: number
): FrontArrivalOrdering {
  const arrivals: FrontArrival[] = [];
  const missingStations: (1 | 2 | 3 | 4)[] = [];
  for (const tr of traces) {
    const t = thresholdCrossingTime(tr.timesS, tr.valuesK, thresholdK, 'below');
    if (t === undefined) missingStations.push(tr.station);
    else arrivals.push({ station: tr.station, timeS: t });
  }
  arrivals.sort((a, b) => a.timeS - b.timeS);
  return { thresholdK, arrivals, complete: missingStations.length === 0, missingStations };
}

/**
 * Discordant-pair count between two orderings over the stations present in
 * BOTH (Kendall-style): 0 = identical order; higher = more disagreement.
 */
export function discordantArrivalPairs(a: FrontArrivalOrdering, b: FrontArrivalOrdering): number {
  const posA = new Map<number, number>();
  const posB = new Map<number, number>();
  a.arrivals.forEach((ar, i) => posA.set(ar.station, i));
  b.arrivals.forEach((ar, i) => posB.set(ar.station, i));
  const common = [...posA.keys()].filter((s) => posB.has(s));
  let discordant = 0;
  for (let i = 0; i < common.length; i++) {
    for (let j = i + 1; j < common.length; j++) {
      const da = posA.get(common[i])! - posA.get(common[j])!;
      const db = posB.get(common[i])! - posB.get(common[j])!;
      if (da * db < 0) discordant++;
    }
  }
  return discordant;
}
