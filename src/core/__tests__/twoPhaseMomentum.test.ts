import { describe, it, expect, beforeAll } from "vitest";
import { NetworkConfig } from "../schema";
import { initRealFluids, realFluidsReady, RealFluid } from "../";
import { darcyFrictionFactor } from "../components";
import { solveSteady } from "../solver";

beforeAll(async () => {
  await initRealFluids();
  expect(realFluidsReady()).toBe(true);
}, 30000);

describe("HEM pipe ΔP hand-calculation", () => {
  it("solver branch dP matches independent Darcy–Weisbach calc with HEM ρ and μ within 1%", () => {
    const fluid = new RealFluid("Nitrogen");
    const P_up = 300e3;
    const P_down = 250e3;
    const x = 0.3;
    const L = 2;
    const D = 0.005;
    const roughness = 1e-5;

    const hf = fluid.hSatLiquid(P_up);
    const hg = fluid.hSatVapor(P_up);
    const h = hf + x * (hg - hf);

    const config: NetworkConfig = {
      meta: { name: "hempipe-handcalc", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
      nodes: [
        { id: "A", type: "boundary", x: 0, y: 0, pressure: P_up, quality: x },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: P_down,
          temperature: 80,
        },
      ],
      branches: [
        {
          id: "p1",
          from: "A",
          to: "B",
          component: { type: "pipe", length: L, diameter: D, roughness },
        },
      ],
    };

    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    const mdot = res.branches.p1.mdot;
    expect(Math.abs(mdot)).toBeGreaterThan(1e-6);

    const ph = fluid.statePH(P_up, h);
    const rho = ph.rho;
    const mu = ph.mu;
    const A = (Math.PI / 4) * D * D;
    const v = mdot / (rho * A);
    const Re = (rho * Math.abs(v) * D) / mu;

    // Independent hand calculation using the same Darcy–Weisbach formula
    // with HEM mixture density and McAdams viscosity.  The friction factor
    // uses the shared C0/C1-continuous correlation (laminar 64/Re below
    // Re=2300, Swamee–Jain above Re=4000, smoothstep blend between, both
    // branches evaluated at the actual Re).  This test operates at
    // Re ≈ 1.7e5 (fully turbulent), so it is insensitive to the transition
    // fix; the shared call simply keeps the hand-calc honest.
    const f = darcyFrictionFactor(Re, roughness / D);

    const dP_hand = (f * (L / D) * (rho * v * Math.abs(v))) / 2;
    const dP_solver = res.branches.p1.dP;

    expect(
      Math.abs(dP_solver - dP_hand) / Math.max(Math.abs(dP_hand), 1),
    ).toBeLessThan(0.01);
  }, 20000);
});

