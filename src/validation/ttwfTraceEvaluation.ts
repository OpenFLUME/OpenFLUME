/**
 * TT-WF trace evaluation — pure plumbing for the Phase-3 pre-registered,
 * FIXED-PARAMETER evaluation of the proposed TT-WF closure
 * (the proposed-closure design notes)
 * against the trusted NBS-9264 digitized wall-temperature corpus, compared
 * fairly with the frozen Miropolskii / Darr–Hartwig trace baseline.
 *
 * ============================================================================
 * WHAT THIS IS / IS NOT
 * ============================================================================
 * - The same measurement pipeline as the trace baseline (same solve plan,
 *   same extraction, same objective suite, same QC gating) with the
 *   closure switched to 'ttWf' at its PRE-REGISTERED DEFAULTS
 *   (C_q = 1, ΔT_h = 2 K — TTWF_DEFAULT_PARAMS).  NOTHING is fitted,
 *   swept, or tuned anywhere.
 * - Additional TT-WF-specific accounting: accepted-step fWet/latch/regime
 *   histories per conductor, front (fWet) arrival times at the exact NBS
 *   stations, TT-WF diagnostic counters, and an independent global energy
 *   audit of each solve (research plan §3.5 physical-validity gates).
 * - NO solver physics lives here; this module is pure extraction /
 *   summarization / comparison over solved TransientResults.
 *
 * Conventions inherited unchanged from traceBaseline.ts: station
 * interpolation, alignment, knee/onset/rate-window conventions, QC gating,
 * run-level pooling (see traceBaseline.ts §Scope).
 */

import { stationXM } from './nbsChilldown';
import { interpolateTraceToStation, thresholdCrossingTime } from './stationInterp';
import {
  aggregateRunLevelMetrics,
  type RunTraceMetrics,
} from './traceObjectives';
import type { TtWfConductorHistory } from '../core/schema';

// ---------------------------------------------------------------------------
// Fixed TT-WF parameter echo (pre-registered — NEVER tuned in this study)
// ---------------------------------------------------------------------------

/**
 * The pre-registered global parameter vector under test.  These are the
 * TTWF_DEFAULT_PARAMS of src/core/ttWf.ts; they are echoed into every
 * artifact so the evaluated configuration is self-describing.  The driver
 * reads them from TTWF_DEFAULT_PARAMS at measurement time — this constant
 * documents the pre-registered expectation and the test suite pins that
 * the two agree (no silent parameter drift).
 */
export const TTWF_PREREGISTERED_PARAMS = {
  /** C_q — ratio of actual to energy-limited rewet-front speed [-]. */
  frontEnergyFactor: 1,
  /** ΔT_h — rewet-to-dry hysteresis temperature separation [K]. */
  rewetHysteresisOffsetK: 2,
} as const;

// ---------------------------------------------------------------------------
// TT-WF history summarization (per conductor / per station)
// ---------------------------------------------------------------------------

export type TtWfRegimeLabel = 'DB' | 'NB' | 'TB' | 'FB' | 'SP';

export interface TtWfRegimeRun {
  regime: TtWfRegimeLabel;
  fromS: number;
  toS: number;
}

export interface TtWfConductorSummary {
  conductorId: string;
  axialPositionM: number;
  /** First accepted time the latch is set (rewet allowed), if ever. */
  latchSetS?: number;
  /** First accepted time the latch clears AFTER a set, if ever. */
  latchClearS?: number;
  /** Transition counts visible in the RECORDED history (chatter check). */
  latchSetCount: number;
  latchClearCount: number;
  /** Smooth upward crossings of the recorded fWet series (subcell front). */
  fWet50S?: number;
  fWet99S?: number;
  finalFWet: number;
  minFWet: number;
  maxFWet: number;
  /** Compressed regime history (consecutive-equal runs). */
  regimeRuns: TtWfRegimeRun[];
}

/**
 * Summarize one conductor's accepted-step TT-WF history (aligned 1:1 with
 * `timesS`).  Pure: no solver state is read here.
 */
