import { describe, it, expect } from "vitest";
import {
  niceTicks,
  clampDomain,
  formatValue,
  assignSeriesColors,
  dedupeTicks,
  SERIES_PALETTE,
  MAX_TICKS,
} from "../components/chartMath";

describe("chartMath", () => {
  it("niceTicks produces reasonable steps", () => {
    const ticks = niceTicks(0, 10, 5);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks[0]).toBeLessThanOrEqual(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(10);
  });

  it("niceTicks handles zero range", () => {
    expect(niceTicks(5, 5, 5)).toEqual([5]);
  });

  // Release-blocker reproduction: Pump-startup rerun produced temperature
  // series 300 vs 300.00000000000006 — the span (≈5.7e-14, one ULP of 300)
  // made niceTicks pick a step below the ULP, `v += step` never advanced,
  // and the loop built an unbounded array (RangeError → white screen).
  it("niceTicks survives the exact sub-ULP crash range [300, 300+6e-14]", () => {
    const ticks = niceTicks(300, 300.00000000000006, 5);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.length).toBeLessThanOrEqual(MAX_TICKS);
    expect(ticks[0]).toBeLessThanOrEqual(300);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(300.00000000000006);
    for (const t of ticks) expect(Number.isFinite(t)).toBe(true);
  });

  it("niceTicks pads one-ULP spans at huge magnitudes", () => {
    const ticks = niceTicks(1e16, 1e16 + 2, 5); // span = 1 ULP(1e16)
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.length).toBeLessThanOrEqual(MAX_TICKS);
  });

  it("niceTicks never emits more than MAX_TICKS on adversarial ranges", () => {
    const cases: Array<[number, number]> = [
      [0, 1e-300], // denormal-scale range near zero
      [5e-324, 1e-323], // subnormal endpoints
      [-1e308, 1e308], // range overflows to Infinity
      [1e-12, 1e-12 + 1e-300], // span far below ULP of the lower bound
      [123456.789, 123456.78900000001], // sub-ULP at everyday magnitude
    ];
    for (const [a, b] of cases) {
      const ticks = niceTicks(a, b, 5);
      expect(ticks.length).toBeLessThanOrEqual(MAX_TICKS);
      expect(ticks.length).toBeGreaterThan(0);
      for (const t of ticks) expect(Number.isFinite(t)).toBe(true);
    }
  });

  it("niceTicks still honors tiny ranges near zero", () => {
    // 1e-12 span at magnitude ≤1 is NOT representation noise — real ticks.
    const ticks = niceTicks(0, 1e-12, 5);
    expect(ticks.length).toBeGreaterThan(1);
    expect(Math.max(...ticks)).toBeLessThan(0.01); // not padded into ±0.01
    expect(Math.min(...ticks)).toBeGreaterThanOrEqual(-1e-12);
  });

  it("niceTicks handles non-finite and reversed inputs without throwing", () => {
    expect(niceTicks(0, Infinity, 5).length).toBeGreaterThan(0);
    expect(niceTicks(-Infinity, 0, 5).length).toBeGreaterThan(0);
    expect(niceTicks(NaN, NaN, 5)).toEqual([0]);
    const reversed = niceTicks(10, 0, 5);
    expect(reversed[0]).toBeLessThanOrEqual(0);
    expect(reversed[reversed.length - 1]).toBeGreaterThanOrEqual(10);
  });

  it("clampDomain enforces bounds", () => {
    expect(clampDomain([-1, 5], 0, 10)).toEqual([0, 6]);
    expect(clampDomain([5, 12], 0, 10)).toEqual([3, 10]);
    expect(clampDomain([2, 8], 0, 10)).toEqual([2, 8]);
  });

  it("formatValue auto-scales Pa base unit", () => {
    expect(formatValue(500, "pressure", "Pa")).toBe("500 Pa");
    expect(formatValue(1500, "pressure", "Pa")).toBe("1.5 kPa");
    expect(formatValue(2.5e6, "pressure", "Pa")).toBe("2.50 MPa");
  });

  it("formatValue formats non-base pressure unit exactly", () => {
    expect(formatValue(101325, "pressure", "psi")).toMatch(/14\.6959/);
    expect(formatValue(101325, "pressure", "bar")).toBe("1.01325 bar");
  });

  it("formatValue auto-scales kg/s base unit", () => {
    expect(formatValue(2, "massFlow", "kg/s")).toBe("2.000 kg/s");
    expect(formatValue(0.002, "massFlow", "kg/s")).toBe("2.00 g/s");
    expect(formatValue(2e-6, "massFlow", "kg/s")).toBe("2.0 mg/s");
  });

  it("formatValue handles K base unit", () => {
    expect(formatValue(293.15, "temperature", "K")).toBe("293.1 K");
  });

  it("formatValue handles °C non-base unit", () => {
    expect(formatValue(273.15, "temperature", "C")).toBe("0 °C");
    expect(formatValue(373.15, "temperature", "C")).toBe("100 °C");
  });
});

describe("assignSeriesColors", () => {
  it("keeps stable hash colors when there is no collision", () => {
    const colors = assignSeriesColors([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(colors.get("a")).toBeTruthy();
    expect(new Set(colors.values()).size).toBe(3);
  });

  it("resolves forced collisions within a chart, deterministically", () => {
    const dup = SERIES_PALETTE[0];
    const a1 = assignSeriesColors([
      { id: "x", color: dup },
      { id: "y", color: dup },
      { id: "z", color: dup },
    ]);
    expect(a1.get("x")).toBe(dup);
    expect(a1.get("y")).not.toBe(dup);
    expect(a1.get("z")).not.toBe(dup);
    expect(new Set(a1.values()).size).toBe(3);
    // Deterministic: same input, same assignment
    const a2 = assignSeriesColors([
      { id: "x", color: dup },
      { id: "y", color: dup },
      { id: "z", color: dup },
    ]);
    expect([...a1.entries()]).toEqual([...a2.entries()]);
  });

  it("matchColorOf locks a follower (baseline) to its primary color", () => {
    const colors = assignSeriesColors([
      { id: "p:tank", color: SERIES_PALETTE[1] },
      {
        id: "baseline:p:tank",
        color: SERIES_PALETTE[2],
        matchColorOf: "p:tank",
      },
    ]);
    expect(colors.get("baseline:p:tank")).toBe(SERIES_PALETTE[1]);
  });
});

describe("dedupeTicks", () => {
  it("escalates precision on near-degenerate domains (no repeated labels)", () => {
    const ticks = [292.9, 292.95, 293, 293.05, 293.1];
    const out = dedupeTicks(ticks);
    const labels = out.map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain("292.95");
  });

  it("drops truly identical values rather than repeating a label", () => {
    const out = dedupeTicks([5, 5, 5]);
    expect(out).toHaveLength(1);
  });

  it("leaves well-spread ticks at default precision", () => {
    const out = dedupeTicks([0, 25, 50, 75, 100]);
    expect(out.map((t) => t.label)).toEqual(["0", "25", "50", "75", "100"]);
  });
});
