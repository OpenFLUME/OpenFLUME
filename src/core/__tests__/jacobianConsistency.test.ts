import { describe, it, expect } from "vitest";
import { NetworkConfig } from "../schema";
import { solveSteady } from "../solver";
import {
  Pipe,
  Orifice,
  FlowResistance,
  Valve,
  AreaChange,
  Bend,
  CheckValve,
  DynamicCheckValve,
} from "../components";
import { IdealGas, ExpandableLiquid } from "../fluids";
import { variable, derivative } from "../dual";

/** Central finite-difference derivative for a scalar function. */
function fdDerivative(f: (x: number) => number, x: number, h = 1e-6): number {
  return (f(x + h) - f(x - h)) / (2 * h);
}

/** Mixed relative/absolute tolerance for comparing AD vs FD. */
function agree(a: number, b: number, relTol = 1e-5, absTol = 1e-8): boolean {
  return (
    Math.abs(a - b) <=
    Math.max(absTol, relTol * Math.max(Math.abs(a), Math.abs(b)))
  );
}

describe("Component dual vs FD derivatives", () => {
  const rho = 998;
  const mu = 1e-3;

  it("Pipe laminar", () => {
    const pipe = new Pipe(10, 0.01, 0);
    const mdot = 0.007;
    const dP = derivative(pipe.pressureDropDual!(variable(mdot), rho, mu));
    const dPfd = fdDerivative((m) => pipe.pressureDrop(m, rho, mu), mdot);
    expect(agree(dP, dPfd, 1e-4)).toBe(true);
  });

  it("Pipe turbulent", () => {
    const pipe = new Pipe(10, 0.05, 1e-5);
    const mdot = 2.0; // Re ≈ 100000
    const dP = derivative(pipe.pressureDropDual!(variable(mdot), rho, mu));
    const dPfd = fdDerivative((m) => pipe.pressureDrop(m, rho, mu), mdot);
    expect(agree(dP, dPfd)).toBe(true);
  });

  it("Pipe blend region Re=3000", () => {
    const pipe = new Pipe(10, 0.05, 1e-5);
    const A = pipe.area;
    const v = (3000 * mu) / (rho * pipe.diameter);
    const mdot = rho * A * v;
    const dP = derivative(pipe.pressureDropDual!(variable(mdot), rho, mu));
    const dPfd = fdDerivative((m) => pipe.pressureDrop(m, rho, mu), mdot);
    expect(agree(dP, dPfd)).toBe(true);
  });

  it("Orifice", () => {
    const orifice = new Orifice(0.001, 0.6);
    const mdot = 0.5;
    const dP = derivative(orifice.pressureDropDual!(variable(mdot), rho, mu));
    const dPfd = fdDerivative((m) => orifice.pressureDrop(m, rho, mu), mdot);
    expect(agree(dP, dPfd)).toBe(true);
  });

  it("FlowResistance", () => {
    const res = new FlowResistance(10, 0.01);
    const mdot = 1.0;
    const dP = derivative(res.pressureDropDual!(variable(mdot), rho, mu));
    const dPfd = fdDerivative((m) => res.pressureDrop(m, rho, mu), mdot);
    expect(agree(dP, dPfd)).toBe(true);
  });

  it("Valve half-open", () => {
    const valve = new Valve(0.001, 0.6, 0.5);
    const mdot = 0.3;
    const dP = derivative(valve.pressureDropDual!(variable(mdot), rho, mu));
    const dPfd = fdDerivative((m) => valve.pressureDrop(m, rho, mu), mdot);
    expect(agree(dP, dPfd)).toBe(true);
  });

  it("AreaChange expansion", () => {
    const ac = new AreaChange(0.001, 0.002);
    const mdot = 0.5;
    const dP = derivative(ac.pressureDropDual!(variable(mdot), rho, mu));
    const dPfd = fdDerivative((m) => ac.pressureDrop(m, rho, mu), mdot);
    expect(agree(dP, dPfd)).toBe(true);
  });

  it("AreaChange contraction", () => {
    const ac = new AreaChange(0.002, 0.001);
    const mdot = 0.5;
    const dP = derivative(ac.pressureDropDual!(variable(mdot), rho, mu));
    const dPfd = fdDerivative((m) => ac.pressureDrop(m, rho, mu), mdot);
    expect(agree(dP, dPfd)).toBe(true);
  });

  it("Bend smooth turbulent", () => {
    const bend = new Bend(0.05, 90, 2, 0);
    const mdot = 2.0;
    const dP = derivative(bend.pressureDropDual!(variable(mdot), rho, mu));
    const dPfd = fdDerivative((m) => bend.pressureDrop(m, rho, mu), mdot);
    expect(agree(dP, dPfd)).toBe(true);
  });

  it("CheckValve forward", () => {
    const cv = new CheckValve(0.001, 0.6);
    const mdot = 0.5;
    const dP = derivative(cv.pressureDropDual!(variable(mdot), rho, mu));
    const dPfd = fdDerivative((m) => cv.pressureDrop(m, rho, mu), mdot);
    expect(agree(dP, dPfd)).toBe(true);
  });

  it("CheckValve reverse", () => {
    const cv = new CheckValve(0.001, 0.6);
    const mdot = -0.5;
    const dP = derivative(cv.pressureDropDual!(variable(mdot), rho, mu));
    const dPfd = fdDerivative((m) => cv.pressureDrop(m, rho, mu), mdot);
    expect(agree(dP, dPfd)).toBe(true);
  });

  it("DynamicCheckValve half-open", () => {
    const dcv = new DynamicCheckValve(
      0.001,
      0.6,
      0.05,
      5000,
      50,
      5,
      0.005,
      undefined,
      0.5,
    );
    const mdot = 0.3;
    const dP = derivative(dcv.pressureDropDual!(variable(mdot), rho, mu));
    const dPfd = fdDerivative((m) => dcv.pressureDrop(m, rho, mu), mdot);
    expect(agree(dP, dPfd)).toBe(true);
  });
});

