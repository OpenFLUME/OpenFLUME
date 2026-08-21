/**
 * Williams, W.C. & McLean, J., "Using NASA's GFSSP Code for Steady State and
 * Transient Modeling of Gas Cooled Reactor Passive Safety Systems," NURETH-16,
 * Chicago, 2015, paper 13066.
 *
 * Geometry is representative (paper tables unavailable) so assertions target the
 * paper's PUBLISHED TRENDS.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { buildGfrLoop } from "../examples";
import { solveSteady, solveTransient } from "../../core";
import type { TransientResult } from "../../core";

function withTimeout<T>(fn: () => T, ms: number): Promise<T> {
  return Promise.race([
    new Promise<T>((resolve) => resolve(fn())),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Solve timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/** Pre-segregated temperatures used to avoid the zero-flow fixed point in
 *  steady solves at very low pressure (the solver otherwise collapses to the
 *  isothermal no-circulation state when the initial mdot guess is too small). */
function applySegregatedTemps(config: ReturnType<typeof buildGfrLoop>) {
  const segregated: Record<string, number> = {
    ANCHOR: 700,
    CORE: 373,
    RISER_BOT: 1100,
    RISER_TOP: 1100,
    HX: 1100,
    HX_OUT: 373,
    DC_BOT: 373,
  };
  for (const node of config.nodes) {
    if (segregated[node.id] !== undefined) {
      node.temperature = segregated[node.id];
    }
  }
}

import type { SteadyResult } from "../../core";

function computeCoreHeat(res: SteadyResult, cp: number) {
  return (
    res.branches["core"].mdot *
    cp *
    (res.nodes["RISER_BOT"].temperature - res.nodes["CORE"].temperature)
  );
}

function computeHxHeat(res: SteadyResult, cp: number) {
  return (
    res.branches["core"].mdot *
    cp *
    (res.nodes["HX_OUT"].temperature - res.nodes["HX"].temperature)
  );
}

