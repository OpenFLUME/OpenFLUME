/**
 * fluid-transient-validation-report.ts — generates the rigid-column fluid
 * transient validation report (docs/validation/fluid-transient-report.md) and
 * its SVG figures (docs/validation/figures/fluid-transient/).
 *
 * Validates the solver's opt-in lumped fluid-inertia term — (L/A)·dṁ/dt in
 * the branch momentum equation — and the trapped-gas-cushion node model
 * against classical rigid-column (incompressible-column) transient theory:
 *
 *   1. flow startup under a step ΔP        →  ṁ(t) = ṁ∞ tanh(t/τ)
 *   2. flow decay after removal of ΔP      →  ṁ(t) = ṁ₀ / (1 + t/τ_d)
 *   3. liquid column on a trapped-gas spring → nonlinear RK4 + linearized ω
 *   4. quasi-static gas-cushion compression →  P·V_g^n = const
 *
 * All numbers and figures come from live solves — rerun after solver changes:
 *
 *   npx tsx scripts/fluid-transient-validation-report.ts
 *
 * The physics/setup mirrors src/core/__tests__/fluidTransient.test.ts
 * (which is the CI gate; this script is the human-readable artifact).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  solveTransient,
  validateNetwork,
  componentPressureDrop,
  Pipe,
} from "../src/core";
import type { NetworkConfig, TransientResult } from "../src/core";

/* ==========================================================================
 * Constants (SI) — water as incompressible liquid (the 'water' preset)
 * ========================================================================== */

const RHO = 998; // kg/m³  (IncompressibleLiquid.WATER)
const MU = 1e-3; // Pa·s

/* ==========================================================================
 * ODE reference: classical RK4 for systems dy/dt = f(t, y)
 * ========================================================================== */

function rk4Vec(
  f: (t: number, y: number[]) => number[],
  y0: number[],
  t0: number,
  tf: number,
  dt: number,
): number[] {
  let y = [...y0];
  let t = t0;
  const steps = Math.ceil((tf - t0) / dt);
  const h = (tf - t0) / steps;
  for (let i = 0; i < steps; i++) {
    const k1 = f(t, y);
    const k2 = f(
      t + h / 2,
      y.map((v, j) => v + (h * k1[j]) / 2),
    );
    const k3 = f(
      t + h / 2,
      y.map((v, j) => v + (h * k2[j]) / 2),
    );
    const k4 = f(
      t + h,
      y.map((v, j) => v + h * k3[j]),
    );
    y = y.map((v, j) => v + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    t += h;
  }
  return y;
}

/* ==========================================================================
 * Solve helper and statistics
 * ========================================================================== */

function runTransient(config: NetworkConfig): TransientResult {
  const errors = validateNetwork(config);
  if (errors.length) throw new Error(`invalid network: ${errors.join("; ")}`);
  return solveTransient(config);
}

/** Normalized RMS deviation between two aligned traces. */
function rmsRel(sol: number[], ref: number[], scale: number): number {
  let sum = 0;
  const n = Math.min(sol.length, ref.length);
  for (let i = 0; i < n; i++) {
    const d = (sol[i] - ref[i]) / scale;
    sum += d * d;
  }
  return Math.sqrt(sum / n);
}

/** First time the trace crosses `target`, linearly interpolated. */
function crossTime(
  times: number[],
  ys: number[],
  target: number,
  rising: boolean,
): number {
  for (let i = 1; i < ys.length; i++) {
    const before = rising ? ys[i - 1] < target : ys[i - 1] > target;
    const after = rising ? ys[i] >= target : ys[i] <= target;
    if (before && after) {
      const frac = (target - ys[i - 1]) / (ys[i] - ys[i - 1]);
      return times[i - 1] + frac * (times[i] - times[i - 1]);
    }
  }
  return NaN;
}

function findPeaks(arr: number[]): Array<{ idx: number; value: number }> {
  const peaks: Array<{ idx: number; value: number }> = [];
  for (let i = 1; i < arr.length - 1; i++) {
    if (arr[i] > arr[i - 1] && arr[i] > arr[i + 1] && arr[i] > 0) {
      peaks.push({ idx: i, value: arr[i] });
    }
  }
  return peaks;
}

function meanPeakSpacing(
  peaks: Array<{ idx: number }>,
  times: number[],
): number {
  if (peaks.length < 2) return NaN;
  let sum = 0;
  for (let i = 1; i < peaks.length; i++) {
    sum += times[peaks[i].idx] - times[peaks[i - 1].idx];
  }
  return sum / (peaks.length - 1);
}

const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)} %`;
/** Percentage in scientific notation, for near-machine-zero deviations. */
const pctSci = (x: number) => `${(x * 100).toExponential(1)} %`;
const fmt = (x: number, digits = 3) => x.toFixed(digits);

/** Every n-th point of a series (always keeps the last point). */
function every<T>(arr: T[], n: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr[i]);
  if (arr.length > 0 && (arr.length - 1) % n !== 0)
    out.push(arr[arr.length - 1]);
  return out;
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

/* ==========================================================================
 * Schematic figure
 * ========================================================================== */

/** Three-panel schematic: one row per network topology. Called after the
 *  case constants are defined so the panels carry the real parameters. */
function fig1Schematic(): string {
  const W = 720;
  const H = 470;
  // Subscript helpers: drop the baseline, then restore it for trailing text.
  const sub = (s: string) => `<tspan font-size="9" dy="3">${s}</tspan>`;
  const rs = (s: string) => `<tspan dy="-3">${s}</tspan>`;

  const reservoir = (x: number, yc: number, lines: string[]): string => {
    const w = 88;
    const h = 76;
    const y0 = yc - ((lines.length - 1) / 2) * 16 + 4;
    return [
      `<rect x="${x}" y="${yc - h / 2}" width="${w}" height="${h}" fill="#eef4fb" stroke="#333" stroke-width="1.6"/>`,
      ...lines.map(
        (l, i) =>
          `<text x="${x + w / 2}" y="${y0 + i * 16}" text-anchor="middle" font-size="11">${l}</text>`,
      ),
    ].join("\n");
  };

  const pipeRect = (
    x1: number,
    x2: number,
    yc: number,
    inner: string,
    above?: string,
  ): string => {
    const ph = 24;
    const parts = [
      `<rect x="${x1}" y="${yc - ph / 2}" width="${x2 - x1}" height="${ph}" fill="#f5f0e6" stroke="#333" stroke-width="1.6"/>`,
      `<text x="${(x1 + x2) / 2}" y="${yc + 4}" text-anchor="middle" font-size="11">${inner}</text>`,
    ];
    if (above) {
      parts.push(
        `<text x="${(x1 + x2) / 2}" y="${yc - ph / 2 - 8}" text-anchor="middle" font-size="11.5">${above}</text>`,
      );
    }
    return parts.join("\n");
  };

  const flowArrow = (
    x: number,
    yc: number,
    label: string,
    double = false,
  ): string => {
    const y = yc + 26;
    const parts = [
      `<line x1="${x}" y1="${y}" x2="${x + 56}" y2="${y}" stroke="#1f5fa8" stroke-width="2.2"/>`,
      `<polygon points="${x + 56},${y} ${x + 45},${y - 5.5} ${x + 45},${y + 5.5}" fill="#1f5fa8"/>`,
    ];
    if (double) {
      parts.push(
        `<polygon points="${x},${y} ${x + 11},${y - 5.5} ${x + 11},${y + 5.5}" fill="#1f5fa8"/>`,
      );
    }
    parts.push(
      `<text x="${x + 64}" y="${y + 4}" font-size="11.5">${label}</text>`,
    );
    return parts.join("\n");
  };

  const cushionTank = (x: number, yc: number): string => {
    const w = 116;
    const h = 100;
    // Gas/liquid interface above the tank's mid-height so the pipe (which
    // meets the tank at yc) visibly enters the liquid region.
    const gasFrac = 0.44;
    const yTop = yc - h / 2;
    const yGas = yTop + h * gasFrac;
    return [
      `<text x="${x + w / 2}" y="${yTop - 8}" text-anchor="middle" font-size="11.5">gasCushion node</text>`,
      `<rect x="${x + 1}" y="${yTop + 1}" width="${w - 2}" height="${h * gasFrac - 1}" fill="#fdeaea"/>`,
      `<rect x="${x + 1}" y="${yGas}" width="${w - 2}" height="${h * (1 - gasFrac) - 1}" fill="#eef4fb"/>`,
      `<line x1="${x + 1}" y1="${yGas}" x2="${x + w - 1}" y2="${yGas}" stroke="#666" stroke-width="1" stroke-dasharray="5 3"/>`,
      `<rect x="${x}" y="${yTop}" width="${w}" height="${h}" fill="none" stroke="#333" stroke-width="1.6"/>`,
      `<text x="${x + w / 2}" y="${yTop + 12}" text-anchor="middle" font-size="10.5">trapped gas</text>`,
      `<text x="${x + w / 2}" y="${yTop + 24.5}" text-anchor="middle" font-size="10.5">P·V${sub("g")}${rs("&#8319; = C")}</text>`,
      `<text x="${x + w / 2}" y="${yTop + 37}" text-anchor="middle" font-size="10.5">V${sub("g0")}${rs(` = ${VG0 * 1000} L, n = ${NPOLY}`)}</text>`,
      `<text x="${x + w / 2}" y="${yGas + 26}" text-anchor="middle" font-size="10.5">liquid</text>`,
      `<text x="${x + w / 2}" y="${yGas + 42}" text-anchor="middle" font-size="10.5">V${sub("tot")}${rs(` = ${V_TOT * 1000} L`)}</text>`,
    ].join("\n");
  };

  const rowCaption = (y: number, text: string): string =>
    `<text x="48" y="${y}" font-size="12" font-weight="bold">${text}</text>`;

  const yA = 126;
  const yB = 256;
  const yC = 396;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">
<rect width="${W}" height="${H}" fill="white"/>
<text x="${W / 2}" y="24" text-anchor="middle" font-size="15" font-weight="bold">Rigid-column transient configurations</text>
<!-- (a) cases 1-2: inertial pipe between two pressure boundaries -->
${rowCaption(66, `(a) Cases 1–2 — startup (step ΔP = ${(DP1 / 1e5).toFixed(0)} bar) and decay (ΔP removed)`)}
${reservoir(48, yA, [`P${sub("A")}`, `${(P_HI / 1e5).toFixed(0)} bar — case 1`, `${(P_LO / 1e5).toFixed(0)} bar — case 2`])}
${pipeRect(136, 584, yA, `pipe, inertia: true · L = ${L1} m, D = ${D1 * 1000} mm, f = ${F1}`, `(L/A)·dṁ/dt + ΔP${sub("f")}${rs("(ṁ)")}`)}
${flowArrow(166, yA, "ṁ(t)")}
${reservoir(584, yA, [`P${sub("B")}`, `${(P_LO / 1e5).toFixed(0)} bar`, "(fixed)"])}
<!-- (b) case 3: reservoir step against the gas cushion -->
${rowCaption(196, "(b) Case 3 — oscillator: reservoir pressure step against the gas spring")}
${reservoir(48, yB, [`P${sub("R")}${rs("(t)")}`, `${(P_EQ / 1e5).toFixed(0)} → ${(P_STEP / 1e5).toFixed(0)} bar`, "step at t = 0"])}
${pipeRect(136, 556, yB, `pipe, inertia: true · L = ${L3} m, D = ${D3 * 1000} mm, roughness 10⁻⁶ m`)}
${flowArrow(166, yB, "ṁ(t) — oscillates", true)}
${cushionTank(556, yB)}
<!-- (c) case 4: constant flow source compressing the cushion -->
${rowCaption(336, "(c) Case 4 — quasi-static compression: constant flow source, no pipe inertia")}
${reservoir(48, yC, [`P${sub("A")}`, `${(P_EQ / 1e5).toFixed(0)} bar`, "(boundary)"])}
<line x1="136" y1="${yC}" x2="556" y2="${yC}" stroke="#333" stroke-width="1.6"/>
<circle cx="346" cy="${yC}" r="20" fill="white" stroke="#333" stroke-width="1.6"/>
<line x1="334" y1="${yC}" x2="354" y2="${yC}" stroke="#1f5fa8" stroke-width="2.2"/>
<polygon points="${358},${yC} ${347},${yC - 5.5} ${347},${yC + 5.5}" fill="#1f5fa8"/>
<text x="346" y="${yC - 30}" text-anchor="middle" font-size="11.5">flowSource: ṁ = ${MDOT4.toFixed(1)} kg/s</text>
<polygon points="556,${yC} 545,${yC - 5.5} 545,${yC + 5.5}" fill="#333"/>
${cushionTank(556, yC)}
</svg>`;
}

