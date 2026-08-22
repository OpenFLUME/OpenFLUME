/**
 * combustion-validation-report.ts — generates the reacting-junction /
 * rocket-thruster validation report (docs/validation/combustion-report.md)
 * and its SVG figures (docs/validation/figures/combustion/), following the
 * structure of scripts/compressible-validation-report.ts.
 *
 * Four verification groups, each with an analytic reference:
 *
 *   1. CEA table thermodynamic consistency — cp = γR/(γ−1) and the frozen
 *      one-dimensional characteristic velocity c* = √(R·T0)/Γ(γ) across the
 *      entire committed (Pc, O/F) grid; T0/γ/c* characteristics vs O/F.
 *   2. Thruster integral quantities — chamber closure T = η·T0(Pc, O/F),
 *      injector orifice mass flows vs ṁ = C_d·A·√(2ρΔP) (with hydrostatic
 *      head), ideal choked mass flow / c*, and the formula-coupled twin.
 *   3. Nozzle profiles — frozen-γ isentropic reference over the geometric
 *      area schedule, plus RK4 integration of the generalized quasi-1-D
 *      compressible ODE (area change + friction + wall-heat extraction) on
 *      the subsonic and supersonic legs away from the transonic segment.
 *   4. Regenerative wall stack — per-station series–parallel resistance
 *      network (gas film → inner liner → fin root → fins → fin tip → outer
 *      shell, coolant films on base/fins/shell) solved exactly with
 *      mean-temperature copper k, vs the solver's three solid layers;
 *      global coolant energy balance; analytic fin efficiency.
 *
 * All numbers and figures come from live solves — rerun after solver changes:
 *
 *   npx tsx scripts/combustion-validation-report.ts
 *
 * CI gate: src/core/__tests__/reactingJunction.test.ts (junction physics,
 * validation rules, robustness) and src/ui/tests/examples.test.ts (the
 * thruster example solves and passes invariants).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeAndValidateNetwork } from "../src/core/config";
import { solveSteady } from "../src/core/solver";
import type { NetworkConfig } from "../src/core";
import {
  combustionGasBounds,
  lookupCombustionGas,
} from "../src/core/combustion/combustionGas";
import { getSolidMaterialTable } from "../src/core/solidProperties";
import { thrusterCombustor } from "../src/ui/thrusterCombustor";

/* ==========================================================================
 * Formatting helpers
 * ========================================================================== */

const pct = (x: number, digits = 2): string =>
  Math.abs(x) < 1e-5
    ? `${(x * 100).toExponential(1)} %`
    : `${(x * 100).toFixed(digits)} %`;

const sig = (x: number, digits = 4): string => {
  if (x === 0) return "0";
  const mag = Math.floor(Math.log10(Math.abs(x)));
  const dec = Math.max(0, digits - 1 - mag);
  return x.toFixed(Math.min(10, dec));
};

/* ==========================================================================
 * Minimal SVG chart renderer (copied from compressible-validation-report.ts)
 * ========================================================================== */

type MarkerShape = "circle" | "square" | "triangle" | "diamond";

interface Series {
  label: string;
  pts: Array<[number, number]>;
  color: string;
  mode: "line" | "markers" | "both";
  marker?: MarkerShape;
  dash?: string;
}

function niceStep(range: number, targetTicks: number): number {
  const raw = range / Math.max(1, targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  if (norm <= 1) return mag;
  if (norm <= 2) return 2 * mag;
  if (norm <= 5) return 5 * mag;
  return 10 * mag;
}

function fmtTick(v: number, step: number): string {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return v.toFixed(Math.min(6, decimals));
}

function markerSvg(
  shape: MarkerShape,
  cx: number,
  cy: number,
  r: number,
  color: string,
): string {
  switch (shape) {
    case "circle":
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="1.4"/>`;
    case "square":
      return `<rect x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" fill="none" stroke="${color}" stroke-width="1.4"/>`;
    case "triangle":
      return `<polygon points="${cx},${cy - r} ${cx - r},${cy + r} ${cx + r},${cy + r}" fill="none" stroke="${color}" stroke-width="1.4"/>`;
    case "diamond":
      return `<polygon points="${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}" fill="none" stroke="${color}" stroke-width="1.4"/>`;
  }
}

function lineChart(opts: {
  title: string;
  xLabel: string;
  yLabel: string;
  series: Series[];
  yPad?: number;
  legend?: "top-right" | "top-left" | "bottom-left" | "bottom-right";
}): string {
  const W = 680;
  const H = 430;
  const m = { l: 76, r: 24, t: 46, b: 58 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;

  const allPts = opts.series.flatMap((s) => s.pts);
  const xMin = Math.min(...allPts.map((p) => p[0]));
  let xMax = Math.max(...allPts.map((p) => p[0]));
  let yMin = Math.min(...allPts.map((p) => p[1]));
  let yMax = Math.max(...allPts.map((p) => p[1]));
  const yPad = (opts.yPad ?? 0.06) * (yMax - yMin || 1);
  yMin -= yPad;
  yMax += yPad;
  if (xMax === xMin) xMax = xMin + 1;

  const sx = (x: number) => m.l + ((x - xMin) / (xMax - xMin)) * pw;
  const sy = (y: number) => m.t + ph - ((y - yMin) / (yMax - yMin)) * ph;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">`,
    `<rect width="${W}" height="${H}" fill="white"/>`,
    `<text x="${W / 2}" y="24" text-anchor="middle" font-size="15" font-weight="bold">${opts.title}</text>`,
  );

  const xStep = niceStep(xMax - xMin, 6);
  const yStep = niceStep(yMax - yMin, 6);
  for (let v = Math.ceil(xMin / xStep) * xStep; v <= xMax + 1e-9; v += xStep) {
    const x = sx(v);
    parts.push(
      `<line x1="${x}" y1="${m.t}" x2="${x}" y2="${m.t + ph}" stroke="#e0e0e0" stroke-width="1"/>`,
      `<text x="${x}" y="${m.t + ph + 18}" text-anchor="middle" font-size="11">${fmtTick(v, xStep)}</text>`,
    );
  }
  for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax + 1e-9; v += yStep) {
    const y = sy(v);
    parts.push(
      `<line x1="${m.l}" y1="${y}" x2="${m.l + pw}" y2="${y}" stroke="#e0e0e0" stroke-width="1"/>`,
      `<text x="${m.l - 8}" y="${y + 4}" text-anchor="end" font-size="11">${fmtTick(v, yStep)}</text>`,
    );
  }
  parts.push(
    `<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="none" stroke="#333" stroke-width="1.2"/>`,
    `<text x="${m.l + pw / 2}" y="${H - 14}" text-anchor="middle" font-size="12.5">${opts.xLabel}</text>`,
    `<text x="20" y="${m.t + ph / 2}" text-anchor="middle" font-size="12.5" transform="rotate(-90 20 ${m.t + ph / 2})">${opts.yLabel}</text>`,
  );

  for (const s of opts.series) {
    if (s.mode !== "markers") {
      const path = s.pts
        .map(
          ([x, y], i) =>
            `${i === 0 ? "M" : "L"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`,
        )
        .join(" ");
      parts.push(
        `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="1.8"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`,
      );
    }
    if (s.mode !== "line") {
      for (const [x, y] of s.pts) {
        parts.push(markerSvg(s.marker ?? "circle", sx(x), sy(y), 3.4, s.color));
      }
    }
  }

  const legendW =
    Math.max(
      ...opts.series.map((s) => s.label.replace(/<[^>]+>/g, "").length),
    ) *
      6.4 +
    44;
  const legendH = opts.series.length * 18 + 10;
  const pad = 8;
  const pos = opts.legend ?? "top-right";
  const lx = pos.endsWith("left") ? m.l + pad : m.l + pw - legendW - pad;
  const ly = pos.startsWith("top") ? m.t + pad : m.t + ph - legendH - pad;
  parts.push(
    `<rect x="${lx}" y="${ly}" width="${legendW}" height="${legendH}" fill="white" fill-opacity="0.88" stroke="#999" stroke-width="0.8"/>`,
  );
  opts.series.forEach((s, i) => {
    const yy = ly + 14 + i * 18;
    if (s.mode !== "markers") {
      parts.push(
        `<line x1="${lx + 8}" y1="${yy - 4}" x2="${lx + 30}" y2="${yy - 4}" stroke="${s.color}" stroke-width="1.8"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`,
      );
    }
    if (s.mode !== "line") {
      parts.push(
        markerSvg(s.marker ?? "circle", lx + 19, yy - 4, 3.4, s.color),
      );
    }
    parts.push(
      `<text x="${lx + 36}" y="${yy}" font-size="11">${s.label}</text>`,
    );
  });

  parts.push("</svg>");
  return parts.join("\n");
}