describe("NURETH-16 #13066 GFR passive cooling loop", () => {
  let defaultTransient: TransientResult;

  beforeAll(async () => {
    defaultTransient = await withTimeout(
      () => solveTransient(buildGfrLoop({ mode: "transient" })),
      30000,
    );
  });

  it("1. Natural circulation establishes (transient)", () => {
    const res = defaultTransient;
    expect(res.converged).toBe(true);

    const mdots = res.branches.core.mdot;
    const first = mdots[0];
    const final = mdots[mdots.length - 1];

    // Initial guess is 1.0; it represents a near-stagnant start relative to the
    // converged ~6 kg/s steady value and grows monotonically after the first step.
    expect(Math.abs(first)).toBeLessThan(0.3 * Math.abs(final));
    expect(final).toBeGreaterThan(0);

    // Growth: the peak in the first half of the trace exceeds the initial guess
    const firstHalfPeak = Math.max(
      ...mdots.slice(0, Math.floor(mdots.length * 0.5)),
    );
    expect(firstHalfPeak).toBeGreaterThan(first);

    // Last 10% vary < 1%
    const last10Start = Math.floor(mdots.length * 0.9);
    const last10 = mdots.slice(last10Start);
    const mean = last10.reduce((a, b) => a + b, 0) / last10.length;
    for (const m of last10) {
      expect(Math.abs(m - mean) / Math.abs(mean)).toBeLessThan(0.01);
    }

    // Direction is up the riser (positive mdot from RISER_BOT → RISER_TOP)
    expect(
      res.branches.riser.mdot[res.branches.riser.mdot.length - 1],
    ).toBeGreaterThan(0);
  });

  it("2. Steady energy balance", async () => {
    const config = buildGfrLoop({ mode: "steady" });
    const res = await withTimeout(() => solveSteady(config), 10000);
    expect(res.converged).toBe(true);

    const cp = 819;
    const Qcore = computeCoreHeat(res, cp);
    const Qhx = computeHxHeat(res, cp);

    expect(Qcore).toBeGreaterThan(0);
    expect(Qhx).toBeLessThan(0);
    expect(
      Math.abs(Math.abs(Qcore) - Math.abs(Qhx)) / Math.abs(Qcore),
    ).toBeLessThan(0.02);
  });

  let nLam = 0;

  it("3. Laminar pressure scaling", async () => {
    // Low-pressure small-diameter variant to reach the laminar regime.
    // The steady solver at low pressure with default isothermal initials collapses
    // to the zero-flow fixed point; pre-segregated temperatures let it converge
    // to the non-zero laminar branch.
    const build = (pressure: number) => {
      const cfg = buildGfrLoop({ mode: "steady", pressure, diameter: 0.05 });
      applySegregatedTemps(cfg);
      return cfg;
    };

    const res1 = await withTimeout(() => solveSteady(build(1.05e4)), 10000);
    const res2 = await withTimeout(() => solveSteady(build(2.1e4)), 10000);

    expect(res1.converged).toBe(true);
    expect(res2.converged).toBe(true);

    const maxRe1 = Math.max(
      ...Object.values(res1.branches).map((b) => b.reynolds),
    );
    const maxRe2 = Math.max(
      ...Object.values(res2.branches).map((b) => b.reynolds),
    );
    expect(maxRe1).toBeLessThan(2300);
    expect(maxRe2).toBeLessThan(2300);

    const cp = 819;
    const Q1 = computeCoreHeat(res1, cp);
    const Q2 = computeCoreHeat(res2, cp);
    nLam = Math.log(Q2 / Q1) / Math.log(2);
    expect(nLam).toBeGreaterThan(1.6);
    expect(nLam).toBeLessThan(2.4);
  });

  let nTurb = 0;

  it("4. Turbulent pressure scaling", async () => {
    // Default D=0.3 gives Re > 1e6 but Q saturates because NTU becomes small;
    // D=0.05 keeps the loop turbulent while preserving observable linear scaling.
    const build = (pressure: number) =>
      buildGfrLoop({ mode: "steady", pressure, diameter: 0.05 });

    const res1 = await withTimeout(() => solveSteady(build(1.5e5)), 10000);
    const res2 = await withTimeout(() => solveSteady(build(3e5)), 10000);

    expect(res1.converged).toBe(true);
    expect(res2.converged).toBe(true);

    const maxRe1 = Math.max(
      ...Object.values(res1.branches).map((b) => b.reynolds),
    );
    const maxRe2 = Math.max(
      ...Object.values(res2.branches).map((b) => b.reynolds),
    );
    expect(maxRe1).toBeGreaterThan(4000);
    expect(maxRe2).toBeGreaterThan(4000);

    const cp = 819;
    const Q1 = computeCoreHeat(res1, cp);
    const Q2 = computeCoreHeat(res2, cp);
    nTurb = Math.log(Q2 / Q1) / Math.log(2);
    expect(nTurb).toBeGreaterThan(0.8);
    expect(nTurb).toBeLessThan(1.4);

    // Paper's key qualitative result: laminar exponent exceeds turbulent exponent
    expect(nLam).toBeGreaterThan(nTurb);
  });

  it("5. CO2 vs helium", async () => {
    const co2Res = await withTimeout(
      () => solveSteady(buildGfrLoop({ mode: "steady" })),
      10000,
    );
    const heRes = await withTimeout(
      () =>
        solveSteady(
          buildGfrLoop({
            mode: "steady",
            fluidParams: { R: 2077, gamma: 1.667, mu: 1.9e-5, cp: 5193 },
          }),
        ),
      10000,
    );

    expect(co2Res.converged).toBe(true);
    expect(heRes.converged).toBe(true);

    const Qco2 = computeCoreHeat(co2Res, 819);
    const Qhe = computeCoreHeat(heRes, 5193);
    expect(Qco2).toBeGreaterThan(Qhe);
  });

  it("6. Transient stability", () => {
    const res = defaultTransient;
    expect(res.converged).toBe(true);

    // No NaN in any array
    for (const node of Object.values(res.nodes)) {
      expect(node.pressure.some(Number.isNaN)).toBe(false);
      expect(node.temperature.some(Number.isNaN)).toBe(false);
      expect(node.density.some(Number.isNaN)).toBe(false);
    }
    for (const branch of Object.values(res.branches)) {
      expect(branch.mdot.some(Number.isNaN)).toBe(false);
    }

    // Last 20% of mdot trace within 1% band or monotone
    const mdots = res.branches.core.mdot;
    const last20Start = Math.floor(mdots.length * 0.8);
    const last20 = mdots.slice(last20Start);
    const mean = last20.reduce((a, b) => a + b, 0) / last20.length;
    const withinBand = last20.every(
      (m) => Math.abs(m - mean) / Math.abs(mean) < 0.01,
    );
    const monotoneDec = last20.slice(1).every((m, i) => m <= last20[i] + 1e-9);
    const monotoneInc = last20.slice(1).every((m, i) => m >= last20[i] - 1e-9);
    expect(withinBand || monotoneDec || monotoneInc).toBe(true);
  });
});
