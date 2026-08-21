/**
 * Reacting-junction UI: store upsert/remove actions (undo + text sync) and
 * the PropertyPanel junction section on internal fluid nodes
 * (docs/combustion.md; core/schema.ts JunctionConfig).
 */
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { useStore } from "../store";
import PropertyPanel from "../components/PropertyPanel";
import { serializeText } from "../../substrate/textProjection";
import type { NetworkConfig, Selection } from "../types";
import type { JunctionConfig } from "../../core";

/** Feed tanks + chamber + exhaust: the minimal shape a junction wants. */
function baseConfig(): NetworkConfig {
  return {
    meta: { name: "junction-ui", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-8,
      maxIterations: 100,
      kineticEnergy: true,
    },
    fluid: {
      model: "idealGas",
      params: { R: 363.6, gamma: 1.127, mu: 0.000106, cp: 3236 },
    },
    fluids: {
      gas: {
        model: "idealGas",
        params: { R: 363.6, gamma: 1.127, mu: 0.000106, cp: 3236 },
      },
      lox: {
        model: "incompressible",
        params: { rho: 1141, mu: 0.000195, cp: 1700 },
      },
      rp1: {
        model: "incompressible",
        params: { rho: 810, mu: 0.0017, cp: 2000 },
      },
    },
    nodes: [
      {
        id: "loxTank",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 1.3e6,
        temperature: 90,
        fluid: "lox",
      },
      {
        id: "fuelTank",
        type: "boundary",
        x: 0,
        y: 100,
        pressure: 1.3e6,
        temperature: 300,
        fluid: "rp1",
      },
      {
        id: "chamber",
        type: "internal",
        x: 100,
        y: 50,
        pressure: 1e6,
        temperature: 3200,
        fluid: "gas",
      },
      {
        id: "exhaust",
        type: "boundary",
        x: 200,
        y: 50,
        pressure: 1e5,
        temperature: 2000,
        fluid: "gas",
      },
    ],
    branches: [
      {
        id: "oxIn",
        from: "loxTank",
        to: "chamber",
        component: { type: "orifice", area: 3.2e-5, cd: 0.65 },
      },
      {
        id: "fuelIn",
        from: "fuelTank",
        to: "chamber",
        component: { type: "orifice", area: 1.5e-5, cd: 0.65 },
      },
      {
        id: "out",
        from: "chamber",
        to: "exhaust",
        component: {
          type: "pipe",
          length: 0.1,
          diameter: 0.02,
          roughness: 0,
          frictionFactor: 0.02,
        },
      },
    ],
  };
}

const testJunction = (): JunctionConfig => ({
  id: "chamberCombustor",
  node: "chamber",
  inlets: [
    { branch: "oxIn", role: "oxidizer" },
    { branch: "fuelIn", role: "fuel" },
  ],
  model: { type: "ceaTable", propellants: "lox-rp1", efficiency: 0.94 },
  productFluid: "gas",
});

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
    modelText: serializeText(config),
    textDraft: serializeText(config),
    textDiagnostics: [],
  });
}

function renderPanel(config: NetworkConfig, selection: Selection): string {
  Object.assign(useStore.getInitialState(), { config, selection });
  return renderToString(<PropertyPanel />).replace(/<!-- -->/g, "");
}

describe("junction store actions", () => {
  it("upsertJunction adds a junction as one undoable, text-synced edit", () => {
    resetStore();
    const s = useStore.getState();
    s.upsertJunction(testJunction());

    const after = useStore.getState();
    expect(after.config.junctions).toHaveLength(1);
    expect(after.config.junctions![0].node).toBe("chamber");
    expect(after.past).toHaveLength(1);
    expect(after.modelText).toBe(serializeText(after.config));
    expect(after.modelText).toContain("junctions");
    expect(after.resultStale).toBe(true);

    after.undo();
    expect(useStore.getState().config.junctions).toBeUndefined();
  });

  it("upsertJunction replaces the junction keyed by the same node", () => {
    resetStore({ ...baseConfig(), junctions: [testJunction()] });
    useStore.getState().upsertJunction({
      ...testJunction(),
      model: { type: "ceaTable", propellants: "lox-rp1", efficiency: 0.88 },
    });
    const junctions = useStore.getState().config.junctions!;
    expect(junctions).toHaveLength(1);
    expect(junctions[0].model.efficiency).toBe(0.88);
  });

  it("upsertJunction ignores a junction whose node does not exist", () => {
    resetStore();
    useStore.getState().upsertJunction({
      ...testJunction(),
      node: "missing",
    });
    expect(useStore.getState().config.junctions).toBeUndefined();
    expect(useStore.getState().past).toHaveLength(0);
  });

  it("removeJunction drops the entry and the emptied field", () => {
    resetStore({ ...baseConfig(), junctions: [testJunction()] });
    useStore.getState().removeJunction("chamber");
    const after = useStore.getState();
    expect(after.config.junctions).toBeUndefined();
    expect(after.modelText).toBe(serializeText(after.config));
    expect(after.past).toHaveLength(1);
  });

  it("removeJunction is a no-op (no undo step) when absent", () => {
    resetStore();
    useStore.getState().removeJunction("chamber");
    expect(useStore.getState().past).toHaveLength(0);
  });
});

describe("PropertyPanel junction section", () => {
  it("offers the toggle on internal nodes only", () => {
    const cfg = baseConfig();
    const internal = renderPanel(cfg, { kind: "node", id: "chamber" });
    expect(internal).toContain("node-junction-toggle");
    expect(internal).toContain("Reacting junction (combustor)");

    const boundary = renderPanel(cfg, { kind: "node", id: "exhaust" });
    expect(boundary).not.toContain("node-junction-toggle");
  });

  it("hides the editor fields until the node is declared a junction", () => {
    const html = renderPanel(baseConfig(), { kind: "node", id: "chamber" });
    expect(html).not.toContain("junction-propellants-select");
    expect(html).not.toContain("junction-role-oxIn");
  });

  it("renders the full editor for a declared junction", () => {
    const cfg = { ...baseConfig(), junctions: [testJunction()] };
    const html = renderPanel(cfg, { kind: "node", id: "chamber" });

    expect(html).toContain("junction-model-select");
    expect(html).toContain("NASA CEA equilibrium table");
    expect(html).toContain("junction-propellants-select");
    expect(html).toContain("lox-rp1");
    expect(html).toContain("junction-efficiency");
    expect(html).toContain("junction-product-fluid-select");
    // One role select per inbound branch; the outflow is not a candidate.
    expect(html).toContain("junction-role-oxIn");
    expect(html).toContain("junction-role-fuelIn");
    expect(html).not.toContain("junction-role-out");
    expect(html).toContain("oxidizer");
    expect(html).toContain("fuel");
  });

  it("offers only idealGas named fluids as the product fluid", () => {
    const cfg = { ...baseConfig(), junctions: [testJunction()] };
    const html = renderPanel(cfg, { kind: "node", id: "chamber" });
    const select = html.slice(
      html.indexOf("junction-product-fluid-select"),
      html.indexOf("Inlet Roles"),
    );
    expect(select).toContain(">gas<");
    expect(select).not.toContain(">lox<");
    expect(select).not.toContain(">rp1<");
  });
});