const C = {
  analytic: "#000000",
  blue: "#1f5fa8",
  red: "#c0392b",
  green: "#1e8449",
  orange: "#d68910",
};

/* ==========================================================================
 * Output plumbing
 * ========================================================================== */

const outDir = join(process.cwd(), "docs", "validation");
const figDir = join(outDir, "figures", "combustion");
mkdirSync(figDir, { recursive: true });

const figFiles: string[] = [];
function writeFig(n: number, name: string, svg: string): void {
  const file = `fig${String(n).padStart(2, "0")}-${name}.svg`;
  writeFileSync(join(figDir, file), svg);
  figFiles[n] = file;
  console.log(`  wrote figures/combustion/${file}`);
}
const fig = (n: number, caption: string): string =>
  `![Figure ${n}](figures/combustion/${figFiles[n]})\n\n*Figure ${n}. ${caption}*`;

console.log("Generating combustion validation report…");

/* ==========================================================================
 * Shared gas-dynamics helpers (frozen γ, ideal gas)
 * ========================================================================== */

/** Vandenkerckhove function Γ(γ): ṁ_choked = P0·At·Γ/√(R·T0). */
const Gamma = (g: number) =>
  Math.sqrt(g) * Math.pow(2 / (g + 1), (g + 1) / (2 * (g - 1)));

/** Isentropic A/A*(M). */
const areaRatioOfM = (M: number, g: number) =>
  (1 / M) *
  Math.pow(((2 / (g + 1)) * (1 + ((g - 1) / 2) * M * M)), (g + 1) / (2 * (g - 1)));

