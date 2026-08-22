/**
 * real-fluid-performance.ts — regenerates docs/real-fluid-performance.md
 * from live solves on the current solver architecture.
 *
 *   npx tsx scripts/real-fluid-performance.ts
 *
 * Exact-attribution profiling (src/core/perf.ts): cumulative timers + call
 * counters around CoolProp entry points, residual evaluation, Jacobian
 * builds, and the dense linear solve. Not a sampling profiler.
 *
 * Cases:
 *   1. Two-phase LN₂ chilldown — N=4 audit line, truncated horizon
 *      (keeps the FD A/B tractable; network matches the diagnostics audit).
 *   2. N₂O cavitating venturi — shipped 9-node one-step transient.
 *   3. Real-fluid transonic N₂ CD nozzle — kineticEnergy + default
 *      limited-upwind faces (the architecture the previous report missed).
 *
 * Absolute wall times are machine- and load-dependent. The durable
 * quantities are attribution percentages, hybrid/FD speedup ratios, and
 * property-call counts.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  initRealFluids,
  solveSteady,
  solveTransient,
  setPerfEnabled,
  getPerfSnapshot,
  RealFluid,
} from "../src/core";
import type {
  NetworkConfig,
  PerfSnapshot,
  SteadyResult,
  TransientResult,
} from "../src/core";
import { getCoolProp } from "../src/core/fluids/coolprop";
import {
  buildChilldownTwoPhase,
  nitrousOxideCavitatingVenturi,
} from "../src/ui/examples";

/* ==========================================================================
 * Cases
 * ========================================================================== */

/** Audit-network geometry (N=4, 60.96 m, 0.5169 MPa), first 75 s / 5 steps
 *  of the 300 s diagnostics run. Long enough for two-phase residual traffic;
 *  short enough that jacobian:'fd' finishes in a few minutes. */
const CHILLDOWN: NetworkConfig = buildChilldownTwoPhase({
  segments: 4,
  length: 60.96,
  drivingPressure: 0.5169e6,
  outletPressure: 101325,
  dt: 15,
  endTime: 75,
  timeStepping: "fixed",
});

/** The FULL 300 s diagnostics horizon.  Unlike the 75 s case — whose whole
 *  trajectory fits in the warm value caches after the warmup solve — this
 *  one visits ~25k fresh (P, h) keys per solve, so its property share is
 *  representative of long-horizon transients rather than flattered by cache
 *  reuse. */
const CHILLDOWN_300: NetworkConfig = buildChilldownTwoPhase({
  segments: 4,
  length: 60.96,
  drivingPressure: 0.5169e6,
  outletPressure: 101325,
  dt: 15,
  endTime: 300,
  timeStepping: "fixed",
});

const VENTURI: NetworkConfig = nitrousOxideCavitatingVenturi;

/* Transonic N₂ CD nozzle — mirrors src/core/__tests__/realFluidTransonic.test.ts
 * (chamber 5 bar / 300 K, 8+10 throat-clustered stations, imposed f = 0.01). */

const GAMMA = 1.4;
const R_GAS = 8.314462618 / 0.0280134;
const P0 = 5e5;
const T0 = 300;
const FRICTION_FACTOR = 0.01;
const D_CH = 0.08;
const D_TH = 0.04;
const D_EX = 0.06;
const L_BARREL = 0.05;
const CONV_ANG = (30 * Math.PI) / 180;
const DIV_ANG = (15 * Math.PI) / 180;
const Z_TH = L_BARREL + (D_CH - D_TH) / 2 / Math.tan(CONV_ANG);
const Z_END = Z_TH + (D_EX - D_TH) / 2 / Math.tan(DIV_ANG);
const areaOf = (d: number) => (Math.PI / 4) * d * d;
const A_STAR = areaOf(D_TH);
function contourD(z: number): number {
  if (z <= L_BARREL) return D_CH;
  if (z <= Z_TH) return D_CH - 2 * Math.tan(CONV_ANG) * (z - L_BARREL);
  return D_TH + 2 * Math.tan(DIV_ANG) * (z - Z_TH);
}
function areaRatioFromMach(M: number): number {
  const t = 1 + ((GAMMA - 1) / 2) * M * M;
  return (1 / M) * (t / ((GAMMA + 1) / 2)) ** ((GAMMA + 1) / (2 * (GAMMA - 1)));
}
function machFromAreaRatio(ar: number, supersonic: boolean): number {
  if (ar <= 1) return 1;
  let lo = supersonic ? 1 : 1e-6;
  let hi = supersonic ? 60 : 1;
  for (let k = 0; k < 200; k++) {
    const mid = 0.5 * (lo + hi);
    const wide = areaRatioFromMach(mid) > ar;
    if (supersonic === wide) hi = mid;
    else lo = mid;
  }
  return 0.5 * (lo + hi);
}
const MDOT_CHOKED =
  A_STAR *
  P0 *
  Math.sqrt(GAMMA / (R_GAS * T0)) *
  (2 / (GAMMA + 1)) ** ((GAMMA + 1) / (2 * (GAMMA - 1)));
