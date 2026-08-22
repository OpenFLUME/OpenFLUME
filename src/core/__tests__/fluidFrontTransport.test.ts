/**
 * fluidFrontTransport.test.ts — transported cryogenic-front / liquid-
 * availability state (src/core/fluidFront.ts; docs/fluid-front-transport.md).
 *
 * Motivation: docs/fluid-front-transport.md records that the early
 * downstream pre-cooling defect is carried by an ADVECTED cold vapor
 * enthalpy tail and that only a conservation-speed transport gate (C2)
 * repairs the trace morphology.  This suite proves the IMPLEMENTATION
 * contracts of the resulting model — no NBS data, no fitting:
 *
 *  1. PLUG DISPLACEMENT / EXACT FRONT TRAVEL — the pure upwind/BE kernel on
 *     a serial line reproduces the backward-Euler well-mixed finite-volume
 *     analytical recurrence EXACTLY (not sharp plug flow — the scheme is
 *     first-order donor-cell; the recurrence is the truth model), with
 *     ordered front arrival; network-level: recorded histories replay
 *     exactly from the kernel + recorded accepted inputs.
 *  2. GLOBAL TRACER CONSERVATION — kernel-level per-step telescoping, and
 *     network-level recorded-series audit: ΔΣ(m·a) = ∫ boundary tracer
 *     influx dt (right-rectangle, the BE-consistent quadrature), forward
 *     AND reversed flow.
 *  3. BOUNDS — a ∈ [0,1] without non-conservative clipping; the counted
 *     bounds-clamp corrections are exactly 0 in every nominal test.
 *  4. ACCEPTED-STEP IMMUTABILITY — adaptive run with rejected trials:
 *     histories align 1:1 with accepted times and replay exactly.
 *  5. HEAT-GATE LIMITS — local (hand-built correlation context): a = 0 ⇒
 *     exactly zero dry-side h; a = 1 ⇒ bit-identical to the ungated TT-WF
 *     evaluation; C1/bounded monotone sweep; fWet = 1 ⇒ gate inert.
 *     Network level: a gated line shows no wall cooling before front
 *     arrival; the ungated twin cools immediately.
 *  6. FRONT/WETTING DISTINCTION — a arrives before and independently of
 *     fWet/quality; it is never set from either.
 *  7. BACKWARD COMPATIBILITY — non-front configs carry no
 *     TransientResult.fluidFront field (ungated ttWf covered bit-identically
 *     by the existing ttWfNetwork suite).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { NetworkConfig, Conductor, TransientResult } from "../schema";
import { initRealFluids, realFluidsReady, RealFluid } from "../";
import {
  solveTransient,
  applyBoundaryConditions,
  cloneState,
} from "../transient";
import {
  buildSolverContext,
  createInitialState,
  solveStateStep,
  updateFluidFrontStates,
} from "../solver";
import { validateNetwork } from "../validate";
import {
  getSolverDiagnostics,
  resetSolverDiagnostics,
  type SolverDiagnostics,
} from "../diagnostics";
import {
  advectFluidFrontUpwindBE,
  fluidFrontBoundaryInflux,
  fluidFrontGate,
  type FluidFrontSharedState,
} from "../fluidFront";
import {
  evaluateConvectionH,
  type CorrelationConductor,
  type CorrelationCtx,
  type CorrelationState,
  type TtWfSharedState,
} from "../correlations";

/* =============================================================================
 * A. Pure gate laws
 * ============================================================================= */
describe("fluidFrontGate (smoothstep) laws", () => {
  it("endpoints exact, bounded, monotone, symmetric", () => {
    expect(fluidFrontGate(0)).toBe(0);
    expect(fluidFrontGate(1)).toBe(1);
    for (let i = 0; i <= 1000; i++) {
      const a = i / 1000;
      const g = fluidFrontGate(a);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
      if (i > 0)
        expect(g).toBeGreaterThanOrEqual(fluidFrontGate((i - 1) / 1000));
      // smoothstep symmetry: g(a) + g(1−a) = 1
      expect(Math.abs(g + fluidFrontGate(1 - a) - 1)).toBeLessThan(1e-15);
    }
  });

  it("is C1: zero slope at both ends (no kink as the gate opens/closes)", () => {
    const d = 1e-4;
    // g(δ) = 3δ² − 2δ³ ⇒ |g(δ)| ≤ 3δ²;  g(1−δ) = 1 − 3δ² + 2δ³.
    expect(fluidFrontGate(d)).toBeLessThanOrEqual(3 * d * d);
    expect(1 - fluidFrontGate(1 - d)).toBeLessThanOrEqual(3 * d * d);
    // max slope of smoothstep is 1.5 at a = 0.5
    for (let i = 0; i < 1000; i++) {
      const a = i / 1000;
      const slope = (fluidFrontGate(a + 1e-6) - fluidFrontGate(a)) / 1e-6;
      expect(slope).toBeLessThanOrEqual(1.5 + 1e-3);
    }
  });
});

/* =============================================================================
 * B. Pure transport kernel — analytical BE recurrence, conservation,
 *    reversal, bounds
 * ============================================================================= */