export function summarizeTtWfConductorHistory(
  conductorId: string,
  axialPositionM: number,
  timesS: number[],
  h: TtWfConductorHistory
): TtWfConductorSummary {
  if (h.fWet.length !== timesS.length || h.rewetLatched.length !== timesS.length) {
    throw new Error(
      `summarizeTtWfConductorHistory(${conductorId}): history/time length mismatch ` +
        `(fWet ${h.fWet.length}, latch ${h.rewetLatched.length}, times ${timesS.length}) — ` +
        `the accepted-step alignment contract is broken`
    );
  }
  let sets = 0;
  let clears = 0;
  let latchSetS: number | undefined;
  let latchClearS: number | undefined;
  for (let k = 1; k < timesS.length; k++) {
    if (!h.rewetLatched[k - 1] && h.rewetLatched[k]) {
      sets++;
      if (latchSetS === undefined) latchSetS = timesS[k];
    }
    if (h.rewetLatched[k - 1] && !h.rewetLatched[k]) {
      clears++;
      if (latchSetS !== undefined && latchClearS === undefined) latchClearS = timesS[k];
    }
  }
  let minF = Infinity;
  let maxF = -Infinity;
  for (const f of h.fWet) {
    if (f < minF) minF = f;
    if (f > maxF) maxF = f;
  }
  const regimeRuns: TtWfRegimeRun[] = [];
  for (let k = 0; k < timesS.length; k++) {
    const r = h.regime[k];
    const last = regimeRuns[regimeRuns.length - 1];
    if (last && last.regime === r) {
      last.toS = timesS[k];
    } else {
      regimeRuns.push({ regime: r, fromS: timesS[k], toS: timesS[k] });
    }
  }
  return {
    conductorId,
    axialPositionM,
    latchSetS,
    latchClearS,
    latchSetCount: sets,
    latchClearCount: clears,
    fWet50S: thresholdCrossingTime(timesS, h.fWet, 0.5, 'above'),
    fWet99S: thresholdCrossingTime(timesS, h.fWet, 0.99, 'above'),
    finalFWet: h.fWet[h.fWet.length - 1] ?? NaN,
    minFWet: minF,
    maxFWet: maxF,
    regimeRuns,
  };
}

export interface TtWfStationFrontSummary {
  station: 1 | 2 | 3 | 4;
  /** Smooth time the spatially-interpolated fWet field crosses 0.5 / 0.99
   *  at the exact station coordinate (the subcell rewet-front passage
   *  diagnostic; interpolation convention identical to the wall-T
   *  extraction). */
  fWet50S?: number;
  fWet99S?: number;
}

/**
 * fWet arrival at the exact NBS stations: the per-conductor fWet series are
 * attached to their wall-node axial coordinates and linearly interpolated
 * in space per time sample (same `interpolateTraceToStation` convention as
 * the wall-temperature extraction), then crossed smoothly against the
 * level.  This is a MORPHOLOGY diagnostic (front passage), not a
 * temperature feature.
 */
