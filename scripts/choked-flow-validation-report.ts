/**
 * choked-flow-validation-report.ts — generates the choked cryogenic flow and
 * cavitating-venturi validation report (docs/validation/choked-flow-report.md)
 * and its SVG figures (docs/validation/figures/choked-flow/).
 *
 * Part A compares OpenFLUME's restriction closures with the maximum mass
 * flux of nitrogen and methane through four converging–diverging nozzles
 * (Simoneau & Hendricks, NASA TP-1484, 1979) and of nitrogen through a
 * sharp-edged orifice (Simoneau, NASA TM X-71760, 1975).  Part B checks the
 * cavitating-venturi closure's throat-pressure assumption against Hord's
 * liquid-hydrogen venturi cavity measurements (NASA CR-2054, 1972).  Cases,
 * transcription QC and models are defined once in
 * src/validation/chokedFlow.ts and src/validation/cavitationHord.ts and
 * gated by src/validation/__tests__/chokedFlow.test.ts and
 * cavitationHord.test.ts.
 *
 * All numbers and figures come from live solves — rerun after solver changes:
 *
 *   npx tsx scripts/choked-flow-validation-report.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  expansibilityY,
  initRealFluids,
  orificeKappa,
  RealFluid,
} from "../src/core";
import {
  CD_NOZZLE,
  CD_SHARP_ORIFICE,
  INLET_REGIMES,
  nozzlePoints,
  orificePoints,
  predict,
  ratioStats,
  type ChokedFlowResult,
  type InletRegime,
} from "../src/validation/chokedFlow";
import { evaluateHord, hordRuns } from "../src/validation/cavitationHord";
import { C, lineChart, type Series } from "./lib/report-charts";

const pct = (x: number, d = 1) =>
  `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)} %`;
const f3 = (x: number) => x.toFixed(3);

/* ==========================================================================
 * Output plumbing
 * ========================================================================== */

const outDir = join(process.cwd(), "docs", "validation");
const figDir = join(outDir, "figures", "choked-flow");
mkdirSync(figDir, { recursive: true });
const figures: string[] = [];
function writeFig(n: number, name: string, svg: string): void {
  const file = `fig${String(n).padStart(2, "0")}-${name}.svg`;
  writeFileSync(join(figDir, file), svg);
  figures[n] = file;
  console.log(`  wrote figures/choked-flow/${file}`);
}
const fig = (n: number, caption: string) =>
  `![Figure ${n}](figures/choked-flow/${figures[n]})\n\n*Figure ${n}. ${caption}*`;

/* ==========================================================================
 * Part A — solves
 * ========================================================================== */

await initRealFluids();
console.log("Generating choked-flow validation report…");
const n2 = new RealFluid("Nitrogen");
const ch4 = new RealFluid("Methane");
const fluidOf = (name: string) => (name === "Methane" ? ch4 : n2);

const nozRows = nozzlePoints();
const oriRows = orificePoints();
const nozUsable = nozRows.filter((p) => p.usable);
const oriUsable = oriRows.filter((p) => p.usable);

const nozzle = nozUsable.map((p) => predict(p));
const oriAtPb = oriUsable.map((p) => predict(p, "orifice at measured Pb"));
const oriChoked = oriUsable.map((p) => predict(p));
const allConverged = [...nozzle, ...oriAtPb, ...oriChoked].every(
  (r) => r.converged,
);
console.log(
  `  nozzle points ${nozzle.length}/${nozRows.length}, orifice points ${oriUsable.length}/${oriRows.length}, all converged: ${allConverged}`,
);

const ratio = (r: ChokedFlowResult) => r.Gmodel / r.point.G;
const hemRatio = (r: ChokedFlowResult) => r.Ghem / r.point.G;
const pvOverP0 = (r: ChokedFlowResult) =>
  r.point.T0 < fluidOf(r.point.fluid).criticalTemperature()
    ? fluidOf(r.point.fluid).saturationPressure(r.point.T0) / r.point.P0
    : NaN;
const Tr = (r: ChokedFlowResult) =>
  r.point.T0 / fluidOf(r.point.fluid).criticalTemperature();

const regimeStats = (rs: ChokedFlowResult[], reg: InletRegime) => {
  const sel = rs.filter((r) => r.regime === reg);
  return {
    model: ratioStats(sel.map(ratio)),
    hem: ratioStats(sel.map(hemRatio)),
  };
};

/* Exclusion reasons, grouped. */
function reasonKey(s: string): string {
  if (s.startsWith("row flagged"))
    return "row flagged by the digitizer (fit failed / fields blank in report)";
  if (/flagged (ocr|fused|unparsed|ditto|ditto_arrow|dash)/.test(s))
    return "T0, P0 or G flagged OCR-uncertain, fused, unparsed or ditto";
  if (/flagged missing|blank/.test(s)) return "T0, P0, G (or Pb, T_b) blank";
  if (s.startsWith("tabulated Psat"))
    return "tabulated P_v(T0) disagrees with CoolProp by > 5 %";
  if (s.startsWith("Tb "))
    return "back temperature ≠ T_sat(P_b) ± 1.5 K (column shift)";
  if (s.startsWith("tabulated Cd"))
    return "tabulated C_d ≠ G/√(2ρ0(P0 − P_b)) ± 3 %";
  return s;
}
function exclusionTable(rows: typeof nozRows): string {
  const counts = new Map<string, number>();
  for (const p of rows) {
    if (p.usable) continue;
    // Count each row once, under its first reason.
    const k = reasonKey(p.excluded[0]);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `| ${k} | ${v} |`)
    .join("\n");
}

