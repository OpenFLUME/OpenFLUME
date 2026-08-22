/**
 * Near-critical two-phase regime: as P → Pc⁻ the saturation dome
 * degenerates (h_g − h_f → 0) and the HEM mixture quality/derivative
 * divisions would diverge without the dhfg clamp in realFluid.ts
 * (twoPhaseDerivs / statePH's dome branch).  These tests drive statePH and
 * derivativesPH at mid-dome enthalpies for pressures approaching Pc from
 * below and assert every published number stays finite — huge derivative
 * magnitudes are acceptable (the Newton globalization handles them), NaN/∞
 * in the Jacobian is not.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { initRealFluids, realFluidsReady, RealFluid } from "../";
import { getSatProps } from "../fluids/realFluid";
import type { SupportedRealFluid } from "../fluids/realFluid";

const FLUIDS: SupportedRealFluid[] = ["Nitrogen", "Water", "Hydrogen"];
// Fractions of Pc to probe from below.  The closest points are where the
// dome gap is smallest that CoolProp's saturation routines still resolve.
const P_FRACTIONS = [0.9, 0.99, 0.999, 0.9999];

beforeAll(async () => {
  await initRealFluids();
  expect(realFluidsReady()).toBe(true);
}, 60000);

describe("near-critical two-phase states and derivatives stay finite", () => {
  for (const name of FLUIDS) {
    it(`${name}: P → Pc⁻ mid-dome`, () => {
      const fluid = new RealFluid(name);
      const Pc = fluid.criticalPressure();
      let probed = 0;
      for (const frac of P_FRACTIONS) {
        const P = frac * Pc;
        let hf: number, hg: number;
        try {
          ({ hf, hg } = getSatProps(name, P));
        } catch {
          // CoolProp's saturation routines can refuse extremely close to Pc;
          // the clamp only matters for pressures they do resolve.
          continue;
        }
        probed++;
        for (const x of [0.01, 0.5, 0.99]) {
          const h = hf + x * (hg - hf);
          const st = fluid.statePH(P, h);
          expect(Number.isFinite(st.T), `${name} T at ${frac}·Pc`).toBe(true);
          expect(Number.isFinite(st.rho), `${name} rho at ${frac}·Pc`).toBe(
            true,
          );
          expect(st.rho).toBeGreaterThan(0);
          if (st.quality !== undefined) {
            expect(Number.isFinite(st.quality)).toBe(true);
          }
          const d = fluid.derivativesPH(P, h);
          expect(
            Number.isFinite(d.drhodP_h),
            `${name} drhodP_h at ${frac}·Pc, x=${x}`,
          ).toBe(true);
          expect(
            Number.isFinite(d.drhodh_P),
            `${name} drhodh_P at ${frac}·Pc, x=${x}`,
          ).toBe(true);
          expect(Number.isFinite(d.dTdP_h)).toBe(true);
          expect(Number.isFinite(d.dTdh_P)).toBe(true);
        }
      }
      // The suite is vacuous if CoolProp refused every near-critical
      // pressure — at least the 0.9·Pc and 0.99·Pc points must resolve.
      expect(probed).toBeGreaterThanOrEqual(2);
    });
  }
});
