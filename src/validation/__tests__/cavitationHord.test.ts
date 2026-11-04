/**
 * Hord, Anderson & Hall (NASA CR-2054, 1972) liquid-hydrogen venturi
 * cavitation data against the cavitatingVenturi throat-pressure assumption
 * (scientific tier — see vitest.fast.config.ts).  Defined once in
 * src/validation/cavitationHord.ts and rendered by
 * scripts/choked-flow-validation-report.ts.  Bands are regression sentinels
 * around the measured values, not accuracy claims.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { initRealFluids } from "../../core";
import { evaluateHord, hordRuns, type HordResult } from "../cavitationHord";

let results: HordResult[] = [];
beforeAll(async () => {
  await initRealFluids();
  results = hordRuns().map(evaluateHord);
}, 60000);

describe("Hord 1972 LH2 venturi — cavitatingVenturi throat-pressure assumption", () => {
  it("transcribes all 32 developed-cavity runs and every closure solve converges", () => {
    expect(results).toHaveLength(32);
    expect(results.every((r) => r.converged)).toBe(true);
  });

  it("OpenFLUME's para-hydrogen vapor pressure matches the tabulated P_v(T0) within 1 %", () => {
    for (const r of results)
      expect(Math.abs(r.pv - r.run.pvTab) / r.run.pvTab).toBeLessThan(0.01);
  });

  it("the cavity leading edge sits at saturation at its own (cooled) temperature", () => {
    for (const r of results) {
      expect(r.portSaturationRatios[0]).toBeGreaterThan(0.85);
      expect(r.portSaturationRatios[0]).toBeLessThan(1.2);
    }
  });

  it("measured cavity pressure lies below P_v(T0): the closure under-predicts a choked flux by 10–41 %", () => {
    for (const r of results) {
      expect(r.pC).toBeLessThan(r.pv);
      const ratio = r.Gclosure / r.GatPc;
      expect(ratio).toBeGreaterThan(0.58);
      expect(ratio).toBeLessThan(0.91);
    }
  });
});