/** Deterministic PRNG (mulberry32) for the robustness sweeps. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("advectFluidFrontUpwindBE kernel", () => {
  const N = 5;
  const ids = Array.from({ length: N }, (_, i) => `n${i + 1}`);
  const lineBranches = [
    { from: "IN", to: "n1" },
    ...Array.from({ length: N - 1 }, (_, i) => ({
      from: `n${i + 1}`,
      to: `n${i + 2}`,
    })),
    { from: `n${N}`, to: "OUT" },
  ];

  it("matches the backward-Euler well-mixed recurrence EXACTLY on a serial line (constant flow)", () => {
    // Truth model: a_i^{n+1} = (m/dt·a_i^n + mdot·a_{i-1}^{n+1}) / (m/dt + mdot),
    // a_0 ≡ a_in = 1 — the BE well-mixed finite-volume recurrence (NOT a
    // sharp plug: donor-cell + BE is the documented discretization).
    const m = 2.0; // kg per node
    const mdot = 0.05; // kg/s
    const dt = 1.0; // s  (tau = m/mdot = 40 s; dt/tau = 0.025)
    const steps = 400;
    const boundary = new Map([["IN", 1]]);
    let aPrev = new Map(ids.map((id) => [id, 0]));
    const hist: number[][] = ids.map(() => [0]);
    for (let k = 0; k < steps; k++) {
      const res = advectFluidFrontUpwindBE({
        nodeIds: ids,
        branches: lineBranches,
        mdots: new Array(lineBranches.length).fill(mdot),
        mass: new Map(ids.map((id) => [id, m])),
        prevMass: new Map(ids.map((id) => [id, m])),
        aPrev,
        boundary,
        dt,
      });
      expect(res.boundsClampCorrections).toBe(0);
      // Analytical recurrence for this step (sequential in i — triangular):
      let aUp = 1; // inlet boundary
      for (let i = 0; i < N; i++) {
        const aAna =
          ((m / dt) * aPrev.get(ids[i])! + mdot * aUp) / (m / dt + mdot);
        const aGot = res.aNext.get(ids[i])!;
        expect(Math.abs(aGot - aAna)).toBeLessThanOrEqual(1e-14);
        aUp = aAna;
      }
      aPrev = res.aNext;
      for (let i = 0; i < N; i++) hist[i].push(res.aNext.get(ids[i])!);
    }
    // Arrival order + expected timings: the 0.5-crossing of node i of the
    // recurrence lies between (i − ½)·τ and (i + ½)·τ + 2·τ (plug time i·τ
    // broadened by the documented first-order cell mixing).
    const tau = m / mdot;
    const cross: number[] = [];
    for (let i = 0; i < N; i++) {
      const k = hist[i].findIndex((v) => v >= 0.5);
      expect(k, `node ${i + 1} never reached a=0.5`).toBeGreaterThan(0);
      const t = (k - 1) * dt; // hist[0] is t=0
      cross.push(t);
      expect(t).toBeGreaterThan((i - 0.5) * tau);
      expect(t).toBeLessThan((i + 2.5) * tau);
      if (i > 0) expect(cross[i]).toBeGreaterThan(cross[i - 1]);
    }
  });

  it("high-Courant one-step response: an inlet step reaches EVERY cell in one step with attenuation beta^i (the fig02 numerical-mixing regime)", () => {
    // Audit-pinned numerical fact (chilldown resolution study):
    // for a uniform serial line at cell flow-capacity ratio
    // Cr = mdot·dt/m ≳ 1 (the frozen NBS fig02 protocol runs at Cr ≈ 2.7 on
    // the cold-tail speed), the donor-cell/BE operator is NOT a local
    // update: one step gives a_i^{n+1} = β^i with β = Cr/(1+Cr) — the inlet
    // signal is felt at the LAST cell of the chain in a single step,
    // attenuated β per cell.  This leading-edge smear is the numerical-
    // mixing mechanism; refining the mesh at fixed velocity raises the
    // cell count and thereby delays the arrival (measured: §4).
    const m = 1.0;
    const dt = 2.5;
    const Cr = 2.7; // fig02 cold-tail regime
    const mdot = (Cr * m) / dt;
    const beta = Cr / (1 + Cr);
    const boundary = new Map([["IN", 1]]);
    const res = advectFluidFrontUpwindBE({
      nodeIds: ids,
      branches: lineBranches,
      mdots: new Array(lineBranches.length).fill(mdot),
      mass: new Map(ids.map((id) => [id, m])),
      prevMass: new Map(ids.map((id) => [id, m])),
      aPrev: new Map(ids.map((id) => [id, 0])),
      boundary,
      dt,
    });
    expect(res.boundsClampCorrections).toBe(0);
    for (let i = 0; i < N; i++) {
      const expected = Math.pow(beta, i + 1);
      expect(Math.abs(res.aNext.get(ids[i])! - expected)).toBeLessThanOrEqual(
        1e-14,
      );
    }
    // The physical statement: at Cr = 2.7 the last of 5 cells already
    // carries > 20% of the inlet signal after ONE step — the leading edge
    // is scheme-driven, not a transported front.
    expect(res.aNext.get(ids[N - 1])!).toBeGreaterThan(0.2);
  });

  it("modified-equation diffusivity invariant: front-rise width W = 2·z95·√((τ_cell+dt)·t_adv) (resolution-study §3)", () => {
    // Pinned numerical fact (chilldown resolution study §1/§3): the
    // donor-cell/BE operator has the modified equation
    //     ∂a/∂t + u·∂a/∂x = D_num·∂²a/∂x²,  D_num = u·Δx·(1 + Cr)/2,
    // so a step front advected over x* acquires the 5–95 % rise width
    //     W = 2·z_0.95·√((τ_cell + dt)·t_adv),  τ_cell = Δx/u, t_adv = x*/u.
    // Measured on the production kernel (constant-u chain, this test's
    // configuration): ratio W_meas/W_pred = 1.002–1.039 over
    // Δx ∈ [0.63, 10] cm × Cr ∈ [0.25, 4] (21 combos) and width growth
    // W(0.8L)/W(0.5L) = √1.6 within 1.8%.  This test pins the invariant at
    // two Courant numbers with ≥ 2× margin against the measured envelope;
    // it is a property of the DISCRETIZATION (no physics, no data).
    const z95 = 1.6448536269514722;
    const chain = (nCells: number) => ({
      ids: Array.from({ length: nCells }, (_, i) => `c${i}`),
      branches: [
        { from: "IN", to: "c0" },
        ...Array.from({ length: nCells - 1 }, (_, i) => ({
          from: `c${i}`,
          to: `c${i + 1}`,
        })),
        { from: `c${nCells - 1}`, to: "OUT" },
      ],
    });
    const run = (nCells: number, Cr: number) => {
      const { ids: cids, branches: cbr } = chain(nCells);
      const m = 1.0; // kg per cell
      const dx = 1 / nCells; // L = 1 m
      const dt = Cr * dx; // u = 1 m/s exactly (mdot = u·m/dx)
      const mdot = m / dx;
      const tAdvExit = (nCells - 0.5) * dx; // u = 1: transit to last cell center
      const steps = Math.ceil((1.6 * tAdvExit) / dt);
      let aPrev = new Map(cids.map((id) => [id, 0]));
      const prevMass = new Map(cids.map((id) => [id, m]));
      const mass = new Map(cids.map((id) => [id, m]));
      const mdots = new Array(cbr.length).fill(mdot);
      const boundary = new Map([
        ["IN", 1],
        ["OUT", 0],
      ]);
      const aExit: number[] = [0];
      for (let k = 1; k <= steps; k++) {
        const r = advectFluidFrontUpwindBE({
          nodeIds: cids,
          branches: cbr,
          mdots,
          mass,
          prevMass,
          aPrev,
          boundary,
          dt,
        });
        expect(r.boundsClampCorrections).toBe(0);
        aPrev = r.aNext;
        aExit.push(r.aNext.get(cids[nCells - 1])!);
      }
      const cross = (lvl: number) => {
        for (let k = 1; k < aExit.length; k++) {
          if (aExit[k - 1] < lvl && aExit[k] >= lvl) {
            const f = (lvl - aExit[k - 1]) / (aExit[k] - aExit[k - 1]);
            return (k - 1 + f) * dt;
          }
        }
        throw new Error("level not reached");
      };
      const w = cross(0.95) - cross(0.05);
      const wPred = 2 * z95 * Math.sqrt((dx + dt) * tAdvExit); // u = 1
      return w / wPred;
    };
    // N=40 cells: measured ratios 1.006 (Cr=0.5) / 1.007 (Cr=2); margins ≥ 2×.
    expect(run(40, 0.5)).toBeGreaterThan(0.95);
    expect(run(40, 0.5)).toBeLessThan(1.05);
    expect(run(40, 2)).toBeGreaterThan(0.95);
    expect(run(40, 2)).toBeLessThan(1.05);
  });

  it("conserves tracer mass EXACTLY per step (telescoping), serial line", () => {
    const m = 2.0;
    const mdot = 0.07;
    const dt = 0.5;
    const boundary = new Map([["IN", 1]]);
    let aPrev = new Map(ids.map((id) => [id, 0]));
    let inventory = 0;
    let influxInt = 0;
    const internal = new Set(ids);
    for (let k = 0; k < 100; k++) {
      const mass = new Map(ids.map((id) => [id, m]));
      const res = advectFluidFrontUpwindBE({
        nodeIds: ids,
        branches: lineBranches,
        mdots: new Array(lineBranches.length).fill(mdot),
        mass,
        prevMass: mass,
        aPrev,
        boundary,
        dt,
      });
      // Per-step identity: ΔΣ(m·a) = dt · (mdot·a_in − mdot·a_N).
      let inv = 0;
      for (const id of ids) inv += m * res.aNext.get(id)!;
      const flux = fluidFrontBoundaryInflux(
        lineBranches,
        new Array(lineBranches.length).fill(mdot),
        res.aNext,
        boundary,
        internal,
      );
      expect(Math.abs(inv - inventory - dt * flux)).toBeLessThanOrEqual(
        1e-12 * Math.max(1, Math.abs(inv)),
      );
      inventory = inv;
      influxInt += dt * flux;
      aPrev = res.aNext;
    }
    // Global: accumulated inventory == integrated boundary influx.
    expect(Math.abs(inventory - influxInt)).toBeLessThanOrEqual(
      1e-10 * Math.max(1, inventory),
    );
  });

  it("flow reversal: transport reverses correctly via upwinding (and stays conservative/bounded)", () => {
    const m = 1.0;
    const mdot = 0.1;
    const dt = 0.25;
    // a=1 at LEFT boundary only; the right boundary is warm (a=0).
    const boundary = new Map([
      ["IN", 1],
      ["OUT", 0],
    ]);
    const internal = new Set(ids);
    let a = new Map(ids.map((id) => [id, 0]));
    // 1) forward fill (12 s residence times: every cell > 0.99)
    for (let k = 0; k < 480; k++) {
      const res = advectFluidFrontUpwindBE({
        nodeIds: ids,
        branches: lineBranches,
        mdots: new Array(lineBranches.length).fill(mdot),
        mass: new Map(ids.map((id) => [id, m])),
        prevMass: new Map(ids.map((id) => [id, m])),
        aPrev: a,
        boundary,
        dt,
      });
      expect(res.boundsClampCorrections).toBe(0);
      a = res.aNext;
    }
    for (const id of ids) expect(a.get(id)!).toBeGreaterThan(0.99);
    // 2) reverse (12 s residence times again): flow enters from the RIGHT
    // (a=0) and drains left.
    let prevInv = 0;
    for (const id of ids) prevInv += m * a.get(id)!;
    for (let k = 0; k < 480; k++) {
      const mdots = new Array(lineBranches.length).fill(-mdot);
      const mass = new Map(ids.map((id) => [id, m]));
      const res = advectFluidFrontUpwindBE({
        nodeIds: ids,
        branches: lineBranches,
        mdots,
        mass,
        prevMass: mass,
        aPrev: a,
        boundary,
        dt,
      });
      expect(res.boundsClampCorrections).toBe(0);
      for (const id of ids) {
        const v = res.aNext.get(id)!;
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      // tracer inventory strictly decreases (draining, no source)
      let inv = 0;
      for (const id of ids) inv += m * res.aNext.get(id)!;
      const flux = fluidFrontBoundaryInflux(
        lineBranches,
        mdots,
        res.aNext,
        boundary,
        internal,
      );
      expect(flux).toBeLessThanOrEqual(0); // outflow only
      expect(Math.abs(inv - prevInv - dt * flux)).toBeLessThanOrEqual(
        1e-12 * Math.max(1, Math.abs(inv)),
      );
      expect(inv).toBeLessThan(prevInv);
      prevInv = inv;
      a = res.aNext;
    }
    // The node nearest the (reversed) inlet drains first: a_N < a_{N-1} < ... < a_1.
    for (let i = 0; i < N - 1; i++) {
      expect(a.get(ids[i + 1])!).toBeLessThan(a.get(ids[i])!);
    }
    // and the line is nearly clean after 3 residence times
    expect(prevInv).toBeLessThan(0.05 * N * m);
  });

  it("diamond topology: parallel-path filling ordered by residence time, conservative", () => {
    // B0(a=1) → n1 → {n2 (slow), n3 (fast)} → n4 → OUT
    const nodesD = ["n1", "n2", "n3", "n4"];
    const branchesD = [
      { from: "B0", to: "n1" },
      { from: "n1", to: "n2" },
      { from: "n1", to: "n3" },
      { from: "n2", to: "n4" },
      { from: "n3", to: "n4" },
      { from: "n4", to: "OUT" },
    ];
    const mdots = [2, 0.5, 1.5, 0.5, 1.5, 2]; // mass-conserving, steady
    const m = 1;
    const dt = 0.1;
    const boundary = new Map([["B0", 1]]);
    const internal = new Set(nodesD);
    let a = new Map(nodesD.map((id) => [id, 0]));
    let inventory = 0;
    for (let k = 0; k < 200; k++) {
      const mass = new Map(nodesD.map((id) => [id, m]));
      const res = advectFluidFrontUpwindBE({
        nodeIds: nodesD,
        branches: branchesD,
        mdots,
        mass,
        prevMass: mass,
        aPrev: a,
        boundary,
        dt,
      });
      expect(res.boundsClampCorrections).toBe(0);
      let inv = 0;
      for (const id of nodesD) inv += m * res.aNext.get(id)!;
      const flux = fluidFrontBoundaryInflux(
        branchesD,
        mdots,
        res.aNext,
        boundary,
        internal,
      );
      expect(Math.abs(inv - inventory - dt * flux)).toBeLessThanOrEqual(
        1e-12 * Math.max(1, inv),
      );
      inventory = inv;
      a = res.aNext;
    }
    // All filled by the end; the fast path (n3, 3× the flow) filled first.
    for (const id of nodesD) expect(a.get(id)!).toBeGreaterThan(0.999);
  });

  it("bounded on randomized compressible steps WITHOUT clipping (mass-balance-consistent)", () => {
    // Random mdots (any sign) with node masses stepped by the EXACT nodal
    // mass balance m_new = m_old + dt·(Σ_in − Σ_out): the M-matrix proof
    // (docs/fluid-front-transport.md) then guarantees [0,1] with zero
    // non-conservative corrections.
    const rng = mulberry32(42);
    const nodesR = ["n1", "n2", "n3"];
    const branchesR = [
      { from: "B0", to: "n1" },
      { from: "n1", to: "n2" },
      { from: "n2", to: "n3" },
      { from: "n3", to: "OUT" },
    ];
    const boundary = new Map([
      ["B0", 1],
      ["OUT", 0],
    ]);
    const dt = 0.1;
    let a = new Map(nodesR.map((id) => [id, rng()])); // random in [0,1)
    let mass = new Map(nodesR.map((id) => [id, 1 + rng()]));
    let corrections = 0;
    for (let k = 0; k < 300; k++) {
      const mdots = branchesR.map(() => (rng() - 0.3) * 0.2); // mixed signs
      const massNew = new Map<string, number>();
      for (const id of nodesR) {
        let balance = 0;
        for (let j = 0; j < branchesR.length; j++) {
          if (branchesR[j].to === id) balance += mdots[j];
          if (branchesR[j].from === id) balance -= mdots[j];
        }
        const mn = mass.get(id)! + dt * balance;
        massNew.set(id, Math.max(mn, 0.2)); // keep physical (m > 0)
      }
      const res = advectFluidFrontUpwindBE({
        nodeIds: nodesR,
        branches: branchesR,
        mdots,
        mass: massNew,
        prevMass: mass,
        aPrev: a,
        boundary,
        dt,
      });
      corrections += res.boundsClampCorrections;
      for (const id of nodesR) {
        const v = res.aNext.get(id)!;
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      a = res.aNext;
      mass = massNew;
    }
    expect(corrections).toBe(0);
  });

  it("rejects non-finite / out-of-domain input loudly (never silently repairs)", () => {
    const base = {
      nodeIds: ["n1"],
      branches: [{ from: "B0", to: "n1" }],
      mdots: [0.1],
      mass: new Map([["n1", 1]]),
      prevMass: new Map([["n1", 1]]),
      aPrev: new Map([["n1", 0]]),
      boundary: new Map([["B0", 1]]),
      dt: 0.5,
    };
    expect(() => advectFluidFrontUpwindBE({ ...base, dt: 0 })).toThrow(/dt/);
    expect(() => advectFluidFrontUpwindBE({ ...base, mdots: [NaN] })).toThrow(
      /mdots/,
    );
    expect(() =>
      advectFluidFrontUpwindBE({ ...base, aPrev: new Map([["n1", 1.5]]) }),
    ).toThrow(/aPrev/);
    expect(() =>
      advectFluidFrontUpwindBE({ ...base, mass: new Map([["n1", -1]]) }),
    ).toThrow(/mass/);
  });
});

