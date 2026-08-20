import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../schema";
import { solveTransient } from "../transient";
import { validateNetwork } from "../validate";

/**
 * Integration tests for the PID controller layer (core/controllerRuntime.ts):
 * actuation of valve position, flowSource mass flow and boundary pressure,
 * output limits, and validate.ts reference/type/range checks.
 *
 * Network arithmetic (incompressible water, rho = 998):
 *   valve (area A, cd): ΔP = m² / (2·rho·(cd·A·pos)²)
 *   resistance (k, A):  ΔP = k·m² / (2·rho·A²)  = 40.08·m² for k=8, A=0.01
 */

const R2_QUAD = 8 / (2 * 998 * 0.01 * 0.01); // Pa per (kg/s)²

function valveQuad(pos: number): number {
  const cdA = 0.6 * 0.01 * pos;
  return 1 / (2 * 998 * cdA * cdA);
}

function makeValveConfig(
  controller: NonNullable<NetworkConfig["controllers"]>[number],
): NetworkConfig {
  return {
    meta: { name: "ctrl-valve", version: 2 },
    settings: {
      mode: "transient",
      dt: 0.01,
      endTime: 0.3,
      tolerance: 1e-9,
      maxIterations: 200,
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
        id: "M",
        type: "internal",
        x: 0.5,
        y: 0,
        pressure: 150000,
        temperature: 300,
        volume: 0.01,
      },
      {
        id: "B",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: 100000,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "v1",
        from: "A",
        to: "M",
        component: { type: "valve", area: 0.01, cd: 0.6, position: 0.5 },
      },
      {
        id: "r2",
        from: "M",
        to: "B",
        component: { type: "resistance", k: 8, area: 0.01 },
      },
    ],
    controllers: [controller],
  } as NetworkConfig;
}

describe("PID controllers — valve actuation", () => {
  it("opens the valve toward an unreachable flow setpoint and clamps at the max limit", () => {
    // Flow setpoint (60 kg/s) is above the wide-open (pos=1) flow
    // m = sqrt(1e5 / (valveQuad(1) + R2_QUAD)) ≈ 43 kg/s, so the error
    // stays positive and the integral drives the output to the max limit.
    const cfg = makeValveConfig({
      id: "vpc",
      type: "pid",
      sense: { kind: "branch", id: "v1", quantity: "massFlow" },
      setpoint: 60,
      gains: { kp: 0.01, ki: 0.5, kd: 0 },
      output: { kind: "valvePosition", id: "v1" },
      limits: { min: 0.1, max: 1 },
      initialOutput: 0.3,
    });
    expect(validateNetwork(cfg)).toEqual([]);
    const res = solveTransient(cfg);
    expect(res.converged).toBe(true);

    const mdot = res.branches.v1.mdot;
    // Step 1 still sees the seeded initialOutput (pos = 0.3).
    const mSeeded = Math.sqrt(1e5 / (valveQuad(0.3) + R2_QUAD));
    expect(mdot[1]).toBeCloseTo(mSeeded, 6);
    // The controller then opens the valve: flow rises and the output
    // saturates exactly at the max limit.
    expect(mdot[mdot.length - 1]).toBeGreaterThan(mdot[1]);
    expect(res.finalControllerOutputs?.vpc).toBe(1);
    const mFull = Math.sqrt(1e5 / (valveQuad(1) + R2_QUAD));
    expect(mdot[mdot.length - 1]).toBeCloseTo(mFull, 4);
  });

  it("closes the valve to the min limit when the setpoint is below the achievable flow", () => {
    // Setpoint 5 kg/s is below the flow at the min position (≈ 8.4 kg/s),
    // so the output saturates at the min limit.
    const cfg = makeValveConfig({
      id: "vpc",
      type: "pid",
      sense: { kind: "branch", id: "v1", quantity: "massFlow" },
      setpoint: 5,
      gains: { kp: 0.01, ki: 0.5, kd: 0 },
      output: { kind: "valvePosition", id: "v1" },
      limits: { min: 0.1, max: 1 },
      initialOutput: 0.8,
    });
    const res = solveTransient(cfg);
    expect(res.converged).toBe(true);

    const mdot = res.branches.v1.mdot;
    const mSeeded = Math.sqrt(1e5 / (valveQuad(0.8) + R2_QUAD));
    expect(mdot[1]).toBeCloseTo(mSeeded, 6);
    expect(res.finalControllerOutputs?.vpc).toBe(0.1);
    expect(mdot[mdot.length - 1]).toBeLessThan(mdot[1]);
    const mMin = Math.sqrt(1e5 / (valveQuad(0.1) + R2_QUAD));
    expect(mdot[mdot.length - 1]).toBeCloseTo(mMin, 4);
  });
});

