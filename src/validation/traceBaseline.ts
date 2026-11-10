/**
 * Trace-baseline plumbing — the PRE-FIT, NO-TUNING comparison of
 * model-predicted wall-temperature traces against the trusted NBS-9264
 * digitized corpus (NBS_TRUSTED_TRACE_RUNS), per the binding
 * protocol (§6–§7) and
 * the data-side trace policy.
 *
 * ============================================================================
 * WHAT THIS IS / IS NOT
 * ============================================================================
 * This module contains ONLY the pure extraction/comparison plumbing used
 * by the test suite (and any external measurement driver):
 *   - spatial extraction of MODEL wall traces at the exact NBS station
 *     coordinates (stationInterp.interpolateTraceToStation — never
 *     nearest-node snapping, protocol §3.1.3);
 *   - per-station model-vs-data comparison (traceObjectives primitives);
 *   - the morphology feature extraction with corpus QC gating;
 *   - guarded front-arrival ordering (the final-sample-interval guard of
 *     extractTraceFeatures applied to the ordering problem);
 *   - the solve plan for the 7 trusted runs (discretization per protocol
 *     §3.1.6 — NOT tuned here).
 *
 * NOTHING is fitted.  No closure constants, no nuisance parameters, no
 * numerics knobs are adjusted anywhere in this study.
 *
 * ============================================================================
 * CONVENTIONS (binding)
 * ============================================================================
 * 1. KNEE THRESHOLD: ONE definition for the Table-6 chilldown time and for
 *    the trace comparison, applied to the model AND to the digitized trace:
 *    T_knee(station) = T_sat(P_local,late(station)) + 15 K, with P_local,late
 *    the late-time pressure at that station of the model solve of the run
 *    at its driving pressure (chilldownMetric.localSaturationThreshold).
 *    The digitized corpus has no pressure record, so the model solve
 *    supplies the pressure; the resulting temperature is the same number for
 *    model and data, so the two knees are compared like for like (a data
 *    trace that never reaches the threshold has no knee under this
 *    definition, and says so).  The earlier convention, T_inlet + 15 K,
 *    sits 15–19 K above this threshold for saturated nitrogen and gave the
 *    opposite sign of the error for the same run; it is kept only as a
 *    sensitivity (dataNativeKneeThresholdK) and as the fallback of
 *    compareRunTraces when a model history carries no pressure.
 * 2. ONSET: 'belowThreshold' 290 K when the trace's first sample is above
 *    290 K (all model traces start at 300 K), otherwise 'dropFromStart'
 *    5 K — exactly the documented intent of TraceFeatureOptions.onset
 *    ("suits digitized traces whose record starts already below 290 K").
 *    The convention used is echoed per trace.
 * 3. RATE WINDOW: one half-window per run = the MAX of the per-trace
 *    adaptive defaults over all 8 traces (4 model + 4 data), applied
 *    identically to both sides.  Rationale: the model's fixed dt (2.5 s
 *    LH2 / 10 s LN2) is the coarser grid; a smaller window on the data
 *    side would invent data-side peak rates the model cannot express at
 *    its own resolution.  The window is reported per run.
 * 4. QC GATING: cold-side features of the data traces honor
 *    CorpusWallTempTrace.qc.coldTailUsable (truncated/ambiguous tails ⇒
 *    categorically unavailable, never imputed).  Model features are always
 *    computed; a FEATURE COMPARISON is only tabulated where the data side
 *    is available.
 */

import { stationXM } from "./nbsChilldown";
import { localSaturationThreshold } from "./chilldownMetric";
import { interpolateTraceToStation } from "./stationInterp";
import {
  adaptiveHalfWindowS,
  discordantArrivalPairs,
  extractTraceFeatures,
  observedTemperatureSpanK,
  poolRunMetrics,
  stationTraceMetrics,
  type DataTraceLike,
  type FrontArrivalOrdering,
  type RunTraceMetrics,
  type StationTraceMetrics,
  type TraceFeatureOptions,
  type TraceFeatures,
  type TraceSample,
} from "./traceObjectives";
import type { CorpusWallTempTrace, TraceRun } from "./nbsTraceCorpus";

// ---------------------------------------------------------------------------
// Solve plan for the trusted runs (protocol §3.1.6)
// ---------------------------------------------------------------------------