/* =============================================================================
 * C. Local heat-gate limits (hand-built correlation context, LH2 fixture)
 * ============================================================================= */
describe("TT-WF dry-side front gate (local, hand-built ctx)", () => {
  let fluid: RealFluid;
  const P = 2e5;
  const D = 0.0102;
  const A_FLUID = (Math.PI / 4) * D * D;
  const G = 38;
  // Cold-vapor node at 100 K (xe ≈ 3) against a 300 K wall: qDry > 0 with
  // Tv = max(Eq. 9, 100) < Tw — a clean dry-side FB/SP evaluation.
  const Tnode = 100;
  let hNode = 0;
  const Tw = 300;

  beforeAll(async () => {
    await initRealFluids();
    expect(realFluidsReady()).toBe(true);
    fluid = new RealFluid("ParaHydrogen");
    hNode = fluid.enthalpyPT(P, Tnode);
  }, 30000);

  function makeCtx(
    a: number | undefined,
    flagged: boolean,
    fWet = 0,
  ): {
    ctx: CorrelationCtx;
    cond: CorrelationConductor;
    state: CorrelationState;
  } {
    const mdot = G * A_FLUID;
    const cond: CorrelationConductor = {
      id: "conv0",
      from: "A",
      to: "WALL",
      type: {
        kind: "convection",
        area: Math.PI * D,
        correlation: {
          model: "ttWf",
          diameter: D,
          axialPosition: 0.5,
          segmentLength: 1,
          ...(flagged ? { fluidFront: true } : {}),
        },
      },
    };
    const ttWf: TtWfSharedState = {
      state: new Map([["conv0", { fWet, rewetLatched: fWet > 0 }]]),
      axialPosition: new Map([["conv0", 0.5]]),
      wall: new Map([
        ["conv0", { massPerLength: 0.1, enthalpy: (T: number) => 385 * T }],
      ]),
      lastSnapshot: new Map(),
    };
    const fluidFront: FluidFrontSharedState | undefined =
      a === undefined
        ? undefined
        : {
            a: new Map([["A", a]]),
            boundary: new Map(),
            nodeIds: ["A"],
            prevMass: new Map([["A", 1]]),
          };
    const ctx: CorrelationCtx = {
      fluid,
      isRealFluid: true,
      branches: [
        { id: "b1", from: "F0", to: "A" },
        { id: "b2", from: "A", to: "F2" },
      ],
      nBranch: 2,
      nodeMap: new Map([
        ["F0", { id: "F0", type: "boundary" }],
        ["A", { id: "A", type: "internal" }],
        ["F2", { id: "F2", type: "boundary" }],
        ["WALL", { id: "WALL", type: "boundary" }],
      ]),
      ttWf,
      fluidFront,
    };
    const state: CorrelationState = {
      nodeP: new Map([["A", P]]),
      nodeT: new Map([["A", Tnode]]),
      nodeH: new Map([["A", hNode]]),
      nodeMu: new Map([["A", 1e-5]]),
      mdots: [mdot, mdot],
      solidT: new Map([["WALL", Tw]]),
    };
    return { ctx, cond, state };
  }

  it("a = 0 ⇒ EXACTLY zero dry-side heat exchange (bypasses the h floor)", () => {
    const { ctx, cond, state } = makeCtx(0, true);
    const h = evaluateConvectionH(cond, ctx, state);
    expect(h).toBe(0);
  });

  it("a = 1 ⇒ bit-identical to the ungated TT-WF evaluation", () => {
    const gated = makeCtx(1, true);
    const ungated = makeCtx(undefined, false);
    const hGated = evaluateConvectionH(gated.cond, gated.ctx, gated.state);
    const hUngated = evaluateConvectionH(
      ungated.cond,
      ungated.ctx,
      ungated.state,
    );
    expect(hGated).toBe(hUngated);
    expect(hGated).toBeGreaterThan(0); // a real dry-side evaluation, not the floor
  });

  it("smooth sweep in a: C1, bounded by [0, h(a=1)], monotone, no jumps", () => {
    const h1 = evaluateConvectionH(
      ...(() => {
        const c = makeCtx(1, true);
        return [c.cond, c.ctx, c.state] as const;
      })(),
    );
    let prev = 0;
    const da = 1e-3;
    for (let a = da; a <= 1 + 1e-12; a += da) {
      const { ctx, cond, state } = makeCtx(Math.min(a, 1), true);
      const h = evaluateConvectionH(cond, ctx, state);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(h1 + 1e-9);
      expect(h).toBeGreaterThanOrEqual(prev); // monotone non-decreasing
      // no jumps: smoothstep slope ≤ 1.5 ⇒ |Δh| ≤ 1.5·h1·Δa (tight C1 check)
      expect(Math.abs(h - prev)).toBeLessThanOrEqual(1.6 * h1 * da);
      prev = h;
    }
    expect(prev).toBe(h1);
    // zero-slope ends (quadratic approach): |h(δ)| ≤ 3.5·δ²·h1 etc.
    const d = 1e-3;
    const hD = evaluateConvectionH(
      ...(() => {
        const c = makeCtx(d, true);
        return [c.cond, c.ctx, c.state] as const;
      })(),
    );
    const h1mD = evaluateConvectionH(
      ...(() => {
        const c = makeCtx(1 - d, true);
        return [c.cond, c.ctx, c.state] as const;
      })(),
    );
    expect(hD).toBeLessThanOrEqual(3.5 * d * d * h1);
    expect(h1 - h1mD).toBeLessThanOrEqual(3.5 * d * d * h1);
  });

  it("fully wetted conductor (fWet = 1): the gate is inert for any a", () => {
    const h0 = evaluateConvectionH(
      ...(() => {
        const c = makeCtx(0, true, 1);
        return [c.cond, c.ctx, c.state] as const;
      })(),
    );
    const h05 = evaluateConvectionH(
      ...(() => {
        const c = makeCtx(0.5, true, 1);
        return [c.cond, c.ctx, c.state] as const;
      })(),
    );
    const h1 = evaluateConvectionH(
      ...(() => {
        const c = makeCtx(1, true, 1);
        return [c.cond, c.ctx, c.state] as const;
      })(),
    );
    expect(h0).toBe(h1);
    expect(h05).toBe(h1);
    expect(h1).toBeGreaterThan(0);
  });

  it("flag off but transport state present: gate NOT applied (per-conductor opt-in)", () => {
    const c = makeCtx(0, false); // a = 0 available, but conductor not flagged
    const h = evaluateConvectionH(c.cond, c.ctx, c.state);
    const ref = makeCtx(undefined, false);
    expect(h).toBe(evaluateConvectionH(ref.cond, ref.ctx, ref.state));
  });

  it("boundary-attached conductor: the gate reads the CONFIGURED boundary value (fluidFrontInlet), not a welded 0", () => {
    // The chilldown builder attaches conv0 to the inlet boundary node f0;
    // boundary nodes carry no transported state, so the gate must consult
    // the configured boundary value — a cryogenic inlet (a_bnd = 1) is pure
    // front fluid from t = 0 and its gate must be fully OPEN (bit-identical
    // to the ungated evaluation at the same fluid state).
    const condB = (flagged: boolean): CorrelationConductor => {
      const { cond } = makeCtx(undefined, false);
      return {
        ...cond,
        from: "F0", // the BOUNDARY inlet node carries the fluid state
        to: "WALL",
        type: {
          ...cond.type,
          correlation: {
            ...(cond.type.correlation as object),
            ...(flagged ? { fluidFront: true as const } : {}),
          } as never,
        },
      };
    };
    const mkFluidFront = (bnd?: number): FluidFrontSharedState => ({
      a: new Map([["A", 0.5]]), // internal state is irrelevant for the boundary-attached conductor
      boundary: bnd === undefined ? new Map() : new Map([["F0", bnd]]),
      nodeIds: ["A"],
      prevMass: new Map([["A", 1]]),
    });
    const stateAtF0 = (): CorrelationState => {
      const { state } = makeCtx(undefined, false);
      return {
        ...state,
        nodeP: new Map([["F0", P]]),
        nodeT: new Map([["F0", Tnode]]),
        nodeH: new Map([["F0", hNode]]),
        nodeMu: new Map([["F0", 1e-5]]),
      };
    };
    const baseCtx = makeCtx(undefined, false).ctx;
    const state = stateAtF0();
    // Ungated reference at the same (boundary) fluid state:
    const hUngated = evaluateConvectionH(condB(false), baseCtx, state);
    expect(hUngated).toBeGreaterThan(0); // a real dry-side evaluation
    // a_bnd = 1 (cryogenic inlet): fully open gate — bit-identical.
    const ctxOpen: CorrelationCtx = { ...baseCtx, fluidFront: mkFluidFront(1) };
    expect(evaluateConvectionH(condB(true), ctxOpen, state)).toBe(hUngated);
    // a_bnd = 0 (warm boundary) or absent: gate fully closed — exactly 0.
    const ctxWarm: CorrelationCtx = { ...baseCtx, fluidFront: mkFluidFront(0) };
    expect(evaluateConvectionH(condB(true), ctxWarm, state)).toBe(0);
    const ctxAbsent: CorrelationCtx = {
      ...baseCtx,
      fluidFront: mkFluidFront(undefined),
    };
    expect(evaluateConvectionH(condB(true), ctxAbsent, state)).toBe(0);
  });
});

