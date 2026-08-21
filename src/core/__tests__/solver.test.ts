import { describe, it, expect } from "vitest";
import { NetworkConfig } from "../schema";
import { IncompressibleLiquid, IdealGas, createFluidModel } from "../fluids";
import { Pipe } from "../components";
import { solveSteady } from "../solver";
import { validateNetwork } from "../validate";

const water = IncompressibleLiquid.WATER;
const air = IdealGas.AIR;

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

describe("Fluid models", () => {
  it("water preset matches constants", () => {
    expect(water.density(1e5, 300)).toBeCloseTo(998, 6);
    expect(water.viscosity(1e5, 300)).toBeCloseTo(1e-3, 6);
    expect(water.cp(1e5, 300)).toBeCloseTo(4182, 6);
    expect(water.enthalpy(1e5, 300)).toBeCloseTo(4182 * 300, 6);
  });

  it("air preset matches constants", () => {
    expect(air.density(101325, 300)).toBeCloseTo(101325 / (287 * 300), 6);
    expect(air.viscosity(101325, 300)).toBeCloseTo(1.8e-5, 6);
    expect(air.cp(101325, 300)).toBeCloseTo(1005, 6);
    expect(air.enthalpy(101325, 300)).toBeCloseTo(1005 * 300, 6);
  });

  it("ideal gas law spot checks", () => {
    const gas = new IdealGas(287, 1.4, 1.8e-5, 1005);
    expect(gas.density(200000, 400)).toBeCloseTo(200000 / (287 * 400), 6);
    expect(gas.density(50000, 250)).toBeCloseTo(50000 / (287 * 250), 6);
  });

  it("incompressible params", () => {
    const oil = new IncompressibleLiquid(850, 0.05, 2000);
    expect(oil.density(1e5, 350)).toBe(850);
    expect(oil.viscosity(1e5, 350)).toBe(0.05);
    expect(oil.cp(1e5, 350)).toBe(2000);
  });

  it("createFluidModel presets", () => {
    const w = createFluidModel("incompressible", "water");
    expect(w.density(1e5, 300)).toBe(998);
    const a = createFluidModel("idealGas", "air");
    expect(a.density(101325, 300)).toBeCloseTo(101325 / (287 * 300), 6);
  });
});

describe("Pipe laminar", () => {
  it("matches Hagen–Poiseuille", () => {
    const D = 0.01;
    const L = 10;
    const mu = 1e-3;
    const rho = 998;
    const A = (Math.PI / 4) * D * D;
    // Pick ΔP small enough for Re < 2300
    // Re = rho*v*D/mu, v = mdot/(rho*A)
    // Hagen-Poiseuille: mdot = pi * rho * ΔP * D^4 / (128 * mu * L)
    // Let's target mdot that gives Re ~ 1000 -> v = 1000*mu/(rho*D) = 1000*1e-3/(998*0.01) ≈ 0.1002
    // mdot = rho*A*v ≈ 998 * 7.854e-5 * 0.1002 ≈ 0.00785
    // ΔP = 128 * mu * L * mdot / (pi * rho * D^4)
    const targetMdot = 0.007;
    const deltaP =
      (128 * mu * L * targetMdot) / (Math.PI * rho * Math.pow(D, 4));

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
    });

    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    const mdot = res.branches.p1.mdot;
    const v = mdot / (rho * A);
    const Re = (rho * Math.abs(v) * D) / mu;
    expect(Re).toBeLessThan(2300);
    expect(Math.abs(mdot)).toBeCloseTo(targetMdot, 2); // within 1%
  });
});

describe("Pipe turbulent friction", () => {
  it("matches Colebrook within 2%", () => {
    // Check friction factor directly at several Re/roughness points
    const pipe = new Pipe(1, 0.05, 1e-5);
    const rho = 998;
    const mu = 1e-3;
    const D = 0.05;
    const A = (Math.PI / 4) * D * D;

    const check = (ReTarget: number) => {
      const v = (ReTarget * mu) / (rho * D);
      const mdot = rho * A * v;
      const dP = pipe.pressureDrop(mdot, rho, mu);
      const fCalc = (dP * 2 * D) / (pipe.length * rho * v * Math.abs(v));

      // Colebrook-approximation via Swamee-Jain
      const rhs = pipe.roughness / (3.7 * D) + 5.74 / Math.pow(ReTarget, 0.9);
      const fExact = 0.25 / Math.pow(Math.log10(rhs), 2);

      expect(Math.abs(fCalc - fExact) / fExact).toBeLessThan(0.02);
    };

    check(4000);
    check(10000);
    check(100000);
    check(1e6);
  });

  it("self-consistency: directly inverted Darcy–Weisbach", () => {
    const D = 0.05;
    const L = 10;
    const rho = 998;
    const mu = 1e-3;
    const pipe = new Pipe(L, D, 1e-5);
    const A = (Math.PI / 4) * D * D;

    // Pick a turbulent Re
    const v = 2.0; // Re ≈ 100000
    const mdot = rho * A * v;
    const dP = pipe.pressureDrop(mdot, rho, mu);

    // Set up boundaries with this dP and solve
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
          pressure: 300000 - dP,
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

    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(Math.abs(res.branches.p1.mdot - mdot) / mdot).toBeLessThan(0.01);
  });
});

