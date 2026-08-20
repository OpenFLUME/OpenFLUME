/**
 * TT-WF + fluid-front trace evaluation — pure plumbing for the Phase-3B
 * FIXED-PARAMETER falsification test of the transported cryogenic-front
 * model (src/core/fluidFront.ts, docs/fluid-front-transport.md) gating the
 * TT-WF dry side, against the trusted NBS-9264 digitized wall-temperature
 * corpus, compared with the FROZEN Miropolskii / Darr–Hartwig trace
 * baseline and the FROZEN ungated TT-WF evaluation — both read-only.
 *
 * ============================================================================
 * WHAT THIS IS / IS NOT
 * ============================================================================
 * - The SAME measurement pipeline as the TT-WF trace evaluation
 *   (src/validation/ttwfTraceEvaluation.ts) with the closure switched to
 *   ttWf + correlation.fluidFront: true at the pre-registered defaults
 *   (C_q = 1, ΔT_h = 2 K; the front model has NO parameter at all — no
 *   transport-speed, no threshold).  NOTHING is fitted, swept, or tuned.
 * - Additional front-specific accounting: per-node accepted-step a
 *   histories, a-arrival at the exact NBS stations (spatial interpolation
 *   of the front-fraction field), the fluidFront diagnostic counters
 *   (bounds clamps / invalid inputs / commit count vs accepted steps), and
 *   a recorded-series global tracer-conservation audit.
 * - NO solver physics lives here; this module is pure extraction /
 *   summarization / comparison over solved TransientResults.
 *
 * Conventions inherited unchanged from traceBaseline.ts /
 * ttwfTraceEvaluation.ts: station interpolation, alignment, knee/onset/
 * rate-window conventions, QC gating, run-level pooling.
 */

import { stationXM } from './nbsChilldown';
import { interpolateTraceToStation, thresholdCrossingTime } from './stationInterp';
import type {
  TtWfCaseConfigEcho,
  TtWfCaseSolveRecord,
  TtWfEnergyAudit,
  TtWfStationCaseRecord,
  TtWfTraceCaseArtifact,
} from './ttwfTraceEvaluation';

// ---------------------------------------------------------------------------
// Fixed configuration echo (pre-registered — NEVER tuned in this study)
// ---------------------------------------------------------------------------

/**
 * The pre-registered fluid-front configuration under test: every ttWf
 * conductor carries correlation.fluidFront: true and the inlet boundary
 * carries fluidFrontInlet: 1 (cryogenic source).  The TT-WF parameters stay
 * at the pre-registered defaults (TTWF_PREREGISTERED_PARAMS: C_q = 1,
 * ΔT_h = 2 K) and the front model exposes NO parameter — the front moves at
 * the mass-conservation speed of the accepted flow, the gate is the fixed
 * smoothstep on [0,1].  Echoed into every artifact so the evaluated
 * configuration is self-describing.
 */
export const TTWF_FLUID_FRONT_PREREGISTERED = {
  fluidFront: true,
  fluidFrontInlet: 1,
  frontEnergyFactor: 1,
  rewetHysteresisOffsetK: 2,
} as const;

// ---------------------------------------------------------------------------
// Front-fraction history summarization (per node / per station)
// ---------------------------------------------------------------------------

export interface FluidFrontNodeSummary {
  nodeId: string;
  axialPositionM: number;
  /** Smooth upward crossings of the recorded a series (front passage). */
  a50S?: number;
  a99S?: number;
  finalA: number;
  minA: number;
  maxA: number;
}

/**
 * Summarize one internal node's accepted-step front-fraction history
 * (aligned 1:1 with `timesS`).  Pure: no solver state is read here.
 */
export function summarizeFluidFrontNodeHistory(
  nodeId: string,
  axialPositionM: number,
  timesS: number[],
  fraction: number[]
): FluidFrontNodeSummary {
  if (fraction.length !== timesS.length) {
    throw new Error(
      `summarizeFluidFrontNodeHistory(${nodeId}): history/time length mismatch ` +
        `(fraction ${fraction.length}, times ${timesS.length}) — ` +
        `the accepted-step alignment contract is broken`
    );
  }
  let minA = Infinity;
  let maxA = -Infinity;
  for (const a of fraction) {
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
  }
  return {
    nodeId,
    axialPositionM,
    a50S: thresholdCrossingTime(timesS, fraction, 0.5, 'above'),
    a99S: thresholdCrossingTime(timesS, fraction, 0.99, 'above'),
    finalA: fraction[fraction.length - 1] ?? NaN,
    minA,
    maxA,
  };
}

