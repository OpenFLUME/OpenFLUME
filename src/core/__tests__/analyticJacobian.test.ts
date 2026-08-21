/**
 * Analytic real-fluid Jacobian vs finite-difference Jacobian — permanent
 * entry-by-entry regression guard.
 *
 * Background: commit 3c2fb4d builds the real-fluid Jacobian analytically
 * (buildDualPropCache evaluates safeStatePH + derivativesPH ONCE per node per
 * build; nodeStateDual chains the cached partials along each seed direction;
 * hybridJacobian patches only genuinely non-differentiable pieces per-column
 * via fdJacobianColumn).  The A/B timing (docs/real-fluid-performance.md §4)
 * measured 2.6–6.6× speedups with identical converged trajectories, but the
 * ad-hoc probe that verified Jacobian agreement was deleted.  This test is
 * the permanent guard: for real-fluid networks at several states it builds
 * the Jacobian BOTH ways at the SAME state (via the exported probeJacobians
 * hook) and compares entry by entry.
 *
 * States covered (where derivative bugs hide):
 *   - LN2 chilldown line (N=4, mirrors buildChilldownTwoPhase in
 *     src/ui/examples.ts, duplicated inline — core tests must not import
 *     src/ui): all-liquid (8 kJ/kg subcooled), all-vapor (8 kJ/kg
 *     superheated), all two-phase at q=0.5, a dome-straddling state
 *     (f1 liquid / f2 q=0.5 / f3 vapor), and near-dome-edge states
 *     (q=0.01 / 0.99 / 0.5).
 *   - N2O cavitating venturi at its shipped initial state (throat seeded at
 *     q=0.001, i.e. sitting ON the liquid-side dome edge; all other nodes
 *     compressed liquid; mu ≡ 0 for NitrousOxide so the frozen-mu convention
 *     is exact there).
 *   - Two FD-patch networks (cavitatingVenturi momentum row; HeatedPipe
 *     energy row) verifying patched entries are identical to the pure-FD
 *     Jacobian (same fdJacobianColumn + same base residual) and that the
 *     patch actually fired.
 *   - A small-step central-FD arbitration at the near-dome state proving the
 *     analytic h-column entries are the accurate side (see below).
 *
 * Tolerance structure (mixed absolute/relative, per entry):
 *   tol(i,k) = max( ABS_FLOOR·rowScale(i),
 *                   REL_class·max(|hybrid|, |fd|),
 *                   MU_MARGIN·muBound(i,k) )
 *
 *   REL_DEFAULT = 1e-4 for P/mdot columns — FD's own accuracy there is
 *     1e-6..1e-8 (central differences on real-fluid P columns; 1e-6-relative
 *     forward steps on mdot).  Measured worst default-class margin: 0.09.
 *   REL_H = 5e-2 for h columns of mass/energy/momentum rows — NOT because
 *     the analytic side is uncertain (it is exact: derivativesPH partials are
 *     property-level-guarded to 1e-6, and the small-step arbitration below
 *     matches it to ≤7e-5), but because the PRODUCTION FD Jacobian is the
 *     inaccurate side there: its fixed h steps (1% of |h| single-phase;
 *     one-sided ~1000 J/kg in/near the dome) carry up to 1.6e-2 relative
 *     truncation at q=0.01 (measured; the dome edge is exactly where FD is
 *     worst — dρ/dh jumps ~50× — which is why the code needed bespoke
 *     one-sided FD stepping).  3× margin over the measured 1.6e-2 worst case.
 *   muBound(i,k) — momentum-row (P,h)-of-upstream-node entries ONLY: the
 *     analytic path deliberately freezes viscosity (mu.d ≡ 0 — documented
 *     VISCOSITY DECISION in realFluid.ts statePHDual, pinned by
 *     statePHDual.test.ts) so it drops the ∂dP/∂μ·∂μ/∂seed friction term
 *     that FD sees.  Verified on every LN2 state: (fd−hybrid) equals
 *     −(∂dP/∂μ)(∂μ/∂seed) to ratio 0.99–1.01 for liquid, vapor AND two-phase
 *     nodes.  The bound is computed here from first principles (component
 *     pressureDrop FD × statePH μ FDs) and multiplied by MU_MARGIN=1.5.
 *     Exact (zero) for NitrousOxide, where statePH.mu ≡ 0.
 *
 * Defects this guard caught on its first run (2026-08-06, fixed alongside):
 *   (c) Pipe/Bend momentum rows for NitrousOxide were NaN across the whole
 *       hybrid Jacobian: statePH.mu ≡ 0 for N2O → Re.v = ∞ in
 *       darcyFrictionFactorDual, and 0·∞ → NaN in the pow/log10 chain.
 *       Fixed by returning the fully-rough Swamee–Jain limit (a constant
 *       dual — the scalar path's own value at Re = ∞) for non-finite Re.
 *   (d) This probe's HeatedPipe network originally seeded nA LIQUID, but
 *       HeatedPipe.getBranchHeat keys its boiling-model switch on the
 *       UPSTREAM state, so the miropolskii closure never fired and the
 *       "patch fired" guard's magnitude (derived for film boiling) was
 *       unachievable.  nA is now two-phase and the guard re-derived (see
 *       the HeatedPipe test).
 *
 * Diagnosis of every disagreement beyond FD noise (investigated 2026-08-06):
 *   (a) NO bug found in the analytic derivative chain.
 *   (b1) h-column entries near/inside the dome: the FD Jacobian is the wrong
 *        side (fixed-step truncation, ≤1.6e-2 relative at q=0.01) — the
 *        analytic entries match custom-step central FDs of the residual to
 *        ≤7e-5 relative (asserted below at δ=20 J/kg).
 *   (b2) momentum-row P/h entries with μ ≠ 0: neither side wrong — the
 *        analytic Jacobian intentionally omits the μ-partial term (frozen-μ
 *        convention); the gap equals the dropped term to ≤1% everywhere.
 *        Newton tolerates an inexact Jacobian (rate, not root), and the A/B
 *        runs confirmed identical converged trajectories.
 *
 * Achieved worst-case margins (|Δ|/tol per state, measured 2026-08-06 on
 * HEAD 3c2fb4d+probe+fixes; printout at end of run — drift here is the early
 * warning, not just pass/fail):
 *   LN2 all-liquid            0.66  (saturated by mom/h μ-bound class)
 *   LN2 all-vapor             0.67
 *   LN2 two-phase q=0.5       0.67
 *   LN2 dome-straddle         0.67
 *   LN2 near-dome q=0.01/0.99 0.68
 *   N2O venturi (throat edge) 0.19  (saturated by energy/h FD-truncation band)
 *   N2O cv FD-patch network   0.069 (mom:pipe / h:tank, REL_H band; patched
 *                                   entries themselves bitwise-identical)
 *   LN2 heatedPipe FD-patch   0.67  (mom:hp / h:nA μ-bound class; patched
 *                                    entries bitwise-identical)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initRealFluids, realFluidsReady, RealFluid } from "../";
import { getSatProps } from "../fluids/realFluid";
import {
  buildSolverContext,
  createInitialState,
  probeJacobians,
  solveStateStep,
  solveSteady,
} from "../solver";
import type { SolverContext, StepState } from "../solver";
import { CavitatingVenturi } from "../components";
import type { NetworkConfig } from "../schema";

// ---------------------------------------------------------------------------
// Tolerances (see header comment for rationale + measured margins)
// ---------------------------------------------------------------------------
const REL_DEFAULT = 1e-4;
const REL_H = 5e-2;
const ABS_FLOOR = 1e-9;
const MU_MARGIN = 1.5;
/** Patched (non-differentiable) entries: same fd code path in both Jacobians,
 *  same base residual — expect identical up to CoolProp evaluation-order
 *  last-bit noise (measured: bitwise or ≤4e-10 relative). */
