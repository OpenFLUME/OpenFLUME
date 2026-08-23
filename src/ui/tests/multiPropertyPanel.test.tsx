/**
 * Multi-selection property editing tests.
 *
 * Layers covered:
 *  - store.updateEntities: many per-entity patches commit as exactly ONE
 *    undoable edit, missing ids are skipped, an all-missing batch commits
 *    nothing, and the modelText === serializeText(config) invariant holds;
 *  - selectionExistsIn semantics for the 'multi' variant via setModelText
 *    (wholesale text replacement keeps a multi selection alive while at
 *    least one member survives);
 *  - SSR markup of the PropertyPanel 'multi' branch: per-kind sections,
 *    counts, uniform values editable, disagreeing values flagged as Mixed,
 *    and mixed component types hiding the parameter fields.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { useStore } from "../store";
import PropertyPanel from "../components/PropertyPanel";
import { serializeText } from "../../substrate/textProjection";
import type { NetworkConfig, Selection } from "../types";

/* ------------------------------------------------------------------ */
/* Fixtures + harness                                                  */
/* ------------------------------------------------------------------ */

/** Two boundary nodes, one internal, two pipes, a solid node + conductor. */
function makeConfig(): NetworkConfig {
  return {
    meta: { name: "Multi edit", version: 2 },
    settings: { mode: "steady", tolerance: 1e-8, maxIterations: 100 },
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
        id: "n1",
        type: "internal",
        x: 1,
        y: 0,
        pressure: 1.5e5,
        temperature: 300,
        volume: 1e-3,
      },
      {
        id: "b",
        type: "boundary",
        x: 2,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "seg1",
        from: "a",
        to: "n1",
        component: { type: "pipe", length: 2, diameter: 0.05, roughness: 1e-5 },
      },
      {
        id: "seg2",
        from: "n1",
        to: "b",
        component: { type: "pipe", length: 1, diameter: 0.05, roughness: 1e-5 },
      },
    ],
    solidNodes: [
      {
        id: "s1",
        type: "solid",
        x: 1,
        y: 1,
        temperature: 290,
        mass: 1,
        cp: 500,
      },
    ],
    conductors: [
      {
        id: "c1",
        from: "s1",
        to: "n1",
        type: { kind: "convection", h: 100, area: 0.01 },
      },
    ],
  };
}

function resetStore(config: NetworkConfig) {
  const text = serializeText(config);
  useStore.setState({
    config,
    baseConfig: config,
    selection: { kind: "none" },
    result: null,
    resultConfig: null,
    validationErrors: [],
    past: [],
    future: [],
    modelText: text,
    textDraft: text,
    textDiagnostics: [],
  });
}

function renderPanelSsr(config: NetworkConfig, selection: Selection): string {
  Object.assign(useStore.getInitialState(), {
    config,
    baseConfig: config,
    selection,
  });
  return renderToString(<PropertyPanel />).replace(/<!-- -->/g, "");
}

const s = () => useStore.getState();

/* ------------------------------------------------------------------ */
/* updateEntities                                                      */
/* ------------------------------------------------------------------ */

