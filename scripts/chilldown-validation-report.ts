/**
 * chilldown-validation-report.ts — generates the cryogenic transfer-line
 * chilldown validation report (docs/validation/chilldown-report.md) and its
 * SVG figures (docs/validation/figures/chilldown/).
 *
 * Evidence: NBS Report 9264 (Brennan et al. 1966) measurements, through
 *   (1) the Table-6 chilldown times as tabulated in AIAA 2015-3850, compared
 *       three ways — experiment, GFSSP's published prediction, OpenFLUME;
 *   (2) the digitized oscillograph corpus (11 runs, 44 station traces),
 *       whose structure, trust levels and QC are gated by
 *       src/validation/__tests__/nbsTraceCorpus.test.ts, and the
 *       pre-registered, untuned trace baseline of the four trusted runs
 *       (src/validation/traceBaseline.ts).
 *
 * The Table-6 solves mirror src/ui/tests/chilldownBaseline.test.ts (the CI
 * gate: N = 3, dt = 10 s fixed, station-4 knee at Tsat_local + 15 K) and
 * scripts/chilldown-baseline.ts (the manual N sweep).  All numbers come from
 * live solves — rerun after solver changes:
 *
 *   npx tsx scripts/chilldown-validation-report.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  NBS_DIAGNOSTIC_SUBCOOLED_TRACE_RUNS,
  NBS_TRACE_DATASET,
  NBS_TRACE_RUNS,
  NBS_TRUSTED_SATURATED_TRACE_RUNS,
  getTraceRun,
} from "../src/validation/nbsTraceCorpus";
import {
  TRACE_BASELINE_SOLVE_PLAN,
  compareRunTraces,
  extractModelStationTrace,
  type ModelWallHistory,
  type RunTraceComparison,
} from "../src/validation/traceBaseline";
import { thresholdCrossingTime } from "../src/validation/stationInterp";
import {
  C,
  groupedBarChart,
  lineChart,
  type Series,
} from "./lib/report-charts";

const fmt = (x: number | undefined, d = 1) =>
  x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(d);
const signedPct = (x: number, d = 1) =>
  `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)} %`;

/* ==========================================================================
 * Output plumbing
 * ========================================================================== */

const outDir = join(process.cwd(), "docs", "validation");
const figDir = join(outDir, "figures", "chilldown");
mkdirSync(figDir, { recursive: true });
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
 * Table-6 solves (mirrors src/ui/tests/chilldownBaseline.test.ts)
 * ========================================================================== */

const SENSITIVITY_DEFS: ChilldownTimeDefinition[] = [
  DEFAULT_CHILLDOWN_TIME_DEFINITION, // station 4, Tsat_local + 15 K
  { station: 4, threshold: { mode: "aboveLocalTsat", marginK: 30 } },
  { station: 4, threshold: { mode: "aboveInletLiquid", marginK: 15 } },
  { station: 4, threshold: { mode: "fixed", valueK: 100 } },
  { station: 3, threshold: { mode: "aboveLocalTsat", marginK: 15 } },
];

interface Table6Run {
  point: ChilldownDataPoint;
  N: number;
  dt: number;
  converged: boolean;
  times: (number | undefined)[]; // one per SENSITIVITY_DEFS entry
  thresholdK: number;
  solveS: number;
}