export type TraceBaselineClosure = "miropolskii" | "darrHartwig";

export interface TrustedRunSolveSpec {
  runId: string;
  /** CoolProp HEOS fluid name (ParaHydrogen for LH2; calibration protocol §3.1.6). */
  fluidName: "Nitrogen" | "ParaHydrogen";
  /** Spatial segments (frozen: N=6 for all trusted runs). */
  segments: number;
  /** Fixed time step (s).  dt=2.5 for LH2, dt=10 for LN2 (protocol §3.1.6). */
  dtS: number;
  /**
   * Solve horizon (s) — the standard 300 s horizon of the baseline
   * campaigns; must exceed the figure's data span so the alignment overlap
   * covers the full experimental record (checked by tests).
   */
  endTimeS: number;
}

/**
 * THE discretizations (protocol §3.1.6: LN2 at N=6, dt=10; LH2 at N=6,
 * dt=2.5 fixed, ParaHydrogen).  These are inputs, not fitted outputs.  The
 * four saturated entries were pre-registered; the three subcooled runs
 * (figs 05, 13, 14) joined the trusted set when trust levels were made a
 * function of the record's QC alone, and follow the same rule unchanged.
 * Subcooled runs are solved with inletTemperature = run.inletLiquidTempK.
 */
export const TRACE_BASELINE_SOLVE_PLAN: readonly TrustedRunSolveSpec[] = [
  {
    runId: "nbs9264-fig02",
    fluidName: "ParaHydrogen",
    segments: 6,
    dtS: 2.5,
    endTimeS: 300,
  },
  {
    runId: "nbs9264-fig05",
    fluidName: "ParaHydrogen",
    segments: 6,
    dtS: 2.5,
    endTimeS: 300,
  },
  {
    runId: "nbs9264-fig10",
    fluidName: "Nitrogen",
    segments: 6,
    dtS: 10,
    endTimeS: 300,
  },
  {
    runId: "nbs9264-fig11",
    fluidName: "Nitrogen",
    segments: 6,
    dtS: 10,
    endTimeS: 300,
  },
  {
    runId: "nbs9264-fig12",
    fluidName: "Nitrogen",
    segments: 6,
    dtS: 10,
    endTimeS: 300,
  },
  {
    runId: "nbs9264-fig13",
    fluidName: "Nitrogen",
    segments: 6,
    dtS: 10,
    endTimeS: 300,
  },
  {
    runId: "nbs9264-fig14",
    fluidName: "Nitrogen",
    segments: 6,
    dtS: 10,
    endTimeS: 300,
  },
] as const;

export function solveSpecForRun(runId: string): TrustedRunSolveSpec {
  const spec = TRACE_BASELINE_SOLVE_PLAN.find((s) => s.runId === runId);
  if (!spec) {
    throw new Error(
      `solveSpecForRun: ${runId} is not a trusted pre-fit run ` +
        `(${TRACE_BASELINE_SOLVE_PLAN.map((s) => s.runId).join(", ")})`,
    );
  }
  return spec;
}

// ---------------------------------------------------------------------------
// Model station extraction (spatial interpolation — never node snapping)
// ---------------------------------------------------------------------------

/** Model wall-temperature history on the solid-node grid. */
export interface ModelWallHistory {
  timesS: number[];
  /** Solid-node axial positions (m), strictly ascending. */
  wallXM: number[];
  /** wallTracesK[j][k]: wall T (K) of solid node j at time index k. */
  wallTracesK: number[][];
  /**
   * Fluid-node axial positions (m, ascending) and pressure histories
   * (pressureTracesPa[j][k], Pa).  Optional: with them compareRunTraces
   * applies the unified local-saturation knee threshold; without them it
   * falls back to the data-native T_inlet + 15 K.
   */
  fluidXM?: number[];
  pressureTracesPa?: number[][];
}

/**
 * Extract the model wall-temperature trace at one exact NBS station
 * (linear interpolation in space; stationInterp's documented clamping
 * applies only outside the wall grid — station 4 at 60.3504 m is bracketed
 * by the upwind-coupled outlet wall node at 60.96 m).
 */
export function extractModelStationTrace(
  model: ModelWallHistory,
  station: 1 | 2 | 3 | 4,
): TraceSample {
  return {
    timesS: model.timesS,
    valuesK: interpolateTraceToStation(
      model.wallXM,
      model.wallTracesK,
      stationXM(station),
    ),
  };
}