/* Per-geometry table. */
const GEOMS = [
  ["7° conical nozzle", "Nitrogen"],
  ["3.5° conical nozzle", "Nitrogen"],
  ["elliptical nozzle", "Nitrogen"],
  ["2-D nozzle", "Nitrogen"],
  ["elliptical nozzle", "Methane"],
] as const;
const geomRows = GEOMS.flatMap(([g, f]) =>
  INLET_REGIMES.map((reg) => {
    const sel = nozzle.filter(
      (r) => r.point.geometry === g && r.point.fluid === f && r.regime === reg,
    );
    const m = ratioStats(sel.map(ratio));
    const h = ratioStats(sel.map(hemRatio));
    if (!m || !h) return "";
    return `| ${g} | ${f === "Methane" ? "CH₄" : "N₂"} | ${reg} | ${sel[0].closure} | ${m.n} | ${f3(m.median)} | ${f3(m.min)}–${f3(m.max)} | ${f3(h.median)} | ${f3(h.min)}–${f3(h.max)} |`;
  }).filter(Boolean),
).join("\n");

const summaryRow = (
  label: string,
  rs: ChokedFlowResult[],
  reg: InletRegime,
) => {
  const { model, hem } = regimeStats(rs, reg);
  if (!model || !hem) return "";
  const closure = rs.find((r) => r.regime === reg)!.closure;
  return `| ${label} | ${reg} | ${closure} | ${model.n} | ${f3(model.median)} | ${f3(model.min)}–${f3(model.max)} | ${(model.meanAbsDev * 100).toFixed(1)} % | ${f3(hem.median)} | ${f3(hem.min)}–${f3(hem.max)} |`;
};
const nozzleSummary = INLET_REGIMES.map((reg) =>
  summaryRow("Nozzles (all four)", nozzle, reg),
)
  .filter(Boolean)
  .join("\n");
const orificeSummary = [
  ...INLET_REGIMES.map((reg) =>
    summaryRow("Sharp-edged orifice", oriAtPb, reg),
  ),
  ...INLET_REGIMES.map((reg) =>
    summaryRow("Sharp-edged orifice", oriChoked, reg),
  ),
]
  .filter(Boolean)
  .join("\n");

const S = (rs: ChokedFlowResult[], reg: InletRegime) => regimeStats(rs, reg);
const subN = S(nozzle, INLET_REGIMES[0]);
const satN = S(nozzle, INLET_REGIMES[1]);
const supN = S(nozzle, INLET_REGIMES[2]);
const gasN = S(nozzle, INLET_REGIMES[3]);
const subO = S(oriAtPb, INLET_REGIMES[0]);
const satO = S(oriAtPb, INLET_REGIMES[1]);
const subOc = S(oriChoked, INLET_REGIMES[0]);
const satOc = S(oriChoked, INLET_REGIMES[1]);

/* Where in the near-saturated band the large errors sit. */
const nearSat = nozzle.filter((r) => r.regime === INLET_REGIMES[1]);
const nearSatClose = nearSat.filter((r) => pvOverP0(r) > 0.9);
const nearSatFar = nearSat.filter((r) => pvOverP0(r) <= 0.9);
const closeStats = ratioStats(nearSatClose.map(ratio))!;
const farStats = ratioStats(nearSatFar.map(ratio))!;
const closeHem = ratioStats(nearSatClose.map(hemRatio))!;

/* Tabulated discharge coefficients of the usable orifice rows. */
const cdRange = (() => {
  const cds = oriUsable.map(
    (p) => p.G / Math.sqrt(2 * n2.density(p.P0, p.T0) * (p.P0 - (p.Pb ?? NaN))),
  );
  return { min: Math.min(...cds), max: Math.max(...cds) };
})();

/* Expansibility factor the orifice closure applies at each usable orifice
 * point (κ = c²ρ/P at the inlet, r = P_b/P0). */
const oriY = oriUsable.map((p) => {
  const rho = n2.density(p.P0, p.T0);
  return {
    T0: p.T0,
    Y: expansibilityY(p.Pb! / p.P0, orificeKappa(n2, p.P0, p.T0, rho)),
  };
});
const yCold = oriY.filter((y) => y.T0 < 112).map((y) => y.Y);
const yWarm = oriY.filter((y) => y.T0 >= 112).map((y) => y.Y);

/* ==========================================================================
 * Part B — Hord venturi
 * ========================================================================== */

const hord = hordRuns().map(evaluateHord);
const hordConverged = hord.every((r) => r.converged);
const pvErr = hord.map((r) => Math.abs(r.pv - r.run.pvTab) / r.run.pvTab);
const depressionC = hord.map((r) => (r.pv - r.pC) / r.pv);
const depressionMin = hord.map((r) => (r.pv - r.pMin) / r.pv);
const gRatio = hord.map((r) => r.Gclosure / r.GatPc);
const port2Sat = hord.map((r) => r.portSaturationRatios[0]);
const downstreamSat = hord.flatMap((r) => r.portSaturationRatios.slice(3));
const minMax = (xs: number[]) => ({
  min: Math.min(...xs),
  max: Math.max(...xs),
});
console.log(
  `  Hord: ${hord.length} runs, converged ${hordConverged}, closure/G(p_c) ${f3(minMax(gRatio).min)}–${f3(minMax(gRatio).max)}`,
);

