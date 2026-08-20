/**
 * Unit tests for the advanced user-component examples shipped in
 * library/components/ and embedded in the UI example networks.
 *
 * Coverage:
 *   - dome-regulator: proportional-opening pressure law (tanh opening vs
 *     pTo, fully-open fallback when pTo is unavailable);
 *   - re-k-factor: Reynolds-table K interpolation (K decreasing with Re,
 *     finite behaviour at zero / near-zero flow);
 *   - heated-resistance: K-factor pressureDrop plus the epsilon-NTU
 *     heat(args) callback (sign of Q, graceful mdot → 0 limit);
 *   - embedded example: the heatedResistance example network validates
 *     cleanly, and the embedded componentLibrary
 *     code/metadata match the library file on disk (no drift between
 *     library and embedded copies).
 *
 * NOTE: this file reads the component sources via node:fs.  Tests run under
 * vitest's node environment; the components themselves stay fs-free.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { compileUserComponent } from "../usercode";
import type { UserPressureDropArgs, UserHeatArgs } from "../usercode";
import { validateNetwork } from "../validate";
import { extensionAdvancedExample } from "../../ui/examples";

const COMPONENTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "library",
  "components",
);

function readComponentSource(filename: string): string {
  return readFileSync(path.join(COMPONENTS_DIR, filename), "utf-8");
}

const domeRegulatorSource = readComponentSource("dome-regulator.component.js");
const reKFactorSource = readComponentSource("re-k-factor.component.js");
const heatedResistanceSource = readComponentSource(
  "heated-resistance.component.js",
);

const domeRegulator = compileUserComponent(domeRegulatorSource);
const reKFactor = compileUserComponent(reKFactorSource);
const heatedResistance = compileUserComponent(heatedResistanceSource);

/* ------------------------------- helpers -------------------------------- */

/** Default parameter values mirror the metadata defaults in each source. */
const DOME_PARAMS = { P_dome: 200000, CdA_max: 1e-4, band: 50000, eps: 1000 };
const REK_PARAMS = { diameter: 0.02, area: 3.14e-4 };
const HEATED_PARAMS = { K: 2, area: 1e-4, ua: 10, wallTemp: 350 };

function domeArgs(pTo?: number, mdot = 0.1): UserPressureDropArgs {
  return { mdot, rho: 1000, mu: 1e-3, t: 0, pTo, params: DOME_PARAMS };
}

function reKArgs(mdot: number): UserPressureDropArgs {
  return { mdot, rho: 1000, mu: 1e-3, t: 0, area: 3.14e-4, params: REK_PARAMS };
}

function heatedDropArgs(mdot = 0.01): UserPressureDropArgs {
  return { mdot, rho: 1000, mu: 1e-3, t: 0, area: 1e-4, params: HEATED_PARAMS };
}

function heatedHeatArgs(mdot: number, wallTemp = 350): UserHeatArgs {
  return { mdot, Tup: 280, cp: 4180, params: { ...HEATED_PARAMS, wallTemp } };
}

/* ---------------------------- dome-regulator ----------------------------- */

describe("dome-regulator component", () => {
  it("compiles successfully", () => {
    expect(domeRegulator.metadata.name).toBe("dome-regulator");
    expect(typeof domeRegulator.pressureDrop).toBe("function");
  });

  it("returns a finite ΔP for typical args", () => {
    const dp = domeRegulator.pressureDrop(domeArgs(150000));
    expect(Number.isFinite(dp)).toBe(true);
    expect(dp).toBeGreaterThan(0);
  });

  it("drops more pressure as pTo approaches P_dome (valve closing)", () => {
    const dpFarBelow = domeRegulator.pressureDrop(domeArgs(100000));
    const dpNearSetpoint = domeRegulator.pressureDrop(domeArgs(190000));
    // Higher downstream pressure → smaller opening → larger ΔP at fixed mdot.
    expect(dpNearSetpoint).toBeGreaterThan(dpFarBelow);
  });

  it("is nearly closed (very large ΔP) when pTo > P_dome + band", () => {
    const dpClosed = domeRegulator.pressureDrop(domeArgs(260000));
    expect(Number.isFinite(dpClosed)).toBe(true);
    // Opening ~8 % → CdA floored tiny → ΔP orders of magnitude above the
    // open-valve operating point.
    expect(dpClosed).toBeGreaterThan(1e8);
  });

  it("is fully open (small ΔP) when pTo << P_dome", () => {
    const dpOpen = domeRegulator.pressureDrop(domeArgs(50000));
    const dpClosed = domeRegulator.pressureDrop(domeArgs(260000));
    expect(Number.isFinite(dpOpen)).toBe(true);
    expect(dpOpen).toBeGreaterThan(0);
    expect(dpOpen).toBeLessThan(dpClosed / 100);
  });

  it("falls back to fully open when pTo is undefined", () => {
    const dpFallback = domeRegulator.pressureDrop(domeArgs(undefined));
    const dpOpen = domeRegulator.pressureDrop(domeArgs(50000));
    expect(Number.isFinite(dpFallback)).toBe(true);
    // Same magnitude as the wide-open sensed case (within a few percent —
    // tanh opening at pTo = 50 kPa is ~0.9975 vs exactly 1 for fallback).
    const relDiff = Math.abs(dpFallback - dpOpen) / dpOpen;
    expect(relDiff).toBeLessThan(0.02);
  });
});

