import { describe, it, expect } from "vitest";
import {
  buildChannelsCsv,
  buildContextGraph,
  channelsExportFilename,
  layoutContextGraph,
  normalizeViewport,
  type ChannelContextGraph,
} from "../channelContext";
import { channelKey, listChannels, type ChannelDescriptor } from "../channels";
import { configHash, settingsSummary } from "../provenance";
import type { NetworkConfig, SteadyResult, TransientResult } from "../types";

/* ------------------------------------------------------------------ */
/* Fixtures (factories: mutation tests must not leak between tests)     */
/* ------------------------------------------------------------------ */

function makeConfig(): NetworkConfig {
  return {
    meta: { name: "ctx-fixture", version: 2 },
    settings: {
      mode: "transient",
      tolerance: 1e-8,
      maxIterations: 60,
      dt: 0.5,
      endTime: 1,
    },
    fluid: { model: "incompressible", params: { rho: 1000 } },
    nodes: [
      {
        id: "n1",
        label: "Feed Tank",
        type: "boundary",
        x: 0,
        y: 0,
        group: "g1",
        pressure: 101325,
        temperature: 300,
      },
      { id: "n2", type: "internal", x: 100, y: 0, group: "g1", volume: 0.01 },
      { id: "n3", type: "internal", x: 200, y: 0, volume: 0.01 },
    ],
    branches: [
      {
        id: "b1",
        label: "Main Pipe",
        from: "n1",
        to: "n2",
        component: { type: "pipe", length: 2, diameter: 0.05, roughness: 1e-5 },
      },
      {
        id: "b2",
        from: "n2",
        to: "n3",
        component: { type: "pipe", length: 2, diameter: 0.05, roughness: 1e-5 },
      },
      // Dangling reference: 'ghost' is not a config element.
      {
        id: "bDangling",
        from: "n2",
        to: "ghost",
        component: { type: "pipe", length: 1, diameter: 0.05, roughness: 1e-5 },
      },
    ],
    solidNodes: [
      {
        id: "s1",
        label: "Wall",
        type: "solid",
        x: 150,
        y: 80,
        temperature: 300,
      },
    ],
    conductors: [
      {
        id: "c1",
        from: "n2",
        to: "s1",
        type: { kind: "conduction", k: 400, area: 0.5, length: 0.005 },
      },
      // Dangling reference on the solid side.
      {
        id: "cDangling",
        from: "s1",
        to: "nowhere",
        type: { kind: "conduction", k: 400, area: 0.5, length: 0.005 },
      },
    ],
    groups: [{ id: "g1", label: "Feed", x: 0, y: 0 }],
  };
}

function makeTransient(): TransientResult {
  return {
    converged: true,
    times: [0, 0.5, 1],
    nodes: {
      n1: {
        pressure: [101325, 101300, 101250],
        temperature: [300, 301, 302],
        density: [1000, 999, 998],
        enthalpy: [100e3, 101e3, 102e3],
      },
      n2: {
        pressure: [100000, 100100, 100200],
        temperature: [299, 299.5, 300],
        density: [1001, 1002, 1003],
        quality: [0, 0.5, 1],
      },
      n3: {
        pressure: [99000, 99100, 99200],
        temperature: [298, 298.5, 299],
        density: [1002, 1003, 1004],
      },
    },
    branches: {
      b1: { mdot: [0.1, 0.2, 0.3] },
      b2: { mdot: [0.05, 0.06, 0.07] },
    },
    solidNodes: { s1: { temperature: [300, 305, 310] } },
    conductors: { c1: { heatRate: [10, 20, 30] } },
  };
}

function makeSteadyConfig(): NetworkConfig {
  const c = makeConfig();
  c.settings = { mode: "steady", tolerance: 1e-8, maxIterations: 60 };
  return c;
}

function makeSteady(): SteadyResult {
  return {
    converged: true,
    iterations: 5,
    residual: 1e-9,
    nodes: {
      n1: { pressure: 101325, temperature: 300, density: 1000 },
      n2: { pressure: 100000, temperature: 299, density: 1001, quality: 0.5 },
      n3: { pressure: 99000, temperature: 298, density: 1002 },
    },
    branches: {
      b1: { mdot: 0.5, velocity: 0.06, dP: 1325, reynolds: 6000 },
      b2: { mdot: 0.4, velocity: 0.05, dP: 1000, reynolds: 5000 },
    },
    solidNodes: { s1: { temperature: 310 } },
    conductors: { c1: { heatRate: 42, heatTransferCoeff: 120 } },
  };
}