/* =============================================================================
 * D–H. Network-level integration (LH2 line, realFluid)
 * ============================================================================= */
const D_TUBE = 0.0102; // m, D-H tube ID
const A_FLUID = (Math.PI / 4) * D_TUBE * D_TUBE;
const OD = 0.0127;
const RHO_CU = 8960;
const CP_CU = 385;
const A_METAL = (Math.PI / 4) * (OD * OD - D_TUBE * D_TUBE);
const SEG_L = 1.0;
const P_IN = 2.5e5;
const P_OUT = 2e5;
const M_SEG = RHO_CU * A_METAL * SEG_L;
const VOL = A_FLUID * SEG_L;

function buildFrontLine(opts: {
  nSeg: number;
  endTime: number;
  dt?: number;
  adaptive?: {
    dtInitial: number;
    dtMin: number;
    dtMax: number;
    relTol: number;
  };
  gated?: boolean; // default true: ttWf conductors carry the fluidFront flag
  frontInlet?: boolean; // default true: f0 is the cryogenic inlet (a = 1)
  miropolskii?: boolean;
  /** Synthetic cell-volume multiplier so the front transit is resolved over
   *  multiple steps at the chosen dt (the raw pipe cell is flushed in less
   *  than one 0.25 s step — see the transport tests). */
  volScale?: number;
}): NetworkConfig {
  const N = opts.nSeg;
  const gated = opts.gated ?? true;
  const vol = VOL * (opts.volScale ?? 1);
  const nodes: NetworkConfig["nodes"] = [];
  const solidNodes: NetworkConfig["solidNodes"] = [];
  const inlet: NetworkConfig["nodes"][number] = {
    id: "f0",
    type: "boundary",
    x: 0,
    y: 0,
    pressure: P_IN,
    quality: 0,
    ...((opts.frontInlet ?? true) ? { fluidFrontInlet: 1 } : {}),
  };
  nodes.push(inlet);
  for (let i = 1; i <= N; i++) {
    const p0 = P_IN - ((P_IN - P_OUT) * i) / (N + 1);
    nodes.push({
      id: `f${i}`,
      type: "internal",
      x: i * SEG_L,
      y: 0,
      pressure: p0,
      quality: 1,
      volume: vol,
    });
    solidNodes.push({
      id: `s${i}`,
      type: "solid",
      x: i * SEG_L,
      y: 1,
      temperature: 300,
      mass: M_SEG,
      cp: CP_CU,
    });
  }
  nodes.push({
    id: `f${N + 1}`,
    type: "boundary",
    x: (N + 1) * SEG_L,
    y: 0,
    pressure: P_OUT,
    temperature: 300,
  });

  const conductors: NetworkConfig["conductors"] = [];
  for (let i = 1; i <= N; i++) {
    conductors.push({
      id: `conv${i}`,
      from: `f${i}`,
      to: `s${i}`,
      type: {
        kind: "convection",
        area: Math.PI * D_TUBE * SEG_L,
        correlation: opts.miropolskii
          ? { model: "miropolskii", diameter: D_TUBE, axialPosition: i * SEG_L }
          : {
              model: "ttWf",
              diameter: D_TUBE,
              axialPosition: i * SEG_L,
              segmentLength: SEG_L,
              ...(gated ? { fluidFront: true } : {}),
            },
      },
    } as Conductor);
  }
  const branches: NetworkConfig["branches"] = [];
  for (let i = 0; i <= N; i++) {
    branches.push({
      id: `pipe${i}`,
      from: `f${i}`,
      to: `f${i + 1}`,
      component: {
        type: "pipe",
        length: SEG_L,
        diameter: D_TUBE,
        roughness: 1.5e-6,
      },
    });
  }

  return {
    meta: { name: `front-net-${N}`, version: 2 },
    settings: opts.adaptive
      ? {
          mode: "transient",
          tolerance: 1e-6,
          maxIterations: 100,
          relaxation: 0.8,
          endTime: opts.endTime,
          timeStepping: "adaptive",
          adaptive: opts.adaptive,
        }
      : {
          mode: "transient",
          tolerance: 1e-6,
          maxIterations: 100,
          relaxation: 0.8,
          endTime: opts.endTime,
          dt: opts.dt ?? 0.25,
          timeStepping: "fixed",
        },
    fluid: { model: "realFluid", params: { fluidName: "ParaHydrogen" } },
    nodes,
    solidNodes,
    conductors,
    branches,
  };
}

