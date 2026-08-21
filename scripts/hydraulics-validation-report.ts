/**
 * hydraulics-validation-report.ts — generates the steady incompressible
 * network-hydraulics validation report
 * (docs/validation/incompressible-hydraulics-report.md) and its seven SVG
 * figures (docs/validation/figures/hydraulics/), following the repo's
 * established report pattern (scripts/compressible-validation-report.ts).
 *
 * Six benchmark cases, each with an exact (or independently converged)
 * reference computed in this script:
 *
 *   1. Laminar pipe flow           — Hagen–Poiseuille closed form
 *   2. Turbulent pipe flow         — Darcy–Weisbach with fixed friction factor
 *   3. Parallel-pipe flow split    — fixed-f branch split closed form
 *   4. Multi-loop water network    — independent Newton solve of the loop/nodal
 *                                    equations (Hardy-Cross reference network,
 *                                    benchmark B1 geometry)
 *   5. Hydrostatics                — P = P₀ − ρgz, plus friction + ρgΔz riser
 *   6. Pump operating point        — pump-curve/system-curve intersection by
 *                                    bisection
 *
 * All numbers and figures come from live solves — rerun after solver changes:
 *
 *   npx tsx scripts/hydraulics-validation-report.ts
 *
 * The physics/setup mirrors src/core/__tests__/solver.test.ts and
 * src/core/__tests__/benchmarks.test.ts (the CI gates; this script is the
 * human-readable artifact).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { solveSteady, validateNetwork } from "../src/core";
import type { NetworkConfig, SteadyResult } from "../src/core";

/* ==========================================================================
 * Constants (SI) — water as incompressible liquid
 * ========================================================================== */

const RHO = 998; // kg/m³ (water preset)
const MU = 1e-3; // Pa·s
const G = 9.80665; // m/s²

const KPA = 1000;
const areaOf = (D: number) => (Math.PI / 4) * D * D;

/* ==========================================================================
 * Solve helpers
 * ========================================================================== */

function baseSettings(relaxation = 0.9): NetworkConfig["settings"] {
  return { mode: "steady", tolerance: 1e-9, maxIterations: 500, relaxation };
}

function runSolve(config: NetworkConfig): SteadyResult {
  const errors = validateNetwork(config);
  if (errors.length) throw new Error(`invalid network: ${errors.join("; ")}`);
  const res = solveSteady(config);
  if (!res.converged) {
    throw new Error(`solve did not converge for ${config.meta.name}`);
  }
  return res;
}

const relErr = (num: number, ref: number) =>
  Math.abs(num - ref) / Math.max(Math.abs(ref), 1e-300);

/** Percentage in scientific notation — for the ≪1 % errors of exact closures. */
const pctE = (x: number) => `${(x * 100).toExponential(2)} %`;
const fmt = (x: number, digits = 3) => x.toFixed(digits);

/* ==========================================================================
 * Independent reference solvers (dense Newton + bisection)
 * ========================================================================== */

function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    let maxVal = Math.abs(M[i][i]);
    for (let k = i + 1; k < n; k++) {
      const v = Math.abs(M[k][i]);
      if (v > maxVal) {
        maxVal = v;
        maxRow = k;
      }
    }
    if (maxVal < 1e-14) return new Array(n).fill(0);
    [M[i], M[maxRow]] = [M[maxRow], M[i]];
    for (let k = i + 1; k < n; k++) {
      const factor = M[k][i] / M[i][i];
      for (let j = i; j <= n; j++) M[k][j] -= factor * M[i][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n];
    for (let j = i + 1; j < n; j++) sum -= M[i][j] * x[j];
    x[i] = sum / M[i][i];
  }
  return x;
}

function bisection(
  f: (x: number) => number,
  lo: number,
  hi: number,
  tol = 1e-12,
  maxIter = 200,
): number {
  let flo = f(lo);
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const fmid = f(mid);
    if (Math.abs(hi - lo) < tol || Math.abs(fmid) < tol) return mid;
    if (flo * fmid <= 0) {
      hi = mid;
    } else {
      lo = mid;
      flo = fmid;
    }
  }
  return (lo + hi) / 2;
}

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
  const decimals = Math.max(
    0,
    -Math.floor(Math.log10(step)) + (step < 1 ? 0 : 0),
  );
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
  /** Default top-right; move when that corner sits on the data. */
  legend?:
    | "top-right"
    | "top-left"
    | "bottom-left"
    | "bottom-right"
    | "center-left"
    | "center-right";
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

  // Gridlines and ticks
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

  // Series
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

  // Legend
  const legendW =
    Math.max(...opts.series.map((s) => s.label.length)) * 6.4 + 44;
  const legendH = opts.series.length * 18 + 10;
  const pad = 8;
  const pos = opts.legend ?? "top-right";
  const lx = pos.endsWith("left") ? m.l + pad : m.l + pw - legendW - pad;
  const ly = pos.startsWith("top")
    ? m.t + pad
    : pos.startsWith("center")
      ? m.t + (ph - legendH) / 2
      : m.t + ph - legendH - pad;
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

/* Grouped bar chart (analytic vs numerical per category) */

function groupedBarChart(opts: {
  title: string;
  xLabel: string;
  yLabel: string;
  categories: string[];
  series: Array<{ label: string; values: number[]; color: string }>;
}): string {
  const W = 680;
  const H = 430;
  const m = { l: 76, r: 24, t: 46, b: 58 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const yMax = Math.max(...opts.series.flatMap((s) => s.values)) * 1.12;
  const sy = (y: number) => m.t + ph - (y / yMax) * ph;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">`,
    `<rect width="${W}" height="${H}" fill="white"/>`,
    `<text x="${W / 2}" y="24" text-anchor="middle" font-size="15" font-weight="bold">${opts.title}</text>`,
  );

  const yStep = niceStep(yMax, 6);
  for (let v = 0; v <= yMax + 1e-9; v += yStep) {
    const y = sy(v);
    parts.push(
      `<line x1="${m.l}" y1="${y}" x2="${m.l + pw}" y2="${y}" stroke="#e0e0e0" stroke-width="1"/>`,
      `<text x="${m.l - 8}" y="${y + 4}" text-anchor="end" font-size="11">${fmtTick(v, yStep)}</text>`,
    );
  }

  const nCat = opts.categories.length;
  const nSer = opts.series.length;
  const slot = pw / nCat;
  const barW = (slot * 0.62) / nSer;
  opts.categories.forEach((cat, ci) => {
    const cx = m.l + slot * (ci + 0.5);
    parts.push(
      `<text x="${cx}" y="${m.t + ph + 18}" text-anchor="middle" font-size="11">${cat}</text>`,
    );
    opts.series.forEach((s, si) => {
      const x = cx - (nSer * barW) / 2 + si * barW;
      const y = sy(s.values[ci]);
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 2).toFixed(1)}" height="${(m.t + ph - y).toFixed(1)}" fill="${s.color}" fill-opacity="${si === 0 ? 0.45 : 0.85}" stroke="${s.color}" stroke-width="1"/>`,
      );
    });
  });

  parts.push(
    `<rect x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="none" stroke="#333" stroke-width="1.2"/>`,
    `<text x="${m.l + pw / 2}" y="${H - 14}" text-anchor="middle" font-size="12.5">${opts.xLabel}</text>`,
    `<text x="20" y="${m.t + ph / 2}" text-anchor="middle" font-size="12.5" transform="rotate(-90 20 ${m.t + ph / 2})">${opts.yLabel}</text>`,
  );

  // Legend — swatches vertically centered on their text lines.
  const legendW =
    Math.max(...opts.series.map((s) => s.label.length)) * 6.4 + 44;
  const legendH = opts.series.length * 18 + 8;
  const lx = m.l + pw - legendW - 8;
  const ly = m.t + 8;
  parts.push(
    `<rect x="${lx}" y="${ly}" width="${legendW}" height="${legendH}" fill="white" fill-opacity="0.88" stroke="#999" stroke-width="0.8"/>`,
  );
  opts.series.forEach((s, i) => {
    const yy = ly + 16 + i * 18; // text baseline; 11px text centers ≈ yy − 4
    parts.push(
      `<rect x="${lx + 8}" y="${yy - 9}" width="22" height="10" fill="${s.color}" fill-opacity="${i === 0 ? 0.45 : 0.85}" stroke="${s.color}" stroke-width="1"/>`,
      `<text x="${lx + 36}" y="${yy}" font-size="11">${s.label}</text>`,
    );
  });

  parts.push("</svg>");
  return parts.join("\n");
}

