import { describe, it, expect } from "vitest";
import {
  formatSig,
  resolveScale,
  formatWithUnit,
  formatInScale,
  clampDisplayDelta,
} from "../format";
import { SI_PRESET, US_PRESET, METRIC_PRESET } from "../units";

describe("formatSig", () => {
  it("handles zero and non-finite values", () => {
    expect(formatSig(0)).toBe("0");
    expect(formatSig(-0)).toBe("0");
    expect(formatSig(NaN)).toBe("NaN");
    expect(formatSig(Infinity)).toBe("Infinity");
    expect(formatSig(-Infinity)).toBe("-Infinity");
  });

  it("rounds to significant figures and strips trailing zeros", () => {
    expect(formatSig(1.23456789)).toBe("1.235");
    expect(formatSig(1.5)).toBe("1.5");
    expect(formatSig(0.0291494)).toBe("0.02915");
    expect(formatSig(2.000001)).toBe("2");
    expect(formatSig(0.1)).toBe("0.1");
  });

  it("respects custom sigFigs", () => {
    expect(formatSig(1.23456789, 2)).toBe("1.2");
    expect(formatSig(1.23456789, 6)).toBe("1.23457");
    expect(formatSig(123456, 3)).toBe("123,000");
  });

  it("adds thousands separators at |v| >= 1000", () => {
    expect(formatSig(1234)).toBe("1,234");
    expect(formatSig(1234000)).toBe("1,234,000");
    expect(formatSig(-1234)).toBe("-1,234");
    expect(formatSig(999999)).toBe("1,000,000"); // 4 sig figs rounds up
  });

  it("collapses toPrecision exponent edge cases inside the plain window", () => {
    expect(formatSig(9999.9)).toBe("10,000");
    expect(formatSig(-12345)).toBe("-12,350");
  });

  it("uses exponential notation only outside [1e-4, 1e7)", () => {
    expect(formatSig(1e7)).toBe("1e+7");
    expect(formatSig(123456789)).toBe("1.235e+8");
    expect(formatSig(1e9)).toBe("1e+9");
    expect(formatSig(-2.5e8)).toBe("-2.5e+8");
    expect(formatSig(1e-12)).toBe("1e-12");
    expect(formatSig(9.9999e-5)).toBe("1e-4"); // 4 sig figs rounds across the boundary
    expect(formatSig(0.0001)).toBe("0.0001");
    expect(formatSig(9999999)).toBe("10,000,000"); // input is inside the plain window; rounding may carry to 8 digits
  });

  it("keeps negatives in the plain window", () => {
    expect(formatSig(-0.0291494)).toBe("-0.02915");
    expect(formatSig(-1e-12)).toBe("-1e-12");
  });
});

describe("resolveScale", () => {
  it("auto-scales base-SI pressure to one prefixed unit for the whole set", () => {
    const s = resolveScale([101325, 200000], "pressure");
    expect(s.unitId).toBe("kPa");
    expect(s.unitLabel).toBe("kPa");
    expect(s.convert(200000)).toBeCloseTo(200, 9);
    expect(s.convert(101325)).toBeCloseTo(101.325, 9);
  });

  it("scales up to MPa and down to Pa", () => {
    expect(resolveScale([5e6], "pressure").unitId).toBe("MPa");
    expect(resolveScale([0.002, 0.5], "pressure").unitId).toBe("Pa");
  });

  it("scales mass flow kg/s ↔ g/s", () => {
    expect(resolveScale([0.0291494], "massFlow").unitId).toBe("g/s");
    expect(resolveScale([12], "massFlow").unitId).toBe("kg/s");
  });

  it("scales length into the SI-prefix family", () => {
    const s = resolveScale([0.02, 0.05], "length");
    expect(s.unitId).toBe("cm"); // 2–5 cm: largest prefix keeping max in [1, 1000)
    expect(s.convert(0.02)).toBeCloseTo(2, 9);
    expect(resolveScale([0.0002], "length").unitId).toBe("mm");
    expect(resolveScale([3, 5], "length").unitId).toBe("m");
  });

  it("never picks bar/atm/psi when auto-scaling pressure", () => {
    expect(resolveScale([2e5], "pressure").unitId).toBe("kPa");
    expect(resolveScale([3e6], "pressure").unitId).toBe("MPa");
  });

  it("never auto-scales offset units (temperature)", () => {
    expect(resolveScale([300, 400], "temperature").unitId).toBe("K");
    expect(resolveScale([300], "temperature", "C").unitId).toBe("C");
  });

  it("never auto-scales kinds without an SI-prefix family (time, angle)", () => {
    expect(resolveScale([0.5, 3600], "time").unitId).toBe("s");
    expect(resolveScale([Math.PI], "angle").unitId).toBe("deg");
    expect(resolveScale([1000], "dimensionless").unitId).toBe("-");
  });

  it("handles degenerate inputs", () => {
    expect(resolveScale([], "pressure").unitId).toBe("Pa");
    expect(resolveScale([0, 0, -0], "pressure").unitId).toBe("Pa");
    expect(resolveScale([NaN, Infinity, -Infinity], "pressure").unitId).toBe(
      "Pa",
    );
    expect(resolveScale([1e-12], "pressure").unitId).toBe("Pa"); // below smallest prefix
    expect(resolveScale([1e12], "pressure").unitId).toBe("MPa"); // above largest prefix → clamp
  });

  it("honors a non-base user preference verbatim", () => {
    const s = resolveScale([101325, 200000], "pressure", "psi");
    expect(s.unitId).toBe("psi");
    expect(s.convert(101325)).toBeCloseTo(14.6959, 3);
    const bar = resolveScale([101325], "pressure", "bar");
    expect(bar.convert(101325)).toBeCloseTo(1.01325, 5);
  });
});

