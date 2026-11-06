/**
 * clampToValidPH — the compressed-liquid enthalpy floor.
 *
 * The global hmin is the saturated liquid at Tmin (the triple point), which
 * lies BELOW the lowest liquid enthalpy at every higher pressure (the
 * compressed liquid at the melting temperature holds more).  An iterate
 * clamped there made CoolProp's P-h flash throw, and a few hundred such
 * failures aborted the WASM module (refined subcooled chilldown solves).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { initRealFluids, RealFluid } from "..";
import { clampToValidPH, getFluidLimits } from "../fluids/realFluid";

beforeAll(async () => {
  await initRealFluids();
});

describe("clampToValidPH compressed-liquid floor", () => {
  for (const name of ["Nitrogen", "ParaHydrogen", "Water"] as const) {
    it(`${name}: the floor never decreases with pressure and sits at or above hmin`, () => {
      const L = getFluidLimits(name);
      const Ps = [1.1, 1.5, 2, 3, 5, 8, 20, 50].map((b) => b * 1e5);
      let prev = -Infinity;
      for (const P of Ps) {
        const [cP, h] = clampToValidPH(name, P, L.hmin - 1e6);
        expect(cP).toBe(P);
        expect(h).toBeGreaterThanOrEqual(L.hmin);
        expect(h).toBeGreaterThanOrEqual(prev - 1e-6);
        prev = h;
      }
      expect(prev).toBeGreaterThan(L.hmin);
    });
  }

  it("leaves in-range states untouched (liquid, dome, vapor)", () => {
    const f = new RealFluid("Nitrogen");
    for (const [P, T] of [
      [1e5, 77.5],
      [4e5, 80],
      [4e5, 150],
      [10e5, 300],
    ] as const) {
      const h = f.enthalpyPT(P, T);
      expect(clampToValidPH("Nitrogen", P, h)).toEqual([P, h]);
    }
    const sat = f.saturationProperties(5e5);
    const hMid = 0.5 * (sat.hf + sat.hg);
    expect(clampToValidPH("Nitrogen", 5e5, hMid)).toEqual([5e5, hMid]);
  });

  for (const [name, bar0, dbar] of [
    ["Nitrogen", 1, 0.02],
    ["ParaHydrogen", 1.1, 0.01],
  ] as const) {
    it(`${name}: a clamped overshoot flashes without throwing, across pressures`, () => {
      const f = new RealFluid(name);
      const L = getFluidLimits(name);
      let failures = 0;
      for (let i = 0; i < 400; i++) {
        const P = (bar0 + dbar * i) * 1e5 * 1.0003; // distinct cache keys
        const [cP, cH] = clampToValidPH(name, P, L.hmin - 1e4 * (i % 7));
        try {
          const s = f.statePH(cP, cH);
          expect(Number.isFinite(s.T)).toBe(true);
          expect(s.phase).toBe("liquid");
        } catch {
          failures++;
        }
      }
      expect(failures).toBe(0);
    });
  }
});
