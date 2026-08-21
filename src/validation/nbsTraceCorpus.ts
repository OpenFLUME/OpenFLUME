/**
 * NBS-9264 digitized wall-temperature TRACE CORPUS — versioned, validated,
 * QC-annotated loader for the pre-registered study
 * "Physics-constrained data-driven closure calibration for cryogenic
 * chilldown network models" (the pre-registered calibration protocol,
 * §4.2/§4.3/§6).
 *
 * ============================================================================
 * WHAT THIS IS / IS NOT
 * ============================================================================
 * This module is the trace-data INGESTION substrate only.  It performs no
 * calibration, fits nothing, and changes no solver physics.  It turns the
 * 11 digitized NBS-9264 oscillograph figures (Figs 2–7 LH2, 10–14 LN2;
 * generated data module ./generated/nbsTraceCorpusData.ts, built by
 * scripts/build-nbs-trace-corpus.ts from the tracked CSVs) into typed,
 * validated, QC-flagged `TraceRun`s.
 *
 * `CorpusWallTempTrace` EXTENDS the pre-registered drop-in schema
 * `DigitizedWallTempTrace` (nbsChilldown.ts §"Future digitized transient
 * traces") with exact-station normalization, per-trace QC flags and a
 * provisional quality weight — so every corpus trace remains assignable to
 * the drop-in contract.  `NBS_CHILLDOWN_TRACES` in nbsChilldown.ts is left
 * untouched (backward compatibility); the run-level structure needed for
 * the §4.3 correlation policy lives here.
 *
 * ============================================================================
 * INDEPENDENCE STRUCTURE (protocol §4.3 — binding)
 * ============================================================================
 * The independent experimental unit is the physical RUN (one figure), not
 * the station trace.  The 4 station traces within a run share the dewar,
 * the inlet condition, the initial wall/line state, the fill dynamics, the
 * instrumentation and the digitization pipeline — they are CORRELATED
 * samples.  Consequently:
 *   - subsets below are run-level (`TraceRun` with 4 correlated traces);
 *   - objective aggregation (traceObjectives.ts) pools stations WITHIN a
 *     run first, then weights runs equally — one 4-station run never counts
 *     as four runs;
 *   - hold-out partitioning (future) must be by run, never by station or
 *     time window.
 *
 * ============================================================================
 * TRUSTED vs DIAGNOSTIC (protocol §3.2 — binding)
 * ============================================================================
 *   NBS_TRUSTED_SATURATED_TRACE_RUNS: the 4 saturated runs whose conditions
 *     are calibration-grade at the frozen discretizations (sat LH2 fig02;
 *     sat LN2 figs 10, 11, 12) — 4 runs / 16 correlated traces.
 *   NBS_DIAGNOSTIC_SUBCOOLED_TRACE_RUNS: the 7 subcooled runs (figs 03–07,
 *     13, 14).  The current solver is NOT defensible at subcooled
 *     conditions (protocol §3.2: errors grow with N away from data, up to
 *     +80 %; compromise steps) — these traces are imported for morphology
 *     DIAGNOSIS ONLY and are marked diagnosticOnly by default.  They are
 *     not fit targets.
 * Per-trace QC flags further restrict WHICH FEATURES of a trusted trace
 * are usable (see TraceQcFlag); e.g. fig11 stns 1–3 stop before the cold
 * plateau and support front morphology but NOT endpoint / chilldown-time
 * objectives.
 *
 * ============================================================================
 * QUALITY-WEIGHT POLICY (PROVISIONAL — not a formal uncertainty model)
 * ============================================================================
 * `qualityWeight` is a transparent, documented heuristic derived from the
 * QC flags and original-marker counts (see TRACE_QUALITY_WEIGHT_POLICY):
 *   base 1.0;
 *   ×0.5  if the trace is dominated by drawn-line reconstruction
 *         (fewer than SPARSE_MARKER_THRESHOLD = 8 original markers);
 *   ×0.5  if the trace crosses a flagged ambiguous/curve-crossing region;
 *   ×0.75 if it contains a flagged oscillatory / low-confidence segment;
 *   floor 0.25.
 * Truncated cold tails do NOT reduce the in-window weight — instead the
 * cold-side FEATURES (50 K crossing, knee, plateau, drop duration) are
 * categorically unavailable for that trace (`coldTailUsable: false`).
 * This is a provisional quality policy for weighting, explicitly NOT a
 * formal uncertainty model; the formal likelihood is a protocol §6.4
 * downstream task.
 */

import {
  NBS_CHILLDOWN_DATA,
  NBS_CHILLDOWN_RIG,
  type DigitizedWallTempTrace,
} from './nbsChilldown';
import {
  NBS9264_SOURCE_FILES,
  NBS9264_SOURCE_HASH_SHA256,
  NBS9264_TOTAL_SAMPLES,
  NBS9264_TRACE_DATASET_VERSION,
  NBS9264_TRACE_RUN_DATA,
  type RawTraceRunData,
} from './generated/nbsTraceCorpusData';

// ---------------------------------------------------------------------------
// Dataset version / provenance
// ---------------------------------------------------------------------------

