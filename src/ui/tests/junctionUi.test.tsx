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
import type {
  NetworkConfig,
  Selection,
  SteadyResult,
  TransientResult,
} from "../types";
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
    baseConfig: config,
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
    validationErrors: [],
    modelText: serializeText(config),
    textDraft: serializeText(config),
    textDiagnostics: [],
  });
}

function renderPanel(config: NetworkConfig, selection: Selection): string {
  Object.assign(useStore.getInitialState(), {
    config,
    baseConfig: config,
    selection,
  });
  return renderToString(<PropertyPanel />).replace(/<!-- -->/g, "");
}

function renderPanelWithResult(
  config: NetworkConfig,
  selection: Selection,
  overrides: {
    result?: SteadyResult | TransientResult | null;
    liveResult?: TransientResult | null;
    runStatus?: string;
    timeIndex?: number | null;
    resultStale?: boolean;
  },
): string {
  Object.assign(useStore.getInitialState(), {
    config,
    selection,
    result: null,
    liveResult: null,
    runStatus: "idle",
    timeIndex: null,
    resultStale: false,
    ...overrides,
  });
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

const testGasState = {
  T0: 3400,
  mw: 0.0221,
  R: 376.2,
  gamma: 1.18,
  cp: 2470,
  mu: 9.8e-5,
  cstar: 1750,
};

/** A steady result carrying just the junction summary (schema.ts
 *  JunctionSummary), keyed by testJunction().id. */
function steadyResultWithJunction(clampedOf = false): SteadyResult {
  return {
    converged: true,
    iterations: 12,
    residual: 1e-10,
    junctions: {
      chamberCombustor: {
        pc: 1.02e6,
        productTemperature: 3196,
        mdotByRole: { oxidizer: 0.9, fuel: 0.36 },
        mdotTotal: 1.26,
        of: 2.5,
        gas: testGasState,
        clampedPc: false,
        clampedOf,
      },
    },
    nodes: { chamber: { pressure: 1.02e6, temperature: 3196, density: 0.8 } },
    branches: {},
  };
}

/** A transient junction summary trajectory (schema.ts
 *  JunctionSummaryHistory) with three steps whose O/F is distinct at each
 *  index, so time-step selection can be pinned by value. */
function transientResultWithJunction(): TransientResult {
  return {
    converged: true,
    times: [0, 0.01, 0.02],
    junctions: {
      chamberCombustor: {
        pc: [8e5, 9.5e5, 1.02e6],
        productTemperature: [3000, 3100, 3196],
        mdotByRole: {
          oxidizer: [0.7, 0.8, 0.9],
          fuel: [0.28, 0.32, 0.36],
        },
        mdotTotal: [0.98, 1.12, 1.26],
        of: [2.1, 2.3, 2.5],
        gas: {
          T0: [3200, 3300, 3400],
          mw: [0.0221, 0.0221, 0.0221],
          R: [376.2, 376.2, 376.2],
          gamma: [1.18, 1.18, 1.18],
          cp: [2470, 2470, 2470],
          mu: [9.6e-5, 9.7e-5, 9.8e-5],
          cstar: [1700, 1725, 1750],
        },
        clampedPc: [false, false, false],
        clampedOf: [false, false, false],
      },
    },
    nodes: {
      chamber: {
        pressure: [8e5, 9.5e5, 1.02e6],
        temperature: [3000, 3100, 3196],
        density: [0.6, 0.7, 0.8],
      },
    },
    branches: {},
  };
}

describe("PropertyPanel junction results", () => {
  const cfg = { ...baseConfig(), junctions: [testJunction()] };

  it("renders nothing before a solve has run", () => {
    const html = renderPanelWithResult(
      cfg,
      { kind: "node", id: "chamber" },
      {},
    );
    expect(html).not.toContain("junction-results");
  });

  it("renders nothing for a node that is not a junction", () => {
    const html = renderPanelWithResult(
      cfg,
      { kind: "node", id: "loxTank" },
      { result: steadyResultWithJunction() },
    );
    expect(html).not.toContain("junction-results");
  });

  it("shows the steady junction summary — Pc, O/F, per-role mdot, CEA gas state", () => {
    const html = renderPanelWithResult(
      cfg,
      { kind: "node", id: "chamber" },
      { result: steadyResultWithJunction() },
    );
    expect(html).toContain("junction-results");
    expect(html).toContain("Junction summary");
    expect(html).toContain("Chamber pressure");
    expect(html).toContain("O/F");
    expect(html).toContain("2.5");
    expect(html).toContain("ṁ (oxidizer)");
    expect(html).toContain("ṁ (fuel)");
    expect(html).toContain("Adiabatic T0");
    expect(html).not.toContain("junction-results-clamped");
  });

  it("flags a clamped junction result", () => {
    const html = renderPanelWithResult(
      cfg,
      { kind: "node", id: "chamber" },
      { result: steadyResultWithJunction(true) },
    );
    expect(html).toContain("junction-results-clamped");
  });

  it("indexes a transient junction history by the selected time step", () => {
    const atStepZero = renderPanelWithResult(
      cfg,
      { kind: "node", id: "chamber" },
      { result: transientResultWithJunction(), timeIndex: 0 },
    );
    expect(atStepZero).toContain("@ step 0");
    expect(atStepZero).toContain("2.1");
    expect(atStepZero).not.toContain("2.5");

    const atLastStep = renderPanelWithResult(
      cfg,
      { kind: "node", id: "chamber" },
      { result: transientResultWithJunction(), timeIndex: null },
    );
    expect(atLastStep).not.toContain("@ step");
    expect(atLastStep).toContain("2.5");
    expect(atLastStep).not.toContain("2.1");
  });

  it("reads a live (in-progress) transient result while running", () => {
    const html = renderPanelWithResult(
      cfg,
      { kind: "node", id: "chamber" },
      {
        result: null,
        liveResult: transientResultWithJunction(),
        runStatus: "running",
        timeIndex: 1,
      },
    );
    expect(html).toContain("junction-results");
    expect(html).toContain("2.3");
  });
});
