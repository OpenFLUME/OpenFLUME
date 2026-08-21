import { describe, it, expect } from "vitest";
import { NetworkConfig } from "../schema";
import { solveSteady } from "../solver";

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

describe("Pump operating point", () => {
  it("matches analytical intersection within 0.5%", () => {
    const rho = 998;
    const A = 0.01;
    const K = 80;
    const pumpCurve: Array<[number, number]> = [
      [0, 50000],
      [0.01, 40000],
      [0.02, 20000],
      [0.03, 0],
    ];

    // Resistance pressure drop for given Q
    const resDP = (Q: number) => (K * rho * Q * Math.abs(Q)) / (2 * A * A);
    // Pump rise for given Q
    const pumpRise = (Q: number) => {
      const c = pumpCurve;
      if (Q <= c[0][0]) {
        const slope = (c[1][1] - c[0][1]) / (c[1][0] - c[0][0]);
        return c[0][1] + slope * (Q - c[0][0]);
      }
      if (Q >= c[c.length - 1][0]) {
        const slope =
          (c[c.length - 1][1] - c[c.length - 2][1]) /
          (c[c.length - 1][0] - c[c.length - 2][0]);
        return c[c.length - 1][1] + slope * (Q - c[c.length - 1][0]);
      }
      for (let i = 0; i < c.length - 1; i++) {
        if (Q >= c[i][0] && Q <= c[i + 1][0]) {
          const dx = c[i + 1][0] - c[i][0];
          const frac = (Q - c[i][0]) / dx;
          return c[i][1] + frac * (c[i + 1][1] - c[i][1]);
        }
      }
      return c[c.length - 1][1];
    };

    // Bisection on difference
    let Qlo = 1e-6;
    let Qhi = 0.03;
    let Qmid = 0;
    for (let i = 0; i < 60; i++) {
      Qmid = (Qlo + Qhi) / 2;
      const diff = pumpRise(Qmid) - resDP(Qmid);
      if (diff > 0) Qlo = Qmid;
      else Qhi = Qmid;
    }
    const expectedMdot = Qmid * rho;

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
          id: "M",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "pump",
          from: "A",
          to: "M",
          component: { type: "pump", curve: pumpCurve },
        },
        {
          id: "res",
          from: "M",
          to: "A",
          component: { type: "resistance", k: K, area: A },
        },
      ],
    });

    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    const mdot = res.branches.pump.mdot;
    expect(Math.abs(mdot - expectedMdot) / Math.abs(expectedMdot)).toBeLessThan(
      0.005,
    );
  });
});

describe("Check valve", () => {
  it("forward flow matches orifice within 1%", () => {
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
          id: "cv",
          from: "A",
          to: "B",
          component: { type: "checkValve", area: A, cd: Cd },
        },
      ],
    });

    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(
      Math.abs(res.branches.cv.mdot - expectedMdot) / expectedMdot,
    ).toBeLessThan(0.01);
  });

  it("reverse flow leakage < 1e-6 of forward flow at same |ΔP|", () => {
    const rho = 998;
    const A = 0.001;
    const Cd = 0.6;
    const deltaP = 10000;
    const expectedForward = Cd * A * Math.sqrt(2 * rho * deltaP);

    const config = makeConfig({
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 200000 - deltaP,
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
          id: "cv",
          from: "A",
          to: "B",
          component: { type: "checkValve", area: A, cd: Cd },
        },
      ],
    });

    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    const rev = Math.abs(res.branches.cv.mdot);
    expect(rev / expectedForward).toBeLessThan(1e-6);
  });
});

describe("Dynamic check valve (steady solve)", () => {
  it("holds the fixed initialPosition and matches the orifice equation at that position", () => {
    const rho = 998;
    const A = 0.001;
    const Cd = 0.6;
    const pos = 0.4;
    const deltaP = 10000;
    const effArea = Cd * A * pos;
    const expectedMdot = effArea * Math.sqrt(2 * rho * deltaP);

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
          id: "dcv",
          from: "A",
          to: "B",
          component: {
            type: "dynamicCheckValve",
            area: A,
            cd: Cd,
            mass: 0.05,
            springRate: 5000,
            preload: 50,
            damping: 5,
            stroke: 0.005,
            initialPosition: pos,
          },
        },
      ],
    });

    // Steady solves never call advanceState — position stays at initialPosition.
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(
      Math.abs(res.branches.dcv.mdot - expectedMdot) / expectedMdot,
    ).toBeLessThan(0.01);
  });

  it("a closed valve (initialPosition 0) blocks flow like the floor area", () => {
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
          pressure: 150000,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "dcv",
          from: "A",
          to: "B",
          component: {
            type: "dynamicCheckValve",
            area: 0.001,
            cd: 0.6,
            mass: 0.05,
            springRate: 5000,
            preload: 50,
            damping: 5,
            stroke: 0.005,
            initialPosition: 0,
          },
        },
      ],
    });
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    // Fully-shut floor area (1e-9 m²) throttles flow to a tiny fraction of a
    // 0.001 m² orifice at the same ΔP.
    const openMdot = 0.6 * 0.001 * Math.sqrt(2 * 998 * 50000);
    expect(Math.abs(res.branches.dcv.mdot) / openMdot).toBeLessThan(1e-3);
  });
});

describe("Valve position sweep", () => {
  it("mdot scales with position for fixed ΔP", () => {
    const A = 0.001;
    const Cd = 0.6;
    const deltaP = 10000;

    const run = (pos: number) => {
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
            id: "v",
            from: "A",
            to: "B",
            component: { type: "valve", area: A, cd: Cd, position: pos },
          },
        ],
      });
      return solveSteady(config);
    };

    const res1 = run(1.0);
    const res05 = run(0.5);
    const res02 = run(0.2);
    const res0 = run(0);

    expect(res1.converged).toBe(true);
    expect(res05.converged).toBe(true);
    expect(res02.converged).toBe(true);
    expect(res0.converged).toBe(true);

    const m1 = Math.abs(res1.branches.v.mdot);
    const m05 = Math.abs(res05.branches.v.mdot);
    const m02 = Math.abs(res02.branches.v.mdot);
    const m0 = Math.abs(res0.branches.v.mdot);

    expect(Math.abs(m05 - 0.5 * m1) / (0.5 * m1)).toBeLessThan(0.01);
    expect(Math.abs(m02 - 0.2 * m1) / (0.2 * m1)).toBeLessThan(0.01);
    expect(m0).toBeLessThan(m1 * 0.001); // near zero
  });
});
