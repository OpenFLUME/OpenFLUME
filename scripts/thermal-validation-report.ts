/**
 * thermal-validation-report.ts — generates the thermal-network and conjugate
 * heat-transfer validation report (docs/validation/thermal-network-report.md)
 * and its SVG figures (docs/validation/figures/thermal/), following the
 * structure of scripts/compressible-validation-report.ts.
 *
 * Five benchmark cases, each with a closed-form (or in-script root-solved /
 * marched) analytic reference:
 *
 *   1. Steady composite plane wall (convection–conduction–conduction–
 *      convection series resistance network).
 *   2. Radiation–convection equilibrium of a heated solid node (Newton
 *      root-solve of the nonlinear balance, swept over heat input).
 *   3. Lumped-capacitance transient cooldown, T(t) = T∞ + (T₀−T∞)e^(−t/τ),
 *      with a two-time-step convergence check (backward Euler, first order).
 *   4. Heated pipe with constant wall temperature: exponential axial approach
 *      T(x) = T_w − (T_w − T_in)·exp(−UA·x/(ṁ·cp·L)).
 *   5. Counterflow heat exchanger, two water streams wall-coupled through
 *      solid nodes and convection conductors, vs the ε–NTU closed form.
 *
 * All numbers and figures come from live solves — rerun after solver changes:
 *
 *   npx tsx scripts/thermal-validation-report.ts
 *
 * The physics/setup helpers mirror src/core/__tests__/thermal.test.ts and
 * src/core/__tests__/solidThermalTransient.test.ts (the CI gates; this script
 * is the human-readable artifact).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { solveSteady, solveTransient, validateNetwork } from "../src/core";
import type { NetworkConfig, SteadyResult, TransientResult } from "../src/core";

/* ==========================================================================
 * Constants (SI)
 * ========================================================================== */

const SIGMA = 5.670374419e-8; // Stefan–Boltzmann [W/m²K⁴]
const CP_WATER = 4182; // J/kg·K (incompressible water preset)

/* ==========================================================================
 * Config helpers (mirroring the CI test helpers)
 * ========================================================================== */

function steadySettings(): NetworkConfig["settings"] {
  return {
    mode: "steady",
    tolerance: 1e-9,
    maxIterations: 500,
    relaxation: 0.9,
  };
}

function makeConfig(
  name: string,
  parts: Pick<NetworkConfig, "nodes" | "branches"> &
    Partial<Pick<NetworkConfig, "solidNodes" | "conductors" | "settings">>,
): NetworkConfig {
  return {
    meta: { name, version: 2 },
    settings: parts.settings ?? steadySettings(),
    fluid: { model: "incompressible", preset: "water" },
    nodes: parts.nodes,
    branches: parts.branches,
    ...(parts.solidNodes ? { solidNodes: parts.solidNodes } : {}),
    ...(parts.conductors ? { conductors: parts.conductors } : {}),
  };
}

function solveChecked(config: NetworkConfig): SteadyResult {
  const errors = validateNetwork(config);
  if (errors.length) throw new Error(`invalid network: ${errors.join("; ")}`);
  const res = solveSteady(config);
  if (!res.converged) throw new Error(`${config.meta.name}: did not converge`);
  return res;
}

function solveTransientChecked(config: NetworkConfig): TransientResult {
  const errors = validateNetwork(config);
  if (errors.length) throw new Error(`invalid network: ${errors.join("; ")}`);
  const res = solveTransient(config);
  if (!res.converged) throw new Error(`${config.meta.name}: did not converge`);
  return res;
}

/* ==========================================================================
 * Formatting helpers
 * ========================================================================== */

const pct = (x: number, digits = 2): string =>
  Math.abs(x) < 1e-5
    ? `${(x * 100).toExponential(1)} %`
    : `${(x * 100).toFixed(digits)} %`;

const fmtK = (t: number, digits = 2) => t.toFixed(digits);

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

  // Legend (width measured on the label text with any tspan markup stripped)
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

/* ==========================================================================
 * Colors / marker assignments (copied palette)
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
const figDir = join(outDir, "figures", "thermal");
mkdirSync(figDir, { recursive: true });

const figures: string[] = [];
function writeFig(n: number, name: string, svg: string): string {
  const file = `fig${String(n).padStart(2, "0")}-${name}.svg`;
  writeFileSync(join(figDir, file), svg);
  figures[n] = file;
  console.log(`  wrote figures/thermal/${file}`);
  return file;
}

console.log("Generating thermal-network validation report…");

/* ==========================================================================
 * Case 1: Steady composite plane wall (series resistance network)
 * ==========================================================================
 * Hot fluid (500 K, h₁) | layer A (brick) | layer B (insulation) | cold fluid
 * (300 K, h₂).  Solid nodes at the two surfaces and the layer interface.
 * ========================================================================== */

console.log("Case 1 — composite plane wall");

const W1 = {
  Thot: 500,
  Tcold: 300,
  h1: 40, // hot-side film coefficient [W/m²K]
  h2: 10, // cold-side film coefficient [W/m²K]
  k1: 1.2, // layer A conductivity (fired brick) [W/mK]
  L1: 0.1, // layer A thickness [m]
  k2: 0.05, // layer B conductivity (mineral-wool insulation) [W/mK]
  L2: 0.05, // layer B thickness [m]
  A: 1.0, // wall area [m²]
};

const wallR = {
  conv1: 1 / (W1.h1 * W1.A),
  condA: W1.L1 / (W1.k1 * W1.A),
  condB: W1.L2 / (W1.k2 * W1.A),
  conv2: 1 / (W1.h2 * W1.A),
};
const wallRtot = wallR.conv1 + wallR.condA + wallR.condB + wallR.conv2;
const wallQan = (W1.Thot - W1.Tcold) / wallRtot;
const wallTan = {
  s1: W1.Thot - wallQan * wallR.conv1, // hot surface
  s2: W1.Thot - wallQan * (wallR.conv1 + wallR.condA), // interface
  s3: W1.Tcold + wallQan * wallR.conv2, // cold surface
};

const wallConfig = makeConfig("composite wall", {
  nodes: [
    {
      id: "fHot",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: 1e5,
      temperature: W1.Thot,
    },
    {
      id: "fCold",
      type: "boundary",
      x: 5,
      y: 0,
      pressure: 1e5,
      temperature: W1.Tcold,
    },
  ],
  solidNodes: [
    { id: "s1", type: "solid", x: 1, y: 0, temperature: 450 },
    { id: "s2", type: "solid", x: 2, y: 0, temperature: 400 },
    { id: "s3", type: "solid", x: 3, y: 0, temperature: 320 },
  ],
  conductors: [
    {
      id: "conv1",
      from: "fHot",
      to: "s1",
      type: { kind: "convection", h: W1.h1, area: W1.A },
    },
    {
      id: "condA",
      from: "s1",
      to: "s2",
      type: { kind: "conduction", k: W1.k1, area: W1.A, length: W1.L1 },
    },
    {
      id: "condB",
      from: "s2",
      to: "s3",
      type: { kind: "conduction", k: W1.k2, area: W1.A, length: W1.L2 },
    },
    {
      id: "conv2",
      from: "s3",
      to: "fCold",
      type: { kind: "convection", h: W1.h2, area: W1.A },
    },
  ],
  branches: [
    {
      id: "dummy",
      from: "fHot",
      to: "fCold",
      component: { type: "flowSource", massFlow: 0 },
    },
  ],
});

const wallRes = solveChecked(wallConfig);
const wallQnum = wallRes.conductors!.condA.heatRate;
const wallTnum = {
  s1: wallRes.solidNodes!.s1.temperature,
  s2: wallRes.solidNodes!.s2.temperature,
  s3: wallRes.solidNodes!.s3.temperature,
};
const wallQerr = Math.abs(wallQnum - wallQan) / wallQan;
const wallTerrs = (["s1", "s2", "s3"] as const).map((id) =>
  Math.abs(wallTnum[id] - wallTan[id]),
);
const wallTerrMaxK = Math.max(...wallTerrs);
const wallTerrMaxRel = Math.max(
  ...(["s1", "s2", "s3"] as const).map(
    (id) => Math.abs(wallTnum[id] - wallTan[id]) / wallTan[id],
  ),
);
// Heat flow through every element of the chain (series consistency)
const wallQspread = Math.max(
  ...(["conv1", "condA", "condB", "conv2"] as const).map(
    (id) => Math.abs(wallRes.conductors![id].heatRate - wallQan) / wallQan,
  ),
);
console.log(
  `  Q analytic=${wallQan.toFixed(4)} W  solver=${wallQnum.toFixed(4)} W  err=${pct(wallQerr)}  maxΔT=${wallTerrMaxK.toExponential(2)} K  chain spread=${pct(wallQspread)}`,
);

