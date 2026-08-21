import { describe, it, expect, beforeAll } from "vitest";
import type { NetworkConfig } from "../schema";
import { initRealFluids, realFluidsReady, RealFluid } from "../";
import { validateNetwork } from "../validate";
import { buildSolverContext, createInitialState, solveSteady } from "../solver";

beforeAll(async () => {
  await initRealFluids();
  expect(realFluidsReady()).toBe(true);
}, 30000);

function nitrogenHydrogenHX(): NetworkConfig {
  return {
    meta: { name: "n2-h2-hx", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-8,
      maxIterations: 500,
      relaxation: 0.9,
    },
    fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
    fluids: {
      h2: { model: "realFluid", params: { fluidName: "Hydrogen" } },
    },
    nodes: [
      {
        id: "n2_in",
        type: "boundary",
        x: 0,
        y: 1,
        pressure: 200_000,
        temperature: 320,
      },
      {
        id: "n2_j",
        type: "internal",
        x: 1,
        y: 1,
        pressure: 150_000,
        temperature: 320,
        volume: 0.01,
      },
      {
        id: "n2_out",
        type: "boundary",
        x: 2,
        y: 1,
        pressure: 100_000,
        temperature: 320,
      },
      {
        id: "h2_in",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 200_000,
        temperature: 280,
        fluid: "h2",
      },
      {
        id: "h2_j",
        type: "internal",
        x: 1,
        y: 0,
        pressure: 150_000,
        temperature: 280,
        volume: 0.01,
        fluid: "h2",
      },
      {
        id: "h2_out",
        type: "boundary",
        x: 2,
        y: 0,
        pressure: 100_000,
        temperature: 280,
        fluid: "h2",
      },
    ],
    solidNodes: [
      {
        id: "wall",
        type: "solid",
        x: 1,
        y: 0.5,
        temperature: 300,
        mass: 1,
        cp: 500,
      },
    ],
    conductors: [
      {
        id: "cv_n2",
        from: "n2_j",
        to: "wall",
        type: { kind: "convection", h: 200, area: 0.02 },
      },
      {
        id: "cv_h2",
        from: "h2_j",
        to: "wall",
        type: { kind: "convection", h: 200, area: 0.02 },
      },
    ],
    branches: [
      {
        id: "n2_1",
        from: "n2_in",
        to: "n2_j",
        component: { type: "orifice", area: 1e-4, cd: 0.6 },
      },
      {
        id: "n2_2",
        from: "n2_j",
        to: "n2_out",
        component: { type: "orifice", area: 1e-4, cd: 0.6 },
      },
      {
        id: "h2_1",
        from: "h2_in",
        to: "h2_j",
        component: { type: "orifice", area: 1e-4, cd: 0.6 },
      },
      {
        id: "h2_2",
        from: "h2_j",
        to: "h2_out",
        component: { type: "orifice", area: 1e-4, cd: 0.6 },
      },
    ],
  };
}

describe("two CoolProp continua on the PH path", () => {
  it("uses per-node statePH and keeps Nitrogen vs Hydrogen densities distinct", () => {
    const config = nitrogenHydrogenHX();
    expect(validateNetwork(config)).toEqual([]);

    const ctx = buildSolverContext(config);
    expect(ctx.isRealFluid).toBe(true);
    const n2 = ctx.fluidAssignment.node("n2_j") as RealFluid;
    const h2 = ctx.fluidAssignment.node("h2_j") as RealFluid;
    expect(n2.fluidName).toBe("Nitrogen");
    expect(h2.fluidName).toBe("Hydrogen");
    expect(n2).toBe(ctx.fluid);
    expect(h2).not.toBe(ctx.fluid);

    const state = createInitialState(ctx, config);
    expect(state.nodeH).toBeDefined();
    const pN2 = state.nodeP.get("n2_j")!;
    const hN2 = state.nodeH!.get("n2_j")!;
    const phN2 = n2.statePH(pN2, hN2);
    expect(phN2.rho).toBeCloseTo(state.nodeRho.get("n2_j")!, 8);
    expect(phN2.T).toBeCloseTo(state.nodeT.get("n2_j")!, 8);

    const pH2 = state.nodeP.get("h2_j")!;
    const hH2 = state.nodeH!.get("h2_j")!;
    const phH2 = h2.statePH(pH2, hH2);
    expect(phH2.rho).toBeCloseTo(state.nodeRho.get("h2_j")!, 8);
    expect(phH2.T).toBeCloseTo(state.nodeT.get("h2_j")!, 8);
    expect(state.nodeRho.get("n2_j")!).toBeGreaterThan(
      state.nodeRho.get("h2_j")! * 5,
    );

    const res = solveSteady(config);
    expect(res.converged).toBe(true);

    const n2Solved = n2.density(
      res.nodes.n2_j.pressure,
      res.nodes.n2_j.temperature,
    );
    const h2Solved = h2.density(
      res.nodes.h2_j.pressure,
      res.nodes.h2_j.temperature,
    );
    expect(res.nodes.n2_j.density).toBeCloseTo(n2Solved, 4);
    expect(res.nodes.h2_j.density).toBeCloseTo(h2Solved, 4);
    expect(res.nodes.n2_j.density).not.toBeCloseTo(res.nodes.h2_j.density, 1);
    expect(res.nodes.h2_j.temperature).toBeGreaterThan(280);
    expect(res.nodes.n2_j.temperature).toBeLessThan(320);
  });
});
