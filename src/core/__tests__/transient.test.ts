import { describe, it, expect } from "vitest";
import { NetworkConfig } from "../schema";
import { solveTransient } from "../transient";
import { validateNetwork } from "../validate";

function makeConfig(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    meta: { name: "test", version: 2 },
    settings: {
      mode: "transient",
      tolerance: 1e-6,
      maxIterations: 200,
      relaxation: 0.9,
      ...overrides.settings,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [],
    branches: [],
    ...overrides,
  } as NetworkConfig;
}

/** RK4 integrator for system of ODEs dy/dt = f(t, y) where y is number[]. */
function rk4Vec(
  f: (t: number, y: number[]) => number[],
  y0: number[],
  t0: number,
  tf: number,
  dt: number,
): number[] {
  let y = [...y0];
  let t = t0;
  const steps = Math.ceil((tf - t0) / dt);
  const h = (tf - t0) / steps;
  for (let i = 0; i < steps; i++) {
    const k1 = f(t, y);
    const k2 = f(
      t + h / 2,
      y.map((v, j) => v + (h * k1[j]) / 2),
    );
    const k3 = f(
      t + h / 2,
      y.map((v, j) => v + (h * k2[j]) / 2),
    );
    const k4 = f(
      t + h,
      y.map((v, j) => v + h * k3[j]),
    );
    y = y.map((v, j) => v + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    t += h;
  }
  return y;
}

describe("Tank blowdown (transient)", () => {
  it("matches coupled mass+energy RK4 reference within 2% and shows first-order convergence", () => {
    const R = 287;
    const cp = 1005;
    const cv = cp - R;
    const T0 = 300;
    const V = 0.1;
    const P0 = 1e6;
    const Pout = 1e5;
    const A = 1e-4;
    const Cd = 0.6;
    const endTime = 2.0;

    const orificeMdot = (P: number, T: number) => {
      const rho = P / (R * T);
      const dP = Math.max(P - Pout, 1e-6);
      return Cd * A * Math.sqrt(2 * rho * dP);
    };

    const m0 = (P0 * V) / (R * T0);
    const U0 = m0 * cv * T0;

    const ode = (_t: number, y: number[]) => {
      const m = y[0];
      const U = y[1];
      const T = U / (m * cv);
      const P = (m * R * T) / V;
      const mdot = orificeMdot(P, T);
      return [-mdot, -mdot * cp * T];
    };

    const y_ref = rk4Vec(ode, [m0, U0], 0, endTime, 1e-4);
    const m_ref = y_ref[0];
    const U_ref = y_ref[1];
    const T_ref = U_ref / (m_ref * cv);
    const P_ref = (m_ref * R * T_ref) / V;

    const runSolver = (dt: number) => {
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
        nodes: [
          {
            id: "tank",
            type: "internal",
            x: 0,
            y: 0,
            pressure: P0,
            temperature: T0,
            volume: V,
          },
          {
            id: "out",
            type: "boundary",
            x: 1,
            y: 0,
            pressure: Pout,
            temperature: T0,
          },
        ],
        branches: [
          {
            id: "o1",
            from: "tank",
            to: "out",
            component: { type: "orifice", area: A, cd: Cd },
          },
        ],
      };
      return solveTransient(config);
    };

    const res1 = runSolver(0.1);
    const res2 = runSolver(0.05);

    const P1 = res1.nodes.tank.pressure[res1.nodes.tank.pressure.length - 1];
    const P2 = res2.nodes.tank.pressure[res2.nodes.tank.pressure.length - 1];

    const err1 = Math.abs(P1 - P_ref);
    const err2 = Math.abs(P2 - P_ref);
    const drop = P0 - P_ref;

    expect(err1 / drop).toBeLessThan(0.02);
    expect(err2 / drop).toBeLessThan(0.02);

    const ratio = err1 / err2;
    expect(ratio).toBeGreaterThanOrEqual(1.5);
    expect(ratio).toBeLessThanOrEqual(3.0);
  });
});

