/**
 * chilldown-validation-report.ts — generates the cryogenic transfer-line
 * chilldown validation report (docs/validation/chilldown-report.md) and its
 * SVG figures (docs/validation/figures/chilldown/).
 *
 * Evidence: NBS Report 9264 (Brennan et al. 1966) measurements, through
 *   (1) all eighteen Table-6 chilldown times as tabulated in AIAA 2015-3850,
 *       compared three ways — experiment, GFSSP's published prediction,
 *       OpenFLUME — at GFSSP's resolution (30 segments, 31 fluid nodes) and
 *       at the 3-segment CI configuration;
 *   (2) the digitized oscillograph corpus (11 runs, 44 station traces),
 *       whose structure, trust levels and QC are gated by
 *       src/validation/__tests__/nbsTraceCorpus.test.ts, and the untuned
 *       trace baseline of the trusted runs (src/validation/traceBaseline.ts).
 *
 * One knee definition throughout: T_sat at the station's late-time local
 * pressure + 15 K, applied to the model and to the digitized trace of the
 * same run.  Each solve starts from the measured initial wall temperature of
 * its run (src/validation/nbsInitialTemperature.ts).  Trust levels come from
 * the experimental record alone (QC flags), never from the model's error.
 * Every solve runs in a child process with a timeout (scripts/lib/
 * chilldown-solves.ts); failures are listed, not dropped.  All numbers come
 * from live solves — rerun after solver changes:
 *
 *   npx tsx scripts/chilldown-validation-report.ts
 *
 * Scope and cost (bounded by design): Table 6 at N = 3 for all eighteen rows
 * (plus the 300 K-start, pre-GFSSP-layout and initial-temperature-bracket
 * variants, all at N = 3); the representative subset (saturated and subcooled
 * LN2 and LH2) at N = 3, 6, 12 and GFSSP's N = 30, with the time step doubled
 * and halved; the seven trusted trace runs at N = 6 and the four of them in
 * the subset at N = 30.  N = 60 is not run.  Each solve is a child process
 * limited to 300 s (a timeout is listed in the report, not dropped), four at
 * a time.  Expected runtime: 15-25 minutes on four cores (about 190 solves,
 * most of them seconds long; the N = 12 and N = 30 solves of the subset
 * dominate, the subcooled-nitrogen N = 30 solves reaching the timeout).
 * CHILLDOWN_CACHE=<file> stores the solve histories of a run and re-reads
 * them, for editing the report text only.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initRealFluids, RealFluid } from "../src/core";
import {
  maybeRunAsChild,
  runSolveJobs,
  specConditions,
  type SolveJob,
  type SolveOut,
  type SolveSpec,
} from "./lib/chilldown-solves";

if (maybeRunAsChild()) await new Promise(() => {}); // child mode: never reached below

import {
  chilldownHorizonS,
  DEFAULT_CHILLDOWN_TIME_DEFINITION,
  NBS_CHILLDOWN_DATA,
  NBS_CHILLDOWN_RIG,
  NBS_TIME_STEP_S,
  type ChilldownDataPoint,
  type ChilldownTimeDefinition,
} from "../src/validation/nbsChilldown";
import {
  CORPUS_INITIAL_WALL_TEMPERATURE,
  initialWallTemperatureForPoint,
  initialWallTemperatureForRun,
  runInitialWallTemperature,
} from "../src/validation/nbsInitialTemperature";
import {
  predictedChilldownTime,
  type ChilldownMetricInput,
} from "../src/validation/chilldownMetric";
import {
  NBS_DIAGNOSTIC_TRACE_RUNS,
  NBS_TRACE_DATASET,
  NBS_TRACE_RUNS,
  NBS_TRUSTED_TRACE_RUNS,
  RUN_COMPROMISING_QC_FLAGS,
  type TraceRun,
} from "../src/validation/nbsTraceCorpus";
import {
  compareRunTraces,
  extractModelStationTrace,
  type ModelWallHistory,
  type RunTraceComparison,
} from "../src/validation/traceBaseline";
import { thresholdCrossingTime } from "../src/validation/stationInterp";
import { C, lineChart, type Series } from "./lib/report-charts";

const HOST = fileURLToPath(import.meta.url);

/* ==========================================================================
 * Formatting helpers
 * ========================================================================== */

const fmt = (x: number | undefined, d = 1) =>
  x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(d);
const signedPct = (x: number, d = 1) =>
  Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)} %` : "—";
const signedSec = (x: number, d = 1) =>
  Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)} s` : "—";
