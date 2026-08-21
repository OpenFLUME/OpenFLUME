/**
 * Two-phase chilldown — wall-vs-LOCAL-Tsat regression guard.
 *
 * An audit flagged final wall temperatures `[93.57, 91.66, 88.21, 88.21]` K in
 * the N=4 two-phase LN₂ chilldown as "colder than the saturated inlet fluid"
 * (Tsat at the 0.5169 MPa driving pressure is 94.42 K) and therefore
 * thermodynamically impossible.  That comparison basis is wrong: pressure
 * falls along the line, so the local saturation temperature falls too
 * (77.36 K at the 101325 Pa outlet).  Each wall convects to its ADJACENT fluid
 * node, whose temperature — in two-phase flow — equals Tsat(P_local).
 *
 * Verdict (recorded 2026-08, chilldown baseline audit): FALSE ALARM.  Every wall stays at or
 * above its local Tsat at every time step (minimum margin +0.08 K at s3,
 * t=300 s).  The correct physical asymptote for a wall node is its local fluid
 * temperature; for two-phase flow that is Tsat(P_local), approached from above.
 *
 * This test rebuilds the exact audit configuration inline (mirroring
 * buildChilldownTwoPhase in src/ui/examples.ts, which core tests must not
 * import) and asserts the correct basis so a genuine conjugate-coupling or
 * inlet-enthalpy bug would fail loudly.
 *
 * Measured final state (t = 300 s) for reference:
 *   node  x(m)   Twall    P_local   Tsat_local  Tfluid  quality
 *   s0/f0  0.00  107.79   516900    94.42       94.42   0.0000
 *   s1/f1 15.24   93.57   473639    93.31       93.31   0.0145
 *   s2/f2 30.48   91.66   409485    91.51       91.51   0.0366
 *   s3/f3 45.72   88.21   306076    88.13       88.13   0.0753
 *   s4/f4 60.96  300.00   101325    77.36      300.00   (vapor)
 */
import { describe, it, expect, beforeAll } from "vitest";
import { initRealFluids, realFluidsReady, RealFluid } from "../";
import { solveTransient } from "../transient";
import type { TransientResult } from "../schema";
import { buildAuditChilldownConfig } from "./helpers/chilldownAuditConfig";

describe("Two-phase chilldown: wall temperatures vs LOCAL Tsat (audit case)", () => {
  let res: TransientResult;
  let fluid: RealFluid;
  const N = 4;

  beforeAll(async () => {
    await initRealFluids();
    expect(realFluidsReady()).toBe(true);
    fluid = new RealFluid("Nitrogen");
    res = solveTransient(buildAuditChilldownConfig());
  }, 120000);

  it("converges and every wall stays at or above LOCAL Tsat at ALL time steps", () => {
    expect(res.converged).toBe(true);
    // Tolerance rationale: the measured minimum margin over the entire run is
    // +0.08 K (s3, t=300 s, still converging down to local Tsat).  A 0.25 K
    // allowance absorbs solver noise while failing loudly (K-scale) if a wall
    // ever drops meaningfully below local saturation — the impossible case.
    const TOL = 0.25;
    for (let i = 0; i <= N; i++) {
      for (let k = 0; k < res.times.length; k++) {
        const Twall = res.solidNodes![`s${i}`].temperature[k];
        const Plocal = res.nodes[`f${i}`].pressure[k];
        const TsatLocal = fluid.saturationTemperature(Plocal);
        expect(
          Twall,
          `s${i} at t=${res.times[k]}s: Twall=${Twall.toFixed(3)} < Tsat(P_local=${Plocal.toFixed(0)})=${TsatLocal.toFixed(3)}`,
        ).toBeGreaterThanOrEqual(TsatLocal - TOL);
      }
    }
  });

  it("interior fluid nodes end two-phase and pinned at LOCAL Tsat", () => {
    const last = res.times.length - 1;
    for (let i = 1; i < N; i++) {
      const q = res.nodes[`f${i}`].quality?.[last];
      const Plocal = res.nodes[`f${i}`].pressure[last];
      const Tfluid = res.nodes[`f${i}`].temperature[last];
      const TsatLocal = fluid.saturationTemperature(Plocal);
      expect(q, `f${i} quality`).toBeGreaterThan(0);
      expect(q!, `f${i} quality`).toBeLessThan(1);
      // HEM two-phase node temperature must equal local saturation temperature
      expect(
        Math.abs(Tfluid - TsatLocal),
        `f${i} Tfluid vs Tsat(P_local)`,
      ).toBeLessThan(0.1);
      // Sanity on the audited numbers: local pressure well below inlet pressure
      expect(Plocal).toBeLessThan(0.5169e6);
    }
    // The audit's specific value: s3 at 88.21 K sits beside 306 kPa fluid whose
    // Tsat is 88.13 K — above local Tsat, not below inlet Tsat.  Lock the ballpark.
    const TsatF3 = fluid.saturationTemperature(res.nodes["f3"].pressure[last]);
    const TwallS3 = res.solidNodes!["s3"].temperature[last];
    expect(TwallS3).toBeGreaterThan(TsatF3);
    expect(TwallS3 - TsatF3).toBeLessThan(1.0); // still converging; was +0.08 K
  });

  it("walls approach local fluid temperature from above (no wall colder than its fluid beyond noise)", () => {
    const last = res.times.length - 1;
    for (let i = 1; i < N; i++) {
      const Twall = res.solidNodes![`s${i}`].temperature[last];
      const Tfluid = res.nodes[`f${i}`].temperature[last];
      expect(Twall).toBeGreaterThanOrEqual(Tfluid - 0.05);
    }
  });
});