export const NBS_TRACE_DATASET = {
  /** Corpus semver — bump on curated-structure change (mirrors generated module). */
  version: NBS9264_TRACE_DATASET_VERSION,
  /** SHA-256 over the source CSVs; recomputed from disk in the test suite. */
  sourceHashSha256: NBS9264_SOURCE_HASH_SHA256,
  sourceFiles: NBS9264_SOURCE_FILES,
  totalSamples: NBS9264_TOTAL_SAMPLES,
  generator: 'scripts/build-nbs-trace-corpus.ts (npm run gen:trace-corpus)',
  runsMetadataCsv: 'validation/data/digitized/chilldown/nbs9264_runs_metadata.csv',
  sourceDoc: 'NBS-9264 / NASA-CR-81338 (Brennan et al. 1966), NTRS 19670007291',
  digitizedOn:
    '2026-08-13 hand-clicked gold markers (user-verified), promoted to the ' +
    'canonical CSVs — supersedes the 2026-08-04/05 auto digitization',
} as const;

// ---------------------------------------------------------------------------
// Station normalization + provenance guard
// ---------------------------------------------------------------------------

/**
 * Rounded station positions (m) as printed in the figure CSVs — the
 * report-rounded forms of the exact 20/80/141/198 ft geometry
 * (NBS_CHILLDOWN_RIG.stations).  Index order = station id 1..4.
 */
export const CANONICAL_STATION_SOURCE_M = [6.1, 24.4, 43.0, 60.4] as const;

/**
 * KNOWN-BAD station annotation found in the external raw-data catalog and
 * in brennan1966_nbs9264_inlet_restriction_results.csv:
 * "~20, 60, 100, 140 ft".  Both primary sources (AIAA 2015-3850 §4.3 and
 * NBS-9264 Fig. 1) agree on 20/80/141/198 ft.  The inlet-restriction CSV is
 * a scalar surge-pressure table (no transients) and must NEVER enter the
 * trace corpus; this guard makes that structural rather than accidental.
 */
export const NBS9264_KNOWN_BAD_STATION_FT = [20, 60, 100, 140] as const;

/** Files that may not contribute traces to the corpus (provenance blocklist). */
export const NBS_TRACE_CORPUS_BLOCKED_SOURCES: readonly string[] = [
  'brennan1966_nbs9264_inlet_restriction_results.csv',
];

/**
 * Map a CSV station position (m) to an NBS station id (1–4).
 * Accepts ONLY the canonical rounded set (6.1/24.4/43.0/60.4 m within
 * 0.05 m) — anything else (e.g. the known-bad 20/60/100/140 ft list, whose
 * 60/100/140 ft entries are 18.288/30.48/42.672 m) throws.
 */
export function stationIdFromSourceM(sourceM: number): 1 | 2 | 3 | 4 {
  for (let i = 0; i < CANONICAL_STATION_SOURCE_M.length; i++) {
    if (Math.abs(CANONICAL_STATION_SOURCE_M[i] - sourceM) < 0.05) {
      return (i + 1) as 1 | 2 | 3 | 4;
    }
  }
  throw new Error(
    `stationIdFromSourceM: ${sourceM} m is not a canonical rounded NBS-9264 ` +
      `station position (${CANONICAL_STATION_SOURCE_M.join(' / ')} m = ` +
      `20/80/141/198 ft).  Refusing to import — check for the known-bad ` +
      `"~20/60/100/140 ft" station annotation (audit finding).`
  );
}

// ---------------------------------------------------------------------------
// QC flags and quality weights
// ---------------------------------------------------------------------------

/**
 * Per-trace QC flags.  Each flag is curated from the digitizer's own CSV
 * header / digitization log (citations in TRACE_QC_SPEC below) and
 * cross-checked against the data by validateTraceCorpus where possible.
 */
export type TraceQcFlag =
  /**
   * Trace ends before the cold plateau: frame-edge truncation or the drawn
   * curve simply stops.  Cold-side features (50 K crossing, knee, plateau,
   * drop duration, chilldown time) are UNAVAILABLE for this trace; early /
   * mid-front morphology remains usable.
   */
  | 'truncatedColdTail'
  /**
   * Cold tails of multiple stations overlap on the scan and marker
   * assignment is ambiguous — per-station endpoint values untrustworthy.
   */
  | 'ambiguousTailAssignment'
  /**
   * Trace passes through a curve-crossing region that NBS itself flags as
   * measurement error (low-T crossings) or the digitizer flags as
   * ambiguous (close knees).
   */
  | 'curveCrossingRegion'
  /**
   * Fewer than SPARSE_MARKER_THRESHOLD original markers — the trace is
   * mostly drawn-line (line-walker) reconstruction.
   */
  | 'sparseOriginalMarkers'
  /** Valve opened ~1–2 s BEFORE t=0 (fig06): absolute time origin shifted. */
  | 'preTZeroValveOpening'
  /** Oscillatory segment noted by CRTech (fig14 stn1, ~30–60 s). */
  | 'oscillatorySegment'
  /**
   * Warm initial flat was reconstructed: overlapping station flats erased
   * by the digitizer and a physical flat prepended from 0 to drop start.
   */
  | 'warmFlatReconstructed'
  /** Other digitizer-flagged low-confidence region (e.g. fig07 warm marker stack). */
  | 'lowConfidenceRegion';

