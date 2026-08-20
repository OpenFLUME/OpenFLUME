import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../schema";
import { validateNetwork } from "../validate";
import { buildSolverContext, createInitialState, solveSteady } from "../solver";
import { createFluidAssignment } from "../fluidAssignment";

function twoLoopHX(): NetworkConfig {
  return {
    meta: { name: "two-loop-hx", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-8,
      maxIterations: 500,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    fluids: {
      oil: {
        model: "incompressible",
        params: { rho: 850, mu: 0.03, cp: 2000 },
      },
    },
    nodes: [
      {
        id: "w_in",
        type: "boundary",
        x: 0,
        y: 1,
        pressure: 200_000,
        temperature: 290,
      },
      {
        id: "w_j",
        type: "internal",
        x: 1,
        y: 1,
        pressure: 150_000,
        temperature: 290,
        volume: 0.001,
      },
      {
        id: "w_out",
        type: "boundary",
        x: 2,
        y: 1,
        pressure: 100_000,
        temperature: 290,
      },
      {
        id: "o_in",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 200_000,
        temperature: 360,
        fluid: "oil",
      },
      {
        id: "o_j",
        type: "internal",
        x: 1,
        y: 0,
        pressure: 150_000,
        temperature: 360,
        volume: 0.001,
        fluid: "oil",
      },
      {
        id: "o_out",
        type: "boundary",
        x: 2,
        y: 0,
        pressure: 100_000,
        temperature: 360,
        fluid: "oil",
      },
    ],
    solidNodes: [
      {
        id: "wall",
        type: "solid",
        x: 1,
        y: 0.5,
        temperature: 325,
        mass: 1,
        cp: 500,
      },
    ],
    conductors: [
      {
        id: "cv_w",
        from: "w_j",
        to: "wall",
        type: { kind: "convection", h: 800, area: 0.05 },
      },
      {
        id: "cv_o",
        from: "o_j",
        to: "wall",
        type: { kind: "convection", h: 400, area: 0.05 },
      },
    ],
    branches: [
      {
        id: "w1",
        from: "w_in",
        to: "w_j",
        component: {
          type: "pipe",
          length: 0.5,
          diameter: 0.02,
          roughness: 1e-5,
        },
      },
      {
        id: "w2",
        from: "w_j",
        to: "w_out",
        component: {
          type: "pipe",
          length: 0.5,
          diameter: 0.02,
          roughness: 1e-5,
        },
      },
      {
        id: "o1",
        from: "o_in",
        to: "o_j",
        component: {
          type: "pipe",
          length: 0.5,
          diameter: 0.02,
          roughness: 1e-5,
        },
      },
      {
        id: "o2",
        from: "o_j",
        to: "o_out",
        component: {
          type: "pipe",
          length: 0.5,
          diameter: 0.02,
          roughness: 1e-5,
        },
      },
    ],
  };
}

function singleFluidPipe(): NetworkConfig {
  return {
    meta: { name: "single", version: 2 },
    settings: { mode: "steady", tolerance: 1e-9, maxIterations: 100 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "A",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 200_000,
        temperature: 300,
      },
      {
        id: "B",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: 100_000,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "p1",
        from: "A",
        to: "B",
        component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      },
    ],
  };
}

describe("FluidAssignment identity (single fluid)", () => {
  it("returns the context fluid itself when no named fluids exist", () => {
    const ctx = buildSolverContext(singleFluidPipe());
    expect(ctx.fluidAssignment.node("A")).toBe(ctx.fluid);
    expect(ctx.fluidAssignment.node("B")).toBe(ctx.fluid);
    expect(ctx.fluidAssignment.branch("p1")).toBe(ctx.fluid);
  });

  it("standalone factory without maps is identity-backed", () => {
    const sentinel = { density: () => 1 } as never;
    const assignment = createFluidAssignment(sentinel, {
      nodes: ["n1"],
      branches: ["b1"],
    });
    expect(assignment.node("n1")).toBe(sentinel);
    expect(assignment.branch("b1")).toBe(sentinel);
  });
});

describe("two isolated incompressible continua coupled by a wall", () => {
  it("validates, assigns distinct models, and solves with per-continuum density", () => {
    const config = twoLoopHX();
    expect(validateNetwork(config)).toEqual([]);

    const ctx = buildSolverContext(config);
    expect(ctx.fluidAssignment.node("w_j")).toBe(ctx.fluid);
    expect(ctx.fluidAssignment.node("o_j")).not.toBe(ctx.fluid);
    expect(ctx.fluidAssignment.branch("o1")).toBe(
      ctx.fluidAssignment.node("o_in"),
    );
    expect(ctx.fluidAssignment.branch("w1")).toBe(ctx.fluid);

    const state = createInitialState(ctx, config);
    expect(state.nodeRho.get("w_j")).toBeCloseTo(998, 6);
    expect(state.nodeRho.get("o_j")).toBeCloseTo(850, 6);

    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(res.nodes.w_j.density).toBeCloseTo(998, 4);
    expect(res.nodes.o_j.density).toBeCloseTo(850, 4);
    expect(res.nodes.o_j.temperature).toBeLessThan(360);
    expect(res.nodes.w_j.temperature).toBeGreaterThan(290);
    expect(res.nodes.w_j.temperature).toBeLessThan(res.nodes.o_j.temperature);
  });
});

describe("multi-fluid validation", () => {
  it("rejects a branch that joins unlike fluids", () => {
    const config = twoLoopHX();
    config.branches.push({
      id: "mix",
      from: "w_j",
      to: "o_j",
      component: { type: "pipe", length: 0.2, diameter: 0.01, roughness: 1e-5 },
    });
    const errors = validateNetwork(config);
    expect(errors.some((e) => e.includes("connects different fluids"))).toBe(
      true,
    );
    expect(errors.some((e) => e.includes("mix"))).toBe(true);
  });

  it("accepts mixed EOS classes (unlike fluids couple only through walls)", () => {
    const config = singleFluidPipe();
    config.fluids = { n2: { model: "idealGas", preset: "air" } };
    expect(validateNetwork(config)).toEqual([]);
  });

  it("rejects species transport when named fluids are present", () => {
    const config: NetworkConfig = {
      meta: { name: "species-multi", version: 2 },
      settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
      fluid: { model: "idealGas", preset: "air" },
      fluids: { extra: { model: "idealGas", preset: "air" } },
      species: {
        names: ["N2", "O2"],
        molecularWeights: [0.028, 0.032],
      },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "b1",
          from: "A",
          to: "B",
          component: { type: "orifice", area: 0.001, cd: 0.6 },
        },
      ],
    };
    const errors = validateNetwork(config);
    expect(
      errors.some((e) => e.includes("not supported in multi-fluid networks")),
    ).toBe(true);
  });

  it("rejects a node that names a missing fluid", () => {
    const config = singleFluidPipe();
    config.nodes[0] = { ...config.nodes[0], fluid: "ghost" };
    const errors = validateNetwork(config);
    expect(errors.some((e) => e.includes('unknown fluid "ghost"'))).toBe(true);
  });

  it("rejects an empty named-fluid key", () => {
    const config = singleFluidPipe();
    config.fluids = { "": { model: "incompressible", preset: "water" } };
    const errors = validateNetwork(config);
    expect(
      errors.some((e) => e.includes("Named fluid keys must be non-empty")),
    ).toBe(true);
  });
});
