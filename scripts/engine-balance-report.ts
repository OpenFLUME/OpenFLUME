/**
 * engine-balance-report.ts — generates the SP-125 A-1 stage engine balance
 * report (docs/validation/engine-balance-report.md) and its figures
 * (docs/validation/figures/engine-balance/).  The comparison choices are
 * fixed in docs/validation/engine-balance-protocol.md before any run.
 *
 *   npx tsx scripts/engine-balance-report.ts
 *
 * Every number in the report comes from live solves of the network of
 * src/validation/a1Engine.ts and from arithmetic on the printed book values
 * in that file.  The run takes about thirty seconds.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  A1,
  BOOK,
  LB,
  FT,
  balanceA1,
  solveA1,
  a1Metrics,
  turbinePowerHp,
} from "../src/validation/a1Engine";
import { C, groupedBarChart, lineChart } from "./lib/report-charts";

const REPORT = join("docs", "validation", "engine-balance-report.md");
const FIG_DIR = join("docs", "validation", "figures", "engine-balance");
mkdirSync(FIG_DIR, { recursive: true });

const f = (x: number, d = 1): string => x.toFixed(d);
const pct = (model: number, book: number, d = 2): string => {
  const v = 100 * (model / book - 1);
  return `${v >= 0 ? "+" : ""}${v.toFixed(d)}`;
};
const sci = (x: number): string => x.toExponential(1);

/* ------------------------------------------------------------------ */
/* Solves                                                              */
/* ------------------------------------------------------------------ */

console.log("Baseline solve at 7000 rpm...");
const basePt = solveA1();
const base = a1Metrics(basePt);

console.log("Balance on shaft speed...");
const bal = balanceA1("speed");
const balM = bal.metrics;

console.log("Cross-check balance on the gas generator orifice scale...");
const alt = balanceA1("ggOrificeScale");
const altM = alt.metrics;

console.log("Sensitivities...");
const sens: Array<{ label: string; b: ReturnType<typeof balanceA1> }> = [
  { label: "Pump shut-off ratio 1.1", b: balanceA1("speed", { shutoff: 1.1 }) },
  { label: "Pump shut-off ratio 1.3", b: balanceA1("speed", { shutoff: 1.3 }) },
  {
    label: "Turbine R from cp and gamma (56.0 against the printed 53.6)",
    b: balanceA1("speed", {
      turbineR: (A1.turbineCp * (A1.turbineGamma - 1)) / A1.turbineGamma,
    }),
  },
  {
    label: "Combustor drop scaled with the gas generator flow squared",
    b: balanceA1("speed", { scaleCombustorDrop: true }),
  },
];

/* ------------------------------------------------------------------ */
/* Book internal consistency (arithmetic on the printed values)        */
/* ------------------------------------------------------------------ */

const rhoLoxFt = 71.38;
const rhoFuelFt = 50.45;
const budgets = {
  lox: 1505 - 25 - 35 - 150 - 200,
  fuel: 1720 - 10 - 15 - 110 - 290 - 200,
  ggLox: 1505 - 25 - 25 - 615 - 10 - 120,
  ggFuel: 1720 - 25 - 25 - 800 - 20 - 140,
};
const headLoxFromP = ((1505 - 55) * 144) / rhoLoxFt;
const headFuelFromP = ((1720 - 45) * 144) / rhoFuelFt;
const hpLoxFromP =
  ((1971 / rhoLoxFt) * (1505 - 55) * 144) / 550 / A1.etaLoxPump;
const hpFuelFromP =
  ((892 / rhoFuelFt) * (1720 - 45) * 144) / 550 / A1.etaFuelPump;
const turbHpBook = turbinePowerHp(92 * LB, 640 / 27);
const turbHpTorque = (BOOK.torque * 2 * Math.PI * 7000) / 33000;
const cpFromR = ((1.124 / 0.124) * 53.6) / 778.17;
const rFromCp = (0.653 * 0.124 * 778.17) / 1.124;

/* ------------------------------------------------------------------ */
/* Comparison tables                                                   */
/* ------------------------------------------------------------------ */

interface Row {
  name: string;
  unit: string;
  book: number;
  base: number;
  bal: number;
  tolPct: number;
  basis: string;
  digits?: number;
}

const rows: Row[] = [];
const add = (
  name: string,
  unit: string,
  book: number,
  b: number,
  l: number,
  tolPct: number,
  basis: string,
  digits = 1,
): void => {
  rows.push({ name, unit, book, base: b, bal: l, tolPct, basis, digits });
};