describe("PID controllers — flowSource actuation", () => {
  it("drives the flow source toward a pressure setpoint (override applies to the NEXT step)", () => {
    // A --fs--> M --r2--> B.  Pure-integral controller on M pressure; the
    // flowSource imposes the controller output exactly at the next step.
    const ki = 0.05;
    const cfg: NetworkConfig = {
      meta: { name: "ctrl-flowsource", version: 2 },
      settings: {
        mode: "transient",
        dt: 0.01,
        endTime: 0.2,
        tolerance: 1e-9,
        maxIterations: 200,
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
          id: "M",
          type: "internal",
          x: 0.5,
          y: 0,
          pressure: 100000,
          temperature: 300,
          volume: 0.01,
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: 100000,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "fs",
          from: "A",
          to: "M",
          component: {
            type: "flowSource",
            massFlow: 10,
            massFlowSchedule: [
              [0, 10],
              [1, 10],
            ],
          },
        },
        {
          id: "r2",
          from: "M",
          to: "B",
          component: { type: "resistance", k: 8, area: 0.01 },
        },
      ],
      controllers: [
        {
          id: "fc",
          type: "pid",
          sense: { kind: "node", id: "M", quantity: "pressure" },
          setpoint: 150000,
          gains: { kp: 0, ki, kd: 0 },
          output: { kind: "flowRate", id: "fs" },
          initialOutput: 10,
        },
      ],
    } as NetworkConfig;
    expect(validateNetwork(cfg)).toEqual([]);
    const res = solveTransient(cfg);
    expect(res.converged).toBe(true);

    const mdot = res.branches.fs.mdot;
    // Step 1 runs with the seeded initialOutput = 10 — the controller
    // override (written after step 1) applies from step 2 onwards.
    expect(mdot[1]).toBeCloseTo(10, 9);
    // After step 1: P_M = P_B + R2_QUAD·10² (incompressible ⇒ algebraic
    // continuity), so the first executed output is exactly ki·e·dt.
    const e1 = 150000 - (100000 + R2_QUAD * 100);
    expect(mdot[2]).toBeCloseTo(ki * e1 * 0.01, 6);
    // The integral controller then ramps the flow up toward the setpoint
    // flow (P_M = 1.5e5 ⇒ m = sqrt(5e4 / R2_QUAD) ≈ 35.3 kg/s), well above
    // the schedule base of 10 — the controller override wins over the
    // schedule.
    const mStar = Math.sqrt(50000 / R2_QUAD);
    expect(mdot[mdot.length - 1]).toBeCloseTo(mStar, 1);
    expect(res.finalControllerOutputs?.fc).toBeCloseTo(mStar, 1);
  });
});

describe("PID controllers — boundary pressure actuation", () => {
  it("raises the upstream boundary pressure toward a flow setpoint", () => {
    // A --r1--> M --r2--> B, both resistances k=8 (total 2·R2_QUAD).
    // Pure-integral controller on r1 flow actuates the boundary pressure
    // of A.  m* = 40 kg/s ⇒ P_A* = 1e5 + 2·R2_QUAD·40².
    const ki = 5e5;
    const cfg: NetworkConfig = {
      meta: { name: "ctrl-boundary", version: 2 },
      settings: {
        mode: "transient",
        dt: 0.01,
        endTime: 0.2,
        tolerance: 1e-9,
        maxIterations: 200,
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
          id: "M",
          type: "internal",
          x: 0.5,
          y: 0,
          pressure: 150000,
          temperature: 300,
          volume: 0.01,
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: 100000,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "r1",
          from: "A",
          to: "M",
          component: { type: "resistance", k: 8, area: 0.01 },
        },
        {
          id: "r2",
          from: "M",
          to: "B",
          component: { type: "resistance", k: 8, area: 0.01 },
        },
      ],
      controllers: [
        {
          id: "bc",
          type: "pid",
          sense: { kind: "branch", id: "r1", quantity: "massFlow" },
          setpoint: 40,
          gains: { kp: 0, ki, kd: 0 },
          output: { kind: "boundaryPressure", id: "A" },
          limits: { min: 1.2e5, max: 3e5 },
          initialOutput: 200000,
        },
      ],
    } as NetworkConfig;
    expect(validateNetwork(cfg)).toEqual([]);
    const res = solveTransient(cfg);
    expect(res.converged).toBe(true);

    const mdot = res.branches.r1.mdot;
    // Step 1 runs at the seeded boundary pressure 2e5.
    expect(mdot[1]).toBeCloseTo(Math.sqrt(1e5 / (2 * R2_QUAD)), 6);
    // Flow converges to the 40 kg/s setpoint from below/above and the
    // boundary pressure lands near the analytic value, inside limits.
    expect(mdot[mdot.length - 1]).toBeCloseTo(40, 1);
    const pStar = 1e5 + 2 * R2_QUAD * 40 * 40;
    expect(res.finalControllerOutputs?.bc).toBeCloseTo(pStar, -3);
    expect(res.finalControllerOutputs!.bc).toBeGreaterThanOrEqual(1.2e5);
    expect(res.finalControllerOutputs!.bc).toBeLessThanOrEqual(3e5);
  });
});

