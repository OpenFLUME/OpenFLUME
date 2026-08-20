/**
 * tank-transient-validation-report.ts — generates the transient tank
 * gas-dynamics validation report (docs/validation/tank-transient-report.md)
 * and its SVG figures (docs/validation/figures/tank/), covering adiabatic
 * blowdown through a choked orifice, a time-step convergence study, two-tank
 * pressure equalization, adiabatic charge (fill) heating, and blowdown
 * through a scheduled valve.
 *
 * All numbers and figures come from live solves — rerun after solver changes:
 *
 *   npx tsx scripts/tank-transient-validation-report.ts
 *
 * The physics/setup helpers mirror src/core/__tests__/transient.test.ts and
 * src/core/__tests__/benchmarks.test.ts (which are the CI gates; this script
 * is the human-readable artifact).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { solveTransient, validateNetwork } from "../src/core";
import type { NetworkConfig, TransientResult } from "../src/core";

/* ==========================================================================
 * Constants (SI) — air as ideal gas with mutually consistent γ, R, cp
 * ========================================================================== */

const GAMMA = 1.4;
const R_AIR = 287; // J/kg·K
const CP = (GAMMA * R_AIR) / (GAMMA - 1); // 1004.5 J/kg·K, so cp/cv = γ exactly
const CV = CP - R_AIR; // 717.5 J/kg·K
const MU_AIR = 1.8e-5; // Pa·s

const FLUID: NetworkConfig["fluid"] = {
  model: "idealGas",
  params: { R: R_AIR, gamma: GAMMA, mu: MU_AIR, cp: CP },
};

const toBar = (pa: number) => pa / 1e5;
const pct = (x: number, digits = 2) => `${(x * 100).toFixed(digits)} %`;
/** Percent with scientific notation below 0.01 % (for near-machine numbers). */
const pctSmart = (x: number) => {
  const v = x * 100;
  if (v === 0) return "0 %";
  return v >= 0.01 ? `${v.toFixed(2)} %` : `${v.toExponential(1)} %`;
};

/* ==========================================================================
 * Analytical references: RK4 of the lumped tank ODEs + closed forms
 * ========================================================================== */

/** RK4 with full state trace: dy/dt = f(t, y), fixed step, records every step. */
function rk4Trace(
  f: (t: number, y: number[]) => number[],
  y0: number[],
  tEnd: number,
  h: number,
): { times: number[]; states: number[][] } {
  const steps = Math.round(tEnd / h);
  const dt = tEnd / steps;
  let y = [...y0];
  const times = [0];
  const states = [y.slice()];
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    const k1 = f(t, y);
    const k2 = f(
      t + dt / 2,
      y.map((v, j) => v + (dt / 2) * k1[j]),
    );
    const k3 = f(
      t + dt / 2,
      y.map((v, j) => v + (dt / 2) * k2[j]),
    );
    const k4 = f(
      t + dt,
      y.map((v, j) => v + dt * k3[j]),
    );
    y = y.map((v, j) => v + (dt / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    times.push((i + 1) * dt);
    states.push(y.slice());
  }
  return { times, states };
}

/** Isentropic compressible-orifice mass flux with choking — mirrors
 *  OrificeCompressible.massFlow (src/core/components/orificeCompressible.ts). */
const CRIT_PR = Math.pow(2 / (GAMMA + 1), GAMMA / (GAMMA - 1));
const CHOKED_FLUX =
  Math.sqrt(GAMMA) * Math.pow(2 / (GAMMA + 1), (GAMMA + 1) / (2 * (GAMMA - 1)));

function isentropicMdot(
  CdA: number,
  pUp: number,
  pDown: number,
  Tup: number,
): number {
  if (pUp <= 0 || Tup <= 0) return 0;
  const PR = pDown / pUp;
  if (PR >= 1) return 0;
  const base = (CdA * pUp) / Math.sqrt(R_AIR * Tup);
  if (PR <= CRIT_PR) return base * CHOKED_FLUX;
  const term =
    ((2 * GAMMA) / (GAMMA - 1)) *
    (Math.pow(PR, 2 / GAMMA) - Math.pow(PR, (GAMMA + 1) / GAMMA));
  return term <= 0 ? 0 : base * Math.sqrt(term);
}

/** Bisection root finder (mirrors benchmarks.test.ts). */
function bisection(
  f: (x: number) => number,
  lo: number,
  hi: number,
  tol = 1e-12,
  maxIter = 200,
): number {
  let flo = f(lo);
  let fhi = f(hi);
  if (flo * fhi > 0) {
    for (let e = 0; e < 60; e++) {
      if (flo * fhi <= 0) break;
      const mid = (lo + hi) / 2;
      const fmid = f(mid);
      if (flo * fmid <= 0) {
        hi = mid;
        fhi = fmid;
      } else {
        lo = mid;
        flo = fmid;
      }
    }
  }
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const fmid = f(mid);
    if (Math.abs(hi - lo) < tol || Math.abs(fmid) < tol) return mid;
    if (flo * fmid <= 0) {
      hi = mid;
      fhi = fmid;
    } else {
      lo = mid;
      flo = fmid;
    }
  }
  return (lo + hi) / 2;
}

/* ==========================================================================
 * Shared solve/stats plumbing
 * ========================================================================== */

function solveValidated(config: NetworkConfig): TransientResult {
  const errors = validateNetwork(config);
  if (errors.length) throw new Error(`invalid network: ${errors.join("; ")}`);
  return solveTransient(config);
}

interface RefTrace {
  h: number; // reference output step
  P: number[];
  T: number[];
}

const refIdx = (t: number, h: number, len: number) =>
  Math.min(Math.round(t / h), len - 1);

/** Max-over-trace and final-state deviations of one tank node against an RK4
 *  reference, normalized by the initial tank pressure / temperature (the
 *  convention of the CI gates). Skips the t = 0 initial state. */
function tankTraceErrors(
  res: TransientResult,
  nodeId: string,
  ref: RefTrace,
  Pnorm: number,
  Tnorm: number,
) {
  const node = res.nodes[nodeId];
  let maxP = 0;
  let maxT = 0;
  for (let i = 1; i < res.times.length; i++) {
    const k = refIdx(res.times[i], ref.h, ref.P.length);
    maxP = Math.max(maxP, Math.abs(node.pressure[i] - ref.P[k]) / Pnorm);
    maxT = Math.max(maxT, Math.abs(node.temperature[i] - ref.T[k]) / Tnorm);
  }
  const last = res.times.length - 1;
  return {
    maxP,
    maxT,
    finalP: Math.abs(node.pressure[last] - ref.P[ref.P.length - 1]) / Pnorm,
    finalT: Math.abs(node.temperature[last] - ref.T[ref.T.length - 1]) / Tnorm,
  };
}

/** Global mass conservation: ∫|ṁ| dt through `branchId` vs the tank mass
 *  change V·|ρ₀ − ρ_final| (mirrors the conservation checks in the CI gates). */
function massConservationErr(
  res: TransientResult,
  nodeId: string,
  branchId: string,
  V: number,
  rho0: number,
): number {
  const mdots = res.branches[branchId].mdot;
  let integ = 0;
  for (let i = 1; i < mdots.length; i++) {
    integ += Math.abs(mdots[i]) * (res.times[i] - res.times[i - 1]);
  }
  const dens = res.nodes[nodeId].density;
  const dm = Math.abs(V * (rho0 - dens[dens.length - 1]));
  return Math.abs(integ - dm) / dm;
}

interface CaseStats {
  maxP: number;
  maxT: number;
  finalP: number;
  finalT: number;
  cons: number;
  steps: number;
  converged: boolean;
}

/* ==========================================================================
 * Minimal SVG chart renderer (copied verbatim from
 * scripts/compressible-validation-report.ts)
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
  let xMin = Math.min(...allPts.map((p) => p[0]));
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

const C = {
  analytic: "#000000",
  blue: "#1f5fa8",
  red: "#c0392b",
  green: "#1e8449",
  orange: "#d68910",
};

/** Marker points at every `step`-th trace index (always includes the last). */
function markerPts(
  times: number[],
  vals: number[],
  step: number,
  skipFirst = false,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = skipFirst ? 1 : 0; i < times.length; i++) {
    if (i % step !== 0 && i !== times.length - 1) continue;
    pts.push([times[i], vals[i]]);
  }
  return pts;
}

/** Dense reference thinned to ≤ maxPts polyline points. */
function linePts(
  times: number[],
  vals: number[],
  maxPts = 240,
): Array<[number, number]> {
  const n = times.length;
  const step = Math.max(1, Math.floor(n / maxPts));
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i += step) pts.push([times[i], vals[i]]);
  if (pts[pts.length - 1][0] !== times[n - 1])
    pts.push([times[n - 1], vals[n - 1]]);
  return pts;
}

/* ==========================================================================
 * Schematic figures
 * ========================================================================== */

