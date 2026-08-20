/**
 * NBS cryogenic transfer-line chilldown — versioned validation dataset.
 *
 * ============================================================================
 * PROVENANCE
 * ============================================================================
 * Primary source (summary table):
 *   Majumdar, A., LeClair, A., Moore, J. & Schallhorn, P.,
 *   "Generalized Fluid System Simulation Program (GFSSP), Version 6,"
 *   AIAA 2015-3850, 51st AIAA/SAE/ASEE Joint Propulsion Conference,
 *   Orlando FL, July 2015.  Table 6 — "Measured and Predicted Chilldown
 *   Time for NBS Test Setup" (p. 23).
 *   NTRS: https://ntrs.nasa.gov/citations/20150016531
 *
 * Underlying experiment:
 *   Brennan, J.A., Brentari, E.G., Smith, R.V., Steward, W.G.,
 *   "Cooldown of Cryogenic Transfer Lines — An Experimental Report,"
 *   NBS Report 9264 (NASA Contract R-45), National Bureau of Standards,
 *   Boulder CO, Nov 7 1966.  Also cataloged as NASA-CR-81338.
 *   NTRS: https://ntrs.nasa.gov/citations/19670007291
 *
 * VERIFICATION STATUS (2026-08-04):
 *   All 18 rows below were verified digit-for-digit against the rendered
 *   Table 6 image in the NTRS PDF of AIAA 2015-3850 (p. 23), and the 10
 *   LH2 rows were additionally cross-checked against Tables 4–5 of the
 *   earlier GFSSP paper (Majumdar, "No Vent Tank Fill and Transfer Line
 *   Chilldown Analysis by GFSSP," NASA M13-2805 / TFAWS 2013, p. 17 —
 *   identical values).  No discrepancies found.
 *   Station locations (20/80/141/198 ft) verified against BOTH
 *   AIAA 2015-3850 §4.3 ("thermocouple stations at distances of 20, 80,
 *   141, and 198 feet from the inlet") and the original NBS-9264 text
 *   ("station 3, 43.0 m away"; knee definition references the curve
 *   "60.4 m from the supply dewar" = station 4 at 198 ft = 60.3504 m).
 *   NOTE: the raw-data catalog at validation/data/raw/chilldown/CATALOG.md
 *   (external data-collection effort) lists the stations as
 *   "~20/60/100/140 ft" — that is WRONG; both primary sources agree on
 *   20/80/141/198 ft.  Flagged for correction.
 *
 * Related raw/digitized artifacts collected by the external data effort
 * (untracked in git at time of writing): validation/data/raw/chilldown/
 * (PDFs incl. NBS-9264 scan + AIAA-consistent companion papers) and
 * validation/data/digitized/chilldown/ (CSV extracts).  The NBS-9264
 * oscillograph FIGURES 2–51 (wall T / P / flow histories at the 4
 * stations) are their #1 digitization priority; when digitized they drop
 * into `NBS_CHILLDOWN_TRACES` below WITHOUT a schema change.
 *
 * ============================================================================
 * CHILLDOWN-TIME DEFINITION — READ THIS BEFORE USING THE DATA
 * ============================================================================
 * The NBS report is explicit that the quantity is not unique:
 *
 *   "The question of cooldown time is usually an important one, but,
 *    unfortunately, this quantity is not uniquely defined.  Several
 *    definitions have been used in the past with no specific one having
 *    a distinct advantage over others.  For the purposes of this report,
 *    cooldown time was defined as the time associated with the LOW
 *    TEMPERATURE KNEE in the temperature vs. time curve 60.4 m FROM THE
 *    SUPPLY DEWAR.  This definition of cooldown time is within a few
 *    seconds of the time taken to achieve steady flow and steady
 *    pressures, either of which could have been used as indicators."
 *    — NBS-9264 (Brennan et al. 1966)
 *
 * GFSSP adopts the same definition: "the chilldown time is defined as the
 * time corresponding to the low-temperature knee for a given transfer
 * line wall temperature curve" (Majumdar, TFAWS 2013, p. 17).
 *
 * So the measured numbers in this module are:
 *   (1) taken at STATION 4 — the most downstream instrument station,
 *       198 ft = 60.3504 m from the inlet (NBS rounds to "60.4 m").
 *       Station 4 is the last point on the line to chill, so this is
 *       effectively the FULL-LINE chilldown time.  Comparing against any
 *       upstream station systematically UNDERSTATES the measured value
 *       (this exact mistake — comparing our s2 node at ≈40.6 m against
 *       Table 6 — produced the confounded −27 %…−32 % "error" in the
 *       pre-baseline test comment).
 *   (2) read at the LOW-TEMPERATURE KNEE of the wall-temperature trace —
 *       the abrupt bend where the steep quench-front drop flattens toward
 *       the local liquid temperature.  It is a visual/graphical quantity,
 *       not a hard threshold.
 *
 * Our operationalization (see `ChilldownTimeDefinition` below): the knee
 * is approximated as the first time the wall temperature — linearly
 * interpolated in space to station 4 — crosses
 * `Tsat_local(station 4) + marginK` from above, where Tsat_local uses the
 * late-time local pressure at the station (the wall's physical asymptote
 * is the LOCAL saturation temperature, not the inlet one — pressure falls
 * along the line).  This is defensible
 * because the knee region is STEEP (the wall drops of order 100 K within
 * seconds of front passage), so any threshold inside the knee band
 * recovers nearly the same time; the residual sensitivity to `marginK`
 * (and to the threshold mode) is QUANTIFIED in the chilldown baseline
 * rather than hidden.  Because the paper's definition is graphical, the
 * definition is kept CONFIGURABLE — sensitivity to it is a first-class
 * output of the baseline, and a later calibration must report objective
 * values under the same definition family.
 *
 * Alternatives considered and rejected:
 *   - "First sample with T < threshold" (the repo's old convention):
 *     piecewise-constant in every model parameter ⇒ gradient identically
 *     zero a.e. — fatal for gradient-based calibration (measured trap;
 *     see stationInterp.ts).
 *   - Nearest-node sampling instead of spatial interpolation: at N=3–4
 *     three of the four experimental stations collapse onto the same
 *     solid node (measured completion-time gaps [30, 0, 0] s), so the
 *     "station" being compared changes with discretization — an
 *     ill-posed objective.
 *   - Threshold relative to INLET liquid temperature: walls legitimately
 *     chill BELOW the inlet saturation temperature because local pressure
 *     (hence local Tsat) falls along the line; an inlet-referenced
 *     threshold does not track the local knee.
 *
 * ============================================================================
 * UNCERTAINTY / NUISANCE NOTES (for a later Bayesian calibration)
 * ============================================================================
 * Documented in `NBS_CHILLDOWN_UNCERTAINTY_NOTES` and per-point
 * `uncertainty.notes`:
 *   [NBS-self-flagged] Temperature accuracy was "sacrificed in order to
 *     cover the entire range from ambient to liquid temperatures"
 *     (copper–constantan thermocouples referenced to LN2).  "The crossing
 *     of temperature curves in the low temperature region in some tests
 *     is undoubtedly the result of inaccuracies in the measurement" —
 *     e.g. station 3 reading WARMER than station 4, physically
 *     inconsistent for a downstream-propagating front.
 *   [NBS-self-flagged] Chilldown time itself is read off oscillograph
 *     charts at a visual knee ⇒ reading error of order seconds.
 *   [Later re-analysis, passed-down context — CRTech digitization study]
 *     Dominant modeling unknowns: initial liquid temperature not
 *     recorded; ortho/para hydrogen fraction unknown (LH2 cases);
 *     copper-alloy heat capacity unknown; ±1 % tube-ID tolerance
 *     identified as a dominant sensitivity.
 *   [This module] GFSSP's "predicted" times are MODEL OUTPUT (33-node
 *     network, Miropolskii film-boiling correlation), kept alongside the
 *     measurements as the published baseline to beat — never treat them
 *     as data.
 */