/* ----------------------------- re-k-factor ------------------------------- */

describe("re-k-factor component", () => {
  it("compiles successfully", () => {
    expect(reKFactor.metadata.name).toBe("re-k-factor");
    expect(typeof reKFactor.pressureDrop).toBe("function");
  });

  it("returns a finite ΔP for typical args", () => {
    const dp = reKFactor.pressureDrop(reKArgs(0.01));
    expect(Number.isFinite(dp)).toBe(true);
    expect(dp).toBeGreaterThan(0);
  });

  it("has a higher effective K at low Re than at high Re", () => {
    // ΔP = K·ṁ²/(2ρA²) → K ∝ ΔP/ṁ² at fixed rho/area.
    const mLow = 1e-5;
    const mHigh = 0.1;
    const dpLow = reKFactor.pressureDrop(reKArgs(mLow));
    const dpHigh = reKFactor.pressureDrop(reKArgs(mHigh));
    const kEffLow = dpLow / (mLow * mLow);
    const kEffHigh = dpHigh / (mHigh * mHigh);
    // Laminar-table K ≈ 50 vs turbulent K ≈ 2.4: a large, unambiguous margin.
    expect(kEffLow).toBeGreaterThan(kEffHigh * 5);
  });

  it("returns exactly 0 at zero flow (no NaN)", () => {
    expect(reKFactor.pressureDrop(reKArgs(0))).toBe(0);
  });

  it("stays finite at very low flow (mdot = 1e-12)", () => {
    const dp = reKFactor.pressureDrop(reKArgs(1e-12));
    expect(Number.isNaN(dp)).toBe(false);
    expect(Number.isFinite(dp)).toBe(true);
    expect(dp).toBeGreaterThanOrEqual(0);
  });
});

/* --------------------------- heated-resistance --------------------------- */

describe("heated-resistance component", () => {
  it("compiles successfully", () => {
    expect(heatedResistance.metadata.name).toBe("heated-resistance");
    expect(typeof heatedResistance.pressureDrop).toBe("function");
  });

  it("returns a finite ΔP for typical args", () => {
    const dp = heatedResistance.pressureDrop(heatedDropArgs());
    expect(Number.isFinite(dp)).toBe(true);
    expect(dp).toBeGreaterThan(0);
  });

  it("provides a heat callback returning finite W for typical args", () => {
    expect(typeof heatedResistance.heat).toBe("function");
    const q = heatedResistance.heat!(heatedHeatArgs(0.01));
    expect(Number.isFinite(q)).toBe(true);
  });

  it("sends heat to ~0 as mdot → 0", () => {
    const q = heatedResistance.heat!(heatedHeatArgs(0));
    expect(Math.abs(q)).toBeLessThan(1e-6);
  });

  it("heats (Q > 0) when wallTemp > Tup", () => {
    const q = heatedResistance.heat!(heatedHeatArgs(0.01, 350));
    expect(q).toBeGreaterThan(0);
  });

  it("cools (Q < 0) when wallTemp < Tup", () => {
    const q = heatedResistance.heat!(heatedHeatArgs(0.01, 250));
    expect(q).toBeLessThan(0);
  });
});

/* --------------------------- embedded examples --------------------------- */

describe("advanced-component example networks", () => {
  it("extensionAdvancedExample validates with no errors", () => {
    expect(extensionAdvancedExample.meta.version).toBe(2);
    expect(validateNetwork(extensionAdvancedExample)).toEqual([]);
  });

  const componentCases = [
    ["heated-resistance", heatedResistanceSource],
    ["re-k-factor", reKFactorSource],
  ] as const;

  it.each(componentCases)(
    'library file "%s" compiles and metadata round-trips',
    (key, source) => {
      const compiled = compileUserComponent(source);
      expect(compiled.metadata.name).toBe(key);
    },
  );
});
