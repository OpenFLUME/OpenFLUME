/**
 * Species tab: the roster, its optional per-species property columns, and the
 * Arrhenius reaction set — all of which previously existed only as a `species`
 * block you had to hand-write into the model text.
 *
 * `SpeciesConfig` is a set of PARALLEL arrays and validation rejects a ragged
 * one, so the invariant worth pinning is that no edit can desynchronise them:
 * adding or removing a species touches every present column, optional columns
 * toggle whole, and a removed species is purged from reactions and from node
 * mass fractions rather than left dangling.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import ConfigurationView from "../components/ConfigurationView";
import PropertyPanel from "../components/PropertyPanel";
import { useStore } from "../store";
import { validateNetwork } from "../../core";
import { serializeText, parseText } from "../../substrate/textProjection";
import type { NetworkConfig, Selection } from "../types";

function baseConfig(species?: NetworkConfig["species"]): NetworkConfig {
  return {
    meta: { name: "species-editor", version: 2 },
    settings: {
      mode: "transient",
      dt: 0.01,
      endTime: 1,
      tolerance: 1e-8,
      maxIterations: 100,
    },
    fluid: { model: "idealGas", preset: "air" },
    ...(species ? { species } : {}),
    nodes: [
      {
        id: "a",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 3e5,
        temperature: 900,
      },
      {
        id: "mix",
        type: "internal",
        x: 1,
        y: 0,
        pressure: 2e5,
        temperature: 900,
        volume: 0.001,
      },
      {
        id: "b",
        type: "boundary",
        x: 2,
        y: 0,
        pressure: 1e5,
        temperature: 900,
      },
    ],
    branches: [
      {
        id: "p1",
        from: "a",
        to: "mix",
        component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      },
      {
        id: "p2",
        from: "mix",
        to: "b",
        component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      },
    ],
  };
}

const TWO: NetworkConfig["species"] = {
  names: ["N2", "O2"],
  molecularWeights: [0.0280134, 0.0319988],
};

function renderSpecies(config: NetworkConfig): string {
  Object.assign(useStore.getInitialState(), {
    config,
    baseConfig: config,
    settingsTab: "species",
  });
  return renderToString(<ConfigurationView />).replace(/<!-- -->/g, "");
}

function renderPanel(config: NetworkConfig, selection: Selection): string {
  Object.assign(useStore.getInitialState(), {
    config,
    baseConfig: config,
    selection,
  });
  return renderToString(<PropertyPanel />).replace(/<!-- -->/g, "");
}

function resetStore(config: NetworkConfig) {
  useStore.setState({
    config,
    baseConfig: config,
    selection: { kind: "none" },
    result: null,
    resultConfig: null,
    validationErrors: [],
    past: [],
    future: [],
  });
}

const s = () => useStore.getState();
const species = () => s().config.species!;

describe("Species tab rendering", () => {
  it("offers an empty state that enables transport", () => {
    const html = renderSpecies(baseConfig());
    expect(html).toContain('data-testid="species-enable"');
    expect(html).not.toContain('data-testid="species-table"');
  });

  it("warns when the fluid model cannot carry species", () => {
    const config = baseConfig();
    config.fluid = { model: "incompressible", preset: "water" };
    expect(renderSpecies(config)).toContain(
      "only supported for the idealGas fluid model",
    );
  });

  it("warns on a multi-fluid network", () => {
    const config = baseConfig(TWO);
    config.fluids = { coolant: { model: "idealGas", preset: "air" } };
    expect(renderSpecies(config)).toContain(
      "not supported in multi-fluid networks",
    );
  });

  it("renders a row per species and a toggle per optional column", () => {
    const html = renderSpecies(baseConfig(TWO));
    expect(html).toContain('data-testid="species-table"');
    expect(html).toContain('data-testid="species-name-0"');
    expect(html).toContain('data-testid="species-name-1"');
    expect(html).toContain('data-testid="species-column-cp"');
    expect(html).toContain('data-testid="species-column-formationEnthalpy"');
    expect(html).toContain('data-testid="species-column-viscosity"');
    expect(html).toContain('data-testid="reactions-empty"');
  });

  it("renders a reaction as a readable equation", () => {
    const html = renderSpecies(
      baseConfig({
        ...TWO,
        names: ["H2", "O2", "H2O"],
        molecularWeights: [0.002016, 0.0319988, 0.018015],
        reactions: [
          {
            reactants: { H2: 2, O2: 1 },
            products: { H2O: 2 },
            A: 1e12,
            b: 0,
            Ea: 1.2e5,
          },
        ],
      }),
    );
    expect(html).toContain("2 H2 + O2 → 2 H2O");
    expect(html).toContain('data-testid="reaction-0-reactants-H2"');
    expect(html).toContain('data-testid="reaction-0-products-H2O"');
    expect(html).toContain('data-testid="reaction-0-Ea"');
  });

  it("needs two species before a reaction can be added", () => {
    const html = renderSpecies(
      baseConfig({ names: ["N2"], molecularWeights: [0.028] }),
    );
    expect(html).toMatch(/data-testid="reaction-add"[^>]*disabled/);
  });
});

describe("species roster edits keep the parallel arrays aligned", () => {
  beforeEach(() => resetStore(baseConfig(TWO)));

  it("extends every present column when a species is added", () => {
    s().updateSpecies({ ...TWO, cp: [1040, 918] });
    s().updateSpecies({
      ...species(),
      names: [...species().names, "Ar"],
      molecularWeights: [...species().molecularWeights, 0.039948],
      cp: [...species().cp!, 520],
    });
    expect(species().names).toHaveLength(3);
    expect(species().molecularWeights).toHaveLength(3);
    expect(species().cp).toHaveLength(3);
    expect(validateNetwork(s().config)).not.toContain(
      "species.cp must have the same length as species.names",
    );
  });

  it("removes the block entirely rather than leaving an empty roster", () => {
    s().updateSpecies(undefined);
    expect(s().config.species).toBeUndefined();
    resetStore(baseConfig(TWO));
    s().updateSpecies({ names: [], molecularWeights: [] });
    expect(s().config.species).toBeUndefined();
  });

  it("purges node mass fractions for species that no longer exist", () => {
    resetStore({
      ...baseConfig(TWO),
      nodes: baseConfig(TWO).nodes.map((n) =>
        n.id === "mix" ? { ...n, massFractions: { N2: 0.77, O2: 0.23 } } : n,
      ),
    });
    s().updateSpecies({ names: ["N2"], molecularWeights: [0.0280134] });
    const mix = s().config.nodes.find((n) => n.id === "mix")!;
    expect(mix.massFractions).toEqual({ N2: 0.77 });
  });

  it("drops massFractions with the block when transport is removed", () => {
    resetStore({
      ...baseConfig(TWO),
      nodes: baseConfig(TWO).nodes.map((n) =>
        n.id === "mix" ? { ...n, massFractions: { N2: 0.77, O2: 0.23 } } : n,
      ),
    });
    s().updateSpecies(undefined);
    const mix = s().config.nodes.find((n) => n.id === "mix")!;
    expect("massFractions" in mix).toBe(false);
  });

  it("is one undoable edit", () => {
    s().updateSpecies(undefined);
    expect(s().config.species).toBeUndefined();
    s().undo();
    expect(s().config.species).toEqual(TWO);
  });

  it("round-trips a species block through the text projection", () => {
    s().updateSpecies({
      ...TWO,
      cp: [1040, 918],
      reactions: [
        {
          reactants: { N2: 1 },
          products: { O2: 1 },
          A: 1e9,
          b: 0.5,
          Ea: 2e5,
          heatOfReaction: -1e6,
        },
      ],
    });
    const parsed = parseText(serializeText(s().config));
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.species).toEqual(s().config.species);
  });
});

describe("node mass fractions", () => {
  it("stay hidden until the network declares species", () => {
    const html = renderPanel(baseConfig(), { kind: "node", id: "mix" });
    expect(html).not.toContain("node-mass-fraction-");
  });

  it("offer one input per declared species with a running sum", () => {
    const config = {
      ...baseConfig(TWO),
      nodes: baseConfig(TWO).nodes.map((n) =>
        n.id === "mix" ? { ...n, massFractions: { N2: 0.5, O2: 0.3 } } : n,
      ),
    };
    const html = renderPanel(config, { kind: "node", id: "mix" });
    expect(html).toContain('data-testid="node-mass-fraction-N2"');
    expect(html).toContain('data-testid="node-mass-fraction-O2"');
    expect(html).toContain('data-testid="mass-fraction-sum"');
    expect(html).toContain("must be 1 to solve");
    expect(html).toContain('data-testid="mass-fraction-normalize"');
  });

  it("hide the normalize action once the fractions balance", () => {
    const config = {
      ...baseConfig(TWO),
      nodes: baseConfig(TWO).nodes.map((n) =>
        n.id === "mix" ? { ...n, massFractions: { N2: 0.77, O2: 0.23 } } : n,
      ),
    };
    const html = renderPanel(config, { kind: "node", id: "mix" });
    expect(html).not.toContain('data-testid="mass-fraction-normalize"');
    expect(html).not.toContain("must be 1 to solve");
  });
});
