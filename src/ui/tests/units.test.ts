import { describe, it, expect } from "vitest";
import {
  convertToSI,
  convertFromSI,
  formatNumber,
  formatValue,
  SI_PRESET,
  METRIC_PRESET,
  US_PRESET,
  PRESETS,
  UNITS,
  QuantityKind,
} from "../units";

describe("units", () => {
  it("round-trips toSI∘fromSI ≈ identity for every unit of every quantity", () => {
    const kinds = Object.keys(UNITS) as QuantityKind[];
    for (const kind of kinds) {
      for (const unit of UNITS[kind]) {
        const testValues = [0, 1, -1, 1e3, 1e-3, 123.456, -987.654];
        for (const v of testValues) {
          const si = unit.toSI(v);
          const back = unit.fromSI(si);
          expect(Math.abs(back - v)).toBeLessThanOrEqual(
            Math.abs(v) * 1e-10 + 1e-12,
          );
        }
      }
    }
  });

  it("known-value spot checks", () => {
    // 1 bar = 14.503774 psi ±1e-4
    const barToPsi = convertFromSI(
      "pressure",
      convertToSI("pressure", 1, "bar"),
      "psi",
    );
    expect(Math.abs(barToPsi - 14.503774)).toBeLessThan(1e-4);

    // 100 kPa = 0.986923 atm
    const kPaToAtm = convertFromSI(
      "pressure",
      convertToSI("pressure", 100, "kPa"),
      "atm",
    );
    expect(Math.abs(kPaToAtm - 0.986923)).toBeLessThan(1e-6);

    // 0°C = 273.15 K
    expect(convertToSI("temperature", 0, "C")).toBe(273.15);
    expect(convertFromSI("temperature", 273.15, "C")).toBe(0);

    // 212°F = 373.15 K
    expect(convertToSI("temperature", 212, "F")).toBeCloseTo(373.15, 6);

    // 491.67°R (32°F) = 273.15 K
    expect(convertToSI("temperature", 491.67, "R")).toBeCloseTo(273.15, 4);
    expect(convertFromSI("temperature", 273.15, "R")).toBeCloseTo(491.67, 2);

    // 1 gpm = 6.30902e-5 m³/s
    expect(convertToSI("volumetricFlow", 1, "gpm(US)")).toBeCloseTo(
      6.30902e-5,
      8,
    );

    // 1 lbm/s = 0.45359237 kg/s
    expect(convertToSI("massFlow", 1, "lbm/s")).toBe(0.45359237);

    // 1 BTU/s = 1055.06 W ±0.01%
    const btuToW = convertToSI("power", 1, "BTU/s");
    expect(Math.abs(btuToW - 1055.06) / 1055.06).toBeLessThan(1e-4);

    // Thermal conductivity: 1 BTU/(hr·ft·°F) ≈ 1.730734666 W/(m·K)
    expect(convertToSI("thermalConductivity", 1, "BTU/(hr·ft·°F)")).toBeCloseTo(
      1.730734666,
      6,
    );
    expect(
      convertFromSI("thermalConductivity", 1.730734666, "BTU/(hr·ft·°F)"),
    ).toBeCloseTo(1, 6);

    // Heat transfer coefficient: 1 BTU/(hr·ft²·°F) ≈ 5.678263337 W/(m²·K)
    expect(convertToSI("heatTransferCoeff", 1, "BTU/(hr·ft²·°F)")).toBeCloseTo(
      5.678263337,
      6,
    );
    expect(
      convertFromSI("heatTransferCoeff", 5.678263337, "BTU/(hr·ft²·°F)"),
    ).toBeCloseTo(1, 6);

    // Specific heat: 1 BTU/(lbm·°F) = 4186.8 J/(kg·K) exactly (IT BTU),
    // and 1 kJ/(kg·K) = 1000 J/(kg·K).
    expect(convertToSI("specificHeat", 1, "BTU/(lbm·°F)")).toBeCloseTo(
      4186.8,
      6,
    );
    expect(convertFromSI("specificHeat", 4186.8, "BTU/(lbm·°F)")).toBeCloseTo(
      1,
      9,
    );
    expect(convertToSI("specificHeat", 1, "kJ/(kg·K)")).toBe(1000);
    expect(convertFromSI("specificHeat", 385, "J/(kg·K)")).toBe(385);
  });

  it("preset completeness: every QuantityKind mapped in all three presets", () => {
    const kinds = Object.keys(UNITS) as QuantityKind[];
    for (const preset of [SI_PRESET, METRIC_PRESET, US_PRESET]) {
      for (const kind of kinds) {
        expect(preset[kind]).toBeDefined();
        const valid = UNITS[kind].some((u) => u.id === preset[kind]);
        expect(valid).toBe(true);
      }
    }
  });

  it("preset names match PRESETS record", () => {
    expect(PRESETS["SI"]).toEqual(SI_PRESET);
    expect(PRESETS["Metric engineering"]).toEqual(METRIC_PRESET);
    expect(PRESETS["US customary"]).toEqual(US_PRESET);
  });

  it("formatNumber trims trailing zeros and gives ~6 sig figs", () => {
    expect(formatNumber(1.23)).toBe("1.23");
    expect(formatNumber(1.2345678)).toBe("1.23457");
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(1234567)).toBe("1234570");
    expect(formatNumber(0.00000123)).toBe("0.00000123");
  });

  it("formatValue auto-scales base SI units", () => {
    expect(formatValue(1500, "pressure", "Pa")).toBe("1.5 kPa");
    expect(formatValue(0.002, "massFlow", "kg/s")).toBe("2.00 g/s");
    expect(formatValue(293.15, "temperature", "K")).toBe("293.1 K");
  });

  it("formatValue does not auto-scale non-base units", () => {
    expect(formatValue(101325, "pressure", "bar")).toBe("1.01325 bar");
    expect(formatValue(101325, "pressure", "psi")).toMatch(/14\.6959/);
    expect(formatValue(0.226796, "massFlow", "lbm/s")).toMatch(/0\.5/);
    expect(formatValue(373.15, "temperature", "C")).toBe("100 °C");
  });
});
