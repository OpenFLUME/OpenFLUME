/**
 * Flow model of the NBS 9264 validation solves (NBS_LINE_FLOW_MODEL,
 * src/validation/nbsChilldown.ts) — short real-fluid solves:
 *
 *   - the inlet restriction is a K-factor resistance: across it the solved
 *     pressure drop is K ṁ|ṁ| / (2 ρ A²) with ρ between the two end states;
 *   - longitudinal inertia (momentum flux + kinetic energy, GFSSP's
 *     formulation, Cross et al. 2002 Eq. 17) is a real change to the
 *     solution, and the solve with it converges;
 *   - the subcooled-LN2 row at 61.74 psia, whose first fluid node stalled
 *     without the restriction (docs/validation/chilldown-report.md, "Inlet
 *     restriction"), converges over its first minute with it;
 *   - the subcooled-LN2 row at 74.97 psia converges through t = 85 s, where
 *     a node at the dome edge used to stall every tier of the retry cascade
 *     (on Node 22; the dome-exit restart in solveStateStep).
 *
 * Each solve is N = 3 over the first 60 s (seconds of wall time).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { buildChilldownTwoPhase } from "../examples";
import { initRealFluids, solveTransient, type NetworkConfig } from "../../core";
import {
  NBS_CHILLDOWN_DATA,
  NBS_CHILLDOWN_RIG,
  NBS_INLET_RESTRICTION_K,
  NBS_LINE_FLOW_MODEL,
  NBS_LINE_WALL_MODEL,
  NBS_TIME_STEP_S,
} from "../../validation/nbsChilldown";
import { initialWallTemperatureForPoint } from "../../validation/nbsInitialTemperature";

const A = (Math.PI / 4) * 0.015875 ** 2;

function rowConfig(
  id: string,
  flow: Partial<{ longitudinalInertia: boolean; inletRestrictionK: number }>,
  endTime = 60,
): NetworkConfig {
  const p = NBS_CHILLDOWN_DATA.find((x) => x.id === id)!;
  return buildChilldownTwoPhase({
    segments: 3,
    length: NBS_CHILLDOWN_RIG.lengthM,
    drivingPressure: p.drivingPressure.pa,
    outletPressure: 101325,
    fluidName: p.fluid === "LH2" ? "ParaHydrogen" : "Nitrogen",
    ...(p.inletCondition === "subcooled"
      ? { inletTemperature: p.subcooledAtTemperature!.K }
      : {}),
    ...NBS_LINE_WALL_MODEL,
    ...flow,
    initialTemperature: initialWallTemperatureForPoint(p).K,
    dt: NBS_TIME_STEP_S[p.fluid],
    endTime,
    timeStepping: "fixed",
  });
}

beforeAll(async () => {
  await initRealFluids();
}, 60_000);

describe("NBS line flow model: real-fluid solves", () => {
  it("the inlet restriction's pressure drop is K ṁ|ṁ|/(2ρA²)", () => {
    const cfg = rowConfig("subLN2-P61.74", NBS_LINE_FLOW_MODEL);
    const res = solveTransient(cfg);
    expect(res.converged).toBe(true);
    const m = res.branches.pipe0.mdot;
    const n = m.length;
    let checked = 0;
    for (let k = 1; k < n; k++) {
      if (!(m[k] > 1e-3)) continue;
      const dp = res.nodes.f0.pressure[k] - res.nodes.f1.pressure[k];
      expect(dp).toBeGreaterThan(0);
      // Implied density of the resistance law; must lie between the two end
      // states' densities (the component evaluates ρ at one of them).
      const rho = (NBS_INLET_RESTRICTION_K * m[k] * m[k]) / (2 * A * A * dp);
      const r0 = res.nodes.f0.density[k];
      const r1 = res.nodes.f1.density[k];
      expect(rho).toBeGreaterThan(Math.min(r0, r1) * 0.999);
      expect(rho).toBeLessThan(Math.max(r0, r1) * 1.001);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  }, 60_000);

  it("longitudinal inertia changes the solution and converges", () => {
    const on = solveTransient(rowConfig("satLN2-P86.73", NBS_LINE_FLOW_MODEL));
    const off = solveTransient(
      rowConfig("satLN2-P86.73", {
        ...NBS_LINE_FLOW_MODEL,
        longitudinalInertia: false,
      }),
    );
    expect(on.converged).toBe(true);
    expect(off.converged).toBe(true);
    const last = (r: typeof on) => r.branches.pipe0.mdot.at(-1)!;
    // The momentum-flux term is a real pressure drop in the accelerating
    // vapor flow: it lowers the inflow at the same driving pressure.
    expect(last(on)).toBeLessThan(last(off));
    expect(Math.abs(last(on) / last(off) - 1)).toBeGreaterThan(1e-3);
  }, 60_000);

  it("subcooled LN2 61.74 psia: no stalled step with the inlet restriction", () => {
    const res = solveTransient(rowConfig("subLN2-P61.74", NBS_LINE_FLOW_MODEL));
    expect(res.converged).toBe(true);
    const sr = res.stepResidualsScaled ?? [];
    expect(sr.filter((x) => x > 0.01)).toHaveLength(0);
  }, 60_000);

  it("subcooled LN2 74.97 psia: the dome-edge step at t = 85 s converges", () => {
    const res = solveTransient(
      rowConfig("subLN2-P74.97", NBS_LINE_FLOW_MODEL, 100),
    );
    expect(res.converged).toBe(true);
    const sr = res.stepResidualsScaled ?? [];
    expect(sr.filter((x) => x > 0.01)).toHaveLength(0);
  }, 60_000);
});