/* ==========================================================================
 * Colors / marker assignments (copied from compressible-validation-report.ts)
 * ========================================================================== */

const C = {
  analytic: "#000000",
  blue: "#1f5fa8",
  red: "#c0392b",
  green: "#1e8449",
  orange: "#d68910",
};

/* ==========================================================================
 * Schematic figure: the multi-loop water network (benchmark B1 geometry)
 * ========================================================================== */

interface LoopBranchDef {
  id: string;
  from: string;
  to: string;
  k: number;
  A: number;
  R: number; // effective resistance: ΔP = R·ṁ·|ṁ|
}

const LOOP_A = 0.001;
const LOOP_BRANCHES: LoopBranchDef[] = [
  { id: "b1", from: "HP", to: "N1", k: 10, A: LOOP_A, R: 0 },
  { id: "b2", from: "N1", to: "N2", k: 5, A: LOOP_A, R: 0 },
  { id: "b3", from: "N2", to: "LP", k: 10, A: LOOP_A, R: 0 },
  { id: "b4", from: "HP", to: "N3", k: 8, A: LOOP_A, R: 0 },
  { id: "b5", from: "N3", to: "N4", k: 6, A: LOOP_A, R: 0 },
  { id: "b6", from: "N4", to: "LP", k: 8, A: LOOP_A, R: 0 },
  { id: "b7", from: "N3", to: "N5", k: 10, A: LOOP_A, R: 0 },
  { id: "b8", from: "N5", to: "N6", k: 5, A: LOOP_A, R: 0 },
  { id: "b9", from: "N6", to: "LP", k: 10, A: LOOP_A, R: 0 },
  { id: "b10", from: "N1", to: "N3", k: 2, A: LOOP_A, R: 0 },
  { id: "b11", from: "N2", to: "N4", k: 2, A: LOOP_A, R: 0 },
  { id: "b12", from: "N4", to: "N6", k: 2, A: LOOP_A, R: 0 },
];
for (const b of LOOP_BRANCHES) b.R = b.k / (2 * RHO * b.A * b.A);

function fig1LoopSchematic(): string {
  const W = 680;
  const H = 470;
  const nodePos: Record<string, [number, number]> = {
    HP: [110, 235],
    N1: [270, 105],
    N2: [430, 105],
    N3: [270, 235],
    N4: [430, 235],
    N5: [270, 365],
    N6: [430, 365],
    LP: [580, 235],
  };
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">`,
    `<rect width="${W}" height="${H}" fill="white"/>`,
    `<text x="${W / 2}" y="26" text-anchor="middle" font-size="15" font-weight="bold">Multi-loop water network (case 4)</text>`,
  );
  // The default midpoint offset sits on top of the diagonal branches, so
  // those get explicit placements clear of their lines.
  const labelPlacement: Record<
    string,
    { dx: number; dy: number; anchor?: "end" }
  > = {
    b1: { dx: -8, dy: -6, anchor: "end" }, // left of the HP–N1 diagonal
    b9: { dx: 8, dy: 16 }, // below the N6–LP diagonal
  };
  for (const b of LOOP_BRANCHES) {
    const [x1, y1] = nodePos[b.from];
    const [x2, y2] = nodePos[b.to];
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const o = labelPlacement[b.id] ?? { dx: 6, dy: -6 };
    parts.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#666" stroke-width="1.6"/>`,
      `<text x="${mx + o.dx}" y="${my + o.dy}"${o.anchor ? ` text-anchor="${o.anchor}"` : ""} font-size="10.5" fill="#333">${b.id} (K=${b.k})</text>`,
    );
  }
  for (const [id, [x, y]] of Object.entries(nodePos)) {
    const boundary = id === "HP" || id === "LP";
    parts.push(
      `<circle cx="${x}" cy="${y}" r="17" fill="${boundary ? "#fdebd0" : "#eef4fb"}" stroke="#333" stroke-width="1.6"/>`,
      `<text x="${x}" y="${y + 4}" text-anchor="middle" font-size="11.5" font-weight="bold">${id}</text>`,
    );
  }
  parts.push(
    `<text x="110" y="285" text-anchor="middle" font-size="11.5">500 kPa</text>`,
    `<text x="580" y="285" text-anchor="middle" font-size="11.5">100 kPa</text>`,
    `<text x="${W / 2}" y="${H - 34}" text-anchor="middle" font-size="12">All 12 branches are square-law resistances ΔP = K·ṁ|ṁ|/(2ρA²), A = 0.001 m².</text>`,
    `<text x="${W / 2}" y="${H - 14}" text-anchor="middle" font-size="12">Figure 1. Topology of the multi-loop network: two pressure boundaries, six internal nodes, four independent loops.</text>`,
    "</svg>",
  );
  return parts.join("\n");
}

/* ==========================================================================
 * Output setup
 * ========================================================================== */

const outDir = join(process.cwd(), "docs", "validation");
const figDir = join(outDir, "figures", "hydraulics");
mkdirSync(figDir, { recursive: true });

const figures: string[] = []; // figure filenames in order 1..7
function writeFig(n: number, name: string, svg: string): string {
  const file = `fig${String(n).padStart(2, "0")}-${name}.svg`;
  writeFileSync(join(figDir, file), svg);
  figures[n] = file;
  console.log(`  wrote figures/hydraulics/${file}`);
  return file;
}

console.log("Generating incompressible hydraulics validation report…");

/* ---------- schematic ---------- */
writeFig(1, "network-schematic", fig1LoopSchematic());

/* ==========================================================================
 * Case 1 — Laminar pipe flow (Hagen–Poiseuille)
 * ========================================================================== */
console.log("Case 1 — laminar pipe flow (Hagen–Poiseuille)");

const LAM = { D: 0.01, L: 10, Pin: 200_000 };

interface SweepPoint {
  dP: number;
  mdotAn: number;
  mdot: number;
  Re: number;
  err: number;
}

// Sweep Re from 200 to 1800 — all well inside the exact 64/Re laminar branch
// (solver cutoff Re = 2300).
const lamPoints: SweepPoint[] = [];
for (const ReTarget of [200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800]) {
  const mdotAn = (ReTarget * Math.PI * LAM.D * MU) / 4;
  const dP = (128 * MU * LAM.L * mdotAn) / (Math.PI * RHO * Math.pow(LAM.D, 4));
  const config: NetworkConfig = {
    meta: { name: "hydraulics case 1 laminar", version: 2 },
    settings: baseSettings(),
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "A",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: LAM.Pin,
        temperature: 300,
      },
      {
        id: "B",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: LAM.Pin - dP,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "p1",
        from: "A",
        to: "B",
        component: {
          type: "pipe",
          length: LAM.L,
          diameter: LAM.D,
          roughness: 0,
        },
      },
    ],
  };
  const res = runSolve(config);
  const mdot = res.branches.p1.mdot;
  lamPoints.push({
    dP,
    mdotAn,
    mdot,
    Re: res.branches.p1.reynolds,
    err: relErr(mdot, mdotAn),
  });
}
const lamMaxErr = Math.max(...lamPoints.map((p) => p.err));
const lamReMin = Math.min(...lamPoints.map((p) => p.Re));
const lamReMax = Math.max(...lamPoints.map((p) => p.Re));
console.log(
  `  ${lamPoints.length} points, Re ${lamReMin.toFixed(0)}–${lamReMax.toFixed(0)}, max mdot err = ${pctE(lamMaxErr)}`,
);