const PATCH_TOL = 1e-9;

// ---------------------------------------------------------------------------
// Inline network builders (mirror src/ui/examples.ts configs; core tests must
// not import src/ui — see helpers/chilldownAuditConfig.ts for the convention)
// ---------------------------------------------------------------------------

/** LN2 chilldown line, N=4 segments of the full 60.96 m 200-ft line,
 *  saturated-liquid inlet at 0.5169 MPa — mirrors buildChilldownTwoPhase. */
function buildLn2ChilldownConfig(): NetworkConfig {
  const N = 4;
  const L = 60.96;
  const P_in = 0.5169e6;
  const P_out = 101325;
  const T_out = 300;
  const D = 0.015875;
  const OD = 0.01905;
  const roughness = 1.5e-6;
  const rhoCu = 8960;
  const cpCu = 385;
  const kCu = 400;
  const segL = L / N;
  const A_fluid = (Math.PI / 4) * D * D;
  const A_metal = (Math.PI / 4) * (OD * OD - D * D);
  const vol = A_fluid * segL;
  const mass_solid = rhoCu * A_metal * segL;
  const convArea = Math.PI * D * segL;

  const nodes: NetworkConfig["nodes"] = [
    { id: "f0", type: "boundary", x: 0, y: 0, pressure: P_in, quality: 0 },
  ];
  const solidNodes: NetworkConfig["solidNodes"] = [
    {
      id: "s0",
      type: "solid",
      x: 0,
      y: 80,
      temperature: T_out,
      mass: mass_solid,
      cp: cpCu,
    },
  ];
  for (let i = 1; i < N; i++) {
    const x = i * segL;
    const p0 = P_in - (P_in - P_out) * (i / N);
    nodes.push({
      id: `f${i}`,
      type: "internal",
      x,
      y: 0,
      pressure: p0,
      temperature: T_out,
      volume: vol,
    });
    solidNodes.push({
      id: `s${i}`,
      type: "solid",
      x,
      y: 80,
      temperature: T_out,
      mass: mass_solid,
      cp: cpCu,
    });
  }
  nodes.push({
    id: `f${N}`,
    type: "boundary",
    x: L,
    y: 0,
    pressure: P_out,
    temperature: T_out,
  });
  solidNodes.push({
    id: `s${N}`,
    type: "solid",
    x: L,
    y: 80,
    temperature: T_out,
    mass: mass_solid,
    cp: cpCu,
  });

  const conductors: NetworkConfig["conductors"] = [];
  for (let i = 0; i <= N; i++) {
    conductors.push({
      id: `conv${i}`,
      from: `f${i}`,
      to: `s${i}`,
      type: {
        kind: "convection",
        area: convArea,
        correlation: { model: "miropolskii", diameter: D, flowArea: A_fluid },
      },
    });
  }
  for (let i = 0; i < N; i++) {
    conductors.push({
      id: `cond${i}`,
      from: `s${i}`,
      to: `s${i + 1}`,
      type: { kind: "conduction", k: kCu, area: A_metal, length: segL },
    });
  }
  const branches: NetworkConfig["branches"] = [];
  for (let i = 0; i < N; i++) {
    branches.push({
      id: `pipe${i}`,
      from: `f${i}`,
      to: `f${i + 1}`,
      component: { type: "pipe", length: segL, diameter: D, roughness },
    });
  }
  return {
    meta: { name: "LN2 chilldown (Jacobian probe)", version: 2 },
    settings: {
      mode: "transient",
      tolerance: 1e-5,
      maxIterations: 200,
      relaxation: 0.7,
      endTime: 10,
      dt: 10,
      timeStepping: "fixed",
    },
    fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
    nodes,
    solidNodes,
    conductors,
    branches,
  };
}