/** Below this original-marker count a trace is line-walker dominated. */
export const SPARSE_MARKER_THRESHOLD = 8;

export interface TraceQc {
  flags: TraceQcFlag[];
  /**
   * Whether cold-side features (50 K crossing, knee, plateau fraction,
   * 150→50 K drop duration, chilldown time) may be computed from this
   * trace.  False ⇒ those features are reported UNAVAILABLE, never
   * extrapolated or invented.
   */
  coldTailUsable: boolean;
  /** Curated provenance notes (digitization-log citations). */
  notes: string[];
}

/**
 * Provisional quality-weight policy (see module header).  Deterministic
 * function of the QC flags — documented, not fitted.
 */
export const TRACE_QUALITY_WEIGHT_POLICY = {
  base: 1.0,
  sparseMarkersFactor: 0.5,
  ambiguousOrCrossingFactor: 0.5,
  oscillatoryOrLowConfidenceFactor: 0.75,
  floor: 0.25,
} as const;

export function traceQualityWeight(qc: TraceQc): number {
  const p = TRACE_QUALITY_WEIGHT_POLICY;
  let w = p.base;
  if (qc.flags.includes('sparseOriginalMarkers')) w *= p.sparseMarkersFactor;
  if (
    qc.flags.includes('ambiguousTailAssignment') ||
    qc.flags.includes('curveCrossingRegion')
  ) {
    w *= p.ambiguousOrCrossingFactor;
  }
  if (
    qc.flags.includes('oscillatorySegment') ||
    qc.flags.includes('lowConfidenceRegion')
  ) {
    w *= p.oscillatoryOrLowConfidenceFactor;
  }
  return Math.max(p.floor, w);
}

// ---------------------------------------------------------------------------
// Corpus trace / run types
// ---------------------------------------------------------------------------

/**
 * One digitized station trace with full provenance.  Extends the
 * pre-registered drop-in schema `DigitizedWallTempTrace` (nbsChilldown.ts)
 * — a corpus trace can be used anywhere that schema is accepted.
 */
export interface CorpusWallTempTrace extends DigitizedWallTempTrace {
  /** Rounded station position exactly as printed in the source CSV (provenance). */
  stationSourceM: number;
  /** Exact NBS station coordinate (m), from NBS_CHILLDOWN_RIG (20/80/141/198 ft). */
  stationExactM: number;
  sampleCount: number;
  /**
   * Hand-clicked gold marker count as reported in the CSV header.  The CSV
   * rows are a UNIFORM RESAMPLE of the marker chain (linear interpolation
   * between markers): sample-level marker origin is not recoverable from
   * the resampled CSVs, so the marker count is the preserved provenance
   * for "original points vs interpolated resample".
   */
  originalMarkerCount: number;
  /** Uniform resample step of the digitizer (s). */
  resampleDtS: number;
  qc: TraceQc;
  /** Provisional quality weight in [0.25, 1] — see TRACE_QUALITY_WEIGHT_POLICY. */
  qualityWeight: number;
}

export type TraceCalibrationTier = 'trustedSaturated' | 'diagnosticOnly';

/**
 * One physical NBS-9264 experimental run (one figure) — the INDEPENDENT
 * unit for weighting and hold-out (protocol §4.3).  Its 4 station traces
 * are correlated samples of the same event.
 */
export interface TraceRun {
  runId: string; // 'nbs9264-figNN'
  figure: string; // 'Fig. NN'
  pdfPage: number;
  /**
   * Table-6 condition cross-reference (nbsChilldown.ts point id) where the
   * run corresponds to a Table-6 row.  figs 10/11 (sat LN2 at 2.5/3.4 atm)
   * have NO Table-6 counterpart (Table 6 sat LN2 starts at 4.2 atm).
   */
  conditionId?: string;
  fluid: 'LH2' | 'LN2';
  inletCondition: 'saturated' | 'subcooled';
  drivingPressure: { atm: number; pa: number };
  /** Inlet liquid temperature (K): Tsat(P_drive) for saturated runs. */
  inletLiquidTempK: number;
  /**
   * 'trustedSaturated' — calibration-grade conditions (protocol §3.2).
   * 'diagnosticOnly'   — subcooled runs; solver not defensible there, so
   *                      these traces support morphology diagnosis only and
   *                      are excluded from any fit by default.
   */
  calibrationTier: TraceCalibrationTier;
  timeSpanS: number;
  resampleDtS: number;
  /** The 4 correlated station traces, ordered by station id 1..4. */
  traces: [CorpusWallTempTrace, CorpusWallTempTrace, CorpusWallTempTrace, CorpusWallTempTrace];
  provenance: {
    sourceDoc: string;
    figure: string;
    page: number;
    sourceFile: string;
    citation: string;
  };
  /** Digitizer "Figure flags:" text, verbatim from the CSV header. */
  figureFlagsText: string;
}

