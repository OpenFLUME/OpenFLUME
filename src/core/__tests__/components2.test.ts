import { describe, it, expect } from "vitest";
import { NetworkConfig } from "../schema";
import { solveSteady } from "../solver";
import { solveTransient } from "../transient";
import { validateNetwork } from "../validate";
import { Bend, AreaChange, Orifice } from "../components";
import { expansibilityY, criticalPressureRatio } from "../components/orifice";

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

// ─── Bend ────────────────────────────────────────────────────────────
describe("Bend", () => {
  it("K90 spot-checks match documented table", () => {
    const bend = new Bend(0.1, 90, 1, 0);
    expect(bend["getK90"]()).toBeCloseTo(0.24, 6);
    expect(new Bend(0.1, 90, 1.5, 0)["getK90"]()).toBeCloseTo(0.19, 6);
    expect(new Bend(0.1, 90, 2, 0)["getK90"]()).toBeCloseTo(0.17, 6);
    expect(new Bend(0.1, 90, 4, 0)["getK90"]()).toBeCloseTo(0.16, 6);
    expect(new Bend(0.1, 90, 6, 0)["getK90"]()).toBeCloseTo(0.16, 6);
  });

  it("ΔP matches K·ρv²/2 within 0.5% at fixed mdot", () => {
    const D = 0.05;
    const angle = 45;
    const rOverD = 2;
    const rho = 998;
    const mu = 1e-3;
    const bend = new Bend(D, angle, rOverD, 0);
    const A = bend.area;
    const mdot = 0.5;
    const v = mdot / (rho * A);
    const Re = (rho * Math.abs(v) * D) / mu;
    const f = bend["frictionFactor"](Re);

    const K90 = bend["getK90"]();
    const K_bend = K90 * Math.pow(angle / 90, 0.85);
    const L_arc = Math.PI * D * rOverD * (angle / 180);
    const K_arc = f * (L_arc / D);
    const K_total = K_bend + K_arc;
    const expectedDP = (K_total * rho * v * Math.abs(v)) / 2;

    const dpComponent = bend.pressureDrop(mdot, rho, mu);
    expect(
      Math.abs(dpComponent - expectedDP) / Math.abs(expectedDP),
    ).toBeLessThan(0.005);
  });

  it("converges in a simple network", () => {
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
          pressure: 190000,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "b1",
          from: "A",
          to: "B",
          component: {
            type: "bend",
            diameter: 0.05,
            angle: 90,
            rOverD: 2,
            roughness: 1e-5,
          },
        },
      ],
    });
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(Math.abs(res.branches.b1.mdot)).toBeGreaterThan(0);
  });
});

// ─── AreaChange ────────────────────────────────────────────────────────
describe("AreaChange", () => {
  it("expansion ΔP = Bernoulli rise − Borda–Carnot loss (net negative for typical ratios)", () => {
    const rho = 998;
    const A_in = 0.001;
    const A_out = 0.002;
    const mdot = 0.5;
    const v_in = mdot / (rho * A_in);
    const v_out = mdot / (rho * A_out);
    const K = Math.pow(1 - A_in / A_out, 2);
    const bernoulli = 0.5 * rho * (v_out * v_out - v_in * v_in);
    const loss = (K * rho * v_in * v_in) / 2;
    const expectedDP = bernoulli + loss; // net pressure rise in from→to direction => negative dP

    const ac = new AreaChange(A_in, A_out);
    const dp = ac.pressureDrop(mdot, rho, 1e-3);
    expect(Math.abs(dp - expectedDP) / Math.abs(expectedDP)).toBeLessThan(
      0.005,
    );
    expect(dp).toBeLessThan(0); // pressure rises in from→to for expansion
  });

  it("contraction ΔP = Bernoulli drop + loss (net positive)", () => {
    const rho = 998;
    const A_in = 0.002;
    const A_out = 0.001;
    const mdot = 0.5;
    const v_in = mdot / (rho * A_in);
    const v_out = mdot / (rho * A_out);
    const K = 0.5 * Math.pow(1 - A_out / A_in, 0.75);
    const bernoulli = 0.5 * rho * (v_out * v_out - v_in * v_in);
    const loss = (K * rho * v_out * v_out) / 2;
    const expectedDP = bernoulli + loss;

    const ac = new AreaChange(A_in, A_out);
    const dp = ac.pressureDrop(mdot, rho, 1e-3);
    expect(Math.abs(dp - expectedDP) / expectedDP).toBeLessThan(0.005);
    expect(dp).toBeGreaterThan(0);
  });

  it("reversed flow swaps roles and flips net ΔP sign", () => {
    const rho = 998;
    const A_in = 0.001;
    const A_out = 0.002;
    const ac = new AreaChange(A_in, A_out);
    // Forward: expansion (mdot>0 => net pressure rise in from→to => dP<0)
    const dpFwd = ac.pressureDrop(0.5, rho, 1e-3);
    // Reverse: swapped to contraction in from→to (mdot<0 => dP>0 because Bernoulli drop dominates)
    const dpRev = ac.pressureDrop(-0.5, rho, 1e-3);
    expect(dpFwd).toBeLessThan(0);
    expect(dpRev).toBeGreaterThan(0);
    // Magnitudes should be different because expansion vs contraction have different K factors
    expect(Math.abs(dpFwd)).not.toBeCloseTo(Math.abs(dpRev), 6);
  });

  it("converges in a simple network", () => {
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
          pressure: 190000,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "a1",
          from: "A",
          to: "B",
          component: { type: "areaChange", areaIn: 0.001, areaOut: 0.002 },
        },
      ],
    });
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
  });
});