describe("Fluid dual vs FD derivatives", () => {
  it("IdealGas density w.r.t. P", () => {
    const gas = IdealGas.AIR;
    const P = 200000;
    const T = 300;
    const dRho = derivative(gas.densityDual!(variable(P), T));
    const dRhoFD = fdDerivative((p) => gas.density(p, T), P);
    expect(agree(dRho, dRhoFD)).toBe(true);
  });

  it("ExpandableLiquid density is constant w.r.t. P", () => {
    const liq = ExpandableLiquid.WATER_EXPANDABLE;
    const P = 100000;
    const T = 300;
    const dRho = derivative(liq.densityDual!(variable(P), T));
    expect(dRho).toBe(0);
  });
});

describe("Network solve consistency: hybrid vs pure-FD", () => {
  function makeConfig(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
    return {
      meta: { name: "test", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [],
      branches: [],
      ...overrides,
    } as NetworkConfig;
  }

  it("three-pipe junction", () => {
    const config = makeConfig({
      nodes: [
        {
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 300000,
          temperature: 300,
        },
        {
          id: "j",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 250000,
          temperature: 300,
        },
        {
          id: "out1",
          type: "boundary",
          x: 2,
          y: 1,
          pressure: 200000,
          temperature: 300,
        },
        {
          id: "out2",
          type: "boundary",
          x: 2,
          y: -1,
          pressure: 150000,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "b1",
          from: "in",
          to: "j",
          component: {
            type: "pipe",
            length: 2,
            diameter: 0.03,
            roughness: 1e-5,
          },
        },
        {
          id: "b2",
          from: "j",
          to: "out1",
          component: {
            type: "pipe",
            length: 3,
            diameter: 0.02,
            roughness: 1e-5,
          },
        },
        {
          id: "b3",
          from: "j",
          to: "out2",
          component: {
            type: "pipe",
            length: 4,
            diameter: 0.015,
            roughness: 1e-5,
          },
        },
      ],
    });
    const hybrid = solveSteady({
      ...config,
      settings: { ...config.settings, jacobian: "hybrid" },
    });
    const fd = solveSteady({
      ...config,
      settings: { ...config.settings, jacobian: "fd" },
    });
    expect(hybrid.converged).toBe(true);
    expect(fd.converged).toBe(true);
    for (const node of config.nodes) {
      expect(
        Math.abs(hybrid.nodes[node.id].pressure - fd.nodes[node.id].pressure),
      ).toBeLessThan(1e-6);
    }
    for (const branch of config.branches) {
      expect(
        Math.abs(hybrid.branches[branch.id].mdot - fd.branches[branch.id].mdot),
      ).toBeLessThan(1e-9);
    }
  });

  it("ideal-gas blowdown", () => {
    const config: NetworkConfig = {
      meta: { name: "test", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "idealGas", preset: "air" },
      nodes: [
        {
          id: "tank",
          type: "internal",
          x: 0,
          y: 0,
          pressure: 500000,
          temperature: 300,
        },
        {
          id: "out",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: 101325,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "o1",
          from: "tank",
          to: "out",
          component: { type: "orifice", area: 0.0001, cd: 0.6 },
        },
      ],
    };
    const hybrid = solveSteady({
      ...config,
      settings: { ...config.settings, jacobian: "hybrid" },
    });
    const fd = solveSteady({
      ...config,
      settings: { ...config.settings, jacobian: "fd" },
    });
    expect(hybrid.converged).toBe(true);
    expect(fd.converged).toBe(true);
    expect(
      Math.abs(hybrid.nodes.tank.pressure - fd.nodes.tank.pressure),
    ).toBeLessThan(1e-6);
    expect(
      Math.abs(hybrid.branches.o1.mdot - fd.branches.o1.mdot),
    ).toBeLessThan(1e-9);
  });

  it("pipe-friction laminar", () => {
    const D = 0.01;
    const L = 10;
    const config = makeConfig({
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
          pressure: 200000 - 5000,
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
    });
    const hybrid = solveSteady({
      ...config,
      settings: { ...config.settings, jacobian: "hybrid" },
    });
    const fd = solveSteady({
      ...config,
      settings: { ...config.settings, jacobian: "fd" },
    });
    expect(hybrid.converged).toBe(true);
    expect(fd.converged).toBe(true);
    expect(
      Math.abs(hybrid.branches.p1.mdot - fd.branches.p1.mdot),
    ).toBeLessThan(1e-10);
  });

  it("pipe-friction turbulent", () => {
    const D = 0.05;
    const L = 10;
    const config = makeConfig({
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 300000,
          temperature: 300,
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: 300000 - 20000,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "p1",
          from: "A",
          to: "B",
          component: { type: "pipe", length: L, diameter: D, roughness: 1e-5 },
        },
      ],
    });
    const hybrid = solveSteady({
      ...config,
      settings: { ...config.settings, jacobian: "hybrid" },
    });
    const fd = solveSteady({
      ...config,
      settings: { ...config.settings, jacobian: "fd" },
    });
    expect(hybrid.converged).toBe(true);
    expect(fd.converged).toBe(true);
    expect(
      Math.abs(hybrid.branches.p1.mdot - fd.branches.p1.mdot),
    ).toBeLessThan(1e-10);
  });

  it("elevation-change pipe (natural circulation)", () => {
    const config = makeConfig({
      nodes: [
        {
          id: "bot",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 300000,
          temperature: 300,
        },
        {
          id: "top",
          type: "boundary",
          x: 0,
          y: 1,
          pressure: 300000 - 998 * 9.80665 * 10,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "p1",
          from: "bot",
          to: "top",
          component: {
            type: "pipe",
            length: 10,
            diameter: 0.02,
            roughness: 0,
            elevationChange: 10,
          },
        },
      ],
    });
    const hybrid = solveSteady({
      ...config,
      settings: { ...config.settings, jacobian: "hybrid" },
    });
    const fd = solveSteady({
      ...config,
      settings: { ...config.settings, jacobian: "fd" },
    });
    expect(hybrid.converged).toBe(true);
    expect(fd.converged).toBe(true);
    expect(
      Math.abs(hybrid.branches.p1.mdot - fd.branches.p1.mdot),
    ).toBeLessThan(1e-9);
  });

  it("valve + bend + areaChange in series", () => {
    const config = makeConfig({
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 300000,
          temperature: 300,
        },
        {
          id: "M",
          type: "internal",
          x: 0.5,
          y: 0,
          pressure: 250000,
          temperature: 300,
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: 200000,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "v1",
          from: "A",
          to: "M",
          component: { type: "valve", area: 0.001, cd: 0.6, position: 0.5 },
        },
        {
          id: "b1",
          from: "M",
          to: "B",
          component: {
            type: "bend",
            diameter: 0.03,
            angle: 90,
            rOverD: 2,
            roughness: 1e-5,
          },
        },
      ],
    });
    const hybrid = solveSteady({
      ...config,
      settings: { ...config.settings, jacobian: "hybrid" },
    });
    const fd = solveSteady({
      ...config,
      settings: { ...config.settings, jacobian: "fd" },
    });
    expect(hybrid.converged).toBe(true);
    expect(fd.converged).toBe(true);
    expect(
      Math.abs(hybrid.nodes.M.pressure - fd.nodes.M.pressure),
    ).toBeLessThan(1e-6);
    expect(
      Math.abs(hybrid.branches.v1.mdot - fd.branches.v1.mdot),
    ).toBeLessThan(1e-9);
  });
});
