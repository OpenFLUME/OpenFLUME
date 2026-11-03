/**
 * microfluidics-validation-report.ts — generates the microfluidic network
 * validation report (docs/validation/microfluidics-report.md) and its SVG
 * figures (docs/validation/figures/microfluidics/), following the repo's
 * report pattern (scripts/hydraulics-validation-report.ts).
 *
 * Part A verifies the microfluidic closures against exact solutions
 * (rectangular-duct laminar law, Washburn filling with displaced-air
 * resistance, Jurin rise, flow-driven and resistance-coupled filling).
 * Part B rebuilds published microfluidic networks from their open-access
 * papers and compares with the published numbers; those cases are defined
 * once in src/validation/microfluidics.ts and gated in CI by
 * src/validation/__tests__/microfluidics.test.ts.
 *
 * All numbers and figures come from live solves — rerun after solver changes:
 *
 *   npx tsx scripts/microfluidics-validation-report.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { solveTransient, validateNetwork } from "../src/core";
import type { NetworkConfig, TransientResult } from "../src/core";
import {
  rectCapillaryPressure,
  rectHydraulicDiameter,
  rectLaminarResistance,
  rectPoiseuilleNumber,
} from "../src/core/components";
import {
  GUERMONPREZ_2015,
  LEE_2012,
  OLANREWAJU_2016,
  REIS_2021,
  TAN_TAKEUCHI_2007,
  VASILAKIS_2019,
  guermonprezLadder,
  lee2012,
  olanrewaju2016,
  reis2021Flow,
  tanTakeuchi2007,
  vasilakis2019,
} from "../src/validation/microfluidics";
import { capillaryCircuit } from "../src/ui/examples";

const P0 = 101325;
const RHO = 998;
const MU = 1e-3;
const MU_G = 1.81e-5;
const G = 9.80665;
const GAMMA = 0.072;

const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)} %`;
const sci = (x: number, d = 2) => x.toExponential(d);
const relErr = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

/* ==========================================================================
 * SVG chart renderer (copied from hydraulics-validation-report.ts)
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
  const lx = m.l + 8; // top-left: the bars here grow left to right
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

const C = {
  ref: "#000000",
  blue: "#1f5fa8",
  red: "#c0392b",
  green: "#1e8449",
  orange: "#d68910",
  grey: "#7f8c8d",
};

/* ==========================================================================
 * Output
 * ========================================================================== */

const outDir = join(process.cwd(), "docs", "validation");
const figDir = join(outDir, "figures", "microfluidics");
mkdirSync(figDir, { recursive: true });
const figures: string[] = [];
function writeFig(n: number, name: string, svg: string): void {
  const file = `fig${String(n).padStart(2, "0")}-${name}.svg`;
  writeFileSync(join(figDir, file), svg);
  figures[n] = file;
  console.log(`  wrote figures/microfluidics/${file}`);
}
const fig = (n: number, caption: string) =>
  `![Figure ${n}](figures/microfluidics/${figures[n]})\n\n*Figure ${n}. ${caption}*`;

/* ==========================================================================
 * Shared capillary-network helpers (Part A)
 * ========================================================================== */

type Comp = NetworkConfig["branches"][number]["component"];

function capNetwork(
  nodes: Array<{
    id: string;
    internal?: boolean;
    p?: number;
    wet?: boolean;
  }>,
  branches: Array<{ id: string; from: string; to: string; c: Comp }>,
  dt: number,
  endTime: number,
): NetworkConfig {
  return {
    meta: { name: "microfluidics report", version: 2 },
    settings: {
      mode: "transient",
      tolerance: 1e-9,
      maxIterations: 200,
      dt,
      endTime,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.internal ? "internal" : "boundary",
      x: 0,
      y: 0,
      pressure: n.p ?? P0,
      temperature: 293,
      ...(n.internal ? { volume: 1e-12 } : {}),
      ...(n.wet !== undefined ? { initiallyWet: n.wet } : {}),
    })),
    branches: branches.map((b) => ({
      id: b.id,
      from: b.from,
      to: b.to,
      component: b.c,
    })),
  } as NetworkConfig;
}

function run(cfg: NetworkConfig): TransientResult {
  const errors = validateNetwork(cfg);
  if (errors.length) throw new Error(errors.join("; "));
  const r = solveTransient(cfg);
  if (!r.converged) throw new Error(`${cfg.meta.name}: did not converge`);
  return r;
}

const cap = (extra: Record<string, unknown>): Comp =>
  ({ type: "capillaryChannel", contactAngle: 30, ...extra }) as Comp;

/* ==========================================================================
 * A1. Rectangular-duct laminar law
 * ========================================================================== */