/* ==========================================================================
 * Colors / marker assignments
 * ========================================================================== */

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
const figDir = join(outDir, "figures", "fluid-transient");
mkdirSync(figDir, { recursive: true });

const figures: string[] = [];
function writeFig(n: number, name: string, svg: string): string {
  const file = `fig${String(n).padStart(2, "0")}-${name}.svg`;
  writeFileSync(join(figDir, file), svg);
  figures[n] = file;
  console.log(`  wrote figures/fluid-transient/${file}`);
  return file;
}

console.log("Generating rigid-column fluid transient validation report…");

/* ==========================================================================
 * Case 1 — flow startup in a single pipe under a step ΔP
 *
 * Solver momentum form with inertia:  (L/A)·dṁ/dt = ΔP − ΔP_f(ṁ).
 * With a fixed Darcy friction factor f, ΔP_f = K·ṁ² with
 * K = f·L / (2·ρ·D·A²), so the exact solution is the tanh law
 *   ṁ(t) = ṁ∞·tanh(t/τ),  ṁ∞ = √(ΔP/K),  τ = (L/A)·ṁ∞/ΔP.
 * ========================================================================== */

console.log("Case 1 — flow startup (tanh law)");

const L1 = 100; // m
const D1 = 0.1; // m
const A1 = (Math.PI / 4) * D1 * D1;
const F1 = 0.02; // fixed Darcy friction factor
const P_HI = 2e5;
const P_LO = 1e5;
const DP1 = P_HI - P_LO;

const K1 = (F1 * L1) / (2 * RHO * D1 * A1 * A1);
const mdotInf = Math.sqrt(DP1 / K1);
const tau1 = ((L1 / A1) * mdotInf) / DP1;
const vInf = mdotInf / (RHO * A1);

const startupAnalytic = (t: number) => mdotInf * Math.tanh(t / tau1);

// RK4 cross-check of the closed form against the solver's own friction law
// (Pipe with fixedFrictionFactor), like the template cross-checks Fanno.
const pipe1 = new Pipe(L1, D1, 0, 0, undefined, F1);
{
  const ode = (_t: number, y: number[]) => [
    (A1 / L1) * (DP1 - componentPressureDrop(y[0], RHO, MU, pipe1)),
  ];
  const yEnd = rk4Vec(ode, [0], 0, 4 * tau1, tau1 / 2000);
  const dev = Math.abs(yEnd[0] - startupAnalytic(4 * tau1)) / mdotInf;
  console.log(
    `  tanh law vs RK4 of solver friction law: ${(dev * 100).toExponential(2)} % at t = 4τ`,
  );
}

const T_END1 = 12; // s ≈ 3.8 τ
const DT1_COARSE = 0.05;
const DT1_FINE = 0.0125;

function startupConfig(dt: number, inertia: boolean): NetworkConfig {
  return {
    meta: { name: "startup", version: 2 },
    settings: {
      mode: "transient",
      dt,
      endTime: T_END1,
      tolerance: 1e-6,
      maxIterations: 200,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "A",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: P_HI,
        temperature: 300,
      },
      {
        id: "B",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: P_LO,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "p1",
        from: "A",
        to: "B",
        initialMdot: 0,
        component: {
          type: "pipe",
          length: L1,
          diameter: D1,
          roughness: 0,
          frictionFactor: F1,
          ...(inertia ? { inertia: true } : {}),
        },
      },
    ],
  };
}