export function ttwfStationFrontArrivals(
  timesS: number[],
  conductors: { axialPositionM: number; fWet: number[] }[],
  levels: number[] = [0.5, 0.99]
): TtWfStationFrontSummary[] {
  const xs = conductors.map((c) => c.axialPositionM);
  const traces = conductors.map((c) => c.fWet);
  return ([1, 2, 3, 4] as const).map((station) => {
    const atStation = interpolateTraceToStation(xs, traces, stationXM(station));
    const out: TtWfStationFrontSummary = { station };
    for (const lv of levels) {
      const t = thresholdCrossingTime(timesS, atStation, lv, 'above');
      if (lv === 0.5) out.fWet50S = t;
      else if (lv === 0.99) out.fWet99S = t;
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Case artifact schema (ttwf-trace-case@1)
// ---------------------------------------------------------------------------

/** Mirrors the trace-baseline artifact's config echo, plus the TT-WF params. */
export interface TtWfCaseConfigEcho {
  fluidName: string;
  segments: number;
  lengthM: number;
  drivingPressurePa: number;
  outletPressurePa: number;
  outletTemperatureK: number;
  initialTemperatureK: number;
  dtS: number;
  endTimeS: number;
  timeStepping: 'fixed';
  outletWallCoupling: 'upwind';
  solidProperties: 'ofhc-copper';
  closureParams: 'defaults (untouched)';
}

export interface TtWfCaseSolveRecord {
  status: 'ok' | 'timeout' | 'not-converged';
  converged: boolean;
  aborted: boolean;
  timedOut: boolean;
  solveWallS: number;
  steps: number;
  finalTimeS?: number;
  hFloorClampCount: number;
  statePHFallbackCount: { freshFactory: number; propsSI: number; saturationDome: number; lastResort: number };
  /** D-H validity guards firing INSIDE TT-WF evaluations (inherited
   *  sub-correlations — counted per h-map evaluation, as for darrHartwig). */
  darrHartwig: {
    validityClamps: { relin: number; twetCrit: number; tvapLimit: number; frontDistance: number; regimeCollapse: number };
    propertyFailureCount: number;
    missingWallTempCount: number;
  };
  /** TT-WF accepted-step counters (mapped only at commit — see
   *  src/core/diagnostics.ts). */
  ttWf: {
    fWetClampCount: number;
    latchSetCount: number;
    latchClearCount: number;
    invalidInputCount: number;
    energyLimiterCount: number;
    supplyLimiterCount: number;
    notIntegratedCount: number;
  };
}

/**
 * Independent global energy audit of the solve (research plan §3.5):
 * right-rectangle (implicit-Euler-consistent) quadrature of the boundary
 * enthalpy fluxes plus the boundary-reservoir wall-heat sink vs the change
 * in stored fluid+solid energy, computed ONLY from the recorded series.
 */
export interface TtWfEnergyAudit {
  /** |ΔE_stored − ∫Φdt| / scale, or undefined on a degenerate result. */
  relativeError?: number;
  dStoredFluidJ: number;
  dStoredSolidJ: number;
  integralBoundaryFluxJ: number;
  /** Heat absorbed by the fixed-state inlet boundary reservoir via the
   *  conv0 wall conductor (tracked-domain sink; documented bookkeeping). */
  integralBoundaryReservoirJ: number;
  scaleJ: number;
  method: 'right-rectangle (implicit-Euler-consistent), upwind boundary enthalpy fluxes; conv0→f0 wall heat treated as a boundary-reservoir sink';
}

/**
 * Per-station case record — identical shape to the trace-baseline
 * artifact's per-station record, re-declared here so this module stays
 * self-contained.
 */
export interface TtWfStationCaseRecord {
  station: 1 | 2 | 3 | 4;
  qualityWeight: number;
  coldTailUsable: boolean;
  qcFlags: string[];
  nSamples: number;
  overlapStartS: number;
  overlapEndS: number;
  rmseK?: number;
  maeK?: number;
  nrmse?: number;
  scaleK: number;
  onsetConvention: { model: string; data: string };
  features: {
    onsetS: { model?: number; data?: number };
    crossing150KS: { model?: number; data?: number; dataReason?: string };
    crossing50KS: { model?: number; data?: number; dataReason?: string };
    kneeS: { model?: number; data?: number; dataReason?: string };
    drop150to50S: { model?: number; data?: number; dataReason?: string };
    peakRateKperS: { model?: number; data?: number; atS?: { model?: number; data?: number } };
    plateauFraction: { model?: number; data?: number; dataReason?: string };
  };
}

export interface TtWfTraceCaseArtifact {
  schema: 'ttwf-trace-case@1';
  commitSha: string;
  measuredAt: string;
  datasetVersion: string;
  runId: string;
  closure: 'ttWf';
  /** Pre-registered fixed parameters actually used (echoed; never tuned). */
  ttwfParams: { frontEnergyFactor: number; rewetHysteresisOffsetK: number };
  /** TT-WF inherits the D-H LH2-fit sub-correlations; LN2 runs are a
   *  cross-fluid extrapolation (same flag convention as the baseline). */
  crossFluidExtrapolation: boolean;
  config: TtWfCaseConfigEcho;
  solve: TtWfCaseSolveRecord;
  energy?: TtWfEnergyAudit;
  /** Same trace-objective block as the baseline artifact (NaN fields on a
   *  failed solve). */
  kneeThresholdK: number;
  rateHalfWindowS: number;
  stations: TtWfStationCaseRecord[];
  pooled: { nStations: number; nSamples: number; rmseK?: number; maeK?: number };
  front150: {
    model: { arrivals: { station: number; timeS: number }[]; missingStations: number[]; complete: boolean };
    data: { arrivals: { station: number; timeS: number }[]; missingStations: number[]; complete: boolean };
    discordantPairs: number;
  };
  scalar: {
    chilldownTimeS?: number;
    thresholdK: number;
    tSatLocalK?: number;
    dataKneeS?: number;
    table6?: { conditionId: string; experimentalS: number; gfsspS: number; errorPct?: number };
  };
  modelStationTraces: { station: 1 | 2 | 3 | 4; timesS: number[]; valuesK: number[] }[];
  /** TT-WF accepted-step state histories + summaries (present whenever the
   *  result carries TransientResult.ttWf, including partial/timeout
   *  results — histories are sliced consistently by the solver). */
  ttwf?: {
    timesS: number[];
    perConductor: TtWfConductorSummary[];
    perStation: TtWfStationFrontSummary[];
    /** Raw recorded histories (aligned 1:1 with timesS) for figure
     *  regeneration and audit replay. */
    histories: Record<
      string,
      { axialPositionM: number; fWet: number[]; rewetLatched: boolean[]; regime: TtWfRegimeLabel[] }
    >;
  };
}

// ---------------------------------------------------------------------------
// Campaign / comparison aggregation (run-level, protocol §6.3/§7)
// ---------------------------------------------------------------------------

export interface CampaignPooledRow {
  closure: string;
  runsOk: number;
  rmseK?: number;
  maeK?: number;
}

/**
 * Pooled-across-runs metrics for one closure — EQUAL weight per run
 * (aggregateRunLevelMetrics; the same rule as the baseline report).  Only
 * runs with a defined run RMSE contribute.
 */
export function poolCampaign(
  closure: string,
  runs: { runId: string; status: string; rmseK?: number; maeK?: number }[],
  restrictToRunIds?: string[]
): CampaignPooledRow {
  const ok = runs.filter(
    (r) =>
      r.status === 'ok' &&
      r.rmseK !== undefined &&
      r.maeK !== undefined &&
      (restrictToRunIds === undefined || restrictToRunIds.includes(r.runId))
  );
  const metrics: RunTraceMetrics[] = ok.map((r) => ({
    nStations: 0,
    nSamples: 0,
    weightSum: 0,
    mseK2: r.rmseK! * r.rmseK!,
    rmseK: r.rmseK!,
    maeK: r.maeK!,
  }));
  const agg = aggregateRunLevelMetrics(metrics);
  return { closure, runsOk: ok.length, rmseK: agg.rmseK, maeK: agg.maeK };
}