// ---------------------------------------------------------------------------
// Unit conversions (single conversion path — every SI value below derives
// from the published original-unit values through these two functions).
// ---------------------------------------------------------------------------

/** Exact: 1 psi = 6894.757293168 Pa (NIST). */
export const PA_PER_PSI = 6894.757293168;

export function psiaToPa(psia: number): number {
  return psia * PA_PER_PSI;
}

/** T[K] = (T[°F] − 32) × 5/9 + 273.15. */
export function degFtoK(degF: number): number {
  return ((degF - 32) * 5) / 9 + 273.15;
}

export function ftToM(ft: number): number {
  return ft * 0.3048;
}

export function inchToM(inch: number): number {
  return inch * 0.0254;
}

// ---------------------------------------------------------------------------
// Test-rig geometry — SINGLE SOURCE OF TRUTH.
// Examples and tests must import this instead of hardcoding.
// ---------------------------------------------------------------------------

export interface RigStation {
  /** Instrument-station index as numbered in NBS-9264 / GFSSP papers. */
  id: 1 | 2 | 3 | 4;
  /** Axial distance from the line inlet (supply-dewar side), metres. */
  xM: number;
  /** Same, in feet (as published: 20/80/141/198 ft). */
  xFt: number;
}

export const NBS_CHILLDOWN_RIG = {
  /** Vacuum-jacketed horizontal copper transfer line. */
  lengthM: ftToM(200), // 60.96 m (200 ft)
  lengthFt: 200,
  innerDiameterM: inchToM(0.625), // 0.015875 m (5/8 in ID)
  innerDiameterIn: 0.625,
  outerDiameterM: inchToM(0.75), // 0.01905 m (3/4 in OD)
  outerDiameterIn: 0.75,
  material: 'copper' as const,
  vacuumJacketed: true,
  /**
   * Thermocouple/pressure stations, measured from the line inlet.
   * Sources: AIAA 2015-3850 §4.3; NBS-9264 (station 3 "43.0 m", knee
   * curve "60.4 m" from dewar).  Station 4 is 2 ft short of the outlet.
   */
  stations: [
    { id: 1, xM: ftToM(20), xFt: 20 }, // 6.096 m
    { id: 2, xM: ftToM(80), xFt: 80 }, // 24.384 m
    { id: 3, xM: ftToM(141), xFt: 141 }, // 42.9768 m ≈ 42.98 m
    { id: 4, xM: ftToM(198), xFt: 198 }, // 60.3504 m ≈ 60.35 m
  ] as RigStation[],
  /** Pressurized supply dewar capacity, US gallons (AIAA 2015-3850 §4.3). */
  supplyDewarGal: 80,
  /** Line discharge condition: vapor vents to atmosphere at the outlet. */
  discharge: 'atmospheric' as const,
  provenance: {
    sourceDoc: 'AIAA 2015-3850 (NTRS 20150016531) §4.3',
    underlyingExperiment: 'NBS-9264 / NASA-CR-81338 (NTRS 19670007291)',
  },
} as const;

