/**
 * chilldown-validation-report.ts — generates the cryogenic transfer-line
 * chilldown validation report (docs/validation/chilldown-report.md) and its
 * SVG figures (docs/validation/figures/chilldown/).
 *
 * Evidence: NBS Report 9264 (Brennan et al. 1966) measurements, through
 *   (1) all eighteen Table-6 chilldown times as tabulated in AIAA 2015-3850,
 *       compared three ways — experiment, GFSSP's published prediction,
 *       OpenFLUME;
 *   (2) the digitized oscillograph corpus (11 runs, 44 station traces),
 *       whose structure, trust levels and QC are gated by
 *       src/validation/__tests__/nbsTraceCorpus.test.ts, and the untuned
 *       trace baseline of the trusted runs (src/validation/traceBaseline.ts).
 *
 * Trust levels come from the experimental record alone (QC flags of the
 * digitized runs, src/validation/nbsTraceCorpus.ts), never from the model's
 * error.  Every Table-6 row the model can represent is solved and reported.
 *
 * The LN₂ Table-6 solves mirror src/ui/tests/chilldownBaseline.test.ts (the
 * CI gate: N = 3, dt = 10 s fixed, station-4 knee at Tsat_local + 15 K) and
 * scripts/chilldown-baseline.ts (the manual N sweep).  All numbers come from
 * live solves — rerun after solver changes:
 *
 *   npx tsx scripts/chilldown-validation-report.ts
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChilldownTwoPhase } from "../src/ui/examples";
import {
  initRealFluids,
  physicalPosition,
  RealFluid,
  solveTransient,
  type NetworkConfig,
  type TransientResult,
} from "../src/core";
import {
  DEFAULT_CHILLDOWN_TIME_DEFINITION,
  getChilldownPoints,
  NBS_CHILLDOWN_DATA,
  NBS_CHILLDOWN_RIG,
  type ChilldownDataPoint,
  type ChilldownTimeDefinition,
} from "../src/validation/nbsChilldown";
import {
  predictedChilldownTimeSweep,
  type ChilldownMetricInput,
} from "../src/validation/chilldownMetric";
import {
  NBS_DIAGNOSTIC_TRACE_RUNS,
  NBS_TRACE_DATASET,
  NBS_TRACE_RUNS,
  NBS_TRUSTED_TRACE_RUNS,
  RUN_COMPROMISING_QC_FLAGS,
  getTraceRun,
  type TraceRun,
} from "../src/validation/nbsTraceCorpus";
import {
  TRACE_BASELINE_SOLVE_PLAN,
  compareRunTraces,
  extractModelStationTrace,
  type ModelWallHistory,
  type RunTraceComparison,
} from "../src/validation/traceBaseline";
import { thresholdCrossingTime } from "../src/validation/stationInterp";
import { C, lineChart, type Series } from "./lib/report-charts";

/** Driving pressure of a trace run in psia: the Table-6 value of the same
 * test where one exists, otherwise the corpus value converted from atm. */
function tracePsia(run: {
  conditionId?: string;
  drivingPressure: { atm: number; pa: number };
}): string {
  const row = run.conditionId
    ? NBS_CHILLDOWN_DATA.find((p) => p.id === run.conditionId)
    : undefined;
  return row
    ? String(row.drivingPressure.psia)
    : (run.drivingPressure.pa / 6894.757).toFixed(1);
}

type WallMaterial = "constant" | "ofhc-copper";
const WALL: WallMaterial = "ofhc-copper";

const fmt = (x: number | undefined, d = 1) =>
  x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(d);