describe("PID controllers — validation", () => {
  const base = makeValveConfig({
    id: "c",
    type: "pid",
    sense: { kind: "node", id: "M", quantity: "pressure" },
    setpoint: 150000,
    gains: { kp: 1e-6, ki: 0, kd: 0 },
    output: { kind: "valvePosition", id: "v1" },
  });

  it("accepts a well-formed controller", () => {
    expect(validateNetwork(base)).toEqual([]);
  });

  it("rejects bad references, kinds, ranges and steady mode", () => {
    const cases: Array<{ mutate: (c: any) => void; pattern: RegExp }> = [
      {
        mutate: (c) => {
          c.type = "bangbang";
        },
        pattern: /type must be "pid"/,
      },
      {
        mutate: (c) => {
          c.on = "stepStart";
        },
        pattern: /on must be 'stepAccepted'/,
      },
      {
        mutate: (c) => {
          c.sense = { kind: "node", id: "ghost", quantity: "pressure" };
        },
        pattern: /sense references missing node: ghost/,
      },
      {
        mutate: (c) => {
          c.sense = { kind: "node", id: "M", quantity: "enthalpy" };
        },
        pattern:
          /sense\.quantity must be 'pressure', 'temperature' or 'density'/,
      },
      {
        mutate: (c) => {
          c.sense = { kind: "branch", id: "v1", quantity: "pressure" };
        },
        pattern: /sense\.quantity must be 'massFlow'/,
      },
      {
        mutate: (c) => {
          c.setpoint = Infinity;
        },
        pattern: /setpoint must be a finite number/,
      },
      {
        mutate: (c) => {
          c.gains.kd = NaN;
        },
        pattern: /gains\.kd must be a finite number/,
      },
      {
        mutate: (c) => {
          c.output = { kind: "valvePosition", id: "r2" };
        },
        pattern: /must be a valve branch/,
      },
      {
        mutate: (c) => {
          c.output = { kind: "flowRate", id: "v1" };
        },
        pattern: /must be a flowSource branch/,
      },
      {
        mutate: (c) => {
          c.output = { kind: "boundaryPressure", id: "M" };
        },
        pattern: /must be a boundary node/,
      },
      {
        mutate: (c) => {
          c.output = { kind: "heatInput", id: "ghost" };
        },
        pattern: /output references missing node: ghost/,
      },
      {
        mutate: (c) => {
          c.limits = { min: 1, max: 0 };
        },
        pattern: /limits\.min must be <= limits\.max/,
      },
    ];
    for (const { mutate, pattern } of cases) {
      const cfg = JSON.parse(JSON.stringify(base)) as NetworkConfig;
      mutate((cfg.controllers as any[])[0]);
      const errs = validateNetwork(cfg);
      expect(
        errs.some((e) => pattern.test(e)),
        `expected ${pattern} in ${JSON.stringify(errs)}`,
      ).toBe(true);
    }

    // Steady mode: controllers are transient-only.
    const steady = JSON.parse(JSON.stringify(base)) as NetworkConfig;
    steady.settings.mode = "steady";
    expect(
      validateNetwork(steady).some((e) =>
        /Controllers require settings\.mode "transient"/.test(e),
      ),
    ).toBe(true);
  });
});