// ---------------------------------------------------------------------------
// Chilldown-time definition (see the long comment at the top of this file).
// ---------------------------------------------------------------------------

export type ChilldownThreshold =
  /**
   * T_thresh = Tsat(P_local,late at the station) + marginK.
   * DEFAULT — tracks the local knee asymptote (see top-of-file comment).
   * P_local,late = mean of the spatially-interpolated pressure trace at
   * the station over the final 10 % of samples.
   */
  | { mode: 'aboveLocalTsat'; marginK: number }
  /** T_thresh = T_inlet_liquid + marginK (inlet Tsat for saturated cases,
   *  the subcooling reference temperature for subcooled cases). */
  | { mode: 'aboveInletLiquid'; marginK: number }
  /** T_thresh = valueK outright (e.g. the repo's historical 100 K). */
  | { mode: 'fixed'; valueK: number };

export interface ChilldownTimeDefinition {
  /**
   * Which instrument station defines the chilldown time.  Per NBS-9264
   * this MUST be station 4 (198 ft / 60.3504 m) for Table-6 comparability;
   * it is configurable only so the sensitivity to the choice can be
   * measured, not because other choices are defensible against Table 6.
   */
  station: 1 | 2 | 3 | 4;
  threshold: ChilldownThreshold;
}

export const DEFAULT_CHILLDOWN_TIME_DEFINITION: ChilldownTimeDefinition = {
  station: 4,
  threshold: { mode: 'aboveLocalTsat', marginK: 15 },
};