interface TraceStats {
  converged: boolean;
  finalErr: number; // vs analytic at endTime
  tauErr: number; // measured τ (63.2%… no: tanh(1) crossing) vs analytic τ
  tauMeasured: number;
  rms: number;
}

function startupStats(res: TransientResult): TraceStats {
  const times = res.times;
  const sol = res.branches.p1.mdot;
  const ref = times.map(startupAnalytic);
  const target = mdotInf * Math.tanh(1); // ṁ(τ) = ṁ∞·tanh(1)
  const tauMeasured = crossTime(times, sol, target, true);
  return {
    converged: res.converged,
    finalErr: Math.abs(sol[sol.length - 1] - ref[ref.length - 1]) / mdotInf,
    tauErr: Math.abs(tauMeasured - tau1) / tau1,
    tauMeasured,
    rms: rmsRel(sol, ref, mdotInf),
  };
}

const startCoarse = runTransient(startupConfig(DT1_COARSE, true));
const startFine = runTransient(startupConfig(DT1_FINE, true));
const startNoInertia = runTransient(startupConfig(DT1_COARSE, false));
const sc = startupStats(startCoarse);
const sf = startupStats(startFine);
console.log(
  `  dt=${DT1_COARSE}: converged=${sc.converged} finalErr=${pct(sc.finalErr, 3)} tauErr=${pct(sc.tauErr, 2)} rms=${pct(sc.rms, 2)}`,
);
console.log(
  `  dt=${DT1_FINE}: converged=${sf.converged} finalErr=${pct(sf.finalErr, 3)} tauErr=${pct(sf.tauErr, 2)} rms=${pct(sf.rms, 2)}`,
);
console.log(
  `  rms ratio coarse/fine = ${(sc.rms / sf.rms).toFixed(2)} (first-order expectation ≈ ${(DT1_COARSE / DT1_FINE).toFixed(0)})`,
);
console.log(
  `  no-inertia contrast: ṁ after first step = ${startNoInertia.branches.p1.mdot[1].toFixed(2)} kg/s (quasi-steady jump)`,
);

const denseStartup: Array<[number, number]> = [];
for (let i = 0; i <= 300; i++) {
  const t = (T_END1 * i) / 300;
  denseStartup.push([t, startupAnalytic(t)]);
}

writeFig(
  2,
  "startup-mdot",
  lineChart({
    title: "Flow startup: ṁ(t) under a step ΔP = 1 bar (tanh law)",
    xLabel: "Time t [s]",
    yLabel: "Mass flow rate ṁ [kg/s]",
    legend: "bottom-right",
    series: [
      {
        label: "Analytical tanh law",
        pts: denseStartup,
        color: C.analytic,
        mode: "line",
      },
      {
        label: `Numerical, dt = ${DT1_COARSE} s`,
        pts: every(
          startCoarse.times.map((t, i): [number, number] => [
            t,
            startCoarse.branches.p1.mdot[i],
          ]),
          8,
        ),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
      {
        label: `Numerical, dt = ${DT1_FINE} s`,
        pts: every(
          startFine.times.map((t, i): [number, number] => [
            t,
            startFine.branches.p1.mdot[i],
          ]),
          48,
        ),
        color: C.green,
        mode: "markers",
        marker: "triangle",
      },
      {
        label: "Without inertia flag",
        pts: startNoInertia.times.map((t, i): [number, number] => [
          t,
          startNoInertia.branches.p1.mdot[i],
        ]),
        color: C.orange,
        mode: "line",
        dash: "4 4",
      },
    ],
  }),
);

/* ==========================================================================
 * Case 2 — flow decay after removal of the driving ΔP (valve slam analog)
 *
 * (L/A)·dṁ/dt = −K·ṁ²  ⇒  ṁ(t) = ṁ₀ / (1 + t/τ_d),  τ_d = (L/A)/(K·ṁ₀).
 * ========================================================================== */

console.log("Case 2 — flow decay (hyperbolic law)");

const mdot0 = mdotInf; // start from the case-1 steady state
const tauD = L1 / A1 / (K1 * mdot0);
const decayAnalytic = (t: number) => mdot0 / (1 + t / tauD);

function decayConfig(dt: number): NetworkConfig {
  return {
    meta: { name: "decay", version: 2 },
    settings: {
      mode: "transient",
      dt,
      endTime: T_END1,
      tolerance: 1e-6,
      maxIterations: 200,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "A",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: P_LO,
        temperature: 300,
      },
      {
        id: "B",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: P_LO,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "p1",
        from: "A",
        to: "B",
        initialMdot: mdot0,
        component: {
          type: "pipe",
          length: L1,
          diameter: D1,
          roughness: 0,
          frictionFactor: F1,
          inertia: true,
        },
      },
    ],
  };
}

function decayStats(res: TransientResult): TraceStats {
  const times = res.times;
  const sol = res.branches.p1.mdot;
  const ref = times.map(decayAnalytic);
  const tauMeasured = crossTime(times, sol, mdot0 / 2, false); // ṁ(τ_d) = ṁ₀/2
  return {
    converged: res.converged,
    finalErr: Math.abs(sol[sol.length - 1] - ref[ref.length - 1]) / mdot0,
    tauErr: Math.abs(tauMeasured - tauD) / tauD,
    tauMeasured,
    rms: rmsRel(sol, ref, mdot0),
  };
}

const decayCoarse = runTransient(decayConfig(DT1_COARSE));
const decayFine = runTransient(decayConfig(DT1_FINE));
const dc = decayStats(decayCoarse);
const df = decayStats(decayFine);
console.log(
  `  dt=${DT1_COARSE}: converged=${dc.converged} finalErr=${pct(dc.finalErr, 3)} tauErr=${pct(dc.tauErr, 2)} rms=${pct(dc.rms, 2)}`,
);
console.log(
  `  dt=${DT1_FINE}: converged=${df.converged} finalErr=${pct(df.finalErr, 3)} tauErr=${pct(df.tauErr, 2)} rms=${pct(df.rms, 2)}`,
);

const denseDecay: Array<[number, number]> = [];
for (let i = 0; i <= 300; i++) {
  const t = (T_END1 * i) / 300;
  denseDecay.push([t, decayAnalytic(t)]);
}