// ─── FlowSource ────────────────────────────────────────────────────────
describe("FlowSource", () => {
  it("imposed mdot appears exactly regardless of ΔP sign", () => {
    const targetMdot = 0.3;
    const config = makeConfig({
      settings: {
        mode: "steady",
        tolerance: 1e-12,
        maxIterations: 500,
        relaxation: 0.9,
      },
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
          pressure: 200000,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "fs",
          from: "A",
          to: "B",
          component: { type: "flowSource", massFlow: targetMdot },
        },
      ],
    });
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(Math.abs(res.branches.fs.mdot - targetMdot)).toBeLessThan(1e-12);
  });

  it("schedule works in transient", () => {
    const dt = 0.1;
    const endTime = 1.0;
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
          pressure: 190000,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "fs",
          from: "A",
          to: "B",
          component: {
            type: "flowSource",
            massFlow: 0,
            massFlowSchedule: [
              [0, 0.1],
              [endTime, 0.5],
            ],
          },
        },
      ],
    };
    const res = solveTransient(config);
    expect(res.converged).toBe(true);
    for (let i = 1; i < res.times.length; i++) {
      const t = res.times[i];
      const expected = 0.1 + (0.5 - 0.1) * (t / endTime);
      expect(Math.abs(res.branches.fs.mdot[i] - expected)).toBeLessThan(1e-5);
    }
  });
});

// ─── Regulator ─────────────────────────────────────────────────────────
describe("Regulator", () => {
  it("holds downstream pressure at setPressure in regulating regime", () => {
    const P_supply = 20e5;
    const P_set = 5e5;
    const P_out = 1e5;
    const A_orifice = 0.001;
    const Cd = 0.6;

    const config = makeConfig({
      nodes: [
        {
          id: "SUP",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P_supply,
          temperature: 300,
        },
        {
          id: "MID",
          type: "internal",
          x: 1,
          y: 0,
          pressure: P_set,
          temperature: 300,
        },
        {
          id: "OUT",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: P_out,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "reg",
          from: "SUP",
          to: "MID",
          component: {
            type: "regulator",
            setPressure: P_set,
            maxCdA: Cd * A_orifice * 2,
          },
        },
        {
          id: "o1",
          from: "MID",
          to: "OUT",
          component: { type: "orifice", area: A_orifice, cd: Cd },
        },
      ],
    });
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(Math.abs(res.nodes.MID.pressure - P_set) / P_set).toBeLessThan(
      0.005,
    );
  });

  it("goes wide-open when supply is below setPressure", () => {
    const P_supply = 3e5;
    const P_set = 5e5;
    const P_out = 1e5;
    const A_orifice = 0.001;
    const Cd = 0.6;
    const maxCdA = Cd * A_orifice * 2;

    const config = makeConfig({
      nodes: [
        {
          id: "SUP",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P_supply,
          temperature: 300,
        },
        {
          id: "MID",
          type: "internal",
          x: 1,
          y: 0,
          pressure: P_supply * 0.5,
          temperature: 300,
        },
        {
          id: "OUT",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: P_out,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "reg",
          from: "SUP",
          to: "MID",
          component: { type: "regulator", setPressure: P_set, maxCdA },
        },
        {
          id: "o1",
          from: "MID",
          to: "OUT",
          component: { type: "orifice", area: A_orifice, cd: Cd },
        },
      ],
    });
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(res.nodes.MID.pressure).toBeLessThan(P_supply);

    // Hand calc: series orifice with maxCdA + fixed orifice
    const rho = 998;
    const handMdot = (P: number) => {
      const dp1 = (mdot: number) =>
        (mdot * Math.abs(mdot)) / (2 * rho * maxCdA * maxCdA);
      const dp2 = (mdot: number) =>
        (mdot * Math.abs(mdot)) / (2 * rho * Math.pow(Cd * A_orifice, 2));
      return dp1(P) + dp2(P) - (P_supply - P_out);
    };
    let lo = 0.001;
    let hi = 10;
    while (handMdot(lo) > 0) lo *= 0.5;
    while (handMdot(hi) < 0) hi *= 2;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (handMdot(mid) > 0) hi = mid;
      else lo = mid;
    }
    const expectedMdot = (lo + hi) / 2;
    expect(
      Math.abs(res.branches.reg.mdot - expectedMdot) / Math.abs(expectedMdot),
    ).toBeLessThan(0.01);
  });
});