const M_EXIT = machFromAreaRatio(areaOf(D_EX) / A_STAR, true);
const EXIT_STAG = 1 + ((GAMMA - 1) / 2) * M_EXIT * M_EXIT;
const P_EXIT = P0 * EXIT_STAG ** (-GAMMA / (GAMMA - 1));
const T_EXIT = T0 / EXIT_STAG;
const N_BARREL = 1;
const N_CONV = 8;
const N_DIV = 10;
function stationZ(): number[] {
  const xs: number[] = [];
  for (let i = 0; i <= N_BARREL; i++) xs.push((L_BARREL * i) / N_BARREL);
  for (let i = 1; i <= N_CONV; i++) {
    const s = i / N_CONV;
    xs.push(L_BARREL + (Z_TH - L_BARREL) * (1 - (1 - s) ** 2));
  }
  for (let i = 1; i <= N_DIV; i++) {
    const s = i / N_DIV;
    xs.push(Z_TH + (Z_END - Z_TH) * s ** 2);
  }
  return xs;
}
const ZS = stationZ();
const stationId = (i: number) =>
  i === 0 ? "inlet" : i === ZS.length - 1 ? "exhaust" : `st${i}`;

function buildTransonicNozzle(): NetworkConfig {
  const n = ZS.length;
  const nodes: NetworkConfig["nodes"] = ZS.map((z, i) => {
    const isIn = i === 0;
    const isOut = i === n - 1;
    const s = i / (n - 1);
    return {
      id: stationId(i),
      type: isIn || isOut ? ("boundary" as const) : ("internal" as const),
      x: i * 100,
      y: 0,
      pressure: isIn ? P0 : isOut ? P_EXIT : P0 + s * (P_EXIT - P0),
      temperature: isIn ? T0 : isOut ? T_EXIT : T0 + s * (T_EXIT - T0),
    };
  });
  const branches: NetworkConfig["branches"] = [];
  for (let i = 1; i < n; i++) {
    const dIn = contourD(ZS[i - 1]);
    const dOut = contourD(ZS[i]);
    branches.push({
      id: `seg${i}`,
      from: stationId(i - 1),
      to: stationId(i),
      initialMdot: MDOT_CHOKED,
      component: {
        type: "pipe",
        length: Math.max(ZS[i] - ZS[i - 1], 1e-4),
        diameter: dIn,
        roughness: 1e-6,
        frictionFactor: FRICTION_FACTOR,
        ...(Math.abs(dOut - dIn) > 1e-12 ? { diameterOut: dOut } : {}),
      },
    });
  }
  return {
    meta: { name: "n2 transonic nozzle", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-6,
      maxIterations: 400,
      kineticEnergy: true,
      momentumFlux: true,
    },
    fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
    nodes,
    branches,
  };
}

const TRANSONIC = buildTransonicNozzle();

/* ==========================================================================
 * Measurement helpers
 * ========================================================================== */

function withJacobian(
  cfg: NetworkConfig,
  jacobian: "hybrid" | "fd",
): NetworkConfig {
  return {
    ...cfg,
    settings: { ...cfg.settings, jacobian },
  };
}

function solve(cfg: NetworkConfig): SteadyResult | TransientResult {
  return cfg.settings.mode === "transient"
    ? solveTransient(cfg)
    : solveSteady(cfg);
}

interface TimedSolve {
  wallMs: number;
  perf: PerfSnapshot;
  result: SteadyResult | TransientResult;
}

function timedSolve(cfg: NetworkConfig): TimedSolve {
  setPerfEnabled(true);
  const t0 = performance.now();
  const result = solve(cfg);
  const wallMs = performance.now() - t0;
  const perf = getPerfSnapshot();
  setPerfEnabled(false);
  return { wallMs, perf, result };
}

function propertyShare(s: TimedSolve): number {
  return s.wallMs > 0 ? s.perf.propertyMs / s.wallMs : 0;
}

function denseShare(s: TimedSolve): number {
  return s.wallMs > 0 ? s.perf.denseSolveMs / s.wallMs : 0;
}

function jacResidualShare(s: TimedSolve): number {
  return s.perf.residualCalls > 0
    ? s.perf.residualCallsInJacobian / s.perf.residualCalls
    : 0;
}