writeFig(
  3,
  "decay-mdot",
  lineChart({
    title: `Flow decay after ΔP removal: ṁ(t) = ṁ₀/(1 + t/τ<tspan font-size="11" dy="4">d</tspan><tspan dy="-4">)</tspan>`,
    xLabel: "Time t [s]",
    yLabel: "Mass flow rate ṁ [kg/s]",
    series: [
      {
        label: "Analytical hyperbolic law",
        pts: denseDecay,
        color: C.analytic,
        mode: "line",
      },
      {
        label: `Numerical, dt = ${DT1_COARSE} s`,
        pts: every(
          decayCoarse.times.map((t, i): [number, number] => [
            t,
            decayCoarse.branches.p1.mdot[i],
          ]),
          8,
        ),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
      {
        label: `Numerical, dt = ${DT1_FINE} s`,
        pts: every(
          decayFine.times.map((t, i): [number, number] => [
            t,
            decayFine.branches.p1.mdot[i],
          ]),
          48,
        ),
        color: C.green,
        mode: "markers",
        marker: "triangle",
      },
    ],
  }),
);

/* ==========================================================================
 * Case 3 — gas-cushion oscillator (liquid column on a trapped-gas spring)
 *
 * Mirrors the oscillator in fluidTransient.test.ts: reservoir stepped from
 * P_eq to P_step drives an inertial water column against a polytropic gas
 * cushion. Nonlinear reference: RK4 of
 *   (L/A)·dṁ/dt = P_step − ΔP_f(ṁ) − P_gas(V_w),  dV_w/dt = ṁ/ρ,
 *   P_gas = P_eq·V_g0^n / (V_tot − V_w)^n,
 * with ΔP_f the solver's own componentPressureDrop (Colebrook friction).
 * Linearized frequency about the new equilibrium:
 *   ω = √(k_eff/m_eff),  k_eff = n·P_step·A²/V_g,eq,  m_eff = ρ·L·A.
 * ========================================================================== */

console.log("Case 3 — gas-cushion oscillator");

const L3 = 10;
const D3 = 0.05;
const A3 = (Math.PI / 4) * D3 * D3;
const ROUGH3 = 1e-6;
const V_TOT = 0.01;
const VG0 = 0.005;
const NPOLY = 1.4;
const P_EQ = 1e5;
const P_STEP = 2e5;
const DT3 = 0.002;
const DT3_FINE = 0.0005;
const T_END3 = 5.0;

const pipe3 = new Pipe(L3, D3, ROUGH3, 0);
const VW_EQ = V_TOT - VG0;
const C_GAS = P_EQ * Math.pow(VG0, NPOLY);

/** RK4 trace of [ṁ, V_w] on a uniform grid; also records gas pressure. */
function oscillatorRK4(dt: number, endTime: number, pipe: Pipe) {
  const ode = (_t: number, y: number[]) => {
    const mdot = y[0];
    const Vg = V_TOT - y[1];
    const P_gas = C_GAS / Math.pow(Vg, NPOLY);
    const dP_f = componentPressureDrop(mdot, RHO, MU, pipe);
    return [(A3 / L3) * (P_STEP - dP_f - P_gas), mdot / RHO];
  };
  const times: number[] = [0];
  const mdots: number[] = [0];
  const pGas: number[] = [C_GAS / Math.pow(VG0, NPOLY)];
  let y = [0, VW_EQ];
  const steps = Math.round(endTime / dt);
  for (let step = 1; step <= steps; step++) {
    y = rk4Vec(ode, y, (step - 1) * dt, step * dt, dt / 4);
    times.push(step * dt);
    mdots.push(y[0]);
    pGas.push(C_GAS / Math.pow(V_TOT - y[1], NPOLY));
  }
  return { times, mdots, pGas };
}

function oscillatorConfig(dt: number, roughness: number): NetworkConfig {
  return {
    meta: { name: "osc", version: 2 },
    settings: {
      mode: "transient",
      dt,
      endTime: T_END3,
      tolerance: 1e-6,
      maxIterations: 200,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "R",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: P_EQ,
        temperature: 300,
        pressureSchedule: [
          [0, P_STEP],
          [T_END3, P_STEP],
        ],
      },
      {
        id: "C",
        type: "internal",
        x: 1,
        y: 0,
        pressure: P_EQ,
        temperature: 300,
        volume: V_TOT,
        gasCushion: { initialGasVolume: VG0, polytropicIndex: NPOLY },
      },
    ],
    branches: [
      {
        id: "p1",
        from: "R",
        to: "C",
        initialMdot: 0,
        component: {
          type: "pipe",
          length: L3,
          diameter: D3,
          roughness,
          inertia: true,
        },
      },
    ],
  };
}

// Linearized natural period about the stepped equilibrium
const VG_EQ_NEW = VG0 * Math.pow(P_EQ / P_STEP, 1 / NPOLY);
const M_EFF = RHO * L3 * A3;
const K_EFF = (NPOLY * P_STEP * A3 * A3) / VG_EQ_NEW;
const OMEGA_LIN = Math.sqrt(K_EFF / M_EFF);
const T_LIN = (2 * Math.PI) / OMEGA_LIN;

const oscRK4 = oscillatorRK4(DT3, T_END3, pipe3);
const oscRK4Fine = oscillatorRK4(DT3_FINE, T_END3, pipe3);
const oscSol = runTransient(oscillatorConfig(DT3, ROUGH3));
const oscSolFine = runTransient(oscillatorConfig(DT3_FINE, ROUGH3));

interface OscStats {
  converged: boolean;
  period: number;
  periodErrVsLin: number;
  periodErrVsRK4: number;
  firstPeak: number;
  firstPeakErr: number; // vs RK4 first peak
  peakRatio: number; // mean successive-peak amplitude ratio
  nPeaks: number;
  rms: number; // vs RK4 trace, normalized by RK4 first peak
}

function oscStats(
  times: number[],
  mdots: number[],
  refMdots: number[],
  converged: boolean,
): OscStats {
  const peaks = findPeaks(mdots);
  const refPeaks = findPeaks(refMdots);
  const period = meanPeakSpacing(peaks, times);
  const refPeriod = meanPeakSpacing(refPeaks, times);
  let ratioSum = 0;
  for (let i = 1; i < peaks.length; i++)
    ratioSum += peaks[i].value / peaks[i - 1].value;
  return {
    converged,
    period,
    periodErrVsLin: Math.abs(period - T_LIN) / T_LIN,
    periodErrVsRK4: Math.abs(period - refPeriod) / refPeriod,
    firstPeak: peaks[0]?.value ?? NaN,
    firstPeakErr:
      Math.abs((peaks[0]?.value ?? NaN) - refPeaks[0].value) /
      refPeaks[0].value,
    peakRatio: peaks.length > 1 ? ratioSum / (peaks.length - 1) : NaN,
    nPeaks: peaks.length,
    rms: rmsRel(mdots, refMdots, refPeaks[0].value),
  };
}

function rk4OwnStats(times: number[], mdots: number[]) {
  const peaks = findPeaks(mdots);
  let ratioSum = 0;
  for (let i = 1; i < peaks.length; i++)
    ratioSum += peaks[i].value / peaks[i - 1].value;
  return {
    period: meanPeakSpacing(peaks, times),
    firstPeak: peaks[0].value,
    peakRatio: peaks.length > 1 ? ratioSum / (peaks.length - 1) : NaN,
    nPeaks: peaks.length,
  };
}

const oscS = oscStats(
  oscSol.times,
  oscSol.branches.p1.mdot,
  oscRK4.mdots,
  oscSol.converged,
);
const oscSF = oscStats(
  oscSolFine.times,
  oscSolFine.branches.p1.mdot,
  oscRK4Fine.mdots,
  oscSolFine.converged,
);
const oscR = rk4OwnStats(oscRK4.times, oscRK4.mdots);

// Backward-Euler per-period amplitude prediction for a linear oscillator:
// each step multiplies amplitude by 1/√(1+(ω·dt)²) ⇒ per period ≈ exp(−π·ω·dt).
const bePerPeriod = (dt: number) => Math.exp(-Math.PI * OMEGA_LIN * dt);

console.log(
  `  T_lin=${fmt(T_LIN)} s  T_rk4=${fmt(oscR.period)} s  T_solver(dt=${DT3})=${fmt(oscS.period)} s (${pct(oscS.periodErrVsLin)} vs lin, ${pct(oscS.periodErrVsRK4)} vs RK4)`,
);
console.log(
  `  first peak: solver=${fmt(oscS.firstPeak)} rk4=${fmt(oscR.firstPeak)} (${pct(oscS.firstPeakErr)});  trace rms=${pct(oscS.rms)}`,
);
console.log(
  `  peak decay per period: solver=${fmt(oscS.peakRatio)} rk4=${fmt(oscR.peakRatio)} BE-prediction=${fmt(bePerPeriod(DT3) * oscR.peakRatio)}`,
);
console.log(
  `  dt=${DT3_FINE}: T=${fmt(oscSF.period)} s (${pct(oscSF.periodErrVsRK4)} vs RK4) firstPeakErr=${pct(oscSF.firstPeakErr)} peakRatio=${fmt(oscSF.peakRatio)} rms=${pct(oscSF.rms)}`,
);

// Friction-dominated variant (roughness 1e-4), as in the CI test's decay check
const oscSolRough = runTransient(oscillatorConfig(DT3, 1e-4));
const oscRK4Rough = oscillatorRK4(DT3, T_END3, new Pipe(L3, D3, 1e-4, 0));
const oscSRough = oscStats(
  oscSolRough.times,
  oscSolRough.branches.p1.mdot,
  oscRK4Rough.mdots,
  oscSolRough.converged,
);
const oscRRough = rk4OwnStats(oscRK4Rough.times, oscRK4Rough.mdots);
console.log(
  `  rough pipe (1e-4): solver peakRatio=${fmt(oscSRough.peakRatio)} rk4 peakRatio=${fmt(oscRRough.peakRatio)} rms=${pct(oscSRough.rms)}`,
);