// ---------------------------------------------------------------------------
// The 18 Table-6 data points.
// ---------------------------------------------------------------------------

export interface ChilldownDataPoint {
  /** Stable identifier, e.g. 'satLN2-P74.97'. */
  id: string;
  fluid: 'LH2' | 'LN2';
  inletCondition: 'saturated' | 'subcooled';
  /** Tank/dewar driving pressure. */
  drivingPressure: { psia: number; pa: number };
  /**
   * Saturated cases only: fluid in the dewar is saturated at the driving
   * pressure; this is the published saturation temperature.
   */
  saturationTemperature?: { degF: number; K: number };
  /**
   * Subcooled cases only: fluid in the dewar is held at this fixed
   * subcooled temperature (LH2: −424.57 °F = 19.50 K;
   * LN2: −322.87 °F = 76.00 K).
   */
  subcooledAtTemperature?: { degF: number; K: number };
  /** Measured chilldown time (s) — NBS experiment, station-4 knee. */
  experimentalChilldownTimeS: number;
  /**
   * GFSSP's own published prediction (s) from the same table.  This is
   * the published model baseline we compare against — NOT data.
   */
  gfsspPredictedChilldownTimeS: number;
  provenance: {
    sourceDoc: string;
    sourceTable: string;
    underlyingExperiment: string;
  };
  uncertainty: {
    /**
     * Estimated 1σ reading uncertainty on the chilldown time (s).
     * NOT from the source — NBS gives no error bars; this is a
     * conservative engineering estimate for chart-read times at a visual
     * knee (oscillograph trace width + knee placement), to be refined (or
     * replaced by a calibrated likelihood) by the Bayesian stage.
     */
    timeS: number;
    basis: string;
    notes: string[];
  };
}

const TABLE6_PROVENANCE = {
  sourceDoc: 'AIAA 2015-3850 (GFSSP Version 6), NTRS 20150016531',
  sourceTable: 'Table 6 "Measured and Predicted Chilldown Time for NBS Test Setup", p. 23',
  underlyingExperiment: 'NBS-9264 / NASA-CR-81338 (Brennan et al. 1966), NTRS 19670007291',
} as const;

const CHART_READING_BASIS =
  'Estimate (not from source): oscillograph chart reading at a visual ' +
  'low-temperature knee; ±5 s is conservative against the 30–250 s ' +
  'measured times.  NBS-9264 flags low-temperature TC inaccuracies and ' +
  'physically-inconsistent curve crossings (see module header).';

function point(
  id: string,
  fluid: 'LH2' | 'LN2',
  inletCondition: 'saturated' | 'subcooled',
  psia: number,
  tempDegF: number,
  experimentalS: number,
  gfsspS: number
): ChilldownDataPoint {
  const base: ChilldownDataPoint = {
    id,
    fluid,
    inletCondition,
    drivingPressure: { psia, pa: psiaToPa(psia) },
    experimentalChilldownTimeS: experimentalS,
    gfsspPredictedChilldownTimeS: gfsspS,
    provenance: { ...TABLE6_PROVENANCE },
    uncertainty: {
      timeS: 5,
      basis: CHART_READING_BASIS,
      notes: [],
    },
  };
  if (inletCondition === 'saturated') {
    base.saturationTemperature = { degF: tempDegF, K: degFtoK(tempDegF) };
  } else {
    base.subcooledAtTemperature = { degF: tempDegF, K: degFtoK(tempDegF) };
  }
  return base;
}

/**
 * NBS-9264's own low-temperature measurement caveat, attached to every
 * point (the report does not identify WHICH tests were affected).
 */
