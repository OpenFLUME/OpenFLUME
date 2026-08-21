/**
 * Fluid-catalogue tests — the static generated CoolProp HEOS catalogue
 * (src/core/fluids/generated/fluidCatalogue.ts) and its query layer.
 *
 * These tests are deliberately FAST and WASM-free: they never call
 * initRealFluids, proving config validation stays synchronous and does not
 * require the CoolProp module (worker requirement).  The dynamic cross-check
 * against a live CoolProp build lives in the generator script's --check mode
 * (npm run check:fluid-catalogue), not in the test suite.
 */
import { describe, it, expect } from "vitest";
import {
  FLUID_CATALOGUE,
  FLUID_CATALOGUE_COUNT,
  CURATED_REAL_FLUIDS,
  canonicalizeFluidName,
  isCatalogueFluid,
  isCuratedRealFluid,
  getFluidCatalogueEntry,
  fluidHasViscosityModel,
  fluidHasConductivityModel,
} from "../fluids/fluidCatalogue";
import { SUPPORTED_REAL_FLUIDS } from "../fluids/realFluid";
import { validateNetwork } from "../validate";
import type { NetworkConfig } from "../schema";

function realFluidConfig(fluidName: string): NetworkConfig {
  return {
    meta: { name: "catalogue-test", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-9,
      maxIterations: 500,
      relaxation: 0.9,
    },
    fluid: { model: "realFluid", params: { fluidName } },
    nodes: [
      {
        id: "A",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
      {
        id: "B",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "p1",
        from: "A",
        to: "B",
        component: { type: "pipe", length: 1, diameter: 0.01, roughness: 1e-5 },
      },
    ],
  };
}

describe("generated fluid catalogue shape", () => {
  it("contains every HEOS fluid of the shipped coolprop-wasm build (124)", () => {
    // Pinned to the generation source: get_global_param_string('fluids_list').
    expect(FLUID_CATALOGUE).toHaveLength(124);
    expect(FLUID_CATALOGUE_COUNT).toBe(124);
  });

  it("is sorted by canonical name with unique entries", () => {
    const names = FLUID_CATALOGUE.map((e) => e.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every entry carries CAS, purity flag, alias list, and transport flags", () => {
    for (const entry of FLUID_CATALOGUE) {
      expect(typeof entry.cas).toBe("string");
      expect(entry.cas.length).toBeGreaterThan(0);
      expect(typeof entry.pure).toBe("boolean");
      expect(Array.isArray(entry.aliases)).toBe(true);
      expect(["yes", "no", "unknown"]).toContain(entry.transport.viscosity);
      expect(["yes", "no", "unknown"]).toContain(entry.transport.conductivity);
    }
  });

  it("contains the expected landmark fluids and excludes INCOMP-only names", () => {
    const names: ReadonlySet<string> = new Set(
      FLUID_CATALOGUE.map((e) => e.name),
    );
    for (const landmark of [
      "Water",
      "Nitrogen",
      "R134a",
      "Air",
      "OrthoHydrogen",
      "HeavyWater",
    ]) {
      expect(names.has(landmark)).toBe(true);
    }
    // INCOMP backend fluids (e.g. the TD12 thermal oil) must NOT appear —
    // the catalogue is HEOS-only by design.
    expect(names.has("TD12")).toBe(false);
    expect(names.has("INCOMP::TD12")).toBe(false);
  });

  it("marks the pseudo-pure mixtures (Air, R404A, R407C, R410A, R507A, SES36) as non-pure", () => {
    const pseudo = FLUID_CATALOGUE.filter((e) => !e.pure).map((e) => e.name);
    expect(pseudo.sort()).toEqual([
      "Air",
      "R404A",
      "R407C",
      "R410A",
      "R507A",
      "SES36",
    ]);
    expect(getFluidCatalogueEntry("Air")?.cas).toBe("AIR.PPF");
  });

  it("flags NitrousOxide and OrthoHydrogen as having no transport models", () => {
    // Pinned generation-time probe results — these two are the documented
    // no-transport cases (N2O is grandfathered as a curated favorite;
    // OrthoHydrogen is discoverable but rejected by validation).
    expect(getFluidCatalogueEntry("NitrousOxide")?.transport).toEqual({
      viscosity: "no",
      conductivity: "no",
    });
    expect(getFluidCatalogueEntry("OrthoHydrogen")?.transport).toEqual({
      viscosity: "no",
      conductivity: "no",
    });
    expect(fluidHasViscosityModel("NitrousOxide")).toBe(false);
    expect(fluidHasViscosityModel("Water")).toBe(true);
    expect(fluidHasConductivityModel("Water")).toBe(true);
  });

  it("keeps the curated favorites inside the catalogue (backward compat)", () => {
    expect(SUPPORTED_REAL_FLUIDS).toEqual(CURATED_REAL_FLUIDS);
    for (const fav of CURATED_REAL_FLUIDS) {
      expect(getFluidCatalogueEntry(fav)).toBeDefined();
      expect(isCuratedRealFluid(fav)).toBe(true);
    }
    expect(isCuratedRealFluid("R134a")).toBe(false);
  });
});

describe("canonicalizeFluidName", () => {
  it("accepts canonical names exactly", () => {
    expect(canonicalizeFluidName("Nitrogen")).toBe("Nitrogen");
    expect(canonicalizeFluidName("R1233zd(E)")).toBe("R1233zd(E)");
    expect(canonicalizeFluidName("n-Dodecane")).toBe("n-Dodecane");
  });

  it("resolves registered aliases to the canonical name", () => {
    expect(canonicalizeFluidName("N2")).toBe("Nitrogen");
    expect(canonicalizeFluidName("R718")).toBe("Water");
    expect(canonicalizeFluidName("H2O")).toBe("Water");
    expect(canonicalizeFluidName("N2O")).toBe("NitrousOxide");
  });

  it("resolves unambiguous case-insensitive matches", () => {
    expect(canonicalizeFluidName("nitrogen")).toBe("Nitrogen");
    expect(canonicalizeFluidName("WATER")).toBe("Water");
  });

  it("trims surrounding whitespace but does no fuzzy matching", () => {
    expect(canonicalizeFluidName("  Nitrogen  ")).toBe("Nitrogen");
    expect(canonicalizeFluidName("Nitro")).toBeUndefined();
    expect(canonicalizeFluidName("R-134a")).toBeUndefined();
  });

  it("rejects unknown, empty, and backend-qualified strings", () => {
    expect(canonicalizeFluidName("")).toBeUndefined();
    expect(canonicalizeFluidName("Unobtanium")).toBeUndefined();
    expect(canonicalizeFluidName("INCOMP::TD12")).toBeUndefined();
    expect(canonicalizeFluidName("REFPROP::R134a")).toBeUndefined();
    // Arbitrary mixture strings are out of scope for this feature.
    expect(
      canonicalizeFluidName("HEOS::Water[0.5]&Ammonia[0.5]"),
    ).toBeUndefined();
    expect(canonicalizeFluidName("Water[0.5]&Ammonia[0.5]")).toBeUndefined();
  });

  it("isCatalogueFluid agrees with canonicalizeFluidName", () => {
    expect(isCatalogueFluid("R134a")).toBe(true);
    expect(isCatalogueFluid("Unobtanium")).toBe(false);
  });
});

describe("validateNetwork with the full catalogue", () => {
  it("accepts canonical catalogue names beyond the old 9-fluid allowlist", () => {
    expect(validateNetwork(realFluidConfig("R134a"))).toEqual([]);
    expect(validateNetwork(realFluidConfig("Ammonia"))).toEqual([]);
    // Pseudo-pure mixtures are legitimate catalogue fluids.
    expect(validateNetwork(realFluidConfig("R410A"))).toEqual([]);
    expect(validateNetwork(realFluidConfig("Air"))).toEqual([]);
  });

  it("accepts a registered alias without rejecting the config", () => {
    expect(validateNetwork(realFluidConfig("R717"))).toEqual([]); // Ammonia alias
  });

  it("rejects unknown fluid names with a catalogue-aware message", () => {
    const errs = validateNetwork(realFluidConfig("Unobtanium"));
    expect(
      errs.some(
        (e) =>
          e.includes('"Unobtanium"') && e.includes("not a CoolProp HEOS fluid"),
      ),
    ).toBe(true);
  });

  it("rejects no-transport catalogue fluids with a clear zero-transport error", () => {
    for (const name of ["OrthoHydrogen", "R41", "Xenon"]) {
      const errs = validateNetwork(realFluidConfig(name));
      expect(
        errs.some((e) => e.includes(`"${name}"`) && e.includes("no viscosity")),
      ).toBe(true);
    }
  });

  it("grandfathers the curated favorites (NitrousOxide validates despite no transport model)", () => {
    expect(validateNetwork(realFluidConfig("NitrousOxide"))).toEqual([]);
  });

  it("does not require CoolProp WASM initialization (synchronous worker path)", async () => {
    // The fluids/coolprop module state must be untouched by validation:
    // realFluidsReady() stays false in this test process because no test in
    // this file ever calls initRealFluids.
    const { realFluidsReady } = await import("../fluids/coolprop");
    expect(realFluidsReady()).toBe(false);
    expect(validateNetwork(realFluidConfig("Water"))).toEqual([]);
    expect(realFluidsReady()).toBe(false);
  });
});
