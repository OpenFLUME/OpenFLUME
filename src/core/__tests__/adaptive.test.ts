import { describe, it, expect } from "vitest";
import { NetworkConfig } from "../schema";
import { solveTransient } from "../transient";

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

function makeBlowdownConfig(
  endTime: number,
  overrides: Partial<NetworkConfig["settings"]> = {},
): NetworkConfig {
  return {
    meta: { name: "blowdown", version: 2 },
    settings: {
      mode: "transient",
      dt: 0.1,
      endTime,
      tolerance: 1e-6,
      maxIterations: 200,
      relaxation: 0.9,
      ...overrides,
    },
    fluid: { model: "idealGas", preset: "air" },
    nodes: [
      {
        id: "tank",
        type: "internal",
        x: 0,
        y: 0,
        pressure: 1e6,
        temperature: 300,
        volume: 0.1,
      },
      {
        id: "out",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "o1",
        from: "tank",
        to: "out",
        component: { type: "orifice", area: 1e-4, cd: 0.6 },
      },
    ],
  };
}

function blowdownReference(endTime: number) {
  const R = 287;
  const cp = 1005;
  const cv = cp - R;
  const T0 = 300;
  const V = 0.1;
  const P0 = 1e6;
  const Pout = 1e5;
  const A = 1e-4;
  const Cd = 0.6;

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
  return { P_ref, T_ref };
}

