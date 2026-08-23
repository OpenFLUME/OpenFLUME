/**
 * Setup tab real-fluid picker tests — the searchable catalogue dropdown:
 * curated favorites optgroup first, all 124 HEOS fluids listed, ⚠ markers for
 * no-transport fluids, and a saved UNKNOWN fluid rendered visibly as invalid
 * rather than silently reverting to a default.
 *
 * Rendered with react-dom/server (no DOM environment needed), driven through
 * the zustand store like the other UI tests.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import ConfigurationView from "../components/ConfigurationView";
import { useStore } from "../store";
import {
  FLUID_CATALOGUE,
  FLUID_CATALOGUE_COUNT,
} from "../../core/fluids/fluidCatalogue";
import type { NetworkConfig } from "../types";

function baseConfig(fluidName?: string): NetworkConfig {
  return {
    meta: { name: "picker-test", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-9,
      maxIterations: 500,
      relaxation: 0.9,
    },
    fluid:
      fluidName === undefined
        ? { model: "incompressible", preset: "water" }
        : { model: "realFluid", params: { fluidName } },
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
  } as NetworkConfig;
}

function renderDialog(fluidName?: string): string {
  // SSR convention in this repo (zustand's server snapshot is the INITIAL
  // state): mutate getInitialState() before renderToString. The picker lives
  // on the Fluids tab, so the section has to be selected up front.
  Object.assign(useStore.getInitialState(), {
    config: baseConfig(fluidName),
    baseConfig: baseConfig(fluidName),
    settingsTab: "fluids",
  });
  return renderToString(<ConfigurationView />).replace(/<!-- -->/g, "");
}

describe("Setup tab real-fluid picker", () => {
  beforeEach(() => {
    Object.assign(useStore.getInitialState(), {
      settingsTab: "solver",
    });
  });

  it("lists the curated favorites first and every HEOS catalogue fluid", () => {
    const html = renderDialog("Nitrogen");
    expect(html).toContain('data-testid="settings-real-fluid-name"');
    expect(html).toContain('data-testid="settings-real-fluid-search"');
    // Favorites optgroup with the legacy pretty labels (incl. ParaHydrogen,
    // which the old hard-coded list omitted).
    expect(html).toContain('<optgroup label="Favorites">');
    expect(html).toContain("Nitrogen (N₂)");
    expect(html).toContain("Parahydrogen (p-H₂)");
    // Full catalogue optgroup: 124 options, incl. fluids outside the old
    // allowlist (R134a) and pseudo-pure mixtures flagged as such.
    expect(html).toContain(
      `All CoolProp HEOS fluids (${FLUID_CATALOGUE_COUNT})`,
    );
    expect(html).toContain('value="R134a"');
    expect(html).toContain('value="OrthoHydrogen"');
    expect(html).toContain("Air (mixture)");
    // Exactly one option per catalogue fluid in the All group + favorites.
    const favGroup = html.slice(html.indexOf('<optgroup label="Favorites">'));
    const favCount = (
      favGroup.slice(0, favGroup.indexOf("</optgroup>")).match(/<option/g) ?? []
    ).length;
    expect(favCount).toBe(9);
    const allGroup = html.slice(html.indexOf("All CoolProp HEOS fluids"));
    const allCount = (
      allGroup.slice(0, allGroup.indexOf("</optgroup>")).match(/<option/g) ?? []
    ).length;
    expect(allCount).toBe(FLUID_CATALOGUE.length);
  });

  it("marks no-transport fluids and explains the selected one", () => {
    const html = renderDialog("Xenon");
    expect(html).toContain("Xenon (⚠ no transport model)");
    expect(html).toContain("no viscosity or thermal-conductivity model");
    expect(html).toContain('aria-invalid="true"');
  });

  it("renders a saved unknown fluid as a visible invalid option (no silent revert)", () => {
    const html = renderDialog("Unobtanium");
    expect(html).toContain("⚠ Unknown fluid: Unobtanium");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("is not a CoolProp HEOS fluid");
    // The select must hold the SAVED value, not a silently substituted default.
    expect(html).toContain('value="Unobtanium"');
    expect(
      html.match(
        /<select[^>]*data-testid="settings-real-fluid-name"[^>]*aria-invalid="true"/,
      ),
    ).not.toBeNull();
  });

  it("shows the normal hint for a fluid with full transport models", () => {
    const html = renderDialog("Nitrogen");
    expect(html).toContain("NIST-grade properties via CoolProp");
    expect(html).not.toContain('aria-invalid="true"');
  });

  it("selecting a catalogue fluid writes the canonical name to the store", () => {
    Object.assign(useStore.getInitialState(), {
      config: baseConfig("Nitrogen"),
    });
    useStore.setState({ config: baseConfig("Nitrogen") });
    useStore.getState().updateFluid({ params: { fluidName: "R134a" } });
    expect(useStore.getState().config.fluid.params?.fluidName).toBe("R134a");
  });
});
