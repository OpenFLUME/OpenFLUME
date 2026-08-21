import { describe, it, expect } from "vitest";
import { NetworkConfig } from "../schema";
import { solveTransient } from "../transient";
import { DynamicCheckValve } from "../components";

/**
 * Closed-form step response of an underdamped 2nd-order spring-mass-damper
 * driven by a constant net force F0 = dP*discArea - preload from rest
 * (x(0) = 0, v(0) = 0): x(t) = x_eq * (1 - e^{-zeta wn t}[cos(wd t) +
 * (zeta wn / wd) sin(wd t)]), x_eq = F0 / k.  Used as the reference solution
 * for DynamicCheckValve.advanceState's semi-implicit Euler integration.
 */
function stepResponse(
  t: number,
  xEq: number,
  wn: number,
  zeta: number,
): number {
  const wd = wn * Math.sqrt(1 - zeta * zeta);
  const decay = Math.exp(-zeta * wn * t);
  return (
    xEq *
    (1 - decay * (Math.cos(wd * t) + ((zeta * wn) / wd) * Math.sin(wd * t)))
  );
}

describe("DynamicCheckValve.advanceState — spring-mass-damper ODE", () => {
  it("matches the underdamped step-response closed form", () => {
    const mass = 0.05;
    const springRate = 5000;
    const preload = 50;
    const damping = 5;
    const discArea = 0.001;
    const stroke = 0.005;
    const dP = 62500; // (dP*discArea - preload)/k = 0.0025 m, well below stroke incl. overshoot

    const wn = Math.sqrt(springRate / mass);
    const zeta = damping / (2 * Math.sqrt(springRate * mass));
    const xEq = (dP * discArea - preload) / springRate;
    expect(zeta).toBeLessThan(1); // underdamped, as intended by the fixture

    const valve = new DynamicCheckValve(
      0.001,
      0.6,
      mass,
      springRate,
      preload,
      damping,
      stroke,
      discArea,
      0,
    );
    const dt = 1e-5;
    const pFrom = 200000;
    const pTo = pFrom - dP;
    const checkpoints = [0.005, 0.01, 0.015, 0.02, 0.03, 0.05];
    let t = 0;
    let ci = 0;
    const steps = Math.round(checkpoints[checkpoints.length - 1] / dt);
    for (let i = 1; i <= steps; i++) {
      valve.advanceState(dt, 0, pFrom, pTo);
      t = i * dt;
      if (ci < checkpoints.length && Math.abs(t - checkpoints[ci]) < dt / 2) {
        const expected = stepResponse(t, xEq, wn, zeta);
        expect(Math.abs(valve.x - expected)).toBeLessThan(0.03 * xEq + 2e-5);
        ci++;
      }
    }
    expect(ci).toBe(checkpoints.length);
    // Settled position (many periods later) equals the static equilibrium.
    for (let i = 0; i < 20000; i++) valve.advanceState(dt, 0, pFrom, pTo);
    expect(Math.abs(valve.x - xEq)).toBeLessThan(1e-6);
    expect(Math.abs(valve.v)).toBeLessThan(1e-4);
  });

  it("stays fully seated when ΔP never exceeds the cracking pressure", () => {
    const valve = new DynamicCheckValve(
      0.001,
      0.6,
      0.05,
      5000,
      50,
      5,
      0.005,
      0.001,
      0,
    );
    // cracking pressure = preload/discArea = 50000 Pa; hold just below it.
    const pFrom = 200000;
    const pTo = 200000 - 40000;
    for (let i = 0; i < 5000; i++) valve.advanceState(1e-4, 0, pFrom, pTo);
    expect(valve.x).toBe(0);
    expect(valve.v).toBe(0);
    expect(valve.position).toBe(0);
  });

  it("re-seats (closes) once the forward differential collapses", () => {
    const valve = new DynamicCheckValve(
      0.001,
      0.6,
      0.05,
      5000,
      50,
      5,
      0.005,
      0.001,
      0,
    );
    const dt = 1e-4;
    // Force it open first.
    for (let i = 0; i < 2000; i++)
      valve.advanceState(dt, 0, 200000, 200000 - 65000);
    expect(valve.x).toBeGreaterThan(0.001);
    // Then collapse the differential to zero — the spring must close it.
    for (let i = 0; i < 5000; i++) valve.advanceState(dt, 0, 150000, 150000);
    expect(valve.x).toBeLessThan(1e-6);
  });

  it("clamps at the stroke limit (does not overshoot past fully open)", () => {
    const valve = new DynamicCheckValve(
      0.001,
      0.6,
      0.05,
      5000,
      50,
      0.5,
      0.005,
      0.001,
      0,
    );
    const dt = 1e-4;
    // A huge ΔP drives the equilibrium far past the mechanical stop.
    for (let i = 0; i < 3000; i++) {
      valve.advanceState(dt, 0, 500000, 100000);
      expect(valve.x).toBeGreaterThanOrEqual(0);
      expect(valve.x).toBeLessThanOrEqual(0.005);
    }
    expect(valve.x).toBeCloseTo(0.005, 6);
  });
});

describe("DynamicCheckValve in a transient network solve", () => {
  function makeConfig(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
    return {
      meta: { name: "test", version: 2 },
      settings: {
        mode: "transient",
        dt: 0.0005,
        endTime: 0.05,
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

  it("opens under a sustained forward ΔP above cracking pressure and reports the expected forward mass flow trend", () => {
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
          pressure: 200000 - 65000,
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
    const res = solveTransient(config);
    expect(res.converged).toBe(true);
    // index 0 is the raw pre-solve initial guess (see resultRecorder.ts);
    // the first genuinely Newton-solved step is index 1.
    const mdots = res.branches.dcv.mdot.slice(1);
    // Starts nearly closed (floor area) and opens over time toward a
    // positive forward flow as the poppet ODE integrates outward.
    expect(Math.abs(mdots[0])).toBeLessThan(1e-3);
    expect(mdots[mdots.length - 1]).toBeGreaterThan(mdots[0]);
    expect(mdots[mdots.length - 1]).toBeGreaterThan(0);
  });

  it("blocks reverse flow (stays seated) under a reverse pressure differential", () => {
    const config = makeConfig({
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 150000,
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
    const res = solveTransient(config);
    expect(res.converged).toBe(true);
    // index 0 is the raw pre-solve initial guess (see resultRecorder.ts).
    for (const m of res.branches.dcv.mdot.slice(1)) {
      expect(Math.abs(m)).toBeLessThan(1e-4);
    }
  });
});
