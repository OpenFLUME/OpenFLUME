/**
 * benchmarks-report.ts — generates the code-to-code benchmark report
 * (docs/validation/benchmarks-report.md): for every benchmark of user-manual
 * §8.3, the reference TYPE (published GFSSP or SINDA/FLUINT output, an
 * analytic solution, ε-NTU, an independent Runge–Kutta integration), the
 * ACHIEVED error of the current solver, and the CI gate.  The gates live in
 * src/ui/tests/gfssp-benchmarks.test.ts, leeMartin.test.ts,
 * lh2StorageTank.test.ts and nureth.test.ts; those tests log the same
 * achieved values.  The gates are pass bands, not measured agreement — this
 * report is where the measured agreement is stated.
 *
 * All numbers come from live solves — rerun after solver changes:
 *
 *   npx tsx scripts/benchmarks-report.ts
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  componentPressureDrop,
  initRealFluids,
  solveSteady,
  solveTransient,
  type NetworkConfig,
} from "../src/core";
import { Pipe, Valve } from "../src/core/components";
import {
  buildLeeMartin,
  gfsspEx13ConductionRod,
  gfsspEx5WaterWaterHX,
  gfsspN2N2CounterflowHX,
  lh2StorageTankNoVentFill,
} from "../src/ui/examples";

const last = <T>(a: T[]): T => a[a.length - 1];
const pct = (x: number, d = 2) =>
  `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)} %`;
const kDiff = (x: number, d = 2) =>
  `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)} K`;

await initRealFluids();
console.log("Generating code-to-code benchmark report…");

interface Row {
  benchmark: string;
  quantity: string;
  refType: string;
  reference: string;
  achieved: string;
  gate: string;
}
const rows: Row[] = [];

/* ==========================================================================
 * A — GFSSP Example 13: conduction rod with convection (analytic reference)
 * ========================================================================== */
{
  const res = solveTransient(gfsspEx13ConductionRod);
  if (!res.converged) throw new Error("Benchmark A did not converge");
  const analyticalT = (xFt: number) => {
    const TF =
      70 + 4.653 * Math.exp(1.714 * xFt) - 42.65 * Math.exp(-1.714 * xFt);
    return ((TF - 32) * 5) / 9 + 273.15;
  };
  const L = 0.6096;
  const devs = [0, 1, 2, 3, 4].map((i) => {
    const xFt = ((i + 0.5) * L) / 5 / 0.3048;
    return last(res.solidNodes![`s${i}`].temperature) - analyticalT(xFt);
  });
  const k = 16.27;
  const A = 2.028e-3;
  const conv = (f: number) => (f * 5) / 9 / 0.3048;
  const qColdAna = k * A * conv(81.08);
  const qHotAna = k * A * conv(248.2);
  const qCold = -last(res.conductors!["c_cold_s0"].heatRate);
  const qHot = -last(res.conductors!["c_s4_hot"].heatRate);
  let qConv = 0;
  for (let i = 0; i < 5; i++)
    qConv += last(res.conductors![`c_s${i}_air`].heatRate);
  const imbalance = Math.abs(qHot - (qCold + qConv)) / qHot;
  const worst = devs.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
  const B = "A. GFSSP Example 13, conduction rod with convection";
  rows.push(
    {
      benchmark: B,
      quantity: "Solid temperatures, 5 nodes",
      refType: "Analytic (fin solution)",
      reference: "T(x) of the Example 13 fin equation",
      achieved: `largest deviation ${Math.abs(worst).toFixed(2)} K (${devs.map((d) => kDiff(d)).join(", ")})`,
      gate: "3.0 K",
    },
    {
      benchmark: B,
      quantity: "End conduction heat flows",
      refType: "Analytic (fin solution)",
      reference: "−kA dT/dx at the ends",
      achieved: `cold end ${pct(Math.abs(qCold) / qColdAna - 1)}, hot end ${pct(Math.abs(qHot) / qHotAna - 1)}`,
      gate: "7 %",
    },
    {
      benchmark: B,
      quantity: "Global energy balance",
      refType: "Conservation",
      reference: "Q_hot = Q_cold + Q_conv",
      achieved: `${(imbalance * 100).toFixed(2)} %`,
      gate: "0.5 %",
    },
  );
}

