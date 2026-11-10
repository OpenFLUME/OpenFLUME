/**
 * CI gates for the Anzelius–Schumann verification of transient conjugate
 * wall–fluid heat transfer (case 6 of docs/validation/thermal-network-report.md).
 *
 * The network (src/validation/schumannConjugate.ts) is the 26 in × 3/16 in ID
 * × 1/2 in OD aluminium tube of Cross et al. (2002) with constant film
 * coefficient, incompressible constant-property fluid, constant mass flow and
 * no axial wall conduction.  The closed form (src/validation/schumann.ts) is
 * θ_w = J(τ, ζ).  The error metric is the largest wall-temperature deviation
 * over the stations z = 4.55, 31.9, 59.23 cm and t ≤ 150 s, divided by
 * T_w0 − T_f0.
 *
 * Measured values (N = 20, Δt = 0.25 s) and gates (1.5 × measured):
 *
 *            measured     gate
 *   b = 0.94  7.11e-3    1.07e-2
 *   b = 4     2.12e-2    3.20e-2
 *
 * The scheme is first order (implicit upwind in space, backward Euler in
 * time), so the gate on the refinement study is the observed order.  Refining
 * N = 10/20/40 together with Δt = 1/0.5/0.25 s gave errors
 * 1.72e-2, 8.74e-3, 4.41e-3 (b = 0.94, orders 0.98, 0.99) and
 * 4.35e-2, 2.26e-2, 1.16e-2 (b = 4, orders 0.94, 0.96).
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  buildSchumannNetwork,
  observedOrders,
  runSchumannCase,
  SCHUMANN_A,
  SCHUMANN_GEOMETRY,
  SCHUMANN_PROPERTIES,
  schumannParameters,
  type SchumannRun,
} from "../schumannConjugate";
import { solveTransient, validateNetwork } from "../../core";

describe("Anzelius–Schumann conjugate verification: fast configuration (N = 20, dt = 0.25 s)", () => {
  const runs: Record<string, SchumannRun> = {};
  beforeAll(() => {
    runs["0.94"] = runSchumannCase({ N: 20, dt: 0.25, b: 0.94 });
    runs["4"] = runSchumannCase({ N: 20, dt: 0.25, b: 4 });
  });

  it("b = 0.94 stays within the gate (measured 7.11e-3, gate 1.07e-2)", () => {
    expect(runs["0.94"].maxError).toBeLessThan(1.07e-2);
    // The error is real discretisation error, not a degenerate comparison.
    expect(runs["0.94"].maxError).toBeGreaterThan(1e-3);
  });

  it("b = 4 stays within the gate (measured 2.12e-2, gate 3.20e-2)", () => {
    expect(runs["4"].maxError).toBeLessThan(3.2e-2);
    expect(runs["4"].maxError).toBeGreaterThan(1e-3);
  });

  it("every station is within the gate, not just the worst one", () => {
    for (const [key, gate] of [
      ["0.94", 1.07e-2],
      ["4", 3.2e-2],
    ] as const) {
      expect(runs[key].stations).toHaveLength(3);
      for (const s of runs[key].stations) expect(s.maxError).toBeLessThan(gate);
    }
  });

  it("converges with no stalled steps", () => {
    for (const r of Object.values(runs)) {
      expect(r.converged).toBe(true);
      expect(r.stalledSteps).toBe(0);
      expect(r.times.length).toBe(601);
    }
  });

  it("closes the global energy balance (wall + fluid storage = enthalpy carried out)", () => {
    // Measured 1e-12 (backward Euler with implicit conductors is conservative).
    for (const r of Object.values(runs))
      expect(r.energyClosure).toBeLessThan(1e-8);
  });

  it("matches the closed form exactly at t = 0 and cools monotonically", () => {
    for (const r of Object.values(runs)) {
      for (const s of r.stations) {
        expect(s.numeric[0]).toBe(SCHUMANN_PROPERTIES.Tw0);
        expect(s.analytic[0]).toBe(SCHUMANN_PROPERTIES.Tw0);
        for (let k = 1; k < s.numeric.length; k++) {
          expect(s.numeric[k]).toBeLessThanOrEqual(s.numeric[k - 1] + 1e-9);
        }
      }
    }
  });

  it("the stations are cooled in order of distance from the inlet", () => {
    const run = runs["0.94"];
    const k = run.times.indexOf(30);
    const temps = run.stations.map((s) => s.numeric[k]);
    expect(temps[0]).toBeLessThan(temps[1]);
    expect(temps[1]).toBeLessThan(temps[2]);
  });
});

describe("Anzelius–Schumann conjugate verification: setup", () => {
  it("builds a valid network whose derived groups reproduce a and b", () => {
    for (const b of [0.94, 4]) {
      const spec = { N: 10, dt: 1, b };
      const cfg = buildSchumannNetwork(spec);
      expect(validateNetwork(cfg)).toEqual([]);
      const p = schumannParameters(spec);
      const { ID, OD, L } = SCHUMANN_GEOMETRY;
      const { rhoW, cW, cF } = SCHUMANN_PROPERTIES;
      const Aw = (Math.PI / 4) * (OD * OD - ID * ID);
      // Re-derive a and b from what the builder actually wrote into the network.
      const conv0 = cfg.conductors!.find((c) => c.id === "conv5")!;
      expect(conv0.type.kind).toBe("convection");
      const h = (conv0.type as { h: number }).h;
      const source = cfg.branches.find((br) => br.id === "pipe0")!;
      const mdot = (source.component as { massFlow: number }).massFlow;
      const hP = h * Math.PI * ID;
      expect(hP / (rhoW * cW * Aw)).toBeCloseTo(SCHUMANN_A, 12);
      expect(hP / (mdot * cF)).toBeCloseTo(b, 12);
      // Total wall mass and fluid volume are those of the tube.
      const wallMass = cfg.solidNodes!.reduce((s, n) => s + n.mass!, 0);
      expect(wallMass).toBeCloseTo(rhoW * Aw * L, 10);
      expect(p.mdot).toBeCloseTo(mdot, 15);
      // The fluid transit time is short against the wall time constant (plug-flow limit, 0.16 s and 0.68 s against 26 s).
      expect(L / p.u).toBeLessThan(0.05 / SCHUMANN_A);
    }
  });
});

describe("Anzelius–Schumann conjugate verification: first-order convergence", () => {
  const study = (b: number) =>
    [
      { N: 10, dt: 1 },
      { N: 20, dt: 0.5 },
      { N: 40, dt: 0.25 },
    ].map(({ N, dt }) => {
      const r = runSchumannCase({ N, dt, b });
      expect(r.converged).toBe(true);
      expect(r.stalledSteps).toBe(0);
      return { h: 1 / N, error: r.maxError };
    });

  it.each([0.94, 4])(
    "b = %s: observed order is 1 (0.8 to 1.2) with N and dt refined together",
    (b) => {
      const series = study(b);
      for (let i = 1; i < series.length; i++) {
        expect(series[i].error).toBeLessThan(series[i - 1].error);
      }
      const orders = observedOrders(series);
      expect(orders).toHaveLength(2);
      for (const p of orders) {
        expect(p).toBeGreaterThan(0.8);
        expect(p).toBeLessThan(1.2);
      }
    },
  );
});

// Issue #54: at N ≥ 60 and tolerance 1e-10 the raw inner-Newton residual
// sits on a floating-point floor of ~1.1e-10, just above tol, while the
// certifying scaled residual is ~1e-14.  The inner loop used to run to
// maxIterations on every outer iteration (500 Jacobians per step, 52 s for
// these 20 steps at N = 60) before the step certified anyway.  The round-off
// floor exit (INNER_FLOOR_STALL_ITERS in core/solver/step.ts) stops it after
// two non-improving iterations; the trajectory is bit-identical, because the
// iterate does not move while the loop grinds.
describe("Anzelius–Schumann at N ≥ 60, tol 1e-10: inner Newton stops on its round-off floor (#54)", () => {
  it.each([60, 80])(
    "N = %s: 20 steps converge in a bounded number of Newton iterations",
    (N) => {
      const cfg = buildSchumannNetwork({ N, dt: 0.25, b: 0.94, tEnd: 5 });
      expect(cfg.settings.tolerance).toBe(1e-10);
      expect(cfg.settings.maxIterations).toBe(100);
      const res = solveTransient(cfg);
      expect(res.converged).toBe(true);
      const iters = res.stepNewtonIterations!;
      expect(iters).toHaveLength(20);
      // Measured 43 over the 20 steps (5 on the first, 2 on each later one);
      // 10 000 before the fix.
      expect(iters.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(100);
      expect(Math.max(...iters)).toBeLessThan(cfg.settings.maxIterations!);
    },
  );
});
