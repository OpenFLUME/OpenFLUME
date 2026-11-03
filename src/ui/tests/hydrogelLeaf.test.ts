/**
 * Hydrogel leaf example (src/ui/hydrogelLeaf.ts) against Koo & Velev 2017.
 *
 * The paper's Table I gives the COMSOL inflow F_in (per unit out-of-plane
 * depth, at c_in = 5 mol/m³) for linear channels of several lengths.  The
 * lumped network has two parts with different status: the lateral gel slabs
 * are a plain 1-D Darcy law (a lower estimate — they ignore all 2-D
 * spreading), while the tip branches are an approximate 2-D shape factor.
 * The tests pin that the slabs alone fall below COMSOL, that slabs + tips
 * land 3–11 % above it (bar: 12 %), and that the network solve matches the
 * conductances it is built from.
 */
import { describe, it, expect } from "vitest";
import { solveSteady, validateNetwork } from "../../core";
import {
  HYDROGEL_LEAF,
  buildHydrogelLeaf,
  gelSlabResistance,
  tipResistance,
} from "../hydrogelLeaf";

const c = HYDROGEL_LEAF;
const RHO = 998;

/** Solved inflow per unit depth [m²/s]. */
function inflowPerDepth(length: number, tips: boolean): number {
  const cfg = buildHydrogelLeaf(length, { tips });
  expect(validateNetwork(cfg)).toEqual([]);
  const r = solveSteady(cfg);
  expect(r.converged).toBe(true);
  return r.branches.feed.mdot / RHO / c.thickness;
}

/** Hand calculation: 4 source–drain interfaces + 5 tips, all at the full
 *  7 kPa (channel resistance neglected). */
function handCalc(length: number, tips: boolean): number {
  const lateral =
    4 / gelSlabResistance(c.gap, (2 * length - c.span) * c.thickness);
  const tipG = tips ? 5 / tipResistance(c.span - length) : 0;
  return (c.inletPressure * (lateral + tipG)) / c.thickness;
}

const cases = c.comsol.filter((p) => 2 * p.length > c.span);

describe("Hydrogel leaf vs Koo & Velev 2017 Table I", () => {
  it("network solve equals the parallel gel conductances it is built from", () => {
    for (const p of cases)
      for (const tips of [false, true])
        expect(
          Math.abs(inflowPerDepth(p.length, tips) - handCalc(p.length, tips)) /
            handCalc(p.length, tips),
        ).toBeLessThan(1e-3);
  });

  for (const p of cases) {
    it(`L = ${p.length * 100} cm: lateral slabs below COMSOL, slabs + tips within 12 % above`, () => {
      const comsol = p.fin / c.inletConcentration;
      const lateral = inflowPerDepth(p.length, false);
      const full = inflowPerDepth(p.length, true);
      expect(lateral).toBeLessThan(comsol);
      expect(full).toBeGreaterThan(comsol);
      expect(full / comsol).toBeLessThan(1.12);
    });
  }

  it("captures most of the inflow jump as the tips approach the header (2.75 → 2.95 cm)", () => {
    const ratio = (tips: boolean) =>
      inflowPerDepth(0.0295, tips) / inflowPerDepth(0.0275, tips);
    const comsolRatio = 10.4 / 7.5; // 1.39
    expect(ratio(false)).toBeLessThan(1.2);
    expect(Math.abs(ratio(true) - comsolRatio)).toBeLessThan(0.1);
  });

  it("is insensitive to the overlap discretisation (channels carry < 0.1 % of the drop)", () => {
    const coarse = buildHydrogelLeaf(0.0275, { segments: 1 });
    const fine = buildHydrogelLeaf(0.0275, { segments: 10 });
    const q = (cfg: ReturnType<typeof buildHydrogelLeaf>) =>
      solveSteady(cfg).branches.feed.mdot;
    expect(Math.abs(q(coarse) - q(fine)) / q(fine)).toBeLessThan(1e-3);
  });
});