const signedPct = (x: number, d = 1) =>
  Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)} %` : "—";
const range = (xs: number[], d = 1, f = signedPct) => {
  const v = xs.filter(Number.isFinite);
  return v.length === 0
    ? "—"
    : `${f(Math.min(...v), d)} to ${f(Math.max(...v), d)}`;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const meanAbs = (xs: number[]) => mean(xs.map(Math.abs));

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
const fig = (n: number, caption: string) =>
  `![Figure ${n}](figures/chilldown/${figures[n]})\n\n*Figure ${n}. ${caption}*`;

/* ==========================================================================
 * Table-6 solves
 * ========================================================================== */

const SENSITIVITY_DEFS: ChilldownTimeDefinition[] = [
  DEFAULT_CHILLDOWN_TIME_DEFINITION, // station 4, Tsat_local + 15 K
  { station: 4, threshold: { mode: "aboveLocalTsat", marginK: 30 } },
  { station: 4, threshold: { mode: "aboveInletLiquid", marginK: 15 } },
  { station: 4, threshold: { mode: "fixed", valueK: 100 } },
  { station: 3, threshold: { mode: "aboveLocalTsat", marginK: 15 } },
];

/** CoolProp fluid and fixed step per Table-6 fluid (protocol §3.1.6). */
const fluidNameOf = (p: ChilldownDataPoint) =>
  p.fluid === "LH2" ? "ParaHydrogen" : "Nitrogen";
const defaultDtOf = (p: ChilldownDataPoint) => (p.fluid === "LH2" ? 2.5 : 10);

interface Table6Run {
  point: ChilldownDataPoint;
  N: number;
  dt: number;
  wall: WallMaterial;
  converged: boolean;
  /** Set when the solve could not run to completion (e.g. a CoolProp
   *  abort or a timeout in an isolated child process). */
  failed?: string;
  times: (number | undefined)[]; // one per SENSITIVITY_DEFS entry
  thresholdK: number;
}

const fluids = new Map<string, RealFluid>();
const fluidFor = (name: string) => {
  if (!fluids.has(name)) fluids.set(name, new RealFluid(name));
  return fluids.get(name)!;
};

function table6Config(
  p: ChilldownDataPoint,
  N: number,
  dt: number,
  wall: WallMaterial,
): NetworkConfig {
  const subcooled = p.inletCondition === "subcooled";
  return buildChilldownTwoPhase({
    segments: N,
    length: NBS_CHILLDOWN_RIG.lengthM,
    drivingPressure: p.drivingPressure.pa,
    outletPressure: 101325,
    fluidName: fluidNameOf(p),
    ...(subcooled ? { inletTemperature: p.subcooledAtTemperature!.K } : {}),
    outletWallCoupling: "upwind",
    wallMaterial: wall,
    dt,
    endTime: subcooled ? 360 : 300,
    timeStepping: "fixed",
  });
}

function wallHistory(cfg: NetworkConfig, res: TransientResult) {
  return {
    timesS: res.times,
    wallXM: cfg.solidNodes!.map((s) => physicalPosition(s)?.x ?? s.x),
    wallTracesK: cfg.solidNodes!.map((s) => res.solidNodes![s.id].temperature),
  };
}

function runTable6(
  p: ChilldownDataPoint,
  N: number,
  opts: { dt?: number; wall?: WallMaterial } = {},
): Table6Run {
  const dt = opts.dt ?? defaultDtOf(p);
  const wall = opts.wall ?? WALL;
  const cfg = table6Config(p, N, dt, wall);
  const res = solveTransient(cfg);
  const f = fluidFor(fluidNameOf(p));
  const subcooled = p.inletCondition === "subcooled";
  const input: ChilldownMetricInput = {
    ...wallHistory(cfg, res),
    fluidXM: cfg.nodes.map((n) => physicalPosition(n)?.x ?? n.x),
    pressureTracesPa: cfg.nodes.map((n) => res.nodes[n.id].pressure),
    inletLiquidTempK: subcooled
      ? p.subcooledAtTemperature!.K
      : f.saturationTemperature(p.drivingPressure.pa),
    saturationTemperatureK: (pPa) => f.saturationTemperature(pPa),
  };
  const sweep = predictedChilldownTimeSweep(input, SENSITIVITY_DEFS);
  return {
    point: p,
    N,
    dt,
    wall,
    converged: res.converged,
    times: sweep.map((m) => m.timeS),
    thresholdK: sweep[0].thresholdK,
  };
}

/**
 * Some refined subcooled solves abort inside CoolProp-wasm (an abort
 * followed by an out-of-bounds memory access) or run without end; after
 * such an abort the wasm module is unusable for every later solve in the
 * process.  Those solves run in a child process with a timeout, and a
 * failure is reported as such — never dropped.
 */
const CASE_FLAG = "--solve-case=";
const caseArg = process.argv.find((a) => a.startsWith(CASE_FLAG));
if (caseArg) {
  await initRealFluids();
  const c = JSON.parse(caseArg.slice(CASE_FLAG.length)) as {
    id: string;
    N: number;
    dt?: number;
    wall?: WallMaterial;
  };
  const p = NBS_CHILLDOWN_DATA.find((x) => x.id === c.id)!;
  const r = runTable6(p, c.N, { dt: c.dt, wall: c.wall });
  console.log(
    `RESULT ${JSON.stringify({ converged: r.converged, times: r.times, thresholdK: r.thresholdK })}`,
  );
  process.exit(0);
}
const ISOLATED_TIMEOUT_S = 600;
function runTable6Isolated(
  p: ChilldownDataPoint,
  N: number,
  opts: { dt?: number; wall?: WallMaterial } = {},
): Table6Run {
  const dt = opts.dt ?? defaultDtOf(p);
  const wall = opts.wall ?? WALL;
  const out = spawnSync(
    process.execPath,
    [
      ...process.execArgv,
      fileURLToPath(import.meta.url),
      `${CASE_FLAG}${JSON.stringify({ id: p.id, N, dt, wall })}`,
    ],
    {
      encoding: "utf8",
      timeout: ISOLATED_TIMEOUT_S * 1000,
      maxBuffer: 1 << 26,
    },
  );
  const base = { point: p, N, dt, wall, thresholdK: NaN };
  const line = (out.stdout ?? "")
    .split("\n")
    .find((l) => l.startsWith("RESULT "));
  if (line) {
    const r = JSON.parse(line.slice(7)) as {
      converged: boolean;
      times: (number | null)[];
      thresholdK: number;
    };
    return {
      ...base,
      converged: r.converged,
      times: r.times.map((t) => t ?? undefined),
      thresholdK: r.thresholdK,
    };
  }
  const failed =
    out.error && (out.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
      ? `timed out after ${ISOLATED_TIMEOUT_S} s`
      : /memory access out of bounds|Aborted/.test(
            `${out.stderr ?? ""}${out.stdout ?? ""}`,
          )
        ? "CoolProp abort"
        : `exit ${out.status}`;
  return {
    ...base,
    converged: false,
    times: SENSITIVITY_DEFS.map(() => undefined),
    failed,
  };
}

mkdirSync(figDir, { recursive: true });
// Figure numbering depends on the number of trusted runs: clear stale SVGs.
for (const f of readdirSync(figDir))
  if (f.endsWith(".svg")) unlinkSync(join(figDir, f));

await initRealFluids();
console.log("Generating chilldown validation report…");

const errPct = (t: number | undefined, exp: number) =>
  t === undefined ? NaN : ((t - exp) / exp) * 100;
const ourErr = (r: Table6Run) =>
  errPct(r.times[0], r.point.experimentalChilldownTimeS);
const gfsspErr = (p: ChilldownDataPoint) =>
  errPct(p.gfsspPredictedChilldownTimeS, p.experimentalChilldownTimeS);

/** Table-6 row trust from the experimental record alone (see the module
 *  header of nbsTraceCorpus.ts): diagnostic only when the digitized record
 *  of the same run is compromised; otherwise trusted. */
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
const ALL_POINTS = GROUPS.flatMap((g) => getChilldownPoints(g.fluid, g.cond));
if (ALL_POINTS.length !== NBS_CHILLDOWN_DATA.length)
  throw new Error("Table 6: not every row is covered by GROUPS");

console.log(
  "Table 6 — all eighteen rows (N = 3; LN₂ Δt = 10 s, LH₂ Δt = 2.5 s)",
);
const t6 = ALL_POINTS.map((p) => runTable6(p, 3));
for (const r of t6)
  console.log(
    `  ${r.point.id}: exp ${r.point.experimentalChilldownTimeS} s, GFSSP ${r.point.gfsspPredictedChilldownTimeS} s, OpenFLUME ${fmt(r.times[0])} s (conv ${r.converged})`,
  );
console.log("Table 6 — same solves with the constant-cp wall (previous model)");
const t6Const = ALL_POINTS.map((p) => runTable6(p, 3, { wall: "constant" }));

const satLN2 = getChilldownPoints("LN2", "saturated");
const subLN2 = getChilldownPoints("LN2", "subcooled");
const runOf = (rs: Table6Run[], p: ChilldownDataPoint) =>
  rs.find((r) => r.point.id === p.id)!;
const satGate = satLN2.map((p) => runOf(t6, p));
const sub74 = subLN2.find((p) => p.id === "subLN2-P74.97")!;

console.log("Grid study, saturated LN₂ (N = 3, 4, 6, 8, 12)");
const GRID_NS = [3, 4, 6, 8, 12];
const gridRuns = new Map<number, Table6Run[]>();
for (const N of GRID_NS) {
  gridRuns.set(N, N === 3 ? satGate : satLN2.map((p) => runTable6(p, N)));
  console.log(
    `  N=${N}: ${gridRuns
      .get(N)!
      .map((r) => fmt(r.times[0]))
      .join(" / ")} s`,
  );
}
console.log("Grid study, subcooled LN₂ (N = 3, 6, 12)");
const SUB_NS = [3, 6, 12];
const subGrid = new Map<number, Table6Run[]>();
for (const N of SUB_NS) {
  subGrid.set(
    N,
    N === 3
      ? subLN2.map((p) => runOf(t6, p))
      : subLN2.map((p) => runTable6Isolated(p, N)),
  );
  console.log(
    `  N=${N}: ${subGrid
      .get(N)!
      .map((r) => r.failed ?? `${fmt(r.times[0])}${r.converged ? "" : "*"}`)
      .join(" / ")} s`,
  );
}
console.log("Time-step check, saturated LN₂ (N = 3, Δt = 5 s)");
const dt5Runs = satLN2.map((p) => runTable6(p, 3, { dt: 5 }));

/* ==========================================================================
 * Trace corpus — structure + the untuned trusted-run baseline
 * ========================================================================== */

const corpusTraces = NBS_TRACE_RUNS.reduce((a, r) => a + r.traces.length, 0);
const trustedTraces = NBS_TRUSTED_TRACE_RUNS.reduce(
  (a, r) => a + r.traces.length,
  0,
);
const coldTailUsable = NBS_TRUSTED_TRACE_RUNS.reduce(
  (a, r) => a + r.traces.filter((t) => t.qc.coldTailUsable).length,
  0,
);
const fig02 = getTraceRun("nbs9264-fig02");
const fig02Knee = thresholdCrossingTime(
  fig02.traces[3].timesS,
  fig02.traces[3].wallTempsK,
  fig02.inletLiquidTempK + 15,
  "below",
)!;
const fig02Table6 = NBS_CHILLDOWN_DATA.find(
  (p) => p.id === fig02.conditionId,
)!.experimentalChilldownTimeS;

interface TraceSolve {
  runId: string;
  model: ModelWallHistory;
  hInlet: number[];
  hFirst: number[];
  cmp: RunTraceComparison;
  converged: boolean;
  N: number;
  dt: number;
  fluidName: string;
}
function solveTraceRun(run: TraceRun, wall: WallMaterial): TraceSolve {
  const spec = TRACE_BASELINE_SOLVE_PLAN.find((s) => s.runId === run.runId)!;
  const cfg = buildChilldownTwoPhase({
    segments: spec.segments,
    length: NBS_CHILLDOWN_RIG.lengthM,
    drivingPressure: run.drivingPressure.pa,
    outletPressure: 101325,
    fluidName: spec.fluidName,
    ...(run.inletCondition === "subcooled"
      ? { inletTemperature: run.inletLiquidTempK }
      : {}),
    outletWallCoupling: "upwind",
    wallMaterial: wall,
    dt: spec.dtS,
    endTime: spec.endTimeS,
    timeStepping: "fixed",
  });
  const res = solveTransient(cfg);
  const model = wallHistory(cfg, res);
  const hOf = (id: string) =>
    (res.conductors?.[id] as { heatTransferCoeff?: number[] } | undefined)
      ?.heatTransferCoeff ?? [];
  return {
    runId: run.runId,
    model,
    hInlet: hOf("conv0"),
    hFirst: hOf("conv1"),
    cmp: compareRunTraces(run, model),
    converged: res.converged,
    N: spec.segments,
    dt: spec.dtS,
    fluidName: spec.fluidName,
  };
}

console.log("Trace baseline — the trusted runs");
const traceSolves = NBS_TRUSTED_TRACE_RUNS.map((run) => {
  const ts = solveTraceRun(run, WALL);
  console.log(
    `  ${run.runId}: converged=${ts.converged} pooled RMSE ${fmt(ts.cmp.pooled.rmseK)} K, MAE ${fmt(ts.cmp.pooled.maeK)} K`,
  );
  return ts;
});
const satTraceSolves = traceSolves.filter(
  (ts) => getTraceRun(ts.runId).inletCondition === "saturated",
);
const subTraceSolves = traceSolves.filter(
  (ts) => getTraceRun(ts.runId).inletCondition === "subcooled",
);
console.log("Trace baseline — saturated runs with the constant-cp wall");
const satTraceConst = satTraceSolves.map((ts) =>
  solveTraceRun(getTraceRun(ts.runId), "constant"),
);

/* Diagnostics: front sharpness at station 4, inlet-node convection. */
interface FrontWidth {
  runId: string;
  model?: number;
  data?: number;
  bandModel?: number;
  bandData?: number;
  hInletMean: number;
  hFirstMean: number;
}
const between = (t: number[], v: number[], hi: number, lo: number) => {
  const a = thresholdCrossingTime(t, v, hi, "below");
  const b = thresholdCrossingTime(t, v, lo, "below");
  return a !== undefined && b !== undefined ? b - a : undefined;
};
const frontWidths: FrontWidth[] = traceSolves.map((ts) => {
  const run = getTraceRun(ts.runId);
  const d = run.traces[3];
  const m = extractModelStationTrace(ts.model, 4);
  const Tk = run.inletLiquidTempK + 15;
  const usable = d.qc.coldTailUsable;
  const span = ts.model.timesS.map((t) => t <= run.timeSpanS);
  return {
    runId: ts.runId,
    model: between(m.timesS, m.valuesK, 250, Tk),
    data: usable ? between(d.timesS, d.wallTempsK, 250, Tk) : undefined,
    bandModel: between(m.timesS, m.valuesK, Tk + 15, Tk),
    bandData: usable ? between(d.timesS, d.wallTempsK, Tk + 15, Tk) : undefined,
    hInletMean: mean(ts.hInlet.filter((_, k) => k > 0 && span[k])),
    hFirstMean: mean(ts.hFirst.filter((_, k) => k > 0 && span[k])),
  };
});

/* 150 K arrival lag (model − data) per station, where both are available. */
const arrivalLag = (ts: TraceSolve, station: number) => {
  const s = ts.cmp.stations[station - 1];
  const m = s.modelFeatures.crossing150KS;
  const d = s.dataFeatures.crossing150KS;
  return m.available && d.available ? m.value - d.value : NaN;
};
const lags234 = traceSolves.flatMap((ts) =>
  [2, 3, 4].map((st) => arrivalLag(ts, st)),
);
const secs = (x: number, d = 1) =>
  Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)} s` : "—";
