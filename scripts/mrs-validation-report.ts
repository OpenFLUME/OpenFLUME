/**
 * mrs-validation-report.ts — generates the Modular Radiator System (MRS)
 * system-level validation report (docs/validation/mrs-report.md) and its
 * figures (docs/validation/figures/mrs/).
 *
 * The case is a high-level system test of the tool, not a research campaign.
 * Two measured traces (test points 1A and 54, fixed in
 * docs/validation/mrs-protocol.md before any run) are recreated with the
 * a-priori model of src/validation/mrsRadiator.ts and compared with the test,
 * the tabulated 1973 model and the first-principles hand calculation of
 * scripts/reference/mrs_hand_calc.py.
 *
 *   npx tsx scripts/mrs-validation-report.ts [--runs DIR]
 *
 * The solves are done by scripts/mrs-validation-run.ts, one process per run
 * and at most three at a time.  Run files already present in DIR are reused
 * (default os.tmpdir()/openflume-mrs-runs), so an interrupted report resumes.
 * Delete DIR to recompute everything.  A full recompute takes about five
 * minutes.  Every number in the report comes from those run files, the
 * committed data files and the committed hand calculation output.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initRealFluids } from "../src/core/fluids/coolprop";
import { RealFluid } from "../src/core/fluids/realFluid";
import {
  MRS_CHOICES,
  MRS_GEOMETRY,
  MRS_PRESSURE,
  MRS_VARIANTS,
  f2k,
  type MrsPanelRun,
} from "../src/validation/mrsRadiator";
import {
  errorStats,
  parseCsvRecords,
  pointMetrics,
  readPanelOutlets,
  readRegistry,
  readSystemOutlets,
  type ErrorStats,
  type MrsRegistryEntry,
} from "../src/validation/mrsData";
import { C, lineChart, type Series } from "./lib/report-charts";

const argv = process.argv.slice(2);
const runsDir =
  argv[argv.indexOf("--runs") + 1] && argv.includes("--runs")
    ? argv[argv.indexOf("--runs") + 1]
    : join(tmpdir(), "openflume-mrs-runs");
const DATA = join("validation", "data", "digitized", "mrs");
const FIG_DIR = join("docs", "validation", "figures", "mrs");
const REPORT = join("docs", "validation", "mrs-report.md");

/** The two primary traces (docs/validation/mrs-protocol.md). */
const POINTS = ["1A", "54"];
/** The cheapest point carries the 16 segment check and the sensitivity block. */
const CHEAP = "1A";
const SENS = [
  "muPlus",
  "muMinus",
  "kPlus",
  "kMinus",
  "fluxPlus",
  "fluxMinus",
  "epsPlus",
  "epsMinus",
];

/* ------------------------------------------------------------------ */
/* Runs                                                                */
/* ------------------------------------------------------------------ */

interface RunSpec {
  name: string;
  variant: string;
  segments: number;
  points: string[];
}
const RUNS: RunSpec[] = [
  { name: "base_8", variant: "base", segments: 8, points: POINTS },
  { name: "base_4", variant: "base", segments: 4, points: POINTS },
  { name: "base_16", variant: "base", segments: 16, points: [CHEAP] },
  ...SENS.map((v) => ({
    name: `${v}_4`,
    variant: v,
    segments: 4,
    points: [CHEAP],
  })),
];

mkdirSync(runsDir, { recursive: true });
const file = (r: RunSpec): string => join(runsDir, `${r.name}.json`);
const todo = RUNS.filter((r) => !existsSync(`${file(r)}.done`));

async function runAll(): Promise<void> {
  const queue = [...todo];
  const worker = async (): Promise<void> => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      await new Promise<void>((resolve, reject) => {
        const p = spawn(
          "npx",
          [
            "tsx",
            "scripts/mrs-validation-run.ts",
            "--variant",
            r.variant,
            "--segments",
            String(r.segments),
            "--points",
            r.points.join(","),
            "--out",
            file(r),
          ],
          { stdio: "inherit" },
        );
        p.on("exit", (code) => {
          if (code === 0) {
            writeFileSync(`${file(r)}.done`, "");
            resolve();
          } else reject(new Error(`run ${r.name} failed with code ${code}`));
        });
      });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}
if (todo.length > 0) {
  console.log(`running ${todo.length} solve files into ${runsDir}`);
  await runAll();
}

type Row = MrsPanelRun & { variant: string; testPoint: string; leg: string };
const load = (name: string): Row[] =>
  JSON.parse(readFileSync(join(runsDir, `${name}.json`), "utf8")) as Row[];
const base8 = load("base_8");
const base4 = load("base_4");
const base16 = load("base_16");

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

