/**
 * The reaction sub-step is operator-split AFTER the transport Newton and
 * mutates node species and temperature. If its stiff integration fails, the
 * node is left at the transport solution, which is not a solution of the
 * split equations — so the step must not be certified. The failure used to
 * be swallowed and the step reported converged.
 */
import { describe, it, expect, vi } from "vitest";
import type { NetworkConfig } from "../schema";

vi.mock("../stiffOde", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stiffOde")>();
  return {
    ...actual,
    integrateBDF1: vi.fn(() => {
      throw new Error("BDF1 exceeded maxSteps (forced by test)");
    }),
  };
});

import { solveTransient } from "../transient";
import {
  buildSolverContext,
  createInitialState,
  solveStateStep,
} from "../solver";

function reactingTank(): NetworkConfig {
  const P = 1e5;
  const T = 300;
  return {
    meta: { name: "reacting tank", version: 2 },
    settings: {
      mode: "transient",
      dt: 0.002,
      endTime: 0.006,
      timeStepping: "fixed",
      tolerance: 1e-6,
      maxIterations: 200,
      relaxation: 0.9,
    },
    fluid: { model: "idealGas", preset: "air" },
    species: {
      names: ["A", "B"],
      molecularWeights: [0.028, 0.028],
      cp: [1000, 1000],
      reactions: [
        { reactants: { A: 1 }, products: { B: 1 }, A: 10, b: 0, Ea: 0 },
      ],
    },
    nodes: [
      {
        id: "in",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: P,
        temperature: T,
        massFractions: { A: 1, B: 0 },
      },
      {
        id: "tank",
        type: "internal",
        x: 1,
        y: 0,
        pressure: P,
        temperature: T,
        volume: 1e-3,
        massFractions: { A: 1, B: 0 },
      },
      {
        id: "out",
        type: "boundary",
        x: 2,
        y: 0,
        pressure: P,
        temperature: T,
        massFractions: { A: 1, B: 0 },
      },
    ],
    branches: [
      {
        id: "s1",
        from: "in",
        to: "tank",
        component: { type: "flowSource", massFlow: 0 },
      },
      {
        id: "s2",
        from: "tank",
        to: "out",
        component: { type: "flowSource", massFlow: 0 },
      },
    ],
  };
}

describe("reaction sub-step failure", () => {
  it("withdraws the step's certification and names the node", () => {
    const cfg = reactingTank();
    const ctx = buildSolverContext(cfg);
    const state = createInitialState(ctx, cfg);
    const res = solveStateStep(ctx, state, {
      dt: cfg.settings.dt,
      t: 0,
      tol: cfg.settings.tolerance,
      maxIterations: cfg.settings.maxIterations,
      relaxation: cfg.settings.relaxation ?? 1,
    });
    expect(res.converged).toBe(false);
    expect(res.chemistryFailed).toEqual(["tank"]);
    // The transport solution stands: species were not touched.
    expect(state.nodeY!.get("tank")!.A).toBe(1);
  });

  it("propagates to the transient result", () => {
    const res = solveTransient(reactingTank());
    expect(res.converged).toBe(false);
  });
});