// ---------------------------------------------------------------------------
// Curated per-trace QC spec — THE audit trail.
// Every entry cites the digitizer's CSV header (quoted in figureFlagsText).
// Adding a run/trace REQUIRES a curated entry here (the loader throws on
// missing or superfluous keys).
// ---------------------------------------------------------------------------

function qc(flags: TraceQcFlag[], coldTailUsable: boolean, notes: string[]): TraceQc {
  return { flags, coldTailUsable, notes };
}

const TRACE_QC_SPEC: Record<string, TraceQc> = {
  // QC RE-AUDIT 2026-08-13 (clicker-gold promotion): the hand-clicked gold
  // markers (user-verified) resolved the auto-digitizer artifacts — the
  // warm-flat erasure/prepend (real warm markers clicked on every figure),
  // the fig07 warm marker-stack ambiguity, fig10 stn4's frame-line
  // truncation, fig11's over-dense chained counts, fig12 stn3/4 sparsity,
  // and fig13's spurious t~55–60 s crossing.  Flags below keep ONLY what
  // remains true of the clicked data: physical low-T crossings, pre-t=0
  // valve opening, the fig14 stn1 oscillation, genuinely early record
  // ends, and cold tails that still overlap in the figure itself.

  // ---- fig02 (sat LH2 5.1 atm) — TRUSTED ----
  // Clicker gold: warm flats clicked from t=0 (no frame-corner loss);
  // stn3/4 knees still cross at t~66 s (low-T crossing, report sec.3.1);
  // stn4 tail fully clicked to 80 s / 25.5 K.
  'nbs9264-fig02/stn1': qc([], true, []),
  'nbs9264-fig02/stn2': qc([], true, []),
  'nbs9264-fig02/stn3': qc(['curveCrossingRegion'], true, [
    'Knee crosses stn4 at t~66 s in the hand-clicked gold data (low-T crossing; report sec.3.1: measurement error).',
  ]),
  'nbs9264-fig02/stn4': qc(['curveCrossingRegion'], true, [
    'Knee crosses stn3 at t~66 s (low-T crossing); full tail hand-clicked to 80 s / 25.5 K.',
  ]),

  // ---- fig03 (sub LH2 2.5 atm) — diagnostic ----
  // Clicker gold: real warm markers clicked at t=0 (no flat reconstruction).
  // Cold tails (~10–30 K) of ALL stations still overlap with low-T
  // crossings t~100–143 s in the clicked data — endpoints untrustworthy.
  'nbs9264-fig03/stn1': qc(['ambiguousTailAssignment'], false, [
    'Cold tails (~10–30 K) of all 4 stations overlap with low-T crossings t~100–143 s even in the hand-clicked gold data — per-station tail endpoints untrustworthy.',
  ]),
  'nbs9264-fig03/stn2': qc(['ambiguousTailAssignment'], false, [
    'Cold-tail overlap with low-T crossings t~100–143 s (clicker gold).',
  ]),
  'nbs9264-fig03/stn3': qc(['ambiguousTailAssignment'], false, [
    'Cold-tail overlap with low-T crossings t~100–143 s (clicker gold).',
  ]),
  'nbs9264-fig03/stn4': qc(['ambiguousTailAssignment'], false, [
    'Cold-tail overlap with low-T crossings t~100–143 s (clicker gold).',
  ]),

  // ---- fig04 (sub LH2 4.2 atm) — diagnostic ----
  // Clicker gold: tails of stns 1–3 still overlap ~22–35 K t~24–60 s;
  // stn4 plunges across stn3 at t~73 s to ~17.8 K (below the 19.5 K inlet —
  // report low-T measurement-error region) but runs to the figure end.
  'nbs9264-fig04/stn1': qc(['ambiguousTailAssignment'], false, [
    'Cold tails (~22–35 K) of stns 1–3 overlap t~24–60 s (clicker gold).',
  ]),
  'nbs9264-fig04/stn2': qc(['ambiguousTailAssignment'], false, [
    'Cold-tail overlap t~24–60 s (clicker gold).',
  ]),
  'nbs9264-fig04/stn3': qc(['ambiguousTailAssignment', 'curveCrossingRegion'], false, [
    'Cold-tail overlap t~24–60 s; stn4 crosses below stn3 at t~73 s (clicker gold).',
  ]),
  'nbs9264-fig04/stn4': qc(['curveCrossingRegion'], true, [
    'Crosses below stn3 at t~73 s down to ~17.8 K — low-T crossing (report sec.3.1 measurement-error region); runs to the figure end (75 s).',
  ]),

  // ---- fig05 (sub LH2 5.9 atm) — diagnostic ----
  // Clicker gold: stn3/4 knees remain within ~1 K t~55–65 s and share the
  // clicked tail markers at t=59–60 s; both tails now fully clicked to the
  // figure end (65 s; stn4 reaches ~23 K).
  'nbs9264-fig05/stn1': qc([], true, []),
  'nbs9264-fig05/stn2': qc([], true, []),
  'nbs9264-fig05/stn3': qc(['curveCrossingRegion'], true, [
    'stn3/4 knees within ~1 K t~55–65 s and share clicked tail markers at t=59–60 s (clicker gold).',
  ]),
  'nbs9264-fig05/stn4': qc(['curveCrossingRegion'], true, [
    'Close knees with stn3 t~55–65 s; tail fully hand-clicked to 65 s / 23.4 K (no longer drawn-line only).',
  ]),

  // ---- fig06 (sub LH2 7.6 atm) — diagnostic ----
  // Clicker gold CONFIRMS stn1 already dropping at t=0 (273 K vs ~296 K
  // siblings) — valve opened ~1–2 s before t=0 (CRTech note); all four
  // tails converge to the same ~35 K band at t~42–44 s.
  'nbs9264-fig06/stn1': qc(['preTZeroValveOpening', 'ambiguousTailAssignment'], false, [
    'Already dropping at t=0 (273 K vs ~296 K siblings) — valve opened ~1–2 s before t=0 (CRTech note; clicker gold confirms).',
    'All four cold tails converge to the same ~35 K band at t~42–44 s — tail endpoints untrustworthy.',
  ]),
  'nbs9264-fig06/stn2': qc(['preTZeroValveOpening', 'ambiguousTailAssignment'], false, [
    'Cold tails converge ~35 K t~42–44 s (clicker gold).',
  ]),
  'nbs9264-fig06/stn3': qc(['preTZeroValveOpening', 'ambiguousTailAssignment'], false, [
    'Cold tails converge ~35 K t~42–44 s (clicker gold).',
  ]),
  'nbs9264-fig06/stn4': qc(['preTZeroValveOpening', 'ambiguousTailAssignment'], false, [
    'Cold tails converge ~35 K t~42–44 s (clicker gold).',
  ]),

  // ---- fig07 (sub LH2 11 atm) — diagnostic ----
  // Clicker gold resolved the auto-pipeline warm marker-stack ambiguity
  // (clean warm flats clicked).  Tails still converge ~20–34 K at t~26–28 s
  // with stn4 crossing below stns 1–3 near t~26 s — endpoints untrustworthy.
  'nbs9264-fig07/stn1': qc(['ambiguousTailAssignment'], false, [
    'Tails converge ~20–34 K at t~26–28 s; stn4 crosses below stns 1–3 near t~26 s (clicker gold) — tail endpoints untrustworthy.',
  ]),
  'nbs9264-fig07/stn2': qc(['ambiguousTailAssignment'], false, [
    'Tail convergence ~20–34 K t~26–28 s (clicker gold).',
  ]),
  'nbs9264-fig07/stn3': qc(['ambiguousTailAssignment'], false, [
    'Tail convergence ~20–34 K t~26–28 s (clicker gold).',
  ]),
  'nbs9264-fig07/stn4': qc(['ambiguousTailAssignment'], false, [
    'Crosses below stns 1–3 near t~26 s into the shared ~20–34 K tail band (clicker gold).',
  ]),

  // ---- fig10 (sat LN2 2.5 atm) — TRUSTED ----
  // Clicker gold: NO stn3/4 low-T crossing (auto-pipeline chaining
  // artifact — resolved); stn4 clicked THROUGH the former t=240 frame-line
  // truncation down to ~98 K at the 250 s figure edge.  All four traces
  // reach the cold-plateau region; no flags remain.
  'nbs9264-fig10/stn1': qc([], true, []),
  'nbs9264-fig10/stn2': qc([], true, []),
  'nbs9264-fig10/stn3': qc([], true, [
    'No stn3/4 low-T crossing in the hand-clicked gold data — the auto-pipeline crossing t~150–170 s was a chaining artifact (clicker promotion 2026-08).',
  ]),
  'nbs9264-fig10/stn4': qc([], true, [
    'Hand-clicked through the former t=240 s frame-line truncation to ~98 K at the 250 s figure edge; knee (t~235–245 s) steep but fully resolved (clicker gold).',
  ]),

  // ---- fig11 (sat LN2 3.4 atm) — TRUSTED ----
  // Clicker gold: stn1,2 drawn traces still stop ~130 s, stn3 ~175 s
  // (before the cold plateau); only stn4 runs to ~240 s / 85.6 K.
  'nbs9264-fig11/stn1': qc(['truncatedColdTail'], false, [
    'Drawn trace stops at 130 s / ~95 K, before the cold plateau (clicker gold).',
  ]),
  'nbs9264-fig11/stn2': qc(['truncatedColdTail'], false, [
    'Drawn trace stops at 130 s / ~97 K, before the cold plateau (clicker gold).',
  ]),
  'nbs9264-fig11/stn3': qc(['truncatedColdTail'], false, [
    'Trace stops ~175 s at ~105 K, before the cold plateau (clicker gold).',
  ]),
  'nbs9264-fig11/stn4': qc([], true, [
    'Only station reaching ~240 s (85.6 K, at the cold plateau); CRTech extrapolated this tail in their own arrays.',
  ]),

  // ---- fig12 (sat LN2 5.9 atm) — TRUSTED ----
  // Clicker gold: 14/21/27/24 markers (no longer sparse); stn4 fully
  // clicked through its late drop (t~105–130 s) to ~86 K — at/below the
  // ~96 K inlet saturation temperature.  No flags remain.
  'nbs9264-fig12/stn1': qc([], true, []),
  'nbs9264-fig12/stn2': qc([], true, []),
  'nbs9264-fig12/stn3': qc([], true, [
    'Runs to the figure end (130 s) at ~104 K with the knee crossed — no longer sparse (27 hand-clicked markers).',
  ]),
  'nbs9264-fig12/stn4': qc([], true, [
    'Fully hand-clicked (24 markers): late drop t~105–130 s to ~86 K — no longer sparse/truncated (clicker promotion 2026-08).',
  ]),

  // ---- fig13 (sub LN2 4.2 atm) — diagnostic ----
  // Clicker gold: the t~55–60 s "crossings" were an auto-pipeline chaining
  // artifact — stations are cleanly separated in the clicked data.  stn1
  // still stops short (~40 s / ~88 K), stn2 ~101 s / ~95 K.
  'nbs9264-fig13/stn1': qc(['truncatedColdTail'], false, [
    'Stops short: record ends 40 s / ~88 K vs the 132 s figure span (clicker gold).',
  ]),
  'nbs9264-fig13/stn2': qc(['truncatedColdTail'], false, [
    'Stops short: record ends 101 s / ~95 K (clicker gold).',
  ]),
  'nbs9264-fig13/stn3': qc([], true, [
    'No t~55–60 s crossing in the hand-clicked gold data — auto-pipeline chaining artifact resolved (clicker promotion 2026-08).',
  ]),
  'nbs9264-fig13/stn4': qc([], true, [
    'Runs to the figure end (132 s) at ~79 K, near the ~76 K inlet temperature.',
  ]),

  // ---- fig14 (sub LN2 5.9 atm) — diagnostic ----
  // Clicker gold CONFIRMS the stn1 oscillation ~25–60 s (CRTech note);
  // stn1,2 still stop short (~65 s, at ~82 / ~104 K).
  'nbs9264-fig14/stn1': qc(['oscillatorySegment', 'truncatedColdTail'], false, [
    'Oscillatory segment ~25–60 s confirmed in the hand-clicked gold data (CRTech note); record stops at 65 s / ~82 K.',
  ]),
  'nbs9264-fig14/stn2': qc(['truncatedColdTail'], false, [
    'Stops short: record ends 65 s / ~104 K (clicker gold).',
  ]),
  'nbs9264-fig14/stn3': qc([], true, []),
  'nbs9264-fig14/stn4': qc([], true, []),
};