const registry = readRegistry(
  readFileSync(join(DATA, "mrs_test_point_registry.csv"), "utf8"),
);
const outlets = readPanelOutlets(
  readFileSync(join(DATA, "mrs_panel_outlets_figs15_33.csv"), "utf8"),
);
const system = readSystemOutlets(
  readFileSync(join(DATA, "mrs_system_outlets_figs15_33.csv"), "utf8"),
);
const handRows = parseCsvRecords(
  readFileSync(join(DATA, "mrs_hand_calc_results.csv"), "utf8"),
);
const handOf = (tp: string): Record<number, number> => {
  const m: Record<number, number> = {};
  for (const r of handRows)
    if (r.test_point === tp && r.panel)
      m[Number(r.panel)] = Number(r.Tout_calc_F);
  return m;
};

await initRealFluids();
const fluid = new RealFluid("R21");
const h = (tF: number): number => fluid.enthalpyPT(MRS_PRESSURE, f2k(tF));
const tInv = (hh: number): number => {
  let lo = -150;
  let hi = 250;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (h(mid) < hh) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
};

const toutMap = (rows: Row[], tp: string): Record<number, number> => {
  const m: Record<number, number> = {};
  for (const r of rows) if (r.testPoint === tp) m[r.panel] = r.toutF;
  return m;
};
const entryOf = (tp: string): MrsRegistryEntry => {
  const e = registry.find((r) => r.testPoint === tp);
  if (!e) throw new Error(`test point ${tp} not in the registry`);
  return e;
};

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const f0 = (x: number): string => x.toFixed(0);
const f1 = (x: number): string => x.toFixed(1);
const f2 = (x: number): string => x.toFixed(2);
const s1 = (x: number): string => (x >= 0 ? "+" : "-") + Math.abs(x).toFixed(1);
const s2 = (x: number): string => (x >= 0 ? "+" : "-") + Math.abs(x).toFixed(2);
const sci = (x: number): string => x.toExponential(1);
const statLine = (s: ErrorStats): string =>
  `RMS ${f2(s.rms)}, max ${f2(s.maxAbs)}, bias ${s2(s.bias)}`;