describe("formatWithUnit / formatInScale", () => {
  it("auto-scales base-SI preferences", () => {
    expect(formatWithUnit(1500, "pressure", SI_PRESET)).toBe("1.5 kPa");
    expect(formatWithUnit(0.0291494, "massFlow", SI_PRESET)).toBe("29.15 g/s");
    expect(formatWithUnit(0, "pressure", SI_PRESET)).toBe("0 Pa");
  });

  it("respects explicit unit preferences", () => {
    expect(formatWithUnit(101325, "pressure", US_PRESET)).toBe("14.7 psi");
    expect(formatWithUnit(373.15, "temperature", METRIC_PRESET)).toBe("100 °C");
    expect(formatWithUnit(0.45359237, "massFlow", US_PRESET)).toBe("1 lbm/s");
  });

  it("omits the dimensionless placeholder symbol", () => {
    expect(formatWithUnit(0.6, "dimensionless", SI_PRESET)).toBe("0.6");
  });

  it("formatInScale reuses a resolved scale for many values", () => {
    const scale = resolveScale([101325, 200000], "pressure");
    expect(formatInScale(101325, scale)).toBe("101.3 kPa");
    expect(formatInScale(200000, scale)).toBe("200 kPa");
  });
});

describe("clampDisplayDelta", () => {
  it("clamps the exact release-blocker noise delta (300 vs 300+6e-14 K)", () => {
    expect(clampDisplayDelta(300.00000000000006 - 300, 300)).toBe(0);
    expect(clampDisplayDelta(-5.684341886080801e-14, 300)).toBe(0);
  });

  it("clamps ULP-level noise at any magnitude, both signs", () => {
    expect(clampDisplayDelta(2, 1e16)).toBe(0); // 1 ULP of 1e16
    expect(clampDisplayDelta(-1e-15, 0.5)).toBe(0);
    expect(clampDisplayDelta(1e-13, 0)).toBe(0); // against a zero reference
  });

  it("clamps deltas below half of the last displayed digit", () => {
    // 300.0 at 4 sig figs: last digit place 0.1, half = 0.05
    expect(clampDisplayDelta(0.01, 300, 4)).toBe(0);
    expect(clampDisplayDelta(-0.04, 300, 4)).toBe(0);
    expect(clampDisplayDelta(0.5, 300, 4)).toBe(0.5); // visible → kept
  });

  it("respects the sigFigs argument (more digits → finer resolution)", () => {
    expect(clampDisplayDelta(0.01, 300, 6)).toBe(0.01); // visible at 6 figs
    expect(clampDisplayDelta(0.0001, 300, 6)).toBe(0);
  });

  it("keeps real physical deltas untouched", () => {
    expect(clampDisplayDelta(-1.5, 100)).toBe(-1.5);
    expect(clampDisplayDelta(250, 101325)).toBe(250);
    expect(clampDisplayDelta(0.25, 0)).toBe(0.25);
  });

  it("returns canonical +0 (never -0) and passes non-finite through", () => {
    expect(Object.is(clampDisplayDelta(-1e-20, 1), -0)).toBe(false);
    expect(Object.is(clampDisplayDelta(1e-20, 1), 0)).toBe(true);
    expect(clampDisplayDelta(NaN, 100)).toBeNaN();
    expect(clampDisplayDelta(Infinity, 100)).toBe(Infinity);
    expect(clampDisplayDelta(-Infinity, 100)).toBe(-Infinity);
  });
});