// ---------------------------------------------------------------------------
// Table-6 condition cross-references (run-level; verified against
// NBS_CHILLDOWN_DATA pressures at load — see buildTraceRuns).
// ---------------------------------------------------------------------------

const CONDITION_ID_BY_RUN: Record<string, string | undefined> = {
  'nbs9264-fig02': 'satLH2-P74.97', // 5.1 atm = 74.95 psia ≈ 74.97 psia
  'nbs9264-fig03': 'subLH2-P36.75', // 2.5 atm = 36.74 psia
  'nbs9264-fig04': 'subLH2-P61.74', // 4.2 atm
  'nbs9264-fig05': 'subLH2-P86.73', // 5.9 atm
  'nbs9264-fig06': 'subLH2-P111.72', // 7.6 atm
  'nbs9264-fig07': 'subLH2-P161.7', // 11.0 atm
  'nbs9264-fig10': undefined, // sat LN2 2.5 atm — no Table-6 sat row below 4.2 atm
  'nbs9264-fig11': undefined, // sat LN2 3.4 atm — no Table-6 sat row below 4.2 atm
  'nbs9264-fig12': 'satLN2-P86.73', // 5.9 atm
  'nbs9264-fig13': 'subLN2-P61.74', // 4.2 atm
  'nbs9264-fig14': 'subLN2-P86.73', // 5.9 atm
};