console.log("A1 rectangular duct");
const SHAH_LONDON: Array<[number, number]> = [
  [1, 56.908],
  [0.5, 62.192],
  [0.25, 72.932],
  [0.125, 82.34],
];
const shahRows = SHAH_LONDON.map(([a, po]) => ({
  a,
  po,
  solved: rectPoiseuilleNumber(1, a),
}));
const shahMax = Math.max(...shahRows.map((r) => relErr(r.solved, r.po)));
const poCurve: Array<[number, number]> = [];
for (let k = 0; k <= 60; k++) {
  const a = Math.pow(10, -2 + (2 * k) / 60);
  poCurve.push([a, rectPoiseuilleNumber(1, a)]);
}
// What a circular pipe at D_h would predict for a 2:1 channel.
const w21 = 100e-6;
const h21 = 50e-6;
const dh21 = rectHydraulicDiameter(w21, h21);
const pipeOverRect =
  rectLaminarResistance(w21, h21, 1, MU) / ((128 * MU) / (Math.PI * dh21 ** 4));
writeFig(
  1,
  "rect-poiseuille",
  lineChart({
    title: "Rectangular duct: laminar f·Re vs aspect ratio",
    xLabel: "aspect ratio α = h/w (log scale, 10^x)",
    yLabel: "Darcy f · Re_Dh",
    series: [
      {
        label: "OpenFLUME rectChannel (exact series)",
        pts: poCurve.map(([a, p]) => [Math.log10(a), p]),
        color: C.blue,
        mode: "line",
      },
      {
        label: "Shah &amp; London (1978) Table 41",
        pts: SHAH_LONDON.map(([a, p]) => [Math.log10(a), p]),
        color: C.ref,
        mode: "markers",
        marker: "square",
      },
      {
        label: "circular pipe (64)",
        pts: [
          [-2, 64],
          [0, 64],
        ],
        color: C.grey,
        mode: "line",
        dash: "5 4",
      },
    ],
  }),
);

/* ==========================================================================
 * A2. Washburn filling with displaced-air resistance
 * ========================================================================== */

console.log("A2 Washburn");
const WB = { w: 100e-6, h: 50e-6, L: 0.01, theta: 30 };
const wbA = WB.w * WB.h;
const wbPc = rectCapillaryPressure(WB.w, WB.h, GAMMA, 30, 30, 30);
const wbRl = rectLaminarResistance(WB.w, WB.h, 1, MU);
const wbRg = rectLaminarResistance(WB.w, WB.h, 1, MU_G);
const washburnT = (s: number, Ru = 0, dP = 0) =>
  (wbA * ((Ru + wbRg * WB.L) * s + ((wbRl - wbRg) * s * s) / 2)) / (dP + wbPc);
const classicT = (s: number) => (wbA * wbRl * s * s) / (2 * wbPc);
const wbFill = washburnT(WB.L);
const wbRun = (steps: number) =>
  run(
    capNetwork(
      [{ id: "in", wet: true }, { id: "out" }],
      [
        {
          id: "c",
          from: "in",
          to: "out",
          c: cap({ width: WB.w, height: WB.h, length: WB.L }),
        },
      ],
      wbFill / steps,
      wbFill * 1.2,
    ),
  );
const wbErrors = [5, 50, 500].map((steps) => {
  const r = wbRun(steps);
  const f = r.capillary!.branches.c.fill;
  let err = 0;
  r.times.forEach((t, i) => {
    if (f[i] > 0 && f[i] < 1)
      err = Math.max(err, Math.abs(t - washburnT(f[i] * WB.L)) / wbFill);
  });
  const arrival = r.capillary!.events.find((e) => e.kind === "nodeWetted")!;
  return { steps, err, arrival: arrival.time };
});
const wbCoarse = wbRun(20);
const wbPts = wbCoarse.times
  .map((t, i) => [t, wbCoarse.capillary!.branches.c.fill[i] * WB.L * 1e3])
  .filter(([, x]) => x > 0) as Array<[number, number]>;
const wbCurve: Array<[number, number]> = [];
const wbClassic: Array<[number, number]> = [];
for (let k = 0; k <= 80; k++) {
  const s = (k / 80) * WB.L;
  wbCurve.push([washburnT(s), s * 1e3]);
  if (classicT(s) <= wbFill * 1.2) wbClassic.push([classicT(s), s * 1e3]);
}
writeFig(
  2,
  "washburn",
  lineChart({
    title: "Capillary filling of a 100 × 50 µm channel (θ = 30°)",
    xLabel: "time [s]",
    yLabel: "meniscus position [mm]",
    legend: "bottom-right",
    series: [
      {
        label: "exact, with displaced-air resistance",
        pts: wbCurve,
        color: C.ref,
        mode: "line",
      },
      {
        label: "classic Washburn (air neglected)",
        pts: wbClassic,
        color: C.grey,
        mode: "line",
        dash: "5 4",
      },
      {
        label: "OpenFLUME, 20 time steps",
        pts: wbPts,
        color: C.blue,
        mode: "markers",
      },
    ],
  }),
);

/* ==========================================================================
 * A3. Jurin rise
 * ========================================================================== */