/** N2O cavitating venturi — exact copy of the shipped
 *  nitrousOxideCavitatingVenturi example (throat seeded at q=0.001). */
function buildN2OVenturiConfig(): NetworkConfig {
  return {
    meta: { name: "N₂O cavitating venturi (Jacobian probe)", version: 2 },
    settings: {
      mode: "transient",
      dt: 0.01,
      endTime: 0.01,
      tolerance: 1e-6,
      maxIterations: 200,
      relaxation: 0.5,
    },
    fluid: { model: "realFluid", params: { fluidName: "NitrousOxide" } },
    nodes: [
      {
        id: "inlet",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 5.5158e6,
        temperature: 244.26,
      },
      {
        id: "c1",
        type: "internal",
        x: 100,
        y: 0,
        pressure: 4.0e6,
        temperature: 244.26,
        volume: 1e-6,
      },
      {
        id: "c2",
        type: "internal",
        x: 200,
        y: 0,
        pressure: 4.0e6,
        temperature: 244.26,
        volume: 1e-6,
      },
      {
        id: "c3",
        type: "internal",
        x: 300,
        y: 0,
        pressure: 4.0e6,
        temperature: 244.26,
        volume: 1e-6,
      },
      {
        id: "throat",
        type: "internal",
        x: 400,
        y: 0,
        pressure: 1.365235e6,
        quality: 0.001,
        volume: 1e-5,
      },
      {
        id: "d1",
        type: "internal",
        x: 500,
        y: 0,
        pressure: 4.0e6,
        temperature: 244.26,
        volume: 1e-6,
      },
      {
        id: "d2",
        type: "internal",
        x: 600,
        y: 0,
        pressure: 4.0e6,
        temperature: 244.26,
        volume: 1e-6,
      },
      {
        id: "d3",
        type: "internal",
        x: 700,
        y: 0,
        pressure: 4.0e6,
        temperature: 244.26,
        volume: 1e-6,
      },
      {
        id: "d4",
        type: "internal",
        x: 800,
        y: 0,
        pressure: 4.0e6,
        temperature: 244.26,
        volume: 1e-6,
      },
      {
        id: "d5",
        type: "internal",
        x: 900,
        y: 0,
        pressure: 4.0e6,
        temperature: 244.26,
        volume: 1e-6,
      },
      {
        id: "d6",
        type: "internal",
        x: 1000,
        y: 0,
        pressure: 4.0e6,
        temperature: 244.26,
        volume: 1e-6,
      },
      {
        id: "outlet",
        type: "boundary",
        x: 1100,
        y: 0,
        pressure: 3.4474e6,
        temperature: 244.26,
      },
    ],
    branches: [
      {
        id: "ac_c1",
        from: "inlet",
        to: "c1",
        component: {
          type: "areaChange",
          areaIn: 1.2674e-4,
          areaOut: 4.2875e-5,
        },
      },
      {
        id: "ac_c2",
        from: "c1",
        to: "c2",
        component: {
          type: "areaChange",
          areaIn: 4.2875e-5,
          areaOut: 1.4509e-5,
        },
      },
      {
        id: "ac_c3",
        from: "c2",
        to: "c3",
        component: {
          type: "areaChange",
          areaIn: 1.4509e-5,
          areaOut: 4.9087e-6,
        },
      },
      {
        id: "ac_c4",
        from: "c3",
        to: "throat",
        component: {
          type: "areaChange",
          areaIn: 4.9087e-6,
          areaOut: 4.9087e-6,
        },
      },
      {
        id: "ac_d1",
        from: "throat",
        to: "d1",
        component: {
          type: "areaChange",
          areaIn: 4.9087e-6,
          areaOut: 8.4352e-6,
        },
      },
      {
        id: "ac_d2",
        from: "d1",
        to: "d2",
        component: {
          type: "areaChange",
          areaIn: 8.4352e-6,
          areaOut: 1.4493e-5,
        },
      },
      {
        id: "ac_d3",
        from: "d2",
        to: "d3",
        component: {
          type: "areaChange",
          areaIn: 1.4493e-5,
          areaOut: 2.4894e-5,
        },
      },
      {
        id: "ac_d4",
        from: "d3",
        to: "d4",
        component: {
          type: "areaChange",
          areaIn: 2.4894e-5,
          areaOut: 4.2764e-5,
        },
      },
      {
        id: "ac_d5",
        from: "d4",
        to: "d5",
        component: {
          type: "areaChange",
          areaIn: 4.2764e-5,
          areaOut: 7.3472e-5,
        },
      },
      {
        id: "ac_d6",
        from: "d5",
        to: "d6",
        component: {
          type: "areaChange",
          areaIn: 7.3472e-5,
          areaOut: 1.2617e-4,
        },
      },
      {
        id: "ac_d7",
        from: "d6",
        to: "outlet",
        component: {
          type: "areaChange",
          areaIn: 1.2617e-4,
          areaOut: 1.2674e-4,
        },
      },
    ],
  };
}

/** N2O: boundary → cavitatingVenturi (no pressureDropDual → FD-patched
 *  momentum row) → internal node → pipe → boundary. */