// ---------------------------------------------------------------------------
// Per-station / per-run comparison
// ---------------------------------------------------------------------------

/** Data-native knee threshold (convention 1): Tsat(P_drive) + 15 K. */
export function dataNativeKneeThresholdK(run: TraceRun): number {
  return run.inletLiquidTempK + 15;
}

/** Onset convention per trace (convention 2). */
export function onsetOptionsFor(trace: TraceSample): {
  opts: TraceFeatureOptions["onset"];
  convention: "belowThreshold290" | "dropFromStart5";
} {
  if (trace.valuesK.length > 0 && trace.valuesK[0] > 290) {
    return {
      opts: { mode: "belowThreshold", thresholdK: 290 },
      convention: "belowThreshold290",
    };
  }
  return {
    opts: { mode: "dropFromStart", dropK: 5 },
    convention: "dropFromStart5",
  };
}

/**
 * One agreed derivative half-window per run (convention 3): the max of the
 * per-trace adaptive defaults across model and data traces.
 */
export function runRateHalfWindowS(
  modelTraces: TraceSample[],
  dataTraces: TraceSample[],
): number {
  let hw = 0;
  for (const tr of [...modelTraces, ...dataTraces]) {
    hw = Math.max(hw, adaptiveHalfWindowS(tr.timesS));
  }
  return hw;
}

export interface StationTraceComparison {
  station: 1 | 2 | 3 | 4;
  /** Knee threshold (K) applied to model and data at this station. */
  kneeThresholdK: number;
  /** QC carried from the corpus trace. */
  qualityWeight: number;
  coldTailUsable: boolean;
  qcFlags: string[];
  /** Pointwise alignment metrics (QC-weighted downstream). */
  metrics: StationTraceMetrics;
  /** NRMSE scale actually used (data observed span, K). */
  scaleK: number;
  modelFeatures: TraceFeatures;
  dataFeatures: TraceFeatures;
  onsetConvention: { model: string; data: string };
}

/** Compare one model station trace against one corpus data trace. */
export function compareStationTrace(
  model: TraceSample,
  data: CorpusWallTempTrace,
  opts: { kneeThresholdK: number; rateHalfWindowS: number },
): StationTraceComparison {
  // CorpusWallTempTrace carries wallTempsK; the objectives take valuesK.
  const dataSample: TraceSample = {
    timesS: data.timesS,
    valuesK: data.wallTempsK,
  };
  const dataLike: DataTraceLike = {
    ...dataSample,
    station: data.station,
    qualityWeight: data.qualityWeight,
    qc: { coldTailUsable: data.qc.coldTailUsable },
  };
  const metrics = stationTraceMetrics(model, dataLike);
  const onsetModel = onsetOptionsFor(model);
  const onsetData = onsetOptionsFor(dataSample);
  const modelFeatures = extractTraceFeatures(model, {
    onset: onsetModel.opts,
    kneeThresholdK: opts.kneeThresholdK,
    coldTailUsable: true, // the model trace is complete by construction
    rateHalfWindowS: opts.rateHalfWindowS,
  });
  const dataFeatures = extractTraceFeatures(dataSample, {
    onset: onsetData.opts,
    kneeThresholdK: opts.kneeThresholdK,
    coldTailUsable: data.qc.coldTailUsable,
    rateHalfWindowS: opts.rateHalfWindowS,
  });
  return {
    station: data.station,
    kneeThresholdK: opts.kneeThresholdK,
    qualityWeight: data.qualityWeight,
    coldTailUsable: data.qc.coldTailUsable,
    qcFlags: [...data.qc.flags],
    metrics,
    scaleK: observedTemperatureSpanK(dataSample),
    modelFeatures,
    dataFeatures,
    onsetConvention: {
      model: onsetModel.convention,
      data: onsetData.convention,
    },
  };
}

/**
 * Front-arrival ordering from GUARDED 150 K crossings only: a crossing in
 * the final sample interval of a record is excluded (convention 4 of
 * traceObjectives) — a frame-edge crossing cannot be distinguished from a
 * truncation artifact, so such stations land in `missingStations`.
 */