const range = (xs: number[], d = 1, f = signedPct) => {
  const v = xs.filter(Number.isFinite);
  return v.length === 0
    ? "—"
    : `${f(Math.min(...v), d)} to ${f(Math.max(...v), d)}`;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const meanAbs = (xs: number[]) => mean(xs.map(Math.abs));
function pearson(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < a.length; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}
const errPct = (t: number | undefined, exp: number) =>
  t === undefined ? NaN : ((t - exp) / exp) * 100;

/* ==========================================================================
 * Output plumbing
 * ========================================================================== */

const outDir = join(process.cwd(), "docs", "validation");
const figDir = join(outDir, "figures", "chilldown");
const figures: string[] = [];
function writeFig(n: number, name: string, svg: string): void {
  const file = `fig${String(n).padStart(2, "0")}-${name}.svg`;
  writeFileSync(join(figDir, file), svg);
  figures[n] = file;
  console.log(`  wrote figures/chilldown/${file}`);
}

/* ==========================================================================
 * Experiment definition
 * ========================================================================== */

const PRIMARY_N = 30; // GFSSP's resolution: 30 segments, 31 fluid nodes
const CI_N = 3; // the CI configuration: ALL eighteen rows
const GRID_NS = [3, 6, 12, 30]; // refinement ladder of the representative subset
const TRACE_N = 6; // the trace-test plan: all trusted runs
const DT_LEVELS_CI = [2, 1, 0.5, 0.25]; // multiples of the fluid's step, N = 3
const DT_LEVELS_PRIMARY = [2, 1, 0.5]; // N = 30 (a quarter step is too costly)
const SOLVE_TIMEOUT_S = 300;
const WORKERS = 4;
/** The representative subset solved at GFSSP's resolution: a saturated and a
 *  subcooled case of each fluid (all four have a trusted digitized run). */
const REP_CASES = [
  "satLN2-P86.73",
  "subLN2-P61.74",
  "satLH2-P74.97",
  "subLH2-P86.73",
];
const DIAG_CASES = ["subLN2-P61.74", "satLN2-P86.73"];
/** Diagnostic solves: N = 3, 6, 12 at Δt = 10 s (the step at which these
 *  converge) and N = 30 at the step used (Δt = 5 s). */
const DIAG_NS = [3, 6, 12, 30];
const DIAG_DT = 10;
const diagKey = (id: string, N: number) =>
  N === PRIMARY_N ? jkey("t6", id, N, "P") : jkey("dg", id, N, "P", DIAG_DT);
const diagDt = (N: number) => (N === PRIMARY_N ? NBS_TIME_STEP_S.LN2 : DIAG_DT);
const KNEE15: ChilldownTimeDefinition = DEFAULT_CHILLDOWN_TIME_DEFINITION;
const KNEE30: ChilldownTimeDefinition = {
  station: 4,
  threshold: { mode: "aboveLocalTsat", marginK: 30 },
};

const dtOf = (p: ChilldownDataPoint): number => NBS_TIME_STEP_S[p.fluid];

type Variant = "P" | "T300" | "LEG" | "TLO" | "THI";
const jkey = (
  kind: string,
  id: string,
  N: number,
  v: Variant | string,
  dt?: number,
) => `${kind}|${id}|N${N}|${v}${dt === undefined ? "" : `|dt${dt}`}`;

function t6Spec(
  p: ChilldownDataPoint,
  N: number,
  v: Variant,
  dt = dtOf(p),
): SolveSpec {
  const init = initialWallTemperatureForPoint(p);
  return {
    id: p.id,
    N,
    dtS: dt,
    endTimeS: chilldownHorizonS(p.experimentalChilldownTimeS),
    ...(v === "T300"
      ? {}
      : {
          initialK:
            v === "TLO"
              ? CORPUS_INITIAL_WALL_TEMPERATURE.minK
              : v === "THI"
                ? CORPUS_INITIAL_WALL_TEMPERATURE.maxK
                : init.K,
        }),
    ...(v === "LEG" ? { layout: "legacy" as const } : {}),
  };
}
function traceSpec(run: TraceRun, N: number, v: "P" | "T300"): SolveSpec {
  return {
    id: run.runId,
    N,
    dtS: NBS_TIME_STEP_S[run.fluid],
    endTimeS: 300,
    ...(v === "P" ? { initialK: initialWallTemperatureForRun(run) } : {}),
  };
}

/* ==========================================================================
 * The solves
 * ========================================================================== */

await initRealFluids();
console.log("Generating chilldown validation report…");
mkdirSync(figDir, { recursive: true });
for (const f of readdirSync(figDir))
  if (f.endsWith(".svg")) unlinkSync(join(figDir, f));

const ALL_POINTS = NBS_CHILLDOWN_DATA;
const REPS = REP_CASES.map((id) =>
  NBS_CHILLDOWN_DATA.find((x) => x.id === id)!,
);
const noTrace = ALL_POINTS.filter(
  (p) => initialWallTemperatureForPoint(p).source !== "trace",
);
const jobs: SolveJob[] = [];
const addJob = (key: string, spec: SolveSpec) => {
  if (!jobs.some((j) => j.key === key)) jobs.push({ key, spec });
};
/** Key of the time-step study's solve: the step actually used is the
 *  refinement ladder's own solve, never solved twice. */
const dtKey = (id: string, N: number, m: number, dt: number) =>
  m === 1 ? jkey("t6", id, N, "P") : jkey("dt", id, N, "P", dt);
// Table 6: all eighteen rows at the CI configuration.
for (const p of ALL_POINTS) {
  addJob(jkey("t6", p.id, CI_N, "P"), t6Spec(p, CI_N, "P"));
  addJob(jkey("t6", p.id, CI_N, "T300"), t6Spec(p, CI_N, "T300"));
  addJob(jkey("t6", p.id, CI_N, "LEG"), t6Spec(p, CI_N, "LEG"));
}
for (const p of noTrace)
  for (const v of ["TLO", "THI"] as const)
    addJob(jkey("t6", p.id, CI_N, v), t6Spec(p, CI_N, v));
// The representative subset: N = 6, 12, 30 (N = 3 is above), and the
// pre-GFSSP layout at N = 12.
for (const p of REPS) {
  for (const N of GRID_NS.filter((n) => n !== CI_N))
    addJob(jkey("t6", p.id, N, "P"), {
      ...t6Spec(p, N, "P"),
      diag: DIAG_CASES.includes(p.id) && N === PRIMARY_N,
    });
  addJob(jkey("t6", p.id, 12, "LEG"), t6Spec(p, 12, "LEG"));
}
// Diagnostic solves of the two nitrogen cases (Δt = 10 s, N = 3, 6, 12).
for (const id of DIAG_CASES) {
  const p = NBS_CHILLDOWN_DATA.find((x) => x.id === id)!;
  for (const N of DIAG_NS.filter((n) => n !== PRIMARY_N))
    addJob(diagKey(id, N), {
      ...t6Spec(p, N, "P", DIAG_DT),
      diag: true,
    });
}
// The same subcooled case in the pre-GFSSP layout at the diagnostic step.
for (const N of DIAG_NS.filter((n) => n !== PRIMARY_N))
  addJob(jkey("dgL", DIAG_CASES[0], N, "LEG", DIAG_DT), {
    ...t6Spec(
      NBS_CHILLDOWN_DATA.find((x) => x.id === DIAG_CASES[0])!,
      N,
      "LEG",
      DIAG_DT,
    ),
  });
// Time step: the subset at N = 3 (four levels) and N = 30 (three levels).
for (const p of REPS)
  for (const [N, levels] of [
    [CI_N, DT_LEVELS_CI],
    [PRIMARY_N, DT_LEVELS_PRIMARY],
  ] as const)
    for (const m of levels) {
      const dt = dtOf(p) * m;
      addJob(dtKey(p.id, N, m, dt), t6Spec(p, N, "P", dt));
    }
// Traces: every trusted run at the trace plan's N = 6, and the runs of the
// representative subset at GFSSP's N = 30.
for (const run of NBS_TRUSTED_TRACE_RUNS) {
  addJob(jkey("tr", run.runId, TRACE_N, "P"), traceSpec(run, TRACE_N, "P"));
  if (run.conditionId && REP_CASES.includes(run.conditionId))
    addJob(
      jkey("tr", run.runId, PRIMARY_N, "P"),
      traceSpec(run, PRIMARY_N, "P"),
    );
}

// Longest first, so the four workers finish together.
jobs.sort((a, b) => b.spec.N - a.spec.N);

const CACHE = process.env.CHILLDOWN_CACHE;
const solved: Map<string, SolveOut> =
  CACHE && existsSync(CACHE)
    ? new Map(Object.entries(JSON.parse(readFileSync(CACHE, "utf8"))))
    : new Map<string, SolveOut>();
if (solved.size > 0) console.log(`read ${solved.size} solves from ${CACHE}`);
const todo = jobs.filter((j) => !solved.has(j.key));
if (todo.length > 0) {
  console.log(`running ${todo.length} solves`);
  const fresh = await runSolveJobs(HOST, todo, {
    timeoutS: SOLVE_TIMEOUT_S,
    concurrency: WORKERS,
    log: (m) => console.log(m),
  });
  for (const [k, v] of fresh) solved.set(k, v);
  if (CACHE) writeFileSync(CACHE, JSON.stringify(Object.fromEntries(solved)));
}
const out = (k: string): SolveOut => {
  const o = solved.get(k);
  if (!o) throw new Error(`missing solve ${k}`);
  return o;
};

/* ==========================================================================
 * Metrics from the histories
 * ========================================================================== */

const fluidObjs = new Map<string, RealFluid>();
const fluidFor = (name: string) => {
  if (!fluidObjs.has(name)) fluidObjs.set(name, new RealFluid(name));
  return fluidObjs.get(name)!;
};
const usable = (o: SolveOut) => !o.failed && o.timesS.length > 1;

function metricInput(o: SolveOut): ChilldownMetricInput {
  const c = specConditions(o.spec);
  const f = fluidFor(o.spec.fluidName ?? c.fluidName);
  return {
    timesS: o.timesS,
    wallXM: o.wallXM,
    wallTracesK: o.wallTracesK,
    fluidXM: o.fluidXM,
    pressureTracesPa: o.pressureTracesPa,
    inletLiquidTempK:
      c.inletTemperatureK ?? f.saturationTemperature(c.drivingPressurePa),
    saturationTemperatureK: (p) => f.saturationTemperature(p),
  };
}
function kneeOf(o: SolveOut, def = KNEE15) {
  if (!usable(o)) return undefined;
  return predictedChilldownTime(metricInput(o), def);
}
const timeOf = (o: SolveOut, def = KNEE15) => kneeOf(o, def)?.timeS;

const traceRunFor = (p: ChilldownDataPoint): TraceRun | undefined =>
  NBS_TRACE_RUNS.find((r) => r.conditionId === p.id);
const trustOf = (p: ChilldownDataPoint) =>
  traceRunFor(p)?.calibrationTier === "diagnosticOnly"
    ? "diagnostic only"
    : "trusted";
const FLAG_TEXT: Record<string, string> = {
  ambiguousTailAssignment: "cold tails overlap",
  preTZeroValveOpening: "valve opened before t = 0",
};
const recordOf = (p: ChilldownDataPoint) => {
  const run = traceRunFor(p);
  if (!run) return "not digitized";
  const bad = [
    ...new Set(
      run.traces.flatMap((t) =>
        t.qc.flags.filter((f) => RUN_COMPROMISING_QC_FLAGS.includes(f)),
      ),
    ),
  ];
  return bad.length === 0
    ? run.figure
    : `${run.figure}: ${bad.map((f) => FLAG_TEXT[f] ?? f).join(", ")}`;
};

interface Row {
  p: ChilldownDataPoint;
  t: number | undefined;
  err: number;
  ok: boolean; // converged and completed
  failed?: string;
}
function rowOf(p: ChilldownDataPoint, N: number, v: Variant): Row {
  const o = out(jkey("t6", p.id, N, v));
  const t = timeOf(o);
  return {
    p,
    t,
    err: errPct(t, p.experimentalChilldownTimeS),
    ok: o.converged && !o.failed,
    failed: o.failed,
  };
}
const gfsspErr = (p: ChilldownDataPoint) =>
  errPct(p.gfsspPredictedChilldownTimeS, p.experimentalChilldownTimeS);

interface Stats {
  n: number;
  mae: number;
  signed: number;
  late: number;
  corr: number;
  range: string;
}
function statsOf(rows: Row[], which: "ours" | "gfssp"): Stats {
  const good = rows.filter((r) => Number.isFinite(r.err));
  const e =
    which === "ours" ? good.map((r) => r.err) : good.map((r) => gfsspErr(r.p));
  return {
    n: good.length,
    mae: meanAbs(e),
    signed: mean(e),
    late: e.filter((x) => x > 0).length,
    corr: pearson(
      good.map((r) => r.err),
      good.map((r) => gfsspErr(r.p)),
    ),
    range: range(e),
  };
}

/* ==========================================================================
 * Table 6: the rows, the groups and the statistics
 * ========================================================================== */

const GROUPS: Array<{
  key: string;
  label: string;
  fluid: "LN2" | "LH2";
  cond: "saturated" | "subcooled";
}> = [
  { key: "satLN2", label: "Saturated LN₂", fluid: "LN2", cond: "saturated" },
  { key: "subLN2", label: "Subcooled LN₂", fluid: "LN2", cond: "subcooled" },
  { key: "satLH2", label: "Saturated LH₂", fluid: "LH2", cond: "saturated" },
  { key: "subLH2", label: "Subcooled LH₂", fluid: "LH2", cond: "subcooled" },
];
const inGroup = (p: ChilldownDataPoint, g: (typeof GROUPS)[number]) =>
  p.fluid === g.fluid && p.inletCondition === g.cond;
const fluidLabel = (p: ChilldownDataPoint) =>
  p.fluid === "LN2" ? "LN₂" : "LH₂";

const rowsAt = (pts: ChilldownDataPoint[], N: number, v: Variant) =>
  pts.map((p) => rowOf(p, N, v));
const R = {
  P3: rowsAt(ALL_POINTS, CI_N, "P"),
  T3: rowsAt(ALL_POINTS, CI_N, "T300"),
  L3: rowsAt(ALL_POINTS, CI_N, "LEG"),
  /** The representative subset at every level of the ladder. */
  grid: Object.fromEntries(
    GRID_NS.map((N) => [N, rowsAt(REPS, N, "P")] as const),
  ) as Record<number, Row[]>,
  L12: rowsAt(REPS, 12, "LEG"),
};
const repRow = (N: number, p: ChilldownDataPoint) =>
  R.grid[N].find((r) => r.p.id === p.id)!;
const rowFor = (rs: Row[], p: ChilldownDataPoint) =>
  rs.find((r) => r.p.id === p.id)!;
const sel = (rs: Row[], f: (p: ChilldownDataPoint) => boolean) =>
  rs.filter((r) => f(r.p));
const gfsspStats = (rs: Row[]) => statsOf(rs, "gfssp");
const ourStats = (rs: Row[]) => statsOf(rs, "ours");

const notConverged = [...solved.entries()].filter(
  ([, o]) => !o.failed && !o.converged,
);

/* Knee-margin sensitivity (15 K vs 30 K) at the CI configuration. */
const kneeSens = ALL_POINTS.map((p) => {
  const o = out(jkey("t6", p.id, CI_N, "P"));
  const t15 = timeOf(o, KNEE15);
  const t30 = timeOf(o, KNEE30);
  return {
    p,
    t15,
    t30,
    shift: (t15 ?? NaN) - (t30 ?? NaN),
    shiftPct:
      (((t15 ?? NaN) - (t30 ?? NaN)) / p.experimentalChilldownTimeS) * 100,
    thresholdK: kneeOf(o, KNEE15)?.thresholdK,
    tSatK: kneeOf(o, KNEE15)?.tSatLocalK,
    pLocalPa: kneeOf(o, KNEE15)?.pLocalLatePa,
  };
});

/* Knee of the digitized station-4 trace under the identical definition. */
interface DataKnee {
  p: ChilldownDataPoint;
  run: TraceRun;
  thresholdK: number;
  dataKneeS?: number;
  inletRefKneeS?: number;
  modelS?: number;
  minK: number;
}
const dataKnees: DataKnee[] = ALL_POINTS.flatMap((p) => {
  const run = traceRunFor(p);
  if (!run) return [];
  const o = out(jkey("t6", p.id, CI_N, "P"));
  const k = kneeOf(o, KNEE15);
  if (!k) return [];
  const tr = run.traces[3];
  return [
    {
      p,
      run,
      thresholdK: k.thresholdK,
      dataKneeS: thresholdCrossingTime(
        tr.timesS,
        tr.wallTempsK,
        k.thresholdK,
        "below",
      ),
      inletRefKneeS: thresholdCrossingTime(
        tr.timesS,
        tr.wallTempsK,
        run.inletLiquidTempK + 15,
        "below",
      ),
      modelS: k.timeS,
      minK: Math.min(...tr.wallTempsK),
    },
  ];
});

/* Time-step study. */
interface DtRow {
  id: string;
  p: ChilldownDataPoint;
  N: number;
  times: (number | undefined)[]; // DT_LEVELS order
  dts: number[];
  converged: boolean[];
  failed: (string | undefined)[];
  notRun: boolean[];
}
const DT_LEVELS = DT_LEVELS_CI; // column order: x2, x1 (used), x1/2, x1/4
const dtRows: DtRow[] = REPS.flatMap((p) =>
  [CI_N, PRIMARY_N].map((N) => {
    const levels = N === CI_N ? DT_LEVELS_CI : DT_LEVELS_PRIMARY;
    const os = DT_LEVELS.map((m) =>
      levels.includes(m)
        ? out(dtKey(p.id, N, m, dtOf(p) * m))
        : (undefined as SolveOut | undefined),
    );
    return {
      id: p.id,
      p,
      N,
      times: os.map((o) => (o ? timeOf(o) : undefined)),
      dts: DT_LEVELS.map((m) => dtOf(p) * m),
      converged: os.map((o) => (o ? o.converged : true)),
      failed: os.map((o) => o?.failed),
      notRun: os.map((o) => o === undefined),
    };
  }),
);
/** Index of the step actually used (multiple 1 of DT_LEVELS). */
const IDT = DT_LEVELS.indexOf(1);
const dtResid = (r: DtRow, a: number, b: number) =>
  Math.abs((r.times[a] ?? NaN) - (r.times[b] ?? NaN));

/* ==========================================================================
 * Traces under the unified definition
 * ========================================================================== */

interface TraceSolve {
  run: TraceRun;
  N: number;
  variant: "P" | "T300";
  o: SolveOut;
  model: ModelWallHistory;
  cmp: RunTraceComparison;
}
function traceSolveOf(
  run: TraceRun,
  N: number,
  variant: "P" | "T300",
): TraceSolve {
  const o = out(jkey("tr", run.runId, N, variant));
  const c = specConditions(o.spec);
  const f = fluidFor(c.fluidName);
  const model: ModelWallHistory = {
    timesS: o.timesS,
    wallXM: o.wallXM,
    wallTracesK: o.wallTracesK,
    fluidXM: o.fluidXM,
    pressureTracesPa: o.pressureTracesPa,
  };
  return {
    run,
    N,
    variant,
    o,
    model,
    cmp: compareRunTraces(run, model, {
      saturationTemperatureK: (p) => f.saturationTemperature(p),
    }),
  };
}
const TS = {
  /** All trusted runs at the trace plan's N = 6. */
  n6: NBS_TRUSTED_TRACE_RUNS.map((r) => traceSolveOf(r, TRACE_N, "P")),
  /** The trusted runs of the representative subset at GFSSP's N = 30. */
  n30: NBS_TRUSTED_TRACE_RUNS.filter(
    (r) => r.conditionId && REP_CASES.includes(r.conditionId),
  ).map((r) => traceSolveOf(r, PRIMARY_N, "P")),
};
const stationKnee = (ts: TraceSolve, st: number) => {
  const s = ts.cmp.stations[st - 1];
  const m = s.modelFeatures.kneeTimeS;
  const d = s.dataFeatures.kneeTimeS;
  return {
    model: m.available ? m.value : NaN,
    data: d.available ? d.value : NaN,
    lag: m.available && d.available ? m.value - d.value : NaN,
    thresholdK: s.kneeThresholdK,
  };
};
const arrival150 = (ts: TraceSolve, st: number) => {
  const s = ts.cmp.stations[st - 1];
  const m = s.modelFeatures.crossing150KS;
  const d = s.dataFeatures.crossing150KS;
  return {
    model: m.available ? m.value : NaN,
    data: d.available ? d.value : NaN,
    lag: m.available && d.available ? m.value - d.value : NaN,
  };
};
/** First time the station's wall is 30 K below its own initial value. */
const leadingEdge = (times: number[], vals: number[]) =>
  thresholdCrossingTime(times, vals, vals[0] - 30, "below");
const edgeLag = (ts: TraceSolve, st: number) => {
  const m = extractModelStationTrace(ts.model, st as 1 | 2 | 3 | 4);
  const d = ts.run.traces[st - 1];
  const tm = leadingEdge(m.timesS, m.valuesK);
  const td = leadingEdge(d.timesS, d.wallTempsK);
  return { model: tm ?? NaN, data: td ?? NaN, lag: (tm ?? NaN) - (td ?? NaN) };
};
const between = (t: number[], v: number[], hi: number, lo: number) => {
  const a = thresholdCrossingTime(t, v, hi, "below");
  const b = thresholdCrossingTime(t, v, lo, "below");
  return a !== undefined && b !== undefined ? b - a : undefined;
};
const frontWidth = (ts: TraceSolve) => {
  const m = extractModelStationTrace(ts.model, 4);
  const d = ts.run.traces[3];
  const Tk = ts.cmp.kneeThresholdsK[3];
  return {
    model: between(m.timesS, m.valuesK, 250, Tk),
    data: d.qc.coldTailUsable
      ? between(d.timesS, d.wallTempsK, 250, Tk)
      : undefined,
  };
};

/* ==========================================================================
 * Diagnosis of the subcooled-nitrogen refinement growth
 * ========================================================================== */

interface DiagCase {
  id: string;
  N: number;
  o: SolveOut;
  knee: number | undefined;
  t250: number;
  t150: number;
  tKneeLiquid?: number; // first time the end node is subcooled liquid after the wall fell below 150 K
  shelfMinH?: number;
  shelfWallK?: number;
  /** h of the end node's conductor at the first liquid step (Dittus–Boelter). */
  hLiquid?: number;
  /** Lowest two-phase quality of the end node after the wall fell below 150 K. */
  minQuality?: number;
  wallShare: Record<string, number>;
}
const stationCross = (o: SolveOut, th: number) => {
  const m = interpolateStation4(o);
  return thresholdCrossingTime(o.timesS, m, th, "below") ?? NaN;
};
function interpolateStation4(o: SolveOut): number[] {
  const x = NBS_CHILLDOWN_RIG.stations[3].xM;
  const xs = o.wallXM;
  let j = 0;
  while (j < xs.length - 2 && xs[j + 1] < x) j++;
  const f = (x - xs[j]) / (xs[j + 1] - xs[j]);
  return o.timesS.map(
    (_, k) => o.wallTracesK[j][k] * (1 - f) + o.wallTracesK[j + 1][k] * f,
  );
}
const diagCases: DiagCase[] = DIAG_CASES.flatMap((id) =>
  DIAG_NS.map((N) => {
    const o = out(diagKey(id, N));
    if (!usable(o) || !o.diag)
      return { id, N, o, knee: undefined, t250: NaN, t150: NaN, wallShare: {} };
    const d = o.diag;
    const t150 = stationCross(o, 150);
    const kneeT = timeOf(o);
    // The handoff: first step after the wall fell below 150 K at which the
    // end node is subcooled liquid.
    let tLiq: number | undefined;
    let hLiq: number | undefined;
    let minQ = Infinity;
    let minH = Infinity;
    let wallAtMin = NaN;
    for (let k = 0; k < o.timesS.length; k++) {
      if (
        d.endNode.wallTemperatureK[k] < 150 &&
        d.endNode.phase[k] === "twoPhase"
      ) {
        const h = d.endNode.hWmK[k];
        if (h < minH) {
          minH = h;
          wallAtMin = d.endNode.wallTemperatureK[k];
        }
      }
      if (
        d.endNode.wallTemperatureK[k] < 150 &&
        d.endNode.phase[k] === "twoPhase"
      )
        minQ = Math.min(minQ, d.endNode.quality[k] ?? Infinity);
      if (
        tLiq === undefined &&
        o.timesS[k] > t150 &&
        d.endNode.phase[k] === "liquid"
      ) {
        tLiq = o.timesS[k];
        hLiq = d.endNode.hWmK[k];
      }
    }
    const tot = Object.values(d.wallHeatByPhaseJ).reduce((a, b) => a + b, 0);
    return {
      id,
      N,
      o,
      knee: kneeT,
      t250: stationCross(o, 250),
      t150,
      tKneeLiquid: tLiq,
      hLiquid: hLiq,
      minQuality: Number.isFinite(minQ) ? minQ : undefined,
      shelfMinH: Number.isFinite(minH) ? minH : undefined,
      shelfWallK: wallAtMin,
      wallShare: Object.fromEntries(
        Object.entries(d.wallHeatByPhaseJ).map(([k, v]) => [k, v / tot]),
      ),
    };
  }),
);
const diagOf = (id: string, N: number) =>
  diagCases.find((c) => c.id === id && c.N === N)!;

/* ==========================================================================
 * Figures
 * ========================================================================== */

const rowsNaN = (rs: Row[]) =>
  rs.map((r): [number, number] => [r.p.experimentalChilldownTimeS, r.t ?? NaN]);
const tMax = Math.max(
  ...[...R.P3, ...R.grid[PRIMARY_N]].flatMap((r) => [
    r.p.experimentalChilldownTimeS,
    r.p.gfsspPredictedChilldownTimeS,
    r.t ?? 0,
  ]),
);
const axisTop = Math.ceil((tMax * 1.05) / 50) * 50;
const parityPts = (rs: Row[], cond: "saturated" | "subcooled") =>
  rowsNaN(rs.filter((r) => r.p.inletCondition === cond));
writeFig(
  1,
  "table6-parity",
  lineChart({
    title: "NBS 9264 Table 6: predicted against measured chilldown time",
    xLabel: "Measured station-4 chilldown time [s]",
    yLabel: "Predicted chilldown time [s]",
    legend: "top-left",
    xRange: [0, axisTop],
    yRange: [0, axisTop],
    series: [
      {
        label: "Equality",
        pts: [
          [0, 0],
          [axisTop, axisTop],
        ],
        color: C.grey,
        mode: "line",
        dash: "6 4",
      },
      {
        label: "GFSSP (published, 30 segments)",
        pts: ALL_POINTS.map((p): [number, number] => [
          p.experimentalChilldownTimeS,
          p.gfsspPredictedChilldownTimeS,
        ]),
        color: C.orange,
        mode: "markers",
        marker: "square",
      },
      {
        label: `OpenFLUME, saturated (N = ${CI_N})`,
        pts: parityPts(R.P3, "saturated"),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
      {
        label: `OpenFLUME, subcooled (N = ${CI_N})`,
        pts: parityPts(R.P3, "subcooled"),
        color: C.red,
        mode: "markers",
        marker: "triangle",
      },
      {
        label: `OpenFLUME, four cases at N = ${PRIMARY_N}`,
        pts: rowsNaN(R.grid[PRIMARY_N]),
        color: C.green,
        mode: "markers",
        marker: "diamond",
      },
    ],
  }),
);

const gridColors = [C.blue, C.red, C.green, C.orange];
const gridMarkers = ["circle", "square", "triangle", "diamond"] as const;
writeFig(
  2,
  "grid-study",
  lineChart({
    title: "Chilldown time relative to experiment against axial segments",
    xLabel: "Pipe segments N",
    yLabel: "Predicted / measured station-4 chilldown time",
    legend: "outside-right",
    series: [
      {
        label: "Equality",
        pts: [
          [GRID_NS[0], 1],
          [GRID_NS[GRID_NS.length - 1], 1],
        ],
        color: C.grey,
        mode: "line",
        dash: "6 4",
      },
      ...REPS.map((p, i): Series => ({
        label: `${fluidLabel(p)} ${p.inletCondition}, ${p.drivingPressure.psia} psia`,
        pts: GRID_NS.map((N): [number, number] => [
          N,
          (repRow(N, p).t ?? NaN) / p.experimentalChilldownTimeS,
        ]),
        color: gridColors[i],
        mode: "both",
        marker: gridMarkers[i],
      })),
    ],
  }),
);

const TRACE_FIG0 = 3;
const stationColors = [C.blue, C.red, C.green, C.orange];
TS.n6.forEach((ts, k) => {
  const run = ts.run;
  const series: Series[] = [];
  run.traces.forEach((tr, i) => {
    const m = extractModelStationTrace(ts.model, tr.station);
    const tEnd = Math.max(...tr.timesS);
    series.push({
      label: `Station ${tr.station}, model`,
      pts: m.timesS
        .map((t, j): [number, number] => [t, m.valuesK[j]])
        .filter(([t]) => t <= tEnd + 1e-9),
      color: stationColors[i],
      mode: "line",
    });
    const stride = Math.max(1, Math.ceil(tr.timesS.length / 40));
    series.push({
      label: `Station ${tr.station}, data`,
      pts: tr.timesS
        .map((t, j): [number, number] => [t, tr.wallTempsK[j]])
        .filter((_, j) => j % stride === 0),
      color: stationColors[i],
      mode: "markers",
      marker: "circle",
    });
  });
  const row = run.conditionId
    ? NBS_CHILLDOWN_DATA.find((p) => p.id === run.conditionId)
    : undefined;
  writeFig(
    TRACE_FIG0 + k,
    `trace-${run.runId.replace("nbs9264-", "")}`,
    lineChart({
      title: `NBS 9264 ${run.figure}: ${run.inletCondition} ${run.fluid.replace("2", "₂")} at ${row ? row.drivingPressure.psia : (run.drivingPressure.pa / 6894.757).toFixed(1)} psia`,
      xLabel: "Time t [s]",
      yLabel: "Wall temperature [K]",
      legend: "outside-right",
      yRange: [0, 320],
      series,
    }),
  );
});

// Outlet wall of the instrumented subcooled case: temperature against time at
// three resolutions, with the digitized station-4 trace of the same run.
const FIG_END = TRACE_FIG0 + TS.n6.length;
{
  const id = "subLN2-P61.74";
  const run = traceRunFor(NBS_CHILLDOWN_DATA.find((p) => p.id === id)!)!;
  const tr = run.traces[3];
  const stride = Math.max(1, Math.ceil(tr.timesS.length / 40));
  writeFig(
    FIG_END,
    "outlet-wall-handoff",
    lineChart({
      title: "Subcooled LN₂, 61.74 psia: station-4 wall temperature against N",
      xLabel: "Time t [s]",
      yLabel: "Wall temperature at station 4 [K]",
      legend: "outside-right",
      yRange: [60, 320],
      series: [
        ...DIAG_NS.map((N, i): Series => {
          const o = out(diagKey(id, N));
          const w = usable(o) ? interpolateStation4(o) : [];
          return {
            label: `Model, N = ${N}, Δt = ${diagDt(N)} s${o.converged ? "" : " (not converged)"}`,
            pts: w.map((T, k): [number, number] => [o.timesS[k], T]),
            color: [C.blue, C.green, C.orange, C.red][i],
            mode: "line",
          };
        }),
        {
          label: "Data (Fig. 13)",
          pts: tr.timesS
            .map((t, j): [number, number] => [t, tr.wallTempsK[j]])
            .filter((_, j) => j % stride === 0),
          color: C.grey,
          mode: "markers",
          marker: "circle",
        },
      ],
    }),
  );
}

/* ==========================================================================
 * Report markdown — derived quantities
 * ========================================================================== */

const flag = (r: Row) => (r.failed ? "†" : r.ok ? "" : "*");
const cell = (r: Row | undefined) =>
  r === undefined
    ? "—"
    : r.failed
      ? `failed† (${r.failed})`
      : `${fmt(r.t)} (${signedPct(r.err)})${flag(r)}`;
const trustedRows = (rs: Row[]) => sel(rs, (p) => trustOf(p) === "trusted");

const corpusTraces = NBS_TRACE_RUNS.reduce((a, r) => a + r.traces.length, 0);
const trustedTraces = NBS_TRUSTED_TRACE_RUNS.reduce(
  (a, r) => a + r.traces.length,
  0,
);
const coldTailUsable = NBS_TRUSTED_TRACE_RUNS.reduce(
  (a, r) => a + r.traces.filter((t) => t.qc.coldTailUsable).length,
  0,
);
const runRows = NBS_TRACE_RUNS.map((r) => {
  const usableTails = r.traces.filter((t) => t.qc.coldTailUsable).length;
  const n = r.traces.reduce((a, t) => a + t.timesS.length, 0);
  const flags = [...new Set(r.traces.flatMap((t) => t.qc.flags))];
  return `| ${r.figure} | ${r.fluid} | ${r.inletCondition} | ${r.drivingPressure.atm} | ${r.conditionId ?? "—"} | ${n} | ${usableTails}/4 | ${flags.length ? flags.join(", ") : "none"} | ${r.calibrationTier === "trusted" ? "trusted" : "diagnostic only"} |`;
}).join("\n");

const s3 = ourStats(R.P3);
const g18 = gfsspStats(R.P3);
const nTrustedRows = trustedRows(R.P3).length;

const t6Rows = ALL_POINTS.map((p) => {
  const r3 = rowFor(R.P3, p);
  const r30 = REP_CASES.includes(p.id) ? repRow(PRIMARY_N, p) : undefined;
  const init = initialWallTemperatureForPoint(p);
  return `| ${fluidLabel(p)} | ${p.inletCondition} | ${p.drivingPressure.psia} | ${p.experimentalChilldownTimeS} | ${p.gfsspPredictedChilldownTimeS} (${signedPct(gfsspErr(p))}) | ${cell(r3)} | ${cell(r30)} | ${fmt(init.K, 0)}${init.source === "trace" ? "" : "ᵃ"} | ${recordOf(p)} | ${trustOf(p)} |`;
}).join("\n");

const statLine = (label: string, rs: Row[]) => {
  const o = ourStats(rs);
  const g = gfsspStats(rs);
  return `| ${label} | ${o.n} | ${o.mae.toFixed(1)} % | ${signedPct(o.signed)} | ${o.late} | ${g.mae.toFixed(1)} % | ${signedPct(g.signed)} | ${g.late} | ${Number.isFinite(o.corr) ? o.corr.toFixed(2) : "—"} |`;
};
const groupStatRows = (rsAll: Row[]) =>
  [
    statLine("All 18 rows", rsAll),
    statLine(`${nTrustedRows} trusted rows`, trustedRows(rsAll)),
    statLine(
      `${rsAll.filter((r) => r.ok).length} rows whose solve converged`,
      rsAll.filter((r) => r.ok),
    ),
    ...GROUPS.map((g) =>
      statLine(
        g.label,
        sel(rsAll, (p) => inGroup(p, g)),
      ),
    ),
  ].join("\n");
const STAT_HEAD = `| Rows | n | OpenFLUME MAE | OpenFLUME signed mean | OpenFLUME late | GFSSP MAE | GFSSP signed mean | GFSSP late | Correlation of errors |
| ---- | - | ------------- | --------------------- | -------------- | --------- | ----------------- | --------- | --------------------- |`;

/* Trends, computed: falling time with pressure within a group; subcooling
 * shortening the time at matched pressure. */
const trendFacts = (() => {
  let pairs = 0;
  let ok = 0;
  const wrong: string[] = [];
  for (const g of GROUPS) {
    const rs = sel(R.P3, (p) => inGroup(p, g)).sort(
      (a, b) => a.p.drivingPressure.psia - b.p.drivingPressure.psia,
    );
    for (let i = 1; i < rs.length; i++) {
      pairs++;
      if ((rs[i].t ?? NaN) < (rs[i - 1].t ?? NaN)) ok++;
      else
        wrong.push(
          `${g.label} ${rs[i - 1].p.drivingPressure.psia}→${rs[i].p.drivingPressure.psia} psia`,
        );
    }
  }
  let sPairs = 0;
  let sOk = 0;
  let measShorter = 0;
  let measEqual = 0;
  const sWrong: string[] = [];
  for (const sat of R.P3.filter((r) => r.p.inletCondition === "saturated")) {
    const sub = R.P3.find(
      (r) =>
        r.p.inletCondition === "subcooled" &&
        r.p.fluid === sat.p.fluid &&
        r.p.drivingPressure.psia === sat.p.drivingPressure.psia,
    );
    if (!sub) continue;
    sPairs++;
    const eS = sub.p.experimentalChilldownTimeS;
    const eT = sat.p.experimentalChilldownTimeS;
    if (eS < eT) measShorter++;
    else if (eS === eT) measEqual++;
    if ((sub.t ?? NaN) < (sat.t ?? NaN)) sOk++;
    else
      sWrong.push(
        `${fluidLabel(sat.p)} ${sat.p.drivingPressure.psia} psia (saturated ${fmt(sat.t)} s, subcooled ${fmt(sub.t)} s; measured ${sat.p.experimentalChilldownTimeS} s and ${sub.p.experimentalChilldownTimeS} s)`,
      );
  }
  return `Chilldown time falls with driving pressure in ${ok} of ${pairs} adjacent pairs of rows within a group${wrong.length ? ` (exceptions: ${wrong.join("; ")})` : ""}. At matched pressure the subcooled time is shorter than the saturated one in ${sOk} of ${sPairs} pairs${sWrong.length ? `; the exceptions are ${sWrong.join("; ")}` : ""}, where the measured subcooled time is the shorter in ${measShorter} of the ${sPairs} pairs${measEqual ? ` and equal in ${measEqual}` : ""}.`;
})();

// The representative subset: OpenFLUME at each N against GFSSP's published values.
const subsetStat = (N: number) => ourStats(R.grid[N]);
const subsetG = gfsspStats(R.grid[PRIMARY_N]);
const subsetStatRows = [
  ...GRID_NS.map((N) => {
    const o = subsetStat(N);
    return `| OpenFLUME, N = ${N} | ${o.n} | ${o.mae.toFixed(1)} % | ${signedPct(o.signed)} | ${o.late} | ${range(R.grid[N].map((r) => r.err))} |`;
  }),
  `| GFSSP (30 segments), published | ${subsetG.n} | ${subsetG.mae.toFixed(1)} % | ${signedPct(subsetG.signed)} | ${subsetG.late} | ${range(REPS.map(gfsspErr))} |`,
].join("\n");

const gridTable = REPS.map(
  (p) =>
    `| ${fluidLabel(p)} ${p.inletCondition} | ${p.drivingPressure.psia} | ${p.experimentalChilldownTimeS} | ${p.gfsspPredictedChilldownTimeS} (${signedPct(gfsspErr(p))}) | ${GRID_NS.map((N) => cell(repRow(N, p))).join(" | ")} |`,
).join("\n");

const layoutRows = ALL_POINTS.map((p) => {
  const a3 = rowFor(R.L3, p);
  const b3 = rowFor(R.P3, p);
  return `| ${fluidLabel(p)} ${p.inletCondition} | ${p.drivingPressure.psia} | ${p.experimentalChilldownTimeS} | ${cell(a3)} | ${cell(b3)} |`;
}).join("\n");
const layoutRows12 = REPS.map((p) => {
  const a = rowFor(R.L12, p);
  const b = repRow(12, p);
  return `| ${fluidLabel(p)} ${p.inletCondition} | ${p.drivingPressure.psia} | ${p.experimentalChilldownTimeS} | ${cell(a)} | ${cell(b)} |`;
}).join("\n");
const layoutS3 = ourStats(R.L3);

const initRows = ALL_POINTS.map((p) => {
  const ini = initialWallTemperatureForPoint(p);
  const a3 = rowFor(R.T3, p);
  const b3 = rowFor(R.P3, p);
  return `| ${fluidLabel(p)} ${p.inletCondition} | ${p.drivingPressure.psia} | ${fmt(ini.K, 1)}${ini.source === "trace" ? "" : "ᵃ"} | ${cell(a3)} | ${cell(b3)} | ${signedSec((b3.t ?? NaN) - (a3.t ?? NaN))} |`;
}).join("\n");
const initS300 = ourStats(R.T3);
const initShiftS = R.P3.map((r, i) => (r.t ?? NaN) - (R.T3[i].t ?? NaN)).filter(
  Number.isFinite,
);
const bracketRows = noTrace.map((p) => {
  const lo = out(jkey("t6", p.id, CI_N, "TLO"));
  const hi = out(jkey("t6", p.id, CI_N, "THI"));
  const mid = rowFor(R.P3, p);
  return { p, lo: timeOf(lo), hi: timeOf(hi), mid: mid.t };
});
const bracketTable = bracketRows
  .map(
    (b) =>
      `| ${fluidLabel(b.p)} ${b.p.inletCondition} | ${b.p.drivingPressure.psia} | ${fmt(b.lo)} | ${fmt(b.mid)} | ${fmt(b.hi)} | ${fmt((b.hi ?? NaN) - (b.lo ?? NaN))} |`,
  )
  .join("\n");
const bracketSpread = bracketRows
  .map((b) => (b.hi ?? NaN) - (b.lo ?? NaN))
  .filter(Number.isFinite);

const runInitRows = NBS_TRACE_RUNS.map((r) => {
  const i = runInitialWallTemperature(r);
  return `| ${r.figure} | ${r.fluid} ${r.inletCondition} | ${i.perStationK.map((x) => fmt(x, 1)).join(" / ")} | ${fmt(i.medianK, 1)} |`;
}).join("\n");

const kneeSensTable = kneeSens
  .map(
    (k) =>
      `| ${fluidLabel(k.p)} ${k.p.inletCondition} | ${k.p.drivingPressure.psia} | ${fmt(k.p.experimentalChilldownTimeS, 0)} | ${fmt(k.pLocalPa === undefined ? NaN : k.pLocalPa / 6894.757, 2)} | ${fmt(k.thresholdK)} | ${fmt(k.t15)} | ${fmt(k.t30)} | ${signedSec(k.shift)} |`,
  )
  .join("\n");
const shiftPcts = kneeSens.map((k) => k.shiftPct).filter(Number.isFinite);

const dataKneeRows = dataKnees
  .map((d) => {
    const exp = d.p.experimentalChilldownTimeS;
    return `| ${d.run.figure} | ${d.p.drivingPressure.psia} | ${exp} | ${fmt(d.thresholdK)} | ${d.dataKneeS === undefined ? `not reached (minimum ${fmt(d.minK, 0)} K)` : `${fmt(d.dataKneeS)} (${signedPct(errPct(d.dataKneeS, exp))})`} | ${fmt(d.modelS)} (${signedPct(errPct(d.modelS, exp))}) | ${d.inletRefKneeS === undefined ? "not reached" : `${fmt(d.inletRefKneeS)} (${signedPct(errPct(d.inletRefKneeS, exp))})`} |`;
  })
  .join("\n");
const dkAvail = dataKnees.filter((d) => d.dataKneeS !== undefined);
const dkErr = dkAvail.map((d) =>
  errPct(d.dataKneeS, d.p.experimentalChilldownTimeS),
);

/* Time-step study summary. */
const dtMaxResid = (n: number) =>
  Math.max(
    ...dtRows
      .filter((r) => r.N === n)
      .map((r) => dtResid(r, IDT, IDT + 1))
      .filter(Number.isFinite),
  );
const dtFailed = dtRows.flatMap((r) =>
  DT_LEVELS.flatMap((m, i) =>
    r.failed[i] || !r.converged[i]
      ? [
          `${fluidLabel(r.p)} ${r.p.inletCondition} ${r.p.drivingPressure.psia} psia, N = ${r.N}, Δt = ${fmt(r.dts[i], 3)} s: ${r.failed[i] ? r.failed[i] : "not converged"}`,
        ]
      : [],
  ),
);

const dtCell = (r: DtRow, i: number) =>
  r.notRun[i]
    ? "not run"
    : r.failed[i]
      ? `failed† (${r.failed[i]})`
      : `${fmt(r.times[i])}${r.converged[i] ? "" : "*"}`;
const dtTable = dtRows
  .map(
    (r) =>
      `| ${fluidLabel(r.p)} ${r.p.inletCondition} ${r.p.drivingPressure.psia} | ${r.N} | ${DT_LEVELS.map((_, i) => dtCell(r, i)).join(" | ")} | ${fmt(dtResid(r, IDT, IDT + 1))} | ${fmt(dtResid(r, IDT + 1, IDT + 2))} |`,
  )
  .join("\n");
const dtHead = `| Case | N | Δt × 2 | Δt (used) | Δt / 2 | Δt / 4 | |Δt − Δt/2| [s] | |Δt/2 − Δt/4| [s] |
| ---- | - | ------ | --------- | ------ | ------ | ------------- | --------------- |`;

/* Diagnosis table. */
const diagRow = (c: DiagCase) => {
  const share = (k: string) => fmt((c.wallShare[k] ?? 0) * 100, 0);
  const d = c.o.diag;
  const closure = d
    ? `${((d.fluidEnthalpyGainJ / d.wallEnergyRemovedJ - 1) * 100).toFixed(1)} %`
    : "—";
  return `| ${c.id} | ${c.N}${c.o.converged ? "" : "*"} | ${diagDt(c.N)} | ${fmt(c.t250)} | ${fmt(c.t150)} | ${fmt(c.knee)} | ${c.tKneeLiquid === undefined ? "never" : fmt(c.tKneeLiquid)} | ${c.minQuality === undefined ? "—" : fmt(c.minQuality, 3)} | ${fmt(c.shelfMinH, 0)} | ${c.hLiquid === undefined ? "—" : fmt(c.hLiquid, 0)} | ${share("vapor")} / ${share("twoPhase")} / ${share("liquid")} | ${closure} |`;
};
const diagRows = diagCases
  .filter((c) => usable(c.o))
  .map(diagRow)
  .join("\n");
const dSubAll = DIAG_NS.map((N) => diagOf("subLN2-P61.74", N)).filter((c) =>
  usable(c.o),
);
const dSub = dSubAll.filter((c) => c.o.converged);
const dSat = DIAG_NS.map((N) => diagOf("satLN2-P86.73", N)).filter((c) =>
  usable(c.o),
);
const minMax = (xs: number[], d = 0) =>
  xs.length === 0
    ? "—"
    : Math.min(...xs) === Math.max(...xs)
      ? Math.min(...xs).toFixed(d)
      : `${Math.min(...xs).toFixed(d)}–${Math.max(...xs).toFixed(d)}`;
const fin = (xs: (number | undefined)[]) =>
  xs.filter((x): x is number => x !== undefined && Number.isFinite(x));
const subMinH = fin(dSub.map((c) => c.shelfMinH));
const satMinH = fin(dSat.map((c) => c.shelfMinH));
const subHLiq = fin(dSub.map((c) => c.hLiquid));
const subMinQ = fin(dSub.map((c) => c.minQuality));
const satMinQ = fin(dSat.map((c) => c.minQuality));

const legacyDiag = DIAG_NS.filter((n) => n !== PRIMARY_N).map((N) =>
  timeOf(out(jkey("dgL", DIAG_CASES[0], N, "LEG", DIAG_DT))),
);
const legacyGrowth =
  (legacyDiag[legacyDiag.length - 1] ?? NaN) - (legacyDiag[0] ?? NaN);
const internalGrowth =
  (dSubAll.find((c) => c.N === 12)?.knee ?? NaN) -
  (dSubAll.find((c) => c.N === 3)?.knee ?? NaN);
/** Interval from the outlet wall's 150 K arrival to its knee. */
const shelfInterval = (c: DiagCase) => (c.knee ?? NaN) - c.t150;

/* Trace-section derived numbers. */
const traceStationRows = (set: TraceSolve[]) =>
  set
    .map((ts) =>
      ts.cmp.stations
        .map((s) => {
          const k = stationKnee(ts, s.station);
          const a = arrival150(ts, s.station);
          return `| ${ts.run.figure} | ${s.station} | ${fmt(s.kneeThresholdK)} | ${fmt(a.data)} | ${fmt(a.model)} | ${fmt(k.data)} | ${fmt(k.model)} | ${Number.isFinite(k.lag) ? signedSec(k.lag) : "—"} | ${fmt(s.metrics.rmseK)} |`;
        })
        .join("\n"),
    )
    .join("\n");
const pooledRow = (ts: TraceSolve) => {
  const o = ts.o;
  const c = specConditions(o.spec);
  return `| ${ts.run.figure} | ${ts.run.inletCondition} ${ts.run.fluid}, ${ts.run.drivingPressure.atm} atm | ${c.fluidName}, N = ${ts.N}, Δt = ${o.spec.dtS} s, T₀ = ${fmt(o.spec.initialK ?? 300, 1)} K | ${o.converged ? "yes" : "no"} | ${fmt(ts.cmp.pooled.rmseK)} | ${fmt(ts.cmp.pooled.maeK)} |`;
};
const rmseOf = (set: TraceSolve[], cond: "saturated" | "subcooled") =>
  set
    .filter((t) => t.run.inletCondition === cond)
    .map((t) => t.cmp.pooled.rmseK ?? NaN);
const kRange = (xs: number[]) =>
  `${Math.min(...xs).toFixed(1)}–${Math.max(...xs).toFixed(1)} K`;
const lagsAt = (set: TraceSolve[], f: (ts: TraceSolve) => number) =>
  set.map(f).filter(Number.isFinite);
const countSign = (xs: number[]) => ({
  late: xs.filter((x) => x > 0).length,
  early: xs.filter((x) => x < 0).length,
  n: xs.length,
});
const lagRange = (xs: number[]) => range(xs, 1, signedSec);

const traceFindings = (set: TraceSolve[], label: string) => {
  const k1 = set.map((t) => stationKnee(t, 1));
  const k4 = set.map((t) => stationKnee(t, 4));
  const k1Lag = k1.map((x) => x.lag).filter(Number.isFinite);
  const k4Lag = k4.map((x) => x.lag).filter(Number.isFinite);
  const reach1 = k1.filter((x) => Number.isFinite(x.model)).length;
  const dataReach1 = k1.filter((x) => Number.isFinite(x.data)).length;
  const a1 = lagsAt(set, (t) => arrival150(t, 1).lag);
  const a234 = [2, 3, 4].flatMap((st) =>
    lagsAt(set, (t) => arrival150(t, st).lag),
  );
  const e1 = lagsAt(set, (t) => edgeLag(t, 1).lag);
  const e4 = lagsAt(set, (t) => edgeLag(t, 4).lag);
  const fw = set.map(frontWidth);
  const ratios = fw
    .filter((f) => f.model !== undefined && f.data !== undefined)
    .map((f) => f.model! / f.data!);
  const sg = countSign(a234);
  const lines: string[] = [];
  lines.push(
    `- **Station 1 (6.1 m, ${label}).** The modeled wall reaches the unified knee threshold inside the record in ${reach1} of ${set.length} runs (the data trace does in ${dataReach1}). Where both knees exist the model's is ${lagRange(k1Lag)} from the measured one (${countSign(k1Lag).late} later, ${countSign(k1Lag).early} earlier of ${k1Lag.length}). The 150 K arrival at station 1 differs by ${lagRange(a1)}; the first 30 K of cooling (the leading edge) by ${lagRange(e1)}.`,
  );
  lines.push(
    `- **Station 4 (60.35 m).** Where both knees exist the model's is ${lagRange(k4Lag)} from the measured one (${countSign(k4Lag).late} later, ${countSign(k4Lag).early} earlier of ${k4Lag.length}); the leading edge differs by ${lagRange(e4)}.`,
  );
  lines.push(
    `- **150 K arrivals at stations 2–4.** The modeled arrival is later than the measured one in ${sg.late} and earlier in ${sg.early} of ${sg.n} station pairs (range ${lagRange(a234)}). The model and the data order the stations' arrivals identically in ${set.filter((t) => t.cmp.front150.discordantPairs === 0).length} of ${set.length} runs.`,
  );
  lines.push(
    `- **Front width at station 4** (time from 250 K to the knee threshold): model ${fw.map((f) => fmt(f.model)).join(", ")} s against data ${fw.map((f) => fmt(f.data)).join(", ")} s (— : not available, the data trace's cold tail is QC-excluded or a threshold is not reached). Where both exist the model/data ratio is ${ratios.length ? `${Math.min(...ratios).toFixed(1)}–${Math.max(...ratios).toFixed(1)}` : "—"}.`,
  );
  return lines.join("\n");
};

const subsetTraceRows = TS.n30
  .map((t30) => {
    const t6 = TS.n6.find((t) => t.run.runId === t30.run.runId)!;
    return `| ${t30.run.figure} | ${fmt(t6.cmp.pooled.rmseK)} | ${fmt(t30.cmp.pooled.rmseK)} | ${signedSec(stationKnee(t6, 1).lag)} | ${signedSec(stationKnee(t30, 1).lag)} | ${signedSec(stationKnee(t6, 4).lag)} | ${signedSec(stationKnee(t30, 4).lag)} |`;
  })
  .join("\n");

const failedList = [...solved.entries()]
  .filter(([, o]) => o.failed)
  .map(([k, o]) => `- \`${k}\`: ${o.failed}`);
const nonConvList = notConverged.map(
  ([k, o]) => `- \`${k}\`: ${o.stalledSteps.length} stalled step(s)`,
);

/* ==========================================================================
 * The report
 * ========================================================================== */

const figLink = (n: number, caption: string) =>
  `![Figure ${n}](figures/chilldown/${figures[n]})\n\n*Figure ${n}. ${caption}*`;

const report = `# Cryogenic Transfer-Line Chilldown Validation of OpenFLUME

**Validation against experiment: NBS Report 9264 chilldown times and digitized wall-temperature traces, with GFSSP's published predictions as a code-to-code reference**

Generated by \`scripts/chilldown-validation-report.ts\` — all model numbers and
figures come from live solves of the current solver. The corresponding CI
gates are \`src/ui/tests/chilldownBaseline.test.ts\` (saturated and subcooled
LN₂ Table-6 cases and the trusted trace runs; the full suite runs under
\`RUN_SLOW=1\`), \`src/validation/__tests__/nbsTraceCorpus.test.ts\` (trace
corpus structure, trust levels, QC, provenance hash),
\`src/validation/__tests__/traceBaseline.test.ts\` (trace-comparison
plumbing) and \`src/validation/__tests__/nbsInitialTemperature.test.ts\`
(initial wall temperatures).

## Abstract

This report compares OpenFLUME's two-phase chilldown model with the measured
cooldown of a 61 m vacuum-jacketed copper transfer line, NBS Report 9264
(Brennan et al., 1966), and with the predictions that GFSSP published for the
same tests. It is validation against experiment and therefore subject to the
modeling, closure, discretization, and measurement uncertainties discussed
below. It is also a case in which one-dimensional codes do not fully agree
with the measurement, because both omit the nucleate and transition boiling
regimes; it is included because GFSSP includes it. All eighteen chilldown
times of Table 6 (liquid nitrogen and liquid hydrogen, saturated and
subcooled) are solved at the 3-segment CI configuration, from the measured
initial wall temperature of each run and with one knee definition applied
alike to the model and to the digitized data; trust levels are assigned from
the experimental record alone. Over the eighteen rows the mean absolute error
is ${s3.mae.toFixed(1)} % for OpenFLUME (signed mean ${signedPct(s3.signed)}, ${s3.late} of 18 late)
and ${g18.mae.toFixed(1)} % for GFSSP's published 33-node predictions (signed mean
${signedPct(g18.signed)}, ${g18.late} of 18 late); the correlation of the two sets of errors is
${s3.corr.toFixed(2)}. A representative subset (saturated and subcooled LN₂ and LH₂) is
also solved at GFSSP's 30 segments: its mean absolute error is
${subsetStat(3).mae.toFixed(1)} % at N = 3, ${subsetStat(PRIMARY_N).mae.toFixed(1)} % at N = ${PRIMARY_N} and ${subsetG.mae.toFixed(1)} % for GFSSP.
The subcooled liquid-nitrogen case at 61.74 psia is ${cell(repRow(3, REPS[1]))} at N = 3 and ${cell(repRow(PRIMARY_N, REPS[1]))} at N = ${PRIMARY_N} (GFSSP ${signedPct(gfsspErr(REPS[1]))}); it is not time-step converged (the knee falls as the step is refined and the finer-step solves do not converge). At the one step at which all its diagnostic solves converge (Δt = 10 s) the knee of the GFSSP layout changes by ${fmt(internalGrowth)} s between N = 3 and N = 12, against ${fmt(legacyGrowth)} s for the earlier layout: for this case the growth of the error with refinement that the earlier layout showed was the layout. The converged solves show the outlet wall waiting on a low-quality film-boiling shelf that ends when the outlet node turns to single-phase liquid ("Subcooled liquid nitrogen" below); the correlation as implemented is the documented one.
Cryogenic chilldown is the least mature area of the code;
the numbers below are the evidence for that statement.

## Experiment and Data

### The NBS 9264 transfer line

Brennan, Brentari, Smith, and Steward (NBS Report 9264, 1966) admitted
liquid hydrogen and liquid nitrogen from a pressurized dewar into a
horizontal, vacuum-jacketed copper line, ${NBS_CHILLDOWN_RIG.lengthM / 0.3048} ft
(${NBS_CHILLDOWN_RIG.lengthM} m) long, 0.625 in
inside and 0.75 in outside diameter, venting to
the atmosphere. Wall thermocouples sat at four stations,
${NBS_CHILLDOWN_RIG.stations.map((s) => `${s.xFt} ft`).join(", ")} from the inlet
(${NBS_CHILLDOWN_RIG.stations.map((s) => `${s.xM.toFixed(2)} m`).join(", ")}). The
report defines the chilldown time as the low-temperature knee of the wall
temperature at 60.4 m (station 4) and notes that it is not uniquely defined.
NBS reports no error bars; the report's own caveats (thermocouple accuracy
traded for range, physically inconsistent low-temperature curve crossings,
chart-read knees) are carried with every data point.

### The knee definition

One definition is used for every chilldown time and every knee in this report.
At a station, the knee is the first smooth (linearly interpolated) crossing, from
above, of the threshold T_sat(P_local) + 15 K, where P_local is the mean over the
final 10 % of the solve of the model's pressure interpolated to the station.
The wall trace is interpolated in space to the exact station coordinate. The
same threshold temperature is then applied to the digitized trace of the same
run, so the model's and the data's knees are evaluated under the identical
definition; the digitized record carries no pressure, which is why the model
solve of the run at its driving pressure supplies it. A data trace that never
reaches the threshold has no knee under the definition, and is reported as such
(table "Knee of the digitized traces"). The definition is implemented once, in
\`localSaturationThreshold\` (\`src/validation/chilldownMetric.ts\`), and is used
by the Table-6 times, the trace comparison and the data knees alike.

### Table 6: chilldown times

The measured chilldown times are taken as tabulated, with GFSSP's
predictions, in Table 6 of Majumdar, LeClair, Moore, and Schallhorn
(AIAA 2015-3850): eighteen rows, verified digit for digit against the NTRS
scan and, for the hydrogen rows, against the earlier TFAWS 2013 paper. GFSSP's
values are model output and are used here as a code-to-code reference, never as
data. GFSSP's model of the line (§4.3 of that paper) has 30 pipe segments
and 31 fluid nodes, each with a solid node, and the dewar and the ambient outlet
as boundary nodes 1 and 33 (the paper's text is internally inconsistent about
the boundary nodes; this report follows its description of 31 fluid nodes with
solid nodes and two boundary nodes). OpenFLUME solves N segments with N − 1 solved
fluid nodes between two boundary nodes (the legacy layout) or N + 1 internal
fluid nodes (the GFSSP layout used here); N = 30 is GFSSP's resolution.
This report solves every row at N = ${CI_N}: four saturated and six subcooled hydrogen
rows, three saturated and five subcooled nitrogen rows.

### Initial wall temperature

The line was "at ambient temperature" before the valve opened and NBS 9264 gives no
number. The measured value is the pre-arrival plateau of the digitized wall
traces: the median of the first samples of a run's four station traces. Eleven runs give
${fmt(CORPUS_INITIAL_WALL_TEMPERATURE.minK, 1)}–${fmt(CORPUS_INITIAL_WALL_TEMPERATURE.maxK, 1)} K (mean ${fmt(CORPUS_INITIAL_WALL_TEMPERATURE.meanK, 1)} K), not the 300 K the line
builder defaults to (\`src/validation/nbsInitialTemperature.ts\`). A Table-6 row takes
the value of the digitized run of the same test where one exists (nine rows); the
other nine rows (ᵃ) take the mean of the eleven runs, with the lowest and highest
run value as the bracket over which the sensitivity is quoted. It is an input
from the record, never fitted; each value is applied as the uniform initial
temperature of the wall and of the fluid in the line.

| Figure | Run | First sample at stations 1–4 [K] | Median [K] |
| ------ | --- | -------------------------------- | ---------- |
${runInitRows}

### Digitized trace corpus and trust levels

Eleven oscillograph figures of NBS 9264 (Figs. 2–7 hydrogen, 10–14 nitrogen)
were digitized into ${corpusTraces} station traces and ${NBS_TRACE_DATASET.totalSamples}
samples (\`validation/data/digitized/chilldown/nbs9264_fig*.csv\`, rebuilt into
\`src/validation/generated/nbsTraceCorpusData.ts\` by \`npm run gen:trace-corpus\`;
the CSVs' SHA-256 is rechecked on every CI run). The physical run, not the
station trace, is the independent unit. Trust levels are assigned from the
experimental record alone. A run is **diagnostic only** when its record is
compromised as a whole: the cold tails of several stations overlap in the
figure so that their assignment to stations cannot be recovered, or the
valve opened before the chart's zero time so that every timing feature is
shifted by an unknown amount. Every other run is **trusted**. Per-trace QC
flags (curve crossings in the low-temperature region, truncated cold tails,
an oscillatory segment, drawn-line reconstruction) then restrict which
features of a trusted trace may be compared, and set its weight.

| Figure | Fluid | Inlet | P_drive [atm] | Table-6 row | Samples | Cold tail usable | QC flags | Trust level |
| ------ | ----- | ----- | ------------- | ----------- | ------- | ---------------- | -------- | ----------- |
${runRows}

**Trusted** runs: ${NBS_TRUSTED_TRACE_RUNS.length} runs, ${trustedTraces} traces, ${coldTailUsable} with a usable cold
tail. **Diagnostic-only** runs: ${NBS_DIAGNOSTIC_TRACE_RUNS.length} (${NBS_DIAGNOSTIC_TRACE_RUNS.map((r) => r.figure.replace("Fig. ", "")).join(", ")}), all
subcooled hydrogen. A Table-6 row inherits the trust level of the digitized
run of the same test where one exists; the other rows carry only the
report-wide NBS caveats and are trusted. The trust level describes the
measurement, not the model: rows the model reproduces poorly are reported
in full.

## Numerical Model

The line is built by \`buildChilldownTwoPhase\` (\`src/ui/examples.ts\`; the
shipped 20-segment cryogenic line cooldown example of user manual §7.11 is a
separate model) in GFSSP's layout of this line (\`endNodeLayout: "internal"\`): N equal pipe segments between
N + 1 internal fluid nodes at x = 0 … L with real-fluid (CoolProp,
homogeneous-equilibrium) properties, a lumped copper wall node on each of them
(so every wall node convects to a solved fluid node at its own position and none
to a boundary node), joined by axial conduction, and the saturated (or subcooled)
liquid inlet and the atmospheric outlet as boundary nodes on short, negligible-friction end
branches. The convection conductor is Miropolskii film boiling in the two-phase
states and Dittus–Boelter on single-phase states (\`src/core/correlations/miropolskii.ts\`).
The two end wall nodes own half a segment each and the end fluid nodes half a
segment of volume, so the total wall mass, wetted area and fluid volume equal
the line's (\`NBS_LINE_WALL_MODEL\`, \`src/validation/nbsChilldown.ts\`). The wall
uses the temperature-dependent NIST OFHC-copper specific heat and conductivity
(4–300 K, RRR 100); the vacuum jacket is represented by an adiabatic outer wall.
Nitrogen is CoolProp Nitrogen; hydrogen is ParaHydrogen. Transients use backward
Euler with a fixed step, Δt = ${NBS_TIME_STEP_S.LN2} s for nitrogen and ${NBS_TIME_STEP_S.LH2} s for hydrogen
(from the time-step study below), a horizon of three measured chilldown times (at least
300 s) and each run's measured initial wall temperature. Nothing in this
report is fitted: N, Δt and the initial temperature are fixed by the definitions
above, and the closure constants are the published ones.

The earlier layout (\`endNodeLayout: "boundary"\`: N segments between the boundary
nodes, the two end wall nodes borrowing a neighbouring fluid node) is kept for
comparison. It ties the outlet wall, the wall that defines the station-4 time,
to the fluid a segment length L/N upstream of it (20 m at N = 3).

## Results

### Table 6: experiment, GFSSP, and OpenFLUME

| Fluid | Inlet | P_drive [psia] | Experiment [s] | GFSSP [s] | OpenFLUME N = ${CI_N} [s] | OpenFLUME N = ${PRIMARY_N} [s] | T₀ [K] | Digitized record | Trust level |
| ----- | ----- | -------------- | -------------- | --------- | ----------- | ------------- | ------ | ---------------- | ----------- |
${t6Rows}

OpenFLUME errors are relative to experiment. N = ${CI_N} for all eighteen rows; N = ${PRIMARY_N} only for the
four representative rows (— : not solved). Station-4 knee as defined above.
ᵃ: mean initial wall temperature of the eleven runs (no digitized run of this
test). * : the solve did not converge. † : the solve failed or timed out.

${STAT_HEAD}
${groupStatRows(R.P3)}

OpenFLUME at N = ${CI_N}. The correlation is the Pearson correlation between OpenFLUME's
and GFSSP's relative errors over the rows. "Late" counts rows whose predicted time exceeds the measured one.
${trendFacts} ${failedList.length === 0 && nonConvList.length === 0 ? "All solves of the report converged." : "Solves that failed or did not converge are listed at the end of this section."}

${figLink(1, `Predicted against measured station-4 chilldown time for all eighteen Table-6 rows: GFSSP's published predictions and OpenFLUME (N = ${CI_N}; the four representative rows also at N = ${PRIMARY_N}).`)}

#### Representative subset at GFSSP's resolution

A saturated and a subcooled case of each fluid are solved at the refinement
ladder N = ${GRID_NS.join(", ")}; N = ${PRIMARY_N} is GFSSP's resolution. The other fourteen rows are not
solved above N = ${CI_N}.

| Case | P_drive [psia] | Experiment [s] | GFSSP [s] | ${GRID_NS.map((N) => `N = ${N}`).join(" | ")} |
| ---- | -------------- | -------------- | --------- | ${GRID_NS.map(() => "---").join(" | ")} |
${gridTable}

| Four-row subset | n | MAE | Signed mean | Late | Range of errors |
| --------------- | - | --- | ----------- | ---- | --------------- |
${subsetStatRows}

${figLink(2, "Predicted over measured station-4 chilldown time of the four representative cases against the number of axial segments.")}

### Time-step sensitivity

The step used (Δt, ${NBS_TIME_STEP_S.LN2} s for nitrogen and ${NBS_TIME_STEP_S.LH2} s for hydrogen) is doubled and halved
on the four representative cases at N = ${CI_N} (also quartered) and at N = ${PRIMARY_N}
(a quarter step is not solved at N = ${PRIMARY_N}); a solve is abandoned after ${SOLVE_TIMEOUT_S} s and listed.

${dtHead}
${dtTable}

(* : the solve did not converge; † : failed or timed out.) Between Δt and Δt/2 the
chilldown time moves by at most ${fmt(dtMaxResid(CI_N))} s at N = ${CI_N} and ${fmt(dtMaxResid(PRIMARY_N))} s at N = ${PRIMARY_N}
over the cases where both completed.${dtFailed.length ? `\n\nNot completed or not converged:\n\n${dtFailed.map((x) => `- ${x}`).join("\n")}` : ""}

### Knee of the digitized traces under the same definition

The threshold temperature of each digitized run's model solve (N = ${CI_N}) is applied to
the station-4 data trace of that run. The last column is the earlier
data-native convention (T_inlet + 15 K), which sits above the unified threshold
by the difference between the inlet liquid temperature and the local saturation
temperature at the late-time pressure.

| Figure | P_drive [psia] | Table 6 [s] | Threshold [K] | Data knee | Model knee | Data knee at T_inlet + 15 K |
| ------ | -------------- | ----------- | ------------- | --------- | ---------- | --------------------------- |
${dataKneeRows}

The data's knee under the identical definition is available for ${dkAvail.length} of ${dataKnees.length} digitized rows
and differs from the tabulated chilldown time by ${range(dkErr)}.
The tabulated Table-6 times and the digitized knees are two readings of the same
event, not independent constraints.

### Sensitivity to the knee margin

The margin above T_sat,local is varied on the N = ${CI_N} solves of all rows.

| Fluid | P_drive [psia] | Experiment [s] | P_local,late [psia] | Threshold at 15 K [K] | T_sat,local + 15 K [s] | T_sat,local + 30 K [s] | Shift |
| ----- | -------------- | -------------- | ------------------- | --------------------- | ----------------------- | ----------------------- | ----- |
${kneeSensTable}

Raising the margin from 15 K to 30 K moves the predicted time by ${range(
  kneeSens.map((k) => k.shift),
  1,
  signedSec,
)} (${range(shiftPcts)} of the measured time).

### Initial wall temperature: sensitivity

| Fluid | P_drive [psia] | T₀ used [K] | 300 K start | Measured T₀ start | Shift |
| ----- | -------------- | ----------- | ----------- | ----------------- | ----- |
${initRows}

With the 300 K start the mean absolute error at N = ${CI_N} is ${initS300.mae.toFixed(1)} % (signed mean ${signedPct(initS300.signed)}); with the measured initial
temperatures ${s3.mae.toFixed(1)} % (${signedPct(s3.signed)}). The shift in the predicted time is ${range(initShiftS, 1, signedSec)}.
For the nine rows without a digitized run, the lowest and highest initial temperature
of the corpus bracket the prediction (N = ${CI_N}):

| Fluid | P_drive [psia] | T₀ = ${fmt(CORPUS_INITIAL_WALL_TEMPERATURE.minK, 1)} K [s] | T₀ = ${fmt(CORPUS_INITIAL_WALL_TEMPERATURE.meanK, 1)} K [s] | T₀ = ${fmt(CORPUS_INITIAL_WALL_TEMPERATURE.maxK, 1)} K [s] | Spread [s] |
| ----- | -------------- | ------------ | ------------ | ------------ | ---------- |
${bracketTable}

The bracket spans ${range(bracketSpread, 1, (x) => `${x.toFixed(1)} s`).replace(" to ", " to ")} for these rows.

### Layout

| Fluid | P_drive [psia] | Experiment [s] | Legacy layout, N = ${CI_N} | GFSSP layout, N = ${CI_N} |
| ----- | -------------- | -------------- | ------------------ | ------------------ |
${layoutRows}

With the legacy layout the N = ${CI_N} mean absolute error is ${layoutS3.mae.toFixed(1)} % (signed mean ${signedPct(layoutS3.signed)}) against ${s3.mae.toFixed(1)} % (${signedPct(s3.signed)}) with GFSSP's layout.
At N = 12 the legacy layout's offset between the outlet wall and its fluid is 5 m, against 20 m at N = 3:

| Case | P_drive [psia] | Experiment [s] | Legacy layout, N = 12 | GFSSP layout, N = 12 |
| ---- | -------------- | -------------- | ------------------ | ------------------ |
${layoutRows12}

### Subcooled liquid nitrogen

The subcooled liquid-nitrogen case at 61.74 psia has the largest and least
stable error of the representative subset (${cell(repRow(3, REPS[1]))} at N = 3,
${cell(repRow(12, REPS[1]))} at N = 12, ${cell(repRow(PRIMARY_N, REPS[1]))} at N = ${PRIMARY_N}; GFSSP ${signedPct(gfsspErr(REPS[1]))}). Its
refinement behavior was traced with diagnostics that record the outlet fluid node (the one the outlet wall convects to)
and the heat the wall gives up by the phase of the fluid it is attached to. The
saturated case at 86.73 psia is the comparison.

| Case | N | Δt [s] | t(250 K) [s] | t(150 K) [s] | Knee [s] | First liquid at outlet node [s] | Minimum two-phase quality (wall < 150 K) | Minimum h, two-phase [W/m²K] | h at first liquid step [W/m²K] | Wall heat to vapor / two-phase / liquid [%] | Energy closure |
| ---- | - | ----- | ------------ | ------------ | -------- | ------------------------------- | ---------------------------------------- | ---------------------------- | ------------------------------ | -------------------------------------------- | -------------- |
${diagRows}

Station-4 wall temperatures (stations interpolated between wall nodes):

${figLink(FIG_END, "Subcooled LN₂ at 61.74 psia: station-4 wall temperature of the model at N = 3, 12 and 30 against the digitized Fig. 13 trace.")}

What the diagnostics show (a * on N marks a solve that did not converge; its numbers are
listed but not used in the statements below):

1. **The solves that did not converge.** ${
  dSubAll.filter((c) => !c.o.converged).length === 0
    ? "All subcooled diagnostic solves converged."
    : `Of the ${dSubAll.length} subcooled diagnostic solves, ${dSubAll
        .filter((c) => !c.o.converged)
        .map(
          (c) =>
            `N = ${c.N} (Δt = ${diagDt(c.N)} s: ${c.o.stalledSteps.length} stalled steps; energy closure ${c.o.diag ? fmt((c.o.diag.fluidEnthalpyGainJ / c.o.diag.wallEnergyRemovedJ - 1) * 100, 0) : "—"} %)`,
        )
        .join(
          ", ",
        )} did not converge, and are listed in the table but not used in the statements below.`
} The time-step table shows the same case failing, timing out or not converging at ${dtFailed.filter((x) => x.includes("LN₂ subcooled")).length} of its solves.
2. **Shelf and handoff, converged solves.** On the converged subcooled solves the outlet node's two-phase quality falls to
   ${minMax(subMinQ, 3)} while the outlet wall is below 150 K (saturated case: ${minMax(satMinQ, 2)}). The Miropolskii coefficient
   falls with quality (\`src/core/correlations/miropolskii.ts:54–57\`): its minimum is ${minMax(subMinH)} W/m²K on the subcooled
   shelf against ${minMax(satMinH)} W/m²K in the saturated case. When the outlet node's state becomes single-phase liquid the
   conductor switches to Dittus–Boelter (\`miropolskii.ts:24–30\`) and h is ${minMax(subHLiq)} W/m²K at the first liquid step.
   The first liquid step of the outlet node is ${minMax(
     dSub.map((c) => (c.tKneeLiquid ?? NaN) - (c.knee ?? NaN)),
     0,
   )} s after the station-4 knee of these solves
   (the station is interpolated between wall nodes); in the saturated case the outlet node never becomes liquid.
3. **The correlation as implemented is the documented one.** Its coefficients (0.023, exponents 0.8 and 0.4, and the factor Y with
   0.1, 0.4, 0.4) are those of Eq. 7h of the GFSSP manual, with Dittus–Boelter (Eq. 7g) on single-phase states, so the
   switch at the liquid boundary is the formulation's. Quality is clamped to [0.01, 0.99] inside the correlation
   (\`miropolskii.ts:34\`); the text of the GFSSP papers consulted does not say how GFSSP treats the limit x → 0. No change to the
   correlation was made: none follows from the formulation or from GFSSP's documented practice. The earlier crashes of
   these solves were a different defect, now fixed: the P–h clamp let a compressed-liquid state fall below the property
   library's range and its flash threw (\`src/core/fluids/realFluid.ts\`, commit 436fdc5).
4. **Refinement.** The chilldown time of this case in the diagnostic solves is ${dSubAll.map((c) => `${fmt(c.knee)} s${c.o.converged ? "" : "*"} (N = ${c.N})`).join(", ")}; in the saturated case ${dSat.map((c) => `${fmt(c.knee)} s${c.o.converged ? "" : "*"} (N = ${c.N})`).join(", ")}.
   For the converged solves the outlet wall's 150 K arrival is ${dSub.map((c) => `${fmt(c.t150)} s (N = ${c.N})`).join(", ")} and the interval from that arrival to the knee
   ${dSub.map((c) => `${fmt(shelfInterval(c))} s`).join(", ")}. For the saturated case the 150 K arrival is ${dSat.map((c) => `${fmt(c.t150)} s (N = ${c.N})`).join(", ")} and the interval ${dSat.map((c) => `${fmt(shelfInterval(c))} s`).join(", ")}. Why the outlet wall's arrival is later on a finer grid is not
   established here; a hypothesis, not tested, is that a coarse grid advances the fluid front numerically.
5. **Time step.** At N = ${CI_N} the knee of this case is ${dtRows
  .find((r) => r.p.id === REPS[1].id && r.N === CI_N)!
  .times.map(
    (t, i) =>
      `${fmt(t)} s${dtRows.find((r) => r.p.id === REPS[1].id && r.N === CI_N)!.converged[i] ? "" : "*"} (Δt = ${fmt(dtRows.find((r) => r.p.id === REPS[1].id && r.N === CI_N)!.dts[i], 2)} s)`,
  )
  .join(
    ", ",
  )}: it falls as the step is refined and the finer-step solves do not converge. At N = ${PRIMARY_N} two of the other three steps time out. The
   subcooled-nitrogen times are therefore not time-step converged, and none of them is quoted as a converged prediction. Whether the solver's failures to converge at fine steps reflect a physical flow-boiling instability or a numerical one is not established.
6. **Layout.** At the same step (Δt = ${DIAG_DT} s) the pre-GFSSP layout gives ${DIAG_NS.filter(
  (n) => n !== PRIMARY_N,
)
  .map((N) => {
    const o = out(jkey("dgL", DIAG_CASES[0], N, "LEG", DIAG_DT));
    return `${fmt(timeOf(o))} s${o.converged ? "" : "*"} (N = ${N})`;
  })
  .join(", ")} against ${dSubAll
  .filter((c) => c.N !== PRIMARY_N)
  .map((c) => `${fmt(c.knee)} s (N = ${c.N})`)
  .join(", ")} with GFSSP's layout.

### Wall-temperature traces of the trusted runs

The ${NBS_TRUSTED_TRACE_RUNS.length} trusted runs are solved at N = ${TRACE_N} (all) and, for the runs of the representative
subset (${TS.n30.map((t) => t.run.figure).join(", ")}), at N = ${PRIMARY_N}, each from its measured initial wall temperature, with Δt = ${NBS_TIME_STEP_S.LN2} s for nitrogen and
${NBS_TIME_STEP_S.LH2} s for para-hydrogen (the frozen calibration plan, \`TRACE_BASELINE_SOLVE_PLAN\`, differs from these: Δt = 10 s and 2.5 s, 300 K start);
subcooled runs start at their recorded inlet temperature. Model traces are interpolated to the exact station positions and aligned to the
digitized record; nothing is tuned. The knee threshold is the unified one, from each solve's own late-time pressure. These numbers are reported, not
gated.

| Run | Condition | Model | Converged | Pooled RMSE [K] | Pooled MAE [K] |
| --- | --------- | ----- | --------- | --------------- | -------------- |
${[...TS.n6, ...TS.n30].map(pooledRow).join("\n")}

| Run | Station | Knee threshold [K] | Data t(150 K) [s] | Model t(150 K) [s] | Data knee [s] | Model knee [s] | Knee lag | RMSE [K] |
| --- | ------- | ------------------ | ----------------- | ------------------ | ------------- | -------------- | -------- | -------- |
${traceStationRows(TS.n6)}

(N = ${TRACE_N}; — : the feature is unavailable — the trace never reaches it inside the record, or the data trace's cold tail is QC-excluded.)

Knee lags at stations 1 and 4 at the two resolutions, for the runs solved at both:

| Run | Pooled RMSE N = ${TRACE_N} [K] | Pooled RMSE N = ${PRIMARY_N} [K] | Station-1 lag N = ${TRACE_N} | Station-1 lag N = ${PRIMARY_N} | Station-4 lag N = ${TRACE_N} | Station-4 lag N = ${PRIMARY_N} |
| --- | ------------------------------ | ------------------------------- | ------------------- | -------------------- | ------------------- | -------------------- |
${subsetTraceRows}

Observations (computed from the tables; the figures overlay model and data). Pooled
RMSE at N = ${TRACE_N} is ${kRange(rmseOf(TS.n6, "saturated"))} for the saturated runs and ${kRange(rmseOf(TS.n6, "subcooled"))} for the subcooled ones.

${traceFindings(TS.n6, `N = ${TRACE_N}, all trusted runs`)}

${TS.n30.length ? traceFindings(TS.n30, `N = ${PRIMARY_N}, representative runs`) : ""}

${TS.n6.map((ts, k) => figLink(TRACE_FIG0 + k, `${ts.run.figure} of NBS 9264 (${ts.run.inletCondition} ${ts.run.fluid.replace("2", "₂")}, ${ts.run.drivingPressure.atm} atm): digitized wall temperature (markers) and the OpenFLUME solve (lines, N = ${ts.N}, Δt = ${ts.o.spec.dtS} s, T₀ = ${fmt(ts.o.spec.initialK, 1)} K) at the four stations.`)).join("\n\n")}

${failedList.length || nonConvList.length ? `### Solves that failed or did not converge\n\n${[...failedList, ...nonConvList].join("\n")}\n` : ""}
## Trust Levels

| Comparison | Evidence class | Trust level | What may be quoted |
| ---------- | -------------- | ----------- | ------------------ |
| Table-6 rows without a compromised record (${nTrustedRows} rows) | Validation against experiment | Trusted | The error, with the definition, initial temperature and discretization stated |
| Table-6 rows whose digitized record is compromised (${18 - nTrustedRows} rows) | Validation against experiment | Diagnostic only | The trend; the error with that caveat |
| GFSSP Table-6 predictions | Code-to-code | Reference | Agreement between codes, not with experiment |
| Subcooled LN₂ at N = ${PRIMARY_N} | Validation against experiment | Not time-step converged | That the time is not converged; not a point estimate |
| Trusted trace runs (Figs. 2, 5, 10, 11, 12, 13, 14) | Validation against experiment | Trusted, reported (not gated) | Station order, knees where available, RMSE as a baseline |
| Diagnostic trace runs (Figs. 3, 4, 6, 7) | Validation against experiment | Diagnostic only | Nothing quantitative |

## Conclusions

Over all eighteen NBS 9264 Table-6 chilldown times, OpenFLUME's untuned
two-phase network model has a mean absolute error of ${s3.mae.toFixed(1)} % at the CI
configuration (signed mean ${signedPct(s3.signed)}, ${s3.late} of 18 late), against ${g18.mae.toFixed(1)} % for GFSSP's published
predictions (${signedPct(g18.signed)}, ${g18.late} late); the correlation of the two sets of errors is ${s3.corr.toFixed(2)}.
At GFSSP's resolution the four-case subset has a mean absolute error of ${subsetStat(PRIMARY_N).mae.toFixed(1)} %
(${subsetStat(3).mae.toFixed(1)} % at N = 3; GFSSP ${subsetG.mae.toFixed(1)} %). The subcooled liquid-nitrogen case is
${signedPct(repRow(PRIMARY_N, REPS[1]).err)} from experiment at N = ${PRIMARY_N} and not converged in the time step, with the outlet
wall governed by the handoff from film boiling at low quality to single-phase liquid. The
chilldown-time comparison depends on the initial wall temperature
(${range(initShiftS, 1, signedSec)} between a 300 K and the measured start), on the knee margin
(${range(shiftPcts)} for 15 K against 30 K) and on the line's layout. Cryogenic chilldown remains the least
mature capability of the code, and these results are a baseline for model improvement, not a calibration.

## References

1. Brennan, J. A., Brentari, E. G., Smith, R. V., and Steward, W. G.,
   "Cooldown of Cryogenic Transfer Lines — An Experimental Report,"
   NBS Report 9264, National Bureau of Standards, Boulder CO, 1966
   (NASA-CR-81338, NTRS 19670007291).
2. Majumdar, A., LeClair, A., Moore, R., and Schallhorn, P., "Generalized
   Fluid System Simulation Program (GFSSP) Version 6," AIAA 2015-3850, 51st
   AIAA/SAE/ASEE Joint Propulsion Conference, 2015 (NTRS 20150016531),
   §4.3 and Table 6.
3. Majumdar, A., "No Vent Tank Fill and Transfer Line Chilldown Analysis by
   Generalized Fluid System Simulation Program (GFSSP)," TFAWS 2013
   (NASA M13-2805).
4. Miropolskii, Z. L., "Heat Transfer in Film Boiling of a Steam–Water
   Mixture in Steam-Generating Tubes," *Teploenergetika* 10(5), 1963,
   pp. 49–52, as used for chilldown by Cross, M. F., Majumdar, A. K.,
   Bennett, J. C., and Malla, R. B., "Modeling of Chill Down in Cryogenic
   Transfer Lines," *Journal of Spacecraft and Rockets* 39(2), 2002,
   pp. 284–289.
5. NIST Cryogenic Material Properties Database, "OFHC Copper (UNS
   C10100/C10200)," rev. 2010 (Marquardt, Le, and Radebaugh, 2000).

## Nomenclature

| Symbol | Meaning |
| ------ | ------- |
| MAE | mean absolute error |
| N | number of axial pipe segments |
| P_drive | dewar (driving) pressure |
| P_local,late | pressure at a station, mean over the final 10 % of the solve |
| RMSE | root-mean-square error between aligned traces |
| t(150 K) | first smooth crossing of 150 K |
| T₀ | initial wall temperature |
| T_inlet | inlet liquid temperature |
| T_sat, T_sat,local | saturation temperature; at the station's late-time pressure |
| Δt | solver time step |
`;

writeFileSync(join(outDir, "chilldown-report.md"), report);
console.log(`\nwrote docs/validation/chilldown-report.md`);

// Every figure the markdown links must exist.
const missing = [...report.matchAll(/\]\((figures\/chilldown\/[^)]+)\)/g)]
  .map((m) => m[1])
  .filter((f) => !existsSync(join(outDir, f)));
if (missing.length) {
  console.error(`MISSING FIGURES: ${missing.join(", ")}`);
  process.exit(1);
}
process.exit(0);