describe("Tank pressurization (transient)", () => {
  it("matches coupled mass+energy RK4 reference within 2%", () => {
    const R = 287;
    const cp = 1005;
    const cv = cp - R;
    const T_supply = 300;
    const V = 0.1;
    const P0 = 1e5;
    const P_supply = 5e5;
    const A = 0.001;
    const K = 10;
    const endTime = 5.0;

    const rhoSupply = P_supply / (R * T_supply);
    const resMdot = (P: number) => {
      const dP = Math.max(P_supply - P, 1e-6);
      return A * Math.sqrt((2 * rhoSupply * dP) / K);
    };

    const m0 = (P0 * V) / (R * T_supply);
    const U0 = m0 * cv * T_supply;

    const ode = (_t: number, y: number[]) => {
      const m = y[0];
      const U = y[1];
      const T = U / (m * cv);
      const P = (m * R * T) / V;
      const mdot = resMdot(P);
      return [mdot, mdot * cp * T_supply];
    };

    const y_ref = rk4Vec(ode, [m0, U0], 0, endTime, 1e-4);
    const m_ref = y_ref[0];
    const U_ref = y_ref[1];
    const T_ref = U_ref / (m_ref * cv);
    const P_ref = (m_ref * R * T_ref) / V;

    const config: NetworkConfig = {
      meta: { name: "test", version: 2 },
      settings: {
        mode: "transient",
        dt: 0.05,
        endTime,
        tolerance: 1e-6,
        maxIterations: 200,
        relaxation: 0.9,
      },
      fluid: { model: "idealGas", preset: "air" },
      nodes: [
        {
          id: "tank",
          type: "internal",
          x: 0,
          y: 0,
          pressure: P0,
          temperature: T_supply,
          volume: V,
        },
        {
          id: "sup",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: P_supply,
          temperature: T_supply,
        },
      ],
      branches: [
        {
          id: "r1",
          from: "sup",
          to: "tank",
          component: { type: "resistance", k: K, area: A },
        },
      ],
    };

    const res = solveTransient(config);
    const P_solver =
      res.nodes.tank.pressure[res.nodes.tank.pressure.length - 1];
    const err = Math.abs(P_solver - P_ref);
    // Compare within 2% of the total pressure rise
    expect(err / (P_supply - P0)).toBeLessThan(0.02);
  });
});

describe("Thermal transient", () => {
  it("matches analytical exponential within 2%", () => {
    const rho = 998;
    const V = 0.01;
    const T0 = 300;
    const T_in = 350;
    const P = 2e5;
    const A = 0.001;
    const Cd = 0.6;
    const deltaP = 50000;

    // Quasi-steady mdot through one orifice with ΔP = 50000
    const mdot = Cd * A * Math.sqrt(2 * rho * deltaP);
    const tau = (rho * V) / mdot;
    const dt = tau / 50;
    const endTime = 3 * tau;

    const analyticalT = (t: number) => T_in + (T0 - T_in) * Math.exp(-t / tau);

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
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P + deltaP,
          temperature: T_in,
        },
        {
          id: "tank",
          type: "internal",
          x: 1,
          y: 0,
          pressure: P,
          temperature: T0,
          volume: V,
        },
        {
          id: "out",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: P - deltaP,
          temperature: T0,
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

    const res = solveTransient(config);
    const idx1 = Math.round(tau / dt);
    const idx3 = Math.round((3 * tau) / dt);

    const T1_solver = res.nodes.tank.temperature[idx1];
    const T3_solver = res.nodes.tank.temperature[idx3];

    expect(Math.abs(T1_solver - analyticalT(tau)) / T_in).toBeLessThan(0.02);
    expect(Math.abs(T3_solver - analyticalT(3 * tau)) / T_in).toBeLessThan(
      0.02,
    );
  });
});

describe("Valve schedule transient", () => {
  it("mdot at each time matches quasi-steady solve within 1%", () => {
    const rho = 998;
    const A = 0.001;
    const Cd = 0.6;
    const deltaP = 10000;
    const dt = 0.01;
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
          id: "v1",
          from: "A",
          to: "B",
          component: {
            type: "valve",
            area: A,
            cd: Cd,
            position: 0,
            positionSchedule: [
              [0, 0],
              [endTime, 1],
            ],
          },
        },
      ],
    };

    const res = solveTransient(config);
    const mdots = res.branches.v1.mdot;

    // Skip t=0 initial state (initial guess, not solved)
    for (let i = 1; i < mdots.length; i++) {
      const t = res.times[i];
      const pos = t / endTime; // linear ramp 0→1
      const effCdA = Math.max(Cd * A * pos, 1e-9);
      const expectedMdot = effCdA * Math.sqrt(2 * rho * deltaP);
      expect(Math.abs(mdots[i] - expectedMdot) / expectedMdot).toBeLessThan(
        0.01,
      );
    }
  });
});