/** Exact-key ceiling on any (fluid, P, h) memoization within one solve. */
function exactKeyCeiling(s: TimedSolve): number {
  const n = s.perf.propertyCalls.statePH;
  if (n === 0) return 0;
  return 1 - s.perf.uniqueStatePH / n;
}

/** Realized hit rate of the shipped bounded LRU value caches. */
function realizedHitRate(
  s: TimedSolve,
  kind: "statePH" | "derivativesPH" | "internalEnergyPH",
): number {
  const n = s.perf.propertyCalls[kind];
  if (n === 0) return 0;
  return s.perf.cacheHits[kind] / n;
}

function totalPropertyCalls(p: PerfSnapshot): number {
  return Object.values(p.propertyCalls).reduce((a, b) => a + b, 0);
}

function fmtPct(x: number, digits = 1): string {
  return `${(100 * x).toFixed(digits)} %`;
}

function fmtX(x: number, digits = 2): string {
  return `${x.toFixed(digits)}×`;
}

function fmtN(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms.toFixed(0)} ms`;
}

function relDiff(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-30);
  return Math.abs(a - b) / denom;
}

function last<T>(arr: T[]): T {
  return arr[arr.length - 1]!;
}

function maxWallRel(
  a: TransientResult,
  b: TransientResult,
): { id: string; rel: number; dK: number } {
  let worst = { id: "?", rel: 0, dK: 0 };
  for (const id of Object.keys(a.solidNodes ?? {})) {
    const ta = last(a.solidNodes![id].temperature);
    const tb = last(b.solidNodes![id].temperature);
    const dK = Math.abs(ta - tb);
    const rel = relDiff(ta, tb);
    if (rel >= worst.rel) worst = { id, rel, dK };
  }
  return worst;
}

/* ==========================================================================
 * Microbenchmarks (after WASM is warm)
 * ========================================================================== */

interface Microbench {
  wasmCompileMs: number;
  flashStateMs: number;
  flashPropsSIMs: number;
  propsSIOverhead: number;
  derivMs: number;
  rhomassMs: number;
  derivOverRhomass: number;
}

const MICRO_ITERS = 400;

function runMicrobench(wasmCompileMs: number): Microbench {
  const cp = getCoolProp();
  const fluid = "Nitrogen";
  const P = 2e6;
  const h = new RealFluid(fluid).enthalpyPT(P, 100); // subcooled liquid

  // Warm the cached AbstractState.
  const state = cp.factory("HEOS", fluid);
  state.update(cp.input_pairs.HmassP_INPUTS, h, P);
  state.rhomass();

  const tFlash0 = performance.now();
  for (let i = 0; i < MICRO_ITERS; i++) {
    state.update(cp.input_pairs.HmassP_INPUTS, h, P);
    state.rhomass();
  }
  const flashStateMs = (performance.now() - tFlash0) / MICRO_ITERS;

  const tPs0 = performance.now();
  for (let i = 0; i < MICRO_ITERS; i++) {
    cp.PropsSI("D", "P", P, "HMASS", h, fluid);
  }
  const flashPropsSIMs = (performance.now() - tPs0) / MICRO_ITERS;

  const { iDmass, iP, iHmass } = cp.parameters;
  state.update(cp.input_pairs.HmassP_INPUTS, h, P);
  const tDer0 = performance.now();
  for (let i = 0; i < MICRO_ITERS; i++) {
    state.first_partial_deriv(iDmass, iP, iHmass);
  }
  const derivMs = (performance.now() - tDer0) / MICRO_ITERS;

  const tRho0 = performance.now();
  for (let i = 0; i < MICRO_ITERS; i++) {
    state.rhomass();
  }
  const rhomassMs = (performance.now() - tRho0) / MICRO_ITERS;

  return {
    wasmCompileMs,
    flashStateMs,
    flashPropsSIMs,
    propsSIOverhead: flashPropsSIMs / flashStateMs,
    derivMs,
    rhomassMs,
    derivOverRhomass: derivMs / Math.max(rhomassMs, 1e-12),
  };
}

/* ==========================================================================
 * Case runner
 * ========================================================================== */

interface CaseStudy {
  name: string;
  blurb: string;
  hybrid: TimedSolve;
  fd: TimedSolve;
  wallSpeedup: number;
  callSpeedup: number;
  agreement: string;
}

function log(msg: string): void {
  console.log(msg);
}

function runCase(
  name: string,
  blurb: string,
  cfg: NetworkConfig,
  agree: (h: TimedSolve, f: TimedSolve) => string,
): CaseStudy {
  log(`\n— ${name}: warmup hybrid —`);
  solve(withJacobian(cfg, "hybrid"));

  log(`— ${name}: timed hybrid —`);
  const hybrid = timedSolve(withJacobian(cfg, "hybrid"));
  log(
    `   wall ${fmtMs(hybrid.wallMs)}, property ${fmtPct(propertyShare(hybrid))}, ` +
      `calls ${fmtN(totalPropertyCalls(hybrid.perf))}, ` +
      `LRU hits ${fmtPct(realizedHitRate(hybrid, "statePH"))} statePH / ` +
      `${fmtPct(realizedHitRate(hybrid, "derivativesPH"))} derivs, ` +
      `converged=${hybrid.result.converged}`,
  );

  log(`— ${name}: warmup fd —`);
  solve(withJacobian(cfg, "fd"));

  log(`— ${name}: timed fd —`);
  const fd = timedSolve(withJacobian(cfg, "fd"));
  log(
    `   wall ${fmtMs(fd.wallMs)}, property ${fmtPct(propertyShare(fd))}, ` +
      `calls ${fmtN(totalPropertyCalls(fd.perf))}, converged=${fd.result.converged}`,
  );

  const wallSpeedup = fd.wallMs / Math.max(hybrid.wallMs, 1e-9);
  const callSpeedup =
    totalPropertyCalls(fd.perf) / Math.max(totalPropertyCalls(hybrid.perf), 1);
  const agreement = agree(hybrid, fd);
  log(`   speedup ${fmtX(wallSpeedup)} wall / ${fmtX(callSpeedup)} calls`);
  log(`   ${agreement}`);

  return {
    name,
    blurb,
    hybrid,
    fd,
    wallSpeedup,
    callSpeedup,
    agreement,
  };
}

function agreeChilldown(h: TimedSolve, f: TimedSolve): string {
  const ht = h.result as TransientResult;
  const ft = f.result as TransientResult;
  const w = maxWallRel(ht, ft);
  const tH = last(ht.times);
  const tF = last(ft.times);
  return (
    `final time ${tH} s vs ${tF} s; worst wall ΔT ${w.dK.toExponential(2)} K ` +
    `on ${w.id} (${fmtPct(w.rel, 3)} relative)`
  );
}

function agreeVenturi(h: TimedSolve, f: TimedSolve): string {
  const ht = h.result as TransientResult;
  const ft = f.result as TransientResult;
  const pH = last(ht.nodes.throat.pressure);
  const pF = last(ft.nodes.throat.pressure);
  const mH = last(Object.values(ht.branches)[0]!.mdot);
  const mF = last(Object.values(ft.branches)[0]!.mdot);
  return (
    `throat P relative ${relDiff(pH, pF).toExponential(2)}, ` +
    `mdot relative ${relDiff(mH, mF).toExponential(2)}`
  );
}

function agreeTransonic(h: TimedSolve, f: TimedSolve): string {
  const hs = h.result as SteadyResult;
  const fs = f.result as SteadyResult;
  const mH = hs.branches["seg1"].mdot;
  const mF = fs.branches["seg1"].mdot;
  return `mdot relative ${relDiff(mH, mF).toExponential(2)}`;
}

/* ==========================================================================
 * Report
 * ========================================================================== */

function caseRow(c: CaseStudy): string {
  const ph = propertyShare(c.hybrid);
  const rest = 1 - ph;
  const dense = denseShare(c.hybrid);
  const jacR = jacResidualShare(c.hybrid);
  const jacRfd = jacResidualShare(c.fd);
  return [
    `| ${c.name} | ${fmtMs(c.hybrid.wallMs)} | ${fmtPct(ph)} | ${fmtPct(rest)} | ${fmtPct(dense)} | ${fmtN(c.hybrid.perf.propertyCalls.statePH)} / ${fmtN(c.hybrid.perf.propertyCalls.derivativesPH)} | ${fmtPct(jacR)} | ${fmtX(c.wallSpeedup)} / ${fmtX(c.callSpeedup)} | ${fmtPct(jacRfd)} |`,
  ].join("\n");
}

function render(micro: Microbench, cases: CaseStudy[]): string {
  const shares = cases.map((c) => propertyShare(c.hybrid));
  const minShare = Math.min(...shares);
  const maxShare = Math.max(...shares);
  const restMax = 1 - minShare;
  const restMin = 1 - maxShare;
  // Amdahl: solver-side-only speedup S→∞ leaves T' = T_prop, so max
  // speedup is 1 / f_prop. Higher CoolProp share ⇒ tighter ceiling.
  const amdahl = (fProp: number) => 1 / Math.max(fProp, 1e-9);

  const speedups = cases.map((c) => c.wallSpeedup);
  const callSpeedups = cases.map((c) => c.callSpeedup);
  const minSp = Math.min(...speedups);
  const maxSp = Math.max(...speedups);
  const minCSp = Math.min(...callSpeedups);
  const maxCSp = Math.max(...callSpeedups);

  const ceilings = cases.map((c) => exactKeyCeiling(c.hybrid));
  const minCeil = Math.min(...ceilings);
  const maxCeil = Math.max(...ceilings);
  const stateHits = cases.map((c) => realizedHitRate(c.hybrid, "statePH"));
  const minStateHit = Math.min(...stateHits);
  const maxStateHit = Math.max(...stateHits);
  const derivHits = cases.map((c) =>
    realizedHitRate(c.hybrid, "derivativesPH"),
  );
  const minDerivHit = Math.min(...derivHits);
  const maxDerivHit = Math.max(...derivHits);

  const fdShares = cases.map((c) => propertyShare(c.fd));
  const minFdShare = Math.min(...fdShares);
  const maxFdShare = Math.max(...fdShares);
  const derivOnFlash = micro.derivMs / micro.flashStateMs;

  const transonic = cases.find((c) => c.name.includes("transonic"))!;
  const chilldown = cases.find((c) => c.name.includes("two-phase chilldown"))!;
  const chilldown300 = cases.find((c) => c.name.includes("300"))!;
  const venturi = cases.find((c) => c.name.includes("venturi"))!;

  const rangePct = (lo: number, hi: number) => {
    const a = Math.min(lo, hi);
    const b = Math.max(lo, hi);
    return a === b ? fmtPct(a) : `${fmtPct(a)}–${fmtPct(b)}`;
  };
  const denseHybrid = cases.map((c) => denseShare(c.hybrid));
  const jacFd = cases.map((c) => jacResidualShare(c.fd));
  const jacHy = cases.map((c) => jacResidualShare(c.hybrid));

  return `# Real-fluid performance