const figNo = (ts: TraceSolve) =>
  getTraceRun(ts.runId).figure.replace("Fig. ", "");
const figPhrase = (ts: TraceSolve[]) =>
  ts.length === 1
    ? `Fig. ${figNo(ts[0])}`
    : `Figs. ${ts.slice(0, -1).map(figNo).join(", ")} and ${figNo(ts[ts.length - 1])}`;
const runsWithDiscordant = traceSolves.filter(
  (ts) => ts.cmp.front150.discordantPairs > 0,
);

/* ==========================================================================
 * Figures
 * ========================================================================== */

const tMax = Math.max(
  ...t6.flatMap((r) => [
    r.point.experimentalChilldownTimeS,
    r.point.gfsspPredictedChilldownTimeS,
    r.times[0] ?? 0,
  ]),
);
const axisTop = Math.ceil((tMax * 1.05) / 50) * 50;
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
        label: "GFSSP (published)",
        pts: t6.map((r): [number, number] => [
          r.point.experimentalChilldownTimeS,
          r.point.gfsspPredictedChilldownTimeS,
        ]),
        color: C.orange,
        mode: "markers",
        marker: "square",
      },
      {
        label: "OpenFLUME, saturated (N = 3)",
        pts: t6
          .filter((r) => r.point.inletCondition === "saturated")
          .map((r): [number, number] => [
            r.point.experimentalChilldownTimeS,
            r.times[0] ?? NaN,
          ]),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
      {
        label: "OpenFLUME, subcooled (N = 3)",
        pts: t6
          .filter((r) => r.point.inletCondition === "subcooled")
          .map((r): [number, number] => [
            r.point.experimentalChilldownTimeS,
            r.times[0] ?? NaN,
          ]),
        color: C.red,
        mode: "markers",
        marker: "triangle",
      },
    ],
  }),
);