function fig1TankSchematic(): string {
  const W = 720;
  const H = 300;
  const tx = 110;
  const ty = 92;
  const tw = 150;
  const th = 105;
  const yc = ty + th / 2;
  const ox = 380; // orifice center
  const bx = 560; // boundary node center
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">
<rect width="${W}" height="${H}" fill="white"/>
<text x="${W / 2}" y="24" text-anchor="middle" font-size="15" font-weight="bold">Single-tank transient layout (cases 1, 2, 4, 5)</text>
<rect x="${tx}" y="${ty}" width="${tw}" height="${th}" rx="10" fill="#eef4fb" stroke="#333" stroke-width="1.6"/>
<text x="${tx + tw / 2}" y="${yc - 12}" text-anchor="middle" font-size="13">Tank (internal node)</text>
<text x="${tx + tw / 2}" y="${yc + 8}" text-anchor="middle" font-size="13">V = 0.1 m³</text>
<text x="${tx + tw / 2}" y="${yc + 28}" text-anchor="middle" font-size="13">m(t), U(t) → P(t), T(t)</text>
<line x1="${tx + tw}" y1="${yc}" x2="${ox - 22}" y2="${yc}" stroke="#1f5fa8" stroke-width="2.2"/>
<polygon points="${ox - 22},${yc} ${ox - 34},${yc - 6} ${ox - 34},${yc + 6}" fill="#1f5fa8"/>
<polygon points="${ox - 18},${yc} ${ox - 18},${yc - 16} ${ox},${yc} ${ox - 18},${yc + 16}" fill="none" stroke="#333" stroke-width="1.6"/>
<polygon points="${ox + 18},${yc} ${ox + 18},${yc - 16} ${ox},${yc} ${ox + 18},${yc + 16}" fill="none" stroke="#333" stroke-width="1.6"/>
<text x="${ox}" y="${yc - 26}" text-anchor="middle" font-size="12">orifice / resistance / valve</text>
<line x1="${ox + 22}" y1="${yc}" x2="${bx - 30}" y2="${yc}" stroke="#1f5fa8" stroke-width="2.2"/>
<polygon points="${bx - 30},${yc} ${bx - 42},${yc - 6} ${bx - 42},${yc + 6}" fill="#1f5fa8"/>
<circle cx="${bx}" cy="${yc}" r="28" fill="#fdf2e3" stroke="#333" stroke-width="1.6"/>
<text x="${bx}" y="${yc - 2}" text-anchor="middle" font-size="12">boundary</text>
<text x="${bx}" y="${yc + 14}" text-anchor="middle" font-size="12">P<tspan font-size="9" dy="3">b</tspan><tspan dy="-3">, T</tspan><tspan font-size="9" dy="3">b</tspan></text>
<text x="${tx}" y="${ty + th + 34}" font-size="12">Cases 1–2 (blowdown): P₀ = 10 bar, T₀ = 300 K → orificeCompressible C<tspan font-size="9" dy="3">d</tspan><tspan dy="-3">A = 6.0×10⁻⁵ m² → 1 bar boundary</tspan></text>
<text x="${tx}" y="${ty + th + 52}" font-size="12">Case 4 (charge): 5 bar / 300 K supply boundary → resistance (K = 10, A = 10⁻³ m²) → tank initially at 1 bar</text>
<text x="${tx}" y="${ty + th + 70}" font-size="12">Case 5 (schedule): tank at 5 bar → valve (position ramps 0 → 1 over 2 s) → orifice → 1 bar boundary</text>
<text x="${W / 2}" y="${H - 8}" text-anchor="middle" font-size="12">Figure 1. Lumped tank connected to a pressure boundary through a flow component.</text>
</svg>`;
}

function fig2TwoTankSchematic(): string {
  const W = 720;
  const H = 270;
  const t1x = 100;
  const t2x = 470;
  const ty = 80;
  const tw = 150;
  const th = 100;
  const yc = ty + th / 2;
  const ox = (t1x + tw + t2x) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">
<rect width="${W}" height="${H}" fill="white"/>
<text x="${W / 2}" y="24" text-anchor="middle" font-size="15" font-weight="bold">Two-tank equalization layout (case 3)</text>
<rect x="${t1x}" y="${ty}" width="${tw}" height="${th}" rx="10" fill="#eef4fb" stroke="#333" stroke-width="1.6"/>
<text x="${t1x + tw / 2}" y="${yc - 12}" text-anchor="middle" font-size="13">Tank 1</text>
<text x="${t1x + tw / 2}" y="${yc + 6}" text-anchor="middle" font-size="13">V₁ = 0.05 m³</text>
<text x="${t1x + tw / 2}" y="${yc + 24}" text-anchor="middle" font-size="13">P₁,₀ = 5 bar, 300 K</text>
<rect x="${t2x}" y="${ty}" width="${tw}" height="${th}" rx="10" fill="#eef4fb" stroke="#333" stroke-width="1.6"/>
<text x="${t2x + tw / 2}" y="${yc - 12}" text-anchor="middle" font-size="13">Tank 2</text>
<text x="${t2x + tw / 2}" y="${yc + 6}" text-anchor="middle" font-size="13">V₂ = 0.10 m³</text>
<text x="${t2x + tw / 2}" y="${yc + 24}" text-anchor="middle" font-size="13">P₂,₀ = 2 bar, 300 K</text>
<line x1="${t1x + tw}" y1="${yc}" x2="${ox - 22}" y2="${yc}" stroke="#1f5fa8" stroke-width="2.2"/>
<polygon points="${ox - 22},${yc} ${ox - 34},${yc - 6} ${ox - 34},${yc + 6}" fill="#1f5fa8"/>
<polygon points="${ox - 18},${yc} ${ox - 18},${yc - 16} ${ox},${yc} ${ox - 18},${yc + 16}" fill="none" stroke="#333" stroke-width="1.6"/>
<polygon points="${ox + 18},${yc} ${ox + 18},${yc - 16} ${ox},${yc} ${ox + 18},${yc + 16}" fill="none" stroke="#333" stroke-width="1.6"/>
<text x="${ox}" y="${yc - 26}" text-anchor="middle" font-size="12">orifice C<tspan font-size="9" dy="3">d</tspan><tspan dy="-3">A = 6.0×10⁻⁵ m²</tspan></text>
<line x1="${ox + 22}" y1="${yc}" x2="${t2x}" y2="${yc}" stroke="#1f5fa8" stroke-width="2.2"/>
<line x1="${t1x + tw / 2}" y1="${ty}" x2="${t1x + tw / 2}" y2="${ty - 28}" stroke="#999" stroke-width="1.4" stroke-dasharray="5 4"/>
<text x="${t1x + tw / 2 + 8}" y="${ty - 16}" font-size="11">closed valve to 1 bar boundary (position = 0; the network requires one boundary node)</text>
<text x="${W / 2}" y="${H - 12}" text-anchor="middle" font-size="12">Figure 2. Two rigid tanks joined by an orifice; the smaller high-pressure tank discharges into the larger one.</text>
</svg>`;
}

/* ==========================================================================
 * Output plumbing
 * ========================================================================== */

const outDir = join(process.cwd(), "docs", "validation");
const figDir = join(outDir, "figures", "tank");
mkdirSync(figDir, { recursive: true });

const figures: string[] = [];
function writeFig(n: number, name: string, svg: string): string {
  const file = `fig${String(n).padStart(2, "0")}-${name}.svg`;
  writeFileSync(join(figDir, file), svg);
  figures[n] = file;
  console.log(`  wrote figures/tank/${file}`);
  return file;
}

console.log("Generating tank transient validation report…");

writeFig(1, "tank-schematic", fig1TankSchematic());
writeFig(2, "twotank-schematic", fig2TwoTankSchematic());

/* ==========================================================================
 * Cases 1 & 2 — adiabatic blowdown through a choked compressible orifice,
 * plus the time-step convergence study
 * ========================================================================== */

console.log("Case 1 — adiabatic choked blowdown");

const BD = {
  V: 0.1,
  P0: 1e6,
  T0: 300,
  Pout: 1e5,
  A: 1e-4,
  Cd: 0.6,
  endTime: 8.0,
};
const BD_CdA = BD.Cd * BD.A;
const bdM0 = (BD.P0 * BD.V) / (R_AIR * BD.T0);
const bdU0 = bdM0 * CV * BD.T0;

/* RK4 reference of the coupled mass/energy ODEs (state y = [m, U]). */
const bdOde = (_t: number, y: number[]): number[] => {
  const [m, U] = y;
  const T = U / (m * CV);
  const P = (m * R_AIR * T) / BD.V;
  const md = isentropicMdot(BD_CdA, P, BD.Pout, T);
  return [-md, -md * CP * T];
};
const BD_HREF = 1e-3;
const bdRef = rk4Trace(bdOde, [bdM0, bdU0], BD.endTime, BD_HREF);
const bdRefT: number[] = [];
const bdRefP: number[] = [];
const bdRefMdot: number[] = [];
for (const [m, U] of bdRef.states) {
  const T = U / (m * CV);
  const P = (m * R_AIR * T) / BD.V;
  bdRefT.push(T);
  bdRefP.push(P);
  bdRefMdot.push(isentropicMdot(BD_CdA, P, BD.Pout, T));
}
const bdRefTrace: RefTrace = { h: BD_HREF, P: bdRefP, T: bdRefT };

/* Closed form for choked adiabatic blowdown. */
const bdTau = BD.V / (BD_CdA * CHOKED_FLUX * Math.sqrt(R_AIR * BD.T0));
const bdClosedM = (t: number) =>
  Math.pow(1 + ((GAMMA - 1) / 2) * (t / bdTau), -2 / (GAMMA - 1));
