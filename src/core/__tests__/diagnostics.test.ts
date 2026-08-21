/**
 * Baseline for the calibration pre-flight diagnostics (src/core/diagnostics.ts).
 *
 * Two gradient hazards are counted:
 *   1. hFloorClampCount — the FALLBACK_H_FLOOR clamp in evaluateConvectionH;
 *      while it binds, the correlation gradient w.r.t. its coefficients is
 *      exactly zero (clipped).
 *   2. statePHFallbackCount — safeStatePH's fallback tiers; the lastResort
 *      tier returns a physically-wrong finite state and silently corrupts
 *      results if it ever fires.
 *
 * This test establishes the CLEAN BASELINE: for the standard two-phase
 * chilldown run at nominal parameters (N=4, L=60.96 m, 0.5169 MPa driving,
 * 101325 Pa outlet — the audit/validation case) BOTH counters must be ZERO.
 * A later calibration study can assert the same across its parameter sweep.
 *
 * The unit tests below prove the counters actually fire when the hazard
 * occurs, so the zero baseline is not vacuous.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { describeSlow } from "../../testUtils/slow";
import { initRealFluids, realFluidsReady, RealFluid } from "../";
import { solveTransient } from "../transient";
import {
  getSolverDiagnostics,
  resetSolverDiagnostics,
  recordHFloorClamp,
  recordStatePHFallback,
} from "../diagnostics";
import { evaluateConvectionH, FALLBACK_H_FLOOR } from "../correlations";
import type {
  CorrelationConductor,
  CorrelationCtx,
  CorrelationState,
} from "../correlations";
import { buildAuditChilldownConfig } from "./helpers/chilldownAuditConfig";

beforeAll(async () => {
  await initRealFluids();
  expect(realFluidsReady()).toBe(true);
}, 30000);

describe("Solver diagnostics counters", () => {
  it("counter API: record, snapshot (deep copy), reset", () => {
    resetSolverDiagnostics();
    recordHFloorClamp();
    recordStatePHFallback("lastResort");
    recordStatePHFallback("propsSI");
    recordStatePHFallback("propsSI");
    const snap = getSolverDiagnostics();
    expect(snap.hFloorClampCount).toBe(1);
    expect(snap.statePHFallbackCount.lastResort).toBe(1);
    expect(snap.statePHFallbackCount.propsSI).toBe(2);
    // Snapshot is a deep copy — mutating it must not touch the live counters
    snap.hFloorClampCount = 999;
    snap.statePHFallbackCount.lastResort = 999;
    const snap2 = getSolverDiagnostics();
    expect(snap2.hFloorClampCount).toBe(1);
    expect(snap2.statePHFallbackCount.lastResort).toBe(1);
    resetSolverDiagnostics();
    const snap3 = getSolverDiagnostics();
    expect(snap3.hFloorClampCount).toBe(0);
    expect(snap3.statePHFallbackCount).toEqual({
      freshFactory: 0,
      propsSI: 0,
      saturationDome: 0,
      lastResort: 0,
    });
  });

  it("h-floor clamp counter fires when the clamp binds (zero baseline is not vacuous)", () => {
    resetSolverDiagnostics();
    // Real-fluid water, Dittus–Boelter, zero flow (G = 0): Nu = 3.66 (laminar
    // floor of the correlation) with k ≈ 0.6 W/mK and D = 1 m gives
    // hRaw ≈ 2.2 W/m²K < FALLBACK_H_FLOOR = 5, so the clamp must bind.
    const fluid = new RealFluid("Water");
    const cond: CorrelationConductor = {
      id: "conv0",
      from: "A",
      to: "WALL",
      type: {
        kind: "convection",
        area: 1,
        correlation: { model: "dittusBoelter", diameter: 1 },
      },
    };
    const ctx: CorrelationCtx = {
      fluid,
      isRealFluid: true,
      branches: [{ id: "b1", from: "A", to: "B" }],
      nBranch: 1,
      nodeMap: new Map([
        ["A", { id: "A", type: "internal" }],
        ["B", { id: "B", type: "boundary" }],
        ["WALL", { id: "WALL", type: "boundary" }],
      ]),
    };
    const P = 1e5;
    const T = 300;
    const state: CorrelationState = {
      nodeP: new Map([["A", P]]),
      nodeT: new Map([["A", T]]),
      nodeH: new Map([["A", fluid.enthalpyPT(P, T)]]),
      mdots: [0],
    };
    const h = evaluateConvectionH(cond, ctx, state);
    expect(h).toBe(FALLBACK_H_FLOOR); // clamped up to the floor
    expect(getSolverDiagnostics().hFloorClampCount).toBe(1);
    // A second evaluation at healthy flow must NOT bind the clamp
    const stateFlow: CorrelationState = { ...state, mdots: [5] };
    const hFlow = evaluateConvectionH(cond, ctx, stateFlow);
    expect(hFlow).toBeGreaterThan(FALLBACK_H_FLOOR);
    expect(getSolverDiagnostics().hFloorClampCount).toBe(1);
    resetSolverDiagnostics();
  });

  // SLOW (RUN_SLOW=1): the full N=4 audit chilldown costs ~125 s with the
  // honest-convergence cascade.  CI keeps the cheap counter-API tests above.
  describeSlow(
    "BASELINE: standard two-phase chilldown run at nominal parameters (slow)",
    () => {
      it("all counters ZERO", () => {
        resetSolverDiagnostics();
        const res = solveTransient(buildAuditChilldownConfig());
        expect(res.converged).toBe(true);
        const diag = getSolverDiagnostics();
        console.log("chilldown baseline diagnostics:", JSON.stringify(diag));
        // The h-floor clamp never binds: Miropolskii/Dittus–Boelter h stays above
        // FALLBACK_H_FLOOR for the whole run, so no correlation gradient is clipped.
        expect(diag.hFloorClampCount).toBe(0);
        // safeStatePH never leaves the primary CoolProp path — in particular the
        // physically-wrong lastResort tier never fires.
        expect(diag.statePHFallbackCount).toEqual({
          freshFactory: 0,
          propsSI: 0,
          saturationDome: 0,
          lastResort: 0,
        });
      }, 120000);
    },
  );
});