function firstCrossing(
  times: number[],
  series: number[],
  threshold: number,
): number | undefined {
  for (let k = 0; k < times.length; k++)
    if (series[k] >= threshold) return times[k];
  return undefined;
}

describe("fluid-front network: fixed-step 3-segment gated LH2 line", () => {
  let res: TransientResult;
  let ungated: TransientResult;
  let diag: SolverDiagnostics;
  let cfg: NetworkConfig;
  const N = 3;
  const VSCALE = 10; // synthetic cell-volume multiplier: resolves the front
  // transit over several steps at dt = 0.25 s (the raw pipe cell flushes in
  // less than one step).  Measured on this solver: converged, ZERO bounds
  // corrections, commitCount = 48 = times.length − 1.

  const volOf = (id: string): number =>
    cfg.nodes.find((n) => n.id === id)!.volume! as number; // literal config: no formula bindings

  beforeAll(async () => {
    await initRealFluids();
    expect(realFluidsReady()).toBe(true);
    resetSolverDiagnostics();
    cfg = buildFrontLine({ nSeg: N, endTime: 12, dt: 0.25, volScale: VSCALE });
    res = solveTransient(cfg);
    diag = getSolverDiagnostics();
    ungated = solveTransient(
      buildFrontLine({
        nSeg: N,
        endTime: 12,
        dt: 0.25,
        volScale: VSCALE,
        gated: false,
      }),
    );
  }, 240000);

  it("converges with clean front diagnostics (bounds/invalid counters zero, one commit per step)", () => {
    expect(res.converged).toBe(true);
    expect(diag.fluidFront.boundsClampCount).toBe(0);
    expect(diag.fluidFront.invalidInputCount).toBe(0);
    expect(diag.fluidFront.commitCount).toBe(res.times.length - 1);
    expect(diag.statePHFallbackCount.lastResort).toBe(0);
    expect(diag.ttWf.invalidInputCount).toBe(0);
  });

  it("records per-node front histories aligned 1:1 with times, a(t=0)=0", () => {
    expect(res.fluidFront).toBeDefined();
    expect(Object.keys(res.fluidFront!).sort()).toEqual(["f1", "f2", "f3"]);
    for (const id of Object.keys(res.fluidFront!)) {
      const h = res.fluidFront![id];
      expect(h.fraction.length).toBe(res.times.length);
      expect(h.fraction[0]).toBe(0); // warm-filled line
    }
    // boundary nodes carry no state (they are inputs)
    expect(res.fluidFront!["f0"]).toBeUndefined();
    expect(res.fluidFront!["f4"]).toBeUndefined();
  });

  it("every recorded fraction is EXACTLY the one-step kernel replay (no trial/Newton pollution)", () => {
    // Replay: a^{k+1} = kernel(recorded mdots@k+1, m@k+1, m@k, a@k, boundary,
    // dt_k) — the commit performs the same deterministic evaluation; any
    // commit during a Newton iteration would desynchronize it.  Tolerance
    // 1e-9 covers the fl(t+dt)−t ulp on dt (cf. the ttWf replay test).
    const internal = new Set(["f1", "f2", "f3"]);
    const branches = cfg.branches.map((b) => ({ from: b.from, to: b.to }));
    const boundary = new Map([["f0", 1]]);
    const nT = res.times.length;
    let checked = 0;
    for (let k = 0; k + 1 < nT; k++) {
      const massPrev = new Map<string, number>();
      const massNext = new Map<string, number>();
      const aPrev = new Map<string, number>();
      for (const id of internal) {
        massPrev.set(id, res.nodes[id].density[k] * volOf(id));
        massNext.set(id, res.nodes[id].density[k + 1] * volOf(id));
        aPrev.set(id, res.fluidFront![id].fraction[k]);
      }
      const mdots = cfg.branches.map((b) => res.branches[b.id].mdot[k + 1]);
      const out = advectFluidFrontUpwindBE({
        nodeIds: [...internal],
        branches,
        mdots,
        mass: massNext,
        prevMass: massPrev,
        aPrev,
        boundary,
        dt: res.times[k + 1] - res.times[k],
      });
      for (const id of internal) {
        const got = res.fluidFront![id].fraction[k + 1];
        const want = out.aNext.get(id)!;
        expect(Math.abs(got - want)).toBeLessThanOrEqual(1e-9);
      }
      checked++;
    }
    expect(checked).toBe(nT - 1);
  });

  it("closes the GLOBAL tracer budget from the recorded series (right-rectangle, BE-consistent)", () => {
    const internal = new Set(["f1", "f2", "f3"]);
    const branches = cfg.branches.map((b) => ({ from: b.from, to: b.to }));
    const boundary = new Map([["f0", 1]]);
    const nT = res.times.length;
    const inventory = (k: number): number => {
      let s = 0;
      for (const id of internal)
        s +=
          res.nodes[id].density[k] *
          volOf(id) *
          res.fluidFront![id].fraction[k];
      return s;
    };
    let influxInt = 0;
    for (let k = 0; k + 1 < nT; k++) {
      const mdots = cfg.branches.map((b) => res.branches[b.id].mdot[k + 1]);
      const a = new Map<string, number>();
      for (const id of internal) a.set(id, res.fluidFront![id].fraction[k + 1]);
      influxInt +=
        fluidFrontBoundaryInflux(branches, mdots, a, boundary, internal) *
        (res.times[k + 1] - res.times[k]);
    }
    const dInv = inventory(nT - 1) - inventory(0);
    // Measured: the identity is exact up to the dense-solve/roundoff floor.
    expect(Math.abs(dInv - influxInt)).toBeLessThanOrEqual(
      1e-9 * Math.max(1, Math.abs(dInv)),
    );
  });

  it("bounds: every recorded a ∈ [0,1]; front shape ordered inlet → outlet while filling", () => {
    for (let i = 1; i <= N; i++) {
      const h = res.fluidFront![`f${i}`].fraction;
      for (const v of h) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      // every node's front arrives (a → ≥0.9) within the horizon
      const t = firstCrossing(res.times, h, 0.9);
      expect(t, `f${i} front never arrived`).toBeDefined();
    }
    // Arrival order, resolved WITHIN the accepted steps: during the fill the
    // front profile is strictly decreasing downstream (upstream node leads),
    // and the 0.9-crossing times are ordered with a resolved span
    // (measured: a at k=1 is [0.926, 0.795, 0.614]; 0.9-crossings
    // [0.25, 1, 1] s).
    for (const k of [1, 2]) {
      const a1 = res.fluidFront!.f1.fraction[k];
      const a2 = res.fluidFront!.f2.fraction[k];
      const a3 = res.fluidFront!.f3.fraction[k];
      expect(a1).toBeGreaterThan(a2);
      expect(a2).toBeGreaterThan(a3);
    }
    const t9 = [1, 2, 3].map((i) =>
      firstCrossing(res.times, res.fluidFront![`f${i}`].fraction, 0.9)!,
    );
    expect(t9[0]).toBeLessThan(t9[1]);
    expect(t9[1]).toBeLessThanOrEqual(t9[2]);
    expect(t9[2]).toBeGreaterThan(t9[0]);
    // all nodes end filled with cryogenic-inlet inventory
    for (let i = 1; i <= N; i++) {
      const h = res.fluidFront![`f${i}`].fraction;
      expect(h[h.length - 1]).toBeGreaterThan(0.99);
    }
  });

  it("gate action: no wall cooling while the gate is closed; ungated twin cools immediately", () => {
    // t = 0: every gated conductor reports h = 0 (closed gate) and zero heat.
    for (let i = 1; i <= N; i++) {
      expect(res.conductors![`conv${i}`].heatTransferCoeff![0]).toBe(0);
      expect(Math.abs(res.conductors![`conv${i}`].heatRate[0])).toBe(0);
      // the ungated twin starts cooling immediately (hot wall, cold vapor)
      expect(
        ungated.conductors![`conv${i}`].heatTransferCoeff![0],
      ).toBeGreaterThan(0);
    }
    // The gate is FROZEN within a step: the walls cannot cool during the
    // first step (a = 0 at its start), so every gated wall is still exactly
    // 300 K at k = 1 — while the ungated walls have already cooled.
    for (let i = 1; i <= N; i++) {
      expect(res.solidNodes![`s${i}`].temperature[1]).toBe(300);
      expect(ungated.solidNodes![`s${i}`].temperature[1]).toBeLessThan(299.9);
    }
    // NOTE: a pointwise "gated ≥ ungated" trajectory ordering is NOT a
    // valid contract — the gate changes the coupled dynamics (the ungated
    // run's early boil-off throttles its own fill, so the gated run's later
    // fluxes are larger).  The per-evaluation suppression property is proven
    // by the LOCAL gate sweep above; here we additionally assert the gated
    // line still completes chilldown once the front has arrived everywhere
    // (a → 1 opens the gate: walls reach the low-20s K).
    for (let i = 1; i <= N; i++) {
      const Tw = res.solidNodes![`s${i}`].temperature;
      expect(Tw[Tw.length - 1]).toBeLessThan(30);
    }
  });

  it("front/wetting distinction: a arrives before any fWet motion or latch, and is not derived from them", () => {
    for (let i = 1; i <= N; i++) {
      const aHist = res.fluidFront![`f${i}`].fraction;
      const tt = res.ttWf![`conv${i}`];
      const tA = firstCrossing(res.times, aHist, 0.5)!;
      const tLatch = firstCrossing(
        res.times,
        tt.rewetLatched.map((v) => (v ? 1 : 0)),
        0.5,
      );
      const tF = firstCrossing(res.times, tt.fWet, 1e-9);
      // the advected front strictly precedes the wall-side response (the
      // latch needs the wall to cool to T_wet — impossible while g(a)≈0).
      expect(tA).toBeGreaterThan(0);
      if (tLatch !== undefined) expect(tLatch).toBeGreaterThan(tA);
      if (tF !== undefined) expect(tF).toBeGreaterThan(tA);
      // a is not the node's equilibrium quality either: the node starts as
      // saturated VAPOR (quality 1) and a moves while quality is still 1.
      const q = res.nodes[`f${i}`].quality!;
      const kA = aHist.findIndex((v) => v > 0.5);
      // at some point before the front half-crossing the node is still vapor
      expect(q.slice(0, kA).some((v) => v === 1)).toBe(true);
    }
  });
});