describe("Global conservation", () => {
  it("blowdown mass balance: discharged mass equals tank mass change", () => {
    const R = 287;
    const T = 300;
    const V = 0.1;
    const P0 = 1e6;
    const Pout = 1e5;
    const A = 1e-4;
    const Cd = 0.6;
    const dt = 0.1;
    const endTime = 2.0;

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
      nodes: [
        {
          id: "tank",
          type: "internal",
          x: 0,
          y: 0,
          pressure: P0,
          temperature: T,
          volume: V,
        },
        {
          id: "out",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: Pout,
          temperature: T,
        },
      ],
      branches: [
        {
          id: "o1",
          from: "tank",
          to: "out",
          component: { type: "orifice", area: A, cd: Cd },
        },
      ],
    };

    const res = solveTransient(config);
    const mdots = res.branches.o1.mdot;
    let totalDischarged = 0;
    for (let i = 1; i < mdots.length; i++) {
      totalDischarged += Math.abs(mdots[i]) * dt;
    }

    const rho0 = P0 / (R * T);
    const rhoFinal = res.nodes.tank.density[res.nodes.tank.density.length - 1];
    const tankMassChange = V * (rho0 - rhoFinal);

    expect(
      Math.abs(totalDischarged - tankMassChange) / tankMassChange,
    ).toBeLessThan(0.005);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// New validation tests for corrected internal-energy storage
// ═══════════════════════════════════════════════════════════════════════

describe("Adiabatic blowdown cooling law", () => {
  it("obeys T/T0 = (m/m0)^(gamma−1) within 1%", () => {
    const R = 287;
    const gamma = 1.4;
    const T0 = 300;
    const V = 0.1;
    const P0 = 1e6;
    const Pout = 1e5;
    const A = 1e-4;
    const Cd = 0.6;
    const endTime = 2.0;
    const dt = 0.05;

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
      nodes: [
        {
          id: "tank",
          type: "internal",
          x: 0,
          y: 0,
          pressure: P0,
          temperature: T0,
          volume: V,
        },
        {
          id: "out",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: Pout,
          temperature: T0,
        },
      ],
      branches: [
        {
          id: "o1",
          from: "tank",
          to: "out",
          component: { type: "orifice", area: A, cd: Cd },
        },
      ],
    };

    const res = solveTransient(config);
    const m0 = (P0 * V) / (R * T0);

    const checkTimes = [0.5, 1.0, 1.5, 2.0];
    for (const t of checkTimes) {
      const idx = Math.round(t / dt);
      if (idx >= res.times.length) continue;
      const m = res.nodes.tank.density[idx] * V;
      const T = res.nodes.tank.temperature[idx];
      const expectedT = T0 * Math.pow(m / m0, gamma - 1);
      expect(Math.abs(T - expectedT) / T0).toBeLessThan(0.01);
    }

    // Final temperature must be meaningfully below T0
    const finalT =
      res.nodes.tank.temperature[res.nodes.tank.temperature.length - 1];
    expect(finalT).toBeLessThan(0.95 * T0);
  });
});

describe("Adiabatic fill heating", () => {
  it("tank temperature rises above supply T and stays below gamma·T_supply", () => {
    const R = 287;
    const gamma = 1.4;
    const cp = 1005;
    const cv = cp - R;
    const T_supply = 300;
    const V = 0.1;
    const P0 = 1e5;
    const P_supply = 5e5;
    const A = 0.001;
    const K = 10;
    const endTime = 5.0;
    const dt = 0.05;

    const rhoSupply = P_supply / (R * T_supply);
    const resMdot = (P: number) => {
      const dP = Math.max(P_supply - P, 1e-6);
      return A * Math.sqrt((2 * rhoSupply * dP) / K);
    };

    const m0 = (P0 * V) / (R * T_supply);
    const U0 = m0 * cv * T_supply;

    const ode = (_t: number, y: number[]) => {
      const m = y[0];
      const U = y[1];
      const T = U / (m * cv);
      const P = (m * R * T) / V;
      const mdot = resMdot(P);
      return [mdot, mdot * cp * T_supply];
    };

    const y_ref = rk4Vec(ode, [m0, U0], 0, endTime, 1e-4);
    const m_ref = y_ref[0];
    const U_ref = y_ref[1];
    const T_ref = U_ref / (m_ref * cv);

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
      nodes: [
        {
          id: "tank",
          type: "internal",
          x: 0,
          y: 0,
          pressure: P0,
          temperature: T_supply,
          volume: V,
        },
        {
          id: "sup",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: P_supply,
          temperature: T_supply,
        },
      ],
      branches: [
        {
          id: "r1",
          from: "sup",
          to: "tank",
          component: { type: "resistance", k: K, area: A },
        },
      ],
    };

    const res = solveTransient(config);
    const T_final =
      res.nodes.tank.temperature[res.nodes.tank.temperature.length - 1];

    expect(T_final).toBeGreaterThan(T_supply);
    expect(T_final).toBeLessThan(gamma * T_supply);
    expect(Math.abs(T_final - T_ref) / T_ref).toBeLessThan(0.02);
  });
});

describe("Liquid regression (transient thermal time constant)", () => {
  it("still matches analytical exponential within 2% after core fix", () => {
    const rho = 998;
    const V = 0.01;
    const T0 = 300;
    const T_in = 350;
    const P = 2e5;
    const A = 0.001;
    const Cd = 0.6;
    const deltaP = 50000;

    const mdot = Cd * A * Math.sqrt(2 * rho * deltaP);
    const tau = (rho * V) / mdot;
    const dt = tau / 50;
    const endTime = 3 * tau;

    const analyticalT = (t: number) => T_in + (T0 - T_in) * Math.exp(-t / tau);

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
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P + deltaP,
          temperature: T_in,
        },
        {
          id: "tank",
          type: "internal",
          x: 1,
          y: 0,
          pressure: P,
          temperature: T0,
          volume: V,
        },
        {
          id: "out",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: P - deltaP,
          temperature: T0,
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

    const res = solveTransient(config);
    const idx1 = Math.round(tau / dt);
    const idx3 = Math.round((3 * tau) / dt);

    const T1_solver = res.nodes.tank.temperature[idx1];
    const T3_solver = res.nodes.tank.temperature[idx3];

    expect(Math.abs(T1_solver - analyticalT(tau)) / T_in).toBeLessThan(0.02);
    expect(Math.abs(T3_solver - analyticalT(3 * tau)) / T_in).toBeLessThan(
      0.02,
    );
  });
});

describe("Isothermal-limit sanity (blowdown with huge convection conductor)", () => {
  it("tank temperature stays within 1 K of ambient", () => {
    const T0 = 300;
    const Tamb = 300;
    const V = 0.1;
    const P0 = 1e6;
    const Pout = 1e5;
    const A = 1e-4;
    const Cd = 0.6;
    const endTime = 2.0;
    const dt = 0.1;

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
      nodes: [
        {
          id: "tank",
          type: "internal",
          x: 0,
          y: 0,
          pressure: P0,
          temperature: T0,
          volume: V,
        },
        {
          id: "out",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: Pout,
          temperature: Tamb,
        },
      ],
      solidNodes: [
        { id: "amb", type: "ambient", x: 2, y: 0, temperature: Tamb },
      ],
      conductors: [
        {
          id: "c1",
          from: "tank",
          to: "amb",
          type: { kind: "convection", h: 1e6, area: 1.0 },
        },
      ],
      branches: [
        {
          id: "o1",
          from: "tank",
          to: "out",
          component: { type: "orifice", area: A, cd: Cd },
        },
      ],
    };

    const res = solveTransient(config);
    for (let i = 0; i < res.nodes.tank.temperature.length; i++) {
      expect(Math.abs(res.nodes.tank.temperature[i] - Tamb)).toBeLessThan(1.0);
    }
  });
});