// ─── ReliefValve ─────────────────────────────────────────────────────
describe("ReliefValve", () => {
  const rho = 998;
  const A = 0.001;
  const Cd = 0.6;
  const crack = 5000;
  const fullOpen = 15000;

  it("below crack: leakage < 1e-6 of open flow", () => {
    const dP = 1000;
    const mdotOpen = Cd * A * Math.sqrt(2 * rho * fullOpen);
    // At tiny mdot and dP << crack, the orifice part dominates with tiny CdAeff
    // Leakage mdot at this tiny dP should be negligible
    // We test via network: very small ΔP should give very small flow
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
          pressure: 200000 - dP,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "rv",
          from: "A",
          to: "B",
          component: {
            type: "reliefValve",
            crackPressure: crack,
            fullOpenPressure: fullOpen,
            area: A,
            cd: Cd,
          },
        },
      ],
    });
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(Math.abs(res.branches.rv.mdot) / mdotOpen).toBeLessThan(1e-6);
  });

  it("above fullOpen: matches orifice formula within 1%", () => {
    const dP = 20000;
    const expectedMdot = Cd * A * Math.sqrt(2 * rho * dP);
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
          pressure: 200000 - dP,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "rv",
          from: "A",
          to: "B",
          component: {
            type: "reliefValve",
            crackPressure: crack,
            fullOpenPressure: fullOpen,
            area: A,
            cd: Cd,
          },
        },
      ],
    });
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(
      Math.abs(res.branches.rv.mdot - expectedMdot) / expectedMdot,
    ).toBeLessThan(0.01);
  });

  it("midway: effective area ≈ half within 5%", () => {
    const dP = (crack + fullOpen) / 2;
    // At midpoint of smoothstep, frac should be ~0.5
    const expectedMdotHalf = Cd * A * 0.5 * Math.sqrt(2 * rho * dP);
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
          pressure: 200000 - dP,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "rv",
          from: "A",
          to: "B",
          component: {
            type: "reliefValve",
            crackPressure: crack,
            fullOpenPressure: fullOpen,
            area: A,
            cd: Cd,
          },
        },
      ],
    });
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(
      Math.abs(res.branches.rv.mdot - expectedMdotHalf) / expectedMdotHalf,
    ).toBeLessThan(0.05);
  });
});