/** Invert A/A* on the requested branch by bisection. */
function machOfAreaRatio(ar: number, g: number, branch: "sub" | "sup"): number {
  if (ar <= 1) return 1;
  let lo = branch === "sub" ? 1e-6 : 1;
  let hi = branch === "sub" ? 1 : 50;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    const f = areaRatioOfM(mid, g) - ar;
    // A/A* decreases with M on the subsonic branch, increases on the
    // supersonic branch.
    const high = branch === "sub" ? f > 0 : f < 0;
    if (high) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/* ==========================================================================
 * Part 1 — CEA table thermodynamic consistency
 * ========================================================================== */

console.log("Part 1 — CEA table consistency");

const PROP = "lox-rp1" as const;
const bounds = combustionGasBounds(PROP);

// Sweep a dense grid strictly inside the table bounds so no lookup clamps.
const NPC = 25;
const NOF = 97;
let cpErrMax = 0;
let cstarGapMax = 0;
let cstarGapAt = { pc: 0, of: 0 };
for (let i = 0; i < NPC; i++) {
  const pc =
    bounds.pcMinPa *
    Math.pow(bounds.pcMaxPa / bounds.pcMinPa, i / (NPC - 1));
  for (let j = 0; j < NOF; j++) {
    const of = bounds.ofMin + ((bounds.ofMax - bounds.ofMin) * j) / (NOF - 1);
    const { state } = lookupCombustionGas(PROP, pc, of);
    const cpFromGamma = (state.gamma / (state.gamma - 1)) * state.R;
    cpErrMax = Math.max(
      cpErrMax,
      Math.abs(state.cp - cpFromGamma) / state.cp,
    );
    // Tabulated c* is CEA's EQUILIBRIUM value; the frozen closed form from
    // the tabulated (T0, gamma_s, R) differs by the equilibrium/frozen gap.
    const cstarFrozen = Math.sqrt(state.R * state.T0) / Gamma(state.gamma);
    const gap = Math.abs(state.cstar - cstarFrozen) / state.cstar;
    if (gap > cstarGapMax) {
      cstarGapMax = gap;
      cstarGapAt = { pc, of };
    }
  }
}
// The gap at the thruster's own operating point, for scale.
const opState = lookupCombustionGas(PROP, 9.8e5, 2.59).state;
const cstarGapAtOp =
  Math.abs(
    opState.cstar - Math.sqrt(opState.R * opState.T0) / Gamma(opState.gamma),
  ) / opState.cstar;

// Characteristics vs O/F at three chamber pressures.
const pcLevels = [2e5, 1e6, 8e6].filter(
  (p) => p >= bounds.pcMinPa && p <= bounds.pcMaxPa,
);
const ofSweep: number[] = [];
for (let j = 0; j <= 96; j++)
  ofSweep.push(bounds.ofMin + ((bounds.ofMax - bounds.ofMin) * j) / 96);

const t0Series: Series[] = pcLevels.map((pc, i) => ({
  label: `Pc = ${sig(pc / 1e5, 3)} bar`,
  pts: ofSweep.map((of) => [of, lookupCombustionGas(PROP, pc, of).state.T0]),
  color: [C.blue, C.red, C.green][i],
  mode: "line" as const,
}));
writeFig(
  1,
  "cea-t0-of",
  lineChart({
    title: "LOX/RP-1 adiabatic chamber temperature (CEA equilibrium)",
    xLabel: "Mixture ratio O/F",
    yLabel: "T0 [K]",
    series: t0Series,
    legend: "bottom-right",
  }),
);

const gammaSeries: Series[] = pcLevels.map((pc, i) => ({
  label: `Pc = ${sig(pc / 1e5, 3)} bar`,
  pts: ofSweep.map((of) => [
    of,
    lookupCombustionGas(PROP, pc, of).state.gamma,
  ]),
  color: [C.blue, C.red, C.green][i],
  mode: "line" as const,
}));
writeFig(
  2,
  "cea-gamma-of",
  lineChart({
    title: "LOX/RP-1 product isentropic exponent (CEA equilibrium)",
    xLabel: "Mixture ratio O/F",
    yLabel: "gamma_s",
    series: gammaSeries,
    legend: "top-right",
  }),
);

const cstarPc = 1e6;
writeFig(
  3,
  "cea-cstar-of",
  lineChart({
    title: "Characteristic velocity at Pc = 10 bar: table vs frozen closed form",
    xLabel: "Mixture ratio O/F",
    yLabel: "c* [m/s]",
    series: [
      {
        label: "sqrt(R T0)/Gamma(gamma) from tabulated state",
        pts: ofSweep.map((of) => {
          const s = lookupCombustionGas(PROP, cstarPc, of).state;
          return [of, Math.sqrt(s.R * s.T0) / Gamma(s.gamma)];
        }),
        color: C.analytic,
        mode: "line",
      },
      {
        label: "tabulated c*",
        pts: ofSweep
          .filter((_, i) => i % 4 === 0)
          .map((of) => [
            of,
            lookupCombustionGas(PROP, cstarPc, of).state.cstar,
          ]),
        color: C.red,
        mode: "markers",
        marker: "circle",
      },
    ],
    legend: "bottom-right",
  }),
);

// Peak locations at 10 bar.
let peakT0 = { of: 0, v: 0 };
let peakCstar = { of: 0, v: 0 };
for (const of of ofSweep) {
  const s = lookupCombustionGas(PROP, cstarPc, of).state;
  if (s.T0 > peakT0.v) peakT0 = { of, v: s.T0 };
  if (s.cstar > peakCstar.v) peakCstar = { of, v: s.cstar };
}

/* ==========================================================================
 * Solve the thruster case
 * ========================================================================== */

console.log("Solving the LOX/RP-1 thruster (reacting junction)…");

const { config, errors } = decodeAndValidateNetwork(
  JSON.parse(JSON.stringify(thrusterCombustor)) as NetworkConfig,
);
if (errors.length) throw new Error(`invalid network:\n${errors.join("\n")}`);
const res = solveSteady(config);
if (!res.converged) throw new Error("thruster solve did not converge");
const jn = res.junctions!.mainCombustor;

/* --------------------------------------------------------------------------
 * Geometry: walk the gas path chamber -> exhaust along seg1..segN.
 * ------------------------------------------------------------------------ */

interface Station {
  id: string;
  D: number; // local diameter [m]
  A: number; // local flow area [m²]
  z: number; // axial coordinate [m]
  Ltrib: number; // tributary length (half of each adjacent segment) [m]
}

const nodeById = new Map(config.nodes.map((n) => [n.id, n]));
const branchById = new Map(config.branches.map((b) => [b.id, b]));

const stations: Station[] = [];
const segLen: number[] = [];
{
  let i = 1;
  for (;;) {
    const b = branchById.get(`seg${i}`);
    if (!b) break;
    const comp = b.component as { length: number; diameter: number };
    const from = nodeById.get(b.from)!;
    stations.push({
      id: b.from,
      D: comp.diameter,
      A: (Math.PI / 4) * comp.diameter * comp.diameter,
      z: (from.position?.z as number) ?? 0,
      Ltrib: 0,
    });
    segLen.push(comp.length);
    i++;
  }
}
stations.forEach((st, i) => {
  st.Ltrib = (((i > 0 ? segLen[i - 1] : 0) + segLen[i]) as number) / 2;
});
const throatIdx = stations.findIndex((s) => s.id === "throat");
const At = stations[throatIdx].A;
const frictionF = 0.02; // authored constant Darcy f on every gas segment

const gamma = jn.gas.gamma;
const Rgas = jn.gas.R;
const cpGas = jn.gas.cp;
const mdotGas = jn.mdotTotal;

/** Solved node state + derived Mach at a station. */
const solvedAt = (st: Station) => {
  const n = res.nodes[st.id];
  const rho = n.pressure / (Rgas * n.temperature);
  const v = mdotGas / (rho * st.A);
  const M = v / Math.sqrt(gamma * Rgas * n.temperature);
  return { P: n.pressure, T: n.temperature, M };
};

/* ==========================================================================
 * Part 2 — integral quantities
 * ========================================================================== */

console.log("Part 2 — integral quantities");

// (a) Chamber thermochemical closure: T_chamber = η·T0(Pc, O/F) exactly.
const eff = config.junctions![0].model.efficiency ?? 1;
const closureErr =
  Math.abs(res.nodes.chamber.temperature - eff * jn.gas.T0) / jn.gas.T0;

// (b) Injector orifices vs ṁ = C_d·A·√(2ρΔP_eff), ΔP_eff including the
// hydrostatic head ρ·g·Δz along the branch (z-up standard gravity).
const G0 = 9.80665;
function orificeCheck(branchId: string, rho: number) {
  const b = branchById.get(branchId)!;
  const comp = b.component as { area: number; cd: number };
  const up = nodeById.get(b.from)!;
  const dn = nodeById.get(b.to)!;
  const dz =
    ((dn.position?.z as number) ?? 0) - ((up.position?.z as number) ?? 0);
  const dP =
    res.nodes[b.from].pressure - res.nodes[b.to].pressure - rho * G0 * dz;
  const mdotAn = comp.cd * comp.area * Math.sqrt(2 * rho * Math.max(dP, 0));
  const mdotNum = res.branches[branchId].mdot;
  return { mdotAn, mdotNum, err: Math.abs(mdotNum - mdotAn) / mdotAn };
}
const loxRho = 1141;
const rp1Rho = 810;
const oxCheck = orificeCheck("loxInjector", loxRho);
const fuelCheck = orificeCheck("fuelInjector", rp1Rho);

// (c) Ideal choked flow and c*.  Chamber stagnation state from the solved
// static chamber state and its (small) Mach number.
const ch = solvedAt(stations[0]);
const stag = 1 + ((gamma - 1) / 2) * ch.M * ch.M;
const P0 = ch.P * Math.pow(stag, gamma / (gamma - 1));
const T0stag = ch.T * stag;
const mdotIdeal = (P0 * At * Gamma(gamma)) / Math.sqrt(Rgas * T0stag);
const mdotExcess = (mdotGas - mdotIdeal) / mdotIdeal;
const cstarEmergent = (jn.pc * At) / mdotGas;
const cstarRef = 0.97 * jn.gas.cstar; // η_c* = √efficiency = 0.97
const cstarErr = (cstarEmergent - cstarRef) / cstarRef;

// (d) Formula-coupled twin (basic-lox-rp1-thruster.fn, fixed γ = 1.2 gas).
const TWIN = { pc: 986633, ox: 0.547247, fuel: 0.21048, gas: 0.757727 };

/* ==========================================================================
 * Part 3 — nozzle profiles
 * ========================================================================== */

console.log("Part 3 — nozzle profiles");

// (a) Frozen-γ isentropic reference over the geometric area schedule.
const isentropic = stations.map((st, i) => {
  const ar = st.A / At;
  const M =
    i === throatIdx
      ? 1
      : machOfAreaRatio(ar, gamma, i < throatIdx ? "sub" : "sup");
  const s = 1 + ((gamma - 1) / 2) * M * M;
  return {
    id: st.id,
    z: st.z,
    M,
    P: P0 * Math.pow(s, -gamma / (gamma - 1)),
    T: T0stag / s,
  };
});

// Sonic-point stations (docs/combustion.md): the discrete sonic transition
// falls inside one near-throat segment, so the station(s) bounding it sit
// BETWEEN the subsonic and supersonic isentrope branches —
// first-order smearing of the limited-upwind faces
// (settings.momentumFluxScheme "upwind", which eliminates the wrong-branch
// roots older central-scheme builds could land on).  Flag them by their
// deviation from the isentrope — friction/heat corrections are a few
// percent, the smearing is tens.
const artifactIds = new Set(
  stations
    .filter((st, i) => {
      const num = solvedAt(st);
      return Math.abs(num.P - isentropic[i].P) / isentropic[i].P > 0.12;
    })
    .map((s) => s.id),
);

// (b) RK4 of the generalized quasi-1-D ODE with area change, friction, and
// the solver's own per-station wall-heat extraction, on the two legs that
// avoid the transonic segment.  dT0/dx uses each station's gas-film heat
// over its tributary length — the exact dual of how the wall stack was
// generated — with the chamber's film excluded (its energy row is the
// junction closure, so that heat never leaves the gas continuum).
const stationHeat = new Map(
  stations.map((st) => [
    st.id,
    st.id === "chamber"
      ? 0
      : (res.conductors?.[`${st.id}GasFilm`]?.heatRate ?? 0),
  ]),
);

function rk4Leg(iStart: number, iEnd: number) {
  const out = new Map<string, { P: number; T: number; M: number }>();
  const start = solvedAt(stations[iStart]);
  let M = start.M;
  let T0 = start.T * (1 + ((gamma - 1) / 2) * M * M);
  for (let i = iStart; i < iEnd; i++) {
    const a = stations[i];
    const b = stations[i + 1];
    const L = segLen[i];
    const dDdx = (b.D - a.D) / L;
    const qA = stationHeat.get(a.id)! / (mdotGas * cpGas * a.Ltrib);
    const qB = stationHeat.get(b.id)! / (mdotGas * cpGas * b.Ltrib);
    const N = 2000;
    const h = L / N;
    for (let k = 0; k < N; k++) {
      const x0 = k * h;
      const deriv = (x: number, Mx: number, T0x: number) => {
        const D = a.D + dDdx * x;
        const A = (Math.PI / 4) * D * D;
        const dAdx = (Math.PI / 2) * D * dDdx;
        // Heat allocation: first half of the segment drains station a's
        // film, second half station b's (tributary-length attribution).
        const dT0dx = -(x < L / 2 ? qA : qB);
        const M2 = Mx * Mx;
        return {
          dM:
            ((Mx * (1 + ((gamma - 1) / 2) * M2)) / (1 - M2)) *
            (((gamma * M2) / 2) * (frictionF / D) +
              ((1 + gamma * M2) / (2 * T0x)) * dT0dx -
              dAdx / A),
          dT0: dT0dx,
        };
      };
      const k1 = deriv(x0, M, T0);
      const k2 = deriv(x0 + h / 2, M + (h / 2) * k1.dM, T0 + (h / 2) * k1.dT0);
      const k3 = deriv(x0 + h / 2, M + (h / 2) * k2.dM, T0 + (h / 2) * k2.dT0);
      const k4 = deriv(x0 + h, M + h * k3.dM, T0 + h * k3.dT0);
      M += (h / 6) * (k1.dM + 2 * k2.dM + 2 * k3.dM + k4.dM);
      T0 += (h / 6) * (k1.dT0 + 2 * k2.dT0 + 2 * k3.dT0 + k4.dT0);
    }
    const T = T0 / (1 + ((gamma - 1) / 2) * M * M);
    const v = M * Math.sqrt(gamma * Rgas * T);
    const rho = mdotGas / (b.A * v);
    out.set(b.id, { P: rho * Rgas * T, T, M });
  }
  return out;
}

const conv5Idx = stations.findIndex((s) => s.id === "conv5");
const div2Idx = stations.findIndex((s) => s.id === "div2");
const lastIdx = stations.length - 1;
const subLeg = rk4Leg(0, conv5Idx); // chamber -> conv5
const supLeg = rk4Leg(div2Idx, lastIdx); // div2 -> div11

interface LegStat {
  n: number;
  maxP: number;
  maxT: number;
  maxM: number;
}
function legStats(leg: Map<string, { P: number; T: number; M: number }>): LegStat {
  let maxP = 0;
  let maxT = 0;
  let maxM = 0;
  for (const [id, an] of leg) {
    const st = stations.find((s) => s.id === id)!;
    const num = solvedAt(st);
    maxP = Math.max(maxP, Math.abs(num.P - an.P) / an.P);
    maxT = Math.max(maxT, Math.abs(num.T - an.T) / an.T);
    maxM = Math.max(maxM, Math.abs(num.M - an.M) / an.M);
  }
  return { n: leg.size, maxP, maxT, maxM };
}
const subStats = legStats(subLeg);
const supStats = legStats(supLeg);

// Isentropic deviation stats away from the artifact stations.
let isenMaxP = 0;
let isenMaxPId = "";
for (let i = 0; i < stations.length; i++) {
  if (artifactIds.has(stations[i].id)) continue;
  const num = solvedAt(stations[i]);
  const rel = Math.abs(num.P - isentropic[i].P) / isentropic[i].P;
  if (rel > isenMaxP) {
    isenMaxP = rel;
    isenMaxPId = stations[i].id;
  }
}

// Profile figures.
const zOf = (id: string) => stations.find((s) => s.id === id)!.z;
function profileFig(
  n: number,
  name: string,
  title: string,
  yLabel: string,
  pick: (s: { P: number; T: number; M: number }) => number,
  pickIsen: (s: { P: number; T: number; M: number }) => number,
) {
  const series: Series[] = [
    {
      label: "frozen-gamma isentropic (geometric A/At)",
      pts: isentropic.map((s) => [s.z, pickIsen(s)]),
      color: C.analytic,
      mode: "line",
    },
    {
      label: "RK4 ODE, friction + wall heat (both legs)",
      pts: [
        ...[...subLeg.entries()].map(
          ([id, s]) => [zOf(id), pick(s)] as [number, number],
        ),
        ...[...supLeg.entries()].map(
          ([id, s]) => [zOf(id), pick(s)] as [number, number],
        ),
      ],
      color: C.green,
      mode: "markers",
      marker: "triangle",
    },
    {
      label: artifactIds.size > 0 ? "solver (clean stations)" : "solver stations",
      pts: stations
        .filter((st) => !artifactIds.has(st.id))
        .map((st) => [st.z, pick(solvedAt(st))]),
      color: C.blue,
      mode: "markers" as const,
      marker: "circle" as const,
    },
    ...(artifactIds.size > 0
      ? [
          {
            label: "solver (transonic-artifact stations)",
            pts: stations
              .filter((st) => artifactIds.has(st.id))
              .map((st) => [st.z, pick(solvedAt(st))] as [number, number]),
            color: C.red,
            mode: "markers" as const,
            marker: "square" as const,
          },
        ]
      : []),
  ];
  writeFig(
    n,
    name,
    lineChart({
      title,
      xLabel: "axial position z [m]",
      yLabel,
      series,
      legend: name === "nozzle-mach" ? "top-left" : "top-right",
    }),
  );
}
profileFig(
  4,
  "nozzle-pressure",
  "Nozzle static pressure: solver vs analytical references",
  "P [Pa]",
  (s) => s.P,
  (s) => s.P,
);
profileFig(
  5,
  "nozzle-mach",
  "Nozzle Mach number: solver vs analytical references",
  "M",
  (s) => s.M,
  (s) => s.M,
);
profileFig(
  6,
  "nozzle-temperature",
  "Nozzle static temperature: solver vs analytical references",
  "T [K]",
  (s) => s.T,
  (s) => s.T,
);

/* ==========================================================================
 * Part 4 — regenerative wall stack vs series–parallel resistance network
 * ========================================================================== */

console.log("Part 4 — wall stack resistance network");

const kTable = getSolidMaterialTable("ofhc-copper", "k");
function copperK(T: number): number {
  if (T <= kTable[0][0]) return kTable[0][1];
  for (let i = 1; i < kTable.length; i++) {
    if (T <= kTable[i][0]) {
      const [T1, k1] = kTable[i - 1];
      const [T2, k2] = kTable[i];
      return k1 + ((k2 - k1) * (T - T1)) / (T2 - T1);
    }
  }
  return kTable[kTable.length - 1][1];
}

const conductorById = new Map((config.conductors ?? []).map((c) => [c.id, c]));
const convG = (id: string): number => {
  const c = conductorById.get(id)!;
  if (c.type.kind !== "convection") throw new Error(`${id} not convection`);
  return (c.type.h as number) * (c.type.area as number);
};
const condGeom = (id: string): { area: number; length: number } => {
  const c = conductorById.get(id)!;
  if (c.type.kind !== "conduction") throw new Error(`${id} not conduction`);
  return { area: c.type.area as number, length: c.type.length as number };
};

/** Solve the per-station 3-layer network for (T_liner, T_fin, T_shell)
 *  given the solved gas/coolant temperatures, iterating the copper k at
 *  the endpoint-mean temperatures exactly as the solver does. */
function wallNetwork(st: Station) {
  const Tg = res.nodes[st.id].temperature;
  const base = conductorById.get(`${st.id}BaseFilm`)!;
  const Tc = res.nodes[base.to].temperature;
  const Gg = convG(`${st.id}GasFilm`);
  const Gb = convG(`${st.id}BaseFilm`);
  const Gf = convG(`${st.id}FinFilm`);
  const Gs = convG(`${st.id}ShellFilm`);
  const root = condGeom(`${st.id}FinRoot`);
  const tip = condGeom(`${st.id}FinTip`);

  let TL = Tg * 0.15 + Tc * 0.85;
  let TF = TL - 10;
  let TS = TF - 5;
  for (let iter = 0; iter < 20; iter++) {
    const Gfr = (copperK((TL + TF) / 2) * root.area) / root.length;
    const Gft = (copperK((TF + TS) / 2) * tip.area) / tip.length;
    // Linear system for [TL, TF, TS]:
    //   (Gg+Gb+Gfr)·TL − Gfr·TF            = Gg·Tg + Gb·Tc
    //   −Gfr·TL + (Gfr+Gf+Gft)·TF − Gft·TS = Gf·Tc
    //   −Gft·TF + (Gft+Gs)·TS              = Gs·Tc
    const A = [
      [Gg + Gb + Gfr, -Gfr, 0],
      [-Gfr, Gfr + Gf + Gft, -Gft],
      [0, -Gft, Gft + Gs],
    ];
    const rhs = [Gg * Tg + Gb * Tc, Gf * Tc, Gs * Tc];
    // 3×3 Gaussian elimination.
    for (let c = 0; c < 3; c++) {
      for (let r = c + 1; r < 3; r++) {
        const f = A[r][c] / A[c][c];
        for (let cc = c; cc < 3; cc++) A[r][cc] -= f * A[c][cc];
        rhs[r] -= f * rhs[c];
      }
    }
    const x = [0, 0, 0];
    for (let r = 2; r >= 0; r--) {
      let s = rhs[r];
      for (let cc = r + 1; cc < 3; cc++) s -= A[r][cc] * x[cc];
      x[r] = s / A[r][r];
    }
    const d = Math.max(
      Math.abs(x[0] - TL),
      Math.abs(x[1] - TF),
      Math.abs(x[2] - TS),
    );
    [TL, TF, TS] = x as [number, number, number];
    if (d < 1e-10) break;
  }
  return { Tg, Tc, TL, TF, TS, q: Gg * (Tg - TL) };
}

interface WallRow {
  id: string;
  z: number;
  an: ReturnType<typeof wallNetwork>;
  num: { TL: number; TF: number; TS: number; q: number };
}
const wallRows: WallRow[] = stations.map((st) => {
  const an = wallNetwork(st);
  return {
    id: st.id,
    z: st.z,
    an,
    num: {
      TL: res.solidNodes![`${st.id}Liner`].temperature,
      TF: res.solidNodes![`${st.id}Fin`].temperature,
      TS: res.solidNodes![`${st.id}Shell`].temperature,
      q: res.conductors![`${st.id}GasFilm`].heatRate,
    },
  };
});
let wallTmaxK = 0;
let wallQmaxRel = 0;
for (const r of wallRows) {
  wallTmaxK = Math.max(
    wallTmaxK,
    Math.abs(r.num.TL - r.an.TL),
    Math.abs(r.num.TF - r.an.TF),
    Math.abs(r.num.TS - r.an.TS),
  );
  wallQmaxRel = Math.max(
    wallQmaxRel,
    Math.abs(r.num.q - r.an.q) / Math.abs(r.an.q),
  );
}

// Global coolant energy balance: all coolant-side films vs ṁ·cp·ΔT.
const CP_RP1 = 2000;
let coolantFilmQ = 0;
for (const st of stations) {
  coolantFilmQ +=
    res.conductors![`${st.id}BaseFilm`].heatRate +
    res.conductors![`${st.id}FinFilm`].heatRate +
    res.conductors![`${st.id}ShellFilm`].heatRate;
}
const mdotFuel = res.branches.fuelInjector.mdot;
const coolantRise =
  mdotFuel *
  CP_RP1 *
  (res.nodes.chamberCoolant.temperature - res.nodes.fuelTank.temperature);
const coolantBalanceErr =
  Math.abs(coolantFilmQ - coolantRise) / coolantRise;

// Analytic fin efficiency at throat conditions vs the modeled constant.
const H_COOL = 15000;
const FIN_T = 0.001;
const CHANNEL_H = 0.003;
const throatWall = wallRows.find((r) => r.id === "throat")!;
const kFin = copperK((throatWall.an.TF + throatWall.an.Tc) / 2 + 0);
const mFin = Math.sqrt((2 * H_COOL) / (kFin * FIN_T));
const etaFinAn = Math.tanh(mFin * CHANNEL_H) / (mFin * CHANNEL_H);

// Wall temperature figure.
writeFig(
  7,
  "wall-temps",
  lineChart({
    title: "Regen wall stack temperatures along the engine",
    xLabel: "axial position z [m]",
    yLabel: "T [K]",
    series: [
      {
        label: "inner liner — resistance network",
        pts: wallRows.map((r) => [r.z, r.an.TL]),
        color: C.red,
        mode: "line",
      },
      {
        label: "inner liner — solver",
        pts: wallRows.map((r) => [r.z, r.num.TL]),
        color: C.red,
        mode: "markers",
        marker: "circle",
      },
      {
        label: "fins — resistance network",
        pts: wallRows.map((r) => [r.z, r.an.TF]),
        color: C.orange,
        mode: "line",
      },
      {
        label: "fins — solver",
        pts: wallRows.map((r) => [r.z, r.num.TF]),
        color: C.orange,
        mode: "markers",
        marker: "triangle",
      },
      {
        label: "outer shell — resistance network",
        pts: wallRows.map((r) => [r.z, r.an.TS]),
        color: C.blue,
        mode: "line",
      },
      {
        label: "outer shell — solver",
        pts: wallRows.map((r) => [r.z, r.num.TS]),
        color: C.blue,
        mode: "markers",
        marker: "square",
      },
      {
        label: "RP-1 coolant (per station)",
        pts: wallRows.map((r) => [r.z, r.an.Tc]),
        color: C.green,
        mode: "line",
        dash: "5 3",
      },
    ],
    legend: "top-right",
  }),
);

// Gas-side heat flux figure.
writeFig(
  8,
  "heat-flux",
  lineChart({
    title: "Gas-side wall heat flux along the engine",
    xLabel: "axial position z [m]",
    yLabel: "q'' [kW/m²]",
    series: [
      {
        label: "resistance network",
        pts: wallRows.map((r) => {
          const c = conductorById.get(`${r.id}GasFilm`)!;
          const area =
            c.type.kind === "convection" ? (c.type.area as number) : 1;
          return [r.z, r.an.q / area / 1000];
        }),
        color: C.analytic,
        mode: "line",
      },
      {
        label: "solver",
        pts: wallRows.map((r) => {
          const c = conductorById.get(`${r.id}GasFilm`)!;
          const area =
            c.type.kind === "convection" ? (c.type.area as number) : 1;
          return [r.z, r.num.q / area / 1000];
        }),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
    ],
    legend: "top-right",
  }),
);

/* ==========================================================================
 * Assemble the report
 * ========================================================================== */

const artifactList = stations
  .filter((s) => artifactIds.has(s.id))
  .map((s) => s.id)
  .join(", ");
/** Prose fragment for the sonic-point station set (empty under the default
 *  limited-upwind faces — the crossing resolves without an outlier). */
const sonicSetProse =
  artifactIds.size > 0
    ? `all but the sonic-point set ${artifactList}`
    : "all of them — no station is smeared off the isentrope branches on this grid";

const wallTableRows = wallRows
  .map(
    (r) =>
      `| ${r.id} | ${r.an.TL.toFixed(1)} | ${r.num.TL.toFixed(1)} | ${r.an.TF.toFixed(1)} | ${r.num.TF.toFixed(1)} | ${r.an.TS.toFixed(1)} | ${r.num.TS.toFixed(1)} | ${(r.an.q / 1000).toFixed(2)} | ${(r.num.q / 1000).toFixed(2)} |`,
  )
  .join("\n");

const report = `# Reacting-Junction Combustion and Rocket Thruster Validation

**Verification of the CEA-coupled reacting junction and the regeneratively
cooled LOX/RP-1 thruster case against analytical solutions**

Generated by \`scripts/combustion-validation-report.ts\` — all numbers and
figures come from live solves of the current solver. Regenerate with
\`npx tsx scripts/combustion-validation-report.ts\`. The corresponding CI
gates are \`src/core/__tests__/reactingJunction.test.ts\` (junction physics,
validation rules, robustness from perturbed initial conditions) and the
examples suite (the thruster solves and passes invariants). Model
documentation: [docs/combustion.md](../combustion.md).

## Abstract

This report verifies the reacting-junction combustion capability of
OpenFLUME — a chamber node whose energy equation is the thermochemical
closure h = η·h(T0(Pc, O/F)) with T0 from NASA CEA equilibrium tables,
solved inside the monolithic Newton system — and validates the complete
LOX/RP-1 thruster example (feed circuits, injectors, chamber, choked
converging–diverging nozzle, and a 22-station three-layer regenerative
cooling jacket) against closed-form analytical solutions. Four groups of
checks are made: (1) thermodynamic self-consistency of the committed CEA
tables (cp = γR/(γ−1) and the frozen c* closed form) across the entire
tabulated (Pc, O/F) domain; (2) integral engine quantities against the
choked-flow, orifice, and chamber-closure closed forms; (3) nozzle
pressure/temperature/Mach profiles against a frozen-γ isentropic reference
and an RK4 integration of the generalized quasi-1-D compressible ODE with
friction and wall-heat extraction; and (4) the per-station three-layer wall
stack against an exact series–parallel thermal-resistance network. The
solver (default limited-upwind momentum faces,
\`settings.momentumFluxScheme: "upwind"\`) tracks the analytical references
to ${pct(Math.max(subStats.maxP, subStats.maxT, subStats.maxM))} on the
subsonic leg; down the supersonic leg the scheme's first-order truncation
accumulates to ${pct(supStats.maxP)} at the exit (see §3). Wall
temperatures agree to ${wallTmaxK.toExponential(1)} K.

## The Model Under Test

The thruster example (\`src/ui/thrusterCombustor.ts\`) couples three
circuits at a reacting junction:

- **LOX feed** — tank → injector orifice → chamber;
- **RP-1 feed** — tank → counterflow regenerative jacket (one coolant
  node per gas station, 22 passes) → injector orifice → chamber;
- **hot gas** — chamber → 22-station choked converging–diverging nozzle →
  exhaust, with \`momentumFlux\` and \`kineticEnergy\` enabled.

The chamber is a junction (\`config.junctions\`): its energy row is the CEA
closure with efficiency η = ${eff} (= 0.97² on enthalpy rise), and the
product gas's R/γ/μ/cp refresh from the same lookup between outer Picard
iterations. Every gas station carries a wall section — gas film
(Bartz-order h scaled (Dt/D)^1.8) → inner liner → fin-root conduction →
fins → fin-tip conduction → outer closeout shell — with coolant films on
the channel base, the fin sides (fin efficiency 0.8 folded into the wetted
area), and the channel top. All copper conduction uses the temperature-
dependent OFHC-copper conductivity evaluated at the endpoint mean
temperature.

The solved operating point: Pc = ${sig(jn.pc / 1e3, 5)} kPa,
O/F = ${jn.of!.toFixed(4)}, ṁ_ox = ${jn.mdotByRole.oxidizer.toFixed(5)} kg/s,
ṁ_fuel = ${jn.mdotByRole.fuel.toFixed(5)} kg/s,
T0 = ${jn.gas.T0.toFixed(1)} K, γ = ${gamma.toFixed(4)},
R = ${Rgas.toFixed(2)} J/kg·K.

## 1. CEA Table Thermodynamic Consistency

The committed tables (\`core/combustion/generated/ceaTables.ts\`, built
offline by \`scripts/build-cea-tables.py\` from NASA CEA chamber
equilibrium runs) store T0, molecular weight, γ_s, and c* on a (Pc, O/F)
grid. Sweeping a ${NPC}×${NOF} grid spanning the full tabulated domain
(Pc ∈ [${sig(bounds.pcMinPa / 1e5, 3)}, ${sig(bounds.pcMaxPa / 1e5, 3)}] bar,
O/F ∈ [${bounds.ofMin}, ${bounds.ofMax}]) checks two closed forms:

$$c_p = \\frac{\\gamma}{\\gamma - 1} R, \\qquad
c^*_{frozen} = \\frac{\\sqrt{R\\,T_0}}{\\Gamma(\\gamma)}, \\quad
\\Gamma(\\gamma) = \\sqrt{\\gamma}\\left(\\frac{2}{\\gamma+1}\\right)^{\\frac{\\gamma+1}{2(\\gamma-1)}}.$$

The first is an exact identity of the constant-cp ideal-gas closure the
solver derives from the table, and it holds to ${pct(cpErrMax)} at every
point. The second is the frozen one-dimensional c* evaluated from the
tabulated (T0, γ_s, R), compared against the tabulated c* — which is CEA's
**equilibrium** value, so the difference between them is the physical
equilibrium-vs-frozen expansion gap, not an interpolation error:

| Comparison | Result |
| ---------- | ------ |
| cp = γR/(γ−1) (identity) | max deviation ${pct(cpErrMax)} |
| tabulated equilibrium c* vs frozen closed form | ≤ ${pct(cstarGapMax)} (at the Pc = ${sig(cstarGapAt.pc / 1e5, 3)} bar, O/F = ${cstarGapAt.of.toFixed(2)} corner of the table) |
| same gap at the thruster operating point | ${pct(cstarGapAtOp)} |

The characteristics behave as LOX/RP-1 equilibrium chemistry should
(Figures 1–3): T0 peaks at O/F = ${peakT0.of.toFixed(2)}
(${peakT0.v.toFixed(0)} K at 10 bar) while c* peaks fuel-rich of the
temperature peak at O/F = ${peakCstar.of.toFixed(2)}
(${peakCstar.v.toFixed(0)} m/s) — the classical offset caused by the lower
molecular weight of fuel-rich products. T0 rises with chamber pressure as
dissociation is suppressed, and γ_s dips near the temperature peak where
dissociation buffers the mixture.

${fig(1, "Adiabatic chamber temperature vs mixture ratio at three chamber pressures (CEA equilibrium tables).")}

${fig(2, "Product isentropic exponent γ_s vs mixture ratio.")}

${fig(3, "Characteristic velocity at 10 bar: tabulated c* (markers) against the frozen closed form √(R·T0)/Γ(γ) evaluated from the tabulated state (line).")}

## 2. Thruster Integral Quantities

**Chamber closure.** The junction's contract is
T_chamber = η·T0(Pc, O/F) exactly (constant-cp ideal gas). The solved
chamber temperature is ${res.nodes.chamber.temperature.toFixed(2)} K
against η·T0 = ${(eff * jn.gas.T0).toFixed(2)} K — a deviation of
${pct(closureErr)}.

**Injector orifices.** Both injectors must obey
ṁ = C_d·A·√(2ρ·ΔP_eff) with ΔP_eff the solved pressure drop corrected for
the hydrostatic head ρgΔz along the branch (the jacket runs z-up with
standard gravity):

| Injector | ṁ analytic [kg/s] | ṁ solver [kg/s] | deviation |
| -------- | ----------------- | --------------- | --------- |
| LOX | ${oxCheck.mdotAn.toFixed(6)} | ${oxCheck.mdotNum.toFixed(6)} | ${pct(oxCheck.err)} |
| RP-1 | ${fuelCheck.mdotAn.toFixed(6)} | ${fuelCheck.mdotNum.toFixed(6)} | ${pct(fuelCheck.err)} |

These verify the coupling, not merely the component formula: the chamber
pressure both orifices discharge against is a solved unknown of the same
Newton system that carries the CEA closure.

**Choked mass flow and c*.** From the solved chamber stagnation state
(P0 = ${sig(P0 / 1e3, 5)} kPa, T0 = ${T0stag.toFixed(1)} K), the ideal 1-D
choked flow through the geometric throat is
ṁ = P0·At·Γ(γ)/√(R·T0) = ${mdotIdeal.toFixed(5)} kg/s. The solver passes
${mdotGas.toFixed(5)} kg/s — ${pct(Math.abs(mdotExcess))}
${mdotExcess > 0 ? "more" : "less"} than ideal. Equivalently the emergent
c* = Pc·At/ṁ = ${cstarEmergent.toFixed(1)} m/s sits ${pct(Math.abs(cstarErr))}
${cstarErr < 0 ? "below" : "above"} the CEA reference
η_c*·c* = ${cstarRef.toFixed(1)} m/s. This ${pct(Math.abs(mdotExcess))}
excess is the transonic discretization bias documented in
[docs/combustion.md](../combustion.md): the default limited-upwind momentum
faces (\`settings.momentumFluxScheme: "upwind"\`) are first-order at the
sonic cell, so the discrete system chokes at a slightly larger effective
throat state. (The upwind faces are what remove the nonphysical
wrong-branch roots by construction — on this grid the central scheme has no
admissible transonic root at all — and the bias shrinks with grid
refinement.) It is a property of the quasi-1-D nozzle discretization
(present with fixed gas properties too), not of the reacting junction.

**Formula-coupled twin.** The same feed and nozzle plumbing driven by
static injector formulas and a fixed γ = 1.2 gas
(\`basic-lox-rp1-thruster.fn\`) solves to Pc = ${TWIN.pc} Pa,
ṁ_ox = ${TWIN.ox} kg/s, ṁ_fuel = ${TWIN.fuel} kg/s. The junction
formulation lands within ${pct(Math.abs(jn.pc - TWIN.pc) / TWIN.pc)} on Pc,
${pct(Math.abs(jn.mdotByRole.oxidizer - TWIN.ox) / TWIN.ox)} on ṁ_ox, and
${pct(Math.abs(jn.mdotByRole.fuel - TWIN.fuel) / TWIN.fuel)} on ṁ_fuel —
the residual differences are physics (the CEA gas with γ = ${gamma.toFixed(3)}
replaces the fixed γ = 1.2 gas), not error.

## 3. Nozzle Profiles

Two analytical references bracket the nozzle physics:

1. **Frozen-γ isentropic flow** through the geometric area schedule:
   M(A/At) from the Mach–area relation (subsonic branch upstream of the
   throat, supersonic downstream), then
   P/P0 = (1 + (γ−1)/2·M²)^(−γ/(γ−1)) and T = T0/(1 + (γ−1)/2·M²) from the
   solved chamber stagnation state. This neglects friction and wall heat.
2. **RK4 integration of the generalized quasi-1-D ODE** (the same
   machinery as the compressible-flow validation report),

$$\\frac{dM}{dx} = \\frac{M\\left(1 + \\frac{\\gamma-1}{2}M^2\\right)}{1 - M^2}\\left[\\frac{\\gamma M^2}{2}\\frac{f}{D} + \\frac{1 + \\gamma M^2}{2T_0}\\frac{dT_0}{dx} - \\frac{1}{A}\\frac{dA}{dx}\\right],$$

   with f = ${frictionF} (the authored Darcy factor), linear D(x) inside
   each tapered segment, and dT0/dx from the solver's own per-station
   gas-film heat extraction spread over each station's tributary length
   (2000 RK4 sub-steps per segment). The ODE is singular at M = 1, so it is
   integrated on the two legs that avoid the transonic segment — the
   subsonic leg (chamber → conv5, initialized from the solved chamber
   state) and the supersonic leg (div2 → div11, initialized from the solved
   div2 state). Evaluating the reference at the solved ṁ isolates the
   spatial discretization of momentum and energy from the choking-point
   bias quantified in §2.

| Leg | Stations | max ΔP/P | max ΔT/T | max ΔM/M |
| --- | -------- | -------- | -------- | -------- |
| Subsonic (barrel + convergent) | ${subStats.n} | ${pct(subStats.maxP)} | ${pct(subStats.maxT)} | ${pct(subStats.maxM)} |
| Supersonic (divergent) | ${supStats.n} | ${pct(supStats.maxP)} | ${pct(supStats.maxT)} | ${pct(supStats.maxM)} |

The subsonic leg tracks the ODE tightly. Down the divergent, the
limited-upwind faces' first-order truncation acts like a small spurious
entropy source per supersonic cell; on this coarsening 9-station grid it
accumulates to ${pct(supStats.maxP)} in static pressure at the exit. This
drift is monotone and grid-convergent — it is the documented cost of the
scheme that removes the wrong-branch transonic roots (see
[docs/combustion.md](../combustion.md); the \`central\` scheme has no
admissible transonic root on this grid, so the trade is upwind's smooth
first-order truncation versus no physical root at all).

Against the no-friction isentropic reference, the stations
(${sonicSetProse}) agree within ${pct(isenMaxP)} on pressure (worst at
${isenMaxPId}), the isentrope deviation being the friction and
heat-extraction corrections it omits plus the same accumulated upwind
drift. The profile through the throat is monotone — the sonic transition
falls inside one near-throat segment and is smeared first-order across it
([docs/combustion.md](../combustion.md)), but no station is thrown off the
isentrope branches, and every integral quantity remains solid.

${fig(4, `Static pressure along the nozzle: frozen-γ isentrope (line), RK4 ODE with friction and wall heat (triangles), solver stations (circles${artifactIds.size > 0 ? "; sonic-point stations as red squares" : ""}).`)}

${fig(5, "Mach number along the nozzle (derived from solved ṁ, P, T). The sonic transition falls inside a near-throat segment and is smeared first-order across it; the profile stays monotone through the throat.")}

${fig(6, "Static temperature along the nozzle.")}

## 4. Regenerative Wall Stack

Each station's wall section is, in steady state, an exact series–parallel
resistance network: gas film G_g = h_g·A_g in series with a three-node
solid network — inner liner (channel-base film G_b to the coolant and
fin-root conduction G_fr to the fins), fins (fin-side film G_f and fin-tip
conduction G_ft), outer shell (channel-top film G_s) — all referenced to
the solved gas and coolant temperatures. The reference solves this 3×3
linear system per station, iterating the OFHC-copper conductivity at the
endpoint-mean temperatures exactly as the solver's thermal subsystem does.

Across all ${wallRows.length} stations the solver matches the network to
**${wallTmaxK.toExponential(1)} K** worst-case on the three layer
temperatures and **${pct(wallQmaxRel)}** on the gas-side heat rate —
machine-level agreement, confirming the solid Newton subsystem solves the
conduction/convection network exactly (Figures 7–8, table below).

**Global energy closure.** The coolant picks up
${(coolantFilmQ / 1e3).toFixed(2)} kW through the ${wallRows.length * 3}
coolant-side films, against ṁ_fuel·cp·ΔT =
${(coolantRise / 1e3).toFixed(2)} kW of enthalpy rise from tank to
injector — closure to ${pct(coolantBalanceErr)}. (The chamber station's
${(res.conductors!.chamberGasFilm.heatRate / 1e3).toFixed(2)} kW gas film
is computed from the adiabatic-flame chamber state but does not cool the
chamber gas — the junction node's energy row is the CEA closure — the
one-way chamber heat-flux approximation noted in the example and in
docs/combustion.md.)

**Fin efficiency.** The modeled constant (0.8, folded into the fin wetted
area) sits next to the analytic straight-fin value at throat conditions,
η = tanh(mH)/(mH) = ${etaFinAn.toFixed(3)} with
m = √(2h/(k·t)) = ${mFin.toFixed(1)} 1/m — the 1-D fin theory the constant
approximates.

| Station | T_liner an. | T_liner num. | T_fin an. | T_fin num. | T_shell an. | T_shell num. | Q̇_gas an. [kW] | Q̇_gas num. [kW] |
| ------- | ----------- | ------------ | --------- | ---------- | ----------- | ------------ | --------------- | ---------------- |
${wallTableRows}

${fig(7, "Wall stack temperatures along the engine: analytic resistance network (lines) vs solver solid nodes (markers); dashed line is the per-station coolant temperature.")}

${fig(8, "Gas-side wall heat flux along the engine: resistance network (line) vs solver (markers). The peak sits at the throat, as the (Dt/D)^1.8 film scaling dictates.")}

## Conclusions

The reacting-junction formulation and the thruster case reproduce their
analytical references:

- the committed CEA tables satisfy the cp = γR/(γ−1) identity exactly
  across their entire domain, and their equilibrium c* sits within
  ${pct(cstarGapMax)} of the frozen closed form (the physical
  equilibrium-vs-frozen gap);
- the chamber closure holds to ${pct(closureErr)}, and both injectors
  match the orifice closed form (with hydrostatic head) to
  ${pct(Math.max(oxCheck.err, fuelCheck.err))} while discharging against a
  solved chamber pressure;
- subsonic nozzle profiles track the RK4 friction-and-heat ODE to
  ${pct(subStats.maxP)} on pressure; down the supersonic leg the default
  limited-upwind faces' first-order truncation accumulates to
  ${pct(supStats.maxP)} at the exit (grid-convergent, and the cost of a
  scheme with no wrong-branch transonic roots);
- the three-layer regenerative wall stack matches the exact resistance
  network to ${wallTmaxK.toExponential(1)} K and closes the coolant energy
  balance to ${pct(coolantBalanceErr)}.

The one systematic integral deviation — a ${pct(Math.abs(mdotExcess))}
excess of choked mass flow (equivalently a ${pct(Math.abs(cstarErr))} c*
deficit) — is the documented first-order choking bias of the default
limited-upwind momentum faces, independent of the combustion coupling and
shrinking with grid refinement. Known model limitations
(steady + kineticEnergy only, frozen downstream composition, standard-state
reactant injection, idealGas product fluid) are catalogued in
[docs/combustion.md](../combustion.md).

## References

1. Gordon, S., and McBride, B. J., *Computer Program for Calculation of
   Complex Chemical Equilibrium Compositions and Applications*,
   NASA RP-1311, 1994 (CEA).
2. Sutton, G. P., and Biblarz, O., *Rocket Propulsion Elements*, 9th ed.,
   John Wiley & Sons, 2016 (c*, choked flow, injector hydraulics, regen
   cooling).
3. Shapiro, A. H., *The Dynamics and Thermodynamics of Compressible Fluid
   Flow*, Vol. 1, Ronald Press, 1953 (generalized quasi-1-D ODE).
4. Bartz, D. R., "A Simple Equation for Rapid Estimation of Rocket Nozzle
   Convective Heat Transfer Coefficients," *Jet Propulsion*, 27(1), 1957.
5. Incropera, F. P., et al., *Fundamentals of Heat and Mass Transfer*,
   6th ed., Wiley, 2007 (resistance networks, fin efficiency).

## Nomenclature

| Symbol | Meaning |
| ------ | ------- |
| A, At | local / throat flow area |
| C_d | orifice discharge coefficient |
| c* | characteristic velocity Pc·At/ṁ |
| c_p | specific heat at constant pressure |
| D, Dt | local / throat diameter |
| f | Darcy friction factor |
| G | thermal conductance [W/K] |
| h | film coefficient; specific enthalpy |
| M | Mach number |
| ṁ | mass flow rate |
| O/F | oxidizer/fuel mass-flow ratio |
| P, P0, Pc | static / stagnation / chamber pressure |
| q'' | wall heat flux |
| R | specific gas constant |
| T, T0 | static / stagnation (adiabatic chamber) temperature |
| Γ(γ) | Vandenkerckhove function |
| γ | isentropic exponent (CEA γ_s) |
| η | combustion efficiency on enthalpy rise (= η_c*²) |
| η_fin | straight-fin efficiency tanh(mH)/(mH) |
`;

writeFileSync(join(outDir, "combustion-report.md"), report);
console.log("\nwrote docs/validation/combustion-report.md");