console.log("A3 Jurin");
const JU = { w: 500e-6, L: 0.1 };
const juPc = rectCapillaryPressure(JU.w, JU.w, GAMMA, 30, 30, 30);
const juHeq = juPc / (RHO * G);
const juRun = run(
  capNetwork(
    [{ id: "pool", wet: true }, { id: "top" }],
    [
      {
        id: "c",
        from: "pool",
        to: "top",
        c: cap({
          width: JU.w,
          height: JU.w,
          length: JU.L,
          elevationChange: JU.L,
        }),
      },
    ],
    0.05,
    120,
  ),
);
const juRise = juRun.capillary!.branches.c.fill.map((f) => f * JU.L);
const juFinal = juRise[juRise.length - 1];
let juMonotone = true;
for (let i = 1; i < juRise.length; i++)
  if (juRise[i] < juRise[i - 1] - 1e-15 || juRise[i] > juHeq * (1 + 1e-9))
    juMonotone = false;
writeFig(
  3,
  "jurin",
  lineChart({
    title: "Capillary rise in a vertical 500 µm square channel",
    xLabel: "time [s]",
    yLabel: "liquid height [mm]",
    legend: "bottom-right",
    series: [
      {
        label: "Jurin height Pcap/(ρg)",
        pts: [
          [0, juHeq * 1e3],
          [8, juHeq * 1e3],
        ],
        color: C.ref,
        mode: "line",
        dash: "5 4",
      },
      {
        label: "OpenFLUME",
        pts: juRun.times
          .map((t, i) => [t, juRise[i] * 1e3] as [number, number])
          .filter(([t]) => t <= 8),
        color: C.blue,
        mode: "line",
      },
    ],
  }),
);

/* ==========================================================================
 * A4. Flow-driven and resistance-coupled filling
 * ========================================================================== */

console.log("A4 coupling");
const SY_Q = 1e-9 / 60;
const syL = 5e-3;
const syRun = run({
  ...capNetwork(
    [
      { id: "src", wet: true },
      { id: "in", internal: true, wet: true },
      { id: "out" },
    ],
    [
      {
        id: "pump",
        from: "src",
        to: "in",
        c: { type: "flowSource", massFlow: SY_Q * RHO },
      },
      {
        id: "c",
        from: "in",
        to: "out",
        c: cap({ width: WB.w, height: WB.h, length: syL, contactAngle: 100 }),
      },
    ],
    0.02,
    1.6,
  ),
});
let syErr = 0;
syRun.times.forEach((t, i) => {
  const f = syRun.capillary!.branches.c.fill[i];
  if (f < 1) syErr = Math.max(syErr, Math.abs(f - (SY_Q * t) / (wbA * syL)));
});
const feedL = 0.02;
const feedR = rectLaminarResistance(50e-6, 20e-6, feedL, MU);
const feedDp = 500;
const feedT = washburnT(WB.L, feedR, feedDp);
const feedRun = run(
  capNetwork(
    [
      { id: "res", p: P0 + feedDp },
      { id: "J", internal: true },
      { id: "vent" },
    ],
    [
      {
        id: "feed",
        from: "res",
        to: "J",
        c: { type: "rectChannel", width: 50e-6, height: 20e-6, length: feedL },
      },
      {
        id: "c",
        from: "J",
        to: "vent",
        c: cap({ width: WB.w, height: WB.h, length: WB.L }),
      },
    ],
    feedT / 25,
    feedT * 1.1,
  ),
);
let feedErr = 0;
feedRun.times.forEach((t, i) => {
  const f = feedRun.capillary!.branches.c.fill[i];
  if (f > 0 && f < 1)
    feedErr = Math.max(
      feedErr,
      Math.abs(t - washburnT(f * WB.L, feedR, feedDp)) / feedT,
    );
});

/* A5. The shipped capillary-circuit example */
console.log("A5 capillary circuit");
const circuit = run(capillaryCircuit);
const circuitEvents = circuit.capillary!.events.filter(
  (e) => e.kind !== "released",
);

/* ==========================================================================
 * Part B — published cases
 * ========================================================================== */

console.log("B1 Vasilakis");
const vas = vasilakis2019();
console.log("B2 Tan & Takeuchi");
const tan = tanTakeuchi2007();
console.log("B3 Guermonprez");
const ladder = GUERMONPREZ_2015.cases.map((c) => ({
  ...c,
  r: guermonprezLadder(GUERMONPREZ_2015.branches, c.ratio),
}));
console.log("B4 Reis");
const reisMeasured = reis2021Flow(REIS_2021.measured.hOverL);
const reisLo = reis2021Flow(
  REIS_2021.measured.hOverL,
  REIS_2021.diameter - REIS_2021.diameterSd,
);
const reisHi = reis2021Flow(
  REIS_2021.measured.hOverL,
  REIS_2021.diameter + REIS_2021.diameterSd,
);
const reisFig2 = reis2021Flow(REIS_2021.fig2.H / REIS_2021.fig2.L);
const reisDiameterFit =
  REIS_2021.diameter *
  Math.pow(REIS_2021.measured.flow / reisMeasured.solved, 0.25);