/* ==========================================================================
 * B — N2–N2 counterflow heat exchanger (ε-NTU duty, GFSSP outlet temperatures)
 * ========================================================================== */
{
  const res = solveTransient(gfsspN2N2CounterflowHX);
  if (!res.converged) throw new Error("Benchmark B did not converge");
  const cp = 1040;
  const [mh, mc, ThIn, TcIn] = [1.175, 1.193, 394.26, 294.26];
  const Th = last(res.nodes["h5"].temperature);
  const Tc = last(res.nodes["c1"].temperature);
  const Q = mh * cp * (ThIn - Th);
  const Ai = (Math.PI * 0.0508 * 0.6096) / 5;
  const Ao = (Math.PI * 0.05715 * 0.6096) / 5;
  const UA = 5 / (1 / (970 * Ai) + 1 / (1250 * Ao));
  const Cmin = Math.min(mh, mc) * cp;
  const Cr = Cmin / (Math.max(mh, mc) * cp);
  const NTU = UA / Cmin;
  const eps =
    (1 - Math.exp(-NTU * (1 - Cr))) / (1 - Cr * Math.exp(-NTU * (1 - Cr)));
  const Qntu = eps * Cmin * (ThIn - TcIn);
  const Qc = mc * cp * (Tc - TcIn);
  const B = "B. N₂–N₂ counterflow heat exchanger";
  rows.push(
    {
      benchmark: B,
      quantity: "Duty",
      refType: "Analytic (ε-NTU)",
      reference: `${(Qntu / 1000).toFixed(2)} kW`,
      achieved: `${(Q / 1000).toFixed(2)} kW (${pct(Q / Qntu - 1)})`,
      gate: "5 %",
    },
    {
      benchmark: B,
      quantity: "Hot / cold outlet temperature",
      refType: "GFSSP output",
      reference: "390.3 K / 298.2 K",
      achieved: `${Th.toFixed(2)} K (${kDiff(Th - 390.3)}) / ${Tc.toFixed(2)} K (${kDiff(Tc - 298.2)})`,
      gate: "2.5 K",
    },
    {
      benchmark: B,
      quantity: "Hot/cold duty balance",
      refType: "Conservation",
      reference: "Q_hot = Q_cold",
      achieved: `${((Math.abs(Q - Qc) / Math.max(Q, Qc)) * 100).toFixed(3)} %`,
      gate: "1 %",
    },
  );
}

/* ==========================================================================
 * C — GFSSP Example 5: water–water counterflow heat exchanger (GFSSP output)
 * ========================================================================== */
{
  const cfg: NetworkConfig = JSON.parse(JSON.stringify(gfsspEx5WaterWaterHX));
  cfg.settings = { ...cfg.settings, mode: "steady" };
  const res = solveSteady(cfg);
  if (!res.converged) throw new Error("Benchmark C did not converge");
  const Th = res.nodes["h12"].temperature;
  const Tc = res.nodes["c1"].temperature;
  const Q = 0.4014 * 4182 * (310.93 - Th);
  const B = "C. GFSSP Example 5, water–water heat exchanger";
  rows.push(
    {
      benchmark: B,
      quantity: "Hot outlet temperature",
      refType: "GFSSP output",
      reference: "295.67 K",
      achieved: `${Th.toFixed(2)} K (${kDiff(Th - 295.67)})`,
      gate: "1.0 K",
    },
    {
      benchmark: B,
      quantity: "Cold outlet temperature",
      refType: "GFSSP output",
      reference: "290.94 K",
      achieved: `${Tc.toFixed(2)} K (${kDiff(Tc - 290.94)})`,
      gate: "0.5 K",
    },
    {
      benchmark: B,
      quantity: "Duty",
      refType: "GFSSP output",
      reference: "25.6 kW",
      achieved: `${(Q / 1000).toFixed(2)} kW (${pct(Q / 25600 - 1)})`,
      gate: "3 %",
    },
  );
}