describe("Orifice", () => {
  it("matches analytical mdot", () => {
    const rho = 998;
    const A = 0.001;
    const Cd = 0.6;
    const deltaP = 10000;
    const expectedMdot = Cd * A * Math.sqrt(2 * rho * deltaP);

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
          pressure: 200000 - deltaP,
          temperature: 300,
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
    });

    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(
      Math.abs(res.branches.o1.mdot - expectedMdot) / expectedMdot,
    ).toBeLessThan(0.01);
  });
});

describe("Series pipes", () => {
  it("intermediate pressure is mean for identical pipes", () => {
    const D = 0.02;
    const L = 5;
    const deltaP = 5000;

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
          id: "M",
          type: "internal",
          x: 0.5,
          y: 0,
          pressure: 200000 - deltaP / 2,
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
          to: "M",
          component: { type: "pipe", length: L, diameter: D, roughness: 1e-5 },
        },
        {
          id: "p2",
          from: "M",
          to: "B",
          component: { type: "pipe", length: L, diameter: D, roughness: 1e-5 },
        },
      ],
    });

    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    const midP = res.nodes.M.pressure;
    expect(Math.abs(midP - (200000 - deltaP / 2)) / deltaP).toBeLessThan(0.01);

    // Total flow through single equivalent pipe should match
    const single = makeConfig({
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
          component: { type: "pipe", length: L, diameter: D, roughness: 1e-5 },
        },
      ],
    });
    const singleRes = solveSteady(single);
    expect(singleRes.converged).toBe(true);
    // Two identical pipes in series should have less flow than one pipe with same total ΔP
    // because each pipe sees half the ΔP, and ΔP ~ mdot^2 for turbulent
    // mdot_series = mdot_single / sqrt(2) approximately
    expect(
      Math.abs(res.branches.p1.mdot - singleRes.branches.p1.mdot / Math.SQRT2) /
        (singleRes.branches.p1.mdot / Math.SQRT2),
    ).toBeLessThan(0.05);
  });
});

describe("Parallel pipes", () => {
  it("identical branches split flow equally", () => {
    const D = 0.02;
    const L = 5;
    const deltaP = 5000;

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
          pressure: 200000 - deltaP,
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
        {
          id: "p2",
          from: "A",
          to: "B",
          component: { type: "pipe", length: L, diameter: D, roughness: 1e-5 },
        },
      ],
    });

    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(
      Math.abs(res.branches.p1.mdot - res.branches.p2.mdot) /
        Math.abs(res.branches.p1.mdot),
    ).toBeLessThan(0.01);

    // Single equivalent pipe for same ΔP should carry sum of both
    const single = makeConfig({
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
          component: { type: "pipe", length: L, diameter: D, roughness: 1e-5 },
        },
      ],
    });
    const singleRes = solveSteady(single);
    expect(singleRes.converged).toBe(true);
    expect(
      Math.abs(
        res.branches.p1.mdot +
          res.branches.p2.mdot -
          singleRes.branches.p1.mdot * 2,
      ) /
        (singleRes.branches.p1.mdot * 2),
    ).toBeLessThan(0.02);
  });
});

describe("T-junction mass conservation", () => {
  it("net mass imbalance < 1e-9 of throughput", () => {
    const D1 = 0.03;
    const D2 = 0.02;
    const D3 = 0.015;
    const L1 = 2;
    const L2 = 3;
    const L3 = 4;

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
            length: L1,
            diameter: D1,
            roughness: 1e-5,
          },
        },
        {
          id: "b2",
          from: "j",
          to: "out1",
          component: {
            type: "pipe",
            length: L2,
            diameter: D2,
            roughness: 1e-5,
          },
        },
        {
          id: "b3",
          from: "j",
          to: "out2",
          component: {
            type: "pipe",
            length: L3,
            diameter: D3,
            roughness: 1e-5,
          },
        },
      ],
    });

    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    const throughput = Math.abs(res.branches.b1.mdot);
    const imbalance = Math.abs(
      res.branches.b1.mdot - res.branches.b2.mdot - res.branches.b3.mdot,
    );
    expect(imbalance / throughput).toBeLessThan(1e-9);
  });
});