describe("Validation tests", () => {
  it("catches missing volume in transient", () => {
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
    expect(errs.some((e) => e.includes("volume"))).toBe(true);
  });

  it("catches missing dt in transient", () => {
    const config = makeConfig({
      settings: {
        mode: "transient",
        endTime: 1,
        tolerance: 1e-6,
        maxIterations: 100,
      },
      nodes: [
        {
          id: "A",
          type: "internal",
          x: 0,
          y: 0,
          pressure: 1e5,
          temperature: 300,
          volume: 0.1,
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
      branches: [],
    });
    const errs = validateNetwork(config);
    expect(errs.some((e) => e.includes("dt"))).toBe(true);
  });

  it("catches missing endTime in transient", () => {
    const config = makeConfig({
      settings: {
        mode: "transient",
        dt: 0.1,
        tolerance: 1e-6,
        maxIterations: 100,
      },
      nodes: [
        {
          id: "A",
          type: "internal",
          x: 0,
          y: 0,
          pressure: 1e5,
          temperature: 300,
          volume: 0.1,
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
      branches: [],
    });
    const errs = validateNetwork(config);
    expect(errs.some((e) => e.includes("endTime"))).toBe(true);
  });

  it("catches bad pump curve", () => {
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
          id: "p1",
          from: "A",
          to: "B",
          component: {
            type: "pump",
            curve: [
              [0, 100],
              [1, 200],
            ],
          },
        },
      ],
    });
    const errs = validateNetwork(config);
    expect(errs.some((e) => e.includes("monotonically decreasing"))).toBe(true);
  });

  it("catches pump curve with non-ascending flow points", () => {
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
          id: "p1",
          from: "A",
          to: "B",
          component: {
            type: "pump",
            curve: [
              [1, 200],
              [0, 100],
            ],
          },
        },
      ],
    });
    const errs = validateNetwork(config);
    expect(
      errs.some((e) => e.includes("flow points must be strictly increasing")),
    ).toBe(true);
  });

  it("catches valve position out of range", () => {
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
          id: "v1",
          from: "A",
          to: "B",
          component: { type: "valve", area: 0.001, cd: 0.6, position: 1.5 },
        },
      ],
    });
    const errs = validateNetwork(config);
    expect(errs.some((e) => e.includes("position"))).toBe(true);
  });
});