function buildCvPatchConfig(): NetworkConfig {
  return {
    meta: { name: "cv FD-patch probe", version: 2 },
    settings: {
      mode: "transient",
      dt: 0.01,
      endTime: 0.01,
      tolerance: 1e-6,
      maxIterations: 100,
      relaxation: 0.7,
    },
    fluid: { model: "realFluid", params: { fluidName: "NitrousOxide" } },
    nodes: [
      {
        id: "inlet",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 5.5158e6,
        temperature: 244.26,
      },
      {
        id: "tank",
        type: "internal",
        x: 1,
        y: 0,
        pressure: 4.0e6,
        temperature: 244.26,
        volume: 1e-4,
      },
      {
        id: "outlet",
        type: "boundary",
        x: 2,
        y: 0,
        pressure: 3.4474e6,
        temperature: 244.26,
      },
    ],
    branches: [
      {
        id: "cv",
        from: "inlet",
        to: "tank",
        component: {
          type: "cavitatingVenturi",
          throatArea: 4.9087e-6,
          cd: 0.84,
          recoveryFactor: 0.55,
        },
      },
      {
        id: "pipe",
        from: "tank",
        to: "outlet",
        component: { type: "pipe", length: 1, diameter: 0.01, roughness: 1e-5 },
      },
    ],
  };
}

/** LN2: boundary → pipe → nA (two-phase q=0.3) → heatedPipe (miropolskii;
 *  branch heat is FD-patched on the downstream energy row) → nB (two-phase)
 *  → pipe → boundary.  nA MUST be two-phase: HeatedPipe.getBranchHeat keys
 *  its boiling-model switch on the UPSTREAM node state, so a liquid nA would
 *  take the sensible-heat NTU branch and the miropolskii film-boiling closure
 *  this probe is meant to exercise would never fire. */
function buildHeatedPipePatchConfig(): NetworkConfig {
  return {
    meta: { name: "heatedPipe FD-patch probe", version: 2 },
    settings: {
      mode: "transient",
      dt: 10,
      endTime: 10,
      tolerance: 1e-6,
      maxIterations: 100,
      relaxation: 0.7,
    },
    fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
    nodes: [
      {
        id: "inlet",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 0.5169e6,
        quality: 0,
      },
      {
        id: "nA",
        type: "internal",
        x: 1,
        y: 0,
        pressure: 0.45e6,
        quality: 0.3,
        volume: 3e-3,
      },
      {
        id: "nB",
        type: "internal",
        x: 2,
        y: 0,
        pressure: 0.35e6,
        quality: 0.5,
        volume: 3e-3,
      },
      {
        id: "outlet",
        type: "boundary",
        x: 3,
        y: 0,
        pressure: 101325,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "pipeA",
        from: "inlet",
        to: "nA",
        component: {
          type: "pipe",
          length: 10,
          diameter: 0.015875,
          roughness: 1.5e-6,
        },
      },
      {
        id: "hp",
        from: "nA",
        to: "nB",
        component: {
          type: "heatedPipe",
          length: 10,
          diameter: 0.015875,
          roughness: 1.5e-6,
          ua: 2000,
          wallTemperature: 300,
          boilingModel: "miropolskii",
        },
      },
      {
        id: "pipeB",
        from: "nB",
        to: "outlet",
        component: {
          type: "pipe",
          length: 10,
          diameter: 0.015875,
          roughness: 1.5e-6,
        },
      },
    ],
  };
}

/** All-liquid LN2 two-pipe step for the jacobian:'fd' escape-hatch solve
 *  (smooth single-phase: both Jacobian paths converge the step trivially). */