export function guardedFrontOrdering150K(
  traces: { station: 1 | 2 | 3 | 4; timesS: number[]; valuesK: number[] }[],
): FrontArrivalOrdering {
  const arrivals: FrontArrivalOrdering["arrivals"] = [];
  const missingStations: (1 | 2 | 3 | 4)[] = [];
  for (const tr of traces) {
    const crossing = extractTraceFeatures(tr, {}).crossing150KS;
    if (crossing.available)
      arrivals.push({ station: tr.station, timeS: crossing.value });
    else missingStations.push(tr.station);
  }
  arrivals.sort((a, b) => a.timeS - b.timeS);
  return {
    thresholdK: 150,
    arrivals,
    complete: missingStations.length === 0,
    missingStations,
  };
}

export interface FrontOrderingComparison {
  thresholdK: 150;
  model: FrontArrivalOrdering;
  data: FrontArrivalOrdering;
  /** Kendall-style discordant pairs over stations present in BOTH orderings. */
  discordantPairs: number;
}

export interface RunTraceComparison {
  runId: string;
  /** Station-4 knee threshold (K). */
  kneeThresholdK: number;
  /** Per-station knee thresholds (K), stations 1–4. */
  kneeThresholdsK: number[];
  /** 'localSaturation': unified definition (needs model pressures);
   *  'dataNative': T_inlet + 15 K fallback. */
  kneeDefinition: "localSaturation" | "dataNative";
  rateHalfWindowS: number;
  stations: StationTraceComparison[];
  /** Within-run pooled metrics (quality-weighted) — protocol §6.3. */
  pooled: RunTraceMetrics;
  front150: FrontOrderingComparison;
}

/**
 * Full run comparison: model wall history vs the run's 4 corpus traces.
 * Pure — the caller supplies the solved model history.
 */
export function compareRunTraces(
  run: TraceRun,
  model: ModelWallHistory,
  opts?: {
    /** Margin above the local saturation temperature (default 15 K). */
    kneeMarginK?: number;
    /** Saturation temperature (K) at a pressure (Pa) — required for the
     *  unified definition. */
    saturationTemperatureK?: (pPa: number) => number;
  },
): RunTraceComparison {
  const modelTraces = run.traces.map((tr) =>
    extractModelStationTrace(model, tr.station),
  );
  const rateHalfWindowS = runRateHalfWindowS(
    modelTraces,
    run.traces.map((tr) => ({ timesS: tr.timesS, valuesK: tr.wallTempsK })),
  );
  const unified =
    model.fluidXM !== undefined &&
    model.pressureTracesPa !== undefined &&
    opts?.saturationTemperatureK !== undefined;
  const marginK = opts?.kneeMarginK ?? 15;
  const kneeThresholdsK = run.traces.map((tr) =>
    unified
      ? localSaturationThreshold(
          {
            fluidXM: model.fluidXM!,
            pressureTracesPa: model.pressureTracesPa!,
            saturationTemperatureK: opts!.saturationTemperatureK!,
          },
          tr.station,
          marginK,
        ).thresholdK
      : dataNativeKneeThresholdK(run),
  );
  const kneeThresholdK = kneeThresholdsK[kneeThresholdsK.length - 1];
  const stations = run.traces.map((tr, i) =>
    compareStationTrace(modelTraces[i], tr, {
      kneeThresholdK: kneeThresholdsK[i],
      rateHalfWindowS,
    }),
  );
  const pooled = poolRunMetrics(stations.map((s) => s.metrics));
  const modelOrdering = guardedFrontOrdering150K(
    modelTraces.map((t, i) => ({
      station: run.traces[i].station,
      timesS: t.timesS,
      valuesK: t.valuesK,
    })),
  );
  const dataOrdering = guardedFrontOrdering150K(
    run.traces.map((tr) => ({
      station: tr.station,
      timesS: tr.timesS,
      valuesK: tr.wallTempsK,
    })),
  );
  return {
    runId: run.runId,
    kneeThresholdK,
    kneeThresholdsK,
    kneeDefinition: unified ? "localSaturation" : "dataNative",
    rateHalfWindowS,
    stations,
    pooled,
    front150: {
      thresholdK: 150,
      model: modelOrdering,
      data: dataOrdering,
      discordantPairs: discordantArrivalPairs(modelOrdering, dataOrdering),
    },
  };
}