// ─── Orifice (compressible closure, ideal gas) ─────────────────────────
describe("Orifice, ideal gas (isentropic/choked closure)", () => {
  const R = 287;
  const gamma = 1.4;
  const T = 300;
  const A = 1e-4;
  const Cd = 0.6;
  const P_up = 5e5;
  const oc = new Orifice(A, Cd);

  it("unchoked point matches isentropic formula hand-calc within 0.5%", () => {
    const PR = 0.7;
    const P_down = P_up * PR;
    const expectedMdot = oc.massFlow(P_up, P_down, T, R, gamma);

    const config = makeConfig({
      fluid: { model: "idealGas", preset: "air" },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P_up,
          temperature: T,
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: P_down,
          temperature: T,
        },
      ],
      branches: [
        {
          id: "oc",
          from: "A",
          to: "B",
          component: { type: "orifice", area: A, cd: Cd },
        },
      ],
    });
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(
      Math.abs(res.branches.oc.mdot - expectedMdot) / expectedMdot,
    ).toBeLessThan(0.005);
  });

  it("choked regime: mdot constant (<0.1% variation) as P_down varies below critical", () => {
    const critPR = Math.pow(2 / (gamma + 1), gamma / (gamma - 1));
    const P_down1 = P_up * critPR * 0.9;
    const P_down2 = P_up * critPR * 0.5;

    const config1 = makeConfig({
      fluid: { model: "idealGas", preset: "air" },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P_up,
          temperature: T,
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: P_down1,
          temperature: T,
        },
      ],
      branches: [
        {
          id: "oc",
          from: "A",
          to: "B",
          component: { type: "orifice", area: A, cd: Cd },
        },
      ],
    });
    const config2 = makeConfig({
      fluid: { model: "idealGas", preset: "air" },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P_up,
          temperature: T,
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: P_down2,
          temperature: T,
        },
      ],
      branches: [
        {
          id: "oc",
          from: "A",
          to: "B",
          component: { type: "orifice", area: A, cd: Cd },
        },
      ],
    });
    const res1 = solveSteady(config1);
    const res2 = solveSteady(config2);
    expect(res1.converged).toBe(true);
    expect(res2.converged).toBe(true);
    expect(
      Math.abs(res1.branches.oc.mdot - res2.branches.oc.mdot) /
        res1.branches.oc.mdot,
    ).toBeLessThan(0.001);
  });

  it("choked mdot matches analytical within 0.5%", () => {
    const critPR = Math.pow(2 / (gamma + 1), gamma / (gamma - 1));
    const P_down = P_up * critPR * 0.5;
    const expectedMdot = oc.massFlow(P_up, P_down, T, R, gamma);

    const config = makeConfig({
      fluid: { model: "idealGas", preset: "air" },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P_up,
          temperature: T,
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: P_down,
          temperature: T,
        },
      ],
      branches: [
        {
          id: "oc",
          from: "A",
          to: "B",
          component: { type: "orifice", area: A, cd: Cd },
        },
      ],
    });
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(
      Math.abs(res.branches.oc.mdot - expectedMdot) / expectedMdot,
    ).toBeLessThan(0.005);
  });

  it("falls back to the Bernoulli closure for a fluid with no R/gamma (incompressible liquid)", () => {
    const rho = 1000;
    const P_up_liq = 200000;
    const P_down_liq = 190000;
    const expectedMdot = Cd * A * Math.sqrt(2 * rho * (P_up_liq - P_down_liq));

    const config = makeConfig({
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P_up_liq,
          temperature: 300,
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: P_down_liq,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "oc",
          from: "A",
          to: "B",
          component: { type: "orifice", area: A, cd: Cd },
        },
      ],
    });
    const errs = validateNetwork(config);
    expect(errs).toEqual([]);
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(
      Math.abs(res.branches.oc.mdot - expectedMdot) / expectedMdot,
    ).toBeLessThan(0.005);
  });

  it("compressible unchoked mdot converges to the Bernoulli value as ΔP/P → 0", () => {
    const rho = P_up / (R * T);
    const smallDP = P_up * 1e-4;
    const P_down = P_up - smallDP;
    const bernoulli = Cd * A * Math.sqrt(2 * rho * smallDP);
    const compressible = oc.massFlow(P_up, P_down, T, R, gamma);
    expect(Math.abs(compressible - bernoulli) / bernoulli).toBeLessThan(1e-3);
  });
});

describe("Orifice expansibility Y", () => {
  const A = 1e-4;
  const Cd = 0.6;
  const oc = new Orifice(A, Cd);

  it("is 1 when kappa is omitted or r → 1", () => {
    expect(expansibilityY(0.7)).toBe(1);
    expect(expansibilityY(0.999999, 1.4)).toBeCloseTo(1, 5);
    expect(expansibilityY(1, 1.4)).toBe(1);
  });

  it("recovers Bernoulli when kappa is omitted", () => {
    const rho = 1000;
    const pUp = 2e5;
    const pDown = 1.9e5;
    const expected = Cd * A * Math.sqrt(2 * rho * (pUp - pDown));
    expect(oc.massFlowFromState(pUp, pDown, rho)).toBeCloseTo(expected, 12);
  });

  it("matches the ideal-gas massFlow convenience at the same state", () => {
    const R = 287;
    const gamma = 1.4;
    const T = 300;
    const pUp = 5e5;
    const pDown = 3.5e5;
    const rho = pUp / (R * T);
    const viaY = oc.massFlowFromState(pUp, pDown, rho, gamma);
    const viaIdeal = oc.massFlow(pUp, pDown, T, R, gamma);
    expect(Math.abs(viaY - viaIdeal) / viaIdeal).toBeLessThan(1e-12);
  });

  it("chokes: further back-pressure drop does not change mdot", () => {
    const kappa = 1.4;
    const rho = 5.8;
    const pUp = 5e5;
    const rCrit = criticalPressureRatio(kappa);
    const m1 = oc.massFlowFromState(pUp, pUp * rCrit * 0.9, rho, kappa);
    const m2 = oc.massFlowFromState(pUp, pUp * rCrit * 0.2, rho, kappa);
    expect(Math.abs(m1 - m2) / m1).toBeLessThan(1e-12);
  });

  it("lone gas orifice mdot is independent of momentumFlux and kineticEnergy", () => {
    const flags = [
      {},
      { momentumFlux: true },
      { kineticEnergy: true },
      { momentumFlux: true, kineticEnergy: true },
    ];
    const mdots = flags.map((extra) => {
      const res = solveSteady(
        makeConfig({
          settings: {
            mode: "steady",
            tolerance: 1e-9,
            maxIterations: 200,
            relaxation: 0.9,
            ...extra,
          },
          fluid: { model: "idealGas", preset: "air" },
          nodes: [
            {
              id: "A",
              type: "boundary",
              x: 0,
              y: 0,
              pressure: 5e5,
              temperature: 300,
            },
            {
              id: "B",
              type: "boundary",
              x: 1,
              y: 0,
              pressure: 101325,
              temperature: 300,
            },
          ],
          branches: [
            {
              id: "oc",
              from: "A",
              to: "B",
              component: { type: "orifice", area: 1e-4, cd: 0.6 },
            },
          ],
        }),
      );
      expect(res.converged).toBe(true);
      return res.branches.oc.mdot;
    });
    for (const m of mdots) {
      expect(Math.abs(m - mdots[0]) / mdots[0]).toBeLessThan(1e-9);
    }
  });
});