const lamDense: Array<[number, number]> = [];
{
  const dPMax = Math.max(...lamPoints.map((p) => p.dP));
  for (let i = 0; i <= 100; i++) {
    const dP = (dPMax * i) / 100;
    const mdotAn =
      (Math.PI * RHO * dP * Math.pow(LAM.D, 4)) / (128 * MU * LAM.L);
    lamDense.push([dP / KPA, mdotAn * 1000]);
  }
}
writeFig(
  2,
  "laminar-flow",
  lineChart({
    title: "Laminar pipe flow: mass flow vs pressure drop (Hagen–Poiseuille)",
    xLabel: "Pressure drop ΔP [kPa]",
    yLabel: "Mass flow rate ṁ [g/s]",
    legend: "top-left",
    series: [
      {
        label: "Analytical (Hagen–Poiseuille)",
        pts: lamDense,
        color: C.analytic,
        mode: "line",
      },
      {
        label: "Numerical (OpenFLUME)",
        pts: lamPoints.map((p): [number, number] => [
          p.dP / KPA,
          p.mdot * 1000,
        ]),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
    ],
  }),
);

/* ==========================================================================
 * Case 2 — Turbulent pipe flow (Darcy–Weisbach, fixed friction factor)
 * ========================================================================== */
console.log("Case 2 — turbulent pipe flow (Darcy–Weisbach, fixed f)");

const TURB = { D: 0.05, L: 10, f: 0.02, Pin: 300_000 };
const turbA = areaOf(TURB.D);

const turbPoints: SweepPoint[] = [];
{
  // Sweep ΔP over more than a decade: 8 log-spaced points, 5 kPa → 100 kPa.
  const n = 8;
  for (let i = 0; i < n; i++) {
    const dP = 5_000 * Math.pow(100_000 / 5_000, i / (n - 1));
    const mdotAn =
      turbA * Math.sqrt((2 * RHO * dP) / (TURB.f * (TURB.L / TURB.D)));
    const config: NetworkConfig = {
      meta: { name: "hydraulics case 2 turbulent", version: 2 },
      settings: baseSettings(),
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: TURB.Pin,
          temperature: 300,
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: TURB.Pin - dP,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "p1",
          from: "A",
          to: "B",
          component: {
            type: "pipe",
            length: TURB.L,
            diameter: TURB.D,
            roughness: 0,
            frictionFactor: TURB.f,
          },
        },
      ],
    };
    const res = runSolve(config);
    const mdot = res.branches.p1.mdot;
    turbPoints.push({
      dP,
      mdotAn,
      mdot,
      Re: res.branches.p1.reynolds,
      err: relErr(mdot, mdotAn),
    });
  }
}
const turbMaxErr = Math.max(...turbPoints.map((p) => p.err));
const turbReMin = Math.min(...turbPoints.map((p) => p.Re));
console.log(
  `  ${turbPoints.length} points, Re ≥ ${turbReMin.toExponential(1)}, max mdot err = ${pctE(turbMaxErr)}`,
);

const turbDense: Array<[number, number]> = [];
{
  const dPMax = Math.max(...turbPoints.map((p) => p.dP));
  for (let i = 0; i <= 120; i++) {
    const dP = (dPMax * i) / 120;
    const mdotAn =
      turbA * Math.sqrt((2 * RHO * dP) / (TURB.f * (TURB.L / TURB.D)));
    turbDense.push([dP / KPA, mdotAn]);
  }
}
writeFig(
  3,
  "turbulent-flow",
  lineChart({
    title: `Turbulent pipe flow: mass flow vs pressure drop (fixed f = ${TURB.f})`,
    xLabel: "Pressure drop ΔP [kPa]",
    yLabel: "Mass flow rate ṁ [kg/s]",
    legend: "top-left",
    series: [
      {
        label: "Analytical (Darcy–Weisbach)",
        pts: turbDense,
        color: C.analytic,
        mode: "line",
      },
      {
        label: "Numerical (OpenFLUME)",
        pts: turbPoints.map((p): [number, number] => [p.dP / KPA, p.mdot]),
        color: C.red,
        mode: "markers",
        marker: "square",
      },
    ],
  }),
);

/* ==========================================================================
 * Case 3 — Parallel-pipe flow split
 * ========================================================================== */
console.log("Case 3 — parallel-pipe flow split");

const PAR = {
  Pin: 250_000,
  Pout: 200_000,
  pipes: [
    { id: "p1", D: 0.04, L: 8, f: 0.02 },
    { id: "p2", D: 0.06, L: 12, f: 0.025 },
    { id: "p3", D: 0.025, L: 6, f: 0.03 },
  ],
};
const parDP = PAR.Pin - PAR.Pout;
const parAnalytic = PAR.pipes.map(
  (p) => areaOf(p.D) * Math.sqrt((2 * RHO * parDP * p.D) / (p.f * p.L)),
);
const parConfig: NetworkConfig = {
  meta: { name: "hydraulics case 3 parallel", version: 2 },
  settings: baseSettings(),
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    {
      id: "A",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: PAR.Pin,
      temperature: 300,
    },
    {
      id: "B",
      type: "boundary",
      x: 1,
      y: 0,
      pressure: PAR.Pout,
      temperature: 300,
    },
  ],
  branches: PAR.pipes.map((p) => ({
    id: p.id,
    from: "A",
    to: "B",
    component: {
      type: "pipe" as const,
      length: p.L,
      diameter: p.D,
      roughness: 0,
      frictionFactor: p.f,
    },
  })),
};
const parRes = runSolve(parConfig);
const parNumerical = PAR.pipes.map((p) => parRes.branches[p.id].mdot);
const parErrs = parNumerical.map((m, i) => relErr(m, parAnalytic[i]));
const parTotalAn = parAnalytic.reduce((a, b) => a + b, 0);
const parTotalNum = parNumerical.reduce((a, b) => a + b, 0);
const parMaxErr = Math.max(...parErrs);
const parTotalErr = relErr(parTotalNum, parTotalAn);
console.log(
  `  branch errs = [${parErrs.map((e) => pctE(e)).join(", ")}], total err = ${pctE(parTotalErr)}`,
);

writeFig(
  4,
  "parallel-split",
  groupedBarChart({
    title: "Parallel-pipe flow split: branch mass flows at ΔP = 50 kPa",
    xLabel: "Branch",
    yLabel: "Mass flow rate ṁ [kg/s]",
    categories: PAR.pipes.map(
      (p) => `${p.id} (D=${(p.D * 1000).toFixed(0)} mm, L=${p.L} m, f=${p.f})`,
    ),
    series: [
      { label: "Analytical", values: parAnalytic, color: C.analytic },
      { label: "Numerical", values: parNumerical, color: C.blue },
    ],
  }),
);

/* ==========================================================================
 * Case 4 — Multi-loop water network (Hardy-Cross reference, benchmark B1)
 * ========================================================================== */
console.log("Case 4 — multi-loop water network");

const HP_P = 500_000;
const LP_P = 100_000;
const loopInternalIds = ["N1", "N2", "N3", "N4", "N5", "N6"];