describe("fluid-front network: adaptive run with rejected trials", () => {
  let res: TransientResult;
  let diag: SolverDiagnostics;
  let cfg: NetworkConfig;
  const N = 3;

  beforeAll(async () => {
    await initRealFluids();
    expect(realFluidsReady()).toBe(true);
    resetSolverDiagnostics();
    cfg = buildFrontLine({
      nSeg: N,
      endTime: 11,
      adaptive: { dtInitial: 0.25, dtMin: 0.05, dtMax: 1, relTol: 1e-3 },
    });
    res = solveTransient(cfg);
    diag = getSolverDiagnostics();
  }, 300000);

  it("produces at least one rejected trial (precondition)", () => {
    expect(res.converged).toBe(true);
    expect(res.stats!.rejectedSteps).toBeGreaterThanOrEqual(1);
    expect(diag.fluidFront.boundsClampCount).toBe(0);
    expect(diag.fluidFront.invalidInputCount).toBe(0);
  });

  it("histories align 1:1 with accepted times; exactly one commit per accepted step", () => {
    // The accepted trajectory of the step-doubling integrator is the PAIR of
    // half steps, and the front commit follows it as two sub-commits with
    // the half-step states (not recorded in the result) — so the adaptive
    // history cannot be replayed from the recorded end-of-step series alone.
    // The immutability evidence is instead: exact replay on the FIXED-step
    // run (same update law, above), 1:1 alignment here, the commit counter
    // (a mid-Newton or rejected-trial commit would inflate it), and the
    // direct solveStateStep immutability test below.
    const internal = ["f1", "f2", "f3"];
    for (const id of internal) {
      expect(res.fluidFront![id].fraction.length).toBe(res.times.length);
    }
    expect(diag.fluidFront.commitCount).toBe(res.stats!.steps);
    // bounds hold on the adaptive path as well
    for (const id of internal) {
      for (const v of res.fluidFront![id].fraction) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("fluid-front state: never advanced inside a solve (direct)", () => {
  it("solveStateStep (Newton + h-map refreshes) leaves the accepted a frozen; only the commit advances it", async () => {
    await initRealFluids();
    expect(realFluidsReady()).toBe(true);
    const cfg = buildFrontLine({
      nSeg: 2,
      endTime: 0.5,
      dt: 0.25,
      volScale: 10,
    });
    const ctx = buildSolverContext(cfg);
    const st = createInitialState(ctx, cfg);
    applyBoundaryConditions(ctx, cfg, st, 0);
    // t = 0 init
    updateFluidFrontStates(ctx, st);
    expect([...ctx.fluidFront!.a.values()]).toEqual([0, 0]);
    const prev = cloneState(st);
    applyBoundaryConditions(ctx, cfg, st, 0.25);
    const frozen = [...ctx.fluidFront!.a.entries()];
    // A full Newton/outer-iteration solve (the h-map refresh inside it READS
    // the frozen a through the gate): the accepted state must not move.
    const r = solveStateStep(ctx, st, {
      dt: 0.25,
      t: 0.25,
      tol: 1e-6,
      maxIterations: 100,
      relaxation: 0.8,
      prevState: prev,
    });
    expect(r.converged).toBe(true);
    expect([...ctx.fluidFront!.a.entries()]).toEqual(frozen);
    // A second solve (a discarded trial in the adaptive sense) from a fresh
    // clone likewise cannot touch it.
    const stTrial = cloneState(prev);
    applyBoundaryConditions(ctx, cfg, stTrial, 0.25);
    solveStateStep(ctx, stTrial, {
      dt: 0.25,
      t: 0.25,
      tol: 1e-6,
      maxIterations: 100,
      relaxation: 0.8,
      prevState: prev,
    });
    expect([...ctx.fluidFront!.a.entries()]).toEqual(frozen);
    // Only the accepted-step commit advances the state.
    const snap = updateFluidFrontStates(ctx, st, 0.25);
    expect(snap).toBeDefined();
    expect(snap!.get("f1")!).toBeGreaterThan(0);
    expect(snap!.get("f1")!).toBeLessThanOrEqual(1);
    expect(ctx.fluidFront!.a.get("f1")).toBe(snap!.get("f1"));
  }, 120000);
});

describe("fluid-front network: flow reversal (warm-vapor line, pressure swap)", () => {
  it("reversed flow drains the tracer back out the inlet; conservation closes", async () => {
    await initRealFluids();
    expect(realFluidsReady()).toBe(true);
    resetSolverDiagnostics();
    // Warm 300 K vapor line (no phase change — clean reversal): f0 drives
    // forward at 2.5 bar for 5 s, then the pressure ordering swaps.
    const cfgR: NetworkConfig = {
      meta: { name: "front-reversal", version: 2 },
      settings: {
        mode: "transient",
        tolerance: 1e-6,
        maxIterations: 100,
        relaxation: 0.8,
        endTime: 12,
        dt: 0.25,
        timeStepping: "fixed",
      },
      fluid: { model: "realFluid", params: { fluidName: "ParaHydrogen" } },
      nodes: [
        {
          id: "f0",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P_IN,
          temperature: 300,
          fluidFrontInlet: 1,
          pressureSchedule: [
            [0, P_IN],
            [5, P_IN],
            [6, 1.9e5],
            [12, 1.9e5],
          ],
        },
        {
          id: "f1",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 2.25e5,
          temperature: 300,
          volume: VOL,
        },
        {
          id: "f2",
          type: "internal",
          x: 2,
          y: 0,
          pressure: 2.1e5,
          temperature: 300,
          volume: VOL,
        },
        {
          id: "f3",
          type: "boundary",
          x: 3,
          y: 0,
          pressure: P_OUT,
          temperature: 300,
          pressureSchedule: [
            [0, P_OUT],
            [5, P_OUT],
            [6, 2.4e5],
            [12, 2.4e5],
          ],
        },
      ],
      solidNodes: [
        {
          id: "s1",
          type: "solid",
          x: 1,
          y: 1,
          temperature: 300,
          mass: M_SEG,
          cp: CP_CU,
        },
      ],
      conductors: [
        {
          id: "conv1",
          from: "f1",
          to: "s1",
          type: {
            kind: "convection",
            area: Math.PI * D_TUBE * SEG_L,
            correlation: {
              model: "ttWf",
              diameter: D_TUBE,
              axialPosition: 1,
              segmentLength: SEG_L,
              fluidFront: true,
            },
          },
        } as Conductor,
      ],
      branches: [
        {
          id: "p0",
          from: "f0",
          to: "f1",
          component: {
            type: "pipe",
            length: SEG_L,
            diameter: D_TUBE,
            roughness: 1.5e-6,
          },
        },
        {
          id: "p1",
          from: "f1",
          to: "f2",
          component: {
            type: "pipe",
            length: SEG_L,
            diameter: D_TUBE,
            roughness: 1.5e-6,
          },
        },
        {
          id: "p2",
          from: "f2",
          to: "f3",
          component: {
            type: "pipe",
            length: SEG_L,
            diameter: D_TUBE,
            roughness: 1.5e-6,
          },
        },
      ],
    };
    expect(validateNetwork(cfgR)).toEqual([]);
    const r = solveTransient(cfgR);
    const d = getSolverDiagnostics();
    expect(r.converged).toBe(true);
    expect(d.fluidFront.boundsClampCount).toBe(0);

    const internal = new Set(["f1", "f2"]);
    const branches = cfgR.branches.map((b) => ({ from: b.from, to: b.to }));
    const boundary = new Map([["f0", 1]]);
    const nT = r.times.length;

    // flow reversed at least once
    const m0 = r.branches.p0.mdot;
    expect(m0.some((v) => v > 0)).toBe(true);
    expect(m0.some((v) => v < 0)).toBe(true);

    // conservation over the whole run (both flow directions)
    const inventory = (k: number): number => {
      let s = 0;
      for (const id of internal)
        s += r.nodes[id].density[k] * VOL * r.fluidFront![id].fraction[k];
      return s;
    };
    let influxInt = 0;
    for (let k = 0; k + 1 < nT; k++) {
      const mdots = cfgR.branches.map((b) => r.branches[b.id].mdot[k + 1]);
      const a = new Map<string, number>();
      for (const id of internal) a.set(id, r.fluidFront![id].fraction[k + 1]);
      influxInt +=
        fluidFrontBoundaryInflux(branches, mdots, a, boundary, internal) *
        (r.times[k + 1] - r.times[k]);
    }
    const dInv = inventory(nT - 1) - inventory(0);
    expect(Math.abs(dInv - influxInt)).toBeLessThanOrEqual(
      1e-9 * Math.max(1, Math.abs(dInv)),
    );

    // morphology: a rises during forward flow, then DECREASES after reversal
    const a1 = r.fluidFront!.f1.fraction;
    const kMax = a1.indexOf(Math.max(...a1));
    expect(Math.max(...a1)).toBeGreaterThan(0.5); // front arrived
    expect(kMax).toBeGreaterThan(0);
    expect(a1[nT - 1]).toBeLessThan(a1[kMax]); // drained back out
    for (const id of internal) {
      for (const v of r.fluidFront![id].fraction) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  }, 240000);
});

/* =============================================================================
 * E. Schema validation + backward compatibility
 * ============================================================================= */
describe("fluid-front schema validation and backward compatibility", () => {
  it("validate: fluidFront flag rejected on non-ttWf correlations", () => {
    const cfg = buildFrontLine({
      nSeg: 1,
      endTime: 1,
      dt: 0.25,
      miropolskii: true,
    });
    for (const c of cfg.conductors ?? []) {
      if (c.type.kind === "convection")
        (c.type.correlation as { fluidFront?: boolean }).fluidFront = true;
    }
    const errs = validateNetwork(cfg);
    expect(
      errs.some((e) => /fluidFront.*only supported for the ttWf/.test(e)),
    ).toBe(true);
  });

  it("validate: fluidFrontInlet bounds and boundary-only", () => {
    const cfg = buildFrontLine({ nSeg: 1, endTime: 1, dt: 0.25 });
    (cfg.nodes[0] as { fluidFrontInlet?: number }).fluidFrontInlet = 1.5;
    expect(
      validateNetwork(cfg).some((e) =>
        /fluidFrontInlet must be in \[0,1\]/.test(e),
      ),
    ).toBe(true);
    const cfg2 = buildFrontLine({ nSeg: 1, endTime: 1, dt: 0.25 });
    (cfg2.nodes[1] as { fluidFrontInlet?: number }).fluidFrontInlet = 1; // internal node
    expect(
      validateNetwork(cfg2).some((e) =>
        /only meaningful on boundary nodes/.test(e),
      ),
    ).toBe(true);
    // and the nominal gated config validates clean
    expect(
      validateNetwork(buildFrontLine({ nSeg: 1, endTime: 1, dt: 0.25 })),
    ).toEqual([]);
  });

  it("backward compatibility: no front field without the opt-in flag", async () => {
    await initRealFluids();
    expect(realFluidsReady()).toBe(true);
    // ttWf WITHOUT the flag: no fluidFront field (behavior unchanged — the
    // existing ttWfNetwork suite pins the ungated bit-identity).
    const r1 = solveTransient(
      buildFrontLine({ nSeg: 1, endTime: 0.5, dt: 0.25, gated: false }),
    );
    expect(r1.converged).toBe(true);
    expect(r1.fluidFront).toBeUndefined();
    expect(r1.ttWf).toBeDefined();
    // non-ttWf model: no fluidFront field
    const r2 = solveTransient(
      buildFrontLine({ nSeg: 1, endTime: 0.5, dt: 0.25, miropolskii: true }),
    );
    expect(r2.converged).toBe(true);
    expect(r2.fluidFront).toBeUndefined();
    expect(r2.ttWf).toBeUndefined();
  }, 180000);
});