add(
  "Chamber oxidizer flow",
  "lb/s",
  BOOK.mdotOx,
  base.mdotOx,
  balM.mdotOx,
  2,
  "solved",
);
add(
  "Chamber fuel flow",
  "lb/s",
  BOOK.mdotFuel,
  base.mdotFuel,
  balM.mdotFuel,
  2,
  "solved",
);
add("Chamber O/F", "", BOOK.of, base.of, balM.of, 2, "solved", 3);
add(
  "Gas generator oxidizer flow",
  "lb/s",
  BOOK.ggOx,
  base.ggOx,
  balM.ggOx,
  2,
  "sized, shifted by the solve",
  2,
);
add(
  "Gas generator fuel flow",
  "lb/s",
  BOOK.ggFuel,
  base.ggFuel,
  balM.ggFuel,
  2,
  "sized, shifted by the solve",
  2,
);
add(
  "Gas generator O/F",
  "",
  BOOK.ggOf,
  base.ggOf,
  balM.ggOf,
  2,
  "sized, shifted by the solve",
  3,
);
add(
  "Turbine flow",
  "lb/s",
  BOOK.turbineMdot,
  base.turbineMdot,
  balM.turbineMdot,
  2,
  "sized, shifted by the solve",
  2,
);
add(
  "LOX pump flow",
  "lb/s",
  BOOK.loxPumpMdot,
  base.loxPumpMdot,
  balM.loxPumpMdot,
  2,
  "solved",
);
add(
  "Fuel pump flow",
  "lb/s",
  BOOK.fuelPumpMdot,
  base.fuelPumpMdot,
  balM.fuelPumpMdot,
  2,
  "solved",
);

const stations: Row[] = [];
const addSt = (
  name: string,
  book: number,
  b: number,
  l: number,
  basis = "solved",
): void => {
  stations.push({
    name,
    unit: "psia",
    book,
    base: b,
    bal: l,
    tolPct: 1,
    basis,
  });
};
addSt("LOX pump discharge", 1505, base.lox.pump, balM.lox.pump);
addSt("LOX after line", 1480, base.lox.line, balM.lox.line);
addSt("LOX after main valve", 1445, base.lox.valve, balM.lox.valve);
addSt("LOX after torus dome", 1295, base.lox.dome, balM.lox.dome);
addSt("Fuel pump discharge", 1720, base.fuel.pump, balM.fuel.pump);
addSt("Fuel after line", 1710, base.fuel.line, balM.fuel.line);
addSt("Fuel after main valve", 1695, base.fuel.valve, balM.fuel.valve);
addSt(
  "Fuel after calibration orifice",
  1585,
  base.fuel.calibration,
  balM.fuel.calibration,
);
addSt(
  "Fuel after jacket and manifold",
  1295,
  base.fuel.jacket,
  balM.fuel.jacket,
);
addSt(
  "Injector end (both sides)",
  BOOK.injectorEnd,
  base.injectorEnd,
  balM.injectorEnd,
);
addSt(
  "Gas generator injector end",
  BOOK.ggInjectorEnd,
  base.ggInjectorEnd,
  balM.ggInjectorEnd,
);
addSt("Turbine inlet", BOOK.turbineInlet, base.turbineInlet, balM.turbineInlet);

const chamber: Row[] = [
  {
    name: "Nozzle stagnation pressure Pc",
    unit: "psia",
    book: BOOK.pc,
    base: base.pc,
    bal: balM.pc,
    tolPct: 3,
    basis: "solved (CEA table)",
  },
  {
    name: "c*",
    unit: "ft/s",
    book: BOOK.cstar,
    base: base.cstar,
    bal: balM.cstar,
    tolPct: 3,
    basis: "solved (CEA table)",
    digits: 0,
  },
  {
    name: "Turbine pressure ratio",
    unit: "",
    book: BOOK.turbinePr,
    base: base.turbinePr,
    bal: balM.turbinePr,
    tolPct: 2,
    basis: "post-processed",
    digits: 2,
  },
  {
    name: "LOX pump head",
    unit: "ft",
    book: BOOK.loxHead,
    base: base.loxHead,
    bal: balM.loxHead,
    tolPct: 3,
    basis: "post-processed",
    digits: 0,
  },
  {
    name: "Fuel pump head",
    unit: "ft",
    book: BOOK.fuelHead,
    base: base.fuelHead,
    bal: balM.fuelHead,
    tolPct: 3,
    basis: "post-processed",
    digits: 0,
  },
];