const loopConfig: NetworkConfig = {
  meta: { name: "hydraulics case 4 multi-loop", version: 2 },
  settings: {
    mode: "steady",
    tolerance: 1e-9,
    maxIterations: 500,
    relaxation: 0.8,
  },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    {
      id: "HP",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: HP_P,
      temperature: 300,
    },
    {
      id: "N1",
      type: "internal",
      x: 1,
      y: 2,
      pressure: 400_000,
      temperature: 300,
    },
    {
      id: "N2",
      type: "internal",
      x: 2,
      y: 2,
      pressure: 300_000,
      temperature: 300,
    },
    {
      id: "N3",
      type: "internal",
      x: 1,
      y: 1,
      pressure: 400_000,
      temperature: 300,
    },
    {
      id: "N4",
      type: "internal",
      x: 2,
      y: 1,
      pressure: 300_000,
      temperature: 300,
    },
    {
      id: "N5",
      type: "internal",
      x: 1,
      y: 0,
      pressure: 400_000,
      temperature: 300,
    },
    {
      id: "N6",
      type: "internal",
      x: 2,
      y: 0,
      pressure: 300_000,
      temperature: 300,
    },
    {
      id: "LP",
      type: "boundary",
      x: 3,
      y: 1,
      pressure: LP_P,
      temperature: 300,
    },
  ],
  branches: LOOP_BRANCHES.map((b) => ({
    id: b.id,
    from: b.from,
    to: b.to,
    component: { type: "resistance" as const, k: b.k, area: b.A },
  })),
};
const loopRes = runSolve(loopConfig);

// Independent reference: Newton iteration on the nodal continuity equations
// with the exact square-law branch relation ṁ = sign(ΔP)·√(|ΔP|/R), converged
// to a mass residual < 1e-12 kg/s (finite-difference Jacobian, dense solve).
const refP = new Map<string, number>();
for (const id of loopInternalIds) refP.set(id, (HP_P + LP_P) / 2);
const nodeP = (id: string): number =>
  id === "HP" ? HP_P : id === "LP" ? LP_P : refP.get(id)!;
const massResiduals = (): number[] => {
  const F = new Array(loopInternalIds.length).fill(0);
  for (const b of LOOP_BRANCHES) {
    const dp = nodeP(b.from) - nodeP(b.to);
    const mdot = Math.sign(dp) * Math.sqrt(Math.abs(dp) / b.R);
    const iFrom = loopInternalIds.indexOf(b.from);
    const iTo = loopInternalIds.indexOf(b.to);
    if (iFrom >= 0) F[iFrom] -= mdot;
    if (iTo >= 0) F[iTo] += mdot;
  }
  return F;
};
let refIterations = 0;
for (let iter = 0; iter < 500; iter++) {
  refIterations = iter + 1;
  const F = massResiduals();
  if (Math.max(...F.map(Math.abs)) < 1e-12) break;
  const J = Array.from({ length: loopInternalIds.length }, () =>
    new Array(loopInternalIds.length).fill(0),
  );
  for (let k = 0; k < loopInternalIds.length; k++) {
    const id = loopInternalIds[k];
    const h = Math.max(Math.abs(refP.get(id)!), 1.0) * 1e-7;
    refP.set(id, refP.get(id)! + h);
    const Fp = massResiduals();
    for (let j = 0; j < loopInternalIds.length; j++)
      J[j][k] = (Fp[j] - F[j]) / h;
    refP.set(id, refP.get(id)! - h);
  }
  const dP = solveLinear(
    J,
    F.map((v) => -v),
  );
  for (let k = 0; k < loopInternalIds.length; k++) {
    refP.set(loopInternalIds[k], refP.get(loopInternalIds[k])! + 0.9 * dP[k]);
  }
}
const refFlows = new Map<string, number>();
for (const b of LOOP_BRANCHES) {
  const dp = nodeP(b.from) - nodeP(b.to);
  refFlows.set(b.id, Math.sign(dp) * Math.sqrt(Math.abs(dp) / b.R));
}

let loopMaxFlowErr = 0;
for (const b of LOOP_BRANCHES) {
  loopMaxFlowErr = Math.max(
    loopMaxFlowErr,
    relErr(loopRes.branches[b.id].mdot, refFlows.get(b.id)!),
  );
}
let loopMaxPErr = 0;
for (const id of loopInternalIds) {
  loopMaxPErr = Math.max(
    loopMaxPErr,
    relErr(loopRes.nodes[id].pressure, refP.get(id)!),
  );
}

// Loop-closure check: signed ΔP sums around the four independent loops of the
// solved network must vanish (Kirchhoff's second law).
const loopDefs = [
  {
    name: "HP–N1–N2–N4–N3–HP",
    branches: ["b1", "b2", "b11", "b5", "b4"],
    signs: [1, 1, 1, -1, -1],
  },
  {
    name: "N1–N3–N4–N2–N1",
    branches: ["b10", "b5", "b11", "b2"],
    signs: [1, 1, -1, -1],
  },
  {
    name: "N3–N5–N6–N4–N3",
    branches: ["b7", "b8", "b12", "b5"],
    signs: [1, 1, -1, -1],
  },
  { name: "N2–LP–N4–N2", branches: ["b3", "b6", "b11"], signs: [1, -1, -1] },
];
const sysDP = HP_P - LP_P;
let loopMaxClosure = 0;
for (const loop of loopDefs) {
  let sum = 0;
  for (let i = 0; i < loop.branches.length; i++) {
    sum += loop.signs[i] * loopRes.branches[loop.branches[i]].dP;
  }
  loopMaxClosure = Math.max(loopMaxClosure, Math.abs(sum) / sysDP);
}
console.log(
  `  reference Newton: ${refIterations} iterations; max flow err = ${pctE(loopMaxFlowErr)}, max node-P err = ${pctE(loopMaxPErr)}, max loop closure = ${loopMaxClosure.toExponential(1)}`,
);

{
  const flowsRef = LOOP_BRANCHES.map((b) => refFlows.get(b.id)!);
  const lo = Math.min(...flowsRef) * 0.9;
  const hi = Math.max(...flowsRef) * 1.05;
  writeFig(
    5,
    "loop-parity",
    lineChart({
      title: "Multi-loop network: branch-flow parity (12 branches)",
      xLabel: "Reference mass flow ṁ [kg/s] (independent Newton)",
      yLabel: "Solver mass flow ṁ [kg/s]",
      legend: "top-left",
      series: [
        {
          label: "Perfect agreement (y = x)",
          pts: [
            [lo, lo],
            [hi, hi],
          ],
          color: C.analytic,
          mode: "line",
          dash: "6 4",
        },
        {
          label: "OpenFLUME branches",
          pts: LOOP_BRANCHES.map((b): [number, number] => [
            refFlows.get(b.id)!,
            loopRes.branches[b.id].mdot,
          ]),
          color: C.green,
          mode: "markers",
          marker: "diamond",
        },
      ],
    }),
  );
}

/* ==========================================================================
 * Case 5 — Hydrostatics (static column + flowing inclined riser)
 * ========================================================================== */
console.log("Case 5 — hydrostatics");

// (a) Static vertical column: 10 stacked pipe segments, boundary pressures in
// exact hydrostatic balance → the solver must recover P(z) = P0 − ρgz at the
// interior nodes with (near-)zero flow.
const COL = { nSeg: 10, h: 2, D: 0.02, P0: 300_000 };
const colH = COL.nSeg * COL.h;
const colTopP = COL.P0 - RHO * G * colH;
const colNodes: NetworkConfig["nodes"] = [];
const colBranches: NetworkConfig["branches"] = [];
for (let i = 0; i <= COL.nSeg; i++) {
  const z = i * COL.h;
  const Pan = COL.P0 - RHO * G * z;
  if (i === 0) {
    colNodes.push({
      id: "c0",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: COL.P0,
      temperature: 300,
    });
  } else if (i === COL.nSeg) {
    colNodes.push({
      id: `c${i}`,
      type: "boundary",
      x: 0,
      y: i,
      pressure: colTopP,
      temperature: 300,
    });
  } else {
    colNodes.push({
      id: `c${i}`,
      type: "internal",
      x: 0,
      y: i,
      pressure: Pan,
      temperature: 300,
    });
  }
}
for (let i = 0; i < COL.nSeg; i++) {
  colBranches.push({
    id: `cb${i}`,
    from: `c${i}`,
    to: `c${i + 1}`,
    component: {
      type: "pipe",
      length: COL.h,
      diameter: COL.D,
      roughness: 0,
      elevationChange: COL.h,
    },
  });
}
const colConfig: NetworkConfig = {
  meta: { name: "hydraulics case 5 static column", version: 2 },
  settings: baseSettings(),
  fluid: { model: "incompressible", preset: "water" },
  nodes: colNodes,
  branches: colBranches,
};
const colRes = runSolve(colConfig);
let colMaxDev = 0; // Pa
for (let i = 1; i < COL.nSeg; i++) {
  const z = i * COL.h;
  const Pan = COL.P0 - RHO * G * z;
  colMaxDev = Math.max(
    colMaxDev,
    Math.abs(colRes.nodes[`c${i}`].pressure - Pan),
  );
}
const colSpan = RHO * G * colH;
const colMaxDevRel = colMaxDev / colSpan;
const colMaxMdot = Math.max(
  ...colBranches.map((b) => Math.abs(colRes.branches[b.id].mdot)),
);
console.log(
  `  static column: max node-P deviation = ${colMaxDev.toExponential(2)} Pa (${pctE(colMaxDevRel)} of ρgH), max |mdot| = ${colMaxMdot.toExponential(2)} kg/s`,
);