const bdClosedP = (t: number) => BD.P0 * Math.pow(bdClosedM(t), GAMMA);
const bdClosedT = (t: number) => BD.T0 * Math.pow(bdClosedM(t), GAMMA - 1);

/* RK4 vs closed form cross-check (both exact while the orifice is choked). */
let bdClosedFormDev = 0;
for (let i = 0; i < bdRef.times.length; i++) {
  bdClosedFormDev = Math.max(
    bdClosedFormDev,
    Math.abs(bdRefP[i] - bdClosedP(bdRef.times[i])) / BD.P0,
  );
}
/* Time at which the orifice unchokes (P falls to Pout/critPR). */
const bdUnchokeP = BD.Pout / CRIT_PR;
const bdFinalPR = BD.Pout / bdRefP[bdRefP.length - 1];

function blowdownConfig(dt: number): NetworkConfig {
  return {
    meta: { name: "tank blowdown validation", version: 2 },
    settings: {
      mode: "transient",
      dt,
      endTime: BD.endTime,
      tolerance: 1e-9,
      maxIterations: 500,
      relaxation: 0.9,
    },
    fluid: FLUID,
    nodes: [
      {
        id: "tank",
        type: "internal",
        x: 0,
        y: 0,
        pressure: BD.P0,
        temperature: BD.T0,
        volume: BD.V,
      },
      {
        id: "out",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: BD.Pout,
        temperature: BD.T0,
      },
    ],
    branches: [
      {
        id: "o1",
        from: "tank",
        to: "out",
        component: { type: "orificeCompressible", area: BD.A, cd: BD.Cd },
      },
    ],
  };
}

interface BlowdownRun {
  dt: number;
  res: TransientResult;
  stats: CaseStats;
  maxMdot: number; // max |ṁ − ṁ_ref| / ṁ_ref(0)
}

function runBlowdown(dt: number): BlowdownRun {
  const res = solveValidated(blowdownConfig(dt));
  const e = tankTraceErrors(res, "tank", bdRefTrace, BD.P0, BD.T0);
  const cons = massConservationErr(
    res,
    "tank",
    "o1",
    BD.V,
    BD.P0 / (R_AIR * BD.T0),
  );
  let maxMdot = 0;
  for (let i = 1; i < res.times.length; i++) {
    const k = refIdx(res.times[i], BD_HREF, bdRefMdot.length);
    maxMdot = Math.max(
      maxMdot,
      Math.abs(res.branches.o1.mdot[i] - bdRefMdot[k]) / bdRefMdot[0],
    );
  }
  return {
    dt,
    res,
    maxMdot,
    stats: {
      ...e,
      cons,
      steps: res.times.length - 1,
      converged: res.converged,
    },
  };
}

const BD_DTS = [0.4, 0.2, 0.1, 0.05];
const bdRuns = BD_DTS.map(runBlowdown);
const bdFine = bdRuns[bdRuns.length - 1]; // dt = 0.05

for (const r of bdRuns) {
  console.log(
    `  dt=${r.dt}: converged=${r.stats.converged} maxP=${pct(r.stats.maxP)} maxT=${pct(r.stats.maxT)} finalP=${pct(r.stats.finalP)} mdot=${pct(r.maxMdot)} cons=${pct(r.stats.cons, 3)}`,
  );
}
console.log(
  `  closed-form vs RK4 max dev: ${pct(bdClosedFormDev, 4)} (τ = ${bdTau.toFixed(3)} s)`,
);

/* Observed convergence order between successive dt pairs (final P error). */
const bdOrders: number[] = [];
for (let i = 1; i < bdRuns.length; i++) {
  bdOrders.push(Math.log2(bdRuns[i - 1].stats.finalP / bdRuns[i].stats.finalP));
}
console.log(
  `  observed orders (final P): ${bdOrders.map((o) => o.toFixed(2)).join(", ")}`,
);

/* ---------- blowdown figures ---------- */

const bdTankP = bdFine.res.nodes.tank.pressure;
const bdTankT = bdFine.res.nodes.tank.temperature;
const bdTimes = bdFine.res.times;