export interface FluidFrontStationSummary {
  station: 1 | 2 | 3 | 4;
  /** Smooth time the spatially-interpolated front-fraction field crosses
   *  0.5 / 0.99 at the exact station coordinate (the cryogenic-front
   *  passage diagnostic; same `interpolateTraceToStation` convention as the
   *  wall-T and fWet extractions). */
  a50S?: number;
  a99S?: number;
}

/**
 * Front-fraction arrival at the exact NBS stations.  The per-internal-node
 * a series are attached to their fluid-node axial coordinates and augmented
 * with the two boundary anchors: the inlet boundary at x = 0 held at its
 * CONFIGURED value a_bnd (constant — boundary nodes carry no state; the
 * cryogenic inlet is a Dirichlet 1) and the outflow boundary at x = L
 * carrying the upwind (last internal) node's series (pure-upwind outflow
 * convention of the transport kernel).  The augmented field is linearly
 * interpolated in space per time sample (interpolateTraceToStation) and
 * crossed smoothly against the level.  This is a MORPHOLOGY diagnostic
 * (front passage), not a temperature feature.
 */
export function fluidFrontStationArrivals(
  timesS: number[],
  nodes: { axialPositionM: number; fraction: number[] }[],
  opts: { inletXM: number; inletA: number; outletXM: number },
  levels: number[] = [0.5, 0.99]
): FluidFrontStationSummary[] {
  // Sort by position, then augment with the boundary anchors.
  const sorted = [...nodes].sort((a, b) => a.axialPositionM - b.axialPositionM);
  const xs: number[] = [opts.inletXM];
  const traces: number[][] = [new Array(timesS.length).fill(opts.inletA)];
  for (const n of sorted) {
    xs.push(n.axialPositionM);
    traces.push(n.fraction);
  }
  const last = sorted[sorted.length - 1];
  if (last && last.axialPositionM < opts.outletXM) {
    xs.push(opts.outletXM);
    traces.push(last.fraction); // upwind outflow carries the last internal node's a
  }
  return ([1, 2, 3, 4] as const).map((station) => {
    const atStation = interpolateTraceToStation(xs, traces, stationXM(station));
    const out: FluidFrontStationSummary = { station };
    for (const lv of levels) {
      const t = thresholdCrossingTime(timesS, atStation, lv, 'above');
      if (lv === 0.5) out.a50S = t;
      else if (lv === 0.99) out.a99S = t;
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Recorded-series global tracer-conservation audit
// ---------------------------------------------------------------------------

/**
 * Independent global TRACER conservation audit (the front analogue of the
 * energy audit; docs/fluid-front-transport.md §3.1): summing the nodal BE
 * equations telescopes internal fluxes exactly, so
 *
 *   Σ_i (m_i a_i)^{n+1} − Σ_i (m_i a_i)^n = dt · (Σ_bnd in mdot·a_bnd − Σ_bnd out mdot·a_i)
 *
 * with right-rectangle (BE-consistent) quadrature.  Computed ONLY from the
 * recorded series (node densities, branch mdots, recorded a histories);
 * inlet boundary value = the configured a_bnd, outlet outflow carries the
 * upwind internal node's recorded a.
 */
export interface FluidFrontTracerAudit {
  /** |ΔΣ(m·a) − ∫Φ_a dt| / max(|ΔΣ|, |∫Φ|, floor). */
  relativeError?: number;
  dStoredTracerKg: number;
  integralBoundaryInfluxKg: number;
  scaleKg: number;
  method: 'right-rectangle (backward-Euler-consistent), upwind boundary tracer fluxes (inlet a_bnd = 1, outlet carries the upwind internal a)';
}

export function fluidFrontTracerAudit(input: {
  timesS: number[];
  /** Internal nodes: id, volume (m³), recorded density series. */
  nodes: { id: string; volumeM3: number; density: number[] }[];
  /** Recorded per-node front fraction series (aligned 1:1 with timesS). */
  fraction: Record<string, number[]>;
  /** Inlet branch mdot series (sign: into the domain positive). */
  inletMdot: number[];
  /** Outlet branch mdot series (sign: out of the domain positive). */
  outletMdot: number[];
  /** Axial ordering helper: node id of the LAST internal node (upwind of
   *  the outlet boundary). */
  outletUpwindNodeId: string;
  inletBoundaryA: number;
}): FluidFrontTracerAudit | undefined {
  const { timesS } = input;
  if (timesS.length < 2) return undefined;
  const stored = (k: number): number => {
    let s = 0;
    for (const n of input.nodes) {
      s += n.volumeM3 * n.density[k] * (input.fraction[n.id]?.[k] ?? 0);
    }
    return s;
  };
  let influx = 0;
  for (let k = 0; k + 1 < timesS.length; k++) {
    const dt = timesS[k + 1] - timesS[k];
    const aOut = input.fraction[input.outletUpwindNodeId]?.[k + 1] ?? 0;
    influx += (input.inletMdot[k + 1] * input.inletBoundaryA - input.outletMdot[k + 1] * aOut) * dt;
  }
  const dStored = stored(timesS.length - 1) - stored(0);
  const scale = Math.max(Math.abs(dStored), Math.abs(influx), 1e-12);
  return {
    relativeError: Math.abs(dStored - influx) / scale,
    dStoredTracerKg: dStored,
    integralBoundaryInfluxKg: influx,
    scaleKg: scale,
    method:
      'right-rectangle (backward-Euler-consistent), upwind boundary tracer fluxes (inlet a_bnd = 1, outlet carries the upwind internal a)',
  };
}

// ---------------------------------------------------------------------------
// Case artifact schema (ttwf-fluid-front-trace-case@1)
// ---------------------------------------------------------------------------

export interface TtWfFluidFrontCaseSolveRecord extends TtWfCaseSolveRecord {
  /** Accepted-step count vs commit discipline (fixed stepping ⇒ zero
   *  rejected trials; the commit count must equal the accepted steps). */
  acceptedSteps: number;
  rejectedSteps: number;
  /** Fluid-front transport counters (src/core/diagnostics.ts). */
  fluidFront: {
    boundsClampCount: number;
    invalidInputCount: number;
    commitCount: number;
  };
}

export interface TtWfFluidFrontTraceCaseArtifact {
  schema: 'ttwf-fluid-front-trace-case@1';
  commitSha: string;
  measuredAt: string;
  datasetVersion: string;
  runId: string;
  closure: 'ttWf+fluidFront';
  /** Pre-registered fixed configuration actually used (echoed). */
  ttwfParams: { frontEnergyFactor: number; rewetHysteresisOffsetK: number };
  fluidFrontConfig: { fluidFront: true; fluidFrontInlet: 1 };
  /** TT-WF inherits the D-H LH2-fit sub-correlations; LN2 runs are a
   *  cross-fluid extrapolation (same flag convention as the baseline). */
  crossFluidExtrapolation: boolean;
  config: TtWfCaseConfigEcho;
  solve: TtWfFluidFrontCaseSolveRecord;
  energy?: TtWfEnergyAudit;
  tracer?: FluidFrontTracerAudit;
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
  /** TT-WF accepted-step state histories + summaries (same shape as the
   *  ungated TT-WF artifact). */
  ttwf?: TtWfTraceCaseArtifact['ttwf'];
  /** Fluid-front accepted-step state: per-node a histories, per-node and
   *  per-station summaries, and the configured boundary values.  Present
   *  whenever the result carries TransientResult.fluidFront (including
   *  partial/timeout results — histories are sliced consistently). */
  fluidFront?: {
    timesS: number[];
    boundary: Record<string, number>;
    perNode: FluidFrontNodeSummary[];
    perStation: FluidFrontStationSummary[];
    histories: Record<string, { axialPositionM: number; fraction: number[] }>;
  };
}