function buildLiquidStepConfig(): NetworkConfig {
  const D = 0.015875;
  const roughness = 1.5e-6;
  const segL = 30.48;
  const vol = (Math.PI / 4) * D * D * segL;
  return {
    meta: { name: "fd escape-hatch step", version: 2 },
    settings: {
      mode: "transient",
      dt: 10,
      endTime: 10,
      tolerance: 1e-6,
      maxIterations: 200,
      relaxation: 0.7,
    },
    fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
    nodes: [
      {
        id: "f0",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 0.4e6,
        temperature: 85,
      },
      {
        id: "f1",
        type: "internal",
        x: segL,
        y: 0,
        pressure: 0.32e6,
        temperature: 87,
        volume: vol,
      },
      {
        id: "f2",
        type: "boundary",
        x: 2 * segL,
        y: 0,
        pressure: 0.25e6,
        temperature: 85,
      },
    ],
    branches: [
      {
        id: "pipe0",
        from: "f0",
        to: "f1",
        component: { type: "pipe", length: segL, diameter: D, roughness },
      },
      {
        id: "pipe1",
        from: "f1",
        to: "f2",
        component: { type: "pipe", length: segL, diameter: D, roughness },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cloneState(s: StepState): StepState {
  return {
    nodeP: new Map(s.nodeP),
    nodeT: new Map(s.nodeT),
    nodeRho: new Map(s.nodeRho),
    nodeMu: new Map(s.nodeMu),
    nodeH: s.nodeH ? new Map(s.nodeH) : undefined,
    nodeQuality: s.nodeQuality ? new Map(s.nodeQuality) : undefined,
    nodePhase: s.nodePhase ? new Map(s.nodePhase) : undefined,
    nodeY: s.nodeY ? new Map(s.nodeY) : undefined,
    mdots: [...s.mdots],
    solidT: new Map(s.solidT),
  };
}

type PhaseTarget = {
  kind: "liquid" | "dome" | "vapor";
  q?: number;
  dh?: number;
};

/** Retarget each internal node's (P, h) to a chosen phase region, keeping all
 *  derived state fields consistent with statePH. */
function setInternalPhases(
  ctx: SolverContext,
  state: StepState,
  targets: Record<string, PhaseTarget>,
  mdot: number,
): void {
  const fluid = ctx.fluid as RealFluid;
  for (const id of ctx.internalIds) {
    const tg = targets[id];
    if (!tg) continue;
    const P = state.nodeP.get(id)!;
    const { hf, hg } = getSatProps(fluid.fluidName, P);
    const h =
      tg.kind === "liquid"
        ? hf - (tg.dh ?? 8000)
        : tg.kind === "vapor"
          ? hg + (tg.dh ?? 8000)
          : hf + (tg.q ?? 0.5) * (hg - hf);
    const ph = fluid.statePH(P, h);
    state.nodeH!.set(id, h);
    state.nodeT.set(id, ph.T);
    state.nodeRho.set(id, ph.rho);
    state.nodeMu.set(id, ph.mu);
    state.nodeQuality!.set(id, ph.quality);
    state.nodePhase!.set(id, ph.phase);
  }
  state.mdots.fill(mdot);
}

function colLabel(ctx: SolverContext, k: number): string {
  const { nInt, nBranch, internalIds, branches } = ctx;
  return k < nInt
    ? `P:${internalIds[k]}`
    : k < nInt + nBranch
      ? `mdot:${branches[k - nInt].id}`
      : `h:${internalIds[k - nInt - nBranch]}`;
}

function rowLabel(ctx: SolverContext, i: number): string {
  const { nInt, nBranch, internalIds, branches } = ctx;
  return i < nInt
    ? `mass:${internalIds[i]}`
    : i < nInt + nBranch
      ? `mom:${branches[i - nInt].id}`
      : `energy:${internalIds[i - nInt - nBranch]}`;
}

/** First-principles bound on the frozen-μ gap for momentum rows:
 *  |(∂dP/∂μ)·(∂μ/∂seed)| with ∂dP/∂μ from the branch component and ∂μ/∂seed
 *  from statePH FDs.  Zero where μ ≡ 0 (NitrousOxide) or the row has no
 *  internal upstream node. */
function computeMuBounds(ctx: SolverContext, x: number[]): number[][] {
  const { nInt, nBranch, internalIndex, branches } = ctx;
  const fluid = ctx.fluid as RealFluid;
  const n = x.length;
  const muB: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let j = 0; j < nBranch; j++) {
    const b = branches[j];
    const mdot = x[nInt + j];
    const up = mdot >= 0 ? b.from : b.to;
    if (!internalIndex.has(up)) continue;
    const ui = internalIndex.get(up)!;
    const P = x[ui];
    const h = x[nInt + nBranch + ui];
    const ph = fluid.statePH(P, h);
    const dMu = Math.max(ph.mu * 1e-4, 1e-12);
    const ddP_dmu =
      (b.component.pressureDrop(mdot, ph.rho, ph.mu + dMu) -
        b.component.pressureDrop(mdot, ph.rho, ph.mu - dMu)) /
      (2 * dMu);
    const dPp = Math.max(P * 1e-4, 10);
    const dmu_dP =
      (fluid.statePH(P + dPp, h).mu - fluid.statePH(P - dPp, h).mu) / (2 * dPp);
    const dH = Math.max(Math.abs(h) * 1e-4, 50);
    const dmu_dh =
      (fluid.statePH(P, h + dH).mu - fluid.statePH(P, h - dH).mu) / (2 * dH);
    muB[nInt + j][ui] = Math.abs(ddP_dmu * dmu_dP);
    muB[nInt + j][nInt + nBranch + ui] = Math.abs(ddP_dmu * dmu_dh);
  }
  return muB;
}

// ---- margin bookkeeping (achieved agreement, printed after the run) ----
const worstMargins = new Map<string, { margin: number; entry: string }>();
function recordMargin(key: string, margin: number, entry: string) {
  const cur = worstMargins.get(key);
  if (!cur || margin > cur.margin) worstMargins.set(key, { margin, entry });
}
afterAll(() => {
  console.log(
    "\n[analyticJacobian] worst-case |Δ|/tol per state (drift here is the early warning):",
  );
  for (const [k, v] of [...worstMargins.entries()].sort()) {
    console.log(`  ${k.padEnd(44)} ${v.margin.toExponential(2)}  (${v.entry})`);
  }
});

interface ProbeOutcome {
  x: number[];
  hybrid: number[][];
  fd: number[][];
  R0: number[];
  rowScale: number[];
  muB: number[][];
}

function runProbe(
  ctx: SolverContext,
  state: StepState,
  dt: number,
): ProbeOutcome {
  const prevState = cloneState(state);
  const { x, hybrid, fd, R0 } = probeJacobians(ctx, state, {
    dt,
    t: dt,
    prevState,
  });
  expect(R0, "base residual evaluation failed at probe state").toBeDefined();
  const n = x.length;
  for (let i = 0; i < n; i++) {
    expect(Number.isFinite(R0![i]), `R0[${i}] not finite`).toBe(true);
    for (let k = 0; k < n; k++) {
      // The 'fd' escape hatch must always produce a finite Jacobian.
      expect(Number.isFinite(fd[i][k]), `fd[${i}][${k}] not finite`).toBe(true);
      expect(
        Number.isFinite(hybrid[i][k]),
        `hybrid[${i}][${k}] not finite`,
      ).toBe(true);
    }
  }
  const rowScale = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      rowScale[i] = Math.max(
        rowScale[i],
        Math.abs(hybrid[i][k]),
        Math.abs(fd[i][k]),
      );
    }
  }
  return { x, hybrid, fd, R0: R0!, rowScale, muB: computeMuBounds(ctx, x) };
}

/** Entry-by-entry comparison with the tolerance structure documented in the
 *  header.  Asserts zero violations; returns/records the worst margin. */
function expectJacobiansAgree(
  label: string,
  ctx: SolverContext,
  probe: ProbeOutcome,
): void {
  const { nInt, nBranch } = ctx;
  const { x, hybrid, fd, rowScale, muB } = probe;
  const n = x.length;
  const violations: string[] = [];
  let worst = 0;
  let worstEntry = "";
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const a = hybrid[i][k];
      const b = fd[i][k];
      const isHCol = k >= nInt + nBranch;
      const tol = Math.max(
        ABS_FLOOR * rowScale[i],
        (isHCol ? REL_H : REL_DEFAULT) * Math.max(Math.abs(a), Math.abs(b)),
        MU_MARGIN * muB[i][k],
      );
      const m = Math.abs(a - b) / tol;
      if (m > worst) {
        worst = m;
        worstEntry = `${rowLabel(ctx, i)} / ${colLabel(ctx, k)}`;
      }
      if (m > 1) {
        violations.push(
          `${rowLabel(ctx, i)} / ${colLabel(ctx, k)}: hybrid=${a.toExponential(6)} fd=${b.toExponential(6)} |Δ|=${Math.abs(a - b).toExponential(3)} > tol=${tol.toExponential(3)} (margin ${m.toFixed(2)})`,
        );
      }
    }
  }
  recordMargin(label, worst, worstEntry);
  expect(
    violations.length,
    `${label}: ${violations.length} Jacobian entries disagree beyond tolerance:\n${violations.slice(0, 8).join("\n")}`,
  ).toBe(0);
}