const FIXED_NOW = "2026-01-01T00:00:00.000Z";

function pick(
  channels: readonly ChannelDescriptor[],
  entity: ChannelDescriptor["channel"]["entity"],
  id: string,
  field: string,
): ChannelDescriptor {
  const found = channels.find(
    (c) =>
      c.channel.entity === entity &&
      c.channel.id === id &&
      c.channel.field === field,
  );
  if (!found)
    throw new Error(`fixture channel missing: ${entity}:${id}:${field}`);
  return found;
}

function nodeIds(graph: ChannelContextGraph): string[] {
  return graph.nodes.map((n) => n.id);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* buildContextGraph: focused one-hop topology                          */
/* ------------------------------------------------------------------ */

describe("buildContextGraph", () => {
  it("focused node: one-hop incident branch/conductor edges + opposite endpoints", () => {
    const graph = buildContextGraph(makeConfig(), { kind: "node", id: "n2" });
    expect(graph.focusedKey).toBe("node:n2");
    // Focused first, then neighbors in edge-discovery order (b1→n1, b2→n3, c1→s1);
    // bDangling is dropped because 'ghost' cannot be placed.
    expect(nodeIds(graph)).toEqual(["n2", "n1", "n3", "s1"]);
    const focus = graph.nodes[0];
    expect(focus).toMatchObject({
      id: "n2",
      kind: "node",
      focused: true,
      neighbor: false,
      x: 100,
      y: 0,
    });
    for (const n of graph.nodes.slice(1)) {
      expect(n.focused).toBe(false);
      expect(n.neighbor).toBe(true);
    }
    expect(graph.edges.map((e) => e.id)).toEqual(["b1", "b2", "c1"]);
    for (const e of graph.edges) expect(e.focused).toBe(false);
    expect(graph.edges[0]).toMatchObject({
      kind: "branch",
      from: "n1",
      to: "n2",
    });
  });

  it("focused branch: the edge plus both endpoints as neighbors", () => {
    const graph = buildContextGraph(makeConfig(), { kind: "branch", id: "b1" });
    expect(graph.focusedKey).toBe("branch:b1");
    expect(graph.edges).toEqual([
      { id: "b1", kind: "branch", from: "n1", to: "n2", focused: true },
    ]);
    // Endpoints in from,to order.
    expect(nodeIds(graph)).toEqual(["n1", "n2"]);
    expect(graph.nodes.every((n) => n.neighbor && !n.focused)).toBe(true);
  });

  it("focused solid node: fluid-solid conductor pulls in the fluid endpoint", () => {
    const graph = buildContextGraph(makeConfig(), {
      kind: "solidNode",
      id: "s1",
    });
    expect(graph.focusedKey).toBe("solidNode:s1");
    // cDangling ('nowhere' missing) is dropped.
    expect(graph.edges).toEqual([
      { id: "c1", kind: "conductor", from: "n2", to: "s1", focused: false },
    ]);
    expect(nodeIds(graph)).toEqual(["s1", "n2"]);
    const solid = graph.nodes[0];
    expect(solid).toMatchObject({
      kind: "solidNode",
      label: "Wall",
      focused: true,
      x: 150,
      y: 80,
    });
    expect(graph.nodes[1]).toMatchObject({
      id: "n2",
      kind: "node",
      neighbor: true,
    });
  });

  it("focused conductor: fluid↔solid endpoints with labels (label fallback to id)", () => {
    const graph = buildContextGraph(makeConfig(), {
      kind: "conductor",
      id: "c1",
    });
    expect(graph.focusedKey).toBe("conductor:c1");
    expect(graph.edges).toEqual([
      { id: "c1", kind: "conductor", from: "n2", to: "s1", focused: true },
    ]);
    // n2 (fluid) then s1 (solid), in from,to order.
    expect(graph.nodes.map((n) => [n.id, n.kind, n.label])).toEqual([
      ["n2", "node", "n2"], // no label in config → falls back to id
      ["s1", "solidNode", "Wall"],
    ]);
  });

  it("accepts a ChannelId as the selection (entity/id shape)", () => {
    const graph = buildContextGraph(makeConfig(), {
      entity: "node",
      id: "n2",
      field: "pressure",
    });
    expect(graph.focusedKey).toBe("node:n2");
    expect(nodeIds(graph)).toEqual(["n2", "n1", "n3", "s1"]);
  });

  it("handles missing references without throwing", () => {
    const config = makeConfig();
    // Selecting the dangling edge itself: unplaceable endpoint → empty graph.
    expect(
      buildContextGraph(config, { kind: "branch", id: "bDangling" }),
    ).toEqual({
      focusedKey: null,
      nodes: [],
      edges: [],
    });
    expect(
      buildContextGraph(config, { kind: "conductor", id: "cDangling" })
        .focusedKey,
    ).toBeNull();
    // Unknown / result-only ids and 'none' → empty graph.
    expect(buildContextGraph(config, { kind: "node", id: "ghost" })).toEqual({
      focusedKey: null,
      nodes: [],
      edges: [],
    });
    expect(buildContextGraph(config, { kind: "none" }).focusedKey).toBeNull();
    // Garbage inputs never throw.
    expect(
      buildContextGraph(config, 42 as unknown as null).focusedKey,
    ).toBeNull();
    expect(
      buildContextGraph(null, { kind: "node", id: "n1" }).focusedKey,
    ).toBeNull();
    expect(
      buildContextGraph({ nodes: "junk" } as unknown as NetworkConfig, {
        kind: "node",
        id: "n1",
      }).focusedKey,
    ).toBeNull();
    // Non-finite coordinates make the element unplaceable.
    const nan: NetworkConfig = makeConfig();
    nan.nodes[1] = { ...nan.nodes[1], x: NaN };
    expect(
      buildContextGraph(nan, { kind: "node", id: "n2" }).focusedKey,
    ).toBeNull();
  });

  it("group selection: member nodes plus intra-group edges only", () => {
    const graph = buildContextGraph(makeConfig(), { kind: "group", id: "g1" });
    expect(graph.focusedKey).toBe("group:g1");
    expect(nodeIds(graph)).toEqual(["n1", "n2"]);
    expect(graph.nodes.every((n) => n.focused)).toBe(true);
    // b1 (n1→n2) is internal; b2/c1/bDangling leave the group or dangle.
    expect(graph.edges.map((e) => e.id)).toEqual(["b1"]);
    // Unknown group → empty graph, no throw.
    expect(
      buildContextGraph(makeConfig(), { kind: "group", id: "nope" }),
    ).toEqual({
      focusedKey: null,
      nodes: [],
      edges: [],
    });
  });

  it("reads only the captured config: deleted-live and result-only independence", () => {
    const captured = makeConfig();
    const before = buildContextGraph(captured, { kind: "node", id: "n2" });

    // Edit a separate "live" config afterwards: the historical graph is unchanged.
    const live = makeConfig();
    live.nodes = live.nodes.filter((n) => n.id !== "n3"); // deleted-live element
    live.nodes[0] = { ...live.nodes[0], label: "Renamed Live" };
    const after = buildContextGraph(captured, { kind: "node", id: "n2" });
    expect(after).toEqual(before);
    expect(nodeIds(after)).toContain("n3");
    expect(after.nodes.find((n) => n.id === "n1")!.label).toBe("Feed Tank");

    // The same selection against the edited live config reflects the edit —
    // proving graphs follow the snapshot they are handed, nothing else.
    const liveGraph = buildContextGraph(live, { kind: "node", id: "n2" });
    expect(nodeIds(liveGraph)).not.toContain("n3");

    // Result-only element (present in the result, absent from config): no graph.
    const result = makeTransient();
    (result.nodes as Record<string, unknown>).resultOnly = {
      pressure: [1, 2, 3],
    };
    expect(
      buildContextGraph(captured, { kind: "node", id: "resultOnly" })
        .focusedKey,
    ).toBeNull();
  });

  it("never mutates the config (deep-frozen input)", () => {
    const config = deepFreeze(makeConfig());
    const snapshot = JSON.stringify(config);
    expect(() =>
      buildContextGraph(config, { kind: "node", id: "n2" }),
    ).not.toThrow();
    expect(JSON.stringify(config)).toBe(snapshot);
  });
});

/* ------------------------------------------------------------------ */
/* normalizeViewport / layoutContextGraph                               */
/* ------------------------------------------------------------------ */

describe("normalizeViewport / layoutContextGraph", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 200, y: 0 },
    { x: 150, y: 80 },
  ];
  const opts = { width: 400, height: 300, padding: 20 };

  it("maps every point inside the padded box with uniform (aspect-preserving) scale", () => {
    const vp = normalizeViewport(points, opts);
    for (const p of points) {
      const q = vp.project(p.x, p.y);
      expect(q.x).toBeGreaterThanOrEqual(20);
      expect(q.x).toBeLessThanOrEqual(380);
      expect(q.y).toBeGreaterThanOrEqual(20);
      expect(q.y).toBeLessThanOrEqual(280);
    }
    // Uniform scale: horizontal spacing ratios survive exactly.
    const [a, b, c, d] = points.map((p) => vp.project(p.x, p.y));
    expect(b.x - a.x).toBeCloseTo(c.x - b.x, 12); // equal source spacing stays equal
    // Aspect preserved: source dy/dx == projected dy/dx.
    expect((d.y - a.y) / (c.x - a.x)).toBeCloseTo(80 / 200, 12);
    // Extreme source points sit exactly on the tight (x) padding bounds.
    expect(a.x).toBeCloseTo(20, 12);
    expect(c.x).toBeCloseTo(380, 12);
    // Slack axis (y) is centered.
    expect((a.y + vp.project(0, 80).y) / 2).toBeCloseTo(150, 12);
  });

  it("centers degenerate one-point and identical-coordinate inputs (no NaN)", () => {
    const single = normalizeViewport([{ x: 5, y: -7 }], opts);
    expect(single.scale).toBe(1);
    expect(single.project(5, -7)).toEqual({ x: 200, y: 150 });

    const identical = normalizeViewport(
      [
        { x: 5, y: -7 },
        { x: 5, y: -7 },
        { x: 5, y: -7 },
      ],
      opts,
    );
    const q = identical.project(5, -7);
    expect(q).toEqual({ x: 200, y: 150 });
    expect(Number.isNaN(q.x)).toBe(false);

    // One degenerate axis: scale comes from the non-degenerate axis, other centered.
    const line = normalizeViewport(
      [
        { x: 0, y: 3 },
        { x: 100, y: 3 },
      ],
      opts,
    );
    expect(line.scale).toBeCloseTo(3.6, 12); // (400 - 40) / 100
    expect(line.project(0, 3).y).toBeCloseTo(150, 12);

    // Empty / non-finite input → centered projection, finite output.
    const empty = normalizeViewport([], opts);
    expect(empty.project(0, 0)).toEqual({ x: 200, y: 150 });
    const dirty = normalizeViewport(
      [
        { x: 0, y: 0 },
        { x: NaN, y: Infinity },
      ],
      opts,
    );
    expect(dirty.project(0, 0)).toEqual({ x: 200, y: 150 });
  });

  it("lays out a graph: preserved node order, bounds, viewBox, no mutation", () => {
    const graph = buildContextGraph(makeConfig(), { kind: "node", id: "n2" });
    const graphJson = JSON.stringify(graph);
    const layout = layoutContextGraph(graph, opts);
    expect(layout.viewBox).toBe("0 0 400 300");
    expect(layout.focusedKey).toBe("node:n2");
    expect(layout.nodes.map((n) => n.id)).toEqual(graph.nodes.map((n) => n.id));
    expect(layout.edges).toEqual(graph.edges);
    for (const n of layout.nodes) {
      expect(n.cx).toBeGreaterThanOrEqual(20 - 1e-9);
      expect(n.cx).toBeLessThanOrEqual(380 + 1e-9);
      expect(n.cy).toBeGreaterThanOrEqual(20 - 1e-9);
      expect(n.cy).toBeLessThanOrEqual(280 + 1e-9);
      // Source coordinates are kept alongside pixel coordinates.
      expect(Number.isFinite(n.x)).toBe(true);
    }
    expect(JSON.stringify(graph)).toBe(graphJson); // input graph untouched

    // Frozen graph input must not throw either.
    const frozen = deepFreeze(
      buildContextGraph(makeConfig(), { kind: "branch", id: "b1" }),
    );
    expect(() => layoutContextGraph(frozen)).not.toThrow();

    // Empty / garbage graphs → empty layout with default box.
    const empty = layoutContextGraph({
      focusedKey: null,
      nodes: [],
      edges: [],
    });
    expect(empty.viewBox).toBe("0 0 320 240");
    expect(empty.nodes).toEqual([]);
    expect(layoutContextGraph(null).nodes).toEqual([]);
  });

  it("identical coordinates in a real config still produce a drawable layout", () => {
    const config = makeConfig();
    config.nodes = config.nodes.map((n) => ({ ...n, x: 42, y: 42 }));
    config.solidNodes = config.solidNodes!.map((s) => ({ ...s, x: 42, y: 42 }));
    const layout = layoutContextGraph(
      buildContextGraph(config, { kind: "node", id: "n2" }),
    );
    for (const n of layout.nodes) {
      expect(Number.isFinite(n.cx)).toBe(true);
      expect(Number.isFinite(n.cy)).toBe(true);
      expect(n.cx).toBeCloseTo(160, 12); // default 320×240 box center
      expect(n.cy).toBeCloseTo(120, 12);
    }
  });
});