const power: Row[] = [
  {
    name: "LOX pump power",
    unit: "bhp",
    book: BOOK.loxHp,
    base: base.loxHp,
    bal: balM.loxHp,
    tolPct: 3,
    basis: "post-processed",
    digits: 0,
  },
  {
    name: "Fuel pump power",
    unit: "bhp",
    book: BOOK.fuelHp,
    base: base.fuelHp,
    bal: balM.fuelHp,
    tolPct: 3,
    basis: "post-processed",
    digits: 0,
  },
  {
    name: "Auxiliary drive",
    unit: "bhp",
    book: BOOK.auxHp,
    base: A1.auxHp,
    bal: A1.auxHp,
    tolPct: 3,
    basis: "imposed",
    digits: 0,
  },
  {
    name: "Turbine power",
    unit: "bhp",
    book: BOOK.turbineHp,
    base: base.turbineHp,
    bal: balM.turbineHp,
    tolPct: 5,
    basis: "post-processed",
    digits: 0,
  },
  {
    name: "Turbine torque",
    unit: "ft lbf",
    book: BOOK.torque,
    base: base.torque,
    bal: balM.torque,
    tolPct: 5,
    basis: "post-processed",
    digits: 0,
  },
  {
    name: "Shaft speed",
    unit: "rpm",
    book: BOOK.rpm,
    base: base.rpm,
    bal: balM.rpm,
    tolPct: 3,
    basis: "free parameter, solved by the outer balance",
    digits: 0,
  },
];

function table(list: Row[], withTol = true): string {
  const head = withTol
    ? "| Quantity | Unit | Book | At 7000 rpm | % | Balanced | % | Expected tolerance % | Within | Basis |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
    : "| Quantity | Unit | Book | At 7000 rpm | % | Balanced | % | Basis |\n| --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = list.map((r) => {
    const d = r.digits ?? 1;
    const pb = 100 * Math.abs(r.base / r.book - 1);
    const pl = 100 * Math.abs(r.bal / r.book - 1);
    const within = pl <= r.tolPct && pb <= r.tolPct ? "yes" : "no";
    const common = `| ${r.name} | ${r.unit} | ${f(r.book, d)} | ${f(r.base, d)} | ${pct(r.base, r.book)} | ${f(r.bal, d)} | ${pct(r.bal, r.book)} |`;
    return withTol
      ? `${common} ${r.tolPct} | ${within} | ${r.basis} |`
      : `${common} ${r.basis} |`;
  });
  return `${head}\n${body.join("\n")}`;
}

/* ------------------------------------------------------------------ */
/* Figures                                                             */
/* ------------------------------------------------------------------ */

const powerFig = groupedBarChart({
  title: "Power balance, book and model",
  xLabel: "Shaft power item",
  yLabel: "Shaft power [bhp]",
  categories: ["Fuel pump", "LOX pump", "Auxiliary", "Pumps + aux", "Turbine"],
  series: [
    {
      label: "SP-125 Table 3-2",
      values: [
        BOOK.fuelHp,
        BOOK.loxHp,
        BOOK.auxHp,
        BOOK.fuelHp + BOOK.loxHp + BOOK.auxHp,
        BOOK.turbineHp,
      ],
      color: C.ref,
    },
    {
      label: "Model at 7000 rpm",
      values: [
        base.fuelHp,
        base.loxHp,
        A1.auxHp,
        base.fuelHp + base.loxHp + A1.auxHp,
        base.turbineHp,
      ],
      color: C.blue,
    },
    {
      label: "Model balanced",
      values: [
        balM.fuelHp,
        balM.loxHp,
        A1.auxHp,
        balM.fuelHp + balM.loxHp + A1.auxHp,
        balM.turbineHp,
      ],
      color: C.red,
    },
  ],
  headroom: 1.3,
});
writeFileSync(join(FIG_DIR, "fig02-power-balance.svg"), powerFig);

const stationX = (n: number) => n;
const pressureFig = lineChart({
  title: "Pressure budget from pump discharge to injector end",
  xLabel: "Station along the feed line (0 is the pump discharge)",
  yLabel: "Pressure [psia]",
  legend: "bottom-left",
  series: [
    {
      label: "LOX, book",
      color: C.ref,
      mode: "line",
      pts: [1505, 1480, 1445, 1295, 1095].map((p, i) => [stationX(i), p]),
    },
    {
      label: "LOX, model at 7000 rpm",
      color: C.blue,
      mode: "markers",
      marker: "circle",
      pts: [
        base.lox.pump,
        base.lox.line,
        base.lox.valve,
        base.lox.dome,
        base.lox.injector,
      ].map((p, i) => [stationX(i), p]),
    },
    {
      label: "Fuel, book",
      color: C.grey,
      mode: "line",
      dash: "5 3",
      pts: [1720, 1710, 1695, 1585, 1295, 1095].map((p, i) => [stationX(i), p]),
    },
    {
      label: "Fuel, model at 7000 rpm",
      color: C.red,
      mode: "markers",
      marker: "square",
      pts: [
        base.fuel.pump,
        base.fuel.line,
        base.fuel.valve,
        base.fuel.calibration,
        base.fuel.jacket,
        base.fuel.injector,
      ].map((p, i) => [stationX(i), p]),
    },
  ],
});
writeFileSync(join(FIG_DIR, "fig01-pressure-budget.svg"), pressureFig);