// (b) Flowing inclined riser: fixed-f pipe with elevation change; the boundary
// ΔP is friction + ρgΔz, so ṁ has the exact Darcy closed form.
const RISER = { L: 20, D: 0.05, f: 0.02, dz: 5, dPfric: 30_000, Pbot: 300_000 };
const riserMdotAn =
  areaOf(RISER.D) *
  Math.sqrt((2 * RHO * RISER.dPfric) / (RISER.f * (RISER.L / RISER.D)));
const riserPtop = RISER.Pbot - (RHO * G * RISER.dz + RISER.dPfric);
const riserConfig: NetworkConfig = {
  meta: { name: "hydraulics case 5 riser", version: 2 },
  settings: baseSettings(),
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    {
      id: "bot",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: RISER.Pbot,
      temperature: 300,
    },
    {
      id: "top",
      type: "boundary",
      x: 1,
      y: 1,
      pressure: riserPtop,
      temperature: 300,
    },
  ],
  branches: [
    {
      id: "r1",
      from: "bot",
      to: "top",
      component: {
        type: "pipe",
        length: RISER.L,
        diameter: RISER.D,
        roughness: 0,
        frictionFactor: RISER.f,
        elevationChange: RISER.dz,
      },
    },
  ],
};
const riserRes = runSolve(riserConfig);
const riserMdot = riserRes.branches.r1.mdot;
const riserErr = relErr(riserMdot, riserMdotAn);
console.log(
  `  flowing riser: mdot = ${fmt(riserMdot, 6)} kg/s (analytic ${fmt(riserMdotAn, 6)}), err = ${pctE(riserErr)}`,
);

writeFig(
  6,
  "hydrostatic-pressure",
  lineChart({
    title: "Static column: nodal pressure vs elevation (20 m water column)",
    xLabel: "Elevation z [m]",
    yLabel: "Pressure [kPa]",
    series: [
      {
        label: "Analytical P = P₀ − ρgz",
        pts: [
          [0, COL.P0 / KPA],
          [colH, colTopP / KPA],
        ],
        color: C.analytic,
        mode: "line",
      },
      {
        label: "Numerical node pressures",
        pts: Array.from({ length: COL.nSeg + 1 }, (_, i): [number, number] => {
          const z = i * COL.h;
          const P =
            i === 0
              ? COL.P0
              : i === COL.nSeg
                ? colTopP
                : colRes.nodes[`c${i}`].pressure;
          return [z, P / KPA];
        }),
        color: C.orange,
        mode: "markers",
        marker: "triangle",
      },
    ],
  }),
);

/* ==========================================================================
 * Case 6 — Pump operating point
 * ========================================================================== */
console.log("Case 6 — pump operating point");

const PUMP_CURVE: Array<[number, number]> = [
  [0, 200_000],
  [0.01, 150_000],
  [0.02, 50_000],
];
const PSYS = { L: 10, D: 0.05, f: 0.02, dz: 5, Pres: 100_000 };

/** Pump pressure rise [Pa] at mass flow ṁ — replicates the solver's
 *  piecewise-linear interpolation on volumetric flow Q = ṁ/ρ. */
function pumpRise(mdot: number): number {
  const Q = mdot / RHO;
  const c = PUMP_CURVE;
  if (Q <= c[0][0]) {
    const slope = (c[1][1] - c[0][1]) / (c[1][0] - c[0][0]);
    return c[0][1] + slope * (Q - c[0][0]);
  }
  if (Q >= c[c.length - 1][0]) {
    const slope =
      (c[c.length - 1][1] - c[c.length - 2][1]) /
      (c[c.length - 1][0] - c[c.length - 2][0]);
    return c[c.length - 1][1] + slope * (Q - c[c.length - 1][0]);
  }
  for (let i = 0; i < c.length - 1; i++) {
    if (Q >= c[i][0] && Q <= c[i + 1][0]) {
      const frac = (Q - c[i][0]) / (c[i + 1][0] - c[i][0]);
      return c[i][1] + frac * (c[i + 1][1] - c[i][1]);
    }
  }
  return c[c.length - 1][1];
}

/** System pressure demand [Pa] at mass flow ṁ: static head + fixed-f Darcy. */
function systemDemand(mdot: number): number {
  const A = areaOf(PSYS.D);
  const v = mdot / (RHO * A);
  return (
    RHO * G * PSYS.dz +
    PSYS.f * (PSYS.L / PSYS.D) * ((RHO * v * Math.abs(v)) / 2)
  );
}

// Operating point: equal reservoir pressures, so pump rise = system demand.
const pumpMdotRef = bisection(
  (m) => pumpRise(m) - systemDemand(m),
  0,
  PUMP_CURVE[2][0] * RHO,
);
const pumpRiseRef = pumpRise(pumpMdotRef);

const pumpConfig: NetworkConfig = {
  meta: { name: "hydraulics case 6 pump", version: 2 },
  settings: baseSettings(),
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    {
      id: "supply",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: PSYS.Pres,
      temperature: 300,
    },
    {
      id: "mid",
      type: "internal",
      x: 1,
      y: 0,
      pressure: 250_000,
      temperature: 300,
    },
    {
      id: "disch",
      type: "boundary",
      x: 2,
      y: 0,
      pressure: PSYS.Pres,
      temperature: 300,
    },
  ],
  branches: [
    {
      id: "pump",
      from: "supply",
      to: "mid",
      component: { type: "pump", curve: PUMP_CURVE },
    },
    {
      id: "pipe",
      from: "mid",
      to: "disch",
      component: {
        type: "pipe",
        length: PSYS.L,
        diameter: PSYS.D,
        roughness: 0,
        frictionFactor: PSYS.f,
        elevationChange: PSYS.dz,
      },
    },
  ],
};
const pumpRes = runSolve(pumpConfig);
const pumpMdotNum = pumpRes.branches.pump.mdot;
const pumpRiseNum = -pumpRes.branches.pump.dP; // pump dP is negative (a rise)
const pumpMdotErr = relErr(pumpMdotNum, pumpMdotRef);
const pumpRiseErr = relErr(pumpRiseNum, pumpRiseRef);
console.log(
  `  operating point: mdot = ${fmt(pumpMdotNum, 6)} kg/s (ref ${fmt(pumpMdotRef, 6)}), rise = ${fmt(pumpRiseNum / KPA, 3)} kPa (ref ${fmt(pumpRiseRef / KPA, 3)}); errs ${pctE(pumpMdotErr)} / ${pctE(pumpRiseErr)}`,
);