/* ==========================================================================
 * Figures
 * ========================================================================== */

const liquidNoz = nozzle.filter(
  (r) => r.regime === INLET_REGIMES[0] || r.regime === INLET_REGIMES[1],
);
writeFig(
  1,
  "nozzle-liquid-ratio",
  lineChart({
    title: "Nozzles, liquid inlets: predicted / measured mass flux",
    xLabel: "Inlet saturation ratio Pv(T₀)/P₀",
    yLabel: "G (model) / G (measured)",
    legend: "bottom-left",
    xRange: [0, 1],
    yRange: [0, 1.4],
    series: [
      {
        label: "y = 1",
        pts: [
          [0, 1],
          [1, 1],
        ],
        color: C.ref,
        mode: "line",
      },
      {
        label: "HEM reference",
        pts: liquidNoz.map((r): [number, number] => [pvOverP0(r), hemRatio(r)]),
        color: C.orange,
        mode: "markers",
        marker: "triangle",
      },
      {
        label: "OpenFLUME cavitatingVenturi (choked, Cd = 1)",
        pts: liquidNoz.map((r): [number, number] => [pvOverP0(r), ratio(r)]),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
      {
        label: "P₀/Pv = 2 regime boundary",
        pts: [
          [0.5, 0],
          [0.5, 1.4],
        ],
        color: C.grey,
        mode: "line",
        dash: "4 4",
      },
    ],
  }),
);

const hotNoz = nozzle.filter(
  (r) => r.regime === INLET_REGIMES[2] || r.regime === INLET_REGIMES[3],
);
writeFig(
  2,
  "nozzle-supercritical-ratio",
  lineChart({
    title: "Nozzles, supercritical and gaseous inlets",
    xLabel: "Reduced stagnation temperature T₀/Tc",
    yLabel: "G (model) / G (measured)",
    legend: "top-right",
    yRange: [0.8, 1.8],
    series: [
      {
        label: "y = 1",
        pts: [
          [Math.min(...hotNoz.map(Tr)), 1],
          [Math.max(...hotNoz.map(Tr)), 1],
        ],
        color: C.ref,
        mode: "line",
      },
      {
        label: "OpenFLUME orifice (κ = c²ρ/P, Cd = 1)",
        pts: hotNoz.map((r): [number, number] => [Tr(r), ratio(r)]),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
      {
        label: "HEM reference",
        pts: hotNoz.map((r): [number, number] => [Tr(r), hemRatio(r)]),
        color: C.orange,
        mode: "markers",
        marker: "triangle",
      },
    ],
  }),
);

const Gmax =
  Math.max(...nozzle.map((r) => Math.max(r.point.G, r.Gmodel))) / 1e3;
const parityColors = [C.blue, C.red, C.green, C.orange];
const parityMarkers = ["circle", "square", "triangle", "diamond"] as const;
writeFig(
  3,
  "nozzle-parity",
  lineChart({
    title: "Nozzles: OpenFLUME against measured maximum mass flux",
    xLabel: "Measured G [10³ kg/(m²·s)]",
    yLabel: "OpenFLUME G [10³ kg/(m²·s)]",
    legend: "outside-right",
    xRange: [0, Math.ceil(Gmax / 10) * 10],
    yRange: [0, Math.ceil(Gmax / 10) * 10],
    series: [
      {
        label: "y = x",
        pts: [
          [0, 0],
          [Math.ceil(Gmax / 10) * 10, Math.ceil(Gmax / 10) * 10],
        ],
        color: C.ref,
        mode: "line",
      },
      {
        label: "±10 %",
        pts: [
          [0, 0],
          [Math.ceil(Gmax / 10) * 10, 1.1 * Math.ceil(Gmax / 10) * 10],
        ],
        color: C.grey,
        mode: "line",
        dash: "4 4",
      },
      {
        label: "",
        pts: [
          [0, 0],
          [Math.ceil(Gmax / 10) * 10, 0.9 * Math.ceil(Gmax / 10) * 10],
        ],
        color: C.grey,
        mode: "line",
        dash: "4 4",
      },
      ...INLET_REGIMES.map((reg, i): Series => ({
        label: reg,
        pts: nozzle
          .filter((r) => r.regime === reg)
          .map((r): [number, number] => [r.point.G / 1e3, r.Gmodel / 1e3]),
        color: parityColors[i],
        mode: "markers",
        marker: parityMarkers[i],
      })),
    ],
  }),
);

writeFig(
  4,
  "orifice-ratio",
  lineChart({
    title: "Sharp-edged orifice (Cd = 0.61): predicted / measured",
    xLabel: "Inlet saturation ratio Pv(T₀)/P₀",
    yLabel: "G (model) / G (measured)",
    legend: "bottom-left",
    xRange: [0, 1],
    yRange: [0, 1.4],
    series: [
      {
        label: "y = 1",
        pts: [
          [0, 1],
          [1, 1],
        ],
        color: C.ref,
        mode: "line",
      },
      {
        label: "orifice at measured Pb",
        pts: oriAtPb.map((r): [number, number] => [pvOverP0(r), ratio(r)]),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
      {
        label: "cavitatingVenturi (choked at Pv)",
        pts: oriChoked.map((r): [number, number] => [pvOverP0(r), ratio(r)]),
        color: C.red,
        mode: "markers",
        marker: "square",
      },
      {
        label: "HEM × Cd",
        pts: oriAtPb.map((r): [number, number] => [pvOverP0(r), hemRatio(r)]),
        color: C.orange,
        mode: "markers",
        marker: "triangle",
      },
    ],
  }),
);

writeFig(
  5,
  "hord-cavity-pressure",
  lineChart({
    title: "Hord LH₂ venturi: cavity pressure against Pv(T₀)",
    xLabel: "Inlet temperature T₀ [K]",
    yLabel: "Pressure [kPa]",
    legend: "top-left",
    series: [
      {
        label: "Pv(T₀), OpenFLUME (closure throat pressure)",
        pts: hord
          .map((r): [number, number] => [r.run.T0, r.pv / 1e3])
          .sort((a, b) => a[0] - b[0]),
        color: C.ref,
        mode: "line",
      },
      {
        label: "Pv(T₀), tabulated",
        pts: hord.map((r): [number, number] => [r.run.T0, r.run.pvTab / 1e3]),
        color: C.ref,
        mode: "markers",
        marker: "diamond",
      },
      {
        label: "measured leading-edge cavity pressure pc",
        pts: hord.map((r): [number, number] => [r.run.T0, r.pC / 1e3]),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
      {
        label: "measured minimum cavity pressure",
        pts: hord.map((r): [number, number] => [r.run.T0, r.pMin / 1e3]),
        color: C.red,
        mode: "markers",
        marker: "square",
      },
    ],
  }),
);

/* ==========================================================================
 * Report markdown
 * ========================================================================== */

const tcN2 = n2.criticalTemperature();
const pcN2 = n2.criticalPressure();
const tcCH4 = ch4.criticalTemperature();
const nozzleSources = [
  ["7° conical", "VI"],
  ["3.5° conical", "VII"],
  ["2-D", "VIII"],
  ["elliptical (N₂)", "IX"],
  ["elliptical (CH₄)", "X"],
];
const perTable = [
  "Simoneau & Hendricks 1979, Table VI",
  "Simoneau & Hendricks 1979, Table VII",
  "Simoneau & Hendricks 1979, Table VIII",
  "Simoneau & Hendricks 1979, Table IX",
  "Simoneau & Hendricks 1979, Table X",
]
  .map((src, i) => {
    const rows = nozRows.filter((p) => p.source === src);
    return `| ${nozzleSources[i][0]} nozzle | TP-1484 Table ${nozzleSources[i][1]} | ${rows.length} | ${rows.filter((p) => p.usable).length} |`;
  })
  .join("\n");

const report = `# Choked Cryogenic Flow and Cavitating-Venturi Validation of OpenFLUME

**Validation against experiment: maximum flow of nitrogen and methane through nozzles and a sharp-edged orifice (NASA TP-1484, TM X-71760), and liquid-hydrogen venturi cavitation (NASA CR-2054)**

Generated by \`scripts/choked-flow-validation-report.ts\` — all model numbers
and figures come from live solves of the current solver. Cases, transcription
QC and models are defined once in \`src/validation/chokedFlow.ts\` and
\`src/validation/cavitationHord.ts\`; the CI gates are
\`src/validation/__tests__/chokedFlow.test.ts\`,
\`src/validation/__tests__/cavitationHord.test.ts\` (scientific tier,
\`npm run test:all\`) and \`src/validation/__tests__/experimentalData.test.ts\`
(source hash, fast tier).

## Abstract

OpenFLUME represents a flow restriction with one of two algebraic closures:
the \`orifice\`, whose expansibility factor uses the real-fluid isentropic
exponent κ = c_s²ρ/P and chokes at the corresponding critical pressure ratio,
and the \`cavitatingVenturi\`, which treats the liquid as incompressible down
to its vapor pressure and chokes there. This report compares both with
${nozzle.length + oriUsable.length} measured maximum mass fluxes of nitrogen
and methane — ${nozzle.length} through four converging–diverging nozzles
(Simoneau & Hendricks, NASA TP-1484, 1979) and ${oriUsable.length} through a
sharp-edged orifice (Simoneau, NASA TM X-71760, 1975) — and checks the
venturi closure's throat-pressure assumption against ${hord.length} developed
liquid-hydrogen cavities (Hord, Anderson & Hall, NASA CR-2054, 1972). The
agreement depends on the inlet regime, and the report is organized by it.
For subcooled liquid nozzle inlets (P0 ≥ 2 P_v(T0)) the choked-liquid closure
predicts the measured flux with a median ratio of ${f3(subN.model!.median)}
(range ${f3(subN.model!.min)}–${f3(subN.model!.max)}), and for gaseous inlets the
expansibility closure gives ${f3(gasN.model!.min)}–${f3(gasN.model!.max)}. Two regimes
are outside what the closures represent. Near saturation the measured flux
exceeds the prediction (median ${f3(satN.model!.median)}, down to ${f3(satN.model!.min)}),
the signature of liquid that stays metastable below its vapor pressure; an
equilibrium model under-predicts there too. For dense supercritical inlets
the expansibility closure, with κ frozen at the inlet state, over-predicts
by a median ${pct(supN.model!.median - 1, 0)} (up to ${pct(supN.model!.max - 1, 0)}), where an
isentropic homogeneous-equilibrium (HEM) calculation has a median ratio of
${f3(supN.hem!.median)}. Through the sharp-edged orifice, the
\`orifice\` closure with the textbook C_d = ${CD_SHARP_ORIFICE} at the measured back
pressure is within ${pct(subO.model!.min - 1)} to ${pct(subO.model!.max - 1)} for subcooled
inlets. In Hord's venturi the cavity leading edge sits ${(100 * minMax(depressionC).min).toFixed(0)}–${(100 * minMax(depressionC).max).toFixed(0)} %
below P_v(T0) because evaporation cools it, so for a choked venturi at
these conditions the closure would under-predict the flow by
${(100 * (1 - minMax(gRatio).max)).toFixed(0)}–${(100 * (1 - minMax(gRatio).min)).toFixed(0)} %.

## Introduction

Feed systems for cryogenic propellants are sized around restrictions that
choke: injector orifices, cavitating venturis used as flow regulators, and
nozzles and valves that pass flashing liquid. A network code reduces each of
these to an algebraic relation between upstream state, downstream pressure
and mass flow, and the quality of that relation sets the predicted flow.
The NASA Lewis choked-flow program of the 1970s measured exactly that
quantity — the maximum mass flux through a restriction as a function of the
stagnation state — across subcooled, saturated, near-critical, supercritical
and gaseous inlets, and Hord's cavitation program measured the cavity
pressures and temperatures that a cavitating-venturi closure assumes. Both
are therefore direct tests of the closures, independent of any network.

## Experiments and Data

### Nozzles (NASA TP-1484)

Simoneau and Hendricks measured the maximum (choked) mass flux of nitrogen
through four converging–diverging nozzles — 7° and 3.5° conical, elliptical,
and two-dimensional — and of methane and hydrogen through the elliptical
nozzle, with stagnation temperatures from well below to above the critical
temperature and stagnation pressures up to about 9 MPa. Each table row gives
T0, P0, the back pressure, the throat-to-stagnation pressure ratio, the
measured G = ṁ/A_throat, and properties computed by the authors (stagnation
entropy and saturation pressures). The digitized run-summary columns are
used here; the axial pressure profiles were not digitized. The hydrogen
table is excluded: most of its rows have no transcribed stagnation state.

### Sharp-edged orifice (NASA TM X-71760)

Simoneau measured the maximum flow of subcooled liquid nitrogen through a
0.318 cm sharp-edged orifice at stagnation temperatures of 95–130 K, with the
back pressure, the back (jet) temperature and the authors' discharge
coefficient C_d = G/√(2ρ0(P0 − P_b)) tabulated.

### Transcription quality control

The CSVs were extracted from scanned tables by OCR with per-cell flags, and
some rows carry shifted or mis-read columns. A row is used only if every
field the comparison needs is present and unflagged, and if values the paper
tabulates redundantly agree with values recomputed from the transcribed
fields: the saturation pressure at T0 within 5 % of CoolProp (both datasets);
for the orifice also the back temperature within 1.5 K of T_sat(P_b) and the
tabulated C_d within 3 % of G/√(2ρ0(P0 − P_b)). These checks use only the
transcribed numbers and the equation of state, never a flow model.

| Nozzle | Source | Rows | Usable |
| ------ | ------ | ---- | ------ |
${perTable}
| Sharp-edged orifice | TM X-71760 Table I | ${oriRows.length} | ${oriUsable.length} |

| Reason a row was excluded (first failing check) | Rows |
| ----------------------------------------------- | ---- |
${exclusionTable([...nozRows, ...oriRows])}

The orifice C_d check makes the orifice comparison at the measured back
pressure equivalent to comparing ${CD_SHARP_ORIFICE} Y with the usable rows' discharge
coefficients, which range from ${f3(cdRange.min)} to ${f3(cdRange.max)}; Y is the closure's
expansibility factor (below).

### Inlet regimes

Results are segmented by the stagnation state, with T_c = ${tcN2.toFixed(2)} K and
P_c = ${(pcN2 / 1e6).toFixed(3)} MPa for nitrogen (T_c = ${tcCH4.toFixed(2)} K for methane):

| Regime | Definition | Physics at the restriction |
| ------ | ---------- | -------------------------- |
| ${INLET_REGIMES[0]} | T0 < T_c, P0 ≥ 2 P_v(T0) | liquid accelerates to near P_v, then flashes |
| ${INLET_REGIMES[1]} | T0 < T_c, P0 < 2 P_v(T0) | flashing begins close to the inlet; non-equilibrium matters most |
| ${INLET_REGIMES[2]} | T_c ≤ T0 < 1.5 T_c | dense fluid whose compressibility changes strongly on expansion |
| ${INLET_REGIMES[3]} | T0 ≥ 1.5 T_c | near-ideal gas |

## Models

Each data point is one OpenFLUME steady network: a boundary node at
(P0, T0), one branch, and a downstream boundary node, with the CoolProp
equation of state for the fluid. Nothing is fitted.

- **Liquid inlets (T0 < T_c): \`cavitatingVenturi\`**, choked branch,
  ṁ = C_d A √(2ρ0(P0 − P_v(T0))). The downstream boundary is set to
  0.5 P_v(T0), so the closure is evaluated choked, the state in which the
  experiments were run.
- **Supercritical and gaseous inlets: \`orifice\`**, ṁ = C_d A Y(r, κ) √(2ρ0 ΔP)
  with κ = c_s²ρ/P at the inlet state and choking at
  r* = (2/(κ + 1))^(κ/(κ−1)); the downstream boundary is at 0.05 P0, below r*.
- **Sharp-edged orifice data:** the \`orifice\` closure at the measured back
  pressure (the model one would build for this restriction), and the
  \`cavitatingVenturi\` closure for comparison.
- **Discharge coefficient:** C_d = ${CD_NOZZLE} for the nozzles (the papers compare
  their data with ideal flow at the measured throat area) and C_d = ${CD_SHARP_ORIFICE}
  for the sharp-edged orifice (the standard high-Reynolds-number value;
  White, *Fluid Mechanics*).
- **Reference model (not an OpenFLUME closure):** isentropic homogeneous
  equilibrium flow, G* = max over P of ρ(P, s0)√(2(h0 − h(P, s0))), computed
  directly from CoolProp and multiplied by the same C_d. It separates the
  error of each closure's idealization from the non-equilibrium physics that
  no equilibrium model contains. Its implementation is checked against the
  ideal-gas critical flux of nitrogen at 300 K (gate test, < 0.5 %).

${allConverged ? "All" : "Not all"} ${nozzle.length + 2 * oriUsable.length} solves converged.

## Results

### Nozzles

Ratios are G_model/G_measured; "HEM" is the reference model.

| Data | Regime | OpenFLUME closure | n | Median | Range | Mean abs. deviation | HEM median | HEM range |
| ---- | ------ | ----------------- | - | ------ | ----- | ------------------- | ---------- | --------- |
${nozzleSummary}

By nozzle and fluid:

| Nozzle | Fluid | Regime | Closure | n | Median | Range | HEM median | HEM range |
| ------ | ----- | ------ | ------- | - | ------ | ----- | ---------- | --------- |
${geomRows}

**Subcooled liquid.** With C_d = 1 the choked-liquid closure over-predicts
the measured flux by a median ${pct(subN.model!.median - 1)}, with every point between
${pct(subN.model!.min - 1)} and ${pct(subN.model!.max - 1)}, and the HEM reference behaves almost
identically (median ${f3(subN.hem!.median)}). For a liquid well above its vapor pressure
the two models coincide: the liquid expands nearly isentropically to about
P_v and flashes there. The remaining few-percent over-prediction is of the
size expected from discharge coefficients slightly below one; no C_d is
fitted here.

**Near-saturated liquid.** The closure's driving pressure P0 − P_v(T0)
vanishes as the inlet approaches saturation, but the measured flux does
not. For P_v/P0 ≤ 0.9 the median ratio is ${f3(farStats.median)}
(${f3(farStats.min)}–${f3(farStats.max)}, n = ${farStats.n}); above 0.9 it is ${f3(closeStats.median)}
(${f3(closeStats.min)}–${f3(closeStats.max)}, n = ${closeStats.n}), and HEM, which lets the fluid
flash in equilibrium, is also low there (median ${f3(closeHem.median)}). The
measured flux exceeding both is the signature of liquid that remains
metastable below P_v(T0) before flashing. Neither closure represents
thermal non-equilibrium. For inlets within 10 % of saturation the
choked-liquid closure under-predicts by up to a factor of
${(1 / closeStats.min).toFixed(1)} and HEM by up to a factor of ${(1 / closeHem.min).toFixed(1)} (Figure 1).

${fig(1, "Liquid inlets, all four nozzles: OpenFLUME's choked-liquid closure (C_d = 1) and the HEM reference against measurement, plotted against the inlet saturation ratio P_v(T₀)/P₀. Points right of the dashed line are near-saturated (P₀ < 2P_v).")}

**Supercritical inlets.** The expansibility closure over-predicts every
point, by a median ${pct(supN.model!.median - 1)} (${pct(supN.model!.min - 1)} to ${pct(supN.model!.max - 1)}), while
HEM's median ratio is ${f3(supN.hem!.median)} (${f3(supN.hem!.min)}–${f3(supN.hem!.max)}). The closure
applies the ideal-gas expansibility law with κ evaluated once, at the inlet.
For a dense supercritical fluid κ = c_s²ρ/P changes by a large factor along
the expansion, so a constant-κ isentrope is a poor approximation to the real
one. The data confirm that this is a limitation of the closure and not of
the property data, since the HEM calculation uses the same equation of state
along the real isentrope (Figure 2).

**Gaseous inlets.** For the six room-temperature nitrogen points the
closure is within ${pct(gasN.model!.min - 1)} to ${pct(gasN.model!.max - 1)} of measurement, and HEM gives
the same values: here κ is nearly constant and the closure reduces to the
classical isentropic critical flux.

${fig(2, "Supercritical and gaseous inlets, all nozzles: OpenFLUME's expansibility closure (κ frozen at the inlet state, C_d = 1) and the HEM reference against measurement.")}

${fig(3, "All usable nozzle points: OpenFLUME's primary closure against the measured maximum mass flux, by inlet regime (dashed: ±10 %).")}

### Sharp-edged orifice

| Data | Regime | OpenFLUME closure | n | Median | Range | Mean abs. deviation | HEM × C_d median | HEM × C_d range |
| ---- | ------ | ----------------- | - | ------ | ----- | ------------------- | ---------------- | --------------- |
${orificeSummary}

With C_d = ${CD_SHARP_ORIFICE} at the measured back pressure the \`orifice\` closure is within
${pct(subO.model!.min - 1)} to ${pct(subO.model!.max - 1)} for subcooled inlets and ${pct(satO.model!.min - 1)} to
${pct(satO.model!.max - 1)} for near-saturated ones; the largest over-prediction is the
point closest to saturation. Part of this agreement is coincidental. At
95 and 110 K the expansibility factor is ${f3(Math.min(...yCold))}–${f3(Math.max(...yCold))} and the
jet behaves as an incompressible jet discharging at the back pressure, with
flashing outside the orifice. At 119–124 K the tabulated discharge
coefficient falls toward the critical point, and so does Y
(${f3(Math.min(...yWarm))}–${f3(Math.max(...yWarm))}, because κ = c_s²ρ/P falls); the closure tracks the data
through a gas-dynamic factor, not through a model of flashing, and that
correspondence should not be extrapolated. Both choked models are wrong for
a sharp-edged orifice: choking at P_v gives a median ${f3(subOc.model!.median)} (subcooled)
and ${f3(satOc.model!.median)} (near-saturated), and HEM × C_d gives ${f3(subOc.hem!.median)} and
${f3(satOc.hem!.median)} (Figure 4). A sharp-edged orifice passing subcooled cryogen
should be modeled with the \`orifice\` closure at the real downstream
pressure, not with a choked closure.

${fig(4, "Sharp-edged orifice, liquid nitrogen: the orifice closure at the measured back pressure, the choked-at-P_v closure and HEM, all with C_d = 0.61, against measurement.")}

## Part B: Cavitating Venturi (NASA CR-2054)

### Data

Hord, Anderson and Hall photographed developed (super)cavities on the
quarter-round contour of a transparent venturi of 1.905 cm throat diameter
in liquid para-hydrogen, and tabulated (Table A-1b) for each of
${hord.length} runs the inlet state (P0, T0), the vapor pressure at T0 (as the
"saturation head" h* and the pressure p*), and the wall pressures and
temperatures at seven ports along the cavity on both walls.

### What is compared, and what is not

The \`cavitatingVenturi\` closure assumes that a choked throat sits at
P_v(T0). Hord's measurements test that assumption directly:

1. OpenFLUME's P_v(T0) (CoolProp ParaHydrogen) against the tabulated p*;
2. the measured cavity pressure at the leading edge, p_c (port 2, nearest
   the throat, mean of the two walls), and the minimum over all ports,
   against P_v(T0);
3. the mass flux the closure predicts (an OpenFLUME solve with C_d = 1,
   downstream at 0.5 P_v) against the flux of a choked throat at the measured
   p_c, G_c = √(2ρ0(P0 − p_c)). Both carry the same C_d and area, so the ratio
   needs no venturi geometry.

The measured mass flow is not compared. The table gives a velocity "at the
test-section inlet", but the digitized record does not establish which area
it refers to: with the throat diameter and the listed 3.175 cm inlet
diameter, the throat velocity head would exceed P0 − P_v. The hydrofoil and
ogive cavitation sets of the same program (CR-2156, CR-2242) are external
flows over bodies with no network-component counterpart and are out of
scope.

### Results

${hordConverged ? "All" : "Not all"} ${hord.length} closure solves converged. OpenFLUME's vapor pressure agrees with
the tabulated value to within ${(100 * Math.max(...pvErr)).toFixed(2)} % (median ${(100 * [...pvErr].sort((a, b) => a - b)[Math.floor(pvErr.length / 2)]).toFixed(2)} %), so the
equation of state is not a factor. The measured leading-edge cavity
pressure lies ${(100 * minMax(depressionC).min).toFixed(0)}–${(100 * minMax(depressionC).max).toFixed(0)} % below P_v(T0), and the minimum cavity pressure
${(100 * minMax(depressionMin).min).toFixed(0)}–${(100 * minMax(depressionMin).max).toFixed(0)} % below. At the leading edge the cavity is close to saturation at
its own measured temperature (p/P_sat(T_port) = ${f3(minMax(port2Sat).min)}–${f3(minMax(port2Sat).max)}), so
the depression is thermal: evaporation into the cavity cools the liquid
around it below T0. Further downstream the ports read up to
${f3(minMax(downstreamSat).max)} × P_sat(T_port) as pressure recovers along the cavity.

For a choked venturi at these conditions the closure's throat pressure is
therefore too high, and its predicted flux is ${f3(minMax(gRatio).min)}–${f3(minMax(gRatio).max)} times the
flux through a throat at the measured p_c: an under-prediction of
${(100 * (1 - minMax(gRatio).max)).toFixed(0)}–${(100 * (1 - minMax(gRatio).min)).toFixed(0)} %. The effect is largest for the warmer runs (T0 ≈ 22.4–23 K),
where P0 − P_v is a small fraction of P0 (Figure 5). The closure has no
thermodynamic-suppression term; for liquid hydrogen near its normal boiling
point a user calibrating a venturi should expect its C_d to absorb this
effect.

${fig(5, "Hord's liquid-hydrogen venturi: the closure's throat pressure P_v(T₀) (OpenFLUME and tabulated) against the measured cavity pressure at the leading edge and the minimum over all ports.")}

## Trust Levels

| Comparison | Evidence class | Trust level | What may be quoted |
| ---------- | -------------- | ----------- | ------------------ |
| Nozzles, subcooled liquid, \`cavitatingVenturi\` | Validation against experiment | Validated within the stated range | Median ${f3(subN.model!.median)}, range ${f3(subN.model!.min)}–${f3(subN.model!.max)} at C_d = 1 |
| Nozzles, gas, \`orifice\` | Validation against experiment | Validated within the stated range | ${f3(gasN.model!.min)}–${f3(gasN.model!.max)} at C_d = 1 (six points) |
| Nozzles, near-saturated liquid | Validation against experiment | Documented disagreement | Under-prediction, unbounded as P0 → P_v |
| Nozzles, supercritical, \`orifice\` | Validation against experiment | Documented disagreement | Over-prediction, median ${pct(supN.model!.median - 1, 0)} |
| Sharp-edged orifice, \`orifice\` at P_b | Validation against experiment | Validated within the stated range | Subcooled ${pct(subO.model!.min - 1)} to ${pct(subO.model!.max - 1)} at C_d = ${CD_SHARP_ORIFICE} |
| Hord venturi, throat-pressure assumption | Validation against experiment (closure assumption) | Documented disagreement | Cavity ${(100 * minMax(depressionC).min).toFixed(0)}–${(100 * minMax(depressionC).max).toFixed(0)} % below P_v(T0) |
| HEM reference | Reference model, not OpenFLUME | — | Context only |

## Conclusions

OpenFLUME's two restriction closures predict choked cryogenic flow well in
the regimes they are built for and badly outside them, and the boundary is
sharp enough to state. The choked-liquid \`cavitatingVenturi\` closure with
C_d = 1 matches nozzle data for liquid nitrogen and methane subcooled to at
least twice the vapor pressure within a few percent, and the \`orifice\`
closure matches gaseous nitrogen and, at the measured back pressure with
C_d = ${CD_SHARP_ORIFICE}, subcooled liquid nitrogen through a sharp-edged orifice. Three
findings bound their use: neither closure represents thermal
non-equilibrium, so near-saturated liquid inlets are under-predicted; the
expansibility closure's frozen κ over-predicts dense supercritical flow by up
to ${pct(supN.model!.max - 1, 0)}, where an equilibrium calculation along the real isentrope
does not; and the venturi closure's throat pressure ignores the thermal
suppression of cavities, which Hord's hydrogen data put at ${(100 * minMax(depressionC).min).toFixed(0)}–${(100 * minMax(depressionC).max).toFixed(0)} % of P_v.
These are limitations of the closures, documented here with the data that
expose them; no closure was adjusted.

## References

1. Simoneau, R. J., and Hendricks, R. C., "Two-Phase Choked Flow of
   Cryogenic Fluids in Converging-Diverging Nozzles," NASA TP-1484, 1979.
2. Simoneau, R. J., "Maximum Two-Phase Flow Rates of Subcooled Nitrogen
   Through a Sharp-Edged Orifice," NASA TM X-71760, 1975 (also *Advances in
   Cryogenic Engineering* 21, 1975, pp. 299–306).
3. Hord, J., Anderson, L. M., and Hall, W. J., "Cavitation in Liquid
   Cryogens. Volume I: Venturi," NASA CR-2054, 1972.
4. Hord, J., "Cavitation in Liquid Cryogens. Volume II: Hydrofoil," NASA
   CR-2156, 1973; "Volume III: Ogives," NASA CR-2242, 1973 (out of scope).
5. White, F. M., *Fluid Mechanics*, 7th ed., McGraw-Hill, 2011 (orifice
   discharge coefficients).
6. Bell, I. H., Wronski, J., Quoilin, S., and Lemort, V., "Pure and
   Pseudo-pure Fluid Thermophysical Property Evaluation and the Open-Source
   Thermophysical Property Library CoolProp," *Industrial & Engineering
   Chemistry Research* 53(6), 2014, pp. 2498–2508.

## Nomenclature

| Symbol | Meaning |
| ------ | ------- |
| A | branch flow area (throat or bore) |
| C_d | discharge coefficient |
| c_s | speed of sound |
| G | mass flux ṁ/A |
| G* | HEM critical mass flux |
| h, h0 | specific enthalpy; stagnation value |
| ṁ | mass flow rate |
| P0, T0 | stagnation pressure, temperature |
| P_b | back pressure |
| P_c, T_c | critical pressure, temperature |
| p_c | measured cavity pressure at the leading edge (port 2) |
| P_v | vapor (saturation) pressure |
| r, r* | pressure ratio P_down/P_up; critical value |
| s0 | stagnation entropy |
| Y | expansibility factor |
| κ | isentropic exponent c_s²ρ/P |
| ρ0 | stagnation density |
`;

writeFileSync(join(outDir, "choked-flow-report.md"), report);
console.log(`\nwrote docs/validation/choked-flow-report.md`);