const table = (head: string[], rows: string[][]): string =>
  [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");

/* ------------------------------------------------------------------ */
/* Per point results                                                    */
/* ------------------------------------------------------------------ */

interface PanelLine {
  leg: string;
  position: number;
  panel: number;
  tin: number;
  test: number;
  m73: number;
  hand: number;
  of8: number;
  of4: number;
  of16?: number;
}

interface PointResult {
  tp: string;
  entry: MrsRegistryEntry;
  lines: PanelLine[];
  eOf: ErrorStats;
  e73: ErrorStats;
  eHand: ErrorStats;
  eOfHand: ErrorStats;
  eOfRich: ErrorStats;
  metOf: ReturnType<typeof pointMetrics>;
  metHand: ReturnType<typeof pointMetrics>;
  closureMax: number;
  massMax: number;
  pOffsetMax: number;
  qRej: number;
  qFlu: number;
  seconds: number;
  nPanels: number;
}

function analyse(tp: string): PointResult {
  const entry = entryOf(tp);
  const o8 = toutMap(base8, tp);
  const o4 = toutMap(base4, tp);
  const o16 = toutMap(base16, tp);
  const hand = handOf(tp);
  const lines: PanelLine[] = [];
  for (const leg of entry.legs) {
    leg.forEach((panel, i) => {
      const o = outlets[tp][panel];
      if (o?.testF === undefined || o.model1973F === undefined)
        throw new Error(`missing outlet data for TP${tp} panel ${panel}`);
      lines.push({
        leg: leg.join("-"),
        position: i + 1,
        panel,
        tin: i === 0 ? entry.tinF : o8[leg[i - 1]],
        test: o.testF,
        m73: o.model1973F,
        hand: hand[panel],
        of8: o8[panel],
        of4: o4[panel],
        of16: o16[panel],
      });
    });
  }
  const rows = base8.filter((r) => r.testPoint === tp);
  const err = (f: (l: PanelLine) => number): ErrorStats =>
    errorStats(lines.map((l) => f(l) - l.test));
  const metOf = pointMetrics(entry, o8, outlets[tp], system[tp], h, tInv);
  const metHand = pointMetrics(entry, hand, outlets[tp], system[tp], h, tInv);
  return {
    tp,
    entry,
    lines,
    eOf: err((l) => l.of8),
    e73: err((l) => l.m73),
    eHand: err((l) => l.hand),
    eOfHand: errorStats(lines.map((l) => l.of8 - l.hand)),
    eOfRich: err((l) => 2 * l.of8 - l.of4),
    metOf,
    metHand,
    closureMax: Math.max(...rows.map((r) => r.energyClosure)),
    massMax: Math.max(...rows.map((r) => r.massClosure)),
    pOffsetMax: Math.max(...rows.map((r) => r.maxPressureOffset)),
    qRej: rows.reduce((s, r) => s + r.qRejected, 0),
    qFlu: rows.reduce((s, r) => s + r.qFluid, 0),
    seconds: rows.reduce((s, r) => s + r.wallSeconds, 0),
    nPanels: rows.length,
  };
}

const results = POINTS.map(analyse);
const R = (tp: string): PointResult =>
  results.find((r) => r.tp === tp) as PointResult;
const pooled = (f: (r: PointResult) => number[]): ErrorStats =>
  errorStats(results.flatMap(f));
const allOf = pooled((r) => r.lines.map((l) => l.of8 - l.test));
const all73 = pooled((r) => r.lines.map((l) => l.m73 - l.test));
const allHand = pooled((r) => r.lines.map((l) => l.hand - l.test));
const allOfHand = pooled((r) => r.lines.map((l) => l.of8 - l.hand));
const allRich = pooled((r) => r.lines.map((l) => 2 * l.of8 - l.of4 - l.test));
const pct = (calc?: number, test?: number): number =>
  calc !== undefined && test ? 100 * (calc / test - 1) : NaN;

/* ------------------------------------------------------------------ */
/* Figures                                                              */
/* ------------------------------------------------------------------ */

function chainFigure(r: PointResult, title: string): string {
  const series: Series[] = [];
  const legs = r.entry.legs.map((l) => l.join("-"));
  type Getter = (l: PanelLine) => number | undefined;
  const add = (
    label: string,
    get: Getter,
    color: string,
    mode: "line" | "both" | "markers",
    marker: Series["marker"],
    dash?: string,
    firstLegOnly = false,
  ): void => {
    legs.forEach((leg, li) => {
      if (firstLegOnly && li > 0) return;
      const pts: Array<[number, number]> = [];
      if (mode !== "markers") pts.push([0, r.entry.tinF]);
      for (const l of r.lines.filter((x) => x.leg === leg)) {
        const v = get(l);
        if (v !== undefined) pts.push([l.position, v]);
      }
      if (pts.length > 1 || (mode === "markers" && pts.length > 0))
        series.push({
          label: li === 0 ? label : "",
          pts,
          color,
          mode: li === 0 || mode === "markers" ? mode : "markers",
          marker,
          dash,
        });
    });
  };
  add("OpenFLUME N=4", (l) => l.of4, "#9db8d8", "line", "circle", "4 3", true);
  if (r.lines.some((l) => l.of16 !== undefined))
    add(
      "OpenFLUME N=16",
      (l) => l.of16,
      "#5b88c0",
      "line",
      "circle",
      "2 3",
      true,
    );
  add("OpenFLUME N=8", (l) => l.of8, C.blue, "both", "circle");
  add("Hand calculation", (l) => l.hand, C.green, "both", "triangle");
  add("1973 model", (l) => l.m73, C.orange, "both", "square", "6 3");
  add("Test", (l) => l.test, C.ref, "markers", "diamond");
  const n = Math.max(...r.lines.map((l) => l.position));
  return lineChart({
    title,
    xLabel: "Panels from the chain inlet (0 is the main inlet)",
    yLabel: "Panel main outlet temperature [F]",
    series,
    xRange: [0, n],
    legend: "top-right",
  });
}

mkdirSync(FIG_DIR, { recursive: true });
const figName = (tp: string): string =>
  `fig0${POINTS.indexOf(tp) + 1}-tp${tp.toLowerCase()}-chain.svg`;
for (const tp of POINTS) {
  const r = R(tp);
  const chainLen = Math.max(...r.lines.map((l) => l.position));
  const what =
    r.entry.legs.length === 1 ? "one chain" : `${r.entry.legs.length} chains`;
  writeFileSync(
    join(FIG_DIR, figName(tp)),
    chainFigure(
      r,
      `MRS test point ${tp}, outlet temperature along ${what} of ${chainLen} panels`,
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Sensitivity                                                          */
/* ------------------------------------------------------------------ */

const o4 = toutMap(base4, CHEAP);
const metBase4 = pointMetrics(
  entryOf(CHEAP),
  o4,
  outlets[CHEAP],
  system[CHEAP],
  h,
  tInv,
);
const sensRows = SENS.map((v) => {
  const rows = load(`${v}_4`);
  const m = toutMap(rows, CHEAP);
  const met = pointMetrics(
    entryOf(CHEAP),
    m,
    outlets[CHEAP],
    system[CHEAP],
    h,
    tInv,
  );
  const d = (p: number): number => m[p] - o4[p];
  const entry = entryOf(CHEAP);
  const ends = entry.legs.map((l) => l[l.length - 1]);
  const all = Object.keys(o4).map((p) => d(Number(p)));
  const rmsErr = errorStats(
    entry.legs.flat().map((p) => m[p] - (outlets[CHEAP][p].testF as number)),
  ).rms;
  return {
    v,
    desc: MRS_VARIANTS[v].description,
    first: d(entry.legs[0][0]),
    end: ends.map(d).reduce((s, x) => s + x, 0) / ends.length,
    max: Math.max(...all.map(Math.abs)),
    tmix: (met.tmix.calc as number) - (metBase4.tmix.calc as number),
    q: pct(met.qBank.calc, metBase4.qBank.calc),
    rmsErr,
    converged: rows.every((r) => r.converged),
  };
});
const rmsBase4 = errorStats(
  entryOf(CHEAP)
    .legs.flat()
    .map((p) => o4[p] - (outlets[CHEAP][p].testF as number)),
).rms;

/* ------------------------------------------------------------------ */
/* Report text                                                          */
/* ------------------------------------------------------------------ */

const entry1A = entryOf("1A");
const entry54 = entryOf("54");
const r1A = R("1A");
const r54 = R("54");
const allRows = [...base8];
const maxEnergy = Math.max(...allRows.map((r) => r.energyClosure));
const maxMass = Math.max(...allRows.map((r) => r.massClosure));
const maxP = Math.max(...allRows.map((r) => r.maxPressureOffset));
const secTotal = allRows.reduce((s, r) => s + r.wallSeconds, 0);
const nSolid = base8[0].nSolid;
const nFluid = base8[0].nFluid;
const allConverged = allRows.every((r) => r.converged);
const fluxRange = (e: MrsRegistryEntry): string => {
  const v = Object.values(e.flux);
  return `${Math.min(...v)} to ${Math.max(...v)}`;
};

function panelTable(r: PointResult): string {
  const body = r.lines.map((l) => [
    l.leg,
    String(l.panel),
    f1(l.tin),
    f1(l.test),
    f1(l.m73),
    f1(l.hand),
    f1(l.of8),
    s1(l.m73 - l.test),
    s1(l.hand - l.test),
    s1(l.of8 - l.test),
    s1(l.of8 - l.hand),
  ]);
  const stat = (name: string, f: (s: ErrorStats) => string): string[] => [
    name,
    "",
    "",
    "",
    "",
    "",
    "",
    f(r.e73),
    f(r.eHand),
    f(r.eOf),
    f(r.eOfHand),
  ];
  return table(
    [
      "Chain",
      "Panel",
      "Inlet (OpenFLUME)",
      "Test",
      "1973 model",
      "Hand calc",
      "OpenFLUME N=8",
      "1973 - test",
      "Hand - test",
      "OpenFLUME - test",
      "OpenFLUME - hand",
    ],
    [
      ...body,
      stat("RMS", (s) => f2(s.rms)),
      stat("Max abs", (s) => f2(s.maxAbs)),
      stat("Bias", (s) => s2(s.bias)),
    ],
  );
}

function pointTable(): string {
  const rows = results.map((r) => {
    const t = r.metOf;
    const hd = r.metHand;
    return [
      `TP${r.tp}`,
      f1(t.tmixPrinted.test as number),
      s1((t.tmixPrinted.model1973 as number) - (t.tmixPrinted.test as number)),
      s1((hd.tmix.calc as number) - (t.tmixPrinted.test as number)),
      s1((t.tmix.calc as number) - (t.tmixPrinted.test as number)),
      f1(t.tmix.test as number),
      f1(t.qBank.test as number),
      s1(pct(t.qBank.model1973, t.qBank.test)),
      s1(pct(hd.qBank.calc, t.qBank.test)),
      s1(pct(t.qBank.calc, t.qBank.test)),
    ];
  });
  return table(
    [
      "Point",
      "Printed test main outlet [F]",
      "1973 error [F]",
      "Hand error [F]",
      "OpenFLUME error [F]",
      "Mixture of test leg ends [F]",
      "Test bank heat [Btu/hr]",
      "1973 heat error [%]",
      "Hand heat error [%]",
      "OpenFLUME heat error [%]",
    ],
    rows,
  );
}

function closureTable(): string {
  return table(
    [
      "Point",
      "Panel solves",
      "All converged",
      "Max energy imbalance of a panel",
      "Heat rejected less absorbed [W]",
      "Fluid enthalpy drop [W]",
      "Max mass imbalance",
      "Max pressure offset [Pa]",
      "Solve time [s]",
    ],
    results.map((r) => [
      `TP${r.tp}`,
      String(r.nPanels),
      base8.filter((x) => x.testPoint === r.tp).every((x) => x.converged)
        ? "yes"
        : "no",
      sci(r.closureMax),
      f1(r.qRej),
      f1(r.qFlu),
      sci(r.massMax),
      f1(r.pOffsetMax),
      f1(r.seconds),
    ]),
  );
}

function discTable(r: PointResult): string {
  const has16 = r.lines.some((l) => l.of16 !== undefined);
  const head = [
    "Panel",
    "Hand calc",
    "N=4",
    "N=8",
    ...(has16 ? ["N=16"] : []),
    "Extrapolated 4 and 8",
    ...(has16 ? ["Extrapolated 8 and 16"] : []),
    "N=8 - hand",
    ...(has16 ? ["N=16 - hand"] : []),
  ];
  const rows = r.lines.map((l) => [
    String(l.panel),
    f2(l.hand),
    f2(l.of4),
    f2(l.of8),
    ...(has16 ? [f2(l.of16 as number)] : []),
    f2(2 * l.of8 - l.of4),
    ...(has16 ? [f2(2 * (l.of16 as number) - l.of8)] : []),
    s2(l.of8 - l.hand),
    ...(has16 ? [s2((l.of16 as number) - l.hand)] : []),
  ]);
  return table(head, rows);
}

const rich16 = r1A.lines.every((l) => l.of16 !== undefined)
  ? errorStats(r1A.lines.map((l) => 2 * (l.of16 as number) - l.of8 - l.hand))
  : undefined;
const of16Hand = r1A.lines.every((l) => l.of16 !== undefined)
  ? errorStats(r1A.lines.map((l) => (l.of16 as number) - l.hand))
  : undefined;
const allRichHand = pooled((r) =>
  r.lines.map((l) => 2 * l.of8 - l.of4 - l.hand),
);
const richHand = (r: PointResult): ErrorStats =>
  errorStats(r.lines.map((l) => 2 * l.of8 - l.of4 - l.hand));
const drops = (r: PointResult): { min: number; max: number } => {
  const d = r.entry.legs.map((leg) => {
    const last = r.lines.find((l) => l.panel === leg[leg.length - 1]);
    return r.entry.tinF - (last as PanelLine).of8;
  });
  return { min: Math.min(...d), max: Math.max(...d) };
};
const range = (d: { min: number; max: number }): string =>
  f0(d.min) === f0(d.max) ? f0(d.min) : `${f0(d.min)} to ${f0(d.max)}`;
const drop1A = drops(r1A);
const drop54 = drops(r54);
const tol16 = Math.max(...base16.map((r) => r.tolerance));
const close16 = Math.max(...base16.map((r) => r.energyClosure));
const worstSens = [...sensRows].sort((a, b) => b.max - a.max)[0];
const sensByName = (n: string) =>
  sensRows.find((s) => s.v === n) as (typeof sensRows)[number];

const report = `# Shuttle Modular Radiator System Thermal-Vacuum Test, System-Level Validation of OpenFLUME

**A high-level thermal-network check against two measured panel traces of the 1973 Modular Radiator System test**

Generated by \`scripts/mrs-validation-report.ts\`. All numbers and figures
come from live solves of the current solver. The comparison choices were fixed
before the first run in [\`mrs-protocol.md\`](mrs-protocol.md). The CI gates are
\`src/validation/__tests__/mrsRadiator.test.ts\` and
\`src/core/__tests__/externalTransport.test.ts\`.

## Abstract

This report recreates two measured traces of the Shuttle Modular Radiator
System (MRS) thermal-vacuum test of 1973 with a model built before the run and
never tuned. The traces are the panel outlet temperatures of test points 1A
and 54, each a series chain of panels in which the coolant (Freon-21) cools
from about ${f1(entry1A.tinF)} F and ${f1(entry54.tinF)} F toward the cold end. The model is a
resolved network of the extruded tubes, the sheet fins, radiation to a -280 F
sink and imposed leg flows, solved panel by panel with the OpenFLUME steady
solver. Over the ${allOf.n} panel outlets of the two points the OpenFLUME
error against the test is ${statLine(allOf)} F at the baseline resolution of 8
segments per tube, against ${statLine(all73)} F for the 1973 model and
${statLine(allHand)} F for the independent hand calculation. The OpenFLUME
panel temperatures differ from the hand calculation by ${f2(allOfHand.rms)} F RMS
(max ${f2(allOfHand.maxAbs)} F) at N = 8 and by ${f2(allRichHand.rms)} F RMS (max ${f2(allRichHand.maxAbs)} F)
after the first-order discretization error is removed by extrapolation from
4 and 8 segments. The model is warmer than the test by ${s2(allOf.bias)} F on average
(${s2(allRich.bias)} F extrapolated) and the hand calculation, which does not use
OpenFLUME, has the same sign (${s2(allHand.bias)} F). The offset to the test therefore
comes from the physical inputs fixed in advance and not from the solver.
${allConverged ? "All panel solves converged. " : "Not all panel solves converged. "}The heat balance of
every panel closes to ${sci(maxEnergy)} and the mass balance to ${sci(maxMass)}.
The case checks the thermal network (conduction, radiation, convection to a
fluid with externally supplied transport properties, series and parallel
bookkeeping of imposed flows). It does not check hydraulics.

## System and test

The MRS test article has eight flat panels of 6 ft by 12 ft. Each panel has
twelve extruded aluminum tubes in a U pattern, one prime tube and eleven main
tubes of length 3, 5, and so on to 23 ft, with an inside diameter of
${(MRS_GEOMETRY.ID / 0.0254).toFixed(3)} in. The tubes are welded to a 0.020 in
aluminum sheet on 6.0 in centres. The panels were tested in a thermal-vacuum
chamber with the plumbing set for each test point and the flows imposed by a
ground cart. The report of the test is Phillips, LTV T169-28 (NASA CR-140269,
NTRS 19740026229), with the test description in NASA CR-140268. The two traces
are the following.

${table(
  [
    "Point",
    "Configuration",
    "Chains (panel order)",
    "Sides",
    "Inlet [F]",
    "Main flow [lb/hr]",
    "Absorbed flux [Btu/hr-ft2]",
  ],
  [entry1A, entry54].map((e) => [
    `TP${e.testPoint}`,
    e.configuration,
    e.legs.map((l) => l.join("-")).join(", "),
    String(e.sides),
    f1(e.tinF),
    String(e.totalFlowLbhr),
    fluxRange(e),
  ]),
)}

Both points are in the primary comparison set of the protocol and have the
fewest panels of that set with a series chain of at least two panels. TP1A is a
one-sided hot case with two chains of four panels, so the temperature falls
over four panels. TP54 is a two-sided skewed case with four chains of two
panels and a large temperature drop with a strong flux difference between the
panels of a chain.

## Protocol

The protocol was committed with the data before any OpenFLUME run. The choices
below are used unchanged.

- Main bank only. The prime tube is not modeled and each panel outlet is the
  main outlet, as in the 1973 model. The mixed main outlet is the flow-weighted
  enthalpy mixture of the chain end temperatures.
- Flows are imposed. Each chain carries the printed total main flow times its
  leg fraction, split equally over the eleven main tubes of every panel.
- Aluminum 6063 with a constant conductivity of ${MRS_CHOICES.kAl} W/m-K in the tube wall
  and fins, emissivity ${MRS_CHOICES.emissivity} on every radiating surface, a sink
  of ${MRS_CHOICES.sinkF} F, and the Table 2 absorbed flux applied uniformly per
  unit panel area. A two-sided panel has a total effective radiating area of
  ${(1 + MRS_CHOICES.twoSidedExtra).toFixed(2)} times the panel area, as in the 1973 model.
- Laminar Nusselt number ${MRS_CHOICES.nuLaminar} to Re 2300, Gnielinski from Re 4000, and a
  linear blend between.
- R21 density, specific heat and enthalpy from CoolProp at 1.5 MPa. R21 has no
  viscosity or thermal conductivity in CoolProp. These two come from the
  REFPROP R21 transport model of Huber (2010) evaluated once into a table, with a
  stated uncertainty of 5 percent, and are carried in the convection
  expression (see the data README).
- Comparators are the 1973 model as tabulated on the correlation maps and the
  independent first-principles hand calculation of
  \`scripts/reference/mrs_hand_calc.py\`, which shares the choices above and does
  not use OpenFLUME.
- Metrics are the panel outlet error calculated minus test, the mixed main
  outlet error and the bank heat error. The bank heat is computed from leg end
  temperatures and the leg flows with the same CoolProp enthalpy function for
  the model, the test and the 1973 model.

## Model

Each panel is one OpenFLUME network. A tube is a chain of N segments. Each
segment has one fluid node, two tube wall nodes and five fin nodes across the half
fin, with conduction along and across the fin and the wall and radiation of
the crown and fins to a sink node. The absorbed flux enters as node heat input.
The eleven tubes discharge into a mixing node. The fluid is R21 declared with
\`params.transport = "external"\`, which is the opt-in added for this case. It
lets a real fluid that has no built-in viscosity or conductivity be used while
validation rejects any component that would read them. The wall-fluid heat
transfer coefficient is a custom convection expression that carries the R21
transport fits. At N = 8 a panel network has ${nSolid} solid temperature
unknowns and ${nFluid} fluid nodes. A chain of four panels is four such networks
solved in sequence, so the unknown count is ${4 * nSolid} solid temperatures and
${4 * nFluid} fluid nodes for a leg of TP1A and ${2 * nSolid} and ${2 * nFluid} for a leg of TP54.
The flow is imposed, nothing flows upstream, and the mixed outlet state of one panel is
exactly the inlet state of the next. A network whose branches are all imposed
flows leaves the node pressures undetermined, so only the first branch of every
tube imposes the flow and the other branches are small resistances that anchor
the pressure to the loop pressure of 1.5 MPa (maximum offset ${f1(maxP)} Pa).
No parameter was adjusted after seeing a result.

## Results

### Test point 1A

${panelTable(r1A)}

Temperatures in F. The inlet column is the OpenFLUME chain inlet. The test
values are read from the printed correlation maps to the printed precision, which is
0.1 F, and the flow in the test legs differs from the printed total by a few
percent, as the protocol notes.

![TP1A outlet temperature along the chains](figures/mrs/${figName("1A")})

_TP1A panel outlet temperature along the series chain. Both chains are shown,
the second as markers. The light dashed lines are OpenFLUME at 4 and 16 segments
per tube and give the discretization spread._

### Test point 54

${panelTable(r54)}

![TP54 outlet temperature along the chains](figures/mrs/${figName("54")})

_TP54 panel outlet temperature along the four chains of two panels._

### Mixed outlet, bank heat, closure and runtime

${pointTable()}

The 1973 and hand calculation columns are scored the same way as OpenFLUME.
The mixed main outlet error is against the temperature printed on the map.
The heat error is against the bank heat recomputed from the measured chain end
temperatures. The printed heat tables of the test are not used because they
disagree with the enthalpy balance through the leg flow inconsistency.

${closureTable()}

Heat rejected less absorbed is the sum of the radiation conductor heat rates
less the absorbed flux over the panels of the point. The fluid enthalpy drop is
the imposed flow times the CoolProp enthalpy change between panel inlet and
outlet. The ratio is the energy closure. The ${allRows.length} panel solves of the
baseline took ${f1(secTotal)} s of solver time in total on one core.

### Pooled over the ${allOf.n} panel outlets

${table(
  ["Comparison", "RMS [F]", "Max abs [F]", "Bias [F]"],
  [
    ["1973 model - test", f2(all73.rms), f2(all73.maxAbs), s2(all73.bias)],
    [
      "Hand calculation - test",
      f2(allHand.rms),
      f2(allHand.maxAbs),
      s2(allHand.bias),
    ],
    ["OpenFLUME N=8 - test", f2(allOf.rms), f2(allOf.maxAbs), s2(allOf.bias)],
    [
      "OpenFLUME N=8 extrapolated - test",
      f2(allRich.rms),
      f2(allRich.maxAbs),
      s2(allRich.bias),
    ],
    [
      "OpenFLUME N=8 - hand calculation",
      f2(allOfHand.rms),
      f2(allOfHand.maxAbs),
      s2(allOfHand.bias),
    ],
  ],
)}

The extrapolated row uses 2 T(8) - T(4) along each chain and is shown only as a
discretization diagnostic. It is not the baseline.

## Discretization check

The cell-outlet scheme for the fluid energy equation is first order in the
number of segments, so the N = 8 baseline is not converged. Each panel
network was also solved at 4 segments for both points and at 16 segments for
TP1A. The extrapolated columns apply 2 T(2N) - T(N) to each chain.

### TP1A

${discTable(r1A)}

### TP54

${discTable(r54)}

On TP1A the N = 8 temperatures are ${f2(r1A.eOfHand.bias)} F on average above the hand
calculation (max ${f2(r1A.eOfHand.maxAbs)} F) and the N = 16 temperatures are ${of16Hand ? f2(of16Hand.bias) : "n/a"} F on
average above it (max ${of16Hand ? f2(of16Hand.maxAbs) : "n/a"} F). The extrapolation from 4 and 8 segments
leaves ${f2(richHand(r1A).maxAbs)} F at most and the extrapolation from 8 and 16 leaves ${rich16 ? f2(rich16.maxAbs) : "n/a"} F.
On TP54 the N = 8 difference to the hand calculation is ${s2(r54.eOfHand.bias)} F on average (max
${f2(r54.eOfHand.maxAbs)} F) and the extrapolation from 4 and 8 segments leaves ${f2(richHand(r54).maxAbs)} F
at most. The N = 8 grid is therefore not discretization converged. TP54 has
steeper axial gradients (a coolant drop of ${range(drop54)} F over two panels against ${range(drop1A)} F over four for TP1A) and
its N = 8 difference is ${(r54.eOfHand.bias / r1A.eOfHand.bias).toFixed(1)} times that of TP1A. The difference between OpenFLUME
and the hand calculation shrinks under refinement, as expected for a first
order scheme, and the hand calculation marches explicitly from below and has a
discretization error of its own, which was 0.3 F on one tube at 24 segments.
The N = 16 solves were accepted at a solver tolerance of ${sci(tol16)} with a worst panel energy imbalance of ${sci(close16)}, after the tighter default of 1e-10 did not converge, so their solve time is not comparable with the N = 8 time of the closure table. The protocol baseline of 8 segments is kept as the primary result and the
extrapolated values are given as a diagnostic.

## Sensitivity of TP1A

The cheapest point was repeated at 4 segments with one input changed at a time,
using the ranges stated in the protocol. Entries are the change from the 4
segment baseline. The baseline RMS error against the test at N = 4 is ${f2(rmsBase4)} F.

${table(
  [
    "Change",
    "Panel 1 [F]",
    "Chain end, mean [F]",
    "Max over 8 outlets [F]",
    "Mixed outlet [F]",
    "Bank heat [%]",
    "RMS error vs test [F]",
  ],
  sensRows.map((s) => [
    s.desc,
    s2(s.first),
    s2(s.end),
    f2(s.max),
    s2(s.tmix),
    s2(s.q),
    f2(s.rmsErr),
  ]),
)}

${worstSens.desc[0].toUpperCase()}${worstSens.desc.slice(1)} has the largest effect, ${f2(worstSens.max)} F at most.
A 5 percent change of the absorbed flux moves the chain end by ${f2(Math.max(Math.abs(sensByName("fluxPlus").end), Math.abs(sensByName("fluxMinus").end)))} F
and a change of 0.02 in emissivity by ${f2(Math.max(Math.abs(sensByName("epsPlus").end), Math.abs(sensByName("epsMinus").end)))} F. This is the same order as the bias of
${s1(allOf.bias)} F against the test over both points, and lowering the flux by 5 percent
reduces the N = 4 RMS error on TP1A from ${f2(rmsBase4)} F to ${f2(sensByName("fluxMinus").rmsErr)} F. Viscosity
(${s2(sensByName("muPlus").end)} F and ${s2(sensByName("muMinus").end)} F at the chain end for plus and minus 25
percent) and fluid conductivity (${s2(sensByName("kPlus").end)} F and ${s2(sensByName("kMinus").end)} F for
plus and minus 15 percent) act only through the fluid-side coefficient, which is
a small part of the thermal resistance, so the uncertainty of the R21 transport
source is small against the offset to the test. The absorbed flux is derived
by the test laboratory with no stated uncertainty, so an offset of this size cannot be ruled out as input uncertainty. These changes are a sensitivity statement and
not a calibration, and no input of the baseline was changed after seeing a result.

## Limitations

- This is a thermal-network case. Panel pressure drop in the test is dominated by
  unpublished per-tube orifices, so hydraulics and flow split are neither
  modeled nor compared. The flows are imposed.
- Only two of the eleven primary points of the protocol are run, and the low
  load frozen-tube regime is outside the scope. The statistics are over
  ${allOf.n} outlets of two points and say little about the whole test.
- R21 viscosity and conductivity come from a published transport model with a
  stated 5 percent uncertainty and not from a measured table. A cross-check
  with a NASA Tech Brief puts the conductivity 8 percent higher.
- The absorbed flux is derived by the test laboratory and carries an
  uncertainty that the report does not state. The two-sided area factor of 1.67
  comes from analysis only.
- The aluminum conductivity and the emissivity are engineering choices fixed in
  the protocol and not measured values for these panels.
- The 1973 model uses a fin effectiveness of 0.90 and a tube bank of one
  representative tube. OpenFLUME resolves the fin, so the comparison is between
  two modeling approaches. The tabulated 1973 predictions for TP1A and TP54 were
  computed at inlet temperatures and flows that differ slightly from the test.
- The test temperatures are read from printed maps. Data defects found in the
  report (missing flows, a misprinted leg flow, an environment row that repeats
  another) are handled by the decisions recorded in the protocol.
- The prime tube is not modeled, as in the 1973 model.
- Panels are solved one network at a time. The case does not exercise a single
  solve with the whole eight-panel plumbing.

## Conclusions

A resolved, a-priori network of one radiator panel, chained in series, runs in
the OpenFLUME steady solver with an R21 fluid whose transport comes from outside the
fluid library. It agrees with an independent hand calculation of the same physics
to ${f2(allOfHand.rms)} F RMS at the baseline resolution of 8 segments and to ${f2(allRichHand.rms)} F RMS
after extrapolation, and it closes its energy and mass balances. Against the
measured outlet temperatures of two test points the error is ${statLine(allOf)} F,
to be compared with ${statLine(all73)} F for the 1973 model and ${statLine(allHand)} F for the
hand calculation. The case verifies the thermal network and the series and
parallel bookkeeping of imposed flows. It is not a validation of hydraulics.
The agreement with the test is limited by physical inputs that were fixed in
advance and not tuned, chiefly the laboratory-derived absorbed flux and the
emissivity.

## References

1. Phillips, M. A., *Shuttle Active Thermal Control System Development
   Testing, Volume III, Modular Radiator System Test Data Correlation with
   Thermal Model*, LTV Aerospace Report T169-28, NASA CR-140269,
   18 December 1973 (NTRS 19740026229).
2. Scheps, Howell, and Voss, *Shuttle Active Thermal Control System
   Development Testing, Volume II, Modular Radiator System Test Description*,
   NASA CR-140268, 23 October 1973 (NTRS 19740026228).
3. Huber, M. L., Laesecke, A., and Perkins, R. A., "Model for the Viscosity
   and Thermal Conductivity of Refrigerants, Including a New Correlation for
   the Viscosity of R134a," *Industrial and Engineering Chemistry Research*,
   Vol. 42, 2003, pp. 3163-3178 (extended corresponding states model used by
   the REFPROP R21 transport block).
4. Gnielinski, V., "Ein neues Berechnungsverfahren fuer die Waermeuebertragung
   im Uebergangsbereich zwischen laminarer und turbulenter Rohrstroemung,"
   *Forschung im Ingenieurwesen*, Vol. 61, 1995, pp. 240-248.
`;

writeFileSync(REPORT, report);
console.log(`wrote ${REPORT} and ${POINTS.length} figures`);