writeFig(
  4,
  "oscillator-mdot",
  lineChart({
    title: "Gas-cushion oscillator: ṁ(t), solver vs nonlinear RK4",
    xLabel: "Time t [s]",
    yLabel: "Mass flow rate ṁ [kg/s]",
    series: [
      {
        label: "Nonlinear RK4 reference",
        pts: oscRK4.times.map((t, i): [number, number] => [t, oscRK4.mdots[i]]),
        color: C.analytic,
        mode: "line",
      },
      {
        label: `Numerical, dt = ${DT3} s`,
        pts: every(
          oscSol.times.map((t, i): [number, number] => [
            t,
            oscSol.branches.p1.mdot[i],
          ]),
          25,
        ),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
      {
        label: `Numerical, dt = ${DT3_FINE} s`,
        pts: oscSolFine.times.map((t, i): [number, number] => [
          t,
          oscSolFine.branches.p1.mdot[i],
        ]),
        color: C.red,
        mode: "line",
        dash: "6 4",
      },
    ],
  }),
);

const zoomEnd = 1.4 * T_LIN;
writeFig(
  5,
  "oscillator-first-period",
  lineChart({
    title: "Gas-cushion oscillator: first period detail",
    xLabel: "Time t [s]",
    yLabel: "Mass flow rate ṁ [kg/s]",
    legend: "bottom-left",
    series: [
      {
        label: "Nonlinear RK4 reference",
        pts: oscRK4Fine.times
          .map((t, i): [number, number] => [t, oscRK4Fine.mdots[i]])
          .filter(([t]) => t <= zoomEnd),
        color: C.analytic,
        mode: "line",
      },
      {
        label: `Numerical, dt = ${DT3} s`,
        pts: every(
          oscSol.times
            .map((t, i): [number, number] => [t, oscSol.branches.p1.mdot[i]])
            .filter(([t]) => t <= zoomEnd),
          20,
        ),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
      {
        label: `Numerical, dt = ${DT3_FINE} s`,
        pts: every(
          oscSolFine.times
            .map((t, i): [number, number] => [
              t,
              oscSolFine.branches.p1.mdot[i],
            ])
            .filter(([t]) => t <= zoomEnd),
          80,
        ),
        color: C.green,
        mode: "markers",
        marker: "triangle",
      },
    ],
  }),
);

writeFig(
  6,
  "oscillator-pressure",
  lineChart({
    title: "Gas-cushion oscillator: cushion pressure P(t)",
    xLabel: "Time t [s]",
    yLabel: "Cushion pressure [kPa]",
    series: [
      {
        label: "Nonlinear RK4 reference",
        pts: oscRK4.times.map((t, i): [number, number] => [
          t,
          oscRK4.pGas[i] / 1e3,
        ]),
        color: C.analytic,
        mode: "line",
      },
      {
        label: `Numerical, dt = ${DT3} s`,
        pts: every(
          oscSol.times.map((t, i): [number, number] => [
            t,
            oscSol.nodes.C.pressure[i] / 1e3,
          ]),
          25,
        ),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
    ],
  }),
);

const oscPrms = rmsRel(
  oscSol.nodes.C.pressure,
  oscRK4.pGas,
  Math.max(...oscRK4.pGas) - P_EQ,
);

/* ==========================================================================
 * Case 4 — quasi-static gas-cushion compression (monotonic)
 *
 * Constant ṁ into the cushion node: V_g(t) = V_g0 − (ṁ/ρ)·t and
 * P(t) = P₀·(V_g0/V_g(t))^n exactly (polytropic P·V^n = const).
 * ========================================================================== */

console.log("Case 4 — gas-cushion compression");

const MDOT4 = 1.0;
const DT4 = 0.01;
const T_END4 = 2.0;

const compressionConfig: NetworkConfig = {
  meta: { name: "cushion", version: 2 },
  settings: {
    mode: "transient",
    dt: DT4,
    endTime: T_END4,
    tolerance: 1e-6,
    maxIterations: 200,
    relaxation: 0.9,
  },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    { id: "A", type: "boundary", x: 0, y: 0, pressure: P_EQ, temperature: 300 },
    {
      id: "C",
      type: "internal",
      x: 1,
      y: 0,
      pressure: P_EQ,
      temperature: 300,
      volume: V_TOT,
      gasCushion: { initialGasVolume: VG0, polytropicIndex: NPOLY },
    },
  ],
  branches: [
    {
      id: "fs1",
      from: "A",
      to: "C",
      initialMdot: MDOT4,
      component: { type: "flowSource", massFlow: MDOT4 },
    },
  ],
};

const compVg = (t: number) => VG0 - (MDOT4 / RHO) * t;
const compP = (t: number) => P_EQ * Math.pow(VG0 / compVg(t), NPOLY);

const compSol = runTransient(compressionConfig);
let compMaxPVdev = 0;
for (let i = 0; i < compSol.times.length; i++) {
  const P = compSol.nodes.C.pressure[i];
  const Vg = compSol.nodes.C.gasVolume![i];
  compMaxPVdev = Math.max(
    compMaxPVdev,
    Math.abs(P * Math.pow(Vg, NPOLY) - C_GAS) / C_GAS,
  );
}
const compRefP = compSol.times.map(compP);
const compFinalErr =
  Math.abs(compSol.nodes.C.pressure[compSol.times.length - 1] - compP(T_END4)) /
  compP(T_END4);
const compRms = rmsRel(compSol.nodes.C.pressure, compRefP, compP(T_END4));
const compVgFinalErr =
  Math.abs(
    compSol.nodes.C.gasVolume![compSol.times.length - 1] - compVg(T_END4),
  ) / compVg(T_END4);
console.log(
  `  converged=${compSol.converged} maxPV^n dev=${pct(compMaxPVdev, 3)} finalP err=${pct(compFinalErr, 3)} finalVg err=${pct(compVgFinalErr, 3)} rms=${pct(compRms, 3)}`,
);

const denseComp: Array<[number, number]> = [];
for (let i = 0; i <= 300; i++) {
  const t = (T_END4 * i) / 300;
  denseComp.push([t, compP(t) / 1e3]);
}

writeFig(
  7,
  "cushion-compression",
  lineChart({
    title: "Quasi-static cushion compression: P(t) under constant inflow",
    xLabel: "Time t [s]",
    yLabel: "Cushion pressure [kPa]",
    legend: "top-left",
    series: [
      {
        label: "Analytical polytropic law",
        pts: denseComp,
        color: C.analytic,
        mode: "line",
      },
      {
        label: `Numerical, dt = ${DT4} s`,
        pts: every(
          compSol.times.map((t, i): [number, number] => [
            t,
            compSol.nodes.C.pressure[i] / 1e3,
          ]),
          8,
        ),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
    ],
  }),
);

/* Schematic drawn last so it can carry the real case parameters. */
writeFig(1, "schematic", fig1Schematic());

/* ==========================================================================
 * Report markdown
 * ========================================================================== */

const fig = (n: number, caption: string) =>
  `![Figure ${n}](figures/fluid-transient/${figures[n]})\n\n*Figure ${n}. ${caption}*`;

const report = `# Rigid-Column Fluid Transient Validation of OpenFLUME

**Validation of the lumped fluid-inertia term (L/A)·dṁ/dt and the trapped-gas-cushion node model against closed-form rigid-column theory and Runge-Kutta references**

Generated by \`scripts/fluid-transient-validation-report.ts\` — all numbers and
figures come from live solves of the current solver. The corresponding CI gate
is \`src/core/__tests__/fluidTransient.test.ts\`.

## Abstract

This report validates the rigid-column fluid-transient capability of the
OpenFLUME solver — a pressure-based node-and-branch network code in the
GFSSP family — against the classical closed-form solutions of
incompressible-column surge theory. Two opt-in models are exercised: the
lumped fluid-inertia term (L/A)·dṁ/dt in the branch momentum equation
(\`pipe.inertia\`) and the polytropic trapped-gas-cushion node model
(\`node.gasCushion\`). Four benchmark cases are run: flow startup in a single
pipe under a step pressure difference (exact tanh law for quadratic friction),
flow decay after removal of the driving pressure (exact hyperbolic law), a
liquid column oscillating on a trapped-gas spring (fourth-order Runge-Kutta
reference of the nonlinear ODE plus the linearized natural frequency), and
quasi-static compression of a trapped-gas volume (exact polytropic law). The
startup and decay traces match the closed forms within
${pct(Math.max(sf.rms, df.rms), 2)} RMS at the refined time step, the
oscillator period matches the linearized prediction within
${pct(oscS.periodErrVsLin)} and the RK4 reference within
${pct(oscS.periodErrVsRK4)}, and the compression trace holds P·V_g^n constant
to ${pctSci(compMaxPVdev)}. The backward-Euler integrator's first-order
numerical damping of the oscillation amplitude is quantified and shown to
shrink in proportion to the time step. Method-of-characteristics acoustic
waterhammer is explicitly out of scope: the rigid-column model is valid for
timescales long compared to the acoustic transit time of the line.

## Introduction

Steady network solvers relate branch pressure drop to mass flow
instantaneously. During rapid transients — valve slam, pump start, surge into
a closed volume — the momentum of the liquid column itself delays the flow
response: the column must be accelerated by the net pressure force acting on
it. The classical lumped treatment (rigid-column or incompressible-column
theory; Wylie & Streeter, Chaudhry) treats the liquid in each line as a rigid
slug of mass ρLA, giving the momentum balance

$$\\frac{L}{A}\\frac{d\\dot m}{dt} = \\Delta P - \\Delta P_f(\\dot m),$$

which the solver adds to the branch momentum equation when \`inertia: true\`
is set on a pipe. Paired with a trapped-gas cushion — a polytropic gas spring
P·V_g^n = const at a tank node — the same term reproduces surge oscillations
of the Lee & Martin entrapped-air type.

This report validates both models against closed-form rigid-column solutions
and against fourth-order Runge-Kutta integrations of the governing ODEs,
using the same configurations as the CI gate
\`src/core/__tests__/fluidTransient.test.ts\`.

**Scope boundary.** Rigid-column theory neglects liquid compressibility and
pipe-wall elasticity, so it carries no pressure waves: it is valid when the
transient timescale is long compared to the acoustic transit time 2L/a of the
line (for the case-1 pipe, 2L/a ≈ 0.13 s against a flow time constant of
${fmt(tau1, 2)} s). Sudden events faster than the acoustic transit —
classical Joukowsky waterhammer — require the method of characteristics and
are explicitly outside the solver's scope; the (L/A) term captures bulk surge
only.

## Problem Description

All cases use water as an incompressible liquid (ρ = ${RHO} kg/m³,
μ = 10⁻³ Pa·s — the solver's \`water\` preset). Four cases are studied
(Figure 1):

| Case | Description |
| ---- | ----------- |
| 1 | Flow startup — step ΔP = ${(DP1 / 1e5).toFixed(0)} bar across an inertial pipe with fixed-f quadratic friction; exact tanh law |
| 2 | Flow decay — driving ΔP removed from the case-1 steady state; exact hyperbolic law |
| 3 | Gas-cushion oscillator — inertial water column against a trapped-gas spring, reservoir stepped ${(P_EQ / 1e5).toFixed(0)} → ${(P_STEP / 1e5).toFixed(0)} bar; RK4 + linearized frequency |
| 4 | Quasi-static cushion compression — constant ${MDOT4} kg/s inflow against the trapped gas; exact polytropic law |

Cases 1–2 use a pipe of L = ${L1} m, D = ${(D1 * 1000).toFixed(0)} mm
(A = ${(A1 * 1e3).toFixed(3)}·10⁻³ m²) with a fixed Darcy friction factor
f = ${F1}, between two pressure boundaries. Case 3 mirrors the CI oscillator:
L = ${L3} m, D = ${(D3 * 1000).toFixed(0)} mm, roughness 10⁻⁶ m
(Colebrook friction), discharging into a ${V_TOT * 1000} L tank node holding a
${VG0 * 1000} L trapped-gas cushion with polytropic index n = ${NPOLY}.
Case 4 feeds the same cushion node from a constant flow source with no pipe
inertia, isolating the cushion model.

${fig(1, "The three network topologies: (a) inertial pipe between two pressure boundaries (cases 1–2); (b) reservoir pressure step driving the liquid column against the trapped-gas cushion (case 3); (c) constant flow source compressing the cushion quasi-statically (case 4).")}

## Benchmark Solutions

### Startup: the tanh law

With a fixed Darcy friction factor the pipe's friction loss is exactly
quadratic, ΔP_f = K·ṁ² with

$$K = \\frac{f\\,L}{2\\,\\rho\\,D\\,A^2},$$

so the rigid-column momentum equation under a constant applied ΔP,

$$\\frac{L}{A}\\frac{d\\dot m}{dt} = \\Delta P - K\\dot m^2,$$

has the exact solution

$$\\dot m(t) = \\dot m_\\infty \\tanh(t/\\tau), \\qquad \\dot m_\\infty = \\sqrt{\\Delta P/K}, \\qquad \\tau = \\frac{L}{A}\\,\\frac{\\dot m_\\infty}{\\Delta P}.$$

For the case-1 parameters, ṁ∞ = ${fmt(mdotInf, 2)} kg/s
(v∞ = ${fmt(vInf, 2)} m/s) and τ = ${fmt(tau1, 3)} s. As a cross-check, an
RK4 integration of the momentum ODE using the solver's own
\`componentPressureDrop\` friction law reproduces the tanh value at t = 4τ to
machine-level accuracy.

### Decay: the hyperbolic law

Dropping the driving ΔP to zero from a steady flow ṁ₀ leaves

$$\\frac{L}{A}\\frac{d\\dot m}{dt} = -K\\dot m^2 \\;\\Rightarrow\\; \\dot m(t) = \\frac{\\dot m_0}{1 + t/\\tau_d}, \\qquad \\tau_d = \\frac{L}{A\\,K\\,\\dot m_0}.$$

Starting from the case-1 steady state (ṁ₀ = ṁ∞), τ_d = ${fmt(tauD, 3)} s —
numerically equal to the startup τ, since τ_d = (L/A)·ṁ∞/ΔP as well.
Quadratic friction gives algebraic (1/t), not exponential, decay: the damping
weakens as the flow slows.

### Oscillator: gas spring and linearized frequency

The liquid column (mass m_eff = ρLA = ${fmt(M_EFF, 2)} kg) rides on the
trapped-gas spring. The polytropic cushion P·V_g^n = C gives a stiffness, at
the stepped equilibrium (P = ${(P_STEP / 1e5).toFixed(0)} bar,
V_g,eq = V_g0·(P_eq/P_step)^{1/n} = ${(VG_EQ_NEW * 1000).toFixed(3)} L),

$$k_\\mathrm{eff} = \\left|\\frac{dP_\\mathrm{gas}}{dx}\\right|A = \\frac{n\\,P_\\mathrm{step}\\,A^2}{V_{g,\\mathrm{eq}}} = ${fmt(K_EFF, 1)}\\ \\mathrm{N/m},$$

so the linearized natural frequency and period are

$$\\omega = \\sqrt{k_\\mathrm{eff}/m_\\mathrm{eff}} = ${fmt(OMEGA_LIN, 3)}\\ \\mathrm{rad/s}, \\qquad T_\\mathrm{lin} = 2\\pi\\sqrt{\\frac{m_\\mathrm{eff}}{k_\\mathrm{eff}}} = ${fmt(T_LIN, 3)}\\ \\mathrm{s}.$$

Because the pressure step doubles the cushion pressure, the oscillation is
strongly nonlinear (the gas spring stiffens on compression), so the primary
reference is an RK4 integration of the full nonlinear system

$$\\frac{L}{A}\\frac{d\\dot m}{dt} = P_\\mathrm{step} - \\Delta P_f(\\dot m) - \\frac{P_\\mathrm{eq}V_{g0}^n}{(V_\\mathrm{tot}-V_w)^n}, \\qquad \\frac{dV_w}{dt} = \\frac{\\dot m}{\\rho},$$

with ΔP_f evaluated by the solver's own friction law so that friction
modeling is identical between reference and solver.

### Compression: the polytropic law

With a constant mass inflow and no inertia the cushion compresses
quasi-statically: V_g(t) = V_g0 − (ṁ/ρ)t exactly (incompressible liquid),
and the gas pressure follows

$$P(t) = P_0\\left(\\frac{V_{g0}}{V_g(t)}\\right)^{n}.$$

Over ${T_END4} s the gas volume falls from ${VG0 * 1000} L to
${(compVg(T_END4) * 1000).toFixed(2)} L and the pressure rises to
${(compP(T_END4) / 1e3).toFixed(1)} kPa.

## Numerical Modeling

OpenFLUME enforces mass conservation at internal nodes and one momentum
relation per branch. Two opt-in models close the rigid-column physics:

- **\`pipe.inertia\`** adds the lumped fluid-inertia term to the branch
  momentum equation, ΔP = ΔP_friction + (L/A)·dṁ/dt, discretized backward
  Euler: (L/A)·(ṁ − ṁ_prev)/Δt joins the Newton system of each transient
  step. In steady mode the term vanishes identically (the CI gate asserts
  bit-identical steady results with the flag on and off).
- **\`node.gasCushion\`** models a trapped, non-dissolving gas pocket in a
  liquid-filled tank node: the gas obeys P·V_g^n = const with the node
  pressure, the liquid volume V_tot − V_g supplies the node's mass-storage
  term, and validation restricts the model to incompressible /
  expandable-liquid transients.

Time integration is backward Euler with a coupled Newton solve per step
(\`solveTransient\`, fixed stepping). Backward Euler is unconditionally
stable but first-order accurate and numerically dissipative: for a linear
oscillator each step multiplies the amplitude by 1/√(1+(ωΔt)²), a per-period
decay factor of approximately exp(−πωΔt). This artificial damping is
quantified in case 3 rather than hidden. Initial flow states are seeded with
\`branches[].initialMdot\` (0 for startup and the oscillator, the analytic
steady flow for decay).

## Time-Step Selection

Each case resolves its transient timescale with the following ratios:

| Case | timescale | dt [s] | timescale/dt |
| ---- | --------- | ------ | ------------ |
| 1 — startup | τ = ${fmt(tau1, 3)} s | ${DT1_COARSE} / ${DT1_FINE} | ${(tau1 / DT1_COARSE).toFixed(0)} / ${(tau1 / DT1_FINE).toFixed(0)} |
| 2 — decay | τ_d = ${fmt(tauD, 3)} s | ${DT1_COARSE} / ${DT1_FINE} | ${(tauD / DT1_COARSE).toFixed(0)} / ${(tauD / DT1_FINE).toFixed(0)} |
| 3 — oscillator | T_lin = ${fmt(T_LIN, 3)} s | ${DT3} / ${DT3_FINE} | ${(T_LIN / DT3).toFixed(0)} / ${(T_LIN / DT3_FINE).toFixed(0)} |
| 4 — compression | fill time ${T_END4} s | ${DT4} | ${(T_END4 / DT4).toFixed(0)} |

Cases 1–3 are each run at two time steps to expose the first-order
convergence of the backward-Euler integrator; the coarser step matches the
kind of step a user would plausibly choose (≳ 50 steps per timescale), the
finer step is 4× smaller.

## Results and Discussion

| Case (dt) | converged | final-state error | time-constant / period error | trace RMS |
| --------- | --------- | ----------------- | ---------------------------- | --------- |
| 1 — startup (${DT1_COARSE} s) | ${sc.converged} | ${pct(sc.finalErr, 2)} | ${pct(sc.tauErr, 2)} (τ) | ${pct(sc.rms, 2)} |
| 1 — startup (${DT1_FINE} s) | ${sf.converged} | ${pct(sf.finalErr, 2)} | ${pct(sf.tauErr, 2)} (τ) | ${pct(sf.rms, 2)} |
| 2 — decay (${DT1_COARSE} s) | ${dc.converged} | ${pct(dc.finalErr, 2)} | ${pct(dc.tauErr, 2)} (τ_d) | ${pct(dc.rms, 2)} |
| 2 — decay (${DT1_FINE} s) | ${df.converged} | ${pct(df.finalErr, 2)} | ${pct(df.tauErr, 2)} (τ_d) | ${pct(df.rms, 2)} |
| 3 — oscillator (${DT3} s) | ${oscS.converged} | ${pct(oscS.firstPeakErr, 1)} (first peak) | ${pct(oscS.periodErrVsRK4, 1)} vs RK4, ${pct(oscS.periodErrVsLin, 1)} vs linearized | ${pct(oscS.rms, 1)} |
| 3 — oscillator (${DT3_FINE} s) | ${oscSF.converged} | ${pct(oscSF.firstPeakErr, 1)} (first peak) | ${pct(oscSF.periodErrVsRK4, 1)} vs RK4, ${pct(oscSF.periodErrVsLin, 1)} vs linearized | ${pct(oscSF.rms, 1)} |
| 4 — compression (${DT4} s) | ${compSol.converged} | ${pctSci(compFinalErr)} (final P) | — | ${pctSci(compRms)} |

Trace RMS is normalized by ṁ∞ (case 1), ṁ₀ (case 2), the RK4 first-peak
amplitude (case 3), and the final analytic pressure (case 4).

### Case 1: Flow Startup

Figure 2 shows the mass-flow rise under the step ΔP. The numerical trace
follows the tanh law closely at both time steps: the RMS deviation is
${pct(sc.rms, 2)} at dt = ${DT1_COARSE} s and ${pct(sf.rms, 2)} at
dt = ${DT1_FINE} s — a ratio of ${(sc.rms / sf.rms).toFixed(1)}, consistent
with the first-order accuracy of backward Euler (dt ratio 4). The measured
time constant (time to reach tanh(1) ≈ 76.16 % of ṁ∞) is
${fmt(sc.tauMeasured, 3)} s at the coarse step against the analytic
τ = ${fmt(tau1, 3)} s (${pct(sc.tauErr, 2)}); backward Euler slightly
${sc.tauMeasured > tau1 ? "overestimates" : "underestimates"} the rise time,
consistent with a dissipative first-order scheme. The final flow settles within ${pct(sc.finalErr, 2)} of the analytic
steady value — the steady solution is independent of the integrator, so the
error at t ≫ τ collapses to the Newton tolerance. The dashed trace shows the
same network without the \`inertia\` flag: the flow jumps to
${fmt(startNoInertia.branches.p1.mdot[1], 1)} kg/s (the quasi-steady value)
within the first step, which is precisely the behavior the inertia term is
there to prevent.

${fig(2, "Flow startup under a step ΔP: analytic tanh law vs backward-Euler solves at two time steps, plus the quasi-steady jump without the inertia flag.")}

### Case 2: Flow Decay

Figure 3 shows the decay after the driving pressure is removed from the
steady state. With quadratic friction the decay is hyperbolic — fast at
first, then increasingly slow — and the numerical trace tracks it within
${pct(dc.rms, 2)} RMS at dt = ${DT1_COARSE} s and ${pct(df.rms, 2)} at
dt = ${DT1_FINE} s. The half-flow time (ṁ = ṁ₀/2, analytically t = τ_d)
is reproduced within ${pct(dc.tauErr, 2)} at the coarse step and
${pct(df.tauErr, 2)} at the fine step. The largest relative deviations occur
in the first few steps, where dṁ/dt is steepest and the backward-Euler local
error is largest.

${fig(3, "Flow decay after removal of the driving ΔP: analytic hyperbolic law vs numerical solution.")}

### Case 3: Gas-Cushion Oscillator

Figures 4–6 show the surge oscillation of the water column against the
trapped-gas cushion after the reservoir pressure step. The solver resolves
${oscS.nPeaks} flow peaks in ${T_END3} s against ${oscR.nPeaks} in the RK4
reference. The mean peak-to-peak period is ${fmt(oscS.period, 3)} s at
dt = ${DT3} s, within ${pct(oscS.periodErrVsRK4, 1)} of the RK4 reference
(${fmt(oscR.period, 3)} s) and ${pct(oscS.periodErrVsLin, 1)} of the
linearized T_lin = ${fmt(T_LIN, 3)} s. The residual gap to T_lin is real
nonlinearity, not error — the RK4 reference itself sits
${pct(Math.abs(oscR.period - T_LIN) / T_LIN, 1)} from the linearized period,
because the large-amplitude motion samples the stiffening branch of the gas
spring.

**Amplitude and numerical damping.** The first flow peak is
${fmt(oscS.firstPeak, 2)} kg/s against ${fmt(oscR.firstPeak, 2)} kg/s from
RK4 (${pct(oscS.firstPeakErr, 1)} low). Successive peaks in the RK4
reference decay by a factor ${fmt(oscR.peakRatio, 3)} per period — this is
the physical friction of the smooth pipe (roughness 10⁻⁶ m). The solver's
peaks decay faster, by ${fmt(oscS.peakRatio, 3)} per period. The excess is
backward-Euler numerical damping: for a linear oscillator the scheme
multiplies amplitude by exp(−πωΔt) per period, which at ω = ${fmt(OMEGA_LIN, 2)} rad/s
and dt = ${DT3} s predicts a factor ${fmt(bePerPeriod(DT3), 3)} on top of the
physical decay — a combined ${fmt(bePerPeriod(DT3) * oscR.peakRatio, 3)},
close to the measured ${fmt(oscS.peakRatio, 3)}. Refining to
dt = ${DT3_FINE} s shrinks the predicted numerical factor to
${fmt(bePerPeriod(DT3_FINE), 3)} and the measured decay improves to
${fmt(oscSF.peakRatio, 3)} per period against RK4's ${fmt(oscR.peakRatio, 3)},
with the first-peak deficit dropping to ${pct(oscSF.firstPeakErr, 1)} and the
trace RMS to ${pct(oscSF.rms, 1)} (Figures 4 and 5). The damping is thus a
quantified, first-order-in-dt property of the integrator, not a model error;
users resolving oscillation amplitudes should budget ≳ ${(T_LIN / DT3_FINE / 1000).toFixed(0)}×10³
steps per period or use the adaptive stepper.

The cushion-pressure trace (Figure 6) tracks the RK4 gas pressure with an RMS
of ${pct(oscPrms, 1)} of the pressure swing, with the same progressive
amplitude attenuation.

**Friction-dominated variant.** With the pipe roughness raised to 10⁻⁴ m
(the CI test's damping check), physical friction dominates: the RK4 peaks
decay by ${fmt(oscRRough.peakRatio, 3)} per period and the solver measures
${fmt(oscSRough.peakRatio, 3)} at the same dt = ${DT3} s — the numerical
contribution is now a small correction on a large physical effect, and the
trace RMS against RK4 is ${pct(oscSRough.rms, 1)}.

${fig(4, "Gas-cushion oscillator: mass-flow trace, nonlinear RK4 reference vs solver at two time steps.")}

${fig(5, "First-period detail: both time steps track the RK4 trace closely; the coarse step loses a small amount of amplitude at the trough and second peak.")}

${fig(6, "Cushion pressure P(t): solver vs RK4 reference.")}

### Case 4: Quasi-Static Cushion Compression

Figure 7 shows the monotonic pressurization of the trapped gas under a
constant ${MDOT4} kg/s inflow. This case isolates the cushion model from the
inertia term (the branch is a flow source). The solved pressure holds the
polytropic invariant P·V_g^n = const to within ${pctSci(compMaxPVdev)} at
every step, the final pressure of
${(compSol.nodes.C.pressure[compSol.times.length - 1] / 1e3).toFixed(1)} kPa
is within ${pctSci(compFinalErr)} of the analytic
${(compP(T_END4) / 1e3).toFixed(1)} kPa, and the final gas volume is within
${pctSci(compVgFinalErr)} of the analytic ${(compVg(T_END4) * 1000).toFixed(3)} L.
The trace RMS is ${pctSci(compRms)}. Unlike cases 1–3 there is no
integration-error mechanism here — the polytropic relation is enforced
algebraically each step — so the residual deviation reflects the Newton
tolerance and the backward-Euler placement of the mass-storage term, not
accumulated drift.

${fig(7, "Quasi-static compression of the trapped-gas cushion: analytic polytropic law vs solver.")}

## Conclusions

The solver's lumped fluid-inertia term and trapped-gas-cushion model
reproduce the four canonical rigid-column transients. Startup and decay
follow the exact tanh and hyperbolic laws within
${pct(Math.max(sc.rms, dc.rms), 1)} RMS at an ordinary time step and within
${pct(Math.max(sf.rms, df.rms), 2)} at a 4× refined step, converging at the
first-order rate expected of backward Euler. The gas-cushion oscillator
matches the RK4 period within ${pct(Math.max(oscS.periodErrVsRK4, 0.001), 1)}
and the linearized natural frequency within ${pct(oscS.periodErrVsLin, 1)};
its amplitude decay separates cleanly into physical friction (present
identically in the RK4 reference) and backward-Euler numerical damping that
matches the exp(−πωΔt) prediction and shrinks proportionally with dt.
Quasi-static cushion compression holds the polytropic invariant to
${pctSci(compMaxPVdev)}. The multi-segment Lee & Martin entrapped-air
benchmark (GFSSP Figure 10) combines both models at engineering scale and is
exercised separately as a shipped example (user manual §7.10); it is not
repeated here. Acoustic waterhammer — wave propagation, Joukowsky pressure
spikes, method-of-characteristics solutions — remains explicitly out of
scope: the rigid-column model is valid only for transients slow compared to
the line's acoustic transit time.

## References

1. Wylie, E. B., and Streeter, V. L., *Fluid Transients in Systems*,
   Prentice Hall, 1993.
2. Chaudhry, M. H., *Applied Hydraulic Transients*, 3rd ed., Springer, 2014.
3. Lee, T. S., and Martin, C. S., "Transient analysis of entrapped air
   pockets in pipeline systems" (the entrapped-air oscillation benchmark
   reproduced as Figure 10 of the GFSSP manual; see also Majumdar et al.,
   AIAA 2015-3850).
4. Majumdar, A. K., LeClair, A. C., Moore, R., and Schallhorn, P. A.,
   *Generalized Fluid System Simulation Program, Version 6.0*,
   NASA/TM-2013-217492, 2013.
5. Press, W. H., et al., *Numerical Recipes*, 2nd ed., Cambridge University
   Press, 1992 (fourth-order Runge-Kutta method).

## Nomenclature

| Symbol | Meaning |
| ------ | ------- |
| A | pipe flow area |
| a | acoustic wave speed |
| D | pipe diameter |
| f | Darcy friction factor |
| K | quadratic resistance coefficient, ΔP_f = K·ṁ² |
| k_eff | linearized gas-spring stiffness |
| L | pipe length |
| ṁ | mass flow rate |
| ṁ∞ / ṁ₀ | steady (asymptotic) / initial mass flow rate |
| m_eff | liquid column mass ρLA |
| n | polytropic index of the trapped gas |
| P | pressure |
| T_lin | linearized natural period |
| t | time |
| V_g / V_w | gas / liquid (water) volume of the cushion node |
| V_tot | total cushion-node volume |
| Δt (dt) | integration time step |
| ρ | liquid density |
| τ / τ_d | startup / decay time constant |
| ω | linearized natural frequency |
`;

writeFileSync(join(outDir, "fluid-transient-report.md"), report);
console.log(`\nwrote docs/validation/fluid-transient-report.md`);
