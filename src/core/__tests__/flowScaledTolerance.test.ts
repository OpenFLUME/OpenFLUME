/**
 * Flow-scaled mass rows in the Newton stopping test (solver/step.ts,
 * MASS_ROW_REF_FLOW).
 *
 * `tol` bounds a residual vector that mixes mass rows [kg/s] with momentum
 * rows [Pa].  At microfluidic flows (~1e-8 kg/s) every mass imbalance used
 * to sit below `tol` already, so a storage-driven transient was "converged"
 * at its warm start and froze.  These tests pin the fix: a syringe pump
 * charging a trapped bubble must follow its exact ODE at the default
 * tolerances, including the UI default 1e-6.
 */
import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../schema";
import { solveTransient } from "../transient";
import { solveSteady } from "../solver";
import { validateNetwork } from "../validate";
import { rectLaminarResistance } from "../components";

const P0 = 101325;
const RHO = 998;
const Q = 1e-9 / 60; // 1 µL/min
const V0 = 5e-9; // 5 µL bubble
const W = 200e-6;
const H = 20e-6;
const L = 0.02;
const R = rectLaminarResistance(W, H, L, 1e-3);
const T0 = (V0 * R) / P0;

/** Syringe pump (stepped from 1 to 2.5 µL/min) into a node holding a
 *  5 µL bubble, draining through one rectangular channel. */
function bubbleNetwork(tolerance: number, dt: number): NetworkConfig {
  const pStart = P0 + R * Q;
  return {
    meta: { name: "bubble", version: 2 },
    settings: {
      mode: "transient",
      tolerance,
      maxIterations: 200,
      dt,
      endTime: 6 * T0,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "src",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: P0,
        temperature: 293,
      },
      {
        id: "a",
        type: "internal",
        x: 0,
        y: 0,
        pressure: pStart,
        temperature: 293,
        volume: 50e-9,
        gasCushion: { initialGasVolume: V0, polytropicIndex: 1 },
      },
      {
        id: "out",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: P0,
        temperature: 293,
      },
    ],
    branches: [
      {
        id: "pump",
        from: "src",
        to: "a",
        initialMdot: Q * RHO,
        component: {
          type: "flowSource",
          massFlow: Q * RHO,
          massFlowSchedule: [
            [0, Q * RHO],
            [dt, Q * RHO],
            [dt * (1 + 1e-6), 2.5 * Q * RHO],
          ],
        },
      },
      {
        id: "ch",
        from: "a",
        to: "out",
        initialMdot: Q * RHO,
        component: { type: "rectChannel", width: W, height: H, length: L },
      },
    ],
  };
}

/** Exact isothermal-bubble ODE, dp/dt = (P0+p)²/(P_s V0)·(Q_s − p/R),
 *  integrated (RK4) onto the solver's own times. */
function reference(times: number[], dt: number): number[] {
  const K = (P0 + R * Q) * V0;
  let p = R * Q;
  let t = 0;
  const out = [p / R];
  for (let i = 1; i < times.length; i++) {
    const qs = times[i] > dt * (1 + 1e-9) ? 2.5 * Q : Q;
    const f = (x: number) => (((P0 + x) * (P0 + x)) / K) * (qs - x / R);
    const n = 20;
    const h = (times[i] - t) / n;
    for (let k = 0; k < n; k++) {
      const k1 = f(p);
      const k2 = f(p + (h / 2) * k1);
      const k3 = f(p + (h / 2) * k2);
      const k4 = f(p + h * k3);
      p += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    }
    t = times[i];
    out.push(p / R);
  }
  return out;
}

function maxRelError(tolerance: number, stepsPerT0: number): number {
  const dt = T0 / stepsPerT0;
  const cfg = bubbleNetwork(tolerance, dt);
  expect(validateNetwork(cfg)).toEqual([]);
  const r = solveTransient(cfg);
  expect(r.converged).toBe(true);
  const ref = reference(r.times, dt);
  let err = 0;
  r.branches.ch.mdot.forEach((m, i) => {
    err = Math.max(err, Math.abs(m / RHO - ref[i]) / (2.5 * Q));
  });
  return err;
}

describe("flow-scaled Newton tolerance at microfluidic flow rates", () => {
  it("tracks a bubble-damped syringe step at tol 1e-9 and at the UI default 1e-6", () => {
    for (const tol of [1e-9, 1e-6]) {
      // Measured on the previous solver: the 1e-6 run never left its initial
      // flow (error 0.60) and the 1e-9 run froze part-way (error 0.023).
      expect(maxRelError(tol, 100)).toBeLessThan(5e-3);
    }
  });

  it("converges first order in dt (the residual error is time integration, not the solver)", () => {
    const coarse = maxRelError(1e-6, 50);
    const fine = maxRelError(1e-6, 200);
    expect(coarse / fine).toBeGreaterThan(3.5);
  });

  it("solves a microfluidic flow split exactly at tol 1e-6 in steady state", () => {
    // Syringe into a junction feeding two channels of different length.
    const cfg: NetworkConfig = {
      meta: { name: "split", version: 2 },
      settings: { mode: "steady", tolerance: 1e-6, maxIterations: 200 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "src",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P0,
          temperature: 293,
        },
        {
          id: "J",
          type: "internal",
          x: 0,
          y: 0,
          pressure: P0,
          temperature: 293,
        },
        {
          id: "o1",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P0,
          temperature: 293,
        },
        {
          id: "o2",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: P0,
          temperature: 293,
        },
      ],
      branches: [
        {
          id: "pump",
          from: "src",
          to: "J",
          component: { type: "flowSource", massFlow: 0.1 * Q * RHO },
        },
        {
          id: "c1",
          from: "J",
          to: "o1",
          component: { type: "rectChannel", width: W, height: H, length: L },
        },
        {
          id: "c2",
          from: "J",
          to: "o2",
          component: {
            type: "rectChannel",
            width: W,
            height: H,
            length: 3 * L,
          },
        },
      ],
    };
    const r = solveSteady(cfg);
    expect(r.converged).toBe(true);
    const q1 = r.branches.c1.mdot / RHO;
    const q2 = r.branches.c2.mdot / RHO;
    // Guard, not a regression of the stall: the flow source's default warm
    // start (0.1 kg/s, ~1e8× the solution) leaves ~1e-8 relative round-off
    // after the Newton step lands, so the bar sits just above that.
    expect(Math.abs(q1 / q2 - 3)).toBeLessThan(1e-7);
    expect(Math.abs(q1 + q2 - 0.1 * Q) / (0.1 * Q)).toBeLessThan(1e-7);
  });
});
