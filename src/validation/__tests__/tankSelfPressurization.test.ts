/**
 * Hasan, Lin & Van Dresar (NASA TM-103804, 1991) self-pressurization of a
 * 4.89 m³ liquid-hydrogen tank against OpenFLUME's lumped real-fluid tank
 * (scientific tier — see vitest.fast.config.ts).  Defined once in
 * src/validation/tankSelfPressurization.ts and rendered by
 * scripts/tank-pressurization-validation-report.ts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { initRealFluids } from "../../core";
import {
  hasanCases,
  solveHasan,
  type HasanResult,
} from "../tankSelfPressurization";

let results: HasanResult[] = [];
beforeAll(async () => {
  await initRealFluids();
  results = hasanCases().map(solveHasan);
}, 60000);

describe("Hasan 1991 LH2 tank self-pressurization", () => {
  it("every solve converges and the closed valve carries no meaningful flow", () => {
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.converged).toBe(true);
      expect(r.valveLeak).toBeLessThan(1e-5);
    }
  });

  it("the lumped tank reproduces the homogeneous rise rate (analytic) within 0.5 %", () => {
    for (const r of results)
      expect(Math.abs(r.model - r.analytic) / r.analytic).toBeLessThan(0.005);
  });

  it("agrees with the paper's homogeneous model within 7 %", () => {
    for (const r of results)
      expect(
        Math.abs(r.model - r.case.paperHomogeneous) / r.case.paperHomogeneous,
      ).toBeLessThan(0.07);
  });

  it("under-predicts the measured (stratified) rise, increasingly with heat flux", () => {
    const ratios = results.map((r) => r.case.measuredSteadyBoiloff / r.model);
    expect(ratios[0]).toBeGreaterThan(1.0);
    expect(ratios[0]).toBeLessThan(1.15);
    expect(ratios[1]).toBeGreaterThan(2.2);
    expect(ratios[2]).toBeGreaterThan(2.8);
    expect(ratios[2]).toBeLessThan(3.3);
  });
});