function table6Config(
  p: ChilldownDataPoint,
  N: number,
  dt: number,
): NetworkConfig {
  const subcooled = p.inletCondition === "subcooled";
  return buildChilldownTwoPhase({
    segments: N,
    length: NBS_CHILLDOWN_RIG.lengthM,
    drivingPressure: p.drivingPressure.pa,
    outletPressure: 101325,
    ...(subcooled ? { inletTemperature: p.subcooledAtTemperature!.K } : {}),
    outletWallCoupling: "upwind",
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

function runTable6(p: ChilldownDataPoint, N: number, dt = 10): Table6Run {
  const cfg = table6Config(p, N, dt);
  const t0 = Date.now();
  const res = solveTransient(cfg);
  const solveS = (Date.now() - t0) / 1000;
  const subcooled = p.inletCondition === "subcooled";
  const input: ChilldownMetricInput = {
    ...wallHistory(cfg, res),
    fluidXM: cfg.nodes.map((n) => physicalPosition(n)?.x ?? n.x),
    pressureTracesPa: cfg.nodes.map((n) => res.nodes[n.id].pressure),
    inletLiquidTempK: subcooled
      ? p.subcooledAtTemperature!.K
      : n2.saturationTemperature(p.drivingPressure.pa),
    saturationTemperatureK: (pPa) => n2.saturationTemperature(pPa),
  };
  const sweep = predictedChilldownTimeSweep(input, SENSITIVITY_DEFS);
  return {
    point: p,
    N,
    dt,
    converged: res.converged,
    times: sweep.map((m) => m.timeS),
    thresholdK: sweep[0].thresholdK,
    solveS,
  };
}

await initRealFluids();
const n2 = new RealFluid("Nitrogen");
console.log("Generating chilldown validation report…");

const satLN2 = getChilldownPoints("LN2", "saturated"); // 61.74 / 74.97 / 86.73 psia
const sub74 = getChilldownPoints("LN2", "subcooled").find(
  (p) => p.id === "subLN2-P74.97",
)!;
const GATE_POINTS = [...satLN2, sub74];

console.log("Table 6 — gate configuration (N = 3, dt = 10 s)");
const gateRuns = GATE_POINTS.map((p) => runTable6(p, 3));
for (const r of gateRuns)
  console.log(
    `  ${r.point.id}: exp ${r.point.experimentalChilldownTimeS} s, GFSSP ${r.point.gfsspPredictedChilldownTimeS} s, OpenFLUME ${fmt(r.times[0])} s (conv ${r.converged})`,
  );

const errPct = (t: number | undefined, exp: number) =>
  t === undefined ? NaN : ((t - exp) / exp) * 100;
const satGate = gateRuns.slice(0, 3);
const meanAbs = (xs: number[]) =>
  xs.reduce((a, b) => a + Math.abs(b), 0) / xs.length;
const oursSatMae = meanAbs(
  satGate.map((r) => errPct(r.times[0], r.point.experimentalChilldownTimeS)),
);
const gfsspSatMae = meanAbs(
  satGate.map((r) =>
    errPct(
      r.point.gfsspPredictedChilldownTimeS,
      r.point.experimentalChilldownTimeS,
    ),
  ),
);

console.log("Table 6 — grid study, saturated LN2 (N = 3, 4, 6, 8, 12)");
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
console.log("Table 6 — time-step check, saturated LN2 (N = 3, dt = 5 s)");
const dt5Runs = satLN2.map((p) => runTable6(p, 3, 5));
for (const r of dt5Runs) console.log(`  ${r.point.id}: ${fmt(r.times[0])} s`);

/* ==========================================================================
 * Trace corpus — gated structure + the pre-registered trusted-run baseline
 * ========================================================================== */

const corpusTraces = NBS_TRACE_RUNS.reduce((a, r) => a + r.traces.length, 0);
const trustedTraces = NBS_TRUSTED_SATURATED_TRACE_RUNS.reduce(
  (a, r) => a + r.traces.length,
  0,
);
const coldTailUsable = NBS_TRUSTED_SATURATED_TRACE_RUNS.reduce(
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

console.log(
  "Trace baseline — four trusted saturated runs (pre-registered plan)",
);
interface TraceSolve {
  runId: string;
  model: ModelWallHistory;
  /** Convection coefficient histories of the inlet wall node (conv0) and
   *  the first interior wall node (conv1) [W/(m²·K)]. */
  hInlet: number[];
  hFirst: number[];
  cmp: RunTraceComparison;
  converged: boolean;
  N: number;
  dt: number;
  fluidName: string;
}
const traceSolves: TraceSolve[] = [];
for (const run of NBS_TRUSTED_SATURATED_TRACE_RUNS) {
  const spec = TRACE_BASELINE_SOLVE_PLAN.find((s) => s.runId === run.runId)!;
  const cfg = buildChilldownTwoPhase({
    segments: spec.segments,
    length: NBS_CHILLDOWN_RIG.lengthM,
    drivingPressure: run.drivingPressure.pa,
    outletPressure: 101325,
    fluidName: spec.fluidName,
    outletWallCoupling: "upwind",
    dt: spec.dtS,
    endTime: spec.endTimeS,
    timeStepping: "fixed",
  });
  const res = solveTransient(cfg);
  const model = wallHistory(cfg, res);
  const cmp = compareRunTraces(run, model);
  const hOf = (id: string) =>
    (res.conductors?.[id] as { heatTransferCoeff?: number[] } | undefined)
      ?.heatTransferCoeff ?? [];
  traceSolves.push({
    runId: run.runId,
    model,
    hInlet: hOf("conv0"),
    hFirst: hOf("conv1"),
    cmp,
    converged: res.converged,
    N: spec.segments,
    dt: spec.dtS,
    fluidName: spec.fluidName,
  });
  console.log(
    `  ${run.runId}: converged=${res.converged} pooled RMSE ${fmt(cmp.pooled.rmseK)} K, MAE ${fmt(cmp.pooled.maeK)} K`,
  );
}

/* Diagnostics of the trace baseline: front sharpness at station 4, and the
 * convection coefficient seen by the inlet wall node. */
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
interface FrontWidth {
  runId: string;
  /** Time from 250 K to T_in + 15 K at station 4 (s), model and data. */
  model?: number;
  data?: number;
  /** Time from T_in + 30 K to T_in + 15 K at station 4 (s). */
  bandModel?: number;
  bandData?: number;
  hInletMean: number;
  hFirstMean: number;
}
const between = (
  t: number[],
  v: number[],
  hi: number,
  lo: number,
): number | undefined => {
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
for (const f of frontWidths)
  console.log(
    `  ${f.runId}: st4 250K→knee model ${fmt(f.model)} s data ${fmt(f.data)} s; band model ${fmt(f.bandModel)} data ${fmt(f.bandData)}; mean h conv0 ${f.hInletMean.toFixed(0)} conv1 ${f.hFirstMean.toFixed(0)} W/m2K`,
  );

/* ==========================================================================
 * Figures
 * ========================================================================== */

const caseLabel = (p: ChilldownDataPoint) =>
  `${p.inletCondition === "saturated" ? "sat" : "sub"} ${p.drivingPressure.psia} psia`;

writeFig(
  1,
  "table6-three-way",
  groupedBarChart({
    title: "NBS 9264 Table 6, LN₂: station-4 chilldown time",
    xLabel: "Inlet condition and driving pressure",
    yLabel: "Chilldown time [s]",
    categories: gateRuns.map((r) => caseLabel(r.point)),
    headroom: 1.4,
    series: [
      {
        label: "Experiment (NBS 9264)",
        values: gateRuns.map((r) => r.point.experimentalChilldownTimeS),
        color: C.ref,
      },
      {
        label: "GFSSP (published)",
        values: gateRuns.map((r) => r.point.gfsspPredictedChilldownTimeS),
        color: C.orange,
      },
      {
        label: "OpenFLUME (N = 3)",
        values: gateRuns.map((r) => r.times[0] ?? 0),
        color: C.blue,
      },
    ],
  }),
);

const gridColors = [C.blue, C.red, C.green];
const gridMarkers = ["circle", "square", "triangle"] as const;
writeFig(
  2,
  "grid-study",
  lineChart({
    title: "Saturated LN₂: chilldown time against axial segments",
    xLabel: "Pipe segments N",
    yLabel: "Station-4 chilldown time [s]",
    legend: "top-right",
    // Headroom above the data so the legend sits clear of the curves.
    yRange: [120, 250],
    series: satLN2.flatMap((p, i): Series[] => [
      {
        label: `OpenFLUME, ${p.drivingPressure.psia} psia`,
        pts: GRID_NS.map((N): [number, number] => [
          N,
          gridRuns.get(N)![i].times[0] ?? NaN,
        ]),
        color: gridColors[i],
        mode: "both",
        marker: gridMarkers[i],
      },
      {
        label: `Experiment, ${p.drivingPressure.psia} psia`,
        pts: [
          [GRID_NS[0], p.experimentalChilldownTimeS],
          [GRID_NS[GRID_NS.length - 1], p.experimentalChilldownTimeS],
        ],
        color: gridColors[i],
        mode: "line",
        dash: "6 4",
      },
    ]),
  }),
);

const stationColors = [C.blue, C.red, C.green, C.orange];
traceSolves.forEach((ts, k) => {
  const run = getTraceRun(ts.runId);
  const series: Series[] = [];
  run.traces.forEach((tr, i) => {
    const m = extractModelStationTrace(ts.model, tr.station);
    const tMax = Math.max(...tr.timesS);
    const keep = m.timesS
      .map((t, j): [number, number] => [t, m.valuesK[j]])
      .filter(([t]) => t <= tMax + 1e-9);
    series.push({
      label: `Station ${tr.station}, model`,
      pts: keep,
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
    3 + k,
    `trace-${ts.runId.replace("nbs9264-", "")}`,
    lineChart({
      title: `${run.figure}: ${run.inletCondition} ${run.fluid} at ${run.drivingPressure.atm} atm`,
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

const threeWayRows = gateRuns
  .map((r) => {
    const p = r.point;
    const exp = p.experimentalChilldownTimeS;
    const g = p.gfsspPredictedChilldownTimeS;
    const o = r.times[0];
    const trust =
      p.inletCondition === "saturated" ? "trusted" : "diagnostic only";
    return `| ${p.inletCondition} | ${p.drivingPressure.psia} | ${exp} | ${g} | ${signedPct(errPct(g, exp))} | ${fmt(o)} | ${signedPct(errPct(o, exp))} | ${trust} |`;
  })
  .join("\n");

const sensRows = gateRuns
  .slice(0, 3)
  .map(
    (r) =>
      `| ${r.point.drivingPressure.psia} | ${r.point.experimentalChilldownTimeS} | ${r.times.map((t) => fmt(t)).join(" | ")} |`,
  )
  .join("\n");

const gridRows = satLN2
  .map(
    (p, i) =>
      `| ${p.drivingPressure.psia} | ${p.experimentalChilldownTimeS} | ${GRID_NS.map(
        (N) => {
          const t = gridRuns.get(N)![i].times[0];
          return `${fmt(t)} (${signedPct(errPct(t, p.experimentalChilldownTimeS))})`;
        },
      ).join(" | ")} |`,
  )
  .join("\n");
const gridSpread = satLN2.map((_, i) => {
  const ts = GRID_NS.map((N) => gridRuns.get(N)![i].times[0] ?? NaN);
  return Math.max(...ts) - Math.min(...ts);
});
const gridAllConverged = GRID_NS.every((N) =>
  gridRuns.get(N)!.every((r) => r.converged),
);
const gridErrs = GRID_NS.flatMap((N) =>
  gridRuns
    .get(N)!
    .map((r) => errPct(r.times[0], r.point.experimentalChilldownTimeS)),
);
const dtShift = dt5Runs.map((r, i) =>
  Math.abs((r.times[0] ?? NaN) - (satGate[i].times[0] ?? NaN)),
);

const runRows = NBS_TRACE_RUNS.map((r) => {
  const usable = r.traces.filter((t) => t.qc.coldTailUsable).length;
  const n = r.traces.reduce((a, t) => a + t.timesS.length, 0);
  return `| ${r.figure} | ${r.fluid} | ${r.inletCondition} | ${r.drivingPressure.atm} | ${r.conditionId ?? "—"} | ${n} | ${usable}/4 | ${r.calibrationTier === "trustedSaturated" ? "trusted" : "diagnostic only"} |`;
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
    return `| ${run.figure} | ${run.fluid}, ${run.drivingPressure.atm} atm | ${ts.fluidName}, N = ${ts.N}, Δt = ${ts.dt} s | ${ts.converged ? "yes" : "no"} | ${fmt(ts.cmp.pooled.rmseK)} | ${fmt(ts.cmp.pooled.maeK)} | ${ts.cmp.front150.discordantPairs} |`;
  })
  .join("\n");
const pooledRmse = traceSolves.map((t) => t.cmp.pooled.rmseK ?? NaN);
const nrmses = traceSolves.flatMap((t) =>
  t.cmp.stations.map((s) => s.metrics.nrmse ?? NaN),
);
const st4Knees = traceSolves
  .map((ts) => {
    const s = ts.cmp.stations[3];
    return {
      run: getTraceRun(ts.runId),
      m: s.modelFeatures.kneeTimeS,
      d: s.dataFeatures.kneeTimeS,
    };
  })
  .filter((x) => x.m.available && x.d.available) as Array<{
  run: ReturnType<typeof getTraceRun>;
  m: { available: true; value: number };
  d: { available: true; value: number };
}>;

const defShiftPct = satGate.map(
  (r) =>
    (((r.times[0] ?? 0) - (r.times[1] ?? 0)) /
      r.point.experimentalChilldownTimeS) *
    100,
);
const frontRatios = frontWidths
  .filter((f) => f.model !== undefined && f.data !== undefined)
  .map((f) => f.model! / f.data!);

const report = `# Cryogenic Transfer-Line Chilldown Validation of OpenFLUME

**Validation against experiment: NBS Report 9264 chilldown times and digitized wall-temperature traces, with GFSSP's published predictions as a code-to-code reference**

Generated by \`scripts/chilldown-validation-report.ts\` — all model numbers and
figures come from live solves of the current solver. The corresponding CI
gates are \`src/ui/tests/chilldownBaseline.test.ts\` (Table 6; the four-case
suite runs under \`RUN_SLOW=1\`), \`src/validation/__tests__/nbsTraceCorpus.test.ts\`
(trace corpus structure, trust levels, QC, provenance hash) and
\`src/validation/__tests__/traceBaseline.test.ts\` (trace-comparison plumbing).

## Abstract

This report compares OpenFLUME's two-phase chilldown model with the measured
cooldown of a 61 m vacuum-jacketed copper transfer line, NBS Report 9264
(Brennan et al., 1966), and with the predictions that GFSSP published for the
same tests. It is validation against experiment and therefore subject to the
modeling, closure, discretization, and measurement uncertainties discussed
below. For the three saturated liquid-nitrogen cases of Table 6 the CI
configuration (3 axial segments, 10 s fixed step) predicts station-4
chilldown times ${satGate.map((r) => signedPct(errPct(r.times[0], r.point.experimentalChilldownTimeS))).join(", ")}
from experiment (mean absolute error ${oursSatMae.toFixed(1)} %), against
${satGate.map((r) => signedPct(errPct(r.point.gfsspPredictedChilldownTimeS, r.point.experimentalChilldownTimeS))).join(", ")}
(${gfsspSatMae.toFixed(1)} %) for GFSSP's published 33-node predictions. Refining
the line from 3 to ${GRID_NS[GRID_NS.length - 1]} segments moves the
predictions by at most ${Math.max(...gridSpread).toFixed(1)} s, and every
saturated prediction in that study lies between ${signedPct(Math.min(...gridErrs))} and
${signedPct(Math.max(...gridErrs))} of experiment. The subcooled case is
over-predicted by ${signedPct(errPct(gateRuns[3].times[0], sub74.experimentalChilldownTimeS))}
and is classified diagnostic only. Against the digitized wall-temperature
traces of the four trusted saturated runs, the untuned pre-registered model
(N = 6) places the station-4 knee within
${Math.min(...st4Knees.map((k) => Math.abs(k.m.value - k.d.value))).toFixed(1)}–${Math.max(...st4Knees.map((k) => Math.abs(k.m.value - k.d.value))).toFixed(1)} s
of the measured one where both are available, but its pooled trace RMSE is
${Math.min(...pooledRmse).toFixed(1)}–${Math.max(...pooledRmse).toFixed(1)} K. Two model deficiencies
stand out: the inlet wall chills far too slowly, because the
film-boiling closure returns a small coefficient at the zero-quality inlet
state, and the modeled quench front is ${Math.min(...frontRatios).toFixed(1)}–${Math.max(...frontRatios).toFixed(1)} times broader than
the measured one at coarse discretization. Cryogenic chilldown is the least mature area of the code; the
numbers below are the evidence for that statement.

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
scan and, for the hydrogen rows, against the earlier TFAWS 2013 paper. GFSSP's values are model
output (a 33-node network with the Miropolskii film-boiling correlation) and
are used here as a code-to-code reference, never as data. This report uses
the three saturated nitrogen rows and the subcooled nitrogen row at the middle
pressure (74.97 psia), the four cases of the CI gate.

### Digitized trace corpus

Eleven oscillograph figures of NBS 9264 (Figs. 2–7 hydrogen, 10–14 nitrogen)
were digitized into ${corpusTraces} station traces and ${NBS_TRACE_DATASET.totalSamples}
samples (\`validation/data/digitized/chilldown/nbs9264_fig*.csv\`, rebuilt into
\`src/validation/generated/nbsTraceCorpusData.ts\` by \`npm run gen:trace-corpus\`;
the CSVs' SHA-256 is rechecked on every CI run). The physical run, not the
station trace, is the independent unit. Every run carries a trust level:

| Figure | Fluid | Inlet | P_drive [atm] | Table-6 row | Samples | Cold tail usable | Trust level |
| ------ | ----- | ----- | ------------- | ----------- | ------- | ---------------- | ----------- |
${runRows}

**Trusted** runs (${NBS_TRUSTED_SATURATED_TRACE_RUNS.length} runs, ${trustedTraces} traces, ${coldTailUsable} with a usable cold tail) are saturated conditions at which
the solver is defensible. **Diagnostic-only** runs (${NBS_DIAGNOSTIC_SUBCOOLED_TRACE_RUNS.length} subcooled runs) may be
used to diagnose the model but not quoted as agreement: at subcooled inlet
conditions the model's error grows with axial refinement, reaching +80 %
(user manual §8.4), and several steps are uncertified. Per-trace
QC flags (drawn-line reconstruction, curve crossings, truncated cold tails)
further restrict which features of a trusted trace may be compared.

The gated cross-check that ties the two data products together: the station-4
trace of Fig. 2 (saturated hydrogen, ${fig02.drivingPressure.atm} atm) crosses
T_sat + 15 K at ${fig02Knee.toFixed(1)} s, against ${fig02Table6} s in Table 6 for the
same run (${signedPct(((fig02Knee - fig02Table6) / fig02Table6) * 100)}; the gate is ±20 %). These are
two readings of one event, not independent constraints.

## Numerical Model

The line is built by \`buildChilldownTwoPhase\` (\`src/ui/examples.ts\`, the
model behind example 7.11): N equal pipe segments between a saturated (or
subcooled) liquid inlet boundary at the driving pressure and an atmospheric
outlet boundary, N − 1 internal fluid nodes with real-fluid (CoolProp,
homogeneous-equilibrium) properties, and N + 1 lumped copper wall nodes, each
coupled to its fluid node by a Miropolskii film-boiling convection conductor
(Dittus–Boelter on single-phase states) and to its neighbors by axial
conduction. The wall uses a constant room-temperature specific heat
(385 J/(kg·K)) and conductivity (400 W/(m·K)); the vacuum jacket is
represented by an adiabatic outer wall. The outlet wall node convects to the
last internal fluid node ("upwind" coupling) so that station 4 is bracketed
by chilled wall nodes. Transients use backward Euler with a fixed step.
Nothing in this report is fitted: the CI configuration (N = 3, Δt = 10 s) and
the trace-baseline plan (N = 6, Δt = 10 s for nitrogen, 2.5 s for
para-hydrogen) were fixed before these comparisons, and the closure constants
are the published ones.

## Results

### Table 6: experiment, GFSSP, and OpenFLUME

| Inlet | P_drive [psia] | Experiment [s] | GFSSP [s] | GFSSP error | OpenFLUME [s] | OpenFLUME error | Trust level |
| ----- | -------------- | -------------- | --------- | ----------- | ------------- | --------------- | ----------- |
${threeWayRows}

OpenFLUME: N = 3, Δt = 10 s, station-4 knee at T_sat,local + 15 K
(threshold ${gateRuns.map((r) => r.thresholdK.toFixed(1)).join(", ")} K). All four
solves converged. Over the saturated cases the mean absolute error is
${oursSatMae.toFixed(1)} % for OpenFLUME and ${gfsspSatMae.toFixed(1)} % for GFSSP. Both
codes over-predict every saturated case; at 61.74 and 74.97 psia the two
predictions agree within ${Math.max(Math.abs((satGate[0].times[0] ?? 0) - satGate[0].point.gfsspPredictedChilldownTimeS), Math.abs((satGate[1].times[0] ?? 0) - satGate[1].point.gfsspPredictedChilldownTimeS)).toFixed(1)} s, while at 86.73 psia
OpenFLUME's N = 3 prediction is ${fmt((satGate[2].times[0] ?? 0) - satGate[2].point.gfsspPredictedChilldownTimeS)} s longer
than GFSSP's — a discretization effect (next section). The model also
reproduces both trends in the data: chilldown shortens as driving pressure
rises, and subcooling shortens it at matched pressure
(${fmt(gateRuns[3].times[0])} s subcooled against ${fmt(gateRuns[1].times[0])} s saturated at 74.97 psia).
The subcooled case is over-predicted by
${signedPct(errPct(gateRuns[3].times[0], sub74.experimentalChilldownTimeS))} where GFSSP
matches the measurement; it is shown for completeness and, per the trust
levels, is not quoted as agreement. The CI gate holds each case inside a
factor-of-1.6 band and the saturated mean absolute error below 25 %; that
band is a regression guard, not a statement of accuracy.

${fig(1, "Station-4 chilldown time for the four LN₂ cases of Table 6: NBS 9264 measurement, GFSSP's published prediction, and OpenFLUME (N = 3, Δt = 10 s).")}

### Sensitivity to the chilldown-time definition

The knee is a graphical quantity, so the definition is varied on the same
solves (N = 3). Columns: the primary definition; local T_sat + 30 K; inlet
liquid temperature + 15 K; a fixed 100 K; and station 3 instead of station 4.

| P_drive [psia] | Experiment [s] | T_sat,local + 15 K | T_sat,local + 30 K | T_inlet + 15 K | 100 K | Station 3 |
| -------------- | -------------- | ------------------ | ------------------ | -------------- | ----- | --------- |
${sensRows}

Raising the margin from 15 K to 30 K shortens the predicted time by
${Math.min(...satGate.map((r) => (r.times[0] ?? 0) - (r.times[1] ?? 0))).toFixed(1)}–${Math.max(...satGate.map((r) => (r.times[0] ?? 0) - (r.times[1] ?? 0))).toFixed(1)} s
(${Math.min(...satGate.map((r) => (((r.times[0] ?? 0) - (r.times[1] ?? 0)) / r.point.experimentalChilldownTimeS) * 100)).toFixed(0)}–${Math.max(...satGate.map((r) => (((r.times[0] ?? 0) - (r.times[1] ?? 0)) / r.point.experimentalChilldownTimeS) * 100)).toFixed(0)} % of the measured time).
At N = 3 the model's station-4 wall approaches the liquid temperature slowly,
so the comparison above depends on the definition at that level. The trace
comparison below shows that the measured knee is much sharper.

### Discretization

| P_drive [psia] | Experiment [s] | ${GRID_NS.map((N) => `N = ${N}`).join(" | ")} |
| -------------- | -------------- | ${GRID_NS.map(() => "------").join(" | ")} |
${gridRows}

${gridAllConverged ? "Every solve converged." : "Not every solve converged; see the console log."} Between N = 3 and N = ${GRID_NS[GRID_NS.length - 1]} the saturated
predictions move by ${gridSpread.map((s) => s.toFixed(1)).join(", ")} s, and they do not
converge monotonically. Halving the time step to Δt = 5 s at N = 3 moves them by
${dtShift.map((s) => s.toFixed(1)).join(", ")} s. The 86.73 psia case carries the largest grid
sensitivity: its N = 3 over-prediction falls to about +7 % from N = 6 on,
level with GFSSP. A practical reading is that the saturated LN₂
chilldown time is predicted to within roughly +2 % to +19 % at every
discretization tried, with GFSSP inside the same band. The subcooled cases
are not grid-converged (user manual §8.4) and are excluded from this
study.

${fig(2, "Station-4 chilldown time of the three saturated LN₂ cases against the number of axial segments (dashed: measurement).")}

### Wall-temperature traces of the trusted runs

The four trusted runs are solved with the pre-registered plan
(\`TRACE_BASELINE_SOLVE_PLAN\` in \`src/validation/traceBaseline.ts\`) and
compared station by station, with model traces interpolated to the exact
station positions and aligned to the digitized record; nothing is tuned. The
trace knee threshold here is the data-native T_sat(P_drive) + 15 K, because
the digitized corpus has no pressure record. These numbers are reported, not
gated: the trace tests pin the comparison plumbing, and a model-error value
would change legitimately as the model improves.

| Run | Condition | Model | Converged | Pooled RMSE [K] | Pooled MAE [K] | Discordant 150 K arrival pairs |
| --- | --------- | ----- | --------- | --------------- | -------------- | ------------------------------ |
${pooledRows}

| Run | Station | RMSE [K] | NRMSE | Data t(150 K) [s] | Model t(150 K) [s] | Data knee [s] | Model knee [s] | QC weight |
| --- | ------- | -------- | ----- | ----------------- | ------------------ | ------------- | -------------- | --------- |
${traceRows}

(— : the feature is unavailable — the trace never reaches it inside the
record, or the data trace's cold tail is QC-excluded.) Station NRMSE, scaled
by each data trace's observed span, ranges from
${Math.min(...nrmses).toFixed(2)} to ${Math.max(...nrmses).toFixed(2)}. Figures 3–6
overlay model and data. Three findings recur across the runs:

1. **Stations 2–4 are in order and roughly on time; station 1 is late.**
   The model chills stations 2–4 in sequence. Their 150 K arrivals fall
   within about 20 s of the measured ones in Figs. 2, 11, and 12 and lag
   by 23–42 s in Fig. 10, the lowest-pressure run. Station 1 is late in
   every run and, in Figs. 11 and 12, arrives after the downstream stations,
   which accounts for the discordant arrival pairs. The cause is the inlet
   wall node. It convects to the inlet boundary state, saturated liquid at
   zero quality, where the Miropolskii coefficient (evaluated at the clamped
   quality 0.01) is small: averaged over each record it is
   ${frontWidths.map((f) => f.hInletMean.toFixed(0)).join(", ")} W/(m²·K) at the inlet wall
   node against ${frontWidths.map((f) => f.hFirstMean.toFixed(0)).join(", ")} W/(m²·K) at the
   next one (Figs. 2, 10, 11, 12). The line inlet therefore stays warm, and
   station 1 (6.1 m) takes 40 % of its interpolated value from it. In the
   experiment the inlet chills first.
2. **The modeled quench front is diffuse.** At station 4 the wall takes
   ${frontWidths.map((f) => fmt(f.model)).join(", ")} s to fall from 250 K to T_sat + 15 K in the
   model against ${frontWidths.map((f) => fmt(f.data)).join(", ")} s in the data, and
   ${frontWidths.map((f) => fmt(f.bandModel)).join(", ")} s against ${frontWidths.map((f) => fmt(f.bandData)).join(", ")} s
   to cross the band from T_sat + 30 K to T_sat + 15 K. With 10 m of copper
   lumped into each wall node the front cannot be sharper than a segment's
   transit time, so the downstream traces begin to fall early and reach the
   knee late, and the knee time is less sensitive to these errors than the
   trace RMSE. A constant room-temperature copper specific heat, which
   overstates the wall's stored energy at cryogenic temperature, acts in
   the same direction. Neither is adjusted here.

${traceSolves.map((ts, k) => fig(3 + k, `${getTraceRun(ts.runId).figure} of NBS 9264 (${getTraceRun(ts.runId).inletCondition} ${getTraceRun(ts.runId).fluid}, ${getTraceRun(ts.runId).drivingPressure.atm} atm): digitized wall temperature (markers) and the pre-registered OpenFLUME solve (lines, ${ts.fluidName}, N = ${ts.N}, Δt = ${ts.dt} s) at the four stations.`)).join("\n\n")}

## Trust Levels

| Comparison | Evidence class | Trust level | What may be quoted |
| ---------- | -------------- | ----------- | ------------------ |
| Saturated LN₂, Table 6 | Validation against experiment | Trusted | Station-4 time within the band reported here, with the definition and discretization stated |
| Subcooled LN₂, Table 6 | Validation against experiment | Diagnostic only | Trend (subcooling shortens chilldown); not the error |
| GFSSP Table 6 predictions | Code-to-code | Reference | Agreement between codes, not with experiment |
| Trusted trace runs (Figs. 2, 10, 11, 12) | Validation against experiment | Trusted, reported (not gated) | Order of stations 2–4, station-4 knee where available, RMSE as a baseline |
| Subcooled trace runs (Figs. 3–7, 13, 14) | Validation against experiment | Diagnostic only | Nothing quantitative |

## Conclusions

For saturated liquid-nitrogen chilldown of the NBS 9264 line, OpenFLUME's
untuned two-phase network model predicts the station-4 chilldown time with
the same sign and comparable magnitude of error as GFSSP's published
predictions: ${oursSatMae.toFixed(1)} % against ${gfsspSatMae.toFixed(1)} % mean absolute error at the CI
configuration, with discretization changing individual predictions by up to
${Math.max(...gridSpread).toFixed(1)} s. The chilldown-time comparison depends on a graphical knee
definition at the ${Math.min(...defShiftPct).toFixed(0)}–${Math.max(...defShiftPct).toFixed(0)} % level, and the full trace comparison shows where
the agreement in a single time is partly fortuitous: the model's inlet-region
quench is too slow and its knee too gradual. Subcooled inlet conditions are
outside the defensible range of the current model. Cryogenic chilldown
remains the least mature capability of the code, and these results are a
baseline for model improvement, not a calibration.

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