const gridColors = [C.blue, C.red, C.green, C.orange, C.grey];
const gridMarkers = [
  "circle",
  "square",
  "triangle",
  "diamond",
  "circle",
] as const;
const gridChart = (
  title: string,
  points: ChilldownDataPoint[],
  ns: number[],
  runs: Map<number, Table6Run[]>,
) =>
  lineChart({
    title,
    xLabel: "Pipe segments N",
    yLabel: "Station-4 chilldown time [s]",
    legend: "outside-right",
    series: points.flatMap((p, i): Series[] => [
      {
        label: `OpenFLUME, ${p.drivingPressure.psia} psia`,
        pts: ns.map((N): [number, number] => [
          N,
          runs.get(N)![i].times[0] ?? NaN,
        ]),
        color: gridColors[i],
        mode: "both",
        marker: gridMarkers[i],
      },
      {
        label: `Experiment, ${p.drivingPressure.psia} psia`,
        pts: [
          [ns[0], p.experimentalChilldownTimeS],
          [ns[ns.length - 1], p.experimentalChilldownTimeS],
        ],
        color: gridColors[i],
        mode: "line",
        dash: "6 4",
      },
    ]),
  });
writeFig(
  2,
  "grid-study",
  gridChart(
    "Saturated LN₂: chilldown time against axial segments",
    satLN2,
    GRID_NS,
    gridRuns,
  ),
);
writeFig(
  3,
  "grid-study-subcooled",
  gridChart(
    "Subcooled LN₂: chilldown time against axial segments",
    subLN2,
    SUB_NS,
    subGrid,
  ),
);

const TRACE_FIG0 = 4;
const stationColors = [C.blue, C.red, C.green, C.orange];
traceSolves.forEach((ts, k) => {
  const run = getTraceRun(ts.runId);
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
  writeFig(
    TRACE_FIG0 + k,
    `trace-${ts.runId.replace("nbs9264-", "")}`,
    lineChart({
      title: `NBS 9264 ${run.figure}: ${run.inletCondition} ${run.fluid.replace("2", "₂")} at ${tracePsia(run)} psia`,
      xLabel: "Time t [s]",
      yLabel: "Wall temperature [K]",
      legend: "outside-right",
      yRange: [0, 320],
      series,
    }),
  );
});

/* ==========================================================================
 * Report markdown
 * ========================================================================== */

const fluidLabel = (p: ChilldownDataPoint) =>
  p.fluid === "LN2" ? "LN₂" : "LH₂";
const t6Rows = t6
  .map((r) => {
    const p = r.point;
    const exp = p.experimentalChilldownTimeS;
    return `| ${fluidLabel(p)} | ${p.inletCondition} | ${p.drivingPressure.psia} | ${exp} | ${p.gfsspPredictedChilldownTimeS} | ${signedPct(gfsspErr(p))} | ${fmt(r.times[0])} | ${signedPct(ourErr(r))} | ${r.converged ? "yes" : "no"} | ${recordOf(p)} | ${trustOf(p)} |`;
  })
  .join("\n");

const groupStats = GROUPS.map((g) => {
  const rs = t6.filter(
    (r) => r.point.fluid === g.fluid && r.point.inletCondition === g.cond,
  );
  const ok = rs.filter((r) => r.converged && Number.isFinite(ourErr(r)));
  const trusted = ok.filter((r) => trustOf(r.point) === "trusted");
  const cst = rs.map((r) => runOf(t6Const, r.point));
  return {
    ...g,
    n: rs.length,
    nOk: ok.length,
    ours: meanAbs(ok.map(ourErr)),
    gfssp: meanAbs(rs.map((r) => gfsspErr(r.point))),
    oursTrusted: trusted.length ? meanAbs(trusted.map(ourErr)) : NaN,
    gfsspTrusted: trusted.length
      ? meanAbs(trusted.map((r) => gfsspErr(r.point)))
      : NaN,
    nTrusted: trusted.length,
    oursRange: range(ok.map(ourErr)),
    gfsspRange: range(rs.map((r) => gfsspErr(r.point))),
    constMae: meanAbs(
      cst.filter((r) => Number.isFinite(ourErr(r))).map(ourErr),
    ),
  };
});
const statRows = groupStats
  .map(
    (s) =>
      `| ${s.label} | ${s.n} | ${s.ours.toFixed(1)} % (${s.oursRange}) | ${s.gfssp.toFixed(1)} % (${s.gfsspRange}) | ${s.nTrusted} | ${fmt(s.oursTrusted)} % | ${fmt(s.gfsspTrusted)} % |`,
  )
  .join("\n");
const allOk = t6.filter((r) => r.converged && Number.isFinite(ourErr(r)));
const oursAllMae = meanAbs(allOk.map(ourErr));
const gfsspAllMae = meanAbs(t6.map((r) => gfsspErr(r.point)));
const constAllMae = meanAbs(
  t6Const.filter((r) => Number.isFinite(ourErr(r))).map(ourErr),
);
const satStat = groupStats[0];
const oursSatMae = satStat.ours;
const gfsspSatMae = satStat.gfssp;
const nonConverged = t6.filter((r) => !r.converged);

const sensRows = satGate
  .map(
    (r) =>
      `| ${r.point.drivingPressure.psia} | ${r.point.experimentalChilldownTimeS} | ${r.times.map((t) => fmt(t)).join(" | ")} |`,
  )
  .join("\n");
const defShift = satGate.map((r) => (r.times[0] ?? NaN) - (r.times[1] ?? NaN));
const defShiftPct = satGate.map(
  (r, i) => (defShift[i] / r.point.experimentalChilldownTimeS) * 100,
);