const reisCurve = (d: number) =>
  [0.15, 0.3, 0.45, 0.6, 0.75, 0.85].map(
    (x) => [x, reis2021Flow(x, d).solved * 1e9] as [number, number],
  );
console.log("B5 Olanrewaju");
const olan = olanrewaju2016();
console.log("B6 Lee");
const leeRuns = LEE_2012.bubbles.map((v) => ({ v, r: lee2012(v) }));
const leeTol = lee2012(5, 1e-6);
const leeErr = (r: ReturnType<typeof lee2012>) => {
  let e = 0;
  let s = 0;
  r.q1.forEach((q, i) => {
    e = Math.max(e, Math.abs(q - r.reference[i]));
    s = Math.max(s, Math.abs(r.reference[i]));
  });
  return e / s;
};
const leeConv = [100, 200, 800].map((n) => ({
  n,
  err: leeErr(lee2012(5, 1e-6, n)),
}));
let leeCollapse = 0;
leeRuns[0].r.q1.forEach((q, i) => {
  leeCollapse = Math.max(
    leeCollapse,
    Math.abs(q - leeRuns[2].r.q1[i]) / leeRuns[0].r.q1[0],
  );
});

/* Figures for Part B */
writeFig(
  4,
  "ladder",
  lineChart({
    title: "20-branch ladder manifold: branch-flow distribution",
    xLabel: "branch index",
    yLabel: "fraction of total flow",
    legend: "top-left",
    series: ladder.flatMap((c, k) => [
      {
        label: `OpenFLUME R/Rb = ${c.ratio}`,
        pts: c.r.fractions.map((f, i) => [i + 1, f] as [number, number]),
        color: [C.red, C.blue, C.green][k],
        mode: "markers" as const,
        marker: (["circle", "square", "triangle"] as const)[k],
      },
      {
        label: `exact nodal solve R/Rb = ${c.ratio}`,
        pts: c.r.reference.map((f, i) => [i + 1, f] as [number, number]),
        color: [C.red, C.blue, C.green][k],
        mode: "line" as const,
      },
    ]),
  }),
);
writeFig(
  5,
  "siphon",
  lineChart({
    title: "Gravity siphon, 10 bores: flow vs head ratio",
    xLabel: "H / L",
    yLabel: "flow rate [µL/s]",
    legend: "top-left",
    series: [
      {
        label: "OpenFLUME, D_h = 204 µm",
        pts: reisCurve(REIS_2021.diameter),
        color: C.blue,
        mode: "line",
      },
      {
        label: "D_h + 13.8 µm (stated SD)",
        pts: reisCurve(REIS_2021.diameter + REIS_2021.diameterSd),
        color: C.blue,
        mode: "line",
        dash: "4 4",
      },
      {
        label: "D_h − 13.8 µm (stated SD)",
        pts: reisCurve(REIS_2021.diameter - REIS_2021.diameterSd),
        color: C.blue,
        mode: "line",
        dash: "4 4",
      },
      {
        label: "measured 3.63 ± 0.07 µL/s",
        pts: [[REIS_2021.measured.hOverL, REIS_2021.measured.flow * 1e9]],
        color: C.red,
        mode: "markers",
        marker: "square",
      },
      {
        label: "reported ≈2.5 µL/s (Fig. 2 devices)",
        pts: [[REIS_2021.fig2.H / REIS_2021.fig2.L, REIS_2021.fig2.flow * 1e9]],
        color: C.orange,
        mode: "markers",
        marker: "diamond",
      },
    ],
  }),
);
writeFig(
  6,
  "rbv-pressures",
  groupedBarChart({
    title: "Retention burst valve pressures (Olanrewaju 2016, Table 1)",
    xLabel: "valve width × height [µm]",
    yLabel: "|capillary pressure| [Pa]",
    categories: olan.rbv.map((v) => `${v.w}×${v.h}`),
    series: [
      {
        label: "paper, Table 1",
        values: olan.rbv.map((v) => -v.p),
        color: C.ref,
      },
      {
        label: "OpenFLUME, cover 89°",
        values: olan.rbv.map((v) => -v.solved),
        color: C.blue,
      },
      {
        label: "OpenFLUME, cover 95° (stated)",
        values: olan.rbv.map((v) => -v.solvedRbvTextAngle),
        color: C.orange,
      },
    ],
  }),
);
const sub = <T>(xs: T[], every: number) => xs.filter((_, i) => i % every === 0);
writeFig(
  7,
  "bubble-damping",
  lineChart({
    title: "Bubble-damped syringe step (Lee 2012 network)",
    xLabel: "t / t0,  t0 = V0·R3/P0",
    yLabel: "flow in branch R1 [µL/min]",
    legend: "bottom-right",
    series: [
      {
        label: "exact isothermal-bubble ODE",
        pts: leeRuns[1].r.scaledTime.map(
          (t, i) => [t, leeRuns[1].r.reference[i] * 6e10] as [number, number],
        ),
        color: C.ref,
        mode: "line",
      },
      ...leeRuns.map(({ v, r }, k) => ({
        label: `OpenFLUME, ${v} µL bubble`,
        pts: sub(
          r.scaledTime.map((t, i) => [t, r.q1[i] * 6e10] as [number, number]),
          41 + 13 * k,
        ),
        color: [C.red, C.blue, C.green][k],
        mode: "markers" as const,
        marker: (["circle", "square", "triangle"] as const)[k],
      })),
    ],
  }),
);