writeFig(
  3,
  "blowdown-pressure",
  lineChart({
    title: "Adiabatic choked blowdown: tank pressure",
    xLabel: "Time t [s]",
    yLabel: "Tank pressure [bar]",
    series: [
      {
        label: "Analytical (RK4)",
        pts: linePts(bdRef.times, bdRefP.map(toBar)),
        color: C.analytic,
        mode: "line",
      },
      {
        label: "Closed form (choked)",
        pts: linePts(
          bdRef.times,
          bdRef.times.map((t) => toBar(bdClosedP(t))),
        ),
        color: C.orange,
        mode: "line",
        dash: "7 4",
      },
      {
        label: "Numerical, dt = 0.05 s",
        pts: markerPts(bdTimes, bdTankP.map(toBar), 8),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
    ],
  }),
);

writeFig(
  4,
  "blowdown-temperature",
  lineChart({
    title: "Adiabatic choked blowdown: tank temperature",
    xLabel: "Time t [s]",
    yLabel: "Tank temperature [K]",
    series: [
      {
        label: "Analytical (RK4)",
        pts: linePts(bdRef.times, bdRefT),
        color: C.analytic,
        mode: "line",
      },
      {
        label: "Closed form T₀(m/m₀)^(γ−1)",
        pts: linePts(bdRef.times, bdRef.times.map(bdClosedT)),
        color: C.orange,
        mode: "line",
        dash: "7 4",
      },
      {
        label: "Numerical, dt = 0.05 s",
        pts: markerPts(bdTimes, bdTankT, 8),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
    ],
  }),
);

writeFig(
  5,
  "blowdown-mdot",
  lineChart({
    title: "Adiabatic choked blowdown: vent mass flow rate",
    xLabel: "Time t [s]",
    yLabel: "Mass flow rate [kg/s]",
    series: [
      {
        label: "Analytical (RK4)",
        pts: linePts(bdRef.times, bdRefMdot),
        color: C.analytic,
        mode: "line",
      },
      {
        label: "Numerical, dt = 0.05 s",
        pts: markerPts(bdTimes, bdFine.res.branches.o1.mdot, 8, true),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
    ],
  }),
);

console.log("Case 2 — time-step convergence study");

writeFig(
  6,
  "dt-study-pressure",
  lineChart({
    title: "Time-step study: tank pressure during blowdown",
    xLabel: "Time t [s]",
    yLabel: "Tank pressure [bar]",
    series: [
      {
        label: "Analytical (RK4)",
        pts: linePts(bdRef.times, bdRefP.map(toBar)),
        color: C.analytic,
        mode: "line",
      },
      {
        label: "Numerical, dt = 0.4 s",
        pts: markerPts(
          bdRuns[0].res.times,
          bdRuns[0].res.nodes.tank.pressure.map(toBar),
          1,
        ),
        color: C.red,
        mode: "markers",
        marker: "square",
      },
      {
        label: "Numerical, dt = 0.2 s",
        pts: markerPts(
          bdRuns[1].res.times,
          bdRuns[1].res.nodes.tank.pressure.map(toBar),
          2,
        ),
        color: C.green,
        mode: "markers",
        marker: "triangle",
      },
      {
        label: "Numerical, dt = 0.1 s",
        pts: markerPts(
          bdRuns[2].res.times,
          bdRuns[2].res.nodes.tank.pressure.map(toBar),
          4,
        ),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
    ],
  }),
);

writeFig(
  7,
  "dt-convergence",
  lineChart({
    title: "Time-step convergence: deviation from the RK4 reference",
    xLabel: "Time step dt [s]",
    yLabel: "Deviation [% of P₀ / T₀]",
    legend: "top-left",
    series: [
      {
        label: "Final tank pressure",
        pts: bdRuns.map((r): [number, number] => [r.dt, r.stats.finalP * 100]),
        color: C.blue,
        mode: "both",
        marker: "circle",
      },
      {
        label: "Max pressure over trace",
        pts: bdRuns.map((r): [number, number] => [r.dt, r.stats.maxP * 100]),
        color: C.red,
        mode: "both",
        marker: "square",
      },
      {
        label: "Max temperature over trace",
        pts: bdRuns.map((r): [number, number] => [r.dt, r.stats.maxT * 100]),
        color: C.green,
        mode: "both",
        marker: "triangle",
      },
    ],
  }),
);

/* ==========================================================================
 * Case 3 — two-tank pressure equalization (mirrors benchmark B4)
 * ========================================================================== */

console.log("Case 3 — two-tank equalization");

const TT = {
  V1: 0.05,
  V2: 0.1,
  P1_0: 5e5,
  P2_0: 2e5,
  T0: 300,
  A: 1e-4,
  Cd: 0.6,
  endTime: 3.0,
  dt: 0.05,
};
const ttM1_0 = (TT.P1_0 * TT.V1) / (R_AIR * TT.T0);
const ttM2_0 = (TT.P2_0 * TT.V2) / (R_AIR * TT.T0);

/* Coupled 4-ODE RK4 reference: y = [m1, U1, m2, U2].  The orifice model is
 * the solver's incompressible orifice with upstream density. */
const ttOde = (_t: number, y: number[]): number[] => {
  const [m1, U1, m2, U2] = y;
  const T1 = U1 / (m1 * CV);
  const T2 = U2 / (m2 * CV);
  const P1 = (m1 * R_AIR * T1) / TT.V1;
  const P2 = (m2 * R_AIR * T2) / TT.V2;
  const dp = P1 - P2;
  const Tup = dp > 0 ? T1 : T2;
  const rhoUp = Math.max(P1, P2) / (R_AIR * Tup);
  const md = TT.Cd * TT.A * Math.sqrt(2 * rhoUp * Math.abs(dp)) * Math.sign(dp);
  return [-md, -md * CP * Tup, +md, +md * CP * Tup];
};
const TT_HREF = 5e-4;
const ttRef = rk4Trace(
  ttOde,
  [ttM1_0, ttM1_0 * CV * TT.T0, ttM2_0, ttM2_0 * CV * TT.T0],
  TT.endTime,
  TT_HREF,
);
const ttRefP1: number[] = [];
const ttRefP2: number[] = [];
const ttRefT1: number[] = [];
const ttRefT2: number[] = [];
for (const [m1, U1, m2, U2] of ttRef.states) {
  const T1 = U1 / (m1 * CV);
  const T2 = U2 / (m2 * CV);
  ttRefP1.push((m1 * R_AIR * T1) / TT.V1);
  ttRefP2.push((m2 * R_AIR * T2) / TT.V2);
  ttRefT1.push(T1);
  ttRefT2.push(T2);
}

/* Closed-form equilibrium from total internal-energy conservation. */
const ttPeq = (TT.P1_0 * TT.V1 + TT.P2_0 * TT.V2) / (TT.V1 + TT.V2);

const ttConfig: NetworkConfig = {
  meta: { name: "two-tank equalization validation", version: 2 },
  settings: {
    mode: "transient",
    dt: TT.dt,
    endTime: TT.endTime,
    tolerance: 1e-9,
    maxIterations: 500,
    relaxation: 0.9,
  },
  fluid: FLUID,
  nodes: [
    {
      id: "tank1",
      type: "internal",
      x: 0,
      y: 0,
      pressure: TT.P1_0,
      temperature: TT.T0,
      volume: TT.V1,
    },
    {
      id: "tank2",
      type: "internal",
      x: 1,
      y: 0,
      pressure: TT.P2_0,
      temperature: TT.T0,
      volume: TT.V2,
    },
    {
      id: "amb",
      type: "boundary",
      x: 2,
      y: 0,
      pressure: 1e5,
      temperature: TT.T0,
    },
  ],
  branches: [
    {
      id: "o1",
      from: "tank1",
      to: "tank2",
      component: { type: "orifice", area: TT.A, cd: TT.Cd },
    },
    {
      id: "v1",
      from: "tank1",
      to: "amb",
      component: { type: "valve", area: 1e-4, cd: TT.Cd, position: 0 },
    },
  ],
};

const ttRes = solveValidated(ttConfig);
const ttE1 = tankTraceErrors(
  ttRes,
  "tank1",
  { h: TT_HREF, P: ttRefP1, T: ttRefT1 },
  TT.P1_0,
  TT.T0,
);
const ttE2 = tankTraceErrors(
  ttRes,
  "tank2",
  { h: TT_HREF, P: ttRefP2, T: ttRefT2 },
  TT.P1_0,
  TT.T0,
);

/* Total-mass drift over the whole trace (from solved densities). */
const ttMass0 = ttM1_0 + ttM2_0;
let ttMassDrift = 0;
for (let i = 0; i < ttRes.times.length; i++) {
  const m =
    ttRes.nodes.tank1.density[i] * TT.V1 + ttRes.nodes.tank2.density[i] * TT.V2;
  ttMassDrift = Math.max(ttMassDrift, Math.abs(m - ttMass0) / ttMass0);
}

/* Leakage through the closed boundary valve (must be negligible). */
const ttMaxOrifice = Math.max(...ttRes.branches.o1.mdot.slice(1).map(Math.abs));
const ttMaxValve = Math.max(...ttRes.branches.v1.mdot.slice(1).map(Math.abs));
const ttLeakRatio = ttMaxValve / ttMaxOrifice;

const ttLast = ttRes.times.length - 1;
const ttFinalP1 = ttRes.nodes.tank1.pressure[ttLast];
const ttFinalP2 = ttRes.nodes.tank2.pressure[ttLast];
const ttFinalT1 = ttRes.nodes.tank1.temperature[ttLast];
const ttFinalT2 = ttRes.nodes.tank2.temperature[ttLast];
const ttPeqErr1 = Math.abs(ttFinalP1 - ttPeq) / ttPeq;
const ttPeqErr2 = Math.abs(ttFinalP2 - ttPeq) / ttPeq;

const ttStats: CaseStats = {
  maxP: Math.max(ttE1.maxP, ttE2.maxP),
  maxT: Math.max(ttE1.maxT, ttE2.maxT),
  finalP: Math.max(ttPeqErr1, ttPeqErr2),
  finalT: Math.max(ttE1.finalT, ttE2.finalT),
  cons: ttMassDrift,
  steps: ttRes.times.length - 1,
  converged: ttRes.converged,
};

console.log(
  `  converged=${ttStats.converged} maxP=${pct(ttStats.maxP)} maxT=${pct(ttStats.maxT)} Peq err=${pct(ttStats.finalP)} massDrift=${pct(ttMassDrift, 4)} leak=${ttLeakRatio.toExponential(1)}`,
);

writeFig(
  8,
  "twotank-pressure",
  lineChart({
    title: "Two-tank equalization: tank pressures",
    xLabel: "Time t [s]",
    yLabel: "Pressure [bar]",
    series: [
      {
        label: "Tank 1 — analytical (RK4)",
        pts: linePts(ttRef.times, ttRefP1.map(toBar)),
        color: C.analytic,
        mode: "line",
      },
      {
        label: "Tank 2 — analytical (RK4)",
        pts: linePts(ttRef.times, ttRefP2.map(toBar)),
        color: C.analytic,
        mode: "line",
        dash: "7 4",
      },
      {
        label: "Tank 1 — numerical",
        pts: markerPts(ttRes.times, ttRes.nodes.tank1.pressure.map(toBar), 3),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
      {
        label: "Tank 2 — numerical",
        pts: markerPts(ttRes.times, ttRes.nodes.tank2.pressure.map(toBar), 3),
        color: C.red,
        mode: "markers",
        marker: "square",
      },
      {
        label: "Equilibrium (P₁V₁+P₂V₂)/(V₁+V₂)",
        pts: [
          [0, toBar(ttPeq)],
          [TT.endTime, toBar(ttPeq)],
        ],
        color: C.green,
        mode: "line",
        dash: "2 4",
      },
    ],
  }),
);

writeFig(
  9,
  "twotank-temperature",
  lineChart({
    title: "Two-tank equalization: tank temperatures",
    xLabel: "Time t [s]",
    yLabel: "Temperature [K]",
    // The curves settle onto the top and bottom right, so both right-hand
    // corners sit on data; the band between the settled curves is clear.
    legend: "center-right",
    series: [
      {
        label: "Tank 1 — analytical (RK4)",
        pts: linePts(ttRef.times, ttRefT1),
        color: C.analytic,
        mode: "line",
      },
      {
        label: "Tank 2 — analytical (RK4)",
        pts: linePts(ttRef.times, ttRefT2),
        color: C.analytic,
        mode: "line",
        dash: "7 4",
      },
      {
        label: "Tank 1 — numerical",
        pts: markerPts(ttRes.times, ttRes.nodes.tank1.temperature, 3),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
      {
        label: "Tank 2 — numerical",
        pts: markerPts(ttRes.times, ttRes.nodes.tank2.temperature, 3),
        color: C.red,
        mode: "markers",
        marker: "square",
      },
    ],
  }),
);

/* ==========================================================================
 * Case 4 — adiabatic charging of a tank (fill heating)
 * ========================================================================== */

console.log("Case 4 — adiabatic fill heating");

const FL = {
  V: 0.1,
  P0: 1e5,
  Psup: 5e5,
  Tsup: 300,
  A: 0.001,
  K: 10,
  endTime: 5.0,
  dt: 0.05,
};
const flRhoSup = FL.Psup / (R_AIR * FL.Tsup);
const flMdot = (P: number) => {
  const dP = Math.max(FL.Psup - P, 1e-6);
  return FL.A * Math.sqrt((2 * flRhoSup * dP) / FL.K);
};
const flM0 = (FL.P0 * FL.V) / (R_AIR * FL.Tsup);

const flOde = (_t: number, y: number[]): number[] => {
  const [m, U] = y;
  const T = U / (m * CV);
  const P = (m * R_AIR * T) / FL.V;
  const md = flMdot(P);
  return [md, md * CP * FL.Tsup];
};
const FL_HREF = 5e-4;
const flRef = rk4Trace(flOde, [flM0, flM0 * CV * FL.Tsup], FL.endTime, FL_HREF);
const flRefP: number[] = [];
const flRefT: number[] = [];
for (const [m, U] of flRef.states) {
  const T = U / (m * CV);
  flRefT.push(T);
  flRefP.push((m * R_AIR * T) / FL.V);
}

/* Closed-form final temperature from the fill energy balance (T_s = T_0):
 * T_f = γ T_0 P_s / (P_s + (γ−1) P_0); evacuated-tank limit T_f → γ T_s. */
const flTfClosed =
  (GAMMA * FL.Tsup * FL.Psup) / (FL.Psup + (GAMMA - 1) * FL.P0);

const flConfig: NetworkConfig = {
  meta: { name: "adiabatic fill validation", version: 2 },
  settings: {
    mode: "transient",
    dt: FL.dt,
    endTime: FL.endTime,
    tolerance: 1e-9,
    maxIterations: 500,
    relaxation: 0.9,
  },
  fluid: FLUID,
  nodes: [
    {
      id: "tank",
      type: "internal",
      x: 0,
      y: 0,
      pressure: FL.P0,
      temperature: FL.Tsup,
      volume: FL.V,
    },
    {
      id: "sup",
      type: "boundary",
      x: 1,
      y: 0,
      pressure: FL.Psup,
      temperature: FL.Tsup,
    },
  ],
  branches: [
    {
      id: "r1",
      from: "sup",
      to: "tank",
      component: { type: "resistance", k: FL.K, area: FL.A },
    },
  ],
};

const flRes = solveValidated(flConfig);
const flE = tankTraceErrors(
  flRes,
  "tank",
  { h: FL_HREF, P: flRefP, T: flRefT },
  FL.Psup,
  FL.Tsup,
);
const flCons = massConservationErr(
  flRes,
  "tank",
  "r1",
  FL.V,
  FL.P0 / (R_AIR * FL.Tsup),
);
const flLast = flRes.times.length - 1;
const flFinalT = flRes.nodes.tank.temperature[flLast];
const flFinalP = flRes.nodes.tank.pressure[flLast];
const flTfClosedErr = Math.abs(flFinalT - flTfClosed) / flTfClosed;

const flStats: CaseStats = {
  ...flE,
  cons: flCons,
  steps: flRes.times.length - 1,
  converged: flRes.converged,
};

console.log(
  `  converged=${flStats.converged} maxP=${pct(flStats.maxP)} maxT=${pct(flStats.maxT)} T_final=${flFinalT.toFixed(1)} K (closed form ${flTfClosed.toFixed(1)} K, err=${pct(flTfClosedErr)}) cons=${pct(flCons, 3)}`,
);

writeFig(
  10,
  "fill-pressure",
  lineChart({
    title: "Adiabatic fill: tank pressure",
    xLabel: "Time t [s]",
    yLabel: "Tank pressure [bar]",
    legend: "bottom-right",
    series: [
      {
        label: "Analytical (RK4)",
        pts: linePts(flRef.times, flRefP.map(toBar)),
        color: C.analytic,
        mode: "line",
      },
      {
        label: "Numerical, dt = 0.05 s",
        pts: markerPts(flRes.times, flRes.nodes.tank.pressure.map(toBar), 5),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
    ],
  }),
);

writeFig(
  11,
  "fill-temperature",
  lineChart({
    title: "Adiabatic fill: tank temperature (fill heating)",
    xLabel: "Time t [s]",
    yLabel: "Tank temperature [K]",
    legend: "bottom-right",
    series: [
      {
        label: "Analytical (RK4)",
        pts: linePts(flRef.times, flRefT),
        color: C.analytic,
        mode: "line",
      },
      {
        label: "Closed-form final T",
        pts: [
          [0, flTfClosed],
          [FL.endTime, flTfClosed],
        ],
        color: C.orange,
        mode: "line",
        dash: "2 4",
      },
      {
        label: "Numerical, dt = 0.05 s",
        pts: markerPts(flRes.times, flRes.nodes.tank.temperature, 5),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
    ],
  }),
);

/* ==========================================================================
 * Case 5 — blowdown through a scheduled valve (mirrors benchmark B6)
 * ========================================================================== */

console.log("Case 5 — blowdown through a scheduled valve");

const VS = {
  V: 0.1,
  P0: 5e5,
  T0: 300,
  Pamb: 1e5,
  Cd: 0.6,
  Avalve: 0.001,
  Aorifice: 0.001,
  rampEnd: 2.0,
  endTime: 4.0,
  dt: 0.05,
};
const VS_CdAv = VS.Cd * VS.Avalve;
const VS_CdAo = VS.Cd * VS.Aorifice;
const vsPos = (t: number) => (t <= VS.rampEnd ? t / VS.rampEnd : 1.0);

/** Series valve+orifice quasi-steady flow at tank state (P, T) and valve
 *  position pos — bisection on the intermediate pressure (mirrors B6). */
function vsMdotFromPT(P_tank: number, T_tank: number, pos: number): number {
  if (P_tank <= VS.Pamb) return 0;
  const rhoTank = P_tank / (R_AIR * T_tank);
  const effCdAv = Math.max(VS_CdAv * pos, 1e-9);
  const residual = (m: number) => {
    const disc =
      VS.Pamb * VS.Pamb + (2 * m * m * R_AIR * T_tank) / (VS_CdAo * VS_CdAo);
    const P_mid = (VS.Pamb + Math.sqrt(disc)) / 2;
    const dpValve = (m * m) / (2 * rhoTank * effCdAv * effCdAv);
    return P_tank - P_mid - dpValve;
  };
  let hi = effCdAv * Math.sqrt(2 * rhoTank * (P_tank - VS.Pamb));
  for (let e = 0; e < 60; e++) {
    if (residual(hi) <= 0) break;
    hi *= 2;
  }
  return bisection(residual, 0, hi, 1e-12);
}

const vsM0 = (VS.P0 * VS.V) / (R_AIR * VS.T0);
const vsOde = (t: number, y: number[]): number[] => {
  const [m, U] = y;
  const T = U / (m * CV);
  const P = (m * R_AIR * T) / VS.V;
  const md = vsMdotFromPT(P, T, vsPos(t));
  return [-md, -md * CP * T];
};
const VS_HREF = VS.dt / 20; // 0.0025 s
const vsRef = rk4Trace(vsOde, [vsM0, vsM0 * CV * VS.T0], VS.endTime, VS_HREF);
const vsRefP: number[] = [];
const vsRefT: number[] = [];
const vsRefMdot: number[] = [];
for (let i = 0; i < vsRef.states.length; i++) {
  const [m, U] = vsRef.states[i];
  const T = U / (m * CV);
  const P = (m * R_AIR * T) / VS.V;
  vsRefP.push(P);
  vsRefT.push(T);
  vsRefMdot.push(vsMdotFromPT(P, T, vsPos(vsRef.times[i])));
}
const vsPeakMdot = Math.max(...vsRefMdot);

const vsConfig: NetworkConfig = {
  meta: { name: "scheduled-valve blowdown validation", version: 2 },
  settings: {
    mode: "transient",
    dt: VS.dt,
    endTime: VS.endTime,
    tolerance: 1e-9,
    maxIterations: 500,
    relaxation: 0.9,
  },
  fluid: FLUID,
  nodes: [
    {
      id: "tank",
      type: "internal",
      x: 0,
      y: 0,
      pressure: VS.P0,
      temperature: VS.T0,
      volume: VS.V,
    },
    {
      id: "mid",
      type: "internal",
      x: 1,
      y: 0,
      pressure: VS.P0,
      temperature: VS.T0,
      volume: 1e-6,
    },
    {
      id: "amb",
      type: "boundary",
      x: 2,
      y: 0,
      pressure: VS.Pamb,
      temperature: VS.T0,
    },
  ],
  branches: [
    {
      id: "v1",
      from: "tank",
      to: "mid",
      component: {
        type: "valve",
        area: VS.Avalve,
        cd: VS.Cd,
        position: 0,
        positionSchedule: [
          [0, 0],
          [VS.rampEnd, 1],
          [VS.endTime, 1],
        ],
      },
    },
    {
      id: "o1",
      from: "mid",
      to: "amb",
      component: { type: "orifice", area: VS.Aorifice, cd: VS.Cd },
    },
  ],
};

const vsRes = solveValidated(vsConfig);
const vsE = tankTraceErrors(
  vsRes,
  "tank",
  { h: VS_HREF, P: vsRefP, T: vsRefT },
  VS.P0,
  VS.T0,
);
const vsCons = massConservationErr(
  vsRes,
  "tank",
  "o1",
  VS.V,
  VS.P0 / (R_AIR * VS.T0),
);

/* Vent mass-flow trace error, normalized by the peak reference flow (the
 * flow starts from zero, so a local relative norm is singular at t = 0). */
let vsMaxMdot = 0;
for (let i = 1; i < vsRes.times.length; i++) {
  const k = refIdx(vsRes.times[i], VS_HREF, vsRefMdot.length);
  vsMaxMdot = Math.max(
    vsMaxMdot,
    Math.abs(vsRes.branches.o1.mdot[i] - vsRefMdot[k]) / vsPeakMdot,
  );
}

const vsStats: CaseStats = {
  ...vsE,
  cons: vsCons,
  steps: vsRes.times.length - 1,
  converged: vsRes.converged,
};
const vsLast = vsRes.times.length - 1;
const vsFinalP = vsRes.nodes.tank.pressure[vsLast];
const vsFinalT = vsRes.nodes.tank.temperature[vsLast];

console.log(
  `  converged=${vsStats.converged} maxP=${pct(vsStats.maxP)} maxT=${pct(vsStats.maxT)} finalP=${pct(vsStats.finalP)} mdot=${pct(vsMaxMdot)} cons=${pct(vsCons, 3)}`,
);

writeFig(
  12,
  "valve-pressure",
  lineChart({
    title: "Scheduled-valve blowdown: tank pressure",
    xLabel: "Time t [s]",
    yLabel: "Tank pressure [bar]",
    series: [
      {
        label: "Analytical (RK4, scheduled area)",
        pts: linePts(vsRef.times, vsRefP.map(toBar)),
        color: C.analytic,
        mode: "line",
      },
      {
        label: "Numerical, dt = 0.05 s",
        pts: markerPts(vsRes.times, vsRes.nodes.tank.pressure.map(toBar), 4),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
    ],
  }),
);

writeFig(
  13,
  "valve-mdot",
  lineChart({
    title: "Scheduled-valve blowdown: vent mass flow rate",
    xLabel: "Time t [s]",
    yLabel: "Mass flow rate [kg/s]",
    series: [
      {
        label: "Analytical (RK4, scheduled area)",
        pts: linePts(vsRef.times, vsRefMdot),
        color: C.analytic,
        mode: "line",
      },
      {
        label: "Numerical, dt = 0.05 s",
        pts: markerPts(vsRes.times, vsRes.branches.o1.mdot, 4, true),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
    ],
  }),
);

/* ==========================================================================
 * Report markdown
 * ========================================================================== */

const fig = (n: number, caption: string) =>
  `![Figure ${n}](figures/tank/${figures[n]})\n\n*Figure ${n}. ${caption}*`;

const statsRow = (name: string, s: CaseStats, extra = "") =>
  `| ${name} | ${pct(s.maxP)} | ${pct(s.maxT)} | ${pct(s.finalP, 3)} | ${pct(s.finalT, 3)} | ${pct(s.cons, 3)} | ${s.steps}${extra} |`;

const report = `# Transient Tank Pressurization and Blowdown Validation of OpenFLUME

**A validation study of transient tank gas dynamics — adiabatic blowdown through a choked orifice, time-step convergence, two-tank pressure equalization, adiabatic charge (fill) heating, and blowdown through a scheduled valve**

Generated by \`scripts/tank-transient-validation-report.ts\` — all numbers and
figures come from live solves of the current solver. The corresponding CI
gates are \`src/core/__tests__/transient.test.ts\` and
\`src/core/__tests__/benchmarks.test.ts\`.

## Abstract

This report verifies and validates the transient (time-marching) capability of
the OpenFLUME solver — a pressure-based node-and-branch network code in
the same family as NASA's GFSSP — for lumped tank gas dynamics. A tank is an
internal node with a finite volume whose stored mass and internal energy are
integrated in time; the solver's backward-Euler / coupled-Newton predictions
are compared against fourth-order Runge-Kutta integrations of the exact
lumped-parameter ODEs and against classical closed-form results: the choked
adiabatic blowdown solution and its cooling law T/T₀ = (m/m₀)^(γ−1), the
two-tank equalization equilibrium pressure from energy conservation, and the
adiabatic fill-heating limit T → γT_supply. Five cases are run: choked
blowdown through a compressible orifice, a four-level time-step convergence
study of that blowdown, equalization of two unequal tanks through an orifice,
charging of a tank from a constant-pressure supply, and blowdown through a
valve whose area follows a prescribed opening schedule. At the working time
step (dt = 0.05 s) every trace agrees with its analytical reference to within
${pct(Math.max(bdFine.stats.maxP, bdFine.stats.maxT, ttStats.maxP, ttStats.maxT, flStats.maxP, flStats.maxT, vsStats.maxP, vsStats.maxT), 1)},
the time-step study confirms the expected first-order convergence of the
backward-Euler integrator, and global mass conservation holds to
${pct(Math.max(bdFine.stats.cons, flStats.cons, vsStats.cons, ttStats.cons), 3)} or better in every case.

## Introduction

Steady network solvers answer "what flow does this system carry"; transient
solvers answer "how does it get there and how fast". For pressurized-gas
systems the canonical transient problems are the blowdown of a tank through an
orifice, the charging of a tank from a supply line, and the equalization of
two tanks — problems with exact lumped-parameter solutions that exercise
precisely the terms a network code must get right: the nodal mass-storage term
ρV, the internal-energy storage term m·c_v·T, and the enthalpy ṁ·c_p·T carried
by every branch. They are also unforgiving of energy-equation mistakes: an
adiabatic blowdown must cool following T/T₀ = (m/m₀)^(γ−1), and an adiabatic
fill must heat above the supply temperature — a tank filled from an evacuated
state approaches γT_supply, a classical result of open-system thermodynamics
(Moran & Shapiro). The purpose of this report is to verify the OpenFLUME
transient integrator against these benchmarks with the same live-solve,
figure-for-figure reporting format as the companion GFSSP compressible-flow
report (\`docs/validation/compressible-report.md\`).

## Problem Description

The working fluid is air, treated as an ideal gas with γ = ${GAMMA}, R =
${R_AIR} J/kg·K, and c_p = γR/(γ−1) = ${CP.toFixed(1)} J/kg·K (so that c_p,
c_v = ${CV.toFixed(1)} J/kg·K, and γ are mutually consistent and the analytic
closed forms hold exactly). Five cases are studied:

| Case | Description |
| ---- | ----------- |
| 1 | Adiabatic blowdown of a ${BD.V} m³ tank from ${toBar(BD.P0).toFixed(0)} bar through a choked compressible orifice |
| 2 | Time-step convergence study of case 1 at dt = ${BD_DTS.join(" / ")} s |
| 3 | Pressure equalization of two tanks (${TT.V1} m³ at ${toBar(TT.P1_0).toFixed(0)} bar, ${TT.V2} m³ at ${toBar(TT.P2_0).toFixed(0)} bar) through an orifice |
| 4 | Adiabatic charging of a ${FL.V} m³ tank at ${toBar(FL.P0).toFixed(0)} bar from a ${toBar(FL.Psup).toFixed(0)} bar constant-pressure supply (fill heating) |
| 5 | Blowdown of a ${VS.V} m³ tank at ${toBar(VS.P0).toFixed(0)} bar through a valve whose position ramps 0 → 1 over ${VS.rampEnd} s in series with a fixed orifice |

### Single-Tank Layouts

Cases 1, 2, 4, and 5 use one tank — an internal node with volume — connected
to a pressure boundary through a flow component (Figure 1). Case 1 vents
through an \`orificeCompressible\` (isentropic mass flux with choking, C_d =
${BD.Cd}, A = 10⁻⁴ m²) to a ${toBar(BD.Pout).toFixed(0)} bar boundary; the
pressure ratio stays below the critical value ${CRIT_PR.toFixed(4)} for the
whole ${BD.endTime} s transient (the final tank pressure is
${toBar(bdRefP[bdRefP.length - 1]).toFixed(2)} bar, still above the unchoking
pressure of ${toBar(bdUnchokeP).toFixed(2)} bar; final ratio P_b/P =
${bdFinalPR.toFixed(3)} < ${CRIT_PR.toFixed(3)}), so the orifice is choked
throughout. Case 4 reverses the flow: a ${toBar(FL.Psup).toFixed(0)} bar,
${FL.Tsup} K supply charges the tank through a square-law resistance (K =
${FL.K}, A = ${FL.A} m²). Case 5 vents through a scheduled valve in series
with a fixed orifice, joined by a small plenum node (volume 10⁻⁶ m³).

${fig(1, "Lumped tank connected to a pressure boundary through a flow component (cases 1, 2, 4, 5).")}

### Two-Tank Layout

Case 3 joins two rigid tanks of different volumes and pressures with an
orifice (C_dA = ${(TT.Cd * TT.A).toExponential(1)} m²). Both start at
${TT.T0} K. A closed valve (position 0) connects tank 1 to a boundary node
because the transient system requires at least one boundary; its measured
leakage flow is ${ttLeakRatio.toExponential(1)} of the peak orifice flow —
negligible (Figure 2).

${fig(2, "Two-tank equalization layout (case 3).")}

## Benchmark Solutions

### Tank ODEs

A rigid adiabatic tank of volume V exchanging mass through quasi-steady
branches obeys the lumped mass and energy balances

$$\\frac{dm}{dt} = \\sum \\dot m_{in} - \\sum \\dot m_{out}, \\qquad \\frac{dU}{dt} = \\sum \\dot m_{in}\\, c_p T_{up} - \\sum \\dot m_{out}\\, c_p T, \\qquad U = m\\, c_v T, \\quad P = \\frac{m R T}{V},$$

where each stream carries the enthalpy of its upstream state. These ODEs are
integrated with classical fourth-order Runge-Kutta at a reference step of
${(BD_HREF * 1000).toFixed(0)} ms (${(TT_HREF * 1000).toFixed(1)} ms for the
coupled two-tank system, ${(VS_HREF * 1000).toFixed(1)} ms for the scheduled
valve) — 50–100× finer than the solver's step, so the reference truncation
error is negligible against the deviations being measured.

### Choked Orifice Mass Flux

The compressible orifice passes the isentropic mass flux

$$\\dot m = C_d A\\, P_u \\sqrt{\\tfrac{\\gamma}{R T_u}} \\left(\\tfrac{2}{\\gamma+1}\\right)^{\\frac{\\gamma+1}{2(\\gamma-1)}} \\quad \\text{for } P_d/P_u \\le \\left(\\tfrac{2}{\\gamma+1}\\right)^{\\frac{\\gamma}{\\gamma-1}} = ${CRIT_PR.toFixed(4)},$$

$$\\dot m = C_d A\\, P_u \\sqrt{\\tfrac{2\\gamma}{(\\gamma-1) R T_u}\\left[\\left(\\tfrac{P_d}{P_u}\\right)^{2/\\gamma} - \\left(\\tfrac{P_d}{P_u}\\right)^{(\\gamma+1)/\\gamma}\\right]} \\quad \\text{otherwise},$$

the standard result for isentropic flow through a converging passage (Saad;
Anderson).

### Adiabatic Blowdown: Cooling Law and Closed Form

For an adiabatic tank discharging through any orifice, eliminating time from
the mass and energy balances gives the polytropic cooling law

$$\\frac{T}{T_0} = \\left(\\frac{m}{m_0}\\right)^{\\gamma-1}, \\qquad \\frac{P}{P_0} = \\left(\\frac{m}{m_0}\\right)^{\\gamma}.$$

While the orifice is choked the mass balance closes in closed form:

$$\\frac{m}{m_0} = \\left[1 + \\frac{\\gamma-1}{2}\\,\\frac{t}{\\tau}\\right]^{-\\frac{2}{\\gamma-1}}, \\qquad \\tau = \\frac{V}{C_d A\\, \\sqrt{\\gamma R T_0}\\,\\left(\\frac{2}{\\gamma+1}\\right)^{\\frac{\\gamma+1}{2(\\gamma-1)}}} = ${bdTau.toFixed(3)}\\ \\text{s}.$$

The RK4 reference and this closed form agree to within
${pctSmart(bdClosedFormDev)} of P₀ over the whole transient — machine-level
agreement that cross-checks both derivations, exactly as the Fanno/Rayleigh
closed forms cross-check the RK4 duct integration in the companion report.

### Two-Tank Equalization Equilibrium

Two rigid adiabatic tanks exchanging mass conserve total internal energy, and
since U = PV/(γ−1) for an ideal gas, the common final pressure is

$$P_{eq} = \\frac{P_{1,0} V_1 + P_{2,0} V_2}{V_1 + V_2} = ${toBar(ttPeq).toFixed(2)}\\ \\text{bar},$$

independent of the flow path. The individual final temperatures are
path-dependent (the discharging tank cools, the receiving tank heats) and are
taken from the RK4 integration of the coupled four-equation system.

### Adiabatic Fill Heating

Charging a rigid adiabatic tank from a constant supply at T_s converts flow
work into internal energy: the energy balance U_f − U_0 = Δm·c_p·T_s gives,
for T_s = T₀,

$$T_f = \\frac{\\gamma\\, T_0\\, P_f}{P_f + (\\gamma-1) P_0} = ${flTfClosed.toFixed(1)}\\ \\text{K at } P_f = ${toBar(FL.Psup).toFixed(0)}\\ \\text{bar},$$

which reduces to the classical evacuated-tank limit T_f → γT_s =
${(GAMMA * FL.Tsup).toFixed(0)} K as P₀ → 0 (Moran & Shapiro). The fill in
case 4 completes well within the ${FL.endTime} s window, so the solver's final
temperature can be compared directly against this closed form as well as
against the RK4 trace.

## Numerical Modeling

OpenFLUME integrates the transient network with backward (implicit)
Euler: at every time step the full set of nodal mass and energy balances —
including the storage terms (ρV)ⁿ⁺¹ − (ρV)ⁿ and (m c_v T)ⁿ⁺¹ − (m c_v T)ⁿ for
every internal node with volume — is solved simultaneously with the branch
momentum relations by a coupled Newton-Raphson iteration on the
end-of-step state. A tank is therefore nothing special: it is an internal
node whose \`volume\` field activates the storage terms. Branch closures are
quasi-steady and evaluated at end-of-step conditions: the compressible
orifice imposes ṁ = ṁ_isentropic(P_u, P_d, T_u), the incompressible orifice
and resistance impose ΔP = K ṁ²/(2ρ_up C_dA²)-type square laws with upstream
density, and scheduled valves interpolate their position at the end-of-step
time. Backward Euler is unconditionally stable and first-order accurate: its
truncation error is O(dt), so halving the time step should halve the
deviation from the exact solution — the hypothesis tested in the time-step
study below. All solves here use fixed stepping, a Newton tolerance of 10⁻⁹,
and the same networks as the CI gates.

## Time-Step Selection

Case 1 is run at four time steps, dt = ${BD_DTS.join(", ")} s
(${bdRuns.map((r) => r.stats.steps).join(" / ")} steps over the ${BD.endTime} s
transient). Figure 6 overlays the pressure traces on the RK4 reference;
Figure 7 plots the deviations against dt. The trace deviation is dominated by
the first-order local truncation error of backward Euler and shrinks almost
exactly linearly with dt: the final-pressure deviation falls from
${pct(bdRuns[0].stats.finalP)} of P₀ at dt = ${BD_DTS[0]} s to
${pct(bdFine.stats.finalP)} at dt = ${BD_DTS[3]} s, an observed convergence
order of ${bdOrders.map((o) => o.toFixed(2)).join(", ")} between successive
halvings (1.00 is ideal first order). The CI gate asserts the same behavior
(error ratio between 1.5 and 3.0 for a dt halving). On this basis dt = 0.05 s
— roughly τ/166 — is used as the working step for every case in this report;
even the coarsest step, dt = 0.4 s ≈ τ/21, stays within
${pct(bdRuns[0].stats.maxP, 1)} of the reference everywhere, a useful property
for design-loop screening runs.

| dt [s] | steps | max ΔP trace | max ΔT trace | final ΔP | final Δṁ (max, /ṁ₀) |
| ------ | ----- | ------------ | ------------ | -------- | -------------------- |
${bdRuns
  .map(
    (r) =>
      `| ${r.dt} | ${r.stats.steps} | ${pct(r.stats.maxP)} | ${pct(r.stats.maxT)} | ${pct(r.stats.finalP)} | ${pct(r.maxMdot)} |`,
  )
  .join("\n")}

${fig(6, "Time-step study: blowdown pressure traces at dt = 0.4, 0.2, and 0.1 s against the RK4 reference.")}

${fig(7, "Deviation from the RK4 reference versus time step: near-linear decay confirms first-order backward-Euler convergence.")}

## Results and Discussion

The table below summarizes the agreement between the solver and the analytic
references at the working step dt = 0.05 s. Trace deviations are maxima over
all solved time points, normalized by the initial tank pressure P₀ and
temperature T₀ (the convention of the CI gates); final-state deviations are
taken at t = endTime; the conservation column is the global mass balance —
the integrated branch flow ∫|ṁ| dt versus the tank mass change V·Δρ (cases 1,
4, 5), or the maximum total-mass drift (case 3).

| Case | max ΔP trace | max ΔT trace | final ΔP | final ΔT | mass conservation | steps |
| ---- | ------------ | ------------ | -------- | -------- | ----------------- | ----- |
${statsRow("1 — Choked blowdown (dt = 0.05 s)", bdFine.stats)}
${statsRow(`3 — Two-tank equalization (vs P_eq${ttStats.converged ? "" : ", not converged"})`, ttStats)}
${statsRow("4 — Adiabatic fill", flStats)}
${statsRow("5 — Scheduled valve", vsStats)}

(Case 2 is the dt sweep tabulated in the previous section. Case 3's final-ΔP
column compares against the closed-form equilibrium pressure; its final-ΔT
column and all trace columns compare against the coupled RK4 reference, and
its conservation column is the peak total-mass drift.)

### Case 1: Adiabatic Blowdown Through a Choked Orifice

The tank starts at ${toBar(BD.P0).toFixed(0)} bar and ${BD.T0} K and vents to
a ${toBar(BD.Pout).toFixed(0)} bar boundary. Over ${BD.endTime} s it loses
${pct(1 - bdRef.states[bdRef.states.length - 1][0] / bdM0, 1)} of its initial
${bdM0.toFixed(3)} kg charge; the pressure falls to
${toBar(bdRefP[bdRefP.length - 1]).toFixed(2)} bar and the gas cools by
adiabatic expansion to ${bdRefT[bdRefT.length - 1].toFixed(1)} K. Figures 3
and 4 compare the solver's pressure and temperature traces with the RK4
reference and the choked closed form (the two analytic curves are
indistinguishable at plot scale, deviating by at most
${pctSmart(bdClosedFormDev)}); Figure 5 compares the vent mass flow rate. The
solver tracks the pressure trace within ${pct(bdFine.stats.maxP)} of P₀, the
temperature within ${pct(bdFine.stats.maxT)} of T₀ — confirming the
T/T₀ = (m/m₀)^(γ−1) cooling law that the CI gate asserts to 1 % — and the
mass flow within ${pct(bdFine.maxMdot)} of the initial flow. The deviations
are one-sided — the implicit step evaluates the vent flow at the end-of-step
(lower-pressure) state, so each step discharges slightly less mass than the
true average and the discrete trace lags the exact decay — and they shrink
linearly with dt, as the time-step study shows. Global mass conservation —
discharged mass versus tank inventory change — closes to
${pctSmart(bdFine.stats.cons)}.

${fig(3, "Tank pressure during choked adiabatic blowdown: RK4 reference, choked closed form, and solver.")}

${fig(4, "Tank temperature during choked adiabatic blowdown: the gas cools following T/T₀ = (m/m₀)^(γ−1).")}

${fig(5, "Vent mass flow rate during choked blowdown.")}

### Case 3: Two-Tank Pressure Equalization

Tank 1 (${TT.V1} m³ at ${toBar(TT.P1_0).toFixed(0)} bar) discharges into tank
2 (${TT.V2} m³ at ${toBar(TT.P2_0).toFixed(0)} bar) through an orifice until
the pressures meet at the energy-conservation equilibrium
${toBar(ttPeq).toFixed(2)} bar. Figure 8 shows both pressure traces against
the coupled RK4 reference with the closed-form equilibrium marked; the solver
reaches final pressures of ${toBar(ttFinalP1).toFixed(3)} and
${toBar(ttFinalP2).toFixed(3)} bar — within ${pctSmart(Math.max(ttPeqErr1, ttPeqErr2))}
of the exact value — and tracks the transient within ${pct(ttStats.maxP)} of
P₁,₀. Figure 9 shows the thermal signature of the exchange: the expanding
tank cools to ${ttFinalT1.toFixed(1)} K while the receiving tank, compressed
and fed with warm enthalpy, heats to ${ttFinalT2.toFixed(1)} K (RK4:
${ttRefT1[ttRefT1.length - 1].toFixed(1)} / ${ttRefT2[ttRefT2.length - 1].toFixed(1)} K).
Total mass drifts by at most ${pctSmart(ttMassDrift)} over the transient, and
the closed boundary valve leaks only ${ttLeakRatio.toExponential(1)} of the
peak orifice flow.

${fig(8, "Two-tank equalization: both tank pressures converge to the closed-form equilibrium (P₁V₁+P₂V₂)/(V₁+V₂).")}

${fig(9, "Two-tank equalization: the discharging tank cools, the receiving tank heats.")}

### Case 4: Adiabatic Charging (Fill Heating)

The tank starts at ${toBar(FL.P0).toFixed(0)} bar, ${FL.Tsup} K and is charged
from a ${toBar(FL.Psup).toFixed(0)} bar supply at the same temperature.
Because the entering stream carries enthalpy c_pT_s but the tank stores only
internal energy c_vT, the contents heat above the supply temperature —
the classical fill-heating effect. The solver's final temperature is
${flFinalT.toFixed(1)} K against the closed-form ${flTfClosed.toFixed(1)} K
(deviation ${pctSmart(flTfClosedErr)}), squarely between the supply temperature
and the evacuated-tank limit γT_s = ${(GAMMA * FL.Tsup).toFixed(0)} K, and the
final pressure equalizes to ${toBar(flFinalP).toFixed(3)} bar. Figures 10 and
11 show the pressure and temperature traces: the fill completes in roughly
1 s (the square-root pressure-deficit law closes in finite time), after which
both curves sit on their equilibrium values. Trace agreement is within
${pct(flStats.maxP)} of P_s on pressure and ${pct(flStats.maxT)} of T_s on
temperature; mass conservation closes to ${pctSmart(flStats.cons)}.

${fig(10, "Tank pressure during adiabatic charging from a constant-pressure supply.")}

${fig(11, "Tank temperature during adiabatic charging: fill heating carries the contents above the supply temperature toward the γT_s limit.")}

### Case 5: Blowdown Through a Scheduled Valve

The tank vents through a valve whose position ramps linearly from 0 to 1 over
${VS.rampEnd} s and then holds, in series with a fixed orifice — the analytic
reference integrates the same series network with the time-varying effective
area by RK4 with an inner bisection for the intermediate pressure. This case
exercises time-varying component handling: the solver interpolates the valve
schedule at each end-of-step time inside the coupled Newton solve. Figure 12
shows the tank pressure: nearly flat while the valve is barely open, then a
fast blowdown as the effective area grows, approaching the
${toBar(VS.Pamb).toFixed(0)} bar ambient (final pressure
${toBar(vsFinalP).toFixed(3)} bar vs ${toBar(vsRefP[vsRefP.length - 1]).toFixed(3)} bar
reference; final temperature ${vsFinalT.toFixed(1)} K vs
${vsRefT[vsRefT.length - 1].toFixed(1)} K). Figure 13 shows the vent flow
rising with the schedule to a peak of ${vsPeakMdot.toFixed(3)} kg/s and
collapsing as the tank empties. The solver tracks the pressure within
${pct(vsStats.maxP)} of P₀ and the flow within ${pct(vsMaxMdot)} of the peak;
the largest flow deviation sits at the emptying knee near t ≈ 2.2 s, where
the flow collapses fastest and the first-order backward-Euler step lags the
steep decay — a truncation effect that shrinks with dt like every other
deviation in this report. Discharged
mass matches the tank inventory change to ${pctSmart(vsStats.cons)}.

${fig(12, "Tank pressure during blowdown through a valve following a linear opening schedule.")}

${fig(13, "Vent mass flow during the scheduled-valve blowdown: the flow follows the valve ramp, peaks, and collapses as the tank empties.")}

## Conclusions

The transient integrator of OpenFLUME — backward Euler with a fully
coupled Newton solve of the nodal mass/energy storage and branch momentum
equations — reproduces the classical lumped-parameter gas dynamics of tank
systems. Choked adiabatic blowdown follows the closed-form solution and its
T/T₀ = (m/m₀)^(γ−1) cooling law; two-tank equalization lands on the exact
energy-conservation equilibrium pressure to ${pctSmart(ttStats.finalP)}; adiabatic
charging reproduces the fill-heating closed form to ${pctSmart(flTfClosedErr)};
and a scheduled valve demonstrates time-varying component handling against an
RK4 reference with time-varying area. All traces agree with their references
to within ${pct(Math.max(bdFine.stats.maxP, bdFine.stats.maxT, ttStats.maxP, ttStats.maxT, flStats.maxP, flStats.maxT, vsStats.maxP, vsStats.maxT), 1)}
at dt = 0.05 s, deviations decay at the expected first order in dt
(observed orders ${bdOrders.map((o) => o.toFixed(2)).join(", ")}), and global
mass conservation closes to ${pct(Math.max(bdFine.stats.cons, flStats.cons, vsStats.cons, ttStats.cons), 3)}
or better. The dominant error is the first-order temporal truncation of
backward Euler — visible as a one-sided lag at coarse dt — not any defect in
the storage or transport terms. Heat transfer to tank walls and real-fluid
tank thermodynamics are exercised by other parts of the test suite and remain
out of scope here.

## References

1. Saad, M. A., *Compressible Fluid Flow*, 2nd ed., Prentice Hall, 1993
   (isentropic orifice flow, choking).
2. Anderson, J. D., *Modern Compressible Flow: With Historical Perspective*,
   3rd ed., McGraw-Hill, 2003.
3. Moran, M. J., Shapiro, H. N., Boettner, D. D., and Bailey, M. B.,
   *Fundamentals of Engineering Thermodynamics*, 8th ed., Wiley, 2014
   (transient charging and discharging of rigid vessels; fill heating).
4. White, F. M., *Fluid Mechanics*, 7th ed., McGraw-Hill, 2011 (orifice
   discharge coefficients).
5. Press, W. H., et al., *Numerical Recipes*, 2nd ed., Cambridge University
   Press, 1992 (fourth-order Runge-Kutta method).
6. Majumdar, A. K., LeClair, A. C., Moore, R., and Schallhorn, P. A.,
   *Generalized Fluid System Simulation Program, Version 6.0*,
   NASA/TM-2013-217492, 2013 (network transient formulation).

## Nomenclature

| Symbol | Meaning |
| ------ | ------- |
| A | orifice / valve flow area |
| C_d | discharge coefficient |
| c_p, c_v | specific heats at constant pressure / volume |
| dt | solver time step |
| K | resistance loss coefficient |
| m | tank gas mass |
| ṁ | mass flow rate |
| P | tank pressure |
| P_b | boundary pressure |
| P_eq | equalization equilibrium pressure |
| R | gas constant |
| T | tank temperature |
| T_s | supply temperature |
| t | time |
| U | tank internal energy |
| V | tank volume |
| γ | specific heat ratio |
| ρ | density |
| τ | choked-blowdown time constant |
| 0 / f | initial / final state |
| u / d | upstream / downstream state |
`;

writeFileSync(join(outDir, "tank-transient-report.md"), report);
console.log(`\nwrote docs/validation/tank-transient-report.md`);