/* ------------------------------------------------------------------ */
/* Helpers for prose                                                   */
/* ------------------------------------------------------------------ */

const scored = [...rows, ...stations, ...chamber, ...power].filter(
  (r) => r.basis !== "imposed",
);
const outBase = scored.filter(
  (r) => 100 * Math.abs(r.base / r.book - 1) > r.tolPct,
);
const outBal = scored.filter(
  (r) => 100 * Math.abs(r.bal / r.book - 1) > r.tolPct,
);
const names = (l: Row[]): string =>
  l.map((r) => r.name.toLowerCase()).join(", ");
const outsideText =
  outBase.length === 0 && outBal.length === 0
    ? "Every compared quantity is inside its expected tolerance."
    : `At 7000 rpm ${outBase.length} compared ${outBase.length === 1 ? "quantity is" : "quantities are"} outside the tolerance set in the protocol${outBase.length ? ` (${names(outBase)})` : ""}. At the balanced shaft speed ${outBal.length} ${outBal.length === 1 ? "is" : "are"} outside it${outBal.length ? ` (${names(outBal)})` : ""}. They are discussed below and nothing was adjusted.`;

const cstarIdealFt = base.oxStar.cstarCea / FT;
const cstarBookIdeal = BOOK.cstar / A1.cstarEff;
const totalFlowBook = BOOK.mdotOx + BOOK.mdotFuel;

const histTable = (
  h: Array<{ x: number; residualHp: number }>,
  xName: string,
) =>
  `| Iteration | ${xName} | Residual [bhp] |\n| --- | --- | --- |\n` +
  h
    .map((e, i) => `| ${i} | ${f(e.x, 6)} | ${e.residualHp.toFixed(3)} |`)
    .join("\n");

const sensTable =
  "| Case | Shaft speed [rpm] | Turbine power [bhp] | Pc [psia] | Residual at 7000 rpm [bhp] |\n| --- | --- | --- | --- | --- |\n" +
  [
    {
      label: "Baseline (shut-off ratio 1.2)",
      b: bal,
    },
    ...sens,
  ]
    .map((s) => {
      const m = s.b.metrics;
      const r0 = s.b.history[0].residualHp;
      return `| ${s.label} | ${f(m.rpm, 0)} | ${f(m.turbineHp, 0)} | ${f(m.pc, 1)} | ${f(r0, 1)} |`;
    })
    .join("\n");

const innerSolveCount =
  bal.solves +
  alt.solves +
  sens.reduce((a, s) => a + s.b.solves, 0) +
  basePt.innerSolves;

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