const gridTable = (
  points: ChilldownDataPoint[],
  ns: number[],
  runs: Map<number, Table6Run[]>,
) =>
  points
    .map(
      (p, i) =>
        `| ${p.drivingPressure.psia} | ${p.experimentalChilldownTimeS} | ${ns
          .map((N) => {
            const r = runs.get(N)![i];
            if (r.failed) return "failed†";
            const t = r.times[0];
            return `${fmt(t)} (${signedPct(errPct(t, p.experimentalChilldownTimeS))})${r.converged ? "" : "*"}`;
          })
          .join(" | ")} |`,
    )
    .join("\n");
const gridSpread = satLN2.map((_, i) => {
  const ts = GRID_NS.map((N) => gridRuns.get(N)![i].times[0] ?? NaN);
  return Math.max(...ts) - Math.min(...ts);
});
const gridAllConverged = GRID_NS.every((N) =>
  gridRuns.get(N)!.every((r) => r.converged),
);
const gridErrs = GRID_NS.flatMap((N) => gridRuns.get(N)!.map(ourErr));
const widest = gridSpread.indexOf(Math.max(...gridSpread));
const dtShift = dt5Runs.map((r, i) =>
  Math.abs((r.times[0] ?? NaN) - (satGate[i].times[0] ?? NaN)),
);
const subErrsAt = (N: number, convergedOnly = true) =>
  subGrid
    .get(N)!
    .filter((r) => !convergedOnly || r.converged)
    .map(ourErr);
const subN3 = subErrsAt(3);
const subNmax = subErrsAt(SUB_NS[SUB_NS.length - 1]);
const subNonConv = SUB_NS.flatMap((N) =>
  subGrid
    .get(N)!
    .filter((r) => !r.converged && !r.failed)
    .map((r) => `${r.point.drivingPressure.psia} psia at N = ${N}`),
);
const subFailed = SUB_NS.flatMap((N) =>
  subGrid
    .get(N)!
    .filter((r) => r.failed)
    .map(
      (r) => `${r.point.drivingPressure.psia} psia at N = ${N} (${r.failed})`,
    ),
);
const subComparable = subLN2.filter((_, i) =>
  SUB_NS.every((N) => Number.isFinite(ourErr(subGrid.get(N)![i]))),
).length;
const subGrows = subLN2.filter((_, i) => {
  const e = SUB_NS.map((N) => ourErr(subGrid.get(N)![i]));
  return e.every(Number.isFinite) && e[e.length - 1] > e[0];
}).length;
const subMaxErr = Math.max(
  ...SUB_NS.flatMap((N) => subErrsAt(N)).filter(Number.isFinite),
);
const subMaxAt = SUB_NS.find((N) => subErrsAt(N).includes(subMaxErr))!;

const runRows = NBS_TRACE_RUNS.map((r) => {
  const usable = r.traces.filter((t) => t.qc.coldTailUsable).length;
  const n = r.traces.reduce((a, t) => a + t.timesS.length, 0);
  const flags = [...new Set(r.traces.flatMap((t) => t.qc.flags))];
  return `| ${r.figure} | ${r.fluid} | ${r.inletCondition} | ${r.drivingPressure.atm} | ${r.conditionId ?? "—"} | ${n} | ${usable}/4 | ${flags.length ? flags.join(", ") : "none"} | ${r.calibrationTier === "trusted" ? "trusted" : "diagnostic only"} |`;
}).join("\n");

const traceRows = traceSolves
  .map((ts) => {
    const run = getTraceRun(ts.runId);
    return ts.cmp.stations
      .map((s) => {
        const mk = s.modelFeatures.kneeTimeS;
        const dk = s.dataFeatures.kneeTimeS;
        const m150 = s.modelFeatures.crossing150KS;
        const d150 = s.dataFeatures.crossing150KS;
        const v = (f: typeof mk) => (f.available ? fmt(f.value) : "—");
        return `| ${run.figure} | ${s.station} | ${fmt(s.metrics.rmseK)} | ${fmt(s.metrics.nrmse, 2)} | ${v(d150)} | ${v(m150)} | ${v(dk)} | ${v(mk)} | ${s.qualityWeight} |`;
      })
      .join("\n");
  })
  .join("\n");
const pooledRows = traceSolves
  .map((ts) => {
    const run = getTraceRun(ts.runId);
    return `| ${run.figure} | ${run.inletCondition} ${run.fluid}, ${run.drivingPressure.atm} atm | ${ts.fluidName}, N = ${ts.N}, Δt = ${ts.dt} s | ${ts.converged ? "yes" : "no"} | ${fmt(ts.cmp.pooled.rmseK)} | ${fmt(ts.cmp.pooled.maeK)} | ${ts.cmp.front150.discordantPairs} |`;
  })
  .join("\n");
const rmseOf = (xs: TraceSolve[]) => xs.map((t) => t.cmp.pooled.rmseK ?? NaN);
const kRange = (xs: number[]) =>
  `${Math.min(...xs).toFixed(1)}–${Math.max(...xs).toFixed(1)} K`;
const satRmse = rmseOf(satTraceSolves);
const subRmse = rmseOf(subTraceSolves);
const satRmseConst = rmseOf(satTraceConst);
const nrmses = traceSolves.flatMap((t) =>
  t.cmp.stations.map((s) => s.metrics.nrmse ?? NaN),
);
const st4KneeGaps = traceSolves
  .map((ts) => {
    const s = ts.cmp.stations[3];
    const m = s.modelFeatures.kneeTimeS;
    const d = s.dataFeatures.kneeTimeS;
    return m.available && d.available ? Math.abs(m.value - d.value) : NaN;
  })
  .filter(Number.isFinite);
const frontRatios = frontWidths
  .filter((f) => f.model !== undefined && f.data !== undefined)
  .map((f) => f.model! / f.data!);
const figList = (ts: TraceSolve[]) =>
  ts.map((t) => getTraceRun(t.runId).figure.replace("Fig. ", "")).join(", ");

const constSat = satLN2.map((p) => runOf(t6Const, p));
const oldNewSentence =
  `With temperature-dependent copper properties, the saturated LN₂ errors ` +
  `at N = 3 are ${satGate.map((r) => signedPct(ourErr(r))).join(", ")} ` +
  `against ${constSat.map((r) => signedPct(ourErr(r))).join(", ")} with the ` +
  `previous constant c_p = 385 J/(kg·K) and k = 400 W/(m·K), the mean ` +
  `absolute error over all eighteen rows is ${oursAllMae.toFixed(1)} % ` +
  `against ${constAllMae.toFixed(1)} %, and the pooled trace RMSE of the ` +
  `four saturated runs is ${kRange(satRmse)} against ${kRange(satRmseConst)}.`;