{
  const mMax = 18;
  const pumpPts: Array<[number, number]> = [];
  const sysPts: Array<[number, number]> = [];
  for (let i = 0; i <= 120; i++) {
    const m = (mMax * i) / 120;
    pumpPts.push([m, pumpRise(m) / KPA]);
    sysPts.push([m, systemDemand(m) / KPA]);
  }
  writeFig(
    7,
    "pump-operating-point",
    lineChart({
      title: "Pump operating point: pump curve vs system curve",
      xLabel: "Mass flow rate ṁ [kg/s]",
      yLabel: "Pressure rise / demand [kPa]",
      // The two curves form an X, so every corner has data on it; the only
      // clear region is the mid-height band on the left, between the curves.
      legend: "center-left",
      series: [
        {
          label: "Pump curve (piecewise linear)",
          pts: pumpPts,
          color: C.blue,
          mode: "line",
        },
        {
          label: "System curve ρgΔz + f(L/D)ρV²/2",
          pts: sysPts,
          color: C.red,
          mode: "line",
          dash: "7 4",
        },
        {
          label: "Solver operating point",
          pts: [[pumpMdotNum, pumpRiseNum / KPA]],
          color: C.green,
          mode: "markers",
          marker: "diamond",
        },
      ],
    }),
  );
}

/* ==========================================================================
 * Report markdown
 * ========================================================================== */

const fig = (n: number, caption: string) =>
  `![Figure ${n}](figures/hydraulics/${figures[n]})\n\n*Figure ${n}. ${caption}*`;

const sweepTable = (points: SweepPoint[]) =>
  [
    "| ΔP [kPa] | ṁ analytic [kg/s] | ṁ numerical [kg/s] | Re | ṁ error |",
    "| -------- | ----------------- | ------------------ | -- | ------- |",
    ...points.map(
      (p) =>
        `| ${(p.dP / KPA).toFixed(3)} | ${p.mdotAn.toExponential(5)} | ${p.mdot.toExponential(5)} | ${p.Re.toFixed(0)} | ${pctE(p.err)} |`,
    ),
  ].join("\n");

const loopFlowTable = [
  "| Branch | K | ṁ reference [kg/s] | ṁ solver [kg/s] | error |",
  "| ------ | - | ------------------ | --------------- | ----- |",
  ...LOOP_BRANCHES.map((b) => {
    const r = refFlows.get(b.id)!;
    const s = loopRes.branches[b.id].mdot;
    return `| ${b.id} (${b.from}→${b.to}) | ${b.k} | ${r.toFixed(6)} | ${s.toFixed(6)} | ${pctE(relErr(s, r))} |`;
  }),
].join("\n");

const loopPressureTable = [
  "| Node | P reference [kPa] | P solver [kPa] | error |",
  "| ---- | ----------------- | -------------- | ----- |",
  ...loopInternalIds.map((id) => {
    const r = refP.get(id)!;
    const s = loopRes.nodes[id].pressure;
    return `| ${id} | ${(r / KPA).toFixed(3)} | ${(s / KPA).toFixed(3)} | ${pctE(relErr(s, r))} |`;
  }),
].join("\n");

const parallelTable = [
  "| Branch | D [mm] | L [m] | f | ṁ analytic [kg/s] | ṁ numerical [kg/s] | error |",
  "| ------ | ------ | ----- | - | ----------------- | ------------------ | ----- |",
  ...PAR.pipes.map(
    (p, i) =>
      `| ${p.id} | ${(p.D * 1000).toFixed(0)} | ${p.L} | ${p.f} | ${parAnalytic[i].toFixed(6)} | ${parNumerical[i].toFixed(6)} | ${pctE(parErrs[i])} |`,
  ),
  `| **total** | — | — | — | ${parTotalAn.toFixed(6)} | ${parTotalNum.toFixed(6)} | ${pctE(parTotalErr)} |`,
].join("\n");

