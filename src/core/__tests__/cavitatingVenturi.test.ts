import { describe, it, expect, beforeAll } from "vitest";
import { NetworkConfig } from "../schema";
import { solveSteady, initRealFluids, RealFluid, CavitatingVenturi } from "../";
import { validateNetwork } from "../validate";
import { getCoolProp } from "../fluids/coolprop";

const P_IN = 5.5158e6;
const T_IN = 244.26;
const D_THROAT = 0.0025;
const A_THROAT = Math.PI * Math.pow(D_THROAT / 2, 2);
const Cd = 1.0;

let P_V: number;
let RHO_F: number;

beforeAll(async () => {
  await initRealFluids();
  const cp = getCoolProp();
  P_V = cp.PropsSI("P", "T", T_IN, "Q", 0, "NitrousOxide");
  RHO_F = cp.PropsSI("D", "P", P_IN, "T", T_IN, "NitrousOxide");
}, 30000);

function makeConfig(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    meta: { name: "test", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-6,
      maxIterations: 200,
      relaxation: 0.9,
    },
    fluid: { model: "realFluid", params: { fluidName: "NitrousOxide" } },
    nodes: [],
    branches: [],
    ...overrides,
  } as NetworkConfig;
}

describe("CavitatingVenturi component", () => {
  it("validates with zero errors for realFluid", () => {
    const config = makeConfig({
      nodes: [
        {
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P_IN,
          temperature: T_IN,
        },
        {
          id: "out",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: P_V * 0.5,
          temperature: T_IN,
        },
      ],
      branches: [
        {
          id: "cv",
          from: "in",
          to: "out",
          component: {
            type: "cavitatingVenturi",
            throatArea: A_THROAT,
            cd: Cd,
          },
        },
      ],
    });
    expect(validateNetwork(config)).toEqual([]);
  });

  it("rejects non-realFluid fluid model", () => {
    const config = makeConfig({
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P_IN,
          temperature: T_IN,
        },
        {
          id: "out",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: P_V * 0.5,
          temperature: T_IN,
        },
      ],
      branches: [
        {
          id: "cv",
          from: "in",
          to: "out",
          component: {
            type: "cavitatingVenturi",
            throatArea: A_THROAT,
            cd: Cd,
          },
        },
      ],
    });
    const errs = validateNetwork(config);
    expect(errs.some((e) => e.includes("realFluid"))).toBe(true);
  });

  it(
    "cavitating regime: mdot matches analytical choked formula within 1%",
    { timeout: 30000 },
    () => {
      const expectedMdot = Cd * A_THROAT * Math.sqrt(2 * RHO_F * (P_IN - P_V));
      const config = makeConfig({
        nodes: [
          {
            id: "in",
            type: "boundary",
            x: 0,
            y: 0,
            pressure: P_IN,
            temperature: T_IN,
          },
          {
            id: "out",
            type: "boundary",
            x: 1,
            y: 0,
            pressure: 1.0e6,
            temperature: T_IN,
          },
        ],
        branches: [
          {
            id: "cv",
            from: "in",
            to: "out",
            component: {
              type: "cavitatingVenturi",
              throatArea: A_THROAT,
              cd: Cd,
            },
          },
        ],
      });
      const res = solveSteady(config);
      expect(res.converged).toBe(true);
      const mdot = res.branches.cv.mdot;
      expect(Math.abs(mdot - expectedMdot) / expectedMdot).toBeLessThan(0.01);
    },
  );

  it(
    "downstream independence: mdot variation < 0.5% across pressures well below Pv",
    { timeout: 60000 },
    () => {
      const outlets = [1.0e6, 0.8e6, 0.5e6];
      const mdots: number[] = [];
      for (const pOut of outlets) {
        const config = makeConfig({
          nodes: [
            {
              id: "in",
              type: "boundary",
              x: 0,
              y: 0,
              pressure: P_IN,
              temperature: T_IN,
            },
            {
              id: "out",
              type: "boundary",
              x: 1,
              y: 0,
              pressure: pOut,
              temperature: T_IN,
            },
          ],
          branches: [
            {
              id: "cv",
              from: "in",
              to: "out",
              component: {
                type: "cavitatingVenturi",
                throatArea: A_THROAT,
                cd: Cd,
              },
            },
          ],
        });
        const res = solveSteady(config);
        expect(res.converged).toBe(true);
        mdots.push(res.branches.cv.mdot);
      }
      const maxM = Math.max(...mdots);
      const minM = Math.min(...mdots);
      expect(Math.abs(maxM - minM) / Math.abs(maxM)).toBeLessThan(0.005);
    },
  );

  it(
    "non-cavitating regime: matches incompressible orifice formula within 1% and depends on P_down",
    { timeout: 30000 },
    () => {
      // P_out = 5.0 MPa → small ΔP, no cavitation expected
      const pOut1 = 5.0e6;
      const dp1 = P_IN - pOut1;
      const expected1 = Cd * A_THROAT * Math.sqrt(2 * RHO_F * dp1);

      const config1 = makeConfig({
        nodes: [
          {
            id: "in",
            type: "boundary",
            x: 0,
            y: 0,
            pressure: P_IN,
            temperature: T_IN,
          },
          {
            id: "out",
            type: "boundary",
            x: 1,
            y: 0,
            pressure: pOut1,
            temperature: T_IN,
          },
        ],
        branches: [
          {
            id: "cv",
            from: "in",
            to: "out",
            component: {
              type: "cavitatingVenturi",
              throatArea: A_THROAT,
              cd: Cd,
            },
          },
        ],
      });
      const res1 = solveSteady(config1);
      expect(res1.converged).toBe(true);
      expect(
        Math.abs(res1.branches.cv.mdot - expected1) / expected1,
      ).toBeLessThan(0.01);

      // Higher P_out → lower mdot
      const pOut2 = 5.2e6;
      const config2 = makeConfig({
        nodes: [
          {
            id: "in",
            type: "boundary",
            x: 0,
            y: 0,
            pressure: P_IN,
            temperature: T_IN,
          },
          {
            id: "out",
            type: "boundary",
            x: 1,
            y: 0,
            pressure: pOut2,
            temperature: T_IN,
          },
        ],
        branches: [
          {
            id: "cv",
            from: "in",
            to: "out",
            component: {
              type: "cavitatingVenturi",
              throatArea: A_THROAT,
              cd: Cd,
            },
          },
        ],
      });
      const res2 = solveSteady(config2);
      expect(res2.converged).toBe(true);
      expect(res2.branches.cv.mdot).toBeLessThan(res1.branches.cv.mdot);
    },
  );

  it("transition smoothness: mdot is continuous and derivative bounded through Pv", () => {
    const fluid = new RealFluid("NitrousOxide");
    const cv = new CavitatingVenturi(A_THROAT, Cd);
    const pOuts: number[] = [];
    const mdots: number[] = [];
    const n = 200;
    const pMin = 1.0e6;
    const pMax = 5.0e6;
    for (let i = 0; i <= n; i++) {
      const pOut = pMin + (pMax - pMin) * (i / n);
      pOuts.push(pOut);
      mdots.push(cv.massFlow(P_IN, pOut, T_IN, fluid));
    }

    // No jump: maximum increase across the sweep must stay below 0.2 % of mdot
    let maxIncrease = 0;
    for (let i = 1; i < mdots.length; i++) {
      const increase = mdots[i] - mdots[i - 1];
      if (increase > maxIncrease) maxIncrease = increase;
    }
    expect(maxIncrease).toBeLessThanOrEqual(1e-3);

    // Numerical derivative bound (central differences)
    let maxDeriv = 0;
    for (let i = 1; i < mdots.length - 1; i++) {
      const dp = pOuts[i + 1] - pOuts[i - 1];
      const dm = mdots[i + 1] - mdots[i - 1];
      const deriv = Math.abs(dm / dp);
      if (deriv > maxDeriv) maxDeriv = deriv;
    }
    // Bound: 0.2 kg/s per MPa = 2e-7 kg/s per Pa
    expect(maxDeriv).toBeLessThan(2e-7);
  });
});