const NBS_LOW_T_CAVEAT =
  'NBS-9264: "The crossing of temperature curves in the low temperature ' +
  'region in some tests is undoubtedly the result of inaccuracies in the ' +
  'measurement" — e.g. station 3 observed warmer than station 4; ' +
  'temperature accuracy sacrificed to span ambient→liquid range ' +
  '(copper-constantan TCs referenced to LN2).';

/** Saturated LH2 — Table 6 upper-left. */
const SAT_LH2: ChilldownDataPoint[] = [
  point('satLH2-P74.97', 'LH2', 'saturated', 74.97, -411.06, 68, 70),
  point('satLH2-P86.73', 'LH2', 'saturated', 86.73, -409.08, 62, 69),
  point('satLH2-P111.72', 'LH2', 'saturated', 111.72, -406.4, 42, 50),
  point('satLH2-P161.72', 'LH2', 'saturated', 161.72, -402.13, 30, 33),
];

/** Subcooled LH2 (subcooled at −424.57 °F) — Table 6 upper-right. */
const SUB_LH2: ChilldownDataPoint[] = [
  point('subLH2-P36.75', 'LH2', 'subcooled', 36.75, -424.57, 148, 150),
  point('subLH2-P61.74', 'LH2', 'subcooled', 61.74, -424.57, 75, 80),
  point('subLH2-P86.73', 'LH2', 'subcooled', 86.73, -424.57, 62, 60),
  point('subLH2-P111.72', 'LH2', 'subcooled', 111.72, -424.57, 41, 45),
  point('subLH2-P136.72', 'LH2', 'subcooled', 136.72, -424.57, 32, 35),
  point('subLH2-P161.7', 'LH2', 'subcooled', 161.7, -424.57, 28, 30),
];

/** Saturated LN2 — Table 6 lower-left. */
const SAT_LN2: ChilldownDataPoint[] = [
  point('satLN2-P61.74', 'LN2', 'saturated', 61.74, -294.09, 165, 185),
  point('satLN2-P74.97', 'LN2', 'saturated', 74.97, -289.71, 150, 160),
  point('satLN2-P86.73', 'LN2', 'saturated', 86.73, -286.24, 130, 140),
];

/** Subcooled LN2 (subcooled at −322.87 °F) — Table 6 lower-right. */
const SUB_LN2: ChilldownDataPoint[] = [
  point('subLN2-P36.75', 'LN2', 'subcooled', 36.75, -322.87, 222, 250),
  point('subLN2-P49.97', 'LN2', 'subcooled', 49.97, -322.87, 170, 175),
  point('subLN2-P61.74', 'LN2', 'subcooled', 61.74, -322.87, 129, 140),
  point('subLN2-P74.97', 'LN2', 'subcooled', 74.97, -322.87, 100, 100),
  point('subLN2-P86.73', 'LN2', 'subcooled', 86.73, -322.87, 85, 90),
];

/** All 18 Table-6 rows: 4 sat LH2 + 6 subcooled LH2 + 3 sat LN2 + 5 subcooled LN2. */
export const NBS_CHILLDOWN_DATA: ChilldownDataPoint[] = [
  ...SAT_LH2,
  ...SUB_LH2,
  ...SAT_LN2,
  ...SUB_LN2,
].map((p) => ({ ...p, uncertainty: { ...p.uncertainty, notes: [NBS_LOW_T_CAVEAT] } }));

// ---------------------------------------------------------------------------
// Documented nuisance/uncertainty notes (module level) — see header.
// ---------------------------------------------------------------------------

