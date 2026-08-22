import { describe, it, expect } from "vitest";
import {
  FOLLOW_SELECTION,
  PIN_CAP,
  baselineScalar,
  baselineSeries,
  clampTimeIndex,
  composeChartSeries,
  derivePrimaryKey,
  entityExists,
  formatChannelDelta,
  formatChannelValue,
  groupOfEntity,
  matchesQuery,
  pinKey,
  sameQuantity,
  selectionForExistingEntity,
  summarizeContextGraph,
  unpinKey,
  watchlistChannels,
} from "../channelExplorer";
import { buildContextGraph } from "../channelContext";
import { channelKey, listChannels, type ChannelDescriptor } from "../channels";
import type {
  NetworkConfig,
  Selection,
  SteadyResult,
  TransientResult,
} from "../types";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeConfig(): NetworkConfig {
  return {
    meta: { name: "explorer-fixture", version: 2 },
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
      { id: "n2", type: "internal", x: 100, y: 0, volume: 0.01 },
    ],
    branches: [
      {
        id: "b1",
        label: "Main Pipe",
        from: "n1",
        to: "n2",
        component: { type: "pipe", length: 2, diameter: 0.05, roughness: 1e-5 },
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
      },
      n2: {
        pressure: [100000, 100100, 100200],
        temperature: [299, 299.5, 300],
        density: [1001, 1002, 1003],
      },
    },
    branches: { b1: { mdot: [0.1, 0.2, 0.3] } },
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
      n2: { pressure: 100000, temperature: 299, density: 1001 },
    },
    branches: { b1: { mdot: 0.5, velocity: 0.06, dP: 1325, reynolds: 6000 } },
    solidNodes: { s1: { temperature: 310 } },
    conductors: { c1: { heatRate: 42, heatTransferCoeff: 120 } },
  };
}

function keyOf(
  channels: ChannelDescriptor[],
  entity: string,
  id: string,
  field: string,
): string {
  const d = channels.find(
    (c) =>
      c.channel.entity === entity &&
      c.channel.id === id &&
      c.channel.field === field,
  );
  if (!d) throw new Error(`fixture missing channel ${entity}:${id}.${field}`);
  return d.key;
}

/* ------------------------------------------------------------------ */
/* Pinning / cap                                                       */
/* ------------------------------------------------------------------ */

describe("pinKey / unpinKey", () => {
  it("pins in order and is idempotent", () => {
    let pinned: string[] = [];
    pinned = pinKey(pinned, "a").pinned;
    pinned = pinKey(pinned, "b").pinned;
    expect(pinned).toEqual(["a", "b"]);
    const again = pinKey(pinned, "a");
    expect(again.capped).toBe(false);
    expect(again.pinned).toEqual(["a", "b"]);
  });

  it(`rejects the ${PIN_CAP + 1}th pin with capped=true and an unchanged set`, () => {
    let pinned: string[] = [];
    for (let i = 0; i < PIN_CAP; i++) pinned = pinKey(pinned, `k${i}`).pinned;
    expect(pinned).toHaveLength(PIN_CAP);
    const r = pinKey(pinned, "one-too-many");
    expect(r.capped).toBe(true);
    expect(r.pinned).toEqual(pinned);
    // Unpin frees a slot.
    const freed = unpinKey(pinned, "k3");
    expect(freed).toHaveLength(PIN_CAP - 1);
    expect(pinKey(freed, "one-too-many").capped).toBe(false);
  });

  it("unpinKey is a no-op for absent keys", () => {
    expect(unpinKey(["a", "b"], "zzz")).toEqual(["a", "b"]);
  });
});

/* ------------------------------------------------------------------ */
/* Primary derivation (selection ↔ explorer reconciliation)            */
/* ------------------------------------------------------------------ */

