import { describe, it, expect } from "vitest";
import { NetworkConfig } from "../schema";
import { solveSteady } from "../solver";
import { solveTransient } from "../transient";
import { validateNetwork } from "../validate";
import { Orifice } from "../components";

function makeConfig(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    meta: { name: "test", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-9,
      maxIterations: 500,
      relaxation: 0.9,
    },
    fluid: { model: "idealGas", preset: "air" },
    nodes: [],
    branches: [],
    ...overrides,
  } as NetworkConfig;
}

describe("Species transport (no reactions)", () => {
  it("pure mixing junction: outlet composition is flow-weighted average within 1e-6", () => {
    const P = 2e5;
    const T = 300;
    const A = 0.001;
    const Cd = 0.6;
    const dP = 10000;

    const config = makeConfig({
      species: {
        names: ["N2", "O2"],
        molecularWeights: [0.028, 0.032],
        cp: [1040, 920],
      },
      nodes: [
        {
          id: "in1",
          type: "boundary",
          x: 0,
          y: 1,
          pressure: P + dP,
          temperature: T,
          massFractions: { N2: 1.0, O2: 0.0 },
        },
        {
          id: "in2",
          type: "boundary",
          x: 0,
          y: -1,
          pressure: P + dP,
          temperature: T,
          massFractions: { N2: 0.0, O2: 1.0 },
        },
        {
          id: "mix",
          type: "internal",
          x: 1,
          y: 0,
          pressure: P,
          temperature: T,
        },
        {
          id: "out",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: P - dP,
          temperature: T,
          massFractions: { N2: 0.5, O2: 0.5 },
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

    expect(validateNetwork(config)).toHaveLength(0);
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    const mdot1 = res.branches.b1.mdot;
    const mdot2 = res.branches.b2.mdot;
    const expectedN2 = mdot1 / (mdot1 + mdot2);
    const expectedO2 = mdot2 / (mdot1 + mdot2);
    expect(Math.abs(res.nodes.mix.massFractions!.N2 - expectedN2)).toBeLessThan(
      1e-6,
    );
    expect(Math.abs(res.nodes.mix.massFractions!.O2 - expectedO2)).toBeLessThan(
      1e-6,
    );
  });

  it("transport with no reaction is conservative: species mass flux in = out within 1e-9 relative", () => {
    const P = 2e5;
    const T = 300;
    const A = 0.001;
    const Cd = 0.6;
    const dP = 10000;

    const config = makeConfig({
      species: {
        names: ["N2", "O2"],
        molecularWeights: [0.028, 0.032],
        cp: [1040, 920],
      },
      nodes: [
        {
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P + dP,
          temperature: T,
          massFractions: { N2: 0.8, O2: 0.2 },
        },
        { id: "m1", type: "internal", x: 1, y: 0, pressure: P, temperature: T },
        {
          id: "m2",
          type: "internal",
          x: 2,
          y: 0,
          pressure: P - dP / 2,
          temperature: T,
        },
        {
          id: "out",
          type: "boundary",
          x: 3,
          y: 0,
          pressure: P - dP,
          temperature: T,
          massFractions: { N2: 0.8, O2: 0.2 },
        },
      ],
      branches: [
        {
          id: "b1",
          from: "in",
          to: "m1",
          component: { type: "orifice", area: A, cd: Cd },
        },
        {
          id: "b2",
          from: "m1",
          to: "m2",
          component: { type: "orifice", area: A, cd: Cd },
        },
        {
          id: "b3",
          from: "m2",
          to: "out",
          component: { type: "orifice", area: A, cd: Cd },
        },
      ],
    });

    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    const mdotIn = res.branches.b1.mdot;
    const mdotOut = res.branches.b3.mdot;
    const Yin = { N2: 0.8, O2: 0.2 };
    const Yout = res.nodes.m2.massFractions!;
    for (const sp of ["N2", "O2"]) {
      const fluxIn = mdotIn * Yin[sp as "N2" | "O2"];
      const fluxOut = mdotOut * Yout[sp];
      const relErr =
        Math.abs(fluxIn - fluxOut) / Math.max(Math.abs(fluxIn), 1e-12);
      expect(relErr).toBeLessThan(1e-9);
    }
  });

  it("transient species residence time: step-change inlet gives exponential within 1%", () => {
    const R = 287;
    const T = 300;
    const P = 2e5;
    const V = 0.01;
    const A = 0.001;
    const Cd = 0.6;
    const dP = 50000;
    const rho = P / (R * T);
    const mdot = new Orifice(A, Cd).massFlow(P, P - dP, T, R, 1.4);
    const tau = (rho * V) / mdot;
    const dt = tau / 50;
    const endTime = 3 * tau;

    const config: NetworkConfig = {
      meta: { name: "test", version: 2 },
      settings: {
        mode: "transient",
        dt,
        endTime,
        tolerance: 1e-6,
        maxIterations: 200,
        relaxation: 0.9,
      },
      fluid: { model: "idealGas", preset: "air" },
      species: {
        names: ["N2", "O2"],
        molecularWeights: [0.028, 0.032],
        cp: [1040, 920],
      },
      nodes: [
        {
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P + dP,
          temperature: T,
          massFractions: { N2: 1.0, O2: 0.0 },
        },
        {
          id: "tank",
          type: "internal",
          x: 1,
          y: 0,
          pressure: P,
          temperature: T,
          volume: V,
          massFractions: { N2: 0.5, O2: 0.5 },
        },
        {
          id: "out",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: P - dP,
          temperature: T,
          massFractions: { N2: 1.0, O2: 0.0 },
        },
      ],
      branches: [
        {
          id: "o1",
          from: "in",
          to: "tank",
          component: { type: "orifice", area: A, cd: Cd },
        },
        {
          id: "o2",
          from: "tank",
          to: "out",
          component: { type: "orifice", area: A, cd: Cd },
        },
      ],
    };

    const analyticalY = (t: number) => 1.0 + (0.5 - 1.0) * Math.exp(-t / tau);

    const res = solveTransient(config);
    const idx1 = Math.round(tau / dt);
    const idx3 = Math.round((3 * tau) / dt);

    const Y1_solver = res.nodes.tank.massFractions!.N2[idx1];
    const Y3_solver = res.nodes.tank.massFractions!.N2[idx3];

    expect(Math.abs(Y1_solver - analyticalY(tau)) / 1.0).toBeLessThan(0.01);
    expect(Math.abs(Y3_solver - analyticalY(3 * tau)) / 1.0).toBeLessThan(0.01);
  });

  it("mixture density responds correctly to composition change (N2 vs He)", () => {
    const P = 1e5;
    const T = 300;
    const configN2 = makeConfig({
      species: {
        names: ["N2"],
        molecularWeights: [0.028],
        cp: [1040],
      },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P,
          temperature: T,
          massFractions: { N2: 1.0 },
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: P,
          temperature: T,
          massFractions: { N2: 1.0 },
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
    const configHe = makeConfig({
      species: {
        names: ["He"],
        molecularWeights: [0.004],
        cp: [5193],
      },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P,
          temperature: T,
          massFractions: { He: 1.0 },
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: P,
          temperature: T,
          massFractions: { He: 1.0 },
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

    const resN2 = solveSteady(configN2);
    const resHe = solveSteady(configHe);
    expect(resN2.converged).toBe(true);
    expect(resHe.converged).toBe(true);
    const rhoN2 = resN2.nodes.A.density;
    const rhoHe = resHe.nodes.A.density;
    expect(rhoN2 / rhoHe).toBeCloseTo(0.028 / 0.004, 2);
  });

  it("mixing junction energy balance uses MIXTURE cp, not the carrier's", () => {
    // The outer T-update solves Σ_in ṁ·h = ṁ_out·h(T_out) and inverts h → T.
    // With species present both sides must use the MIXTURE h/cp: reading the
    // carrier continuum's cp (air, 1005 J/kg·K) on both sides cancels it out
    // and collapses the balance to a MASS-weighted mean of the inlet
    // temperatures, which is only correct when every species shares one cp.
    //
    // Here the two inlets carry pure species with cp differing 3× at
    // temperatures differing 100 K, so the two answers are ~24 K apart:
    //   mixture-correct  T = Σ ṁᵢ·cpᵢ·Tᵢ / Σ ṁᵢ·cpᵢ   (enthalpy-weighted)
    //   carrier-cp bug   T = Σ ṁᵢ·Tᵢ / Σ ṁᵢ            (mass-weighted)
    // Equal molecular weights keep R_mix — hence ρ at fixed (P,T) — identical
    // for both streams, so the flow split is set purely by the inlet
    // temperatures and the assertion isolates the energy closure.
    const P = 2e5;
    const dP = 10000;
    const A = 0.001;
    const Cd = 0.6;
    const T_HOT = 400;
    const T_COLD = 300;
    const CP_HOT = 800;
    const CP_COLD = 2400;

    const config = makeConfig({
      species: {
        names: ["HOT", "COLD"],
        molecularWeights: [0.028, 0.028],
        cp: [CP_HOT, CP_COLD],
      },
      nodes: [
        {
          id: "in1",
          type: "boundary",
          x: 0,
          y: 1,
          pressure: P + dP,
          temperature: T_HOT,
          massFractions: { HOT: 1.0, COLD: 0.0 },
        },
        {
          id: "in2",
          type: "boundary",
          x: 0,
          y: -1,
          pressure: P + dP,
          temperature: T_COLD,
          massFractions: { HOT: 0.0, COLD: 1.0 },
        },
        {
          id: "mix",
          type: "internal",
          x: 1,
          y: 0,
          pressure: P,
          temperature: T_COLD,
        },
        {
          id: "out",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: P - dP,
          temperature: T_COLD,
          massFractions: { HOT: 0.5, COLD: 0.5 },
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

    expect(validateNetwork(config)).toHaveLength(0);
    const res = solveSteady(config);
    expect(res.converged).toBe(true);

    const mdot1 = res.branches.b1.mdot;
    const mdot2 = res.branches.b2.mdot;
    expect(mdot1).toBeGreaterThan(0);
    expect(mdot2).toBeGreaterThan(0);

    const Tmix = res.nodes.mix.temperature;
    const enthalpyWeighted =
      (mdot1 * CP_HOT * T_HOT + mdot2 * CP_COLD * T_COLD) /
      (mdot1 * CP_HOT + mdot2 * CP_COLD);
    const massWeighted = (mdot1 * T_HOT + mdot2 * T_COLD) / (mdot1 + mdot2);

    expect(Math.abs(Tmix - enthalpyWeighted)).toBeLessThan(0.05);
    // The two candidates are far apart, so this is a real discrimination and
    // not a tolerance accident.
    expect(Math.abs(enthalpyWeighted - massWeighted)).toBeGreaterThan(10);
    expect(Math.abs(Tmix - massWeighted)).toBeGreaterThan(10);

    // The invariant behind the number: mixture enthalpy in = mixture enthalpy
    // out, with the outlet composition the solver actually converged on.
    const Ymix = res.nodes.mix.massFractions!;
    const cpMix = Ymix.HOT * CP_HOT + Ymix.COLD * CP_COLD;
    const hIn = mdot1 * CP_HOT * T_HOT + mdot2 * CP_COLD * T_COLD;
    const hOut = res.branches.b3.mdot * cpMix * Tmix;
    expect(Math.abs(hIn - hOut) / Math.abs(hIn)).toBeLessThan(1e-6);
  });
});