export const NBS_CHILLDOWN_UNCERTAINTY_NOTES: string[] = [
  'NBS-9264 (self-flagged): temperature accuracy "sacrificed in order to ' +
    'cover the entire range from ambient to liquid temperatures"; ' +
    'copper-constantan thermocouples referenced to liquid nitrogen.',
  'NBS-9264 (self-flagged): low-temperature curve crossings (e.g. station 3 ' +
    'warmer than station 4) "undoubtedly the result of inaccuracies in the ' +
    'measurement" — treat per-station low-T readings as suspect.',
  'NBS-9264 (self-flagged): chilldown time is a visual knee read off ' +
    'oscillograph charts; "within a few seconds of the time taken to ' +
    'achieve steady flow and steady pressures".',
  'Later re-analysis (CRTech digitization study, passed-down context): ' +
    'dominant modeling unknowns are the unrecorded initial liquid ' +
    'temperature, unknown ortho/para hydrogen fraction (LH2), unknown ' +
    'copper-alloy cp, and ±1% tube-ID tolerance sensitivity.',
  'This module: GFSSP "predicted" times are a 33-node-network model ' +
    'output (Miropolskii film-boiling correlation) — the published ' +
    'baseline to compare against, NOT experimental data.',
  'This module: chilldown-time operationalization (station-4 knee as a ' +
    'configurable threshold crossing) contributes a definitional ' +
    'sensitivity that is QUANTIFIED in the chilldown baseline and ' +
    'must be carried into any calibration likelihood.',
];

// ---------------------------------------------------------------------------
// Future digitized transient traces — EXPLICIT SHAPE, EMPTY FOR NOW.
// ---------------------------------------------------------------------------

/**
 * A digitized wall-temperature history at one instrument station for one
 * experimental run (the external data effort's deliverable: NBS-9264
 * oscillograph Figures 2–51).
 *
 * Drop-in contract (so digitized data lands here WITHOUT a schema rewrite):
 *   - `runId`    : free-form identifier from the digitization effort
 *                  (e.g. 'nbs9264-fig12'); if the run corresponds to a
 *                  Table-6 condition, ALSO set `conditionId` to that
 *                  point's `id` (e.g. 'satLN2-P61.74') so traces and
 *                  summary points cross-reference.
 *   - `station`  : 1–4, indexing NBS_CHILLDOWN_RIG.stations.
 *   - `timesS` / `wallTempsK` : SI, equal length, ascending times.
 *      (Field names carry SI suffixes per this repo's data convention,
 *       matching the external CSVs' unit-suffixed column names.)
 *   - `provenance` : which document/figure/page the trace came from.
 *   - `digitizationMethod` : e.g. 'manual-point-read', 'WebPlotDigitizer',
 *                  'image-processing pipeline' — free text, required.
 *   - `estimatedUncertainty` : digitizer's own error estimate
 *                  (timeS/tempK + notes); distinct from the instrument
 *                  uncertainty already recorded on the summary points.
 *
 * Pressure and flow-rate histories (also in the NBS figures) can reuse
 * this envelope later by adding a `quantity` discriminant — a
 * backwards-compatible extension, not a rewrite.
 */
export interface DigitizedWallTempTrace {
  runId: string;
  conditionId?: string;
  station: 1 | 2 | 3 | 4;
  timesS: number[];
  wallTempsK: number[];
  provenance: {
    sourceDoc: string;
    figure: string;
    page?: number;
  };
  digitizationMethod: string;
  estimatedUncertainty: {
    timeS?: number;
    tempK?: number;
    notes?: string[];
  };
}

/**
 * Digitized transient wall-temperature traces.  EMPTY today — populated
 * by the external data effort's digitization of NBS-9264 Figures 2–51
 * (their stated #1 priority).  Shape is fixed by `DigitizedWallTempTrace`.
 */
export const NBS_CHILLDOWN_TRACES: DigitizedWallTempTrace[] = [];

// ---------------------------------------------------------------------------
// Small accessors
// ---------------------------------------------------------------------------

export function getChilldownPoints(
  fluid: 'LH2' | 'LN2',
  inletCondition: 'saturated' | 'subcooled'
): ChilldownDataPoint[] {
  return NBS_CHILLDOWN_DATA.filter(
    (p) => p.fluid === fluid && p.inletCondition === inletCondition
  );
}

/** Station position (m) for a 1–4 station id. */
export function stationXM(id: 1 | 2 | 3 | 4): number {
  const st = NBS_CHILLDOWN_RIG.stations.find((s) => s.id === id);
  if (!st) throw new Error(`Unknown station id ${id}`);
  return st.xM;
}