Why the solver uses \`coolprop-wasm\`, where the time goes on real-fluid
solves with the current architecture, and how the analytic real-fluid
Jacobian works.

Regenerate after solver or CoolProp changes:

\`\`\`
npx tsx scripts/real-fluid-performance.ts
\`\`\`

## Backend decision

The project uses \`coolprop-wasm\` because it is MIT-licensed, supports the
required cryogenic and propulsion fluids, exposes saturation and derivative
APIs, and runs in both Node tests and browser workers. Lighter alternatives
reviewed during initial development were either water-only, unmaintained,
license-incompatible, or substantially slower. The WASM payload is lazy-loaded
only for real-fluid models.

**Timing caveat:** absolute wall times are machine- and load-dependent
(identical solves have been observed to differ by up to ~1.7× across
machines/loads with the same code and config). Hybrid-vs-FD *wall* speedups
move with that noise; property-call counts and their ratios repeat exactly.
Numbers below were measured on one machine; re-run the script to refresh them.

## 1. Performance profile

Exact-attribution profiling (\`src/core/perf.ts\`: cumulative accumulators +
call counters, not a sampling profiler) on four current-architecture
real-fluid solves:

1. **Two-phase LN₂ chilldown** — N=4 audit line (60.96 m, 0.5169 MPa saturated
   inlet), first 75 s at dt = 15 s. No \`kineticEnergy\`. This is the
   diagnostics-audit network with a truncated horizon so the FD Jacobian A/B
   stays tractable.  With warm value caches its whole trajectory is
   cache-resident, so its property share is a WARM-CACHE floor, not a
   long-horizon estimate — that is what case 2 is for.
2. **LN₂ chilldown, full 300 s horizon** — the same network run to the full
   diagnostics horizon.  Each solve visits ~25k fresh \`(P, h)\` keys, so this
   case shows the property share long transients actually pay (first-visit
   flashes; the caches absorb only within-solve reuse).
3. **N₂O cavitating venturi** — shipped 9-node one-step transient (area-change cascade, throat seeded on the liquid-side dome edge). No \`kineticEnergy\`. Area-change components are dual-capable, so the hybrid Jacobian has no FD patches on this network.
4. **Real-fluid transonic N₂ CD nozzle** — CoolProp nitrogen at 5 bar / 300 K,
   \`kineticEnergy\` + default limited-upwind momentum faces, coupled
   \`[P, ṁ, h]\` system.

| Case | hybrid wall | property | other | dense solve | statePH / derivativesPH | scalar R evals in J (hybrid) | hybrid vs FD wall / calls | scalar R evals in J (FD) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${cases.map(caseRow).join("\n")}

Property evaluation is ${rangePct(minShare, maxShare)} of hybrid wall (highest on the 300 s chilldown, whose ~25k first-visit keys must each be flashed once; lowest on the short cases whose trajectories are fully cache-resident after warmup). The bounded value caches (§5, item 2) absorb repeated exact-key traffic — realized hit rates equal the within-solve exact-key ceiling, so the remaining property cost is genuine first-visit flash work, not cache misses that a bigger cache could recover. Residual assembly, dense solves, Jacobian bookkeeping, state cloning, upwind-face reconstruction, and transient stepping share the remaining ${rangePct(restMin, restMax)}. Dense Gaussian elimination alone is ${rangePct(Math.min(...denseHybrid), Math.max(...denseHybrid))}. On the FD Jacobian path the same cases spend ${rangePct(minFdShare, maxFdShare)} of wall in property evaluation: the O(columns) residual sweep evaluates at perturbed states whose exact keys are new, so the value caches cannot absorb it and CoolProp remains the dominant cost there.

Consequences, scoped to these cases:

- The Amdahl ceiling on any solver-side optimization that leaves CoolProp untouched is ${fmtX(amdahl(maxShare))}–${fmtX(amdahl(minShare))} on the hybrid path and ${fmtX(amdahl(maxFdShare))}–${fmtX(amdahl(minFdShare))} on the FD path. Short warm-cache solves are solver-side-majority (residual assembly, cloning, bookkeeping); the long-horizon chilldown is still property-majority because every fresh Newton iterate pays first-visit flashes. CoolProp also still dominates the FD path and any cold-cache first solve.
- Scalar residual evaluations (not dual-number Jacobian columns) that run inside Jacobian builds: ${rangePct(Math.min(...jacFd), Math.max(...jacFd))} on the FD path (one residual per column plus step-control extras, mostly at states the solve has already visited). The hybrid path drops that share to ${rangePct(Math.min(...jacHy), Math.max(...jacHy))}, leaving only FD patches on non-differentiable pieces; each hybrid build is O(nodes) property calls plus dual arithmetic rather than O(nodes × columns) residual re-evaluations.
- Coupled \`[P, ṁ, h]\` systems (transonic, any \`kineticEnergy\` real-fluid solve) have more Newton columns than the enthalpy-segregated chilldown, so the FD Jacobian's O(columns) residual sweep is correspondingly more expensive. That is why the transonic hybrid/FD property-call ratio sits at the high end of the range in §4.

## 2. Analytic derivative APIs

The \`coolprop-wasm@^6.6.0\` \`AbstractState\` exposes \`first_partial_deriv\`,
\`second_partial_deriv\`, \`first_saturation_deriv\`,
\`second_saturation_deriv\`, \`first_two_phase_deriv\`,
\`second_two_phase_deriv\`.

- **Embind calling convention:** the parameter arguments must be the
  \`cp.parameters.\`\\* EnumValue OBJECTS, NOT raw \`.value\` numbers. Raw
  numbers silently coerce to parameter key 0 and the call throws
  \`Unable to match the key [0] in get_parameter_information\`.
- \`PropsSI("D", "P", P, "HMASS", h, …)\` returns the same density as \`update(HmassP) + rhomass()\` on a cached \`AbstractState\`, but a full PropsSI round trip costs ${fmtX(micro.propsSIOverhead)} more than the cached-state flash (${micro.flashPropsSIMs.toExponential(2)} ms vs ${micro.flashStateMs.toExponential(2)} ms per call, Nitrogen 2 MPa subcooled). Use the cached-state interface on hot paths, and keep PropsSI off them.
- On an already-updated state a derivative call (${micro.derivMs.toExponential(2)} ms) costs ${fmtX(micro.derivOverRhomass, 1)} a plain \`rhomass()\` (${micro.rhomassMs.toExponential(2)} ms) and ${fmtPct(derivOnFlash)} of a full HmassP flash. Adding the ρ partials to a flash is a small increment on top of the flash itself.
- The first CoolProp call of a fresh process pays the WASM compile (${fmtMs(micro.wasmCompileMs)} here), which is visible as a fixed per-solve overhead in short transients.
- Single-phase / supercritical analytic partials validate against central
  finite differences of \`statePH\` to 1e-12…1e-7 relative for Nitrogen,
  NitrousOxide, Water, and Hydrogen (\`src/core/__tests__/propertyDerivatives.test.ts\`).

## 3. Two-phase derivative semantics

CoolProp's in-dome \`first_partial_deriv\` uses a different two-phase
equilibrium convention and does not reproduce the derivatives of the
solver's HEM mixture density (it is off by a factor of ~3.7 at x=0.5 for
N₂). Also, \`first_two_phase_deriv(D,H|P)\` is unsupported for these input
pairs.

The correct in-dome partials are assembled from \`first_saturation_deriv\`
on the Q=0 / Q=1 states plus analytic differentiation of the solver's own
HEM mixture rules (x = (h−h_f)/(h_g−h_f), 1/ρ = x/ρ_g + (1−x)/ρ_f,
T = Tsat(P)). These match central finite differences of \`statePH\` itself
to ~1e-11 relative. The saturation derivatives ride the same cached
sat-props path the solver already pays for, so in-dome analytic partials
are essentially free. Derivation and implementation are in \`twoPhaseDerivs\`
in \`src/core/fluids/realFluid.ts\`.

ρ(P, h) and T(P, h) have genuine kinks at the saturation boundaries, so the
derivative is discontinuous there. The derivative path must region-branch
exactly like \`statePH\` and adopt a one-sided (dome-side) subgradient
convention exactly at h = h_f / h_g. See the \`derivativesPH\` doc comment.

## 4. Analytic Jacobian

\`settings.jacobian: 'hybrid'\` (the default) builds the real-fluid Jacobian
analytically: one \`statePH\` + one \`derivativesPH\` per node per build
(O(nodes) property calls instead of O(nodes × columns)), with FD patches
only on the entries touching non-differentiable pieces. Measured against
\`jacobian: 'fd'\` on the four cases above, the analytic path uses
**${fmtX(minCSp)}–${fmtX(maxCSp)} fewer property calls** (this ratio repeats
across runs) and converges to the same trajectories — exactly on the short
cases; on the 300 s horizon the two Jacobian schemes take slightly different
Newton paths through the moving chilldown front and the wall traces differ
by a sub-percent front-timing offset (below). Wall-clock was also
faster on this machine (${fmtX(minSp)}–${fmtX(maxSp)}; load-dependent — see
the timing caveat). The transonic call-count ratio sits at the high end
because the coupled \`[P, ṁ, h]\` unknown vector is longer, so each FD
Jacobian build re-evaluates the residual once per extra enthalpy column:

- ${chilldown.agreement}
- 300 s horizon: ${chilldown300.agreement}
- ${venturi.agreement}
- ${transonic.agreement}

Entry-by-entry Jacobian agreement is permanently guarded by
\`src/core/__tests__/analyticJacobian.test.ts\`. Property-level derivative
accuracy is guarded by \`src/core/__tests__/propertyDerivatives.test.ts\`.

Momentum-row ∂/∂h entries use a frozen-μ convention (\`mu.d ≡ 0\` in the
dual state path: this coolprop-wasm build rejects analytic μ partials). At
subcooled-liquid states the dropped μ term can dominate the true entry
through a near-cancellation of the turbulent-friction ∂ρ/∂h and ∂μ/∂h
terms. Harmless where the momentum rows sit at the noise floor; see
[\`docs/solver-convergence.md\`](solver-convergence.md) §4.

## 5. Performance strategy

1. **Analytic real-fluid Jacobian** is the default. It removed the majority
   of residual evaluations that existed only to build FD columns, and it
   removes FD-noise convergence failures at dome edges. Set
   \`settings.jacobian: 'fd'\` only for debugging or comparison.
2. **Exact-key value caching is bounded and fused.** One bounded cache of
   per-key entries (8192 exact \`(fluid, P, h)\` keys,
   \`src/core/fluids/realFluid.ts\`) serves \`statePH\`, \`internalEnergyPH\`,
   and \`derivativesPH\` together: a \`statePH\` miss also computes u (a free
   \`umass()\` read on its own flash) and — single-phase / supercritical —
   the analytic partials eagerly, so the other two calls at the same key
   never re-flash.  \`derivativesPH\` branch-locks to the entry's
   \`statePH\` phase verdict.  Realized hit rates on these hybrid solves:
   ${rangePct(minStateHit, maxStateHit)} of \`statePH\` calls and
   ${rangePct(minDerivHit, maxDerivHit)} of \`derivativesPH\` calls
   (within-solve exact-key ceiling ${rangePct(minCeil, maxCeil)}; warm
   caches can exceed it).  Supporting structure, same file:
   - **Region-test order:** with satProps cached at the exact P the
     inclusive h ∈ [h_f, h_g] test is free; otherwise the HmassP flash runs
     FIRST and CoolProp's \`phase()\` verdict short-circuits clearly
     single-phase states (1 flash instead of 2 PQ saturation solves + 1
     flash).  Two-phase/ambiguous verdicts fall back to getSatProps + the
     inclusive test, so the dome-edge subgradient convention is unchanged.
   - **getSatProps also reads the saturation derivatives** while the
     Q=0 / Q=1 states are positioned (~1 µs each), so getSatDerivs never
     re-runs the two PQ saturation solves.
   - **GenCacheMap** (two-generation, bulk-evicting): the LruMap
     delete+re-insert recency refresh measured ~14 % of solver wall at these
     hit volumes; a young-generation hit is now a single \`Map.get\`.
   The bound is mandatory: keys are exact IEEE doubles, and an UNBOUNDED map
   grows without bound on long transients (the 2026-08-07 Darr–Hartwig
   OOM). Caching CoolProp \`AbstractState\` objects remains forbidden either
   way: a corrupted N₂O state must be replaceable with \`getFreshState\`.
   Eviction only discards a value that is recomputed bit-identically on the
   next miss, so results are exact while the heap stays bounded.
3. **Do not port the solver to another language to make real-fluid solves
   fast.** Historically this was an Amdahl statement (CoolProp WASM was
   84 %–95 % of hybrid wall, so solver-side rewrites were capped at
   1.05×–1.18×). The item 2 caches changed the profile shape (solver-side
   share is now ${rangePct(restMin, restMax)}), but the conclusion stands:
   absolute walls are
   ${fmtMs(Math.min(...cases.map((c) => c.hybrid.wallMs)))}–${fmtMs(Math.max(...cases.map((c) => c.hybrid.wallMs)))}
   on these cases (${fmtMs(chilldown300.hybrid.wallMs)} for the FULL 300 s
   chilldown horizon), on long horizons the dominant cost is still
   first-visit CoolProp flashes that a port would not touch, the solver-side
   remainder is spread across residual assembly / cloning / bookkeeping with
   no single compiled-code-shaped hotspot, and a port would forfeit the
   browser-worker deployment. Revisit only with a profile of a real workload
   that is still too slow.
4. **Keep PropsSI off hot paths.** It incurs a ${fmtX(micro.propsSIOverhead)}
   per-call overhead vs the cached \`AbstractState\` interface (see §2).

## 6. Future work

1. **Evaluate a native CoolProp binding instead of WASM.** Measure the
   WASM-vs-native delta on HEOS flashes (available from Node without
   porting the solver) before entertaining any port decision. The hybrid
   ceiling for ANY faster property backend is
   ${fmtX(1 / Math.max(1 - minShare, 1e-9))}–${fmtX(1 / Math.max(1 - maxShare, 1e-9))}
   on these cases (highest on the long-horizon chilldown, whose first-visit
   flashes the value caches cannot absorb); FD debugging runs, cold-cache
   first solves, and the WASM compile itself would also benefit. This tree
   still has no native binding, so that delta was not re-measured here.
2. **Avoid dense-solve micro-optimization.** Dense elimination is ${rangePct(Math.min(...denseHybrid), Math.max(...denseHybrid))} of hybrid wall. On warm short solves residual assembly, cloning, and dual arithmetic are the largest share; on long horizons first-visit flashes still lead — either way the dense solve is noise. Guide any future solver-side optimization with a fresh CPU profile.
`;
}

