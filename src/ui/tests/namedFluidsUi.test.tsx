/**
 * Named-fluids UI: helpers, store set/rename/remove, Settings manager,
 * and the node fluid picker (single + multi select).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { useStore } from "../store";
import SettingsDialog from "../components/SettingsDialog";
import PropertyPanel from "../components/PropertyPanel";
import {
  defaultFluidLabel,
  fluidSpecLabel,
  fluidsSummary,
  namedFluidNames,
  nextNamedFluidName,
} from "../fluidsUi";
import type { NetworkConfig, Selection } from "../types";

const oilSpec = {
  model: "incompressible" as const,
  params: { rho: 850, mu: 0.03, cp: 2000 },
};

function baseConfig(): NetworkConfig {
  return {
    meta: { name: "named-fluids-ui", version: 2 },
    settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "A",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 2e5,
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
        component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      },
    ],
  };
}

function resetStore(config: NetworkConfig = baseConfig()) {
  useStore.setState({
    config,
    selection: { kind: "none" },
    result: null,
    resultConfig: null,
    resultDiary: null,
    runHistory: [],
    runSeq: 0,
    selectedRunId: null,
    baselineRunId: null,
    canvasSelection: [],
    past: [],
    future: [],
    dirty: false,
    resultStale: false,
    preparingOperation: null,
    showSettings: false,
    validationErrors: [],
  });
}

function renderSettings(config: NetworkConfig): string {
  Object.assign(useStore.getInitialState(), {
    config,
    showSettings: true,
  });
  return renderToString(<SettingsDialog />).replace(/<!-- -->/g, "");
}

function renderPanel(config: NetworkConfig, selection: Selection): string {
  Object.assign(useStore.getInitialState(), { config, selection });
  return renderToString(<PropertyPanel />).replace(/<!-- -->/g, "");
}

describe("fluidsUi helpers", () => {
  it("labels specs and lists unused names", () => {
    const config = baseConfig();
    expect(fluidSpecLabel(config.fluid)).toBe("water");
    expect(fluidSpecLabel(oilSpec)).toBe("incompressible");
    expect(
      fluidSpecLabel({ model: "realFluid", params: { fluidName: "Nitrogen" } }),
    ).toBe("Nitrogen");
    expect(defaultFluidLabel(config)).toBe("Default (water)");
    expect(namedFluidNames(config)).toEqual([]);
    expect(nextNamedFluidName(config)).toBe("fluid2");
    expect(fluidsSummary(config)).toBe("water");
  });

  it("summarises only named fluids that nodes actually use", () => {
    const config: NetworkConfig = {
      ...baseConfig(),
      fluids: { oil: oilSpec, unused: oilSpec },
      nodes: [
        { ...baseConfig().nodes[0], fluid: "oil" },
        baseConfig().nodes[1],
      ],
    };
    expect(namedFluidNames(config)).toEqual(["oil", "unused"]);
    expect(nextNamedFluidName(config)).toBe("fluid2");
    expect(fluidsSummary(config)).toBe("water, oil");
  });
});

describe("store named-fluid actions", () => {
  beforeEach(() => resetStore());

  it("setNamedFluid creates an undoable fluids map entry", () => {
    const s = () => useStore.getState();
    s().setNamedFluid("oil", oilSpec);
    expect(s().config.fluids).toEqual({ oil: oilSpec });
    expect(s().past).toHaveLength(1);
    s().undo();
    expect(s().config.fluids).toBeUndefined();
  });

  it("renameNamedFluid rewrites node refs in the same edit", () => {
    const s = () => useStore.getState();
    s().setNamedFluid("oil", oilSpec);
    s().updateNode("A", { fluid: "oil" });
    s().renameNamedFluid("oil", "lube");
    expect(s().config.fluids?.lube).toEqual(oilSpec);
    expect(s().config.fluids?.oil).toBeUndefined();
    expect(s().config.nodes[0].fluid).toBe("lube");
    s().undo();
    expect(s().config.nodes[0].fluid).toBe("oil");
    expect(s().config.fluids?.oil).toEqual(oilSpec);
  });

  it("removeNamedFluid clears node refs and drops an empty map", () => {
    const s = () => useStore.getState();
    s().setNamedFluid("oil", oilSpec);
    s().updateNode("A", { fluid: "oil" });
    s().removeNamedFluid("oil");
    expect(s().config.fluids).toBeUndefined();
    expect(s().config.nodes[0].fluid).toBeUndefined();
  });

  it("ignores empty names and colliding renames", () => {
    const s = () => useStore.getState();
    s().setNamedFluid("  ", oilSpec);
    expect(s().config.fluids).toBeUndefined();
    s().setNamedFluid("oil", oilSpec);
    s().setNamedFluid("lube", oilSpec);
    s().renameNamedFluid("oil", "lube");
    expect(Object.keys(s().config.fluids ?? {})).toEqual(["oil", "lube"]);
  });
});

describe("Settings named-fluids manager (SSR)", () => {
  it("always offers Add named fluid", () => {
    const html = renderSettings(baseConfig());
    expect(html).toContain('data-testid="named-fluid-add"');
    expect(html).toContain("Named fluids");
  });

  it("renders an existing named fluid with model and delete controls", () => {
    const html = renderSettings({
      ...baseConfig(),
      fluids: { oil: oilSpec },
    });
    expect(html).toContain('data-testid="named-fluid-oil"');
    expect(html).toContain('data-testid="named-fluid-name-oil"');
    expect(html).toContain('data-testid="named-fluid-model-oil"');
    expect(html).toContain('data-testid="named-fluid-delete-oil"');
  });

  it("gives a custom-params named fluid the same editable fields as the default", () => {
    const html = renderSettings({
      ...baseConfig(),
      fluids: { oil: oilSpec },
    });
    // Preset selector is no longer real-fluid-only.
    expect(html).toContain('data-testid="named-fluid-preset-oil"');
    // Editable rho/mu/cp fields carrying the spec's values.
    expect(html).toContain('data-testid="named-fluid-param-oil-rho"');
    expect(html).toContain('data-testid="named-fluid-param-oil-mu"');
    expect(html).toContain('data-testid="named-fluid-param-oil-cp"');
    expect(html).toContain('value="850"');
    expect(html).toContain('value="2000"');
    // The old "edit as JSON" escape hatch is gone.
    expect(html).not.toContain("edit as JSON in the text view");
  });

  it("shows a preset named fluid's properties read-only", () => {
    const html = renderSettings({
      ...baseConfig(),
      fluids: { coolant: { model: "idealGas", preset: "air" } },
    });
    expect(html).toContain('data-testid="named-fluid-preset-props-coolant"');
    expect(html).toContain('aria-label="Gas constant R for coolant"');
    expect(html).not.toContain('data-testid="named-fluid-param-coolant-R"');
  });

  it("keeps the CoolProp picker for real-fluid named continua", () => {
    const html = renderSettings({
      ...baseConfig(),
      fluids: {
        lox: { model: "realFluid", params: { fluidName: "Oxygen" } },
      },
    });
    expect(html).toContain('data-testid="named-fluid-heos-lox"');
    expect(html).toContain('data-testid="named-fluid-search-lox"');
    // No preset dropdown: realFluid picks its substance from the catalogue.
    expect(html).not.toContain('data-testid="named-fluid-preset-lox"');
  });
});

describe("named-fluid spec editing", () => {
  beforeEach(() => resetStore());

  it("switching a named fluid to Custom seeds params from the preset", () => {
    const s = () => useStore.getState();
    s().setNamedFluid("coolant", { model: "idealGas", preset: "air" });
    // What the Preset -> Custom handler writes.
    s().setNamedFluid("coolant", {
      model: "idealGas",
      preset: undefined,
      params: { R: 287, gamma: 1.4, mu: 1.8e-5, cp: 1005 },
    });
    expect(s().config.fluids?.coolant.preset).toBeUndefined();
    expect(s().config.fluids?.coolant.params?.R).toBe(287);
  });

  it("editing one named fluid's params leaves the default fluid alone", () => {
    const s = () => useStore.getState();
    s().setNamedFluid("oil", oilSpec);
    s().setNamedFluid("oil", {
      ...oilSpec,
      params: { ...oilSpec.params, rho: 900 },
    });
    expect(s().config.fluids?.oil.params?.rho).toBe(900);
    expect(s().config.fluid).toEqual({
      model: "incompressible",
      preset: "water",
    });
  });
});

describe("node fluid picker (SSR)", () => {
  it("hides the dropdown when the network has no named fluids", () => {
    const html = renderPanel(baseConfig(), { kind: "node", id: "A" });
    expect(html).not.toContain('data-testid="node-fluid-select"');
  });

  it("shows Default plus named entries on a fluid node", () => {
    const config: NetworkConfig = {
      ...baseConfig(),
      fluids: { oil: oilSpec },
      nodes: [
        { ...baseConfig().nodes[0], fluid: "oil" },
        baseConfig().nodes[1],
      ],
    };
    const html = renderPanel(config, { kind: "node", id: "A" });
    expect(html).toContain('data-testid="node-fluid-select"');
    expect(html).toContain("Default (water)");
    expect(html).toContain(">oil<");
  });

  it("shows a multi-select fluid control with the default sentinel", () => {
    const config: NetworkConfig = {
      ...baseConfig(),
      fluids: { oil: oilSpec },
    };
    const html = renderPanel(config, {
      kind: "multi",
      items: [
        { kind: "node", id: "A" },
        { kind: "node", id: "B" },
      ],
    });
    expect(html).toContain('data-testid="multi-node-fluid-select"');
    expect(html).toContain('value="__default__"');
  });
});