const CITATION =
  "Brennan, J.A., Brentari, E.G., Smith, R.V., Steward, W.G., 'Cooldown of " +
  'Cryogenic Transfer Lines - An Experimental Report\', NBS Report 9264 ' +
  '(NASA-CR-81338), Nov 7, 1966; NTRS 19670007291';

const DIGITIZATION_METHOD =
  'hand-clicked gold markers (2026-08, user-verified; integer-second click ' +
  'times, duplicate times averaged) + linear-interp uniform resample';

function buildTraceRuns(raw: RawTraceRunData[]): TraceRun[] {
  return raw.map((r) => {
    const conditionId = CONDITION_ID_BY_RUN[r.runId];
    if (!(r.runId in CONDITION_ID_BY_RUN)) {
      throw new Error(`nbsTraceCorpus: no curated conditionId entry for ${r.runId}`);
    }
    // Cross-check the Table-6 cross-reference (fluid, condition, pressure).
    if (conditionId !== undefined) {
      const pt = NBS_CHILLDOWN_DATA.find((p) => p.id === conditionId);
      if (!pt) throw new Error(`nbsTraceCorpus: conditionId ${conditionId} not in NBS_CHILLDOWN_DATA`);
      if (pt.fluid !== r.fluid || pt.inletCondition !== r.liquidState) {
        throw new Error(`nbsTraceCorpus: ${r.runId} condition ${conditionId} fluid/state mismatch`);
      }
      const relErr = Math.abs(pt.drivingPressure.pa - r.pDrivePa) / r.pDrivePa;
      if (relErr > 0.01) {
        throw new Error(
          `nbsTraceCorpus: ${r.runId} (${r.pDrivePa} Pa) vs ${conditionId} ` +
            `(${pt.drivingPressure.pa} Pa) pressure mismatch ${(relErr * 100).toFixed(2)} %`
        );
      }
    }

    const traces = r.stations.map((st, i) => {
      const station = stationIdFromSourceM(st.sourceM);
      const specKey = `${r.runId}/stn${station}`;
      const qcSpec = TRACE_QC_SPEC[specKey];
      if (!qcSpec) {
        throw new Error(`nbsTraceCorpus: no curated TRACE_QC_SPEC entry for ${specKey}`);
      }
      // Derived-consistency check: the sparse-marker flag must agree with
      // the digitizer's marker count (so the flag can't silently drift).
      const isSparse = r.markersPerStation[i] < SPARSE_MARKER_THRESHOLD;
      if (isSparse !== qcSpec.flags.includes('sparseOriginalMarkers')) {
        throw new Error(
          `nbsTraceCorpus: ${specKey} marker count ${r.markersPerStation[i]} ` +
            `inconsistent with curated sparseOriginalMarkers flag`
        );
      }
      const trace: CorpusWallTempTrace = {
        runId: r.runId,
        conditionId,
        station,
        timesS: st.timesS,
        wallTempsK: st.wallTempsK,
        provenance: {
          sourceDoc: NBS_TRACE_DATASET.sourceDoc,
          figure: r.figure,
          page: r.pdfPage,
        },
        digitizationMethod: DIGITIZATION_METHOD,
        estimatedUncertainty: {
          timeS: r.uncTimeS,
          tempK: r.uncTempK,
          notes: [
            'Marker-center localization band (digitizer estimate); between ' +
              'markers the drawn line is interpolated linearly — steep knees ' +
              'may deviate ~2–5 K (CSV header).  Distinct from the NBS ' +
              'instrument caveats (nbsChilldown.ts header).',
          ],
        },
        stationSourceM: st.sourceM,
        stationExactM: NBS_CHILLDOWN_RIG.stations[station - 1].xM,
        sampleCount: st.timesS.length,
        originalMarkerCount: r.markersPerStation[i],
        resampleDtS: r.resampleDtS,
        qc: qcSpec,
        qualityWeight: traceQualityWeight(qcSpec),
      };
      return trace;
    });

    return {
      runId: r.runId,
      figure: r.figure,
      pdfPage: r.pdfPage,
      conditionId,
      fluid: r.fluid,
      inletCondition: r.liquidState,
      drivingPressure: { atm: r.pDriveAtm, pa: r.pDrivePa },
      inletLiquidTempK: r.tInletK,
      calibrationTier: r.liquidState === 'saturated' ? 'trustedSaturated' : 'diagnosticOnly',
      timeSpanS: r.timeSpanS,
      resampleDtS: r.resampleDtS,
      traces: traces as TraceRun['traces'],
      provenance: {
        sourceDoc: NBS_TRACE_DATASET.sourceDoc,
        figure: r.figure,
        page: r.pdfPage,
        sourceFile: r.sourceFile,
        citation: CITATION,
      },
      figureFlagsText: r.figureFlagsText,
    };
  });
}