describe("Adaptive time stepping", () => {
  it("accuracy: tank blowdown adaptive (relTol 1e-4) matches RK4 within 2%", () => {
    const endTime = 2.0;
    const { P_ref } = blowdownReference(endTime);

    const config = makeBlowdownConfig(endTime, {
      timeStepping: "adaptive",
      adaptive: { dtMin: 0.001, dtMax: 0.2, relTol: 1e-4, safety: 0.9 },
    });

    const res = solveTransient(config);
    expect(res.converged).toBe(true);
    expect(res.stats).toBeDefined();
    expect(res.times[res.times.length - 1]).toBe(endTime);

    const P_final = res.nodes.tank.pressure[res.nodes.tank.pressure.length - 1];
    const err = Math.abs(P_final - P_ref);
    const drop = 1e6 - P_ref;
    expect(err / drop).toBeLessThan(0.02);
  });

  it("efficiency: valve-schedule transient shrinks dt in ramp and grows in plateau", () => {
    const endTime = 5.0;
    const config: NetworkConfig = {
      meta: { name: "valve", version: 2 },
      settings: {
        mode: "transient",
        timeStepping: "adaptive",
        adaptive: { dtMin: 0.001, dtMax: 1.0, relTol: 1e-3, safety: 0.9 },
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
            area: 0.001,
            cd: 0.6,
            position: 0,
            positionSchedule: [
              [0, 0],
              [1, 1],
              [endTime, 1],
            ],
          },
        },
      ],
    };

    const res = solveTransient(config);
    expect(res.converged).toBe(true);
    expect(res.stats).toBeDefined();

    // Compute dt array from non-uniform times
    const dts: number[] = [];
    for (let i = 1; i < res.times.length; i++) {
      dts.push(res.times[i] - res.times[i - 1]);
    }

    // Ramp window: t in [0,1]; plateau: t in [1,5]
    const rampDts = dts.filter((_, i) => res.times[i + 1] <= 1);
    const plateauDts = dts.filter((_, i) => res.times[i] >= 1);

    const rampMin = Math.min(...rampDts);
    const plateauMax = Math.max(...plateauDts);
    const medianDt = dts.slice().sort((a, b) => a - b)[
      Math.floor(dts.length / 2)
    ];

    expect(rampMin).toBeLessThan(0.3 * medianDt);
    expect(plateauMax).toBeGreaterThan(3 * rampMin);

    // Adaptive should use fewer steps than fixed with dt = minDt
    const fixedConfig: NetworkConfig = {
      ...config,
      settings: {
        ...config.settings,
        timeStepping: "fixed",
        dt: res.stats!.minDt,
      },
    };
    const fixedRes = solveTransient(fixedConfig);
    expect(res.stats!.steps).toBeLessThan(fixedRes.times.length);
  });

  it("tolerance ordering: end-state error decreases (non-increasing) with tighter relTol", () => {
    const endTime = 2.0;
    const { P_ref } = blowdownReference(endTime);
    const drop = 1e6 - P_ref;

    const tols = [1e-2, 1e-3, 1e-4];
    const errors: number[] = [];
    for (const relTol of tols) {
      const config = makeBlowdownConfig(endTime, {
        timeStepping: "adaptive",
        adaptive: { dtMin: 0.001, dtMax: 0.2, relTol, safety: 0.9 },
      });
      const res = solveTransient(config);
      const P_final =
        res.nodes.tank.pressure[res.nodes.tank.pressure.length - 1];
      errors.push(Math.abs(P_final - P_ref) / drop);
    }

    for (let i = 1; i < errors.length; i++) {
      expect(errors[i]).toBeLessThanOrEqual(errors[i - 1] + 0.001); // allow tiny noise
    }
  });

  it("event alignment: times[] contains every schedule breakpoint exactly", () => {
    const endTime = 5.0;
    const breakpoints = [0.5, 1.2, 3.0, endTime];
    const config: NetworkConfig = {
      meta: { name: "events", version: 2 },
      settings: {
        mode: "transient",
        timeStepping: "adaptive",
        adaptive: { dtMin: 0.001, dtMax: 0.5, relTol: 1e-3 },
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
          pressureSchedule: [
            [0, 200000],
            [breakpoints[0], 210000],
            [breakpoints[1], 220000],
            [breakpoints[2], 230000],
            [endTime, 240000],
          ],
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
          component: { type: "valve", area: 0.001, cd: 0.6, position: 0.5 },
        },
      ],
    };

    const res = solveTransient(config);
    expect(res.converged).toBe(true);

    for (const b of breakpoints) {
      expect(res.times).toContain(b);
    }

    // No step should straddle a breakpoint
    for (let i = 1; i < res.times.length; i++) {
      const t0 = res.times[i - 1];
      const t1 = res.times[i];
      for (const b of breakpoints) {
        if (b > t0 && b < t1) {
          throw new Error(`Step straddles breakpoint ${b}: ${t0} -> ${t1}`);
        }
      }
    }
  });

  it("robustness: absurdly tight tol hits dtMin floor and completes with stats", () => {
    const endTime = 1.0;
    const config = makeBlowdownConfig(endTime, {
      timeStepping: "adaptive",
      adaptive: {
        dtMin: 0.001,
        dtMax: 0.05,
        relTol: 1e-10,
        absTolP: 1e-6,
        absTolT: 1e-6,
        safety: 0.9,
      },
    });

    const res = solveTransient(config);
    expect(res.stats).toBeDefined();
    expect(res.stats!.dtAtMinCount).toBeGreaterThan(0);
    expect(res.stats!.rejectedSteps).toBeGreaterThan(0);
    expect(res.converged).toBe(true);
    expect(res.stats!.accuracyLimited).toBe(true);
    expect(res.times[res.times.length - 1]).toBe(endTime);
  });

  it("robustness: abort mid-run works and progress times are monotone", () => {
    const endTime = 5.0;
    const config = makeBlowdownConfig(endTime, {
      timeStepping: "adaptive",
      adaptive: { dtMin: 0.001, dtMax: 0.2, relTol: 1e-3 },
    });

    const progressCalls: Array<{ time: number; dt?: number }> = [];
    let abortAfter = 0.3;
    const res = solveTransient(config, {
      onProgress: (p) => progressCalls.push({ time: p.time, dt: p.dt }),
      shouldAbort: () => {
        // abort once we pass 0.3 s
        return (
          progressCalls.length > 0 &&
          progressCalls[progressCalls.length - 1].time > abortAfter
        );
      },
    });

    expect(res.aborted).toBe(true);
    expect(res.times[res.times.length - 1]).toBeLessThan(endTime);
    expect(res.times[res.times.length - 1]).toBeGreaterThan(0);

    for (let i = 1; i < progressCalls.length; i++) {
      expect(progressCalls[i].time).toBeGreaterThanOrEqual(
        progressCalls[i - 1].time,
      );
    }
  });

  it("backward compat: fixed mode without timeStepping is byte-identical to explicit fixed", () => {
    const endTime = 1.0;
    const configNoFlag = makeBlowdownConfig(endTime);
    const configFixed = makeBlowdownConfig(endTime, { timeStepping: "fixed" });

    const res1 = solveTransient(configNoFlag);
    const res2 = solveTransient(configFixed);

    expect(res1.times).toEqual(res2.times);
    expect(res1.nodes.tank.pressure).toEqual(res2.nodes.tank.pressure);
    expect(res1.nodes.tank.temperature).toEqual(res2.nodes.tank.temperature);
    expect(res1.branches.o1.mdot).toEqual(res2.branches.o1.mdot);
  });
});