const report = `# A-1 Stage Engine Balance, NASA SP-125 Design Example

**A nested pump and turbine power balance with pressure budgets for a 750 klbf LOX/RP-1 gas-generator-cycle engine, compared with the printed design values of NASA SP-125**

Generated by \`scripts/engine-balance-report.ts\`. All numbers and figures
come from live solves of the current solver. The comparison choices were fixed
before the first run in [\`engine-balance-protocol.md\`](engine-balance-protocol.md).
The CI gate is \`src/validation/__tests__/a1Engine.test.ts\`.

## Abstract

This report builds a basic balance of the A-1 stage engine of Huzel and Huang
(NASA SP-125, Table 3-2) from components that OpenFLUME has today and compares
every published balance number with the model. The engine is a hypothetical
750 klbf LOX/RP-1 gas-generator-cycle engine, so the reference is a published
design example and not a measured engine. The network has LOX and RP-1 feed
lines with one square-law restriction per printed pressure drop, two pumps with
a head-flow shape through the design point, a reacting junction chamber with a
choked throat, the two gas-generator feed lines and the turbine as a choked
orifice with the book's gas state. The turbine power, the pump powers and the
balance residual are post-processed, because OpenFLUME has no turbine component
and no shaft speed unknown. The balance is closed by a script-level outer
iteration on the common shaft speed, with an inner root find on the gas
generator pressure. It is a nested balance, not a simultaneous solve.

At the book hardware and 7000 rpm the model turbine power is ${f(base.turbineHp, 0)} bhp
against ${f(base.loxHp + base.fuelHp + A1.auxHp, 0)} bhp for the pumps and the auxiliary drive, a
residual of ${f(base.residualHp, 0)} bhp (${f(100 * base.residualFraction, 2)} percent of the turbine power). The
outer iteration closes it to ${sci(Math.abs(balM.residualFraction))} of the turbine power at a shaft speed
of ${f(balM.rpm, 0)} rpm, ${pct(balM.rpm, BOOK.rpm)} percent from the book's 7000. The nozzle
stagnation pressure is ${f(base.pc, 1)} psia against 1000 (${pct(base.pc, BOOK.pc)} percent) and c* is
${f(base.cstar, 0)} ft/s against 5660 (${pct(base.cstar, BOOK.cstar)} percent), which is the CEA table value
(${pct(cstarIdealFt, cstarBookIdeal)} percent above the book's implied ideal c*) times the 0.975 efficiency. ${outsideText}
Because the effective area of every restriction is sized from the book's own
flow and drop, the flows and station pressures are reproduced largely by
construction, and the report marks them so. The independent content of the
case is the CEA chamber, the pump curve shift, the turbine power from the
solved state and the shaft speed that closes the balance. This is a code-to-code
check against a design example. It is not a validation against measurement.

## System

The A-1 engine of SP-125 is a single-start fixed-thrust gas-generator-cycle
engine. A direct-drive turbopump has a fuel pump and a LOX pump on one shaft
at 7000 rpm with a two-wheel turbine. An uncooled gas generator burns the same
propellants at O/F 0.408 and the turbine exhaust is discharged separately at
27 psia. The thrust chamber is regeneratively cooled by the fuel. Table 3-2
(printed page 65) lists the flows, the pressure drop of every element, the pump
and turbine data and the gas generator data, and Table 6-4 (page 197) and
Sample Calculation 6-5 (page 199) give the turbine gas properties. The data are
tabulated with page citations in the protocol. The book's budgets close in psi.
The main LOX side is 1505 - 25 - 35 - 150 - 200 = ${budgets.lox} psia and the fuel side is
1720 - 10 - 15 - 110 - 290 - 200 = ${budgets.fuel} psia. The gas generator budgets give
${budgets.ggLox} and ${budgets.ggFuel} psia.

## Protocol

The data, the imposed inputs, the unknowns, the free parameter and the
expected tolerances were committed before any run (no solver call of any kind
had been made for this case at that commit). The points that matter for
reading the results are the following.

- The effective area of every liquid restriction is sized from the book's
  flow and drop with the book's density, so the network passes the printed
  flow at the printed drop. The turbine effective area is sized to pass
  92 lb/s at 640 psia and 1860 R with the printed gas constant.
- The pump head-flow shape is h = 1.2 - 0.2 q squared through the design
  point, which is a stated choice and not a book number. The affinity laws
  scale it with speed and the efficiency is the printed constant.
- The gas generator gas state is imposed from the book, because the CEA tables
  start at O/F 1 and NASA CEA gives 1727 F against the book's 1400 F at
  O/F 0.408. No CEA is used for the gas generator.
- The free parameter of the outer balance is the common shaft speed. The
  cross-check closure uses the common scale of the two gas generator control
  orifice areas at 7000 rpm.
- The balance closes when the residual is below 1e-6 of the turbine power.

## Model

The network has ${basePt.result.nodes ? Object.keys(basePt.result.nodes).length : 0} nodes and ${basePt.result.branches ? Object.keys(basePt.result.branches).length : 0} branches. The LOX line is the pump, then
the line, main valve, torus dome and injector, each an orifice branch, ending
on the chamber node. The fuel line is the pump, line, main valve, calibration
orifice, jacket and manifold, and injector. A flow source takes the printed
3 lb/s heat exchanger flow from the LOX pump discharge. The two gas generator
lines start at the pump discharge nodes and pass the entrance loss, line,
control orifice, valve and injector before they reach two liquid boundary nodes
at the gas generator injector end pressure. The tanks are boundary nodes at the
printed pump inlet pressures of 55 and 45 psia.

The chamber node is a reacting junction on the \`lox-rp1\` CEA table with an
enthalpy efficiency of 0.975 squared. The throat is a choked orifice to an
ambient boundary with the throat area of 487 square inches and a discharge
coefficient of 1000/1095, which carries the book's stagnation pressure loss of
the chamber. The node pressure is therefore the injector end pressure and the
model Pc is the node pressure over 1.095. The turbine inlet is a gas boundary
node at the gas generator pressure minus the printed 70 psi combustor drop and
1860 R, and the turbine is a choked orifice to a boundary at 27 psia.

The inner loop is a secant iteration on the gas generator pressure until the
liquid flow into the gas generator equals the turbine flow (${basePt.innerSolves} solves at
the baseline, residual ${sci(Math.abs(basePt.innerResidual))} kg/s). The turbine power is
cp T0 (1 - (1/PR)^((gamma-1)/gamma)) times the solved flow times 0.582 by
equations 6-18 and 6-19. The pump power is the volumetric flow times the solved
rise over the printed efficiency. The balance residual is the turbine power
minus the two pump powers and the 500 bhp auxiliary drive.

## Results

${outsideText}

### Book consistency before any model run

These are arithmetic checks of the printed values. They set the floor below
which a model difference cannot be told apart from the book's own rounding.

| Check | Value | Printed | Difference % |
| --- | --- | --- | --- |
| LOX pump head from the printed pressures [ft] | ${f(headLoxFromP, 0)} | 2930 | ${pct(headLoxFromP, 2930)} |
| Fuel pump head from the printed pressures [ft] | ${f(headFuelFromP, 0)} | 4790 | ${pct(headFuelFromP, 4790)} |
| LOX pump power from flow, rise and efficiency [bhp] | ${f(hpLoxFromP, 0)} | 14850 | ${pct(hpLoxFromP, 14850)} |
| Fuel pump power from flow, rise and efficiency [bhp] | ${f(hpFuelFromP, 0)} | 11790 | ${pct(hpFuelFromP, 11790)} |
| Turbine power from equations 6-18 and 6-19 [bhp] | ${f(turbHpBook, 0)} | 27140 | ${pct(turbHpBook, 27140)} |
| Turbine power from torque and speed [bhp] | ${f(turbHpTorque, 0)} | 27140 | ${pct(turbHpTorque, 27140)} |
| Pump powers plus auxiliary drive [bhp] | 27140 | 27140 | 0.00 |
| Chamber plus gas generator oxidizer plus heat exchanger [lb/s] | ${f(1941 + 26.7 + 3, 1)} | 1971 | ${pct(1941 + 26.7 + 3, 1971)} |
| Chamber plus gas generator fuel [lb/s] | ${f(827 + 65.3, 1)} | 892 | ${pct(827 + 65.3, 892)} |
| Gas generator O/F from the two flows | ${f(26.7 / 65.3, 3)} | 0.408 | ${pct(26.7 / 65.3, 0.408)} |
| cp from the printed R and gamma [Btu/lb F] | ${f(cpFromR, 3)} | 0.653 | ${pct(cpFromR, 0.653)} |
| R from the printed cp and gamma [ft lbf/lb R] | ${f(rFromCp, 1)} | 53.6 | ${pct(rFromCp, 53.6)} |

### Flows

Basis marks how the number is obtained. A sized quantity is reproduced at the
design point by the choice of effective area and moves only through the solve.

${table(rows)}

### Station pressures

${table(stations)}

![Pressure budget from pump discharge to injector end](figures/engine-balance/fig01-pressure-budget.svg)

*Figure 1. Pressure at each station of the main LOX and fuel feed lines. The lines are the book budget and the markers are the model at 7000 rpm. The LOX stations are the pump discharge, line, main valve, torus dome and injector end. The fuel stations are the pump discharge, line, main valve, calibration orifice, jacket and manifold, and injector end.*

### Chamber, turbine pressure ratio and pump heads

${table(chamber)}

The CEA table c* at the solved state is ${f(cstarIdealFt, 0)} ft/s before the efficiency
and the book's implied ideal c* is ${f(cstarBookIdeal, 0)} ft/s. The throat area times the
book Pc over the book flow gives ${f((1000 * 487 * 32.174) / totalFlowBook, 0)} ft/s, which is the book's own
definition of c*. The CEA frozen gamma at the solved state is ${f(base.oxStar.gamma, 3)} and the
chamber temperature from the table is ${f(base.oxStar.T0, 0)} K before the efficiency.

### Power balance

${table(power)}

![Power balance](figures/engine-balance/fig02-power-balance.svg)

*Figure 2. Shaft power of each pump, the auxiliary drive, their sum and the turbine. The book sums to 27140 bhp on both sides. The model at 7000 rpm leaves a residual and the balanced model closes it by shaft speed.*

## Balance closure

The balance residual is the turbine power minus the two pump powers and the
auxiliary drive. At the book hardware and 7000 rpm it is an output. It is
${f(base.residualHp, 1)} bhp or ${f(100 * base.residualFraction, 2)} percent of the turbine power. The turbine
power is ${pct(base.turbineHp, BOOK.turbineHp)} percent from the book and the two pump powers sum to
${pct(base.loxHp + base.fuelHp, BOOK.loxHp + BOOK.fuelHp)} percent from the book. The pump flows are low by ${f(Math.abs(100 * (base.loxPumpMdot / BOOK.loxPumpMdot - 1)), 2)} and
${f(Math.abs(100 * (base.fuelPumpMdot / BOOK.fuelPumpMdot - 1)), 2)} percent (LOX and fuel) and the turbine flow is ${pct(base.turbineMdot, BOOK.turbineMdot)} percent. A likely
cause is the chamber pressure, which is ${pct(base.pc, BOOK.pc)} percent high through the CEA c*, because
it takes part of the injector drop of the main lines and lowers their flow and so the pump
power, while the gas generator branches are fed from the same discharge pressures through
large control drops and their flow is almost unchanged.

The outer iteration on the common shaft speed (secant, ${bal.iterations} evaluations,
${bal.solves} network solves in all) gives the following history.

${histTable(bal.history, "Speed over design")}

The closed solution has a shaft speed of ${f(balM.rpm, 1)} rpm (${pct(balM.rpm, BOOK.rpm)} percent
from 7000), a turbine power of ${f(balM.turbineHp, 0)} bhp (${pct(balM.turbineHp, BOOK.turbineHp)} percent from the book)
and a residual of ${sci(balM.residualHp)} bhp. The residual at convergence is the solved
equation and is not an independent check. The independent outputs of the closure
are the shaft speed and the shifts of the flows and pressures that follow from
it. Because the pump power rises as the cube of the speed and the turbine power
only through the flow, the balance has one root and the secant iteration
reaches it in ${bal.iterations} evaluations.

### Cross-check on the gas generator orifice scale

The second way the book sets the turbine power is the size of the gas generator
control orifices. Holding the shaft at 7000 rpm and scaling the two control
orifice areas by a common factor closes the same residual.

${histTable(alt.history, "Orifice scale")}

The closed scale is ${f(alt.value, 5)}. The turbine power is ${f(altM.turbineHp, 0)} bhp, the
gas generator flow is ${f(altM.turbineMdot, 2)} lb/s, the gas generator pressure is ${f(altM.ggInjectorEnd, 1)} psia and
Pc is ${f(altM.pc, 1)} psia. The two closures give turbine powers that differ by ${f(Math.abs(balM.turbineHp - altM.turbineHp), 0)} bhp and Pc
values that differ by ${f(Math.abs(balM.pc - altM.pc), 1)} psia. The two closures are different
operating points, because the shaft speed moves every flow and the orifice
scale moves only the gas generator.

## Sensitivities

These are reported and not scored. The residual column is the output at 7000
rpm for the same case.

${sensTable}

The pump curve shape moves the solved shaft speed by at most
${f(Math.max(...sens.slice(0, 2).map((s) => Math.abs(s.b.metrics.rpm - balM.rpm))), 1)} rpm because the pumps run near the design point and the shape
matters only through its slope. The gas constant does not change the result, as
expected, because the turbine area is sized with the same value so it cancels in
the choked flow. The balance does not depend on the 4.5 percent
inconsistency in the book's gas table, because the power equation uses cp and
gamma only.

## Disagreements and likely causes

${outsideText}

- **c* and Pc.** The CEA table c* with the 0.975 efficiency convention is ${f(base.cstar, 0)} ft/s
  against the book's 5660, ${pct(base.cstar, BOOK.cstar)} percent. The book's ideal c* implied by its
  efficiency is ${f(cstarBookIdeal, 0)} ft/s and the CEA frozen value is ${f(cstarIdealFt, 0)} ft/s. A likely cause
  is a difference between the thermochemistry behind the book's design value and the
  current CEA equilibrium data. This report does not test that. The flow is set by the feed
  system, so a higher c* shows up as a higher Pc, ${pct(base.pc, BOOK.pc)} percent. The injector end
  pressure at the junction is ${f(base.injectorEnd, 1)} psia against 1095 (${pct(base.injectorEnd, BOOK.injectorEnd)} percent) and the excess
  decays upstream to ${pct(base.lox.pump, 1505)} percent at the LOX pump discharge, because the pump
  curve falls with flow.
- **Station pressures after balancing.** The protocol expected 1.0 percent. The balanced shaft
  speed is ${pct(balM.rpm, BOOK.rpm)} percent from 7000 and the pump rise scales with its square, so
  every station moves up by about ${f(2 * 100 * (balM.rpm / BOOK.rpm - 1), 2)} percent on top of the chamber effect. The
  tolerance of the protocol was too tight for the balanced point and it is kept as written.
- **Main flows.** The chamber flows are low by ${f(Math.abs(100 * (base.mdotOx / BOOK.mdotOx - 1)), 2)} percent
  (LOX) at 7000 rpm because of the higher chamber pressure. The mixture ratio is ${f(base.of, 3)}
  against 2.35.
- **Turbine power.** The turbine power is ${pct(base.turbineHp, BOOK.turbineHp)} percent from the book at 7000
  rpm. The gas generator pressure is ${pct(base.ggInjectorEnd, BOOK.ggInjectorEnd)} percent from 710 psia and the choked turbine flow
  follows it. The turbine power also rests on the book's efficiency, which the book
  itself back-calculated from the same equations, so its agreement is not an
  independent check of the turbine.
- **Pump powers.** The pump powers differ from the book by ${pct(base.loxHp, BOOK.loxHp)} and ${pct(base.fuelHp, BOOK.fuelHp)} percent
  (LOX and fuel), which follows the shift in pump flow and discharge
  pressure. The book's own printed power differs from its pressures and flows by
  ${pct(hpLoxFromP, 14850)} and ${pct(hpFuelFromP, 11790)} percent.

## Limitations

- The case reproduces a design example of a hypothetical engine. It is not a
  measurement and it carries the book's rounding and inconsistencies.
- Flows and station pressures at the design point come from sizing effective
  areas with the book's own values, so their agreement is a bookkeeping check
  of the network. They are not a prediction.
- There is no turbine component. The turbine is a choked orifice and its power
  is post-processed from ideal-gas isentropic enthalpy drop times the book's
  efficiency. The turbine efficiency has no dependence on blade speed ratio or
  pressure ratio, and there is no turbine map.
- There is no shaft speed unknown and no component that couples turbine power
  to pump power. The balance is a script-level secant iteration on the speed
  with an inner root find on the gas generator pressure. A shaft unknown and a
  turbine component would put both loops inside the single Newton solve and
  would remove the post-processing.
- The pump is a Q to dP table. The head-flow shape is a stated quadratic with a
  shut-off ratio of 1.2 and the efficiency is constant. There is no pump map,
  no efficiency curve, no suction performance and no stall.
- The gas generator gas state is imposed. The CEA tables cover O/F 1 to 5 and
  the gas generator runs at 0.408, so no thermochemistry is computed for it.
  NASA CEA gives 1727 F against the book's 1400 F, which the book treats as a
  design value. A fuel-rich gas generator model with its own thermochemistry
  would change the turbine gas properties and the turbine flow with the mixture
  ratio, which here is fixed.
- A node cannot join two unlike fluids outside a reacting junction, so the gas
  generator liquid lines end on boundary nodes and the gas generator pressure is
  closed by the inner loop. A multi-fluid mixing node or a reacting junction with
  a user thermochemistry would make this part of the simultaneous solve.
- The chamber is one node with the book's stagnation loss imposed as a ratio of
  1000/1095 on the throat coefficient, and the CEA table is read at the node
  pressure and not at the nozzle stagnation pressure. The chamber gas is frozen
  downstream of the junction, and the reactants are taken at standard injection
  temperatures by the table. Reactant inlet enthalpy is not a model input.
  Thrust and specific impulse are not compared, because the nozzle has no
  expansion.
- Every restriction is square-law with a constant area. The combustor drop is a
  fixed 70 psi (a scaled drop is in the sensitivities), the jacket is a
  square-law orifice and the heat exchanger is an imposed 3 lb/s.
- The book's gas table is not self-consistent (R and cp differ by
  ${pct(cpFromR, 0.653, 1)} percent), and the torque unit of Table 3-2 is printed in-lb
  while the sample calculation uses ft-lb.
- The auxiliary drive is held at 500 bhp at all speeds.

## Conclusions

A basic balance of the SP-125 A-1 engine runs in the OpenFLUME steady solver
in about ${bal.solves} network solves with a reacting junction chamber, pump
curves, square-law feed lines, a choked throat and a choked turbine orifice with
the book's gas state. The solved pressures and flows reproduce the printed design
point (see the tolerance columns for the items outside the protocol band), and the chamber Pc and c* differ from the book by ${pct(base.pc, BOOK.pc)} and
${pct(base.cstar, BOOK.cstar)} percent through the CEA table. The power balance closes at a shaft
speed of ${f(balM.rpm, 0)} rpm (${pct(balM.rpm, BOOK.rpm)} percent from 7000) by a nested
iteration. What is verified is that the network carries the book's pressure
budgets and that the post-processed power balance of the book's own data is
reproduced to the accuracy shown. What is not verified is any turbomachinery
physics, any measured engine behavior, the gas generator thermochemistry or a
simultaneous pump and turbine solve. A total of ${innerSolveCount} network solves went into this report.

## References

1. Huzel, D. K. and Huang, D. H., *Design of Liquid-Propellant Rocket
   Engines*, NASA SP-125, second edition, 1971 (NTRS 19710019929).
`;

writeFileSync(REPORT, report);
console.log(`wrote ${REPORT} and 2 figures`);
