/**
 * Settings dialog tab shell.
 *
 * The dialog used to be one scrolling column of three grids plus a stacked
 * "Advanced Extensibility" block. Six sections now sit behind horizontal tabs,
 * so these tests pin the parts that other code depends on: Solver is the
 * landing section, only the active panel is rendered (a tab is real navigation,
 * not a CSS hide), closing resets the section, and the legacy test ids that the
 * e2e specs drive still resolve on their sections.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import ConfigurationView from "../components/ConfigurationView";
import { useStore, type SettingsTabId } from "../store";
import type { NetworkConfig } from "../types";

function baseConfig(): NetworkConfig {
  return {
    meta: { name: "settings-tabs", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-8,
      maxIterations: 200,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "a",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 2e5,
        temperature: 300,
      },
      {
        id: "b",
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
        from: "a",
        to: "b",
        component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      },
    ],
  };
}

function renderDialog(
  tab: SettingsTabId = "solver",
  config: NetworkConfig = baseConfig(),
): string {
  Object.assign(useStore.getInitialState(), {
    config,
    baseConfig: config,
    settingsTab: tab,
  });
  return renderToString(<ConfigurationView />).replace(/<!-- -->/g, "");
}

const TABS: SettingsTabId[] = [
  "solver",
  "physics",
  "fluids",
  "species",
  "units",
  "extensibility",
];

describe("Settings dialog tabs", () => {
  beforeEach(() => {
    Object.assign(useStore.getInitialState(), {
      settingsTab: "solver",
    });
  });

  it("offers every section and marks the active one", () => {
    const html = renderDialog("physics");
    for (const tab of TABS) {
      expect(html).toContain(`data-testid="settings-tab-${tab}"`);
    }
    expect(html).toMatch(
      /data-testid="settings-tab-physics"[^>]*aria-selected="true"/,
    );
    expect(html).toMatch(
      /data-testid="settings-tab-solver"[^>]*aria-selected="false"/,
    );
  });

  it("renders only the active panel", () => {
    const html = renderDialog("units");
    expect(html).toContain('data-testid="settings-tab-panel-units"');
    expect(html).not.toContain('data-testid="settings-tab-panel-solver"');
    // Solver controls are genuinely absent, not merely hidden.
    expect(html).not.toContain('data-testid="settings-mode"');
  });

  it("keeps the legacy control ids on their sections", () => {
    const solver = renderDialog("solver");
    expect(solver).toContain('data-testid="settings-mode"');

    const fluids = renderDialog("fluids");
    expect(fluids).toContain('data-testid="settings-fluid-model"');
    expect(fluids).toContain('data-testid="named-fluid-add"');

    const units = renderDialog("units");
    expect(units).toContain('data-testid="unit-preset-si"');
    expect(units).toContain('data-testid="unit-select-pressure"');

    const ext = renderDialog("extensibility");
    expect(ext).toContain('data-testid="settings-registers"');
    expect(ext).toContain('data-testid="settings-logic"');
    expect(ext).toContain('data-testid="settings-controllers"');
  });

  it("defaults to Solver and returns there when you leave the tab", () => {
    const s = () => useStore.getState();
    expect(s().settingsTab).toBe("solver");
    s().setActiveTab("config");
    s().setSettingsTab("species");
    expect(s().settingsTab).toBe("species");
    s().setActiveTab("editor");
    expect(s().settingsTab).toBe("solver");
  });

  it("keeps the section while Configuration stays active", () => {
    const s = () => useStore.getState();
    s().setActiveTab("config");
    s().setSettingsTab("physics");
    s().setActiveTab("config");
    expect(s().settingsTab).toBe("physics");
  });

  it("explains the empty time-stepping section in steady mode", () => {
    const html = renderDialog("solver");
    expect(html).toContain('data-testid="settings-stepping-na"');
    expect(html).not.toContain('data-testid="settings-time-stepping"');
  });

  it("exposes the adaptive absolute tolerances that were text-only", () => {
    const config = baseConfig();
    config.settings = {
      ...config.settings,
      mode: "transient",
      endTime: 1,
      timeStepping: "adaptive",
      adaptive: { dtMin: 1e-4, dtMax: 0.1, relTol: 1e-3 },
    };
    const html = renderDialog("solver", config);
    expect(html).toContain('data-testid="settings-abs-tol-p"');
    expect(html).toContain('data-testid="settings-abs-tol-t"');
  });

  it("exposes the Newton strategy knobs that were text-only", () => {
    const html = renderDialog("solver");
    expect(html).toContain('data-testid="settings-steady-solver"');
    expect(html).toContain('data-testid="settings-globalization"');
    expect(html).toContain('data-testid="settings-jacobian"');
    expect(html).toContain('data-testid="settings-certify-after-coupling"');
  });

  it("restricts the steady solver select to steady mode", () => {
    const config = baseConfig();
    config.settings = {
      ...config.settings,
      mode: "transient",
      dt: 0.01,
      endTime: 1,
    };
    const html = renderDialog("solver", config);
    expect(html).toMatch(/data-testid="settings-steady-solver"[^>]*disabled/);
  });
});