describe("store.updateEntities", () => {
  beforeEach(() => resetStore(makeConfig()));

  it("applies patches across entity kinds as ONE undo step", () => {
    s().updateEntities([
      { kind: "node", id: "a", patch: { pressure: 3e5 } },
      { kind: "node", id: "b", patch: { pressure: 3e5 } },
      {
        kind: "branch",
        id: "seg1",
        patch: {
          component: {
            type: "pipe",
            length: 2,
            diameter: 0.08,
            roughness: 1e-5,
          },
        },
      },
      { kind: "solidNode", id: "s1", patch: { temperature: 250 } },
      {
        kind: "conductor",
        id: "c1",
        patch: { type: { kind: "convection", h: 100, area: 0.02 } },
      },
    ]);
    const cfg = s().config;
    expect(cfg.nodes.find((n) => n.id === "a")?.pressure).toBe(3e5);
    expect(cfg.nodes.find((n) => n.id === "b")?.pressure).toBe(3e5);
    expect(cfg.branches.find((b) => b.id === "seg1")?.component).toMatchObject({
      diameter: 0.08,
    });
    expect(cfg.solidNodes?.[0].temperature).toBe(250);
    expect(cfg.conductors?.[0].type).toMatchObject({ area: 0.02 });
    // Exactly one history entry; undo restores every member at once.
    expect(s().past).toHaveLength(1);
    s().undo();
    const undone = s().config;
    expect(undone.nodes.find((n) => n.id === "a")?.pressure).toBe(2e5);
    expect(
      undone.branches.find((b) => b.id === "seg1")?.component,
    ).toMatchObject({ diameter: 0.05 });
    expect(undone.solidNodes?.[0].temperature).toBe(290);
    expect(undone.conductors?.[0].type).toMatchObject({ area: 0.01 });
  });

  it("skips missing ids but applies the rest", () => {
    s().updateEntities([
      { kind: "node", id: "ghost", patch: { pressure: 9e5 } },
      { kind: "node", id: "n1", patch: { pressure: 1.2e5 } },
    ]);
    expect(s().config.nodes.find((n) => n.id === "n1")?.pressure).toBe(1.2e5);
    expect(s().past).toHaveLength(1);
  });

  it("commits nothing (and burns no undo step) when no update applies", () => {
    const before = s().config;
    s().updateEntities([{ kind: "branch", id: "ghost", patch: {} }]);
    expect(s().config).toBe(before);
    expect(s().past).toHaveLength(0);
  });

  it("preserves the modelText === serializeText(config) invariant", () => {
    s().updateEntities([
      { kind: "node", id: "a", patch: { pressure: 3.3e5 } },
      { kind: "node", id: "b", patch: { pressure: 3.3e5 } },
    ]);
    expect(s().modelText).toBe(serializeText(s().config));
    expect(s().dirty).toBe(true);
    expect(s().resultStale).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* selectionExistsIn for 'multi' (via wholesale text replacement)      */
/* ------------------------------------------------------------------ */

describe("multi selection across wholesale config replacement", () => {
  beforeEach(() => resetStore(makeConfig()));

  it("keeps a multi selection alive while a member survives, clears it when none do", () => {
    useStore.setState({
      selection: {
        kind: "multi",
        items: [
          { kind: "node", id: "a" },
          { kind: "branch", id: "seg1" },
        ],
      },
    });
    // Remove seg1 only — 'a' survives, selection is retained.
    const cfg = makeConfig();
    cfg.branches = cfg.branches.filter((b) => b.id !== "seg1");
    expect(s().setModelText(serializeText(cfg))).toBe(true);
    expect(s().selection.kind).toBe("multi");
    // Remove node 'a' too (seg2 keeps the network valid) — no selected
    // member survives, so the selection resets.
    const cfg2 = makeConfig();
    cfg2.nodes = cfg2.nodes.filter((n) => n.id !== "a");
    cfg2.branches = cfg2.branches.filter((br) => br.id === "seg2");
    expect(s().setModelText(serializeText(cfg2))).toBe(true);
    expect(s().selection).toEqual({ kind: "none" });
  });
});

/* ------------------------------------------------------------------ */
/* SSR markup of the multi panel                                       */
/* ------------------------------------------------------------------ */

describe("MultiPropertyPanel rendering", () => {
  it("renders per-kind sections with counts", () => {
    const html = renderPanelSsr(makeConfig(), {
      kind: "multi",
      items: [
        { kind: "node", id: "a" },
        { kind: "node", id: "b" },
        { kind: "branch", id: "seg1" },
        { kind: "branch", id: "seg2" },
      ],
    });
    expect(html).toContain("4 selected");
    expect(html).toContain("Nodes (2)");
    expect(html).toContain("Branches (2)");
    expect(html).not.toContain("Solid Nodes");
    expect(html).not.toContain("Conductors");
  });

  it("flags disagreeing values as Mixed and keeps uniform ones editable", () => {
    const html = renderPanelSsr(makeConfig(), {
      kind: "multi",
      items: [
        { kind: "branch", id: "seg1" },
        { kind: "branch", id: "seg2" },
      ],
    });
    // Lengths differ (2 vs 1); diameters agree (0.05).
    expect(html).toContain('data-testid="multi-branch-length-mixed"');
    expect(html).not.toContain('data-testid="multi-branch-diameter-mixed"');
  });

  it("shows a Mixed type placeholder for nodes of different types", () => {
    const html = renderPanelSsr(makeConfig(), {
      kind: "multi",
      items: [
        { kind: "node", id: "a" },
        { kind: "node", id: "n1" },
      ],
    });
    expect(html).toContain(">Mixed</option>");
  });

  it("hides component parameter fields when branch types are mixed", () => {
    const cfg = makeConfig();
    cfg.branches[1].component = { type: "orifice", area: 1e-4, cd: 0.6 };
    const html = renderPanelSsr(cfg, {
      kind: "multi",
      items: [
        { kind: "branch", id: "seg1" },
        { kind: "branch", id: "seg2" },
      ],
    });
    expect(html).toContain("Mixed component types");
    expect(html).not.toContain('data-testid="multi-branch-length"');
  });

  it("drops entities deleted since selection instead of crashing", () => {
    const html = renderPanelSsr(makeConfig(), {
      kind: "multi",
      items: [
        { kind: "node", id: "a" },
        { kind: "node", id: "deleted" },
        { kind: "conductor", id: "c1" },
      ],
    });
    expect(html).toContain("2 selected");
    expect(html).toContain("Conductors (1)");
  });
});