describe("Progress & abort hooks", () => {
  const baseConfig: NetworkConfig = {
    meta: { name: "test", version: 2 },
    settings: {
      mode: "transient",
      dt: 0.1,
      endTime: 5.0,
      tolerance: 1e-6,
      maxIterations: 200,
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
        volume: 0.1,
      },
      {
        id: "ambient",
        type: "boundary",
        x: 300,
        y: 0,
        pressure: 101325,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "orifice",
        from: "tank",
        to: "ambient",
        component: { type: "orifice", area: 0.0001, cd: 0.6 },
      },
    ],
  };

  it("onProgress called with monotonically increasing step/time and matching array lengths", () => {
    const calls: Array<{
      step: number;
      totalSteps?: number;
      time: number;
      endTime: number;
      dt?: number;
      partial: ReturnType<typeof solveTransient>;
    }> = [];
    const res = solveTransient(baseConfig, {
      onProgress: (p) => calls.push(p),
    });

    expect(calls.length).toBeGreaterThan(0);
    const steps = Math.round(
      baseConfig.settings.endTime! / baseConfig.settings.dt!,
    );
    // First call is the initial state at step 0; remaining calls are during the loop.
    expect(calls[0].step).toBe(0);
    expect(calls[calls.length - 1].step).toBe(steps);

    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].step).toBeGreaterThanOrEqual(calls[i - 1].step);
      expect(calls[i].time).toBeGreaterThanOrEqual(calls[i - 1].time);
    }

    const last = calls[calls.length - 1].partial;
    expect(last.times.length).toBe(res.times.length);
    expect(last.nodes.tank.pressure.length).toBe(
      res.nodes.tank.pressure.length,
    );
    expect(last.branches.orifice.mdot.length).toBe(
      res.branches.orifice.mdot.length,
    );
  });

  it("default progressInterval ≈ every 200 emissions max", () => {
    const steps = 500;
    const config: NetworkConfig = {
      ...baseConfig,
      settings: { ...baseConfig.settings, dt: 0.01, endTime: steps * 0.01 },
    };
    const calls: number[] = [];
    solveTransient(config, {
      onProgress: (p) => calls.push(p.step),
    });
    const expectedInterval = Math.max(1, Math.floor(steps / 200)); // 2
    // Should emit roughly every 2 steps plus the final step
    for (let i = 0; i < calls.length - 1; i++) {
      const delta = calls[i + 1] - calls[i];
      expect(delta).toBeGreaterThanOrEqual(expectedInterval);
    }
    expect(calls[calls.length - 1]).toBe(steps);
  });

  it("shouldAbort at step k returns arrays of length ≈k and aborted flag", () => {
    const abortAt = 12;
    let stepCount = 0;
    const res = solveTransient(baseConfig, {
      shouldAbort: () => {
        stepCount++;
        return stepCount === abortAt;
      },
    });

    expect(res.aborted).toBe(true);
    // shouldAbort is checked at the top of each loop iteration before solving.
    // When it returns true at step=abortAt, that step is NOT solved.
    // So we have initial state (t=0) + (abortAt - 1) solved steps = abortAt entries.
    expect(res.times.length).toBe(abortAt);
    expect(res.nodes.tank.pressure.length).toBe(abortAt);
    expect(res.branches.orifice.mdot.length).toBe(abortAt);
  });

  it("custom progressInterval respected", () => {
    const calls: number[] = [];
    solveTransient(baseConfig, {
      progressInterval: 5,
      onProgress: (p) => calls.push(p.step),
    });
    for (let i = 0; i < calls.length - 1; i++) {
      const delta = calls[i + 1] - calls[i];
      expect(delta).toBe(5);
    }
  });
});