const report = `# Steady Incompressible Network Hydraulics Validation of OpenFLUME

**A validation report for the pressure–flow network solver against the classical closed-form results of steady incompressible pipe hydraulics: Hagen–Poiseuille laminar flow, Darcy–Weisbach turbulent flow, parallel-pipe flow splits, multi-loop network analysis (Hardy-Cross reference problem), hydrostatics, and pump/system operating points.**

Generated by \`scripts/hydraulics-validation-report.ts\` — all numbers and
figures come from live solves of the current solver. The corresponding CI
gates are \`src/core/__tests__/solver.test.ts\` and
\`src/core/__tests__/benchmarks.test.ts\`.

## Abstract

This report verifies the steady incompressible-flow capability of the
OpenFLUME solver — a pressure-based node-and-branch network code in the
GFSSP family — against six benchmark problems of classical pipe hydraulics,
each of which admits either an exact closed-form solution or an independent
reference solution converged in this script to a tolerance far below the
solver's own. The cases cover the laminar friction law (Hagen–Poiseuille),
the turbulent Darcy–Weisbach law with a prescribed friction factor, the flow
split among parallel pipes of unequal geometry, a six-node twelve-branch
multi-loop water network of the kind classically solved with the Hardy-Cross
method, hydrostatic pressure distributions with and without through-flow, and
the operating point of a pump run against a pipe system curve. Across all
${lamPoints.length + turbPoints.length + PAR.pipes.length + LOOP_BRANCHES.length + loopInternalIds.length + (COL.nSeg - 1) + 1 + 1} compared quantities the numerical solution
reproduces the reference to within ${pctE(Math.max(lamMaxErr, turbMaxErr, parMaxErr, loopMaxFlowErr, loopMaxPErr, colMaxDevRel, riserErr, pumpMdotErr, pumpRiseErr))} — the agreement is limited only
by the Newton convergence tolerance (10⁻⁹), not by any modeling
approximation, because every case is constructed so that the solver's
friction closure and the analytic reference are the same expression.

## Introduction

Before a network flow solver can be trusted on problems without known
answers, it must reproduce the problems with known answers. For steady
incompressible flow the canonical set is small and sharp: the laminar
Hagen–Poiseuille law (an exact solution of the Navier–Stokes equations), the
Darcy–Weisbach equation with prescribed friction factor, mass-conservative
flow splits, Kirchhoff-consistent loop networks — the problem class Hardy
Cross's 1936 moment-distribution analogue was invented for — the hydrostatic
law, and the intersection of a pump curve with a system curve. This report
exercises the OpenFLUME steady solver on all six, mirroring the network
configurations of the CI test suite (\`solver.test.ts\`,
\`benchmarks.test.ts\`) so the report and the CI gates validate the same
physics. The companion report
(\`compressible-report.md\`) covers the compressible quasi-1-D
capability; this one establishes the incompressible foundation underneath
it.

## Problem Description

The working fluid throughout is water, treated as an incompressible liquid
(ρ = ${RHO} kg/m³, μ = ${MU} Pa·s, the solver's \`water\` preset). Six cases
are studied:

| Case | Description |
| ---- | ----------- |
| 1 | Laminar flow in a small-bore pipe — ṁ vs ΔP against Hagen–Poiseuille, Re ${lamReMin.toFixed(0)}–${lamReMax.toFixed(0)} |
| 2 | Turbulent flow with fixed Darcy friction factor — ṁ vs ΔP over a ΔP decade |
| 3 | Flow split among three parallel pipes of unequal D, L, and f |
| 4 | Multi-loop water network: 6 internal nodes, 12 square-law resistances, 4 loops |
| 5 | Hydrostatics: a 20 m static water column, and a flowing inclined riser |
| 6 | Pump operating point: pump curve vs pipe system curve between equal reservoirs |

Cases 1, 2, 3, and 5 use pressure boundary pairs with pipe branches sized in
the script; case 4 uses the multi-loop geometry of benchmark B1 in
\`benchmarks.test.ts\`, shown in Figure 1; case 6 uses the pump curve of
benchmark B2 discharging through a fixed-friction pipe with a 5 m static
lift.

${fig(1, "Topology of the multi-loop water network (case 4): two pressure boundaries at 500 kPa and 100 kPa, six internal nodes, twelve square-law resistance branches forming four independent loops.")}

## Benchmark Solutions

**Hagen–Poiseuille (case 1).** For fully developed laminar flow the Darcy
friction factor is exactly f = 64/Re, which turns the Darcy–Weisbach
equation into the linear Hagen–Poiseuille law:

$$\\Delta P = \\frac{128\\,\\mu L\\,\\dot m}{\\pi \\rho D^4}, \\qquad \\dot m = \\frac{\\pi \\rho D^4 \\Delta P}{128\\,\\mu L}.$$

**Darcy–Weisbach with fixed f (case 2).** With a prescribed constant
friction factor the momentum balance closes exactly:

$$\\Delta P = f\\,\\frac{L}{D}\\,\\frac{\\rho V^2}{2}, \\qquad \\dot m = A\\sqrt{\\frac{2\\rho\\,\\Delta P}{f L/D}}.$$

**Parallel-pipe split (case 3).** Parallel branches between common nodes see
the same ΔP, so each branch flow follows the fixed-f closed form
independently and the total is their sum:

$$\\dot m_i = A_i\\sqrt{\\frac{2\\rho\\,\\Delta P\\, D_i}{f_i L_i}}, \\qquad \\dot m_{tot} = \\sum_i \\dot m_i.$$

**Multi-loop network (case 4).** Each branch is a square-law resistance
ΔP = R·ṁ|ṁ| with R = K/(2ρA²). The network solution must satisfy
Kirchhoff's two laws — mass continuity at every node and zero signed ΔP
around every loop:

$$\\sum_{j \\in node} \\dot m_j = 0, \\qquad \\sum_{j \\in loop} \\pm R_j\\,\\dot m_j |\\dot m_j| = 0.$$

This is the problem class of Cross (1936), whose iterative loop-correction
scheme
$$\\Delta Q = -\\frac{\\sum_j \\pm R_j Q_j |Q_j|}{2 \\sum_j R_j |Q_j|}$$
predates but is equivalent in fixed point to a Newton iteration on the
network equations. The reference here is an independent Newton solve of the
nodal continuity equations with the exact branch law, implemented in this
script with a finite-difference Jacobian and dense Gaussian elimination,
converged to a mass residual below 10⁻¹² kg/s (${refIterations} iterations).

**Hydrostatics (case 5).** For a static column of incompressible liquid the
pressure varies linearly with elevation,

$$P(z) = P_0 - \\rho g z,$$

and for a flowing inclined pipe the boundary pressure difference splits into
hydrostatic and frictional parts:

$$P_{bot} - P_{top} = \\rho g\\,\\Delta z + f\\,\\frac{L}{D}\\,\\frac{\\rho V^2}{2}.$$

**Pump operating point (case 6).** Between reservoirs of equal pressure, the
steady flow settles where the pump pressure rise equals the system demand,

$$\\Delta P_{pump}(\\dot m) = \\rho g\\,\\Delta z + f\\,\\frac{L}{D}\\,\\frac{\\rho V^2}{2},$$

with the pump curve interpolated piecewise-linearly in volumetric flow
Q = ṁ/ρ, exactly as the solver's pump component defines it. The reference
operating point is found by bisection on this scalar equation to a bracket
width of 10⁻¹² kg/s.

## Numerical Modeling

OpenFLUME employs a finite volume formulation of the mass, momentum, and
energy conservation equations on a network of nodes and branches: mass (and
energy) conservation is enforced at every internal node, and each branch
supplies one momentum relation between its endpoint pressures and its mass
flow rate, solved as a coupled Newton system with pressure boundary
conditions at boundary nodes. The flow rate is never prescribed — it is
computed from the imposed pressures, exactly as in GFSSP.

The component physics exercised here:

- **\`pipe\`** applies the Darcy–Weisbach relation. With no
  \`frictionFactor\` override the friction factor is f = 64/Re for
  Re < 2300 (exact Hagen–Poiseuille), the Swamee–Jain explicit Colebrook
  approximation for Re > 4000, and a C¹ smoothstep blend between (case 1
  stays entirely below Re ${lamReMax.toFixed(0)}, inside the exact laminar branch). With
  \`frictionFactor\` set, that constant f is used at every Reynolds number
  (cases 2, 3, 5b, 6), making the analytic references exact closures of the
  solver's own momentum equation. The pipe's \`elevationChange\` adds the
  hydrostatic term ρg·Δz with g = ${G} m/s².
- **\`resistance\`** applies the square law ΔP = K·ṁ|ṁ|/(2ρA²) (case 4).
- **\`pump\`** applies a pressure rise interpolated piecewise-linearly from
  its (Q, ΔP) curve (case 6).

All solves use \`tolerance\` 10⁻⁹, \`maxIterations\` 500, and relaxation 0.9
(0.8 for the multi-loop network, matching benchmark B1). The compressible
opt-in terms (\`momentumFlux\`, \`kineticEnergy\`) are left off: both are
identically zero for constant-density flow. Internal nodes carry initial
pressure guesses only; these do not constrain the converged solution.

## Results and Discussion

Every case converged. The table summarizes the maximum relative deviation of
each compared quantity from its reference; the errors sit at the Newton
convergence floor (10⁻⁹ relative residual), orders of magnitude below any
physical-modeling tolerance.

| Case | Compared quantity | Points | Max error |
| ---- | ----------------- | ------ | --------- |
| 1 — Laminar pipe | ṁ vs Hagen–Poiseuille | ${lamPoints.length} | ${pctE(lamMaxErr)} |
| 2 — Turbulent pipe | ṁ vs Darcy–Weisbach | ${turbPoints.length} | ${pctE(turbMaxErr)} |
| 3 — Parallel split | branch ṁ vs closed form | ${PAR.pipes.length} | ${pctE(parMaxErr)} |
| 3 — Parallel split | total ṁ | 1 | ${pctE(parTotalErr)} |
| 4 — Multi-loop | branch ṁ vs independent Newton | ${LOOP_BRANCHES.length} | ${pctE(loopMaxFlowErr)} |
| 4 — Multi-loop | node P vs independent Newton | ${loopInternalIds.length} | ${pctE(loopMaxPErr)} |
| 5a — Static column | node P vs P₀ − ρgz | ${COL.nSeg - 1} | ${pctE(colMaxDevRel)} of ρgH |
| 5b — Flowing riser | ṁ vs friction + ρgΔz closure | 1 | ${pctE(riserErr)} |
| 6 — Pump | operating-point ṁ | 1 | ${pctE(pumpMdotErr)} |
| 6 — Pump | operating-point rise | 1 | ${pctE(pumpRiseErr)} |

### Case 1: Laminar Pipe Flow (Hagen–Poiseuille)

A D = ${(LAM.D * 1000).toFixed(0)} mm, L = ${LAM.L} m water pipe is driven by
boundary-pressure pairs chosen to sweep the Reynolds number from
${lamReMin.toFixed(0)} to ${lamReMax.toFixed(0)} — entirely inside the laminar regime, where the
solver's friction factor is exactly 64/Re and the Hagen–Poiseuille law is an
exact closure. Figure 2 shows the solved mass flow against the analytic
line: ṁ is linear in ΔP, and the maximum deviation over the
${lamPoints.length}-point sweep is ${pctE(lamMaxErr)}. The solver-reported
Reynolds numbers confirm every point sits below the laminar cutoff
(Re = 2300), so no transition blending contaminates the comparison.

${sweepTable(lamPoints)}

${fig(2, "Laminar pipe flow: solved mass flow rate vs pressure drop against the exact Hagen–Poiseuille line.")}

### Case 2: Turbulent Pipe Flow (Darcy–Weisbach)

A D = ${(TURB.D * 1000).toFixed(0)} mm, L = ${TURB.L} m pipe with a prescribed
constant friction factor f = ${TURB.f} is swept over a ΔP decade
(${(turbPoints[0].dP / KPA).toFixed(0)}–${(turbPoints[turbPoints.length - 1].dP / KPA).toFixed(0)} kPa). Because f is fixed, the
Darcy–Weisbach inversion ṁ = A√(2ρΔP/(fL/D)) is exact, and the solved flow
follows the square-root curve of Figure 3 to within ${pctE(turbMaxErr)}.
Reynolds numbers span ${turbReMin.toExponential(1)} to
${Math.max(...turbPoints.map((p) => p.Re)).toExponential(1)}, comfortably turbulent.

${sweepTable(turbPoints)}

${fig(3, "Turbulent pipe flow with fixed friction factor: solved mass flow rate vs pressure drop against the exact Darcy–Weisbach inversion.")}

### Case 3: Parallel-Pipe Flow Split

Three pipes of unequal diameter, length, and friction factor connect the
same two pressure boundaries (ΔP = ${(parDP / KPA).toFixed(0)} kPa). Each branch must
carry ṁᵢ = Aᵢ√(2ρΔP·Dᵢ/(fᵢLᵢ)) independently; the solver reproduces every
branch flow to within ${pctE(parMaxErr)} and the total to within
${pctE(parTotalErr)} (Figure 4). This exercises simultaneous momentum
closure on parallel paths — the degenerate two-node limit of a loop network.

${parallelTable}

${fig(4, "Parallel-pipe flow split: analytic vs numerical branch flows for three unequal pipes at common ΔP.")}

### Case 4: Multi-Loop Water Network (Hardy-Cross Reference)

The six-node, twelve-branch, four-loop network of Figure 1 (the geometry of
CI benchmark B1) is driven from 500 kPa to 100 kPa through square-law
resistances. The reference solution is this script's own Newton iteration on
the nodal continuity equations with the exact branch law, converged to a mass
residual below 10⁻¹² kg/s in ${refIterations} iterations. All twelve solver
branch flows agree with the reference to within ${pctE(loopMaxFlowErr)}, and
all six internal node pressures to within ${pctE(loopMaxPErr)} (Figure 5).
As an internal-consistency check, the signed pressure-drop sums around the
four independent loops of the solved network close to within
${loopMaxClosure.toExponential(1)} of the 400 kPa system ΔP — Kirchhoff's
second law is satisfied to solver precision.

${loopFlowTable}

${loopPressureTable}

${fig(5, "Multi-loop network: parity of solver branch flows against the independent Newton reference — all 12 branches on the y = x line.")}

### Case 5: Hydrostatics

**Static column.** A ${colH} m vertical water column is discretized into
${COL.nSeg} pipe segments with \`elevationChange\` set, and the two boundary
pressures are placed in exact hydrostatic balance
(P₀ = ${(COL.P0 / KPA).toFixed(0)} kPa at the bottom, ${(colTopP / KPA).toFixed(2)} kPa at the top).
The solver recovers the linear pressure profile P = P₀ − ρgz at every
interior node to within ${colMaxDev.toExponential(2)} Pa
(${pctE(colMaxDevRel)} of the ρgH = ${(colSpan / KPA).toFixed(1)} kPa column
span), with a residual through-flow of ${colMaxMdot.toExponential(2)} kg/s —
numerically zero (Figure 6).

**Flowing inclined riser.** A ${RISER.L} m fixed-f pipe rising
Δz = ${RISER.dz} m carries flow driven by a boundary ΔP composed of
ρgΔz = ${((RHO * G * RISER.dz) / KPA).toFixed(2)} kPa of hydrostatic head plus
${(RISER.dPfric / KPA).toFixed(0)} kPa of friction. The solver must
superpose both momentum terms correctly to recover the closed-form flow: it
returns ṁ = ${fmt(riserMdot, 6)} kg/s against the analytic
${fmt(riserMdotAn, 6)} kg/s, an error of ${pctE(riserErr)}.

${fig(6, "Static water column: solved nodal pressures vs the analytic hydrostatic line P = P₀ − ρgz.")}

### Case 6: Pump Operating Point

The benchmark-B2 pump curve (${PUMP_CURVE.map(([q, p]) => `${(p / KPA).toFixed(0)} kPa at ${q} m³/s`).join(", ")};
piecewise linear in volumetric flow) discharges through a
D = ${(PSYS.D * 1000).toFixed(0)} mm, L = ${PSYS.L} m fixed-f pipe with a ${PSYS.dz} m static
lift, between reservoirs of equal pressure. The analytic operating point —
the intersection of the pump curve with the system curve
ρgΔz + f(L/D)ρV²/2, found by bisection — is
ṁ = ${fmt(pumpMdotRef, 6)} kg/s at a rise of ${(pumpRiseRef / KPA).toFixed(3)} kPa.
The solver lands on ṁ = ${fmt(pumpMdotNum, 6)} kg/s at
${(pumpRiseNum / KPA).toFixed(3)} kPa — errors of ${pctE(pumpMdotErr)} and
${pctE(pumpRiseErr)} respectively (Figure 7). The operating point falls on
the steeper second segment of the pump curve, so the agreement also confirms
the solver's piecewise-linear curve interpolation and its Newton handling of
the slope discontinuity at the knot.

${fig(7, "Pump operating point: pump curve, system curve, and the solver's converged operating point at their intersection.")}

## Conclusions

The steady incompressible capability of OpenFLUME reproduces all six
classical hydraulics benchmarks — laminar and turbulent single-pipe flow,
parallel splits, multi-loop networks, hydrostatics, and pump/system
operating points — to within ${pctE(Math.max(lamMaxErr, turbMaxErr, parMaxErr, loopMaxFlowErr, loopMaxPErr, colMaxDevRel, riserErr, pumpMdotErr, pumpRiseErr))}, the Newton convergence floor.
Because every case was constructed as an exact closure of the solver's own
friction laws (64/Re laminar, fixed-f Darcy–Weisbach, square-law resistance,
piecewise-linear pump curve, ρgΔz elevation), the residual deviations
measure the solver's algebraic convergence rather than any modeling gap; the
Kirchhoff loop-closure sums of the multi-loop case confirm the same at the
network level. Reynolds-correlation accuracy (Swamee–Jain vs Colebrook) is
covered separately by the CI friction-factor tests and is deliberately
excluded here by fixing f. Together with the compressible report, this
establishes the solver's verification baseline across both incompressible
and compressible steady regimes.

## References

1. White, F. M., *Fluid Mechanics*, 7th ed., McGraw-Hill, 2011.
2. Cross, H., "Analysis of Flow in Networks of Conduits or Conductors,"
   *University of Illinois Engineering Experiment Station Bulletin* No. 286,
   1936.
3. Streeter, V. L., and Wylie, E. B., *Fluid Mechanics*, 8th ed.,
   McGraw-Hill, 1985.
4. Swamee, P. K., and Jain, A. K., "Explicit Equations for Pipe-Flow
   Problems," *Journal of the Hydraulics Division*, ASCE, Vol. 102, No. 5,
   1976, pp. 657–664.
5. Majumdar, A. K., LeClair, A. C., Moore, R., and Schallhorn, P. A.,
   *Generalized Fluid System Simulation Program, Version 6.0*,
   NASA/TM-2013-217492, 2013.

## Nomenclature

| Symbol | Meaning |
| ------ | ------- |
| A | flow area |
| D | pipe diameter |
| f | Darcy friction factor |
| g | gravitational acceleration (${G} m/s²) |
| K | resistance loss coefficient |
| L | pipe length |
| ṁ | mass flow rate |
| P | static pressure |
| Q | volumetric flow rate |
| R | square-law resistance, ΔP = R·ṁ\\|ṁ\\| |
| Re | Reynolds number ρVD/μ |
| V | mean velocity |
| z / Δz | elevation / elevation change |
| ΔP | pressure difference |
| μ | dynamic viscosity |
| ρ | density |
| 0 | reference (bottom-of-column) property |
`;

writeFileSync(join(outDir, "incompressible-hydraulics-report.md"), report);
console.log(`\nwrote docs/validation/incompressible-hydraulics-report.md`);