describe("derivePrimaryKey", () => {
  const channels = listChannels(makeConfig(), makeTransient());
  const pN1 = keyOf(channels, "node", "n1", "pressure");
  const mB1 = keyOf(channels, "branch", "b1", "mdot");
  const tS1 = keyOf(channels, "solidNode", "s1", "temperature");

  it("follows the global selection while not dirty (canonical primary field)", () => {
    const sel: Selection = { kind: "node", id: "n1" };
    expect(derivePrimaryKey(channels, sel, FOLLOW_SELECTION)).toBe(pN1);
    expect(
      derivePrimaryKey(
        channels,
        { kind: "branch", id: "b1" },
        FOLLOW_SELECTION,
      ),
    ).toBe(mB1);
    expect(
      derivePrimaryKey(
        channels,
        { kind: "solidNode", id: "s1" },
        FOLLOW_SELECTION,
      ),
    ).toBe(tS1);
  });

  it("falls back to the first inventory channel without a usable selection", () => {
    expect(derivePrimaryKey(channels, { kind: "none" }, FOLLOW_SELECTION)).toBe(
      channels[0].key,
    );
    // Selection whose element has no channels → inventory default.
    expect(
      derivePrimaryKey(
        channels,
        { kind: "node", id: "ghost" },
        FOLLOW_SELECTION,
      ),
    ).toBe(channels[0].key);
  });

  it("keeps a dirty explicit pick regardless of selection (loop-free echo)", () => {
    const focus = { key: tS1, dirty: true };
    expect(derivePrimaryKey(channels, { kind: "node", id: "n1" }, focus)).toBe(
      tS1,
    );
    expect(derivePrimaryKey(channels, { kind: "none" }, focus)).toBe(tS1);
  });

  it("keeps a pinned focus even when not dirty", () => {
    const focus = { key: tS1, dirty: false };
    expect(
      derivePrimaryKey(channels, { kind: "node", id: "n1" }, focus, [tS1]),
    ).toBe(tS1);
    // …but an unpinned, non-dirty focus follows the selection.
    expect(
      derivePrimaryKey(channels, { kind: "node", id: "n1" }, focus, []),
    ).toBe(pN1);
  });

  it("drops a dirty pick that vanished from the inventory (new result)", () => {
    const other = listChannels(makeSteadyConfig(), makeSteady());
    // A transient-only channel (fluidFront) cannot exist in the steady
    // inventory, so the dirty focus falls through to the selection primary.
    const ghostKey = channelKey({
      entity: "node",
      id: "n1",
      field: "fluidFront",
    });
    expect(
      derivePrimaryKey(
        other,
        { kind: "branch", id: "b1" },
        { key: ghostKey, dirty: true },
      ),
    ).toBe(keyOf(other, "branch", "b1", "mdot"));
  });

  it("returns null for an empty inventory", () => {
    expect(
      derivePrimaryKey([], { kind: "node", id: "n1" }, FOLLOW_SELECTION),
    ).toBeNull();
    expect(
      derivePrimaryKey([], { kind: "none" }, { key: "x", dirty: true }),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Watchlist                                                           */
/* ------------------------------------------------------------------ */

describe("watchlistChannels", () => {
  const channels = listChannels(makeConfig(), makeTransient());

  it("returns deterministic defaults when nothing is pinned", () => {
    const w = watchlistChannels(channels, [], { kind: "none" });
    expect(w.defaults).toBe(true);
    expect(w.channels.length).toBeLessThanOrEqual(PIN_CAP);
    expect(w.channels.map((c) => c.key)).toEqual(
      channels.slice(0, PIN_CAP).map((c) => c.key),
    );
  });

  it("defaults put the selected element first", () => {
    const w = watchlistChannels(channels, [], { kind: "solidNode", id: "s1" });
    expect(w.channels[0].channel).toEqual({
      entity: "solidNode",
      id: "s1",
      field: "temperature",
    });
  });

  it("returns the pinned set in pin order, silently dropping stale keys", () => {
    const a = keyOf(channels, "branch", "b1", "mdot");
    const b = keyOf(channels, "node", "n2", "temperature");
    const w = watchlistChannels(channels, [a, "stale-key", b], {
      kind: "none",
    });
    expect(w.defaults).toBe(false);
    expect(w.channels.map((c) => c.key)).toEqual([a, b]);
  });
});

/* ------------------------------------------------------------------ */
/* Time index                                                          */
/* ------------------------------------------------------------------ */

describe("clampTimeIndex", () => {
  it("maps null/non-finite to the FINAL sample", () => {
    expect(clampTimeIndex(null, 5)).toBe(4);
    expect(clampTimeIndex(undefined, 5)).toBe(4);
    expect(clampTimeIndex(NaN, 5)).toBe(4);
    expect(clampTimeIndex(Infinity, 5)).toBe(4);
  });
  it("rounds fractional indices and clamps to range", () => {
    expect(clampTimeIndex(1.4, 5)).toBe(1);
    expect(clampTimeIndex(1.5, 5)).toBe(2);
    expect(clampTimeIndex(-3, 5)).toBe(0);
    expect(clampTimeIndex(99, 5)).toBe(4);
  });
  it("returns 0 for empty/degenerate sample counts", () => {
    expect(clampTimeIndex(null, 0)).toBe(0);
    expect(clampTimeIndex(3, 0)).toBe(0);
    expect(clampTimeIndex(3, NaN)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Series composition / baseline                                       */
/* ------------------------------------------------------------------ */

describe("sameQuantity", () => {
  const channels = listChannels(makeConfig(), makeTransient());
  it("matches on quantity AND rawUnit", () => {
    const p1 = channels.find(
      (c) => c.channel.id === "n1" && c.channel.field === "pressure",
    )!;
    const p2 = channels.find(
      (c) => c.channel.id === "n2" && c.channel.field === "pressure",
    )!;
    const t1 = channels.find(
      (c) => c.channel.id === "n1" && c.channel.field === "temperature",
    )!;
    expect(sameQuantity(p1, p2)).toBe(true);
    expect(sameQuantity(p1, t1)).toBe(false);
  });
  it("separates thermodynamic properties by their own quantity kinds", () => {
    const withProperties = listChannels(makeConfig(), {
      ...makeTransient(),
      nodes: {
        ...makeTransient().nodes,
        n1: {
          ...makeTransient().nodes.n1,
          enthalpy: [1, 2, 3],
          internalEnergy: [1, 2, 3],
          entropy: [1, 2, 3],
          quality: [0, 0.5, 1],
        },
      },
    });
    const find = (field: string) =>
      withProperties.find((c) => c.channel.field === field)!;
    // Enthalpy and internal energy are both J/kg, so they may share an axis.
    expect(sameQuantity(find("enthalpy"), find("internalEnergy"))).toBe(true);
    // Entropy and quality are neither, and neither is a fraction.
    expect(sameQuantity(find("enthalpy"), find("entropy"))).toBe(false);
    expect(sameQuantity(find("enthalpy"), find("quality"))).toBe(false);
  });

  it("keeps a rawUnit channel off a plain axis of the same quantity", () => {
    const channels = listChannels(makeConfig(), makeTransient());
    const plain = channels.find(
      (c) => c.channel.id === "n1" && c.channel.field === "pressure",
    )!;
    const raw = { ...plain, rawUnit: "Pa" };
    expect(sameQuantity(plain, raw)).toBe(false);
    expect(sameQuantity(raw, { ...raw })).toBe(true);
  });
});

describe("composeChartSeries", () => {
  it("orders primary → overlays → dashed baseline, skipping duplicate keys", () => {
    const s = composeChartSeries({
      primary: { key: "p", label: "Primary", values: [1, 2] },
      overlays: [
        { key: "p", label: "Duplicate primary", values: [9, 9] },
        { key: "o1", label: "Overlay", values: [3, 4] },
      ],
      baseline: { values: [0.5, 1.5] },
    });
    expect(s.map((x) => x.id)).toEqual(["p", "o1", "baseline:p"]);
    const base = s[2];
    expect(base.dashed).toBe(true);
    expect(base.opacity).toBeLessThan(1);
    expect(base.matchColorOf).toBe("p");
    expect(base.label).toContain("(baseline)");
  });

  it("omits the baseline entry when no baseline values are given", () => {
    const s = composeChartSeries({
      primary: { key: "p", label: "P", values: [1] },
      baseline: null,
    });
    expect(s).toHaveLength(1);
  });
});

describe("baselineSeries / baselineScalar", () => {
  const cfg = makeConfig();
  const cur = makeTransient();

  it("resolves a same-grid baseline verbatim", () => {
    const base = makeTransient();
    base.nodes.n1.pressure = [101000, 101000, 101000];
    const v = baselineSeries(base, cur, {
      entity: "node",
      id: "n1",
      field: "pressure",
    });
    expect(v).toEqual([101000, 101000, 101000]);
  });

  it("resamples a baseline on a different time grid onto the current grid", () => {
    const base = makeTransient();
    base.times = [0, 1]; // coarser grid
    base.nodes.n1.pressure = [100000, 102000];
    const v = baselineSeries(base, cur, {
      entity: "node",
      id: "n1",
      field: "pressure",
    });
    expect(v).toEqual([100000, 101000, 102000]); // linear at t=0.5
  });

  it("returns null for mode-mismatched or absent channels", () => {
    expect(
      baselineSeries(makeSteady(), cur, {
        entity: "node",
        id: "n1",
        field: "pressure",
      }),
    ).toBeNull();
    expect(
      baselineSeries(cur, cur, {
        entity: "node",
        id: "ghost",
        field: "pressure",
      }),
    ).toBeNull();
    expect(
      baselineSeries(null, cur, {
        entity: "node",
        id: "n1",
        field: "pressure",
      }),
    ).toBeNull();
  });

  it("baselineScalar resolves steady scalars only", () => {
    expect(
      baselineScalar(makeSteady(), {
        entity: "branch",
        id: "b1",
        field: "mdot",
      }),
    ).toBe(0.5);
    expect(
      baselineScalar(makeTransient(), {
        entity: "branch",
        id: "b1",
        field: "mdot",
      }),
    ).toBeNull();
    expect(
      baselineScalar(makeSteady(), {
        entity: "branch",
        id: "ghost",
        field: "mdot",
      }),
    ).toBeNull();
    void cfg;
  });
});

/* ------------------------------------------------------------------ */
/* Entity existence / selection mapping / groups                       */
/* ------------------------------------------------------------------ */

describe("entityExists / selectionForExistingEntity / groupOfEntity", () => {
  const live = makeConfig();

  it("checks the four element kinds and rejects none/group", () => {
    expect(entityExists(live, { kind: "node", id: "n1" })).toBe(true);
    expect(entityExists(live, { kind: "node", id: "ghost" })).toBe(false);
    expect(entityExists(live, { kind: "branch", id: "b1" })).toBe(true);
    expect(entityExists(live, { kind: "solidNode", id: "s1" })).toBe(true);
    expect(entityExists(live, { kind: "conductor", id: "c1" })).toBe(true);
    expect(entityExists(live, { kind: "none" })).toBe(false);
    expect(entityExists(live, { kind: "group", id: "g1" })).toBe(false);
    expect(entityExists(null, { kind: "node", id: "n1" })).toBe(false);
  });

  it("maps channels to selections only when the entity exists live", () => {
    expect(
      selectionForExistingEntity(live, {
        entity: "node",
        id: "n1",
        field: "pressure",
      }),
    ).toEqual({ kind: "node", id: "n1" });
    expect(
      selectionForExistingEntity(live, {
        entity: "node",
        id: "deleted",
        field: "pressure",
      }),
    ).toBeNull();
  });

  it("finds the live group of nodes and solid nodes", () => {
    expect(groupOfEntity(live, "node", "n1")).toBe("g1");
    expect(groupOfEntity(live, "node", "n2")).toBeUndefined();
    expect(groupOfEntity(live, "branch", "b1")).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

describe("formatChannelValue / formatChannelDelta", () => {
  const pressure = { quantity: "pressure" as const };
  const enthalpy = { quantity: "dimensionless" as const, rawUnit: "J/kg" };

  it("formats in preferred units, rawUnit channels never converted", () => {
    expect(formatChannelValue(200000, pressure, { pressure: "kPa" }, 4)).toBe(
      "200 kPa",
    );
    expect(formatChannelValue(100000, enthalpy, undefined, 4)).toBe(
      "100,000 J/kg",
    );
  });

  it("formats deltas with sign and clamps FP noise to +0", () => {
    expect(
      formatChannelDelta(201000, 200000, pressure, { pressure: "kPa" }, 4),
    ).toBe("+1 kPa");
    expect(
      formatChannelDelta(200000, 201000, pressure, { pressure: "kPa" }, 4),
    ).toBe("-1 kPa");
    // Sub-display-resolution difference between nominally identical runs.
    expect(
      formatChannelDelta(
        300,
        300.00000000000006,
        { quantity: "temperature" },
        { temperature: "K" },
        4,
      ),
    ).toBe("+0 K");
  });
});

/* ------------------------------------------------------------------ */
/* Search + context summary                                            */
/* ------------------------------------------------------------------ */

describe("matchesQuery", () => {
  const channels = listChannels(makeConfig(), makeTransient());
  const pipe = channels.find((c) => c.channel.id === "b1")!;
  it("matches label, element id, field and entity kind, case-insensitive", () => {
    expect(matchesQuery(pipe, "main pipe")).toBe(true);
    expect(matchesQuery(pipe, "B1")).toBe(true);
    expect(matchesQuery(pipe, "mdot")).toBe(true); // raw field name
    expect(matchesQuery(pipe, "mass flow")).toBe(true); // field label
    expect(matchesQuery(pipe, "branch")).toBe(true);
    expect(matchesQuery(pipe, "")).toBe(true);
    expect(matchesQuery(pipe, "zzz")).toBe(false);
  });
});

describe("summarizeContextGraph", () => {
  const cfg = makeConfig();
  it("summarizes focus + neighbors + edges", () => {
    const g = buildContextGraph(cfg, { kind: "node", id: "n1" });
    const s = summarizeContextGraph(g);
    expect(s).toContain('fluid node "Feed Tank"');
    expect(s).toContain("branch");
  });
  it("summarizes an edge focus with both endpoints", () => {
    const g = buildContextGraph(cfg, { kind: "branch", id: "b1" });
    expect(summarizeContextGraph(g)).toContain('branch "b1"');
  });
  it("summarizes empty graphs", () => {
    expect(
      summarizeContextGraph(
        buildContextGraph(cfg, { kind: "node", id: "ghost" }),
      ),
    ).toBe("No topology context available for this channel.");
  });
});