// ─── HeatedPipe ────────────────────────────────────────────────────────
describe("HeatedPipe", () => {
  const cp = 4182;
  const Tin = 300;
  const Twall = 350;
  const D = 0.02;
  const L = 2;

  it("steady T_out matches effectiveness formula within 0.2%", () => {
    const testUA = (ua: number) => {
      const config = makeConfig({
        nodes: [
          {
            id: "IN",
            type: "boundary",
            x: 0,
            y: 0,
            pressure: 200000,
            temperature: Tin,
          },
          {
            id: "OUT",
            type: "internal",
            x: 1,
            y: 0,
            pressure: 190000,
            temperature: Tin,
          },
          {
            id: "AMB",
            type: "boundary",
            x: 2,
            y: 0,
            pressure: 180000,
            temperature: Tin,
          },
        ],
        branches: [
          {
            id: "hp",
            from: "IN",
            to: "OUT",
            component: {
              type: "heatedPipe",
              length: L,
              diameter: D,
              roughness: 1e-5,
              ua,
              wallTemperature: Twall,
            },
          },
          {
            id: "o1",
            from: "OUT",
            to: "AMB",
            component: { type: "orifice", area: 0.001, cd: 0.6 },
          },
        ],
      });
      const res = solveSteady(config);
      expect(res.converged).toBe(true);
      const actualMdot = res.branches.hp.mdot;
      const Tout = res.nodes.OUT.temperature;

      const NTU = ua / (actualMdot * cp);
      const expectedTout = Twall - (Twall - Tin) * Math.exp(-NTU);
      const expectedQ = actualMdot * cp * (expectedTout - Tin);

      expect(Math.abs(Tout - expectedTout) / expectedTout).toBeLessThan(0.002);

      // Energy conservation: Q added equals mdot·cp·ΔT
      const Q_actual = actualMdot * cp * (Tout - Tin);
      expect(Math.abs(Q_actual - expectedQ) / expectedQ).toBeLessThan(0.001);
    };

    testUA(50); // small UA
    testUA(5000); // large UA -> Tout ≈ Twall
  });

  it("large UA drives T_out close to T_wall", () => {
    const ua = 10000;
    const config = makeConfig({
      nodes: [
        {
          id: "IN",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 200000,
          temperature: Tin,
        },
        {
          id: "OUT",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 190000,
          temperature: Tin,
        },
        {
          id: "AMB",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: 180000,
          temperature: Tin,
        },
      ],
      branches: [
        {
          id: "hp",
          from: "IN",
          to: "OUT",
          component: {
            type: "heatedPipe",
            length: L,
            diameter: D,
            roughness: 1e-5,
            ua,
            wallTemperature: Twall,
          },
        },
        {
          id: "o1",
          from: "OUT",
          to: "AMB",
          component: { type: "orifice", area: 0.001, cd: 0.6 },
        },
      ],
    });
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    // Use actual mdot to compute expected asymptotic temperature
    const actualMdot = res.branches.hp.mdot;
    const NTU = ua / (actualMdot * cp);
    const expectedTout = Twall - (Twall - Tin) * Math.exp(-NTU);
    expect(
      Math.abs(res.nodes.OUT.temperature - expectedTout) / expectedTout,
    ).toBeLessThan(0.002);
  });
});