/* ------------------------------------------------------------------ */
/* buildChannelsCsv                                                     */
/* ------------------------------------------------------------------ */

describe("buildChannelsCsv", () => {
  function transientSelection(): {
    config: NetworkConfig;
    result: TransientResult;
    channels: ChannelDescriptor[];
  } {
    const config = makeConfig();
    const result = makeTransient();
    return { config, result, channels: listChannels(config, result) };
  }

  it("wide format: all-transient, same quantity → time + one column per channel", () => {
    const { config, result, channels } = transientSelection();
    const selected = [
      pick(channels, "node", "n1", "pressure"),
      pick(channels, "node", "n2", "pressure"),
    ];
    const csv = buildChannelsCsv({
      config,
      result,
      channels: selected,
      generatedAt: FIXED_NOW,
    });
    const expected = [
      "# model=ctx-fixture",
      `# generated=${FIXED_NOW}`,
      "# mode=transient",
      `# settings=${settingsSummary(config)}`,
      `# config_hash=${configHash(config)}`,
      "# units=SI (raw solver values, no conversion applied)",
      "# format=wide",
      "# quantity=pressure",
      "# unit=Pa",
      "# time_unit=s",
      "time (s),Feed Tank · Pressure (Pa),n2 · Pressure (Pa)",
      "0,101325,100000",
      "0.5,101300,100100",
      "1,101250,100200",
      "",
    ].join("\n");
    expect(csv).toBe(expected);
  });

  it("wide column order follows the input order (deterministic, deduped)", () => {
    const { config, result, channels } = transientSelection();
    const n1p = pick(channels, "node", "n1", "pressure");
    const n2p = pick(channels, "node", "n2", "pressure");
    const csv = buildChannelsCsv({
      config,
      result,
      channels: [n2p, n1p, n2p],
      generatedAt: FIXED_NOW,
    });
    expect(csv).toContain(
      "time (s),n2 · Pressure (Pa),Feed Tank · Pressure (Pa)\n",
    );
    expect(csv).toContain("0,100000,101325\n");
    // Same input twice → byte-identical output.
    const again = buildChannelsCsv({
      config,
      result,
      channels: [n2p, n1p, n2p],
      generatedAt: FIXED_NOW,
    });
    expect(again).toBe(csv);
  });

  it("wide format: mixed quantities share the time column, unit per column header", () => {
    const { config, result, channels } = transientSelection();
    const selected = [
      pick(channels, "node", "n1", "pressure"),
      pick(channels, "node", "n1", "temperature"),
    ];
    const csv = buildChannelsCsv({
      config,
      result,
      channels: selected,
      generatedAt: FIXED_NOW,
    });
    expect(csv).toContain("# format=wide\n");
    // A mixed set has no single axis, so no bare quantity/unit comment.
    expect(csv).not.toContain("# quantity=");
    expect(csv).not.toContain("# unit=");
    expect(csv).toContain(
      "time (s),Feed Tank · Pressure (Pa),Feed Tank · Temperature (K)\n",
    );
    expect(csv).toContain("0,101325,300\n");
    expect(csv).toContain("0.5,101300,301\n");
  });

  it("wide format: ragged grids (non-finite samples) leave blank cells, not a new format", () => {
    const { config, result, channels } = transientSelection();
    // Knock out one n2 sample → resolved time grids differ between channels.
    result.nodes.n2.pressure = [100000, NaN, 100200];
    const selected = [
      pick(channels, "node", "n1", "pressure"),
      pick(channels, "node", "n2", "pressure"),
    ];
    const csv = buildChannelsCsv({
      config,
      result,
      channels: selected,
      generatedAt: FIXED_NOW,
    });
    expect(csv).toContain("# format=wide\n");
    expect(csv).toContain(
      "# gaps=blank cell = no finite sample for that channel at that time\n",
    );
    expect(csv).not.toContain("NaN");
    // The union grid keeps every instant; the gap is an empty cell.
    expect(csv).toContain("0,101325,100000\n");
    expect(csv).toContain("0.5,101300,\n");
    expect(csv).toContain("1,101250,100200\n");
  });

  it("steady scalars: long rows with no time column at all; raw SI units", () => {
    const config = makeSteadyConfig();
    const result = makeSteady();
    const channels = listChannels(config, result);
    const selected = [
      pick(channels, "branch", "b1", "mdot"),
      pick(channels, "node", "n2", "quality"),
    ];
    const csv = buildChannelsCsv({
      config,
      result,
      channels: selected,
      generatedAt: FIXED_NOW,
    });
    expect(csv).toContain("# mode=steady\n");
    expect(csv).toContain("# format=long\n");
    expect(csv).toContain(
      "channel_key,entity_kind,entity_id,field,quantity,unit,value\n",
    );
    expect(csv).toContain(
      `${channelKey({ entity: "branch", id: "b1", field: "mdot" })},branch,b1,mdot,massFlow,kg/s,0.5\n`,
    );
    // dimensionless symbol '-' is formula-guarded to a leading apostrophe.
    expect(csv).toContain(
      `${channelKey({ entity: "node", id: "n2", field: "quality" })},node,n2,quality,dimensionless,'-,0.5\n`,
    );
  });

  it("exports enthalpy as specific energy in SI J/kg", () => {
    const { config, result, channels } = transientSelection();
    const selected = [pick(channels, "node", "n1", "enthalpy")];
    const csv = buildChannelsCsv({
      config,
      result,
      channels: selected,
      generatedAt: FIXED_NOW,
    });
    expect(csv).not.toContain("# raw_units=");
    expect(csv).toContain("# quantity=specificEnergy\n");
    expect(csv).toContain("# unit=J/kg\n");
    expect(csv).toContain("time (s),Feed Tank · Enthalpy (J/kg)\n");
    expect(csv).toContain("0,100000\n");
  });

  it("never converts a channel that declares a rawUnit", () => {
    const { config, result, channels } = transientSelection();
    const forged = {
      ...pick(channels, "node", "n1", "enthalpy"),
      rawUnit: "J/kg",
    };
    const csv = buildChannelsCsv({
      config,
      result,
      channels: [forged],
      generatedAt: FIXED_NOW,
      units: { specificEnergy: "kJ/kg" },
    });
    expect(csv).toContain(
      "# raw_units=1 channel(s) carry raw SI units (rawUnit) and are never converted\n",
    );
    expect(csv).toContain("# unit=J/kg\n");
    expect(csv).toContain("0,100000\n");
  });

  it("explicit unit preferences convert values and say so", () => {
    const { config, result, channels } = transientSelection();
    const selected = [
      pick(channels, "node", "n1", "pressure"),
      pick(channels, "node", "n2", "pressure"),
    ];
    const csv = buildChannelsCsv({
      config,
      result,
      channels: selected,
      generatedAt: FIXED_NOW,
      units: { pressure: "kPa" },
    });
    expect(csv).toContain(
      "# units=converted from SI per supplied unit preferences\n",
    );
    expect(csv).toContain("# unit=kPa\n");
    expect(csv).toContain("0,101.325,100\n");

    // Mixed quantities stay one table, each column converted to its own
    // preference and labelled with the unit it was converted to.
    const mixed = buildChannelsCsv({
      config,
      result,
      channels: [
        pick(channels, "node", "n1", "temperature"),
        pick(channels, "node", "n1", "enthalpy"),
      ],
      generatedAt: FIXED_NOW,
      units: { temperature: "C", specificEnergy: "kJ/kg" },
    });
    expect(mixed).toContain(
      "time (s),Feed Tank · Temperature (°C),Feed Tank · Enthalpy (kJ/kg)\n",
    );
    expect(mixed).toContain("0,26.85,100\n");
  });

  it("guards spreadsheet formula injection and applies RFC-4180 quoting", () => {
    const config = makeConfig();
    config.nodes.push({
      id: "n,evil",
      label: '=HYPERLINK("http://evil")',
      type: "internal",
      x: 300,
      y: 0,
      volume: 0.01,
    });
    const result = makeTransient();
    (result.nodes as Record<string, unknown>)["n,evil"] = {
      pressure: [1, 2, 3],
    };
    const channels = listChannels(config, result);
    const evil = pick(channels, "node", "n,evil", "pressure");
    // Guarded label with a leading apostrophe, quotes doubled, cell quoted —
    // in the wide column header the label is written to.
    const csv = buildChannelsCsv({
      config,
      result,
      channels: [evil, pick(channels, "node", "n1", "temperature")],
      generatedAt: FIXED_NOW,
    });
    expect(csv).toContain("# format=wide\n");
    expect(csv).toContain(
      `time (s),"'=HYPERLINK(""http://evil"") · Pressure (Pa)",`,
    );

    // The long path writes the raw id/label into their own cells: a steady
    // result exercises the entity_id column with the same hostile id.
    const steadyConfig = makeSteadyConfig();
    steadyConfig.nodes = config.nodes;
    const steadyResult = makeSteady();
    (steadyResult.nodes as Record<string, unknown>)["n,evil"] = { pressure: 1 };
    const steadyChannels = listChannels(steadyConfig, steadyResult);
    const long = buildChannelsCsv({
      config: steadyConfig,
      result: steadyResult,
      channels: [pick(steadyChannels, "node", "n,evil", "pressure")],
      generatedAt: FIXED_NOW,
    });
    expect(long).toContain("# format=long\n");
    const evilKey = channelKey({
      entity: "node",
      id: "n,evil",
      field: "pressure",
    });
    expect(long).toContain(`${evilKey},node,"n,evil",pressure,pressure,Pa,1\n`);
    // No unguarded formula leader anywhere in a data row.
    for (const line of [...csv.split("\n"), ...long.split("\n")]) {
      if (line.startsWith("#") || line.length === 0) continue;
      for (const cell of line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
        expect(cell).not.toMatch(/^[=+\-@\t]/);
      }
    }
  });

  it("skips unresolvable / non-finite channels and reports them as comments", () => {
    const config = makeConfig();
    const result = makeTransient();
    const transientChannels = listChannels(config, result);
    // A steady-only channel (dP) cannot resolve against the transient result.
    const steadyOnly: ChannelDescriptor = {
      channel: { entity: "branch", id: "b1", field: "dP" },
      key: channelKey({ entity: "branch", id: "b1", field: "dP" }),
      label: "Main Pipe · Pressure drop",
      elementLabel: "Main Pipe",
      quantity: "pressure",
      availability: "steady",
      signed: true,
    };
    const mdot = pick(transientChannels, "branch", "b1", "mdot");
    const csv = buildChannelsCsv({
      config,
      result,
      channels: [steadyOnly, mdot],
      generatedAt: FIXED_NOW,
    });
    expect(csv).toContain(`# skipped=${steadyOnly.key}\n`);
    expect(csv).not.toContain("Pressure drop");
    // mdot still exports fine (single transient channel → wide).
    expect(csv).toContain("time (s),Main Pipe · Mass flow (kg/s)\n");
    expect(csv).toContain("0,0.1\n");

    // Non-finite steady scalar → skipped, finite values only in the output.
    const nanSteady = makeSteady();
    nanSteady.branches.b1.mdot = NaN;
    const steadyConfig = makeSteadyConfig();
    const steadyCsv = buildChannelsCsv({
      config: steadyConfig,
      result: nanSteady,
      channels: listChannels(steadyConfig, nanSteady),
      generatedAt: FIXED_NOW,
    });
    expect(steadyCsv).not.toContain("NaN");
  });

  it("provenance comes from the captured config/hash, not live state", () => {
    const captured = makeConfig();
    const result = makeTransient();
    const channels = listChannels(captured, result);
    const selected = [pick(channels, "node", "n1", "pressure")];
    const capturedHash = configHash(captured);

    // Simulate later live edits: rename + retune the LIVE model object.
    const live = makeConfig();
    live.meta.name = "live-renamed";
    live.settings.tolerance = 1e-3;

    const csv = buildChannelsCsv({
      config: captured,
      result,
      channels: selected,
      generatedAt: FIXED_NOW,
    });
    expect(csv).toContain("# model=ctx-fixture\n");
    expect(csv).not.toContain("live-renamed");
    expect(csv).toContain(`# settings=${settingsSummary(captured)}\n`);
    expect(csv).toContain("tol=1e-8");
    expect(csv).toContain(`# config_hash=${capturedHash}\n`);

    // A caller-supplied captured hash wins over recomputation (run-record flow).
    const withHash = buildChannelsCsv({
      config: captured,
      result,
      channels: selected,
      generatedAt: FIXED_NOW,
      configHash: "deadbeefcafe1234",
    });
    expect(withHash).toContain("# config_hash=deadbeefcafe1234\n");

    // Rebuilding from the untouched captured snapshot is byte-identical.
    expect(
      buildChannelsCsv({
        config: captured,
        result,
        channels: selected,
        generatedAt: FIXED_NOW,
      }),
    ).toBe(csv);
  });

  it("never throws on garbage; empty selection yields comments + long header", () => {
    expect(
      buildChannelsCsv(
        null as unknown as Parameters<typeof buildChannelsCsv>[0],
      ),
    ).toBe("");
    const { config } = transientSelection();
    const csv = buildChannelsCsv({
      config,
      result: null,
      channels: [],
      generatedAt: FIXED_NOW,
    });
    expect(csv).toContain("# format=long\n");
    expect(csv).toContain(
      "channel_key,entity_kind,entity_id,field,quantity,unit,time,value\n",
    );
    // Unresolvable result: every channel is skipped, no data rows.
    const result = makeTransient();
    const channels = listChannels(config, result);
    const csv2 = buildChannelsCsv({
      config,
      result: null,
      channels,
      generatedAt: FIXED_NOW,
    });
    expect(
      csv2.split("\n").filter((l) => l.startsWith("# skipped=")).length,
    ).toBe(channels.length);
  });
});

