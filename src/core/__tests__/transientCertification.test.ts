/**
 * transientCertification — `converged` on a transient step means the inner
 * Newton actually met the certifying bar, for every fluid model.
 *
 * Non-real-fluid transient steps used to be certified unconditionally, on
 * the argument that a small dt keeps the state near the previous solution.
 * That bounds the ERROR of an unconverged step, not the claim that it
 * converged, and it hid genuinely unsolvable steps. The network below is the
 * minimal such case: an incompressible column behind a closed valve, with a
 * fluid-inertia pipe whose ṁ(0) is left at the 0.1 kg/s warm-start default.
 * The first step must decelerate that flow to zero within one dt, which
 * needs a pressure below the solver's floor — the momentum row cannot be
 * balanced and the step is not a solution of the equations.
 */
import { describe, it, expect } from "vitest";
import { solveTransient } from "../transient";
import type { NetworkConfig } from "../schema";

const TOL = 1e-6;
/** Certifying scaled-residual bar of solver/step.ts (tol × 1e3). */
const SCALED_BAR = TOL * 1e3;

function closedValveColumn(initialMdot?: number): NetworkConfig {
  return {
    meta: { name: "closed valve column", version: 2 },
    settings: {
      mode: "transient",
      dt: 0.01,
      endTime: 0.05,
      timeStepping: "fixed",
      tolerance: TOL,
      maxIterations: 200,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "tank",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 7e5,
        temperature: 300,
      },
      {
        id: "mid",
        type: "internal",
        x: 100,
        y: 0,
        pressure: 1e5,
        temperature: 300,
        volume: 1e-3,
      },
      {
        id: "out",
        type: "boundary",
        x: 200,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "valve",
        from: "tank",
        to: "mid",
        component: {
          type: "valve",
          area: 5e-4,
          cd: 0.6,
          position: 0,
        },
      },
      {
        id: "line",
        from: "mid",
        to: "out",
        ...(initialMdot !== undefined ? { initialMdot } : {}),
        // L/A ≈ 1.9e4 m⁻¹: decelerating 0.1 kg/s to rest in 10 ms asks for
        // a 1.9e5 Pa drop, more than the 1e5 Pa the outlet can supply.
        component: {
          type: "pipe",
          length: 10,
          diameter: 0.026,
          roughness: 1.5e-6,
          inertia: true,
        },
      },
    ],
  };
}

describe("transient step certification (non-real fluid)", () => {
  it("does not certify a step whose momentum rows cannot be balanced", () => {
    const res = solveTransient(closedValveColumn());
    expect(res.converged).toBe(false);
    const scaled = res.stepResidualsScaled!;
    // The unsolvable first step sits far above the bar…
    expect(scaled[0]).toBeGreaterThan(SCALED_BAR);
    // …and the certifying series says so; every later step (fluid at rest,
    // nothing left to decelerate) converges.
    expect(scaled.slice(1).every((v) => v < SCALED_BAR)).toBe(true);
  });

  it("certifies the same network once its initial condition is consistent", () => {
    const res = solveTransient(closedValveColumn(0));
    expect(res.converged).toBe(true);
    expect(res.stepResidualsScaled!.every((v) => v < SCALED_BAR)).toBe(true);
    // The column stays essentially at rest (the closed valve's regularised
    // leak is ~1e-5 kg/s), nowhere near the 0.1 kg/s warm-start default.
    for (const m of res.branches.line.mdot)
      expect(Math.abs(m)).toBeLessThan(1e-3);
  });
});