const report = `# Cryogenic Transfer-Line Chilldown Validation of OpenFLUME

**Validation against experiment: NBS Report 9264 chilldown times and digitized wall-temperature traces, with GFSSP's published predictions as a code-to-code reference**

Generated by \`scripts/chilldown-validation-report.ts\` — all model numbers and
figures come from live solves of the current solver. The corresponding CI
gates are \`src/ui/tests/chilldownBaseline.test.ts\` (saturated and subcooled
LN₂ Table-6 cases and the trusted trace runs; the full suite runs under
\`RUN_SLOW=1\`), \`src/validation/__tests__/nbsTraceCorpus.test.ts\` (trace
corpus structure, trust levels, QC, provenance hash) and
\`src/validation/__tests__/traceBaseline.test.ts\` (trace-comparison plumbing).

## Abstract

This report compares OpenFLUME's two-phase chilldown model with the measured
cooldown of a 61 m vacuum-jacketed copper transfer line, NBS Report 9264
(Brennan et al., 1966), and with the predictions that GFSSP published for the
same tests. It is validation against experiment and therefore subject to the
modeling, closure, discretization, and measurement uncertainties discussed
below. All eighteen chilldown times of Table 6 (liquid nitrogen and liquid
hydrogen, saturated and subcooled) are solved and reported; trust levels are
assigned from the experimental record alone. At the CI configuration (3 axial
segments) the mean absolute error over the eighteen rows is
${oursAllMae.toFixed(1)} % for OpenFLUME and ${gfsspAllMae.toFixed(1)} % for GFSSP's published
33-node predictions. For the three saturated liquid-nitrogen cases OpenFLUME
predicts station-4 chilldown times ${satGate.map((r) => signedPct(ourErr(r))).join(", ")} from
experiment (mean absolute error ${oursSatMae.toFixed(1)} %), against
${satLN2.map((p) => signedPct(gfsspErr(p))).join(", ")} (${gfsspSatMae.toFixed(1)} %) for GFSSP;
over 3 to ${GRID_NS[GRID_NS.length - 1]} segments the saturated predictions lie between
${signedPct(Math.min(...gridErrs))} and ${signedPct(Math.max(...gridErrs))}. The subcooled
liquid-nitrogen error grows with axial refinement, from ${range(subN3)} at
N = 3 to ${range(subNmax)} at N = ${SUB_NS[SUB_NS.length - 1]}. The wall uses the temperature-dependent
OFHC-copper specific heat and conductivity. Against the digitized
wall-temperature traces of the ${NBS_TRUSTED_TRACE_RUNS.length} trusted runs, the untuned model
(N = 6) places the station-4 knee within ${Math.min(...st4KneeGaps).toFixed(1)}–${Math.max(...st4KneeGaps).toFixed(1)} s of the measured one where
both are available, but its pooled trace RMSE is ${kRange(satRmse)} for the
saturated runs and ${kRange(subRmse)} for the subcooled ones. Two model deficiencies stand out: the
inlet wall chills far too slowly, because the film-boiling closure returns a
small coefficient at the zero-quality inlet state, and the modeled quench
front is ${Math.min(...frontRatios).toFixed(1)}–${Math.max(...frontRatios).toFixed(1)} times broader than the measured one at this
discretization. Cryogenic chilldown is the least mature area of the code;
the numbers below are the evidence for that statement.

## Experiment and Data

### The NBS 9264 transfer line

Brennan, Brentari, Smith, and Steward (NBS Report 9264, 1966) admitted
liquid hydrogen and liquid nitrogen from a pressurized dewar into a
horizontal, vacuum-jacketed copper line, ${NBS_CHILLDOWN_RIG.lengthFt} ft
(${NBS_CHILLDOWN_RIG.lengthM.toFixed(2)} m) long, ${NBS_CHILLDOWN_RIG.innerDiameterIn} in
inside and ${NBS_CHILLDOWN_RIG.outerDiameterIn} in outside diameter, venting to
the atmosphere. Wall thermocouples sat at four stations,
${NBS_CHILLDOWN_RIG.stations.map((s) => `${s.xFt} ft`).join(", ")} from the inlet
(${NBS_CHILLDOWN_RIG.stations.map((s) => `${s.xM.toFixed(2)} m`).join(", ")}). The
report defines the chilldown time as the low-temperature knee of the wall
temperature at 60.4 m (station 4) and notes that it is not uniquely defined;
OpenFLUME operationalizes the knee as the first smooth crossing of the
local saturation temperature plus 15 K, with the wall trace interpolated in
space to the exact station coordinate (\`src/validation/nbsChilldown.ts\`).
NBS reports no error bars; the report's own caveats (thermocouple accuracy
traded for range, physically inconsistent low-temperature curve crossings,
chart-read knees) are carried with every data point.

### Table 6: chilldown times

The measured chilldown times are taken as tabulated, with GFSSP's
predictions, in Table 6 of Majumdar, LeClair, Moore, and Schallhorn
(AIAA 2015-3850): eighteen rows, verified digit for digit against the NTRS
scan and, for the hydrogen rows, against the earlier TFAWS 2013 paper. GFSSP's
values are model output (a 33-node network with the Miropolskii film-boiling
correlation) and are used here as a code-to-code reference, never as data.
This report solves every row: four saturated and six subcooled hydrogen
rows, three saturated and five subcooled nitrogen rows.

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

The gated cross-check that ties the two data products together: the station-4
trace of Fig. 2 (saturated hydrogen, ${fig02.drivingPressure.atm} atm) crosses
T_sat + 15 K at ${fig02Knee.toFixed(1)} s, against ${fig02Table6} s in Table 6 for the
same run (${signedPct(((fig02Knee - fig02Table6) / fig02Table6) * 100)}; the gate is ±20 %). These are
two readings of one event, not independent constraints.

## Numerical Model

The line is built by \`buildChilldownTwoPhase\` (\`src/ui/examples.ts\`; the
shipped 20-segment cryogenic line cooldown example of user manual §7.11 is a
separate model): N equal pipe segments between a saturated (or
subcooled) liquid inlet boundary at the driving pressure and an atmospheric
outlet boundary, N − 1 internal fluid nodes with real-fluid (CoolProp,
homogeneous-equilibrium) properties, and N + 1 lumped copper wall nodes, each
coupled to its fluid node by a Miropolskii film-boiling convection conductor
(Dittus–Boelter on single-phase states) and to its neighbors by axial
conduction. The wall uses the temperature-dependent NIST OFHC-copper
specific heat and conductivity (\`wallMaterial: "ofhc-copper"\`, 4–300 K,
RRR 100); the vacuum jacket is represented by an adiabatic outer wall. The
outlet wall node convects to the last internal fluid node ("upwind"
coupling) so that station 4 is bracketed by chilled wall nodes. Nitrogen is
CoolProp Nitrogen; hydrogen is ParaHydrogen. Transients use backward Euler
with a fixed step: Δt = 10 s for nitrogen and 2.5 s for hydrogen. Nothing in
this report is fitted: the CI configuration (N = 3) and the trace-baseline
plan (N = 6) were fixed before these comparisons, and the closure constants
are the published ones.

${oldNewSentence}

## Results

### Table 6: experiment, GFSSP, and OpenFLUME

| Fluid | Inlet | P_drive [psia] | Experiment [s] | GFSSP [s] | GFSSP error | OpenFLUME [s] | OpenFLUME error | Converged | Digitized record | Trust level |
| ----- | ----- | -------------- | -------------- | --------- | ----------- | ------------- | --------------- | --------- | ---------------- | ----------- |
${t6Rows}

OpenFLUME: N = 3, station-4 knee at T_sat,local + 15 K. ${nonConverged.length === 0 ? "All eighteen solves converged." : `${nonConverged.length} solve(s) did not converge (${nonConverged.map((r) => r.point.id).join(", ")}); their times are shown but excluded from the means.`}

| Group | Rows | OpenFLUME mean abs. error (range) | GFSSP mean abs. error (range) | Trusted rows | OpenFLUME, trusted | GFSSP, trusted |
| ----- | ---- | --------------------------------- | ----------------------------- | ------------ | ------------------ | -------------- |
${statRows}

Over all eighteen rows the mean absolute error is ${oursAllMae.toFixed(1)} % for OpenFLUME and
${gfsspAllMae.toFixed(1)} % for GFSSP. The model reproduces both trends in the data:
chilldown shortens as driving pressure rises, and subcooling shortens it at
matched pressure (${fmt(runOf(t6, sub74).times[0])} s subcooled against ${fmt(satGate[1].times[0])} s
saturated at 74.97 psia). The CI gate holds each of its four LN₂ cases (the saturated
rows and subcooled 74.97 psia) inside a factor-of-1.6 band and the saturated mean absolute error below 25 %; that band is a
regression guard, not a statement of accuracy.

${fig(1, "Predicted against measured station-4 chilldown time for all eighteen Table-6 rows: GFSSP's published predictions and OpenFLUME (N = 3).")}

### Sensitivity to the chilldown-time definition

The knee is a graphical quantity, so the definition is varied on the same
saturated LN₂ solves (N = 3). Columns: the primary definition; local T_sat +
30 K; inlet liquid temperature + 15 K; a fixed 100 K; and station 3 instead of
station 4.

| P_drive [psia] | Experiment [s] | T_sat,local + 15 K | T_sat,local + 30 K | T_inlet + 15 K | 100 K | Station 3 |
| -------------- | -------------- | ------------------ | ------------------ | -------------- | ----- | --------- |
${sensRows}

Raising the margin from 15 K to 30 K shortens the predicted time by
${Math.min(...defShift).toFixed(1)}–${Math.max(...defShift).toFixed(1)} s
(${Math.min(...defShiftPct).toFixed(0)}–${Math.max(...defShiftPct).toFixed(0)} % of the measured time).
At N = 3 the model's station-4 wall approaches the liquid temperature slowly,
so the comparison above depends on the definition at that level. The trace
comparison below shows that the measured knee is much sharper.

### Discretization

Saturated LN₂:

| P_drive [psia] | Experiment [s] | ${GRID_NS.map((N) => `N = ${N}`).join(" | ")} |
| -------------- | -------------- | ${GRID_NS.map(() => "------").join(" | ")} |
${gridTable(satLN2, GRID_NS, gridRuns)}

${gridAllConverged ? "Every saturated solve converged." : "Not every saturated solve converged (marked *)."} Between N = 3 and N = ${GRID_NS[GRID_NS.length - 1]} the saturated
predictions span ${gridSpread.map((s) => s.toFixed(1)).join(", ")} s, the largest at
${satLN2[widest].drivingPressure.psia} psia. Halving the time step to Δt = 5 s at N = 3 moves them by
${dtShift.map((s) => s.toFixed(1)).join(", ")} s. Every saturated LN₂ prediction in this
study lies between ${signedPct(Math.min(...gridErrs))} and ${signedPct(Math.max(...gridErrs))} of
experiment; GFSSP's errors for the same cases are ${range(satLN2.map(gfsspErr))}.

Subcooled LN₂:

| P_drive [psia] | Experiment [s] | ${SUB_NS.map((N) => `N = ${N}`).join(" | ")} |
| -------------- | -------------- | ${SUB_NS.map(() => "------").join(" | ")} |
${gridTable(subLN2, SUB_NS, subGrid)}

(* : the solve did not converge${subNonConv.length ? ` — ${subNonConv.join("; ")}` : ""}.${subFailed.length ? ` † : the solve could not be completed — ${subFailed.join("; ")}; a solver robustness failure at that condition, reported rather than dropped.` : ""}) The subcooled
error grows with axial refinement: in ${subGrows} of the ${subComparable} cases with a time at every
level the N = ${SUB_NS[SUB_NS.length - 1]} error exceeds the N = 3 error, and over the converged solves the error rises
from ${range(subN3)} at N = 3 to ${range(subNmax)} at N = ${SUB_NS[SUB_NS.length - 1]}, reaching
${signedPct(subMaxErr)} (N = ${subMaxAt}). Refinement does not repair the subcooled
predictions. This is a model result.

${fig(2, "Station-4 chilldown time of the three saturated LN₂ cases against the number of axial segments (dashed: measurement).")}

${fig(3, "Station-4 chilldown time of the five subcooled LN₂ cases against the number of axial segments (dashed: measurement).")}

### Wall-temperature traces of the trusted runs

The ${NBS_TRUSTED_TRACE_RUNS.length} trusted runs are solved with the plan in
\`TRACE_BASELINE_SOLVE_PLAN\` (\`src/validation/traceBaseline.ts\`: N = 6,
Δt = 10 s for nitrogen and 2.5 s for para-hydrogen; subcooled runs at their
recorded inlet temperature) and compared station by station, with model
traces interpolated to the exact station positions and aligned to the
digitized record; nothing is tuned. The trace knee threshold here is the
data-native T_inlet + 15 K, because the digitized corpus has no pressure
record. These numbers are reported, not gated: the trace tests pin the
comparison plumbing, and a model-error value would change legitimately as
the model improves.

| Run | Condition | Model | Converged | Pooled RMSE [K] | Pooled MAE [K] | Discordant 150 K arrival pairs |
| --- | --------- | ----- | --------- | --------------- | -------------- | ------------------------------ |
${pooledRows}

| Run | Station | RMSE [K] | NRMSE | Data t(150 K) [s] | Model t(150 K) [s] | Data knee [s] | Model knee [s] | QC weight |
| --- | ------- | -------- | ----- | ----------------- | ------------------ | ------------- | -------------- | --------- |
${traceRows}

(— : the feature is unavailable — the trace never reaches it inside the
record, or the data trace's cold tail is QC-excluded.) Station NRMSE, scaled
by each data trace's observed span, ranges from
${Math.min(...nrmses).toFixed(2)} to ${Math.max(...nrmses).toFixed(2)}. Figures ${TRACE_FIG0}–${TRACE_FIG0 + traceSolves.length - 1}
overlay model and data. Three findings recur across the runs:

1. **The inlet region chills late where the inlet coefficient is small.**
   Over the trusted runs the modeled 150 K arrivals at stations 2–4 differ
   from the measured ones by ${range(lags234, 1, secs)}; at station 1 the
   difference is ${traceSolves.map((ts) => `${secs(arrivalLag(ts, 1), 0)} (Fig. ${figNo(ts)})`).join(", ")}.${runsWithDiscordant.length ? ` In ${figPhrase(runsWithDiscordant)} station 1 arrives out of order, which accounts for the discordant arrival pairs.` : ""}
   The cause is the inlet wall node. It convects to the inlet boundary
   state, liquid at zero quality, where the Miropolskii coefficient
   (evaluated at the clamped quality 0.01) is smallest: averaged over each
   record it is ${frontWidths.map((f) => f.hInletMean.toFixed(0)).join(", ")} W/(m²·K) at the
   inlet wall node against ${frontWidths.map((f) => f.hFirstMean.toFixed(0)).join(", ")} W/(m²·K)
   at the next one (Figs. ${figList(traceSolves)}; ratio ${frontWidths.map((f) => (f.hFirstMean / f.hInletMean).toFixed(1)).join(", ")}).
   Where the ratio is large (the saturated LN₂ runs) the line inlet stays
   warm, and station 1 (6.1 m) takes 40 % of its interpolated value from it.
   In the experiment the inlet chills first.
2. **The modeled quench front is diffuse.** At station 4 the wall takes
   ${frontWidths.map((f) => fmt(f.model)).join(", ")} s to fall from 250 K to T_inlet + 15 K in the
   model against ${frontWidths.map((f) => fmt(f.data)).join(", ")} s in the data, and
   ${frontWidths.map((f) => fmt(f.bandModel)).join(", ")} s against ${frontWidths.map((f) => fmt(f.bandData)).join(", ")} s
   to cross the band from T_inlet + 30 K to T_inlet + 15 K. With 10 m of copper
   lumped into each wall node the front cannot be sharper than a segment's
   transit time, so the downstream traces begin to fall early and reach the
   knee late, and the knee time is less sensitive to these errors than the
   trace RMSE.
3. **Subcooled runs fit no better than saturated ones.** The pooled RMSE of
   the subcooled trusted runs (Figs. ${figList(subTraceSolves)}) is ${kRange(subRmse)},
   against ${kRange(satRmse)} for the saturated runs.

${traceSolves.map((ts, k) => fig(TRACE_FIG0 + k, `${getTraceRun(ts.runId).figure} of NBS 9264 (${getTraceRun(ts.runId).inletCondition} ${getTraceRun(ts.runId).fluid}, ${getTraceRun(ts.runId).drivingPressure.atm} atm): digitized wall temperature (markers) and the OpenFLUME solve (lines, ${ts.fluidName}, N = ${ts.N}, Δt = ${ts.dt} s) at the four stations.`)).join("\n\n")}

## Trust Levels

| Comparison | Evidence class | Trust level | What may be quoted |
| ---------- | -------------- | ----------- | ------------------ |
| Table-6 rows without a compromised record (${t6.filter((r) => trustOf(r.point) === "trusted").length} rows) | Validation against experiment | Trusted | The error, with the definition and discretization stated |
| Table-6 rows whose digitized record is compromised (${t6.filter((r) => trustOf(r.point) !== "trusted").length} rows) | Validation against experiment | Diagnostic only | The trend; the error with that caveat |
| GFSSP Table-6 predictions | Code-to-code | Reference | Agreement between codes, not with experiment |
| Trusted trace runs (Figs. ${figList(traceSolves)}) | Validation against experiment | Trusted, reported (not gated) | Station order, station-4 knee where available, RMSE as a baseline |
| Diagnostic trace runs (Figs. ${NBS_DIAGNOSTIC_TRACE_RUNS.map((r) => r.figure.replace("Fig. ", "")).join(", ")}) | Validation against experiment | Diagnostic only | Nothing quantitative |

## Conclusions

Over all eighteen NBS 9264 Table-6 chilldown times, OpenFLUME's untuned
two-phase network model has a mean absolute error of ${oursAllMae.toFixed(1)} % at the CI
configuration, against ${gfsspAllMae.toFixed(1)} % for GFSSP's published predictions. For
saturated liquid nitrogen OpenFLUME's mean absolute error is ${oursSatMae.toFixed(1)} %
against ${gfsspSatMae.toFixed(1)} % for GFSSP, with discretization changing individual predictions by up to
${Math.max(...gridSpread).toFixed(1)} s. For subcooled liquid nitrogen the error grows with axial
refinement (${range(subN3)} at N = 3, ${range(subNmax)} at N = ${SUB_NS[SUB_NS.length - 1]}, up to
${signedPct(subMaxErr)} at N = ${subMaxAt}), so agreement at the coarse grid is not evidence
that the subcooled closure is right. The chilldown-time
comparison depends on a graphical knee definition at the
${Math.min(...defShiftPct).toFixed(0)}–${Math.max(...defShiftPct).toFixed(0)} % level, and the trace comparison shows where agreement
in a single time is partly fortuitous: the model's inlet-region quench is
too slow and its knee too gradual. Cryogenic chilldown remains the least
mature capability of the code, and these results are a baseline for model
improvement, not a calibration.

## References

1. Brennan, J. A., Brentari, E. G., Smith, R. V., and Steward, W. G.,
   "Cooldown of Cryogenic Transfer Lines — An Experimental Report,"
   NBS Report 9264, National Bureau of Standards, Boulder CO, 1966
   (NASA-CR-81338, NTRS 19670007291).
2. Majumdar, A., LeClair, A., Moore, R., and Schallhorn, P., "Generalized
   Fluid System Simulation Program (GFSSP) Version 6," AIAA 2015-3850, 51st
   AIAA/SAE/ASEE Joint Propulsion Conference, 2015 (NTRS 20150016531),
   Table 6.
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
| NRMSE | RMSE divided by the data trace's observed temperature span |
| P_drive | dewar (driving) pressure |
| RMSE | root-mean-square error between aligned traces |
| t(150 K) | first smooth crossing of 150 K |
| T_inlet | inlet liquid temperature |
| T_sat, T_sat,local | saturation temperature; at the station's late-time pressure |
| Δt | solver time step |
`;

writeFileSync(join(outDir, "chilldown-report.md"), report);
console.log(`\nwrote docs/validation/chilldown-report.md`);