/* ==========================================================================
 * Main
 * ========================================================================== */

async function main(): Promise<void> {
  log("init CoolProp WASM…");
  const tInit = performance.now();
  await initRealFluids();
  const n2 = new RealFluid("Nitrogen");
  n2.statePH(1e5, n2.enthalpyPT(1e5, 300));
  const wasmCompileMs = performance.now() - tInit;
  log(`WASM compile + first flash: ${fmtMs(wasmCompileMs)}`);

  log("microbenchmarks…");
  const micro = runMicrobench(wasmCompileMs);
  log(
    `  PropsSI / AbstractState flash = ${fmtX(micro.propsSIOverhead)} ` +
      `(${micro.flashPropsSIMs.toExponential(2)} vs ${micro.flashStateMs.toExponential(2)} ms)`,
  );
  log(
    `  first_partial_deriv / rhomass = ${fmtX(micro.derivOverRhomass, 1)} ` +
      `(${micro.derivMs.toExponential(2)} vs ${micro.rhomassMs.toExponential(2)} ms)`,
  );

  const cases: CaseStudy[] = [
    runCase(
      "LN₂ two-phase chilldown",
      "N=4 audit line, 75 s",
      CHILLDOWN,
      agreeChilldown,
    ),
    runCase(
      "LN₂ chilldown 300 s",
      "full diagnostics horizon",
      CHILLDOWN_300,
      agreeChilldown,
    ),
    runCase(
      "N₂O cavitating venturi",
      "9-node one-step transient",
      VENTURI,
      agreeVenturi,
    ),
    runCase(
      "N₂ transonic CD nozzle",
      "kineticEnergy + upwind",
      TRANSONIC,
      agreeTransonic,
    ),
  ];

  const md = render(micro, cases);
  const out = join(process.cwd(), "docs/real-fluid-performance.md");
  writeFileSync(out, md);
  log(`\nWrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