/* ==========================================================================
 * D — Lee & Martin entrapped air (GFSSP figure; independent RK4 column)
 * ========================================================================== */
function findPeaks(a: number[]): number[] {
  const idx: number[] = [];
  for (let i = 1; i < a.length - 1; i++)
    if (a[i] > a[i - 1] && a[i] > a[i + 1] && a[i] > 0) idx.push(i);
  return idx;
}
{
  const cfg = buildLeeMartin();
  const dt = cfg.settings.dt!;
  const res = solveTransient(cfg);
  if (!res.converged) throw new Error("Benchmark D did not converge");
  const P = res.nodes["12"].pressure;
  const pk = findPeaks(P);
  const first = P[pk[0]] / 1e6;
  const periods = pk.slice(1).map((k, i) => (k - pk[i]) * dt);

  // Independent rigid-column RK4 at a refined solver step (as in
  // leeMartin.test.ts): one pipe of 10 × segment length, the valve ramp,
  // and the polytropic gas cushion.
  const solverDt = 0.003;
  const cfgF = buildLeeMartin({ dt: solverDt, endTime: 4 });
  const resF = solveTransient(cfgF);
  const node12 = cfgF.nodes.find((n) => n.id === "12")!;
  const n = node12.gasCushion!.polytropicIndex;
  const Vg0 = node12.gasCushion!.initialGasVolume;
  const Vtot = node12.volume as number;
  const P0 = node12.pressure!;
  const PR = cfgF.nodes.find((x) => x.id === "1")!.pressure!;
  const D = 0.026035;
  const A = (Math.PI / 4) * D * D;
  const Ltot = 10 * 0.6096;
  const Cg = P0 * Math.pow(Vg0, n);
  const pipe = new Pipe(Ltot, D, 1.5e-6, 0);
  const valve = new Valve(A, 0.6, 0, [
    [0, 0],
    [0.15, 0],
    [0.4, 1],
  ]);
  const f = (t: number, y: number[]): number[] => {
    if (valve.getPosition(t) <= 0) return [0, 0];
    const Pg = Cg / Math.pow(Vtot - y[1], n);
    const dP =
      componentPressureDrop(y[0], 998, 1e-3, pipe, t) +
      componentPressureDrop(y[0], 998, 1e-3, valve, t);
    return [(A / Ltot) * (PR - dP - Pg), y[0] / 998];
  };
  const h = 0.001;
  let y = [0, Vtot - Vg0];
  const Prk: number[] = [P0];
  for (let s = 1; s <= Math.round(4 / h); s++) {
    const t = (s - 1) * h;
    const k1 = f(t, y);
    const k2 = f(
      t + h / 2,
      y.map((v, j) => v + (h / 2) * k1[j]),
    );
    const k3 = f(
      t + h / 2,
      y.map((v, j) => v + (h / 2) * k2[j]),
    );
    const k4 = f(
      t + h,
      y.map((v, j) => v + h * k3[j]),
    );
    y = y.map((v, j) => v + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    Prk.push(Cg / Math.pow(Vtot - y[1], n));
  }
  const PF = resF.nodes["12"].pressure;
  const pS = findPeaks(PF);
  const pR = findPeaks(Prk);
  const ampErr = PF[pS[0]] / Prk[pR[0]] - 1;
  const tErr = (pS[0] * solverDt) / (pR[0] * h) - 1;
  const perErr = ((pS[1] - pS[0]) * solverDt) / ((pR[1] - pR[0]) * h) - 1;
  const B = "D. Lee & Martin entrapped air";
  rows.push(
    {
      benchmark: B,
      quantity: "First pressure peak (Δt = 0.01 s)",
      refType: "GFSSP output (figure)",
      reference: "≈ 1.90 MPa",
      achieved: `${first.toFixed(3)} MPa (${pct(first / 1.9 - 1, 1)}) at t = ${(pk[0] * dt).toFixed(2)} s`,
      gate: "±15 %; peak at 0.6–0.9 s",
    },
    {
      benchmark: B,
      quantity: "Oscillation period (Δt = 0.01 s)",
      refType: "GFSSP output (figure)",
      reference: "≈ 0.55–0.60 s",
      achieved: `${Math.min(...periods).toFixed(2)}–${Math.max(...periods).toFixed(2)} s`,
      gate: "0.5–0.65 s",
    },
    {
      benchmark: B,
      quantity: "First peak, its time, first period (Δt = 0.003 s)",
      refType: "Independent RK4 (same lumped ODE)",
      reference: "RK4, h = 1 ms",
      achieved: `${pct(ampErr, 1)}, ${pct(tErr, 1)}, ${pct(perErr, 1)}`,
      gate: "8 % each",
    },
  );
}

/* ==========================================================================
 * E — SINDA/FLUINT Sample F: LH2 no-vent fill (SINDA/FLUINT output, emulated)
 * ========================================================================== */
{
  const PSI = 6894.757293168;
  const RANK = 5 / 9;
  const LBM_HR = 0.45359237 / 3600;
  const res = solveTransient(lh2StorageTankNoVentFill);
  if (!res.converged) throw new Error("Benchmark E did not converge");
  const g = res.finalRegisters!;
  const B =
    "E. SINDA/FLUINT Sample F, LH₂ no-vent fill (emulated with logic rules)";
  const q = (
    quantity: string,
    model: number,
    deck: number,
    unit: string,
    d: number,
    gate: string,
  ) =>
    rows.push({
      benchmark: B,
      quantity,
      refType: "SINDA/FLUINT output",
      reference: `${deck.toFixed(d)} ${unit}`.trim(),
      achieved:
        `${model.toFixed(d)} ${unit} (${pct(model / deck - 1, 1)})`.replace(
          "  ",
          " ",
        ),
      gate,
    });
  q("Fill fraction at 15 min", g.fillFrac, 0.739, "", 3, "5 %");
  q("Tank pressure at 15 min", g.Ptank / PSI, 59.721, "psia", 2, "0.5 %");
  q("Vapor temperature at 15 min", g.TV / RANK, 47.387, "R", 2, "5 %");
  q("Liquid temperature at 15 min", g.TL / RANK, 38.098, "R", 2, "5 %");
  q("TVS vent flow at 15 min", g.mdotTvs / LBM_HR, 0.0522, "lbm/hr", 4, "5 %");
}

/* ==========================================================================
 * Report
 * ========================================================================== */
const table = rows
  .map(
    (r) =>
      `| ${r.benchmark} | ${r.quantity} | ${r.refType} | ${r.reference} | ${r.achieved} | ${r.gate} |`,
  )
  .join("\n");

const report = `# Code-to-Code Benchmarks of OpenFLUME

**Achieved agreement with published GFSSP and SINDA/FLUINT results, and with the analytic references used alongside them**

Generated by \`scripts/benchmarks-report.ts\`. All model numbers come from
live solves of the current solver. The CI gates are in
\`src/ui/tests/gfssp-benchmarks.test.ts\` (A–C), \`leeMartin.test.ts\` (D),
\`lh2StorageTank.test.ts\` (E) and \`nureth.test.ts\` (F); those tests log the
same achieved values.

## Abstract

User manual §8.3 lists six benchmarks against other codes. A gate is a pass
band that a CI test enforces, not a measured agreement, so this report states
for every gated quantity the reference it is compared with, the type of that
reference, the error the current solver achieves, and the gate. The types
matter: Benchmark A is gated against an analytic solution and is analytic
verification, not code-to-code. Benchmark B's duty is gated against ε-NTU;
only its outlet temperatures are published GFSSP output. Benchmark C compares
with GFSSP's published output, Benchmark D with a GFSSP figure and an
independent Runge–Kutta integration of the same lumped model, and Benchmark E
with SINDA/FLUINT's published sample-problem output. Benchmark E is reproduced
only through an emulation built from registers, logic rules, and
boundary-node controllers (user manual §3.8), not by the core formulation.
Benchmark F reproduces published trends only and carries no error figure.

## Reference types

| Type | Meaning |
| ---- | ------- |
| GFSSP output | A value GFSSP published for the same problem; agreement inherits GFSSP's assumptions |
| SINDA/FLUINT output | A value from the SINDA/FLUINT sample-problem deck |
| Analytic | A closed-form solution of the modeled equations (verification, not code-to-code) |
| ε-NTU | The effectiveness–NTU closed form for the modeled exchanger (analytic) |
| Independent RK4 | A separate Runge–Kutta integration of the same lumped equations |
| Conservation | An internal balance; checks the solve, not the agreement |

## Results

| Benchmark | Quantity | Reference type | Reference value | OpenFLUME (achieved) | Gate |
| --------- | -------- | -------------- | --------------- | -------------------- | ---- |
${table}
| F. NURETH-16 gas-cooled reactor loop | Natural-circulation trends | Published trends | — | Trends reproduced (see \`nureth.test.ts\`); geometry is representative | Qualitative |

Notes:

- **A** is analytic verification: GFSSP Example 13's own documentation
  compares with the same fin solution. It is listed here because the
  problem is a GFSSP example.
- **B**: the loop pressure is raised to 2.0 MPa from the published schematic
  (whose flow rates at 1 atm give about 500 m/s); see the example's source
  comment.
- **D**: the default polytropic index of the gas cushion, 1.03, was chosen to
  recover the published first-peak amplitude and period at the default step
  (\`buildLeeMartin\` in \`src/ui/examples.ts\`), so the GFSSP-figure rows are
  partly calibrated. The RK4 rows are not.
- **E** is emulated: FLUINT's twinned tanks and moveable ties are reproduced
  with registers, logic rules, and boundary-node controllers
  (\`src/ui/lh2StorageTank.ts\` lists what is emulated and what is not).
  All five deck quantities are shown.
- **F** has no quantitative reference: the paper's geometry tables are not
  available, so the model is representative and only the published trends
  are checked.

## References

1. Majumdar, A. K., LeClair, A. C., and Moore, R., *Generalized Fluid System
   Simulation Program, Version 6.0*, NASA/TM-2013-217492, §6.13 (Example 13,
   which is Example 11, §5.11 of the Version 5 Educational manual,
   NASA/TM-2011-216470); and Majumdar, TFAWS 2004.
2. Majumdar, A. K., and LeClair, A. C., JANNAF 2024 conjugate heat-exchanger
   paper, as cited in user manual §8.3 (Benchmark B).
3. GFSSP Version 5 user manual, Example 5 (water–water heat exchanger), via
   Patel 2011, as cited in \`src/ui/tests/gfssp-benchmarks.test.ts\`.
4. Lee & Martin entrapped-air problem: GFSSP Figure 10 as cited in user
   manual §8.3; the example source cites Majumdar et al., AIAA 2015-3850,
   Fig. 11.
5. C&R Technologies, *SINDA/FLUINT Sample Problems*, Sample Problem F
   ("LH2 storage tank with internal HX and vapor cooled shield"), modeling
   Anderson, J. E., et al., "Evaluation of Long-term Cryogenic Storage
   System," Cryogenic Engineering Conference, 1989.
6. Williams, W. C., and McLean, J., "Using NASA's GFSSP Code for Steady
   State and Transient Modeling of Gas Cooled Reactor Passive Safety
   Systems," NURETH-16, Chicago, 2015, paper 13066.
`;

writeFileSync(
  join(process.cwd(), "docs", "validation", "benchmarks-report.md"),
  report,
);
console.log("wrote docs/validation/benchmarks-report.md");