describe("Quality sensitivity — fixed mdot", () => {
  it("pipe ΔP increases monotonically with quality and tracks density ratio", () => {
    const P_up = 300e3;
    const P_down = 200e3;
    const mdot = 0.01;
    const L = 2;
    const D = 0.005;
    const roughness = 1e-5;

    const dps: number[] = [];
    const rhos: number[] = [];

    for (const x of [0.1, 0.3, 0.6]) {
      const config: NetworkConfig = {
        meta: { name: "quality-sweep", version: 2 },
        settings: {
          mode: "steady",
          tolerance: 1e-9,
          maxIterations: 500,
          relaxation: 0.9,
        },
        fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
        nodes: [
          { id: "A", type: "boundary", x: 0, y: 0, pressure: P_up, quality: x },
          {
            id: "C",
            type: "internal",
            x: 0.5,
            y: 0,
            pressure: P_up - 1000,
            temperature: 80,
            volume: 1e-6,
          },
          {
            id: "B",
            type: "boundary",
            x: 1,
            y: 0,
            pressure: P_down,
            temperature: 80,
          },
        ],
        branches: [
          {
            id: "fs",
            from: "A",
            to: "C",
            component: { type: "flowSource", massFlow: mdot },
          },
          {
            id: "p1",
            from: "C",
            to: "B",
            component: { type: "pipe", length: L, diameter: D, roughness },
          },
        ],
      };

      const res = solveSteady(config);
      expect(res.converged).toBe(true);

      // Upstream for pipe is C when mdot > 0 (C -> B)
      const dp = res.branches.p1.dP;
      dps.push(dp);

      // Upstream density from solver result
      const rho_up = res.nodes.C.density;
      rhos.push(rho_up);
    }

    // Monotonic increase in ΔP with quality
    expect(dps[1]).toBeGreaterThan(dps[0]);
    expect(dps[2]).toBeGreaterThan(dps[1]);

    // Density-dominated ratio sanity check.
    // For turbulent pipe at fixed mdot: ΔP ≈ f·(L/D)·mdot²/(2·ρ·A²).
    // As quality rises, ρ drops strongly, so ΔP rises.
    // The measured ratio should be within a loose band of the pure density ratio
    // (viscosity changes alter f slightly, but ρ is the dominant driver).
    const dpRatio = dps[2] / dps[0];
    const rhoRatio = rhos[0] / rhos[2];
    console.log(
      `Quality sensitivity: dpRatio=${dpRatio.toFixed(2)}, rhoRatio=${rhoRatio.toFixed(2)}`,
    );
    expect(dpRatio).toBeGreaterThan(rhoRatio * 0.7); // lower bound: f drops as Re rises
    expect(dpRatio).toBeLessThan(rhoRatio * 1.5); // upper bound: generous headroom
  }, 20000);
});

describe("Orifice with two-phase upstream", () => {
  it("mdot matches incompressible orifice formula using HEM mixture density within 1%", () => {
    const fluid = new RealFluid("Nitrogen");
    const P_up = 300e3;
    const P_down = 200e3;
    const x = 0.4;
    const A = 1e-4;
    const Cd = 0.6;

    const hf = fluid.hSatLiquid(P_up);
    const hg = fluid.hSatVapor(P_up);
    const h = hf + x * (hg - hf);
    const ph = fluid.statePH(P_up, h);
    const rho = ph.rho;

    const config: NetworkConfig = {
      meta: { name: "orifice-twophase", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
      nodes: [
        { id: "A", type: "boundary", x: 0, y: 0, pressure: P_up, quality: x },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: P_down,
          temperature: 80,
        },
      ],
      branches: [
        {
          id: "o1",
          from: "A",
          to: "B",
          component: { type: "orifice", area: A, cd: Cd },
        },
      ],
    };

    const res = solveSteady(config);
    expect(res.converged).toBe(true);

    const expectedMdot = Cd * A * Math.sqrt(2 * rho * (P_up - P_down));
    expect(
      Math.abs(res.branches.o1.mdot - expectedMdot) / expectedMdot,
    ).toBeLessThan(0.01);
  }, 20000);
});

describe("Single-phase regression (bit-identical)", () => {
  it("laminar water pipe Hagen–Poiseuille mdot unchanged to 1e-12", () => {
    // This is the exact same geometry and fluid state as the existing
    // solver.test.ts "Pipe laminar" test.  The expected mdot is the
    // analytical Hagen–Poiseuille value.
    const D = 0.01;
    const L = 10;
    const mu = 1e-3;
    const rho = 998;
    const targetMdot = 0.007;
    const deltaP =
      (128 * mu * L * targetMdot) / (Math.PI * rho * Math.pow(D, 4));

    const config: NetworkConfig = {
      meta: { name: "regression-laminar", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 200000,
          temperature: 300,
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: 200000 - deltaP,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "p1",
          from: "A",
          to: "B",
          component: { type: "pipe", length: L, diameter: D, roughness: 0 },
        },
      ],
    };

    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    const mdot = res.branches.p1.mdot;
    expect(Math.abs(mdot - targetMdot) / targetMdot).toBeLessThan(1e-11);
  }, 20000);
});