// ---------------------------------------------------------------------------
// Corpus validation (runs at module load — fail fast, never silently).
// ---------------------------------------------------------------------------

export function validateTraceCorpus(runs: TraceRun[]): void {
  const runIds = new Set<string>();
  for (const run of runs) {
    if (runIds.has(run.runId)) throw new Error(`validateTraceCorpus: duplicate runId ${run.runId}`);
    runIds.add(run.runId);
    if (NBS_TRACE_CORPUS_BLOCKED_SOURCES.includes(run.provenance.sourceFile)) {
      throw new Error(
        `validateTraceCorpus: ${run.runId} sourced from blocked file ` +
          `${run.provenance.sourceFile} (known-bad "~20/60/100/140 ft" station annotation)`
      );
    }
    if (run.traces.length !== 4) {
      throw new Error(`validateTraceCorpus: ${run.runId} has ${run.traces.length} traces, expected 4`);
    }
    const seenStations = new Set<number>();
    for (const tr of run.traces) {
      if (seenStations.has(tr.station)) {
        throw new Error(`validateTraceCorpus: ${run.runId} duplicate station ${tr.station}`);
      }
      seenStations.add(tr.station);
      // Station positions: exact NBS geometry + canonical rounded source.
      const exact = NBS_CHILLDOWN_RIG.stations[tr.station - 1].xM;
      if (tr.stationExactM !== exact) {
        throw new Error(
          `validateTraceCorpus: ${run.runId} stn${tr.station} exact position ` +
            `${tr.stationExactM} != NBS rig ${exact}`
        );
      }
      // Re-runs the provenance guard (throws on the known-bad station list).
      stationIdFromSourceM(tr.stationSourceM);
      if (tr.timesS.length !== tr.wallTempsK.length || tr.timesS.length === 0) {
        throw new Error(`validateTraceCorpus: ${run.runId} stn${tr.station} length mismatch/empty`);
      }
      if (tr.sampleCount !== tr.timesS.length) {
        throw new Error(`validateTraceCorpus: ${run.runId} stn${tr.station} sampleCount mismatch`);
      }
      for (let i = 0; i < tr.timesS.length; i++) {
        if (!Number.isFinite(tr.timesS[i]) || !Number.isFinite(tr.wallTempsK[i])) {
          throw new Error(`validateTraceCorpus: ${run.runId} stn${tr.station} non-finite at index ${i}`);
        }
        if (i > 0 && !(tr.timesS[i] > tr.timesS[i - 1])) {
          throw new Error(`validateTraceCorpus: ${run.runId} stn${tr.station} times not ascending at ${i}`);
        }
      }
      // QC internal consistency: a truncated tail must not claim usable
      // cold-side features; the quality weight must match the policy.
      if (tr.qc.flags.includes('truncatedColdTail') && tr.qc.coldTailUsable) {
        throw new Error(
          `validateTraceCorpus: ${run.runId} stn${tr.station} truncatedColdTail but coldTailUsable=true`
        );
      }
      if (Math.abs(tr.qualityWeight - traceQualityWeight(tr.qc)) > 1e-12) {
        throw new Error(`validateTraceCorpus: ${run.runId} stn${tr.station} qualityWeight off policy`);
      }
    }
    // Tier policy: trusted ⇔ saturated (protocol §3.2 defensibility).
    if (run.inletCondition === 'subcooled' && run.calibrationTier !== 'diagnosticOnly') {
      throw new Error(`validateTraceCorpus: ${run.runId} subcooled but not diagnosticOnly`);
    }
  }
  // The QC spec must cover EXACTLY the loaded traces (no orphans, no gaps).
  const specKeys = new Set(Object.keys(TRACE_QC_SPEC));
  for (const run of runs) {
    for (const tr of run.traces) {
      const key = `${run.runId}/stn${tr.station}`;
      if (!specKeys.delete(key)) throw new Error(`validateTraceCorpus: ${key} missing from TRACE_QC_SPEC`);
    }
  }
  if (specKeys.size > 0) {
    throw new Error(`validateTraceCorpus: orphaned TRACE_QC_SPEC entries: ${[...specKeys].join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// The corpus (built + validated at module load).
// ---------------------------------------------------------------------------

function buildCorpus(): TraceRun[] {
  const runs = buildTraceRuns(NBS9264_TRACE_RUN_DATA);
  validateTraceCorpus(runs);
  return runs;
}

/** All 11 digitized NBS-9264 runs (44 correlated station traces, 10,195 samples). */
export const NBS_TRACE_RUNS: readonly TraceRun[] = buildCorpus();

/**
 * TRUSTED subset (protocol §3.2 + trace-audit): the 4 saturated runs —
 * sat LH2 fig02, sat LN2 figs 10/11/12 = 4 runs / 16 correlated traces.
 * Per-trace QC flags still apply: fig11 stns1–3 (stop before the cold
 * plateau) support early/mid-front morphology only; fig02 stn3/4 pass
 * through a low-T knee-crossing region at t~66 s.
 */
export const NBS_TRUSTED_SATURATED_TRACE_RUNS: readonly TraceRun[] = NBS_TRACE_RUNS.filter(
  (r) => r.calibrationTier === 'trustedSaturated'
);

/**
 * DIAGNOSTIC subset: the 7 subcooled runs (figs 03–07 LH2, 13–14 LN2).
 * Solver is not calibration-defensible at subcooled conditions (protocol
 * §3.2) — imported for morphology diagnosis, excluded from fits by default.
 */
export const NBS_DIAGNOSTIC_SUBCOOLED_TRACE_RUNS: readonly TraceRun[] = NBS_TRACE_RUNS.filter(
  (r) => r.calibrationTier === 'diagnosticOnly'
);

/** Lookup helper. */
export function getTraceRun(runId: string): TraceRun {
  const run = NBS_TRACE_RUNS.find((r) => r.runId === runId);
  if (!run) throw new Error(`getTraceRun: unknown runId ${runId}`);
  return run;
}

/**
 * Traces whose QC permits cold-side (endpoint / chilldown-time / plateau)
 * features — the only traces a future chilldown-time objective may touch.
 */
export function coldTailUsableTraces(run: TraceRun): CorpusWallTempTrace[] {
  return run.traces.filter((t) => t.qc.coldTailUsable);
}