/* ------------------------------------------------------------------ */
/* channelsExportFilename                                               */
/* ------------------------------------------------------------------ */

describe("channelsExportFilename", () => {
  it("builds safe filenames from the captured model name and channel count", () => {
    expect(channelsExportFilename(makeConfig(), 3)).toBe(
      "ctx-fixture-channels-3.csv",
    );
    expect(channelsExportFilename(makeConfig(), 0)).toBe(
      "ctx-fixture-channels-0.csv",
    );
    expect(channelsExportFilename(makeConfig(), 12, "all")).toBe(
      "ctx-fixture-all-channels-12.csv",
    );
    expect(channelsExportFilename(makeConfig(), 3, "view")).toBe(
      "ctx-fixture-channels-3.csv",
    );

    const fancy = makeConfig();
    fancy.meta.name = "My Model! / cryo ① v2";
    expect(channelsExportFilename(fancy, 12)).toBe(
      "My-Model-cryo-v2-channels-12.csv",
    );

    // Empty / all-unsafe / missing names fall back deterministically.
    fancy.meta.name = "🚀🚀";
    expect(channelsExportFilename(fancy, 1)).toBe("network-channels-1.csv");
    fancy.meta.name = "";
    expect(channelsExportFilename(fancy, 1)).toBe("network-channels-1.csv");
    expect(channelsExportFilename(null, 2)).toBe("network-channels-2.csv");

    // Count is floored and clamped; name is length-capped.
    expect(channelsExportFilename(makeConfig(), 2.9)).toBe(
      "ctx-fixture-channels-2.csv",
    );
    expect(channelsExportFilename(makeConfig(), -5)).toBe(
      "ctx-fixture-channels-0.csv",
    );
    const long = makeConfig();
    long.meta.name = "a".repeat(80);
    const name = channelsExportFilename(long, 1);
    expect(name).toBe(`${"a".repeat(48)}-channels-1.csv`);
    // Output charset is always filesystem-safe.
    expect(channelsExportFilename(fancy, 1)).toMatch(/^[A-Za-z0-9._-]+\.csv$/);
  });

  it("is deterministic and independent of later live renames", () => {
    const captured = makeConfig();
    const before = channelsExportFilename(captured, 2);
    const live = makeConfig();
    live.meta.name = "live-renamed";
    expect(channelsExportFilename(captured, 2)).toBe(before);
    expect(channelsExportFilename(live, 2)).toBe("live-renamed-channels-2.csv");
  });
});