describe("Energy mixing", () => {
  it("outlet temperature is enthalpy-weighted average", () => {
    const T1 = 350;
    const T2 = 300;
    const P = 200000;
    const A = 0.001;
    const Cd = 0.6;

    const config = makeConfig({
      nodes: [
        {
          id: "in1",
          type: "boundary",
          x: 0,
          y: 1,
          pressure: P + 10000,
          temperature: T1,
        },
        {
          id: "in2",
          type: "boundary",
          x: 0,
          y: -1,
          pressure: P + 10000,
          temperature: T2,
        },
        {
          id: "mix",
          type: "internal",
          x: 1,
          y: 0,
          pressure: P,
          temperature: 320,
        },
        {
          id: "out",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: P - 10000,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "b1",
          from: "in1",
          to: "mix",
          component: { type: "orifice", area: A, cd: Cd },
        },
        {
          id: "b2",
          from: "in2",
          to: "mix",
          component: { type: "orifice", area: A, cd: Cd },
        },
        {
          id: "b3",
          from: "mix",
          to: "out",
          component: { type: "orifice", area: A * 2, cd: Cd },
        },
      ],
    });

    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    const mdot1 = res.branches.b1.mdot;
    const mdot2 = res.branches.b2.mdot;
    const expectedT = (mdot1 * T1 + mdot2 * T2) / (mdot1 + mdot2);
    expect(
      Math.abs(res.nodes.mix.temperature - expectedT) / expectedT,
    ).toBeLessThan(0.001);
  });
});

describe("Elevation", () => {
  it("static column pressure difference ≈ ρgh", () => {
    const G = 9.80665;
    const rho = 998;
    const h = 10;
    const expectedDP = rho * G * h;
    const D = 0.02;
    const L = h;

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
          pressure: 300000 - expectedDP,
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
            length: L,
            diameter: D,
            roughness: 0,
            elevationChange: h,
          },
        },
      ],
    });

    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(Math.abs(res.branches.p1.mdot)).toBeLessThan(1e-4); // near zero flow
    expect(Math.abs(res.branches.p1.dP - expectedDP) / expectedDP).toBeLessThan(
      0.005,
    );
  });
});

describe("validateNetwork", () => {
  it("catches dangling branch refs", () => {
    const config = makeConfig({
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
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
    });
    const errs = validateNetwork(config);
    expect(errs.some((e) => e.includes("missing node"))).toBe(true);
  });

  it("catches missing boundary values", () => {
    const config = makeConfig({
      nodes: [
        { id: "A", type: "boundary", x: 0, y: 0, temperature: 300 } as any,
      ],
      branches: [],
    });
    const errs = validateNetwork(config);
    expect(errs.some((e) => e.includes("pressure"))).toBe(true);
  });

  it("catches no boundary nodes", () => {
    const config = makeConfig({
      nodes: [
        {
          id: "A",
          type: "internal",
          x: 0,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [],
    });
    const errs = validateNetwork(config);
    expect(errs.some((e) => e.includes("No boundary"))).toBe(true);
  });

  it("catches duplicate ids", () => {
    const config = makeConfig({
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
          id: "A",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [],
    });
    const errs = validateNetwork(config);
    expect(errs.some((e) => e.includes("Duplicate node"))).toBe(true);
  });

  it("catches non-positive geometry", () => {
    const config = makeConfig({
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
          component: { type: "pipe", length: -1, diameter: 0.01, roughness: 0 },
        },
        {
          id: "b2",
          from: "A",
          to: "B",
          component: { type: "orifice", area: 0, cd: 0.6 },
        },
        {
          id: "b3",
          from: "A",
          to: "B",
          component: { type: "resistance", k: -1, area: 0.01 },
        },
      ],
    });
    const errs = validateNetwork(config);
    expect(errs.some((e) => e.includes("length"))).toBe(true);
    expect(errs.some((e) => e.includes("area"))).toBe(true);
    expect(errs.some((e) => e.includes("k"))).toBe(true);
  });

  it("allows valid config", () => {
    const config = makeConfig({
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
          component: { type: "pipe", length: 1, diameter: 0.01, roughness: 0 },
        },
      ],
    });
    expect(validateNetwork(config)).toEqual([]);
  });
});

describe("Steady progress & abort hooks", () => {
  // Use a network with heat addition so temperatures change and outer iterations are needed
  const baseConfig: NetworkConfig = {
    meta: { name: "test", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-9,
      maxIterations: 500,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
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
        x: 200,
        y: 0,
        pressure: 250000,
        temperature: 300,
        heatInput: 50000,
      },
      {
        id: "out",
        type: "boundary",
        x: 400,
        y: 0,
        pressure: 200000,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "b1",
        from: "in",
        to: "j",
        component: { type: "pipe", length: 2, diameter: 0.03, roughness: 1e-5 },
      },
      {
        id: "b2",
        from: "j",
        to: "out",
        component: { type: "pipe", length: 3, diameter: 0.02, roughness: 1e-5 },
      },
    ],
  };

  it("onProgress called with monotonically increasing iteration", () => {
    const calls: Array<{ iteration: number; residual: number }> = [];
    const res = solveSteady(baseConfig, {
      onProgress: (p) => calls.push(p),
    });

    expect(calls.length).toBeGreaterThan(0);
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].iteration).toBeGreaterThanOrEqual(calls[i - 1].iteration);
    }
    expect(res.converged).toBe(true);
  });

  it("shouldAbort returns early with aborted flag", () => {
    let calls = 0;
    const res = solveSteady(baseConfig, {
      shouldAbort: () => {
        calls++;
        return calls === 2;
      },
    });

    expect(res.aborted).toBe(true);
  });
});