/* ==========================================================================
 * Report
 * ========================================================================== */

const vp = VASILAKIS_2019.published;
const report = `# Microfluidic Network Validation of OpenFLUME

**A validation report for OpenFLUME's microfluidic capability: the rectangular-channel laminar law, capillary-driven filling with displaced-gas resistance, capillary pumps and valves, and published microfluidic networks rebuilt from their papers — a serial-dilution cell, a hydrodynamic bead trap, a parallel manifold, a gravity siphon, a capillaric circuit's valve design and a bubble-damped syringe network.**

Generated by \`scripts/microfluidics-validation-report.ts\` — all numbers and
figures come from live solves of the current solver. The published cases are
defined once in \`src/validation/microfluidics.ts\` and gated in CI by
\`src/validation/__tests__/microfluidics.test.ts\`; the closed-form cases
mirror \`src/core/__tests__/rectChannel.test.ts\`,
\`capillaryChannel.test.ts\` and \`flowScaledTolerance.test.ts\`.

## Abstract

Microfluidic networks run at flows of nanolitres to microlitres per minute
through rectangular channels tens of micrometres deep, and are often driven by
capillarity rather than pumps. This report checks OpenFLUME in that regime in
two parts. Part A compares the \`rectChannel\` and \`capillaryChannel\`
components with exact solutions: the rectangular-duct friction constant
matches Shah & London to ${pct(shahMax, 3)}, capillary filling follows the
Washburn law with air resistance to ${sci(Math.max(...wbErrors.map((e) => e.err)))} of the fill
time at any step size, the Jurin rise is reached to ${sci(relErr(juFinal, juHeq))},
and syringe-driven and resistance-coupled filling are exact to
${sci(Math.max(syErr, feedErr))}. Part B rebuilds six published microfluidic
networks from the parameters printed in their open-access papers. OpenFLUME
reproduces the authors' COMSOL inlet pressure (${vas.inletPressureA.toFixed(1)} vs ${vp.inletPressureCOMSOL} Pa)
and design dilution ratio of a serial diluter, both trap flow ratios and the
trapping outcome of a bead-trap array, the flow distribution of a 20-branch
manifold, the measured flow of a gravity siphon within its stated diameter
uncertainty, the tabulated capillary pressures of a capillaric circuit's
valves to ${pct(Math.max(...olan.rbv.map((v) => relErr(v.solved, v.p))), 1)}, and the exact dynamics of a bubble-damped
syringe network to ${sci(Math.max(...leeRuns.map((l) => leeErr(l.r))))} — including the paper's
finding that responses for different bubble sizes collapse when time is
scaled by V·R/P. That last case exposed, and now pins, a solver defect: the
absolute Newton tolerance judged mass imbalances in kg/s, so microfluidic
compliance transients stopped iterating and froze. The stopping test now
weights mass-flow rows by the network's flow scale.

## 1. Model Summary

**Rectangular channel** (\`rectChannel\`, user manual §4.3.18). Fully
developed laminar resistance from the exact Fourier-series solution,
R = 12μL / (a³bF), F = 1 − (192a/π⁵b) Σₙ odd tanh(nπb/2a)/n⁵, with a smooth
blend to Swamee–Jain on D_h above Re 2300.

**Capillary channel** (\`capillaryChannel\`, §4.3.19). A rectangular channel
holding liquid over length s and gas over the rest:
P_from − P_to = R_liq(s)·Q + R_gas(L−s)·Q − σ·P_cap + ρgΔz·s/L, with the
Young–Laplace pressure P_cap = γ[(cos θ_top + cos θ_bottom)/h + 2cos θ_sides/w].
Fronts are integrated against a Thevenin equivalent of the surrounding
network; stop valves use the Cho et al. (2007) burst pressure; node wetting
drives trigger valves and air-trap detection.

**Flow-scaled Newton tolerance.** The Newton residual mixes mass rows [kg/s]
with momentum rows [Pa]. With an absolute bar \`tol\`, a microfluidic mass
imbalance (~10⁻¹³ kg/s) always passes, so a storage-driven step was accepted
at its warm start. Below 10⁻³ kg/s the mass-flow rows (nodal balances and
imposed-flow branches) are now weighted by 10⁻³ kg/s ÷ F, F the largest
warm-start flow (weight ≤ 10⁹), in both the stopping test and the
line-search merit. At or above 10⁻³ kg/s the weight is 1 and the solver is
bit-identical to before; of the 14 shipped examples only *Entrapped-air line*
changes, by 10⁻⁷ relative, during its at-rest phase.

## Part A — Closed-Form Verification

### A1. Rectangular-duct laminar law

| Aspect ratio α | Shah & London f·Re | OpenFLUME f·Re | error |
| -------------- | ------------------ | -------------- | ----- |
${shahRows.map((r) => `| ${r.a} | ${r.po} | ${r.solved.toFixed(3)} | ${pct(relErr(r.solved, r.po), 3)} |`).join("\n")}

The parallel-plate limit is 96. A circular pipe sized to the hydraulic
diameter of a 100 × 50 µm channel would predict
${pct(Math.abs(1 - pipeOverRect), 0)} ${pipeOverRect < 1 ? "less" : "more"} flow than the
rectangle carries — the reason the dedicated component exists.

${fig(1, "Laminar f·Re of a rectangular duct against Shah & London's tabulated values.")}

### A2. Washburn filling with displaced-air resistance

A ${WB.w * 1e6} × ${WB.h * 1e6} µm channel, ${WB.L * 1e3} mm long, θ = ${WB.theta}°,
γ = ${GAMMA} N/m, fills from a reservoir to a vent at equal pressure. With air
viscosity included, the exact front law is
r_l s²/2 + r_g(Ls − s²/2) = P_cap·t / A (r per unit length), filling in
${wbFill.toFixed(4)} s.

| Time steps per fill | max \\|t − t_exact(s)\\| / t_fill | arrival-event time [s] |
| ------------------- | ------------------------------- | ---------------------- |
${wbErrors.map((e) => `| ${e.steps} | ${sci(e.err)} | ${e.arrival.toFixed(4)} |`).join("\n")}

The meniscus ODE is integrated across each step against the network's
Thevenin equivalent, so the stiff early phase (velocity ∝ 1/s) costs nothing
in accuracy even at 5 steps per fill.

${fig(2, "Front position against the exact law with displaced-air resistance and the classic (air-free) Washburn law; markers are a 20-step OpenFLUME run.")}

### A3. Jurin rise

A vertical ${JU.w * 1e6} µm square channel, ${JU.L * 1e3} mm tall, θ = 30°.
Equilibrium height P_cap/(ρg) = ${(juHeq * 1e3).toFixed(3)} mm; OpenFLUME
settles at ${(juFinal * 1e3).toFixed(3)} mm (error ${sci(relErr(juFinal, juHeq))}),
monotonically and without overshoot: ${juMonotone ? "yes" : "NO"}.

${fig(3, "Capillary rise approaching the Jurin height.")}

### A4. Flow-driven and resistance-coupled filling

* **Syringe pump**, 1 µL/min into a hydrophobic (θ = 100°) channel: the fill
  follows s = Qt/A to ${sci(syErr)} of the channel volume, including the
  pinned entrance that the pump forces open.
* **Reservoir behind a resistive feed**, ΔP = ${feedDp} Pa through a
  50 × 20 µm, ${feedL * 1e3} mm feed channel: exact law
  (R_u + r_g L)s + (r_l − r_g)s²/2 = (ΔP + P_cap)t/A, matched to
  ${sci(feedErr)} of the fill time with 25 steps.

### A5. Sequential capillary circuit

The shipped example *Capillary circuit (stop + trigger valve)* produces the
designed event sequence (pinning at the inlet in the first step is gas
back-pressure from the faster branch):

| t [s] | event | channel | node |
| ----- | ----- | ------- | ---- |
${circuitEvents.map((e) => `| ${e.time.toFixed(4)} | ${e.kind} | ${e.branch} | ${e.node} |`).join("\n")}

## Part B — Published Microfluidic Networks

Every parameter below is printed in the cited open-access paper; the
location is given in \`src/validation/microfluidics.ts\`. Each paper's own
result type is respected: a measurement with its error bar, the authors'
model value, or a statement in the text.

### B1. Pressure- and flow-balanced serial-dilution cell (Vasilakis et al. 2019)

Five rectangular channels, 64 µm deep, from Table 1 ("COMSOL optimisation"),
two syringe inlets at 0.4 µL/min, outlets at 0 Pa.

| Quantity | OpenFLUME | Published |
| -------- | --------- | --------- |
| Inlet A pressure | ${vas.inletPressureA.toFixed(1)} Pa | 85.2 Pa (COMSOL) |
| Inlet B pressure | ${vas.inletPressureB.toFixed(1)} Pa | 85.2 Pa (COMSOL) |
| Dilution ratio DR | ${vas.ratio.toFixed(3)} | 0.67 design; measured 0.65 ± 0.02 (0.2 µL/min), 0.70 ± 0.01 (0.4 µL/min) |

The model reproduces the design, as the authors' own optimisation did. The
measurements were judged against the glucose meter's ±10 % accuracy, within
which both agree; by its own standard deviation the 0.4 µL/min measurement
sits about ${((0.7 - vas.ratio) / 0.01).toFixed(0)} σ above the design value.

### B2. Hydrodynamic bead trap (Tan & Takeuchi 2007)

A trap constriction (path 1) in parallel with a loop (path 2); beads are
trapped only if Q₁/Q₂ > 1. Dimensions from Table 1.

| Device | W₁/L₁/W₂/L₂/H [µm] | Q₁/Q₂ OpenFLUME | Q₁/Q₂ paper | Trapping predicted | Experiment |
| ------ | ------------------ | --------------- | ----------- | ------------------ | ---------- |
${tan.map((d) => `| ${d.id} | ${d.W1}/${d.L1}/${d.W2}/${d.L2}/${d.H} | ${d.ratio.toFixed(3)} | ${d.ratioPaper} | ${d.predictsTrapping ? "yes" : "no"} | ${d.trapped ? "every bead trapped" : "no bead trapped"} |`).join("\n")}

Like the paper's model, the constriction is taken as a fully developed duct
of its own short length (L₁ < W₁), so entrance losses are ignored; the
trapping outcome is nevertheless predicted correctly for both devices.

### B3. Parallel manifold flow distribution (Guermonprez et al. 2015)

A 20-branch ladder with inlet and outlet at opposite corners; only the
resistance ratio R/R_b of a manifold segment to a branch matters.

| R/R_b | first two + last two branches | spread (max − min)/Q | Paper (§IV A) |
| ----- | ----------------------------- | -------------------- | ------------- |
${ladder.map((c) => `| ${c.ratio} | ${pct(c.r.endShare, 1)} | ${pct(c.r.spread, 2)} | ${c.endShare !== undefined ? `≈ ${pct(c.endShare, 0)}` : `spread ≤ ${pct(c.maxSpread!, 0)}`} |`).join("\n")}

Every branch flow also matches an independent dense nodal solve to
${sci(Math.max(...ladder.flatMap((c) => c.r.fractions.map((f, i) => Math.abs(f - c.r.reference[i])))))}.
The paper quotes its percentages to two figures and does not state how the
manifold's end segments are counted, which this comparison cannot resolve;
the remaining 1–2 point difference is within that.

${fig(4, "Branch-flow fractions of the 20-branch ladder for three resistance ratios.")}

### B4. Gravity-driven microcapillary siphon (Reis et al. 2021)

Ten parallel bores of mean hydraulic diameter 204 ± 13.8 µm under a
hydrostatic head H over length L (water, μ = 1.002 mPa·s, ρ = 998.2 kg/m³).

| Quantity | OpenFLUME | Published |
| -------- | --------- | --------- |
| Q at H/L = 0.69, D_h = 204 µm | ${(reisMeasured.solved * 1e9).toFixed(2)} µL/s | 3.63 ± 0.07 µL/s measured |
| Q at H/L = 0.69, D_h = 204 ∓ 13.8 µm | ${(reisLo.solved * 1e9).toFixed(2)} – ${(reisHi.solved * 1e9).toFixed(2)} µL/s | (measurement inside band) |
| Q for H = 40 mm, L = 70 mm | ${(reisFig2.solved * 1e9).toFixed(2)} µL/s | ≈ 2.5 µL/s |

The solver equals Hagen–Poiseuille to ${sci(relErr(reisMeasured.solved, reisMeasured.hagenPoiseuille))}. Flow scales
with D⁴, so the stated ±6.8 % diameter spread is a ±27 % flow band; a mean
diameter of ${(reisDiameterFit * 1e6).toFixed(0)} µm (within the SD) reproduces the measurement.

${fig(5, "Siphon flow against head ratio with the diameter-uncertainty band and the two reported measurements.")}

### B5. Capillaric-circuit valve and pump pressures (Olanrewaju et al. 2016)

Retention burst valves in PDMS with a hydrophobic cover; per-wall
Young–Laplace with the receding angles printed in the paper (walls 31°,
γ = 72 mN/m).

| Valve w × h [µm] | Table 1 [Pa] | OpenFLUME, cover 89° | error | OpenFLUME, cover 95° | error |
| ---------------- | ------------ | -------------------- | ----- | -------------------- | ----- |
${olan.rbv.map((v) => `| ${v.w} × ${v.h} | ${v.p} | ${v.solved.toFixed(0)} | ${pct(relErr(v.solved, v.p), 1)} | ${v.solvedRbvTextAngle.toFixed(0)} | ${pct(relErr(v.solvedRbvTextAngle, v.p), 1)} |`).join("\n")}
| pump 200 × 100 (advancing 114°/45°) | −736 | ${olan.pump.solved.toFixed(0)} | ${pct(relErr(olan.pump.solved, olan.pump.p), 1)} | — | — |

The paper's RBV section states a 95° receding angle for the cover, but its
Table 1 is reproduced by the 89° given in its Conclusions; 95° under-predicts
every valve by 3–6 %. The full circuit's drainage sequence is not modelled:
it needs receding-meniscus draining of reservoirs, which OpenFLUME does not
yet represent, and the paper omits connector lengths.

${fig(6, "Retention burst valve pressures: paper Table 1 against OpenFLUME with both stated cover angles.")}

### B6. Bubble-damped syringe network (Lee et al. 2012)

Two syringe pumps, each holding an air bubble of V₀ = 2, 5 or 10 µL at 1 atm,
feed resistances R₁ = 0.14 and R₂ = 0.20 psi·min/µL into a junction draining
through R₃ = 0.25 psi·min/µL; Q_s1 = 1 µL/min while Q_s2 steps from 1 to
2.5 µL/min. Bubbles are isothermal (P·V = P₀V₀), as in the paper. The
reference is the network's exact ODE, integrated independently.

| Bubble | tolerance | max error vs exact ODE |
| ------ | --------- | ---------------------- |
${leeRuns.map(({ v, r }) => `| ${v} µL | 10⁻⁹ | ${sci(leeErr(r))} |`).join("\n")}
| 5 µL | 10⁻⁶ (UI default) | ${sci(leeErr(leeTol))} |

The remaining error is backward-Euler time integration: at 100 / 200 / 800
steps per t₀ it is ${leeConv.map((c) => sci(c.err)).join(" / ")} — first order. The paper
reports that responses for all bubble sizes collapse when time is scaled by
t₀ ∼ V₀R₃/P₀; in OpenFLUME the 2 µL and 10 µL responses coincide in t/t₀ to
${sci(leeCollapse)}.

Measured on the previous solver (absolute tolerance), the same 5 µL case
reached a maximum error of 1.2 % at tol = 10⁻⁹ — the flow froze at
0.959 µL/min while the exact solution continues to 0.971 µL/min, once the
remaining mass imbalance fell below 10⁻⁹ kg/s — and 37 % at the UI default
10⁻⁶, where the syringe step never propagated to branch R1 at all.
\`flowScaledTolerance.test.ts\` fails on the previous solver.

${fig(7, "Flow in branch R1 after the syringe step, in scaled time: three bubble volumes on one exact curve.")}

## Conclusions

OpenFLUME's microfluidic closures reproduce their exact solutions to solver
precision, and its network solver reproduces six published microfluidic
designs from their printed parameters — matching the authors' COMSOL and
design values, their trapping and distribution outcomes, and their
measurements within the uncertainties they state. Two limits are visible in
the published cases and documented: receding-meniscus draining (needed for
the full retention-burst-valve drainage sequence of capillaric circuits) and
entrance effects of constrictions shorter than they are wide. The cases also
exposed one solver defect in the micro-flow regime — absolute mass-row
tolerance — which is fixed and regression-tested.

## References

1. Shah, R. K., London, A. L., *Laminar Flow Forced Convection in Ducts*,
   Academic Press, 1978.
2. Bruus, H., *Theoretical Microfluidics*, Oxford University Press, 2008.
3. Washburn, E. W., "The dynamics of capillary flow," *Physical Review* 17,
   273 (1921).
4. Cho, H., Kim, H.-Y., Kang, J. Y., Kim, T. S., "How the capillary burst
   microvalve works," *J. Colloid Interface Sci.* 306, 379–385 (2007).
5. ${VASILAKIS_2019.citation}. doi:${VASILAKIS_2019.doi}
6. ${TAN_TAKEUCHI_2007.citation}. doi:${TAN_TAKEUCHI_2007.doi}
7. ${GUERMONPREZ_2015.citation}. doi:${GUERMONPREZ_2015.doi}
8. ${REIS_2021.citation}. doi:${REIS_2021.doi}
9. ${OLANREWAJU_2016.citation}. doi:${OLANREWAJU_2016.doi}
10. ${LEE_2012.citation}. doi:${LEE_2012.doi}

## Nomenclature

| Symbol | Meaning |
| ------ | ------- |
| A | channel cross-section w·h |
| D_h | hydraulic diameter 2wh/(w+h) |
| f·Re | Darcy friction factor × Reynolds number (laminar constant) |
| h, w, L | channel height, width, length |
| P_cap | capillary (Young–Laplace) pressure |
| Q | volumetric flow |
| R, R_b | hydraulic resistance (manifold segment, branch) |
| r_l, r_g | liquid / gas resistance per unit length |
| s | meniscus position (liquid length) |
| t₀ | bubble time scale V₀R₃/P₀ |
| γ | surface tension |
| θ | contact angle |
| μ, ρ | viscosity, density |
`;

writeFileSync(join(outDir, "microfluidics-report.md"), report);
console.log("\nwrote docs/validation/microfluidics-report.md");