/** Mirror of the solver's fdRows marking (computeResidualDual) for the two
 *  non-differentiable component kinds used here — cavitatingVenturi momentum
 *  rows and HeatedPipe branch heat on energy rows.  Patched entries must be
 *  (near-)bitwise identical to the pure-FD Jacobian: both paths patch via the
 *  same fdJacobianColumn on the same base residual. */
function expectedPatchedEntries(
  ctx: SolverContext,
  x: number[],
): Array<[number, number]> {
  const { nInt, nBranch, internalIndex, branches } = ctx;
  const out: Array<[number, number]> = [];
  const colsForNode = (id: string): number[] =>
    internalIndex.has(id)
      ? [internalIndex.get(id)!, nInt + nBranch + internalIndex.get(id)!]
      : [];
  branches.forEach((b, j) => {
    const mdot = x[nInt + j];
    if (b.component instanceof CavitatingVenturi) {
      const row = nInt + j;
      for (const c of [nInt + j, ...colsForNode(b.from), ...colsForNode(b.to)])
        out.push([row, c]);
    }
    if (b.component.getBranchHeat) {
      const dn = mdot >= 0 ? b.to : b.from;
      if (internalIndex.has(dn)) {
        const up = mdot >= 0 ? b.from : b.to;
        const row = nInt + nBranch + internalIndex.get(dn)!;
        for (const c of [nInt + j, ...colsForNode(up)]) out.push([row, c]);
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Analytic real-fluid Jacobian vs FD — entry-by-entry (probeJacobians)", () => {
  let ln2Ctx: SolverContext;
  let ln2Config: NetworkConfig;

  beforeAll(async () => {
    await initRealFluids();
    expect(realFluidsReady()).toBe(true);
    ln2Config = buildLn2ChilldownConfig();
    ln2Ctx = buildSolverContext(ln2Config);
  }, 60000);

  function probeLn2State(
    label: string,
    targets: Record<string, PhaseTarget>,
  ): ProbeOutcome {
    const state = createInitialState(ln2Ctx, ln2Config);
    setInternalPhases(ln2Ctx, state, targets, 0.05);
    const probe = runProbe(ln2Ctx, state, 10);
    expectJacobiansAgree(label, ln2Ctx, probe);
    return probe;
  }

  it("LN2 single-phase liquid (8 kJ/kg subcooled)", () => {
    probeLn2State("LN2 all-liquid", {
      f1: { kind: "liquid" },
      f2: { kind: "liquid" },
      f3: { kind: "liquid" },
    });
  });

  it("LN2 single-phase vapor (8 kJ/kg superheated)", () => {
    probeLn2State("LN2 all-vapor", {
      f1: { kind: "vapor" },
      f2: { kind: "vapor" },
      f3: { kind: "vapor" },
    });
  });

  it("LN2 well inside the two-phase dome (q=0.5)", () => {
    probeLn2State("LN2 two-phase q=0.5", {
      f1: { kind: "dome", q: 0.5 },
      f2: { kind: "dome", q: 0.5 },
      f3: { kind: "dome", q: 0.5 },
    });
  });

  it("LN2 dome-straddling (f1 liquid / f2 two-phase / f3 vapor)", () => {
    probeLn2State("LN2 dome-straddle", {
      f1: { kind: "liquid" },
      f2: { kind: "dome", q: 0.5 },
      f3: { kind: "vapor" },
    });
  });

  it("LN2 near dome edges (q=0.01 / 0.99 / 0.5) — where FD is worst", () => {
    probeLn2State("LN2 near-dome q=0.01/0.99", {
      f1: { kind: "dome", q: 0.01 },
      f2: { kind: "dome", q: 0.99 },
      f3: { kind: "dome", q: 0.5 },
    });
  });

  it("N2O cavitating venturi at shipped initial state (throat on dome edge)", () => {
    const config = buildN2OVenturiConfig();
    const ctx = buildSolverContext(config);
    const state = createInitialState(ctx, config);
    state.mdots.fill(0.385); // realistic choked-mdot scale
    const probe = runProbe(ctx, state, 0.01);
    expectJacobiansAgree("N2O venturi (throat q=0.001)", ctx, probe);
  });

  it("FD patch: cavitatingVenturi momentum row patched entries are identical to pure FD", () => {
    const config = buildCvPatchConfig();
    const ctx = buildSolverContext(config);
    const state = createInitialState(ctx, config);
    state.mdots.fill(0.3);
    const probe = runProbe(ctx, state, 0.01);
    const { x, hybrid, fd } = probe;

    const patched = expectedPatchedEntries(ctx, x);
    expect(patched.length).toBeGreaterThan(0);
    for (const [i, k] of patched) {
      const a = hybrid[i][k];
      const b = fd[i][k];
      const scale = Math.max(1, Math.abs(a), Math.abs(b));
      expect(
        Math.abs(a - b),
        `patched ${rowLabel(ctx, i)} / ${colLabel(ctx, k)}: hybrid=${a.toExponential(10)} fd=${b.toExponential(10)}`,
      ).toBeLessThanOrEqual(PATCH_TOL * scale);
    }
    // The patch provably FIRED: the analytic-alone derivative of the cv
    // momentum row w.r.t. the downstream-node pressure column is exactly 0
    // (the dual row is mdot − constant(expectedMdot)); the patched value is
    // the nonzero FD derivative of the cavitation closure w.r.t. pDown.
    const cvRow = ctx.nInt + 0;
    const tankPCol = ctx.internalIndex.get("tank")!;
    expect(Math.abs(hybrid[cvRow][tankPCol])).toBeGreaterThan(1e-12);

    // Rest of the matrix still compared under the standard tolerance structure.
    expectJacobiansAgree("N2O cv FD-patch", ctx, probe);
  });

  it("FD patch: HeatedPipe branch heat on energy row patched entries are identical to pure FD", () => {
    const config = buildHeatedPipePatchConfig();
    const ctx = buildSolverContext(config);
    const fluid = ctx.fluid as RealFluid;
    const state = createInitialState(ctx, config);
    state.mdots.fill(0.05);
    // Sanity: BOTH internal nodes are two-phase — nB because the probe is its
    // energy row, nA because the boiling-model switch in getBranchHeat keys on
    // the UPSTREAM state (mdot > 0 → nA), so the miropolskii film-boiling
    // branch is the active closure for the patched heat term.
    const phA = fluid.statePH(state.nodeP.get("nA")!, state.nodeH!.get("nA")!);
    const phB = fluid.statePH(state.nodeP.get("nB")!, state.nodeH!.get("nB")!);
    expect(phA.phase).toBe("twoPhase");
    expect(phB.phase).toBe("twoPhase");

    const probe = runProbe(ctx, state, 10);
    const { x, hybrid, fd } = probe;

    const patched = expectedPatchedEntries(ctx, x);
    expect(patched.length).toBeGreaterThan(0);
    for (const [i, k] of patched) {
      const a = hybrid[i][k];
      const b = fd[i][k];
      const scale = Math.max(1, Math.abs(a), Math.abs(b));
      expect(
        Math.abs(a - b),
        `patched ${rowLabel(ctx, i)} / ${colLabel(ctx, k)}: hybrid=${a.toExponential(10)} fd=${b.toExponential(10)}`,
      ).toBeLessThanOrEqual(PATCH_TOL * scale);
    }
    // The patch provably FIRED.  The analytic-alone derivative of the nB
    // energy row w.r.t. h:nA is exactly the advection term mdot = 0.05 (the
    // dual path adds the branch heat as a VALUE, derivative 0, and patches);
    // the patched FD entry additionally carries the wall-heat derivative
    //   ∂Q/∂h = A_i·(T_wall − T_sat)·∂hMiro/∂h,
    // with A_i = π·D·L = 0.499 m², T_wall − T_sat = 207 K and hMiro depending
    // on h only through quality x = (h − h_f)/h_fg (h_fg ≈ 176 kJ/kg), so
    // ∂Q/∂h ≈ 0.23 W per J/kg — the same order as advection, NOT hundreds:
    // measured patched entry 0.277 = 0.05 + 0.227 (deviation 4.5×mdot; the
    // 2×mdot threshold below carries >2× margin).
    const energyB = ctx.nInt + ctx.nBranch + ctx.internalIndex.get("nB")!;
    const hACol = ctx.nInt + ctx.nBranch + ctx.internalIndex.get("nA")!;
    const mdotHp = x[ctx.nInt + 1];
    expect(mdotHp).toBe(0.05);
    expect(
      Math.abs(hybrid[energyB][hACol] - mdotHp),
      `patch fired: |${hybrid[energyB][hACol]} − ${mdotHp}| must exceed 2×mdot (analytic-alone value is exactly mdot)`,
    ).toBeGreaterThan(2 * mdotHp);

    expectJacobiansAgree("LN2 heatedPipe FD-patch", ctx, probe);
  });

  it("Arbitration: analytic h-column entries match a small-step reference FD; the production FD is the inaccurate side", () => {
    // Near-dome state (f1 at q=0.01).  Reference: central FD of the base
    // residual at δ=20 J/kg around the SAME x (via re-probed R0), a step that
    // stays inside the dome on both sides and is small enough that FD
    // truncation is ~1e-5 relative.  The production FD Jacobian must use its
    // fixed ~1000 J/kg one-sided step here, carrying ~1.6e-2 truncation.
    const state = createInitialState(ln2Ctx, ln2Config);
    setInternalPhases(
      ln2Ctx,
      state,
      {
        f1: { kind: "dome", q: 0.01 },
        f2: { kind: "dome", q: 0.99 },
        f3: { kind: "dome", q: 0.5 },
      },
      0.05,
    );
    const prevState = cloneState(state);
    const opts = { dt: 10, t: 10, prevState };
    const { x, hybrid, fd, R0 } = probeJacobians(ln2Ctx, state, opts);
    expect(R0).toBeDefined();
    const { nInt, nBranch } = ln2Ctx;
    const colHf1 = nInt + nBranch + ln2Ctx.internalIndex.get("f1")!;
    const massF1 = ln2Ctx.internalIndex.get("f1")!;
    const energyF1 = nInt + nBranch + ln2Ctx.internalIndex.get("f1")!;

    const delta = 20;
    const xp = [...x];
    xp[colHf1] += delta;
    const xm = [...x];
    xm[colHf1] -= delta;
    const rp = probeJacobians(ln2Ctx, state, opts, xp).R0!;
    const rm = probeJacobians(ln2Ctx, state, opts, xm).R0!;

    for (const i of [massF1, energyF1]) {
      const ref = (rp[i] - rm[i]) / (2 * delta);
      const a = hybrid[i][colHf1];
      const b = fd[i][colHf1];
      const hybridErr = Math.abs(a - ref) / Math.abs(ref);
      const fdErr = Math.abs(b - ref) / Math.abs(ref);
      // Analytic side agrees with the reference to FD's sweet-spot accuracy
      // (measured 1.1e-5 at δ=20; 100× margin).
      expect(
        hybridErr,
        `${rowLabel(ln2Ctx, i)} / h:f1: hybrid=${a.toExponential(6)} ref=${ref.toExponential(6)}`,
      ).toBeLessThan(1e-4);
      // …and the production FD is the outlier (~1.6e-2 measured).  If a
      // future change makes the FD Jacobian more accurate here, this
      // assertion fails loudly — tighten REL_H at that point.
      expect(
        fdErr,
        `production fd unexpectedly accurate at ${rowLabel(ln2Ctx, i)} / h:f1`,
      ).toBeGreaterThan(1e-3);
    }
  });
});

describe("settings.jacobian: 'fd' escape hatch", () => {
  beforeAll(async () => {
    await initRealFluids();
    expect(realFluidsReady()).toBe(true);
  }, 60000);

  it("transient all-liquid LN2 step: fd path converges to the same state as hybrid", () => {
    const results: Record<string, { P: number; h: number; mdots: number[] }> =
      {};
    for (const jacobian of ["hybrid", "fd"] as const) {
      const config = buildLiquidStepConfig();
      const ctx = buildSolverContext(config);
      const state = createInitialState(ctx, config);
      const res = solveStateStep(ctx, state, {
        dt: 10,
        t: 10,
        tol: 1e-6,
        maxIterations: 200,
        relaxation: 0.7,
        prevState: cloneState(state),
        jacobian,
      });
      expect(
        res.converged,
        `jacobian=${jacobian} did not converge the smooth step`,
      ).toBe(true);
      results[jacobian] = {
        P: state.nodeP.get("f1")!,
        h: state.nodeH!.get("f1")!,
        mdots: [...state.mdots],
      };
    }
    // Same discrete root (smooth single-phase system, same tol).
    expect(
      Math.abs(results.fd.P - results.hybrid.P) / results.hybrid.P,
    ).toBeLessThan(1e-6);
    expect(Math.abs(results.fd.h - results.hybrid.h)).toBeLessThan(1); // J/kg
    for (let j = 0; j < 2; j++) {
      expect(
        Math.abs(results.fd.mdots[j] - results.hybrid.mdots[j]),
      ).toBeLessThan(1e-6);
    }
  });

  it("steady N2O cavitating-venturi closure: fd path converges to the same mdot", () => {
    const base: NetworkConfig = {
      meta: { name: "cv steady (fd escape hatch)", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-6,
        maxIterations: 200,
        relaxation: 0.9,
      },
      fluid: { model: "realFluid", params: { fluidName: "NitrousOxide" } },
      nodes: [
        {
          id: "inlet",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 5.5158e6,
          temperature: 244.26,
        },
        {
          id: "outlet",
          type: "boundary",
          x: 300,
          y: 0,
          pressure: 3.4474e6,
          temperature: 244.26,
        },
      ],
      branches: [
        {
          id: "cv",
          from: "inlet",
          to: "outlet",
          component: {
            type: "cavitatingVenturi",
            throatArea: 4.9087e-6,
            cd: 0.84,
            recoveryFactor: 0.55,
          },
        },
      ],
    };
    const mdots: Record<string, number> = {};
    for (const jacobian of ["hybrid", "fd"] as const) {
      const res = solveSteady({
        ...base,
        settings: { ...base.settings, jacobian },
      });
      expect(
        res.converged,
        `jacobian=${jacobian} steady solve did not converge`,
      ).toBe(true);
      mdots[jacobian] = res.branches.cv.mdot;
    }
    expect(Math.abs(mdots.fd - mdots.hybrid) / mdots.hybrid).toBeLessThan(1e-6);
  });
});