/* ==========================================================================
 * Case 2: Radiation–convection equilibrium (heat-input sweep)
 * ========================================================================== */

console.log("Case 2 — radiation–convection equilibrium");

const R2 = {
  Tinf: 300,
  h: 15,
  Aconv: 0.05,
  eps: 0.8,
  Arad: 0.05,
  F: 1.0,
};

/** Newton root-solve of q = hA(T−T∞) + σεAF(T⁴−T∞⁴). */
function radConvEquilibrium(q: number): number {
  const hA = R2.h * R2.Aconv;
  const sEAF = SIGMA * R2.eps * R2.Arad * R2.F;
  let T = R2.Tinf + q / hA; // convection-only start, always above the root
  for (let i = 0; i < 100; i++) {
    const f = hA * (T - R2.Tinf) + sEAF * (T ** 4 - R2.Tinf ** 4) - q;
    const df = hA + 4 * sEAF * T ** 3;
    const step = f / df;
    T -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  return T;
}

function radConvConfig(q: number): NetworkConfig {
  return makeConfig(`rad-conv q=${q}`, {
    nodes: [
      {
        id: "f1",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 1e5,
        temperature: R2.Tinf,
      },
      {
        id: "f2",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: 1e5,
        temperature: R2.Tinf,
      },
    ],
    solidNodes: [
      { id: "s1", type: "solid", x: 0, y: 1, temperature: 500, heatInput: q },
      { id: "a1", type: "ambient", x: 1, y: 1, temperature: R2.Tinf },
    ],
    conductors: [
      {
        id: "cv",
        from: "s1",
        to: "f1",
        type: { kind: "convection", h: R2.h, area: R2.Aconv },
      },
      {
        id: "rd",
        from: "s1",
        to: "a1",
        type: {
          kind: "radiation",
          emissivity: R2.eps,
          area: R2.Arad,
          viewFactor: R2.F,
        },
      },
    ],
    branches: [
      {
        id: "dummy",
        from: "f1",
        to: "f2",
        component: { type: "flowSource", massFlow: 0 },
      },
    ],
  });
}

const radQs = [100, 250, 500, 1000, 2000, 4000];
interface RadPoint {
  q: number;
  Tan: number;
  Tnum: number;
  err: number;
  balanceErr: number;
}
const radPoints: RadPoint[] = radQs.map((q) => {
  const res = solveChecked(radConvConfig(q));
  const Tnum = res.solidNodes!.s1.temperature;
  const Tan = radConvEquilibrium(q);
  // Residual of the analytic balance evaluated at the solver temperature
  const bal =
    R2.h * R2.Aconv * (Tnum - R2.Tinf) +
    SIGMA * R2.eps * R2.Arad * R2.F * (Tnum ** 4 - R2.Tinf ** 4) -
    q;
  return {
    q,
    Tan,
    Tnum,
    err: Math.abs(Tnum - Tan) / Tan,
    balanceErr: Math.abs(bal) / q,
  };
});
const radErrMax = Math.max(...radPoints.map((p) => p.err));
const radBalMax = Math.max(...radPoints.map((p) => p.balanceErr));
for (const p of radPoints) {
  console.log(
    `  q=${p.q} W  T_eq analytic=${p.Tan.toFixed(3)} K  solver=${p.Tnum.toFixed(3)} K  err=${pct(p.err)}`,
  );
}
console.log(
  `  max T_eq error=${pct(radErrMax)}  max balance residual=${pct(radBalMax)} of q`,
);

// Fraction of heat leaving by radiation at the largest q (for discussion)
const radTopPoint = radPoints[radPoints.length - 1];
const radFracTop =
  (SIGMA * R2.eps * R2.Arad * R2.F * (radTopPoint.Tnum ** 4 - R2.Tinf ** 4)) /
  radTopPoint.q;
const radBottomPoint = radPoints[0];
const radFracBottom =
  (SIGMA *
    R2.eps *
    R2.Arad *
    R2.F *
    (radBottomPoint.Tnum ** 4 - R2.Tinf ** 4)) /
  radBottomPoint.q;

/* ==========================================================================
 * Case 3: Lumped-capacitance transient cooldown
 * ========================================================================== */

console.log("Case 3 — lumped-capacitance transient");

const L3 = { m: 1, cp: 500, h: 10, A: 1.0, T0: 400, Tinf: 300 };
const tau = (L3.m * L3.cp) / (L3.h * L3.A); // 50 s
const lumpedEnd = 3 * tau;
const lumpedAnalytic = (t: number) =>
  L3.Tinf + (L3.T0 - L3.Tinf) * Math.exp(-t / tau);

function lumpedConfig(dt: number): NetworkConfig {
  return makeConfig(`lumped dt=${dt}`, {
    settings: {
      mode: "transient",
      dt,
      endTime: lumpedEnd,
      tolerance: 1e-9,
      maxIterations: 200,
      relaxation: 0.9,
    },
    nodes: [
      {
        id: "f1",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 1e5,
        temperature: L3.Tinf,
      },
      {
        id: "f2",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: 1e5,
        temperature: L3.Tinf,
      },
    ],
    solidNodes: [
      {
        id: "s1",
        type: "solid",
        x: 1,
        y: 1,
        temperature: L3.T0,
        mass: L3.m,
        cp: L3.cp,
      },
    ],
    conductors: [
      {
        id: "c1",
        from: "s1",
        to: "f1",
        type: { kind: "convection", h: L3.h, area: L3.A },
      },
    ],
    branches: [
      {
        id: "dummy",
        from: "f1",
        to: "f2",
        component: { type: "flowSource", massFlow: 0 },
      },
    ],
  });
}

const lumpedDt1 = tau / 25; // 2 s
const lumpedDt2 = tau / 100; // 0.5 s
const lumpedRes1 = solveTransientChecked(lumpedConfig(lumpedDt1));
const lumpedRes2 = solveTransientChecked(lumpedConfig(lumpedDt2));

function lumpedErrAt(res: TransientResult, dt: number, t: number): number {
  const idx = Math.round(t / dt);
  return Math.abs(res.solidNodes!.s1.temperature[idx] - lumpedAnalytic(t));
}
const lumpedStats = {
  errTau1: lumpedErrAt(lumpedRes1, lumpedDt1, tau),
  err3Tau1: lumpedErrAt(lumpedRes1, lumpedDt1, 3 * tau),
  errTau2: lumpedErrAt(lumpedRes2, lumpedDt2, tau),
  err3Tau2: lumpedErrAt(lumpedRes2, lumpedDt2, 3 * tau),
};
const lumpedRatio = lumpedStats.err3Tau1 / lumpedStats.err3Tau2;
const lumpedSpan = L3.T0 - L3.Tinf;
// Max deviation over the full trace, per dt, normalized by the span
function lumpedMaxErr(res: TransientResult, dt: number): number {
  const trace = res.solidNodes!.s1.temperature;
  let worst = 0;
  for (let i = 0; i < trace.length; i++) {
    worst = Math.max(
      worst,
      Math.abs(trace[i] - lumpedAnalytic(i * dt)) / lumpedSpan,
    );
  }
  return worst;
}
const lumpedMax1 = lumpedMaxErr(lumpedRes1, lumpedDt1);
const lumpedMax2 = lumpedMaxErr(lumpedRes2, lumpedDt2);
console.log(
  `  τ=${tau} s  dt=${lumpedDt1}s: |ΔT(τ)|=${lumpedStats.errTau1.toFixed(4)} K, |ΔT(3τ)|=${lumpedStats.err3Tau1.toFixed(4)} K, max=${pct(lumpedMax1)} of span`,
);
console.log(
  `  dt=${lumpedDt2}s: |ΔT(τ)|=${lumpedStats.errTau2.toFixed(4)} K, |ΔT(3τ)|=${lumpedStats.err3Tau2.toFixed(4)} K, max=${pct(lumpedMax2)} of span`,
);
console.log(
  `  error ratio at 3τ (dt ${lumpedDt1}/${lumpedDt2} = 4×): ${lumpedRatio.toFixed(2)} (first-order ⇒ ≈4)`,
);

/* ==========================================================================
 * Case 4: Heated pipe with constant wall temperature
 * ==========================================================================
 * Ten heatedPipe segments in series; ε–NTU per segment gives the exact
 * exponential approach at every node, so the reference is evaluated at the
 * SOLVED mass flow (pressure-driven, as in the CI test).
 * ========================================================================== */

console.log("Case 4 — heated pipe, constant wall temperature");

const HP = {
  n: 10,
  Lseg: 0.2, // m — total 2 m
  D: 0.02,
  roughness: 1e-5,
  Tin: 300,
  Twall: 350,
  uaSeg: 250, // W/K per segment
  Pin: 200000,
  Pout: 180000,
  orificeArea: 1e-4,
  orificeCd: 0.6,
};
const hpLtot = HP.n * HP.Lseg;
const hpUAtot = HP.n * HP.uaSeg;

function heatedPipeConfig(): NetworkConfig {
  const nodes: NetworkConfig["nodes"] = [
    {
      id: "n0",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: HP.Pin,
      temperature: HP.Tin,
    },
  ];
  const branches: NetworkConfig["branches"] = [];
  for (let i = 1; i <= HP.n; i++) {
    nodes.push({
      id: `n${i}`,
      type: "internal",
      x: i,
      y: 0,
      pressure: HP.Pin - ((HP.Pin - HP.Pout) * i) / (HP.n + 1),
      temperature: HP.Tin,
    });
    branches.push({
      id: `hp${i}`,
      from: `n${i - 1}`,
      to: `n${i}`,
      component: {
        type: "heatedPipe",
        length: HP.Lseg,
        diameter: HP.D,
        roughness: HP.roughness,
        ua: HP.uaSeg,
        wallTemperature: HP.Twall,
      },
    });
  }
  nodes.push({
    id: "amb",
    type: "boundary",
    x: HP.n + 1,
    y: 0,
    pressure: HP.Pout,
    temperature: HP.Tin,
  });
  branches.push({
    id: "orf",
    from: `n${HP.n}`,
    to: "amb",
    component: { type: "orifice", area: HP.orificeArea, cd: HP.orificeCd },
  });
  return makeConfig("heated pipe string", { nodes, branches });
}

const hpRes = solveChecked(heatedPipeConfig());
const hpMdot = hpRes.branches.hp1.mdot;
const hpNTUseg = HP.uaSeg / (hpMdot * CP_WATER);
const hpNTUtot = HP.n * hpNTUseg;
const hpAnalyticAt = (x: number) =>
  HP.Twall -
  (HP.Twall - HP.Tin) * Math.exp((-hpUAtot * x) / (hpMdot * CP_WATER * hpLtot));
interface HpStation {
  x: number;
  Tan: number;
  Tnum: number;
}
const hpStations: HpStation[] = [];
for (let i = 1; i <= HP.n; i++) {
  const x = i * HP.Lseg;
  hpStations.push({
    x,
    Tan: hpAnalyticAt(x),
    Tnum: hpRes.nodes[`n${i}`].temperature,
  });
}
const hpErrMaxRel = Math.max(
  ...hpStations.map((s) => Math.abs(s.Tnum - s.Tan) / s.Tan),
);
const hpOutlet = hpStations[hpStations.length - 1];
const hpOutletErrK = Math.abs(hpOutlet.Tnum - hpOutlet.Tan);
const hpEpsTot = 1 - Math.exp(-hpNTUtot);
console.log(
  `  mdot=${hpMdot.toFixed(5)} kg/s  NTU_total=${hpNTUtot.toFixed(3)}  T_out analytic=${hpOutlet.Tan.toFixed(4)} K  solver=${hpOutlet.Tnum.toFixed(4)} K  maxErr=${pct(hpErrMaxRel)}`,
);

/* ==========================================================================
 * Case 5: Counterflow heat exchanger vs ε–NTU (flagship)
 * ==========================================================================
 * Two water streams (hot left→right, cold right→left) coupled segment by
 * segment through wall solid nodes with convection conductors on both sides
 * — the same architecture as GFSSP Example 5 (user manual §7.9) and the CI
 * test.  Total UA is held fixed while the segment count varies.
 * ========================================================================== */

console.log("Case 5 — counterflow heat exchanger");

const HX = {
  ThIn: 400,
  TcIn: 300,
  mdotH: 0.2,
  mdotC: 0.3,
  h: 500, // both sides [W/m²K]
  Atot: 5.0, // total transfer area per side [m²]
};
const hxCh = HX.mdotH * CP_WATER;
const hxCc = HX.mdotC * CP_WATER;
const hxCmin = Math.min(hxCh, hxCc);
const hxCmax = Math.max(hxCh, hxCc);
const hxCr = hxCmin / hxCmax;
// Per segment: two hA films in series wall-coupled ⇒ UA_seg = hA_seg/2;
// summed over segments: UA = h·A_tot/2 independent of the segment count.
const hxUA = (HX.h * HX.Atot) / 2;
const hxNTU = hxUA / hxCmin;
const hxEpsAn =
  (1 - Math.exp(-hxNTU * (1 - hxCr))) /
  (1 - hxCr * Math.exp(-hxNTU * (1 - hxCr)));
const hxDTmax = HX.ThIn - HX.TcIn;
const hxDutyAn = hxEpsAn * hxCmin * hxDTmax;
const hxThOutAn = HX.ThIn - hxDutyAn / hxCh;
const hxTcOutAn = HX.TcIn + hxDutyAn / hxCc;

/** Analytic counterflow profiles: hot flows x = 0 → 1, cold flows x = 1 → 0. */
function hxProfiles(x: number): { Th: number; Tc: number } {
  const a = hxUA * (1 / hxCh - 1 / hxCc); // Δ(x) = Δ(0)·e^(−a·x), L = 1
  const d0 = HX.ThIn - hxTcOutAn;
  const Th = HX.ThIn - ((hxUA / hxCh) * d0 * (1 - Math.exp(-a * x))) / a;
  return { Th, Tc: Th - d0 * Math.exp(-a * x) };
}
// Cross-check: analytic profile must land on the ε–NTU outlet states.
{
  const end = hxProfiles(1);
  const c1 = Math.abs(end.Th - hxThOutAn);
  const c2 = Math.abs(end.Tc - HX.TcIn);
  if (c1 > 1e-9 || c2 > 1e-9) {
    throw new Error(`HX profile cross-check failed: ΔTh=${c1}, ΔTc=${c2}`);
  }
}

function buildHX(nSeg: number): NetworkConfig {
  const Aseg = HX.Atot / nSeg;
  const nodes: NetworkConfig["nodes"] = [
    {
      id: "h_in",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: 1e5,
      temperature: HX.ThIn,
    },
    {
      id: "h_out",
      type: "boundary",
      x: nSeg + 1,
      y: 0,
      pressure: 1e5,
      temperature: HX.ThIn,
    },
    {
      id: "c_in",
      type: "boundary",
      x: nSeg + 1,
      y: 2,
      pressure: 1e5,
      temperature: HX.TcIn,
    },
    {
      id: "c_out",
      type: "boundary",
      x: 0,
      y: 2,
      pressure: 1e5,
      temperature: HX.TcIn,
    },
  ];
  const solidNodes: NetworkConfig["solidNodes"] = [];
  const conductors: NetworkConfig["conductors"] = [];
  const branches: NetworkConfig["branches"] = [];

  for (let i = 1; i <= nSeg; i++) {
    nodes.push({
      id: `h${i}`,
      type: "internal",
      x: i,
      y: 0,
      pressure: 1e5,
      temperature: HX.ThIn,
    });
    nodes.push({
      id: `c${i}`,
      type: "internal",
      x: i,
      y: 2,
      pressure: 1e5,
      temperature: HX.TcIn,
    });
    solidNodes.push({
      id: `w${i}`,
      type: "solid",
      x: i,
      y: 1,
      temperature: (HX.ThIn + HX.TcIn) / 2,
    });
    conductors.push({
      id: `hw${i}`,
      from: `h${i}`,
      to: `w${i}`,
      type: { kind: "convection", h: HX.h, area: Aseg },
    });
    conductors.push({
      id: `cw${i}`,
      from: `w${i}`,
      to: `c${i}`,
      type: { kind: "convection", h: HX.h, area: Aseg },
    });
  }

  // Hot stream left→right
  for (let i = 0; i <= nSeg; i++) {
    const from = i === 0 ? "h_in" : `h${i}`;
    const to = i === nSeg ? "h_out" : `h${i + 1}`;
    branches.push({
      id: `hb${i + 1}`,
      from,
      to,
      component: { type: "flowSource", massFlow: HX.mdotH },
    });
  }
  // Cold stream right→left (counterflow)
  branches.push({
    id: "cb1",
    from: "c_in",
    to: `c${nSeg}`,
    component: { type: "flowSource", massFlow: HX.mdotC },
  });
  for (let i = nSeg; i >= 2; i--) {
    branches.push({
      id: `cb${nSeg - i + 2}`,
      from: `c${i}`,
      to: `c${i - 1}`,
      component: { type: "flowSource", massFlow: HX.mdotC },
    });
  }
  branches.push({
    id: `cb${nSeg + 1}`,
    from: "c1",
    to: "c_out",
    component: { type: "flowSource", massFlow: HX.mdotC },
  });

  return makeConfig(`counterflow HX N=${nSeg}`, {
    nodes,
    solidNodes,
    conductors,
    branches,
  });
}

interface HxRun {
  nSeg: number;
  res: SteadyResult;
  ThOut: number;
  TcOut: number;
  duty: number;
  eps: number;
  epsErr: number;
  ThOutErrK: number;
  TcOutErrK: number;
  balanceErr: number;
}

function runHX(nSeg: number): HxRun {
  const res = solveChecked(buildHX(nSeg));
  const ThOut = res.nodes[`h${nSeg}`].temperature;
  const TcOut = res.nodes.c1.temperature;
  const dutyHot = hxCh * (HX.ThIn - ThOut);
  const dutyCold = hxCc * (TcOut - HX.TcIn);
  const duty = (dutyHot + dutyCold) / 2;
  const eps = duty / (hxCmin * hxDTmax);
  return {
    nSeg,
    res,
    ThOut,
    TcOut,
    duty,
    eps,
    epsErr: Math.abs(eps - hxEpsAn) / hxEpsAn,
    ThOutErrK: Math.abs(ThOut - hxThOutAn),
    TcOutErrK: Math.abs(TcOut - hxTcOutAn),
    balanceErr: Math.abs(dutyHot - dutyCold) / duty,
  };
}

const hxSweepNs = [2, 3, 5, 8, 12, 16, 20, 28];
const hxRuns = hxSweepNs.map(runHX);
const hxMain = hxRuns[hxRuns.length - 2]; // N = 20 — flagship discretization
if (hxMain.nSeg !== 20) throw new Error("expected N=20 flagship run");
for (const r of hxRuns) {
  console.log(
    `  N=${String(r.nSeg).padStart(2)}  ε=${r.eps.toFixed(4)} (analytic ${hxEpsAn.toFixed(4)}, err=${pct(r.epsErr)})  Th_out err=${r.ThOutErrK.toFixed(3)} K  Tc_out err=${r.TcOutErrK.toFixed(3)} K  balance=${pct(r.balanceErr)}`,
  );
}

// Axial profile deviation for the flagship run.  The discrete cells are an
// implicit-upwind scheme: each stream's node holds its cell-OUTLET state, so
// hot node i sits at x = i/N and cold node i (flowing right→left) at
// x = (i−1)/N.
interface HxProfilePoint {
  x: number;
  Tnum: number;
  Tan: number;
}
const hxHotPts: HxProfilePoint[] = [];
const hxColdPts: HxProfilePoint[] = [];
for (let i = 1; i <= hxMain.nSeg; i++) {
  const xh = i / hxMain.nSeg;
  const xc = (i - 1) / hxMain.nSeg;
  hxHotPts.push({
    x: xh,
    Tnum: hxMain.res.nodes[`h${i}`].temperature,
    Tan: hxProfiles(xh).Th,
  });
  hxColdPts.push({
    x: xc,
    Tnum: hxMain.res.nodes[`c${i}`].temperature,
    Tan: hxProfiles(xc).Tc,
  });
}
const hxProfileDevK = Math.max(
  ...[...hxHotPts, ...hxColdPts].map((p) => Math.abs(p.Tnum - p.Tan)),
);
console.log(
  `  N=20 profiles: max axial deviation ${hxProfileDevK.toFixed(3)} K over both streams`,
);

/* ==========================================================================
 * Schematic figures
 * ========================================================================== */

function fig1WallSchematic(): string {
  const W = 720;
  const H = 330;
  const yTop = 90;
  const wallH = 150;
  const xA = 250;
  const wA = 140; // layer A, 0.10 m
  const wB = 70; // layer B, 0.05 m
  const yc = yTop + wallH / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">
<rect width="${W}" height="${H}" fill="white"/>
<text x="${W / 2}" y="24" text-anchor="middle" font-size="15" font-weight="bold">Composite plane wall (case 1)</text>
<rect x="${xA}" y="${yTop}" width="${wA}" height="${wallH}" fill="#f6e3d5" stroke="#333" stroke-width="1.6"/>
<rect x="${xA + wA}" y="${yTop}" width="${wB}" height="${wallH}" fill="#fdf6dd" stroke="#333" stroke-width="1.6"/>
<text x="${xA + wA / 2}" y="${yc - 8}" text-anchor="middle" font-size="12">layer A</text>
<text x="${xA + wA / 2}" y="${yc + 10}" text-anchor="middle" font-size="12">k₁ = ${W1.k1} W/mK</text>
<text x="${xA + wA / 2}" y="${yc + 28}" text-anchor="middle" font-size="12">L₁ = ${W1.L1} m</text>
<text x="${xA + wA + wB / 2}" y="${yc - 8}" text-anchor="middle" font-size="12">B</text>
<text x="${xA + wA + wB / 2}" y="${yc + 10}" text-anchor="middle" font-size="11">k₂ = ${W1.k2}</text>
<text x="${xA + wA + wB / 2}" y="${yc + 28}" text-anchor="middle" font-size="11">L₂ = ${W1.L2} m</text>
<text x="${xA - 90}" y="${yc - 26}" text-anchor="middle" font-size="12">hot fluid</text>
<text x="${xA - 90}" y="${yc - 8}" text-anchor="middle" font-size="12">T∞₁ = ${W1.Thot} K</text>
<text x="${xA - 90}" y="${yc + 10}" text-anchor="middle" font-size="12">h₁ = ${W1.h1} W/m²K</text>
<text x="${xA + wA + wB + 92}" y="${yc - 26}" text-anchor="middle" font-size="12">cold fluid</text>
<text x="${xA + wA + wB + 92}" y="${yc - 8}" text-anchor="middle" font-size="12">T∞₂ = ${W1.Tcold} K</text>
<text x="${xA + wA + wB + 92}" y="${yc + 10}" text-anchor="middle" font-size="12">h₂ = ${W1.h2} W/m²K</text>
<line x1="${xA - 50}" y1="${yc + 44}" x2="${xA - 8}" y2="${yc + 44}" stroke="#c0392b" stroke-width="2.2"/>
<polygon points="${xA - 8},${yc + 44} ${xA - 20},${yc + 38} ${xA - 20},${yc + 50}" fill="#c0392b"/>
<line x1="${xA + wA + wB + 8}" y1="${yc + 44}" x2="${xA + wA + wB + 50}" y2="${yc + 44}" stroke="#c0392b" stroke-width="2.2"/>
<polygon points="${xA + wA + wB + 50},${yc + 44} ${xA + wA + wB + 38},${yc + 38} ${xA + wA + wB + 38},${yc + 50}" fill="#c0392b"/>
<text x="${xA + (wA + wB) / 2}" y="${yTop + wallH + 30}" text-anchor="middle" font-size="12">Q̇ = ΔT / ΣR,  ΣR = 1/h₁A + L₁/k₁A + L₂/k₂A + 1/h₂A</text>
<circle cx="${xA}" cy="${yTop - 12}" r="4" fill="#1f5fa8"/>
<circle cx="${xA + wA}" cy="${yTop - 12}" r="4" fill="#1f5fa8"/>
<circle cx="${xA + wA + wB}" cy="${yTop - 12}" r="4" fill="#1f5fa8"/>
<text x="${xA}" y="${yTop - 20}" text-anchor="middle" font-size="11">s1</text>
<text x="${xA + wA}" y="${yTop - 20}" text-anchor="middle" font-size="11">s2</text>
<text x="${xA + wA + wB}" y="${yTop - 20}" text-anchor="middle" font-size="11">s3</text>
<text x="${W / 2}" y="${H - 14}" text-anchor="middle" font-size="12">Figure 1. Composite wall: three solid nodes (surfaces and interface), two conduction and two convection conductors.</text>
</svg>`;
}

function fig2HxSchematic(): string {
  const W = 720;
  const H = 340;
  const x0 = 110;
  const chW = 480;
  const chH = 42;
  const yHot = 90;
  const yCold = 210;
  const yWall = (yHot + chH + yCold) / 2;
  const nShow = 6;
  const cells: string[] = [];
  for (let i = 0; i < nShow; i++) {
    const cx = x0 + ((i + 0.5) * chW) / nShow;
    cells.push(
      `<rect x="${cx - 7}" y="${yWall - 7}" width="14" height="14" fill="#eee" stroke="#333" stroke-width="1.2"/>`,
      `<line x1="${cx}" y1="${yHot + chH}" x2="${cx}" y2="${yWall - 7}" stroke="#888" stroke-width="1.2" stroke-dasharray="4 3"/>`,
      `<line x1="${cx}" y1="${yWall + 7}" x2="${cx}" y2="${yCold}" stroke="#888" stroke-width="1.2" stroke-dasharray="4 3"/>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">
<rect width="${W}" height="${H}" fill="white"/>
<text x="${W / 2}" y="24" text-anchor="middle" font-size="15" font-weight="bold">Counterflow heat exchanger (case 5)</text>
<rect x="${x0}" y="${yHot}" width="${chW}" height="${chH}" fill="#fdeaea" stroke="#333" stroke-width="1.6"/>
<rect x="${x0}" y="${yCold}" width="${chW}" height="${chH}" fill="#e8f0fa" stroke="#333" stroke-width="1.6"/>
${cells.join("\n")}
<line x1="${x0 - 62}" y1="${yHot + chH / 2}" x2="${x0 - 8}" y2="${yHot + chH / 2}" stroke="#c0392b" stroke-width="2.2"/>
<polygon points="${x0 - 8},${yHot + chH / 2} ${x0 - 20},${yHot + chH / 2 - 6} ${x0 - 20},${yHot + chH / 2 + 6}" fill="#c0392b"/>
<line x1="${x0 + chW + 8}" y1="${yHot + chH / 2}" x2="${x0 + chW + 62}" y2="${yHot + chH / 2}" stroke="#c0392b" stroke-width="2.2"/>
<polygon points="${x0 + chW + 62},${yHot + chH / 2} ${x0 + chW + 50},${yHot + chH / 2 - 6} ${x0 + chW + 50},${yHot + chH / 2 + 6}" fill="#c0392b"/>
<line x1="${x0 + chW + 62}" y1="${yCold + chH / 2}" x2="${x0 + chW + 8}" y2="${yCold + chH / 2}" stroke="#1f5fa8" stroke-width="2.2"/>
<polygon points="${x0 + chW + 8},${yCold + chH / 2} ${x0 + chW + 20},${yCold + chH / 2 - 6} ${x0 + chW + 20},${yCold + chH / 2 + 6}" fill="#1f5fa8"/>
<line x1="${x0 - 8}" y1="${yCold + chH / 2}" x2="${x0 - 62}" y2="${yCold + chH / 2}" stroke="#1f5fa8" stroke-width="2.2"/>
<polygon points="${x0 - 62},${yCold + chH / 2} ${x0 - 50},${yCold + chH / 2 - 6} ${x0 - 50},${yCold + chH / 2 + 6}" fill="#1f5fa8"/>
<text x="${x0 - 12}" y="${yHot - 10}" text-anchor="start" font-size="12">hot: ṁ = ${HX.mdotH} kg/s, T<tspan font-size="9" dy="3">in</tspan><tspan dy="-3"> = ${HX.ThIn} K</tspan></text>
<text x="${x0 + chW + 12}" y="${yCold + chH + 24}" text-anchor="end" font-size="12">cold: ṁ = ${HX.mdotC} kg/s, T<tspan font-size="9" dy="3">in</tspan><tspan dy="-3"> = ${HX.TcIn} K</tspan></text>
<text x="${x0 + chW / 2}" y="${yWall + 34}" text-anchor="middle" font-size="12">wall solid nodes w<tspan font-size="9" dy="3">i</tspan><tspan dy="-3">; convection hA</tspan><tspan font-size="9" dy="3">seg</tspan><tspan dy="-3"> on each side (h = ${HX.h} W/m²K, ΣA = ${HX.Atot} m² per side)</tspan></text>
<text x="${W / 2}" y="${H - 14}" text-anchor="middle" font-size="12">Figure 2. Counterflow HX: two water streams exchanging through per-segment wall nodes (${nShow} of N segments drawn).</text>
</svg>`;
}

writeFig(1, "composite-wall-schematic", fig1WallSchematic());
writeFig(2, "hx-schematic", fig2HxSchematic());

/* ==========================================================================
 * Result figures
 * ========================================================================== */

/* --- Figure 3: composite wall temperature profile --- */
const toCm = (m: number) => m * 100;
writeFig(
  3,
  "composite-wall-profile",
  lineChart({
    title: "Composite wall: temperature through the wall",
    xLabel: "Position x [cm] (0 = hot surface)",
    yLabel: "Temperature [K]",
    // Top-right sits on the profile kink at the layer interface; the profile
    // falls left-to-right, so bottom-left is the empty corner.
    legend: "bottom-left",
    series: [
      {
        label: `Hot fluid T∞₁ = ${W1.Thot} K`,
        pts: [
          [-4, W1.Thot],
          [0, W1.Thot],
        ],
        color: C.red,
        mode: "line",
        dash: "6 4",
      },
      {
        label: "Analytic (series resistances)",
        pts: [
          [0, wallTan.s1],
          [toCm(W1.L1), wallTan.s2],
          [toCm(W1.L1 + W1.L2), wallTan.s3],
        ],
        color: C.analytic,
        mode: "line",
      },
      {
        label: "Solver solid nodes",
        pts: [
          [0, wallTnum.s1],
          [toCm(W1.L1), wallTnum.s2],
          [toCm(W1.L1 + W1.L2), wallTnum.s3],
        ],
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
      {
        label: `Cold fluid T∞₂ = ${W1.Tcold} K`,
        pts: [
          [toCm(W1.L1 + W1.L2), W1.Tcold],
          [toCm(W1.L1 + W1.L2) + 4, W1.Tcold],
        ],
        color: C.blue,
        mode: "line",
        dash: "6 4",
      },
    ],
  }),
);

/* --- Figure 4: radiation–convection equilibrium sweep --- */
const radDense: Array<[number, number]> = [];
for (let q = 50; q <= 4200; q += 25) radDense.push([q, radConvEquilibrium(q)]);
writeFig(
  4,
  "radiation-convection-equilibrium",
  lineChart({
    title: `Radiation–convection equilibrium: T<tspan font-size="11" dy="4">eq</tspan><tspan dy="-4"> vs heat input</tspan>`,
    xLabel: "Heat input q [W]",
    yLabel: "Equilibrium temperature [K]",
    legend: "bottom-right",
    series: [
      {
        label: "Newton root-solve of the balance",
        pts: radDense,
        color: C.analytic,
        mode: "line",
      },
      {
        label: "Solver (steady solid node)",
        pts: radPoints.map((p): [number, number] => [p.q, p.Tnum]),
        color: C.red,
        mode: "markers",
        marker: "square",
      },
    ],
  }),
);

/* --- Figure 5: lumped-capacitance transient --- */
const lumpedDense: Array<[number, number]> = [];
for (let t = 0; t <= lumpedEnd + 1e-9; t += lumpedEnd / 240) {
  lumpedDense.push([t, lumpedAnalytic(t)]);
}
const subsample = (
  res: TransientResult,
  dt: number,
  every: number,
): Array<[number, number]> => {
  const trace = res.solidNodes!.s1.temperature;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < trace.length; i += every) pts.push([i * dt, trace[i]]);
  return pts;
};
writeFig(
  5,
  "lumped-transient",
  lineChart({
    title: "Lumped-capacitance cooldown: T(t), backward Euler vs exponential",
    xLabel: "Time t [s]",
    yLabel: "Solid temperature [K]",
    legend: "top-right",
    series: [
      {
        label: "Analytic T∞ + (T₀−T∞)e^(−t/τ)",
        pts: lumpedDense,
        color: C.analytic,
        mode: "line",
      },
      {
        label: `Numerical, dt = τ/25 = ${lumpedDt1} s`,
        pts: subsample(lumpedRes1, lumpedDt1, 3),
        color: C.red,
        mode: "markers",
        marker: "square",
      },
      {
        label: `Numerical, dt = τ/100 = ${lumpedDt2} s`,
        pts: subsample(lumpedRes2, lumpedDt2, 12),
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
    ],
  }),
);

/* --- Figure 6: heated pipe axial profile --- */
const hpDense: Array<[number, number]> = [];
for (let x = 0; x <= hpLtot + 1e-9; x += hpLtot / 200)
  hpDense.push([x, hpAnalyticAt(x)]);
writeFig(
  6,
  "heated-pipe-profile",
  lineChart({
    title: "Heated pipe: axial fluid temperature, constant wall temperature",
    xLabel: "Axial distance x [m]",
    yLabel: "Fluid temperature [K]",
    legend: "bottom-right",
    series: [
      {
        label: `Wall T<tspan font-size="8.5" dy="3">w</tspan><tspan dy="-3"> = ${HP.Twall} K</tspan>`,
        pts: [
          [0, HP.Twall],
          [hpLtot, HP.Twall],
        ],
        color: C.orange,
        mode: "line",
        dash: "6 4",
      },
      {
        label: "Analytic exponential approach",
        pts: hpDense,
        color: C.analytic,
        mode: "line",
      },
      {
        label: `Numerical, ${HP.n} segments`,
        pts: [
          [0, HP.Tin] as [number, number],
          ...hpStations.map((s): [number, number] => [s.x, s.Tnum]),
        ],
        color: C.blue,
        mode: "markers",
        marker: "circle",
      },
    ],
  }),
);

/* --- Figure 7: HX axial temperature profiles (flagship) --- */
const hxDenseHot: Array<[number, number]> = [];
const hxDenseCold: Array<[number, number]> = [];
for (let x = 0; x <= 1 + 1e-9; x += 1 / 200) {
  const p = hxProfiles(x);
  hxDenseHot.push([x, p.Th]);
  hxDenseCold.push([x, p.Tc]);
}
writeFig(
  7,
  "hx-profiles",
  lineChart({
    title: `Counterflow HX: axial temperature profiles (N = ${hxMain.nSeg} segments)`,
    xLabel: "Normalized position x/L (hot flows left → right)",
    yLabel: "Temperature [K]",
    legend: "top-right",
    series: [
      {
        label: "Hot stream — analytic",
        pts: hxDenseHot,
        color: C.analytic,
        mode: "line",
      },
      {
        label: "Hot stream — numerical",
        pts: [
          [0, HX.ThIn] as [number, number],
          ...hxHotPts.map((p): [number, number] => [p.x, p.Tnum]),
        ],
        color: C.red,
        mode: "markers",
        marker: "circle",
      },
      {
        label: "Cold stream — analytic",
        pts: hxDenseCold,
        color: C.analytic,
        mode: "line",
        dash: "7 4",
      },
      {
        label: "Cold stream — numerical",
        pts: [
          ...hxColdPts.map((p): [number, number] => [p.x, p.Tnum]),
          [1, HX.TcIn] as [number, number],
        ],
        color: C.blue,
        mode: "markers",
        marker: "square",
      },
    ],
  }),
);

/* --- Figure 8: HX segmentation convergence --- */
writeFig(
  8,
  "hx-segmentation",
  lineChart({
    title: "Counterflow HX: effectiveness vs segment count (UA fixed)",
    xLabel: "Number of wall segments N",
    yLabel: "Effectiveness ε",
    legend: "bottom-right",
    yPad: 0.15,
    series: [
      {
        label: `ε–NTU closed form (${hxEpsAn.toFixed(4)})`,
        pts: [
          [hxSweepNs[0], hxEpsAn],
          [hxSweepNs[hxSweepNs.length - 1], hxEpsAn],
        ],
        color: C.analytic,
        mode: "line",
        dash: "7 4",
      },
      {
        label: "Numerical (segmented wall model)",
        pts: hxRuns.map((r): [number, number] => [r.nSeg, r.eps]),
        color: C.green,
        mode: "both",
        marker: "triangle",
      },
    ],
  }),
);

/* ==========================================================================
 * Report markdown
 * ========================================================================== */

const fig = (n: number, caption: string) =>
  `![Figure ${n}](figures/thermal/${figures[n]})\n\n*Figure ${n}. ${caption}*`;

const radRows = radPoints
  .map(
    (p) =>
      `| ${p.q} | ${fmtK(p.Tan, 3)} | ${fmtK(p.Tnum, 3)} | ${pct(p.err)} |`,
  )
  .join("\n");

const hxRows = hxRuns
  .map(
    (r) =>
      `| ${r.nSeg} | ${r.eps.toFixed(4)} | ${pct(r.epsErr)} | ${fmtK(r.ThOut, 2)} | ${fmtK(r.TcOut, 2)} | ${pct(r.balanceErr)} |`,
  )
  .join("\n");

const report = `# Thermal Network and Conjugate Heat Transfer Validation of OpenFLUME

**Analytic verification of the solid-node thermal system — conduction, convection, and radiation conductors — and of its conjugate coupling to the fluid network**

Generated by \`scripts/thermal-validation-report.ts\` — all numbers and figures
come from live solves of the current solver. The corresponding CI gates are
\`src/core/__tests__/thermal.test.ts\` and
\`src/core/__tests__/solidThermalTransient.test.ts\`.

## Abstract

This report verifies the conjugate thermal capability of the OpenFLUME
solver — a pressure-based node-and-branch network code in the same family as
NASA's GFSSP — against classical closed-form heat-transfer solutions. Five
benchmark cases exercise every conductor kind and both coupling directions
between the solid and fluid systems: a steady composite plane wall (series
thermal-resistance network), the nonlinear radiation–convection equilibrium of
a heated solid node, the lumped-capacitance transient cooldown, a heated pipe
approaching a constant wall temperature, and — the flagship case — a
counterflow heat exchanger of two water streams wall-coupled through solid
nodes, compared against the ε–NTU closed form. The steady resistance-network
cases reproduce the analytic solutions to near machine precision
(composite-wall heat flow within ${pct(wallQerr)}, radiation equilibrium
temperatures within ${pct(radErrMax)}); the transient cooldown follows the
exponential within ${pct(lumpedMax2)} of the temperature span at dt = τ/100
and exhibits the expected first-order time-step convergence of backward Euler
(error ratio ${lumpedRatio.toFixed(2)} for a 4× step refinement); the heated
pipe reproduces the exponential wall-temperature approach to
${pct(hpErrMaxRel)}; and the ${hxMain.nSeg}-segment heat exchanger predicts
effectiveness within ${pct(hxMain.epsErr)} and both outlet temperatures within
${fmtK(Math.max(hxMain.ThOutErrK, hxMain.TcOutErrK), 3)} K of the ε–NTU
solution, with the residual discrepancy shown to be finite-segmentation error
that vanishes monotonically as the wall discretization is refined.

## Introduction

Fluid-network codes that carry only fluid unknowns cannot represent hardware
thermal mass, structural conduction paths, or radiation sinks — all of which
dominate problems like cryogenic line chilldown, heat-exchanger sizing, and
thermal protection. OpenFLUME therefore carries a second, thermal network
alongside the fluid one: solid nodes with optional thermal capacitance
(mass × cp) and prescribed heat inputs, ambient nodes at fixed temperature,
and conductors of three kinds — conduction (kA/L), convection (hA, attaching
a solid to a fluid node), and radiation (σεAF between solid/ambient nodes).
Heated-pipe branches provide a complementary lightweight fluid heating path
against a prescribed wall temperature. The purpose of this report is to
verify that machinery the same way the compressible-flow capability was
verified (see \`docs/validation/compressible-report.md\`): live solves
of small networks against independent analytic references, with every number
in this document interpolated from those solves.

## Problem Description

Five cases cover the three conductor kinds, both steady and transient solid
physics, and both directions of conjugate coupling (fluid heating a wall,
walls heating a fluid):

| Case | Description | Reference |
| ---- | ----------- | --------- |
| 1 | Steady composite plane wall: convection–conduction–conduction–convection in series | Resistance sum, Q = ΔT/ΣR |
| 2 | Radiation–convection equilibrium of a solid node with fixed heat input, swept over q | Newton root-solve of the T⁴ balance |
| 3 | Lumped-capacitance transient cooldown by convection, two time steps | T(t) = T∞ + (T₀−T∞)e^(−t/τ) |
| 4 | Heated pipe: ${HP.n} constant-wall-temperature segments in series | Exponential axial approach |
| 5 | Counterflow heat exchanger: two water streams wall-coupled per segment | ε–NTU closed form |

### Composite Wall

Case 1 is the classic two-layer furnace wall (Figure 1): hot fluid at
${W1.Thot} K with film coefficient h₁ = ${W1.h1} W/m²K, a ${toCm(W1.L1)} cm
layer of k₁ = ${W1.k1} W/mK, a ${toCm(W1.L2)} cm layer of k₂ = ${W1.k2} W/mK,
and cold fluid at ${W1.Tcold} K with h₂ = ${W1.h2} W/m²K, over A = ${W1.A} m².
Three solid nodes sit at the two surfaces and the layer interface; the two
fluids are boundary nodes of the fluid network.

${fig(1, "Composite wall: three solid nodes (surfaces and interface), two conduction and two convection conductors between two fluid boundary nodes.")}

### Counterflow Heat Exchanger

Case 5 mirrors the architecture of GFSSP Example 5 (the water–water
counterflow heat exchanger, user manual §7.9): each axial segment carries an
internal fluid node on the hot stream, an internal fluid node on the cold
stream, and a wall solid node between them, with convection conductors on
both faces (Figure 2). The hot stream (${HX.mdotH} kg/s, ${HX.ThIn} K in)
flows left to right; the cold stream (${HX.mdotC} kg/s, ${HX.TcIn} K in)
flows right to left. Both film coefficients are ${HX.h} W/m²K over a total
transfer area of ${HX.Atot} m² per side, so the overall conductance
UA = hA/2 = ${hxUA.toFixed(0)} W/K is independent of the segment count and
the segment sweep isolates pure discretization error. The capacity rates are
deliberately unequal (C_r = ${hxCr.toFixed(4)}) to exercise the general
ε–NTU form rather than the degenerate balanced case.

${fig(2, "Counterflow heat exchanger: per-segment wall solid nodes with convection conductors to both streams, mirroring GFSSP Example 5.")}

## Benchmark Solutions

**Series resistance network (case 1).** In steady state the heat flow through
every element of the chain is equal, so the wall behaves as resistances in
series:

$$\\Sigma R = \\frac{1}{h_1 A} + \\frac{L_1}{k_1 A} + \\frac{L_2}{k_2 A} + \\frac{1}{h_2 A}, \\qquad \\dot Q = \\frac{T_{\\infty 1} - T_{\\infty 2}}{\\Sigma R},$$

and the surface and interface temperatures follow from partial sums,
$T_{s,i} = T_{\\infty 1} - \\dot Q \\sum_{j \\le i} R_j$. With the case-1
numbers, ΣR = ${wallRtot.toFixed(6)} K/W and Q̇ = ${wallQan.toFixed(4)} W.

**Radiation–convection equilibrium (case 2).** A solid node with heat input q
losing to a common sink temperature T∞ by convection and radiation settles
where

$$q = hA\\,(T - T_\\infty) + \\sigma \\varepsilon A F\\,(T^4 - T_\\infty^4).$$

The quartic has one physical root above T∞; the reference is a Newton
iteration on this balance, converged to 10⁻¹² K in-script.

**Lumped capacitance (case 3).** A solid of thermal capacitance mc cooling
through a convection conductance hA obeys

$$m c \\frac{dT}{dt} = -hA\\,(T - T_\\infty) \\;\\Rightarrow\\; T(t) = T_\\infty + (T_0 - T_\\infty)\\,e^{-t/\\tau}, \\qquad \\tau = \\frac{mc}{hA}.$$

For the physical problem this classical solution requires a small Biot number
(Bi = hL_c/k ≲ 0.1) so the solid is spatially isothermal; for the network
model the comparison is exact by construction, because a solid node *is* a
lumped capacitance with no internal resistance — which makes this a pure test
of the time integrator.

**Heated pipe with constant wall temperature (case 4).** A fluid stream ṁcp
exchanging with a fixed wall temperature through a uniformly distributed
conductance UA obeys dT/dx = (UA/L)(T_w − T)/(ṁc_p), giving the exponential
approach

$$T(x) = T_w - (T_w - T_{in})\\,\\exp\\left(-\\frac{UA}{\\dot m c_p}\\frac{x}{L}\\right).$$

The solver's heated-pipe branch applies exactly the per-segment
effectiveness form ε = 1 − exp(−UA_seg/ṁc_p), whose composition over equal
segments reproduces this exponential at every node; the comparison therefore
isolates the branch heat-delivery path and the coupled energy balance rather
than a discretization error.

**Counterflow ε–NTU (case 5).** With NTU = UA/C_min and C_r = C_min/C_max,
the counterflow effectiveness is

$$\\varepsilon = \\frac{1 - \\exp\\left(-\\mathrm{NTU}\\,(1 - C_r)\\right)}{1 - C_r \\exp\\left(-\\mathrm{NTU}\\,(1 - C_r)\\right)},$$

and the outlet temperatures follow from q = εC_min(T_{h,in} − T_{c,in}).
The axial profiles come from the temperature-difference ODE
dΔT/dx = −(UA/L)(1/C_h − 1/C_c)ΔT, whose exponential solution is anchored by
the ε–NTU outlet states (cross-checked in-script to 10⁻⁹ K). With the case-5
numbers, NTU = ${hxNTU.toFixed(4)}, C_r = ${hxCr.toFixed(4)}, and
ε = ${hxEpsAn.toFixed(4)}.

## Numerical Modeling

The thermal network adds one temperature unknown per solid node. Each solid
node enforces an energy balance over its attached conductors and prescribed
heat input,

$$m c_p \\frac{dT_i}{dt} = \\sum_j \\dot Q_{ji} + \\dot Q_{input,i},$$

with the storage term dropped in steady mode (and the backward-Euler form
m c_p (T_i^{n+1} − T_i^n)/Δt in transient mode — first-order in time). The
conductor heat rates take the three classical forms: conduction
Q̇ = (kA/L)(T_i − T_j), convection Q̇ = hA(T_s − T_f) against a fluid-node
temperature, and radiation Q̇ = σεAF(T_i⁴ − T_j⁴) between solid/ambient
nodes. The solid temperatures are solved as a segregated thermal subsystem by
a Newton iteration with an exact analytic Jacobian — including the 4σεAFT³
radiation derivative, which is what lets the strongly nonlinear case-2
balance converge from a cold start (the Jacobian is verified entry-by-entry
against central finite differences in
\`src/core/__tests__/solidThermalTransient.test.ts\`).

Conjugate coupling runs in both directions. Convection conductors deposit
their heat rate into the attached fluid node's energy balance, so a heated
wall raises the downstream fluid temperature through the ordinary advective
energy equation; conversely the fluid temperature enters the conductor's
driving ΔT. Heated-pipe branches short-cut this when the wall temperature is
known rather than solved: they deliver Q̇ = ṁc_pε(T_w − T_in) with
ε = 1 − exp(−UA/ṁc_p) directly to the downstream node. In cases 1–3 the
fluid network is reduced to boundary nodes (fixed T∞ reservoirs) with a
zero-flow source branch, mirroring the CI-test configurations; in cases 4–5
the streams carry real through-flow (case 4 pressure-driven through an
orifice, case 5 imposed by flow sources on both streams, exactly as in the
CI heat-exchanger test).

In the segmented heat-exchanger model each stream's internal node holds its
cell-outlet state (an implicit upwind discretization of the counterflow
ODEs), so hot node i is plotted at x = i/N and cold node i — flowing right to
left — at x = (i−1)/N. The scheme is first-order in the segment width, which
is the discretization error the segment sweep of Figure 8 quantifies.

## Results and Discussion

| Case | Compared quantity | Max deviation | Notes |
| ---- | ----------------- | ------------- | ----- |
| 1 — composite wall | heat flow Q̇ | ${pct(wallQerr)} | series chain spread ${pct(wallQspread)} |
| 1 — composite wall | surface/interface T (3 nodes) | ${wallTerrMaxK.toExponential(2)} K (${pct(wallTerrMaxRel)}) | near machine precision |
| 2 — radiation–convection | equilibrium T over ${radQs.length}-point q sweep | ${pct(radErrMax)} | balance residual ≤ ${pct(radBalMax)} of q |
| 3 — lumped transient (dt = τ/25) | T(t) vs exponential | ${pct(lumpedMax1)} of span | backward Euler, first order |
| 3 — lumped transient (dt = τ/100) | T(t) vs exponential | ${pct(lumpedMax2)} of span | error ratio ${lumpedRatio.toFixed(2)} vs 4 expected |
| 4 — heated pipe (${HP.n} segments) | axial T profile, ${HP.n} nodes | ${pct(hpErrMaxRel)} | outlet within ${hpOutletErrK.toExponential(2)} K |
| 5 — counterflow HX (N = ${hxMain.nSeg}) | effectiveness ε | ${pct(hxMain.epsErr)} | outlets within ${fmtK(Math.max(hxMain.ThOutErrK, hxMain.TcOutErrK), 3)} K; segmentation error, first order in 1/N |

### Case 1: Composite Plane Wall

The solver reproduces the series-resistance solution essentially exactly:
Q̇ = ${wallQnum.toFixed(4)} W against the analytic ${wallQan.toFixed(4)} W
(${pct(wallQerr)}), with the same heat flow through all four elements of the
chain to ${pct(wallQspread)} — the discrete statement that the steady
resistances are truly in series. The hot-surface, interface, and cold-surface
temperatures are ${fmtK(wallTnum.s1)} K, ${fmtK(wallTnum.s2)} K, and
${fmtK(wallTnum.s3)} K against analytic values of ${fmtK(wallTan.s1)} K,
${fmtK(wallTan.s2)} K, and ${fmtK(wallTan.s3)} K — a worst deviation of
${wallTerrMaxK.toExponential(2)} K (Figure 3). The insulation layer carries
${pct(wallR.condB / wallRtot, 1)} of the total resistance and correspondingly
almost the entire temperature drop, a useful visual check that each conductor
carries its intended share.

${fig(3, "Temperature through the composite wall: analytic piecewise-linear profile and solver solid-node temperatures; dashed levels are the two fluid reservoir temperatures.")}

### Case 2: Radiation–Convection Equilibrium

A solid node with fixed heat input q sheds it through a convection conductor
(h = ${R2.h} W/m²K, A = ${R2.Aconv} m²) to a ${R2.Tinf} K fluid and a
radiation conductor (ε = ${R2.eps}, A = ${R2.Arad} m², F = ${R2.F}) to a
${R2.Tinf} K ambient. Sweeping q from ${radQs[0]} to
${radQs[radQs.length - 1]} W moves the equilibrium from
${fmtK(radPoints[0].Tnum, 1)} K to ${fmtK(radTopPoint.Tnum, 1)} K, across
which the radiated share of the load grows from
${pct(radFracBottom, 1)} to ${pct(radFracTop, 1)} — the sweep genuinely
crosses from convection-dominated to radiation-dominated territory. The
solver matches the Newton reference within ${pct(radErrMax)} at every point
(Figure 4, Table below), and substituting the solver temperatures back into
the analytic balance leaves a residual below ${pct(radBalMax)} of q,
confirming the exact treatment of the T⁴ conductor in the thermal Newton
system.

| q [W] | T_eq analytic [K] | T_eq solver [K] | deviation |
| ----- | ----------------- | --------------- | --------- |
${radRows}

${fig(4, "Equilibrium temperature vs heat input: Newton root-solve of the convection + radiation balance (line) and steady solver results (markers).")}

### Case 3: Lumped-Capacitance Transient Cooldown

A solid node (m = ${L3.m} kg, c_p = ${L3.cp} J/kg·K) initially at
${L3.T0} K cools through a convection conductor (hA = ${L3.h * L3.A} W/K) to
a ${L3.Tinf} K reservoir; τ = mc_p/hA = ${tau} s. Two fixed time steps were
run to 3τ. At dt = τ/25 = ${lumpedDt1} s the trace deviates from the
exponential by at most ${pct(lumpedMax1)} of the ${lumpedSpan} K span
(|ΔT| = ${lumpedStats.errTau1.toFixed(3)} K at τ,
${lumpedStats.err3Tau1.toFixed(3)} K at 3τ); refining to
dt = τ/100 = ${lumpedDt2} s reduces the 3τ error to
${lumpedStats.err3Tau2.toFixed(4)} K — a ratio of ${lumpedRatio.toFixed(2)}
for a 4× step refinement, consistent with the first-order accuracy of
backward Euler (Figure 5). The integrator is unconditionally stable and
monotone here, so the choice of dt is purely an accuracy trade, not a
stability one.

${fig(5, "Lumped-capacitance cooldown: analytic exponential and backward-Euler traces at dt = τ/25 and dt = τ/100 (markers subsampled for legibility).")}

### Case 4: Heated Pipe with Constant Wall Temperature

Water enters ${HP.n} series heated-pipe segments (D = ${HP.D} m,
L = ${hpLtot} m total, UA = ${HP.uaSeg} W/K per segment) at ${HP.Tin} K with
the wall held at ${HP.Twall} K; the flow is pressure-driven and the solved
rate is ṁ = ${hpMdot.toFixed(5)} kg/s, giving a total
NTU = ${hpNTUtot.toFixed(3)} and an expected outlet approach of
ε = ${(hpEpsTot * 100).toFixed(1)} % of the wall–inlet difference. The
axial profile follows the analytic exponential at all ${HP.n} nodes to within
${pct(hpErrMaxRel)}, with the outlet at ${fmtK(hpOutlet.Tnum, 3)} K against
the analytic ${fmtK(hpOutlet.Tan, 3)} K (Figure 6). Agreement at this level
is expected rather than remarkable — the branch model applies the same
per-segment effectiveness relation the analytic solution composes — but it
verifies the heat-delivery path into the downstream node energy balance and
the coupled solve of flow rate and temperature, with the reference evaluated
at the solved ṁ exactly as in the CI test.

${fig(6, "Heated pipe: analytic exponential approach to the wall temperature and solved node temperatures along the pipe string.")}

### Case 5: Counterflow Heat Exchanger (flagship)

The ${hxMain.nSeg}-segment exchanger predicts ε = ${hxMain.eps.toFixed(4)}
against the ε–NTU value of ${hxEpsAn.toFixed(4)} — a deviation of
${pct(hxMain.epsErr)} — with outlet temperatures of
${fmtK(hxMain.ThOut)} K (hot) and ${fmtK(hxMain.TcOut)} K (cold) against
analytic values of ${fmtK(hxThOutAn)} K and ${fmtK(hxTcOutAn)} K
(deviations of ${fmtK(hxMain.ThOutErrK, 3)} K and
${fmtK(hxMain.TcOutErrK, 3)} K). The hot- and cold-side duties agree to
${pct(hxMain.balanceErr)}, confirming that the wall nodes store nothing in
steady state and simply relay the heat. The axial profiles (Figure 7) track
the analytic exponentials within ${fmtK(hxProfileDevK, 3)} K everywhere on
both streams.

The residual effectiveness error is finite segmentation, not physics: each
segment lumps its exchange at the cell-outlet states (implicit upwind), which
under-predicts the local ΔT and hence the duty. Because total UA is held
fixed as the segment count varies, the sweep of Figure 8 isolates that error:
the numerical effectiveness rises monotonically toward the closed form, from
${pct(hxRuns[0].epsErr)} low at N = ${hxRuns[0].nSeg} to
${pct(hxRuns[hxRuns.length - 1].epsErr)} at
N = ${hxRuns[hxRuns.length - 1].nSeg}, with the error falling roughly in
proportion to 1/N as expected of a first-order scheme. This is the same
segmentation trade GFSSP documents for its Example 5 model, which uses twelve
passes.

| N segments | ε numerical | ε deviation | T_h,out [K] | T_c,out [K] | hot/cold duty imbalance |
| ---------- | ----------- | ----------- | ----------- | ----------- | ----------------------- |
${hxRows}

${fig(7, "Counterflow HX axial temperature profiles at N = 20: analytic (lines) vs numerical node temperatures (markers), hot stream flowing left to right, cold stream right to left.")}

${fig(8, "Effectiveness vs segment count at fixed total UA: monotone first-order approach of the segmented wall model to the ε–NTU closed form.")}

## Conclusions

The thermal-network machinery of OpenFLUME — solid and ambient nodes,
conduction, convection, and radiation conductors, heated-pipe branches, and
the segregated exact-Jacobian thermal Newton subsystem — reproduces the five
classical benchmarks. Steady resistance-network problems solve to near
machine precision (${pct(wallQerr)} on composite-wall heat flow,
${pct(radErrMax)} on radiation–convection equilibria across a q sweep that
moves the radiated share from ${pct(radFracBottom, 1)} to
${pct(radFracTop, 1)} of the load). The backward-Euler transient integrator
follows the lumped-capacitance exponential within ${pct(lumpedMax1)} of span
at dt = τ/25 and converges at first order, its documented accuracy. Conjugate
coupling is verified in both directions: heated-pipe branches reproduce the
exponential wall-temperature approach to ${pct(hpErrMaxRel)}, and the
wall-coupled counterflow heat exchanger matches ε–NTU effectiveness within
${pct(hxMain.epsErr)} at twenty segments, with the remaining discrepancy
demonstrated to be first-order segmentation error that shrinks monotonically
under refinement. Known limitations follow directly from the formulation:
transient accuracy is first order in Δt, and segmented heat-exchanger duty
converges from below at first order in 1/N, so segment count should be
chosen against the NTU per segment rather than by habit.

## References

1. Incropera, F. P., DeWitt, D. P., Bergman, T. L., and Lavine, A. S.,
   *Fundamentals of Heat and Mass Transfer*, 6th ed., John Wiley & Sons,
   2007 (composite walls, lumped capacitance, radiation exchange, ε–NTU).
2. Kays, W. M., and London, A. L., *Compact Heat Exchangers*, 3rd ed.,
   McGraw-Hill, 1984 (effectiveness–NTU relations for counterflow).
3. Majumdar, A. K., LeClair, A. C., Moore, R., and Schallhorn, P. A.,
   *Generalized Fluid System Simulation Program, Version 6.0*,
   NASA/TM-2013-217492, 2013 (Example 5: water–water counterflow heat
   exchanger; conjugate solid–fluid formulation).

## Nomenclature

| Symbol | Meaning |
| ------ | ------- |
| A | heat-transfer area |
| Bi | Biot number hL_c/k |
| C | capacity rate ṁc_p |
| C_r | capacity ratio C_min/C_max |
| c_p | specific heat |
| F | radiation view factor |
| h | convective film coefficient |
| k | thermal conductivity |
| L | thickness / length |
| m | solid node mass |
| ṁ | mass flow rate |
| NTU | number of transfer units UA/C_min |
| Q̇, q | heat rate / heat input |
| R | thermal resistance |
| T | temperature |
| T∞ | reservoir (fluid or ambient) temperature |
| UA | overall conductance |
| ε | heat-exchanger effectiveness; radiation emissivity |
| σ | Stefan–Boltzmann constant |
| τ | lumped-capacitance time constant mc_p/hA |

`;

writeFileSync(join(outDir, "thermal-network-report.md"), report);
console.log(`\nwrote docs/validation/thermal-network-report.md`);
