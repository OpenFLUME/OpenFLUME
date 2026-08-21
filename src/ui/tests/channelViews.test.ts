import { describe, it, expect } from "vitest";
import {
  AGGREGATE_SERIES_CAP,
  CHANNEL_VIEW_PRESETS,
  aggregateChartSeries,
  aggregateRows,
  channelViewPreset,
  defaultPreset,
  displayChannelSet,
  presetChannels,
  presetsForInventory,
  type ChannelViewPresetId,
} from "../channelViews";
import { channelKey, listChannels, type ChannelDescriptor } from "../channels";
import { seriesColor } from "../components/chartMath";
import { resampleSeries } from "../runHistory";
import type { NetworkConfig, SteadyResult, TransientResult } from "../types";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const config: NetworkConfig = {
  meta: { name: "channel-views-fixture", version: 2 },
  settings: { mode: "steady", tolerance: 1e-8, maxIterations: 60 },
  fluid: { model: "incompressible", params: { rho: 1000 } },
  nodes: [
    {
      id: "n1",
      label: "Feed Tank",
      type: "boundary",
      x: 0,
      y: 0,
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
    { id: "s1", label: "Wall", type: "solid", x: 50, y: 60, temperature: 300 },
  ],
  conductors: [
    {
      id: "c1",
      from: "n2",
      to: "s1",
      type: { kind: "conduction", k: 400, area: 0.5, length: 0.005 },
    },
  ],
};

/** Full steady result: every steady-applicable channel present (incl. optional quality + heatTransferCoeff). */
function makeSteady(): SteadyResult {
  return {
    converged: true,
    iterations: 5,
    residual: 1e-9,
    nodes: {
      n1: { pressure: 101325, temperature: 300, density: 1000 },
      n2: { pressure: 100000, temperature: 299, density: 1001, quality: 0.5 },
    },
    branches: {
      b1: {
        mdot: 0.5,
        velocity: 0.06,
        dP: 1325,
        reynolds: 6000,
        massFlux: 255,
        dynamicPressure: 1.8,
        mach: 4e-5,
      },
    },
    solidNodes: { s1: { temperature: 310 } },
    conductors: { c1: { heatRate: 42, heatFlux: 84, heatTransferCoeff: 120 } },
  };
}

/**
 * Full transient result: optional node thermodynamic/transport properties,
 * gasVolume, quality and the fluidFront/ttWf side tables all present.
 */
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
        internalEnergy: [99e3, 100e3, 101e3],
        viscosity: [9e-4, 8.8e-4, 8.6e-4],
        speedOfSound: [1500, 1495, 1490],
        gasVolume: [0.1, 0.2, 0.3],
      },
      n2: {
        pressure: [100000, 100100, 100200],
        temperature: [299, 299.5, 300],
        density: [1001, 1002, 1003],
        quality: [0, 0.5, 1],
      },
    },
    branches: { b1: { mdot: [0.1, 0.2, 0.3] } },
    solidNodes: { s1: { temperature: [300, 305, 310] } },
    conductors: {
      c1: {
        heatRate: [10, 20, 30],
        heatFlux: [20, 40, 60],
        heatTransferCoeff: [100, 110, 120],
      },
    },
    ttWf: {
      c1: {
        fWet: [0, 0.5, 1],
        rewetLatched: [false, false, true],
        regime: ["FB", "TB", "NB"],
      },
    },
    fluidFront: { n2: { fraction: [0, 0.25, 1] } },
  };
}

/** Sparse transient: no optional channels anywhere. */
function makeSparseTransient(): TransientResult {
  return {
    converged: true,
    times: [0, 1],
    nodes: { n1: { pressure: [1, 2], temperature: [3, 4], density: [5, 6] } },
    branches: { b1: { mdot: [0.1, 0.2] } },
    solidNodes: { s1: { temperature: [300, 301] } },
    conductors: { c1: { heatRate: [7, 8] } },
  };
}

function tripletKeys(channels: readonly ChannelDescriptor[]): string[] {
  return channels.map(
    (c) => `${c.channel.entity}:${c.channel.id}:${c.channel.field}`,
  );
}

function presetIds(
  channels: readonly ChannelDescriptor[],
  mode: "steady" | "transient",
): ChannelViewPresetId[] {
  return presetsForInventory(channels, mode).map((p) => p.id);
}

const steady = makeSteady();
const transient = makeTransient();
const steadyChannels = listChannels(config, steady);
const transientChannels = listChannels(config, transient);

/* ------------------------------------------------------------------ */
/* Registry sanity                                                     */
/* ------------------------------------------------------------------ */

describe("CHANNEL_VIEW_PRESETS registry", () => {
  it("is fixed, in canonical order, with unique ids", () => {
    expect(CHANNEL_VIEW_PRESETS.map((p) => p.id)).toEqual([
      "node-pressure",
      "node-solid-temperature",
      "branch-mdot",
      "conductor-heat-rate",
      "node-density",
      "branch-flow",
      "branch-compressible",
      "node-energy",
      "node-transport",
      "conductor-heat-flux",
      "conductor-heat-transfer-coeff",
      "node-gas-volume",
      "dimensionless-fractions",
    ]);
    expect(new Set(CHANNEL_VIEW_PRESETS.map((p) => p.id)).size).toBe(
      CHANNEL_VIEW_PRESETS.length,
    );
  });

  it("channelViewPreset resolves ids and returns undefined for unknown ids", () => {
    expect(channelViewPreset("node-pressure")!.label).toBe("Node pressure");
    expect(channelViewPreset("nope" as ChannelViewPresetId)).toBeUndefined();
  });

  it("mode-scoped presets declare their mode honestly", () => {
    // Gas volume is the only quantity the solver cannot produce in steady;
    // every other preset now applies to both modes.
    expect(channelViewPreset("node-gas-volume")!.mode).toBe("transient");
    expect(channelViewPreset("branch-flow")!.mode).toBe("both");
    expect(channelViewPreset("node-energy")!.mode).toBe("both");
    expect(channelViewPreset("node-pressure")!.mode).toBe("both");
    expect(channelViewPreset("dimensionless-fractions")!.mode).toBe("both");
  });

  it("declares singleAxis only for quantity-homogeneous presets", () => {
    for (const preset of CHANNEL_VIEW_PRESETS) {
      const matched = presetChannels(
        [...steadyChannels, ...transientChannels],
        preset,
      ).channels;
      if (!preset.singleAxis || matched.length === 0) continue;
      const axes = new Set(
        matched.map((c) => `${c.quantity}|${c.rawUnit ?? ""}`),
      );
      expect(axes.size, preset.id).toBe(1);
    }
  });
});

/* ------------------------------------------------------------------ */
/* presetsForInventory: availability, order, sparse inventories        */
/* ------------------------------------------------------------------ */

describe("presetsForInventory", () => {
  it("steady: every preset the result has channels for, in registry order", () => {
    expect(presetIds(steadyChannels, "steady")).toEqual([
      "node-pressure",
      "node-solid-temperature",
      "branch-mdot",
      "conductor-heat-rate",
      "node-density",
      "branch-flow",
      "branch-compressible",
      // this steady result carries no node energy/transport properties
      "conductor-heat-flux",
      "conductor-heat-transfer-coeff",
      // quality present on n2 → fraction group available in steady too
      "dimensionless-fractions",
    ]);
  });

  it("transient: the transient-only preset appears alongside the shared ones", () => {
    expect(presetIds(transientChannels, "transient")).toEqual([
      "node-pressure",
      "node-solid-temperature",
      "branch-mdot",
      "conductor-heat-rate",
      "node-density",
      // this transient result carries mdot only on its branch
      "node-energy",
      "node-transport",
      "conductor-heat-flux",
      "conductor-heat-transfer-coeff",
      "node-gas-volume",
      "dimensionless-fractions",
    ]);
  });

  it("sparse results: presets with no matching channels are excluded", () => {
    const sparse = listChannels(config, makeSparseTransient());
    expect(presetIds(sparse, "transient")).toEqual([
      "node-pressure",
      "node-solid-temperature",
      "branch-mdot",
      "conductor-heat-rate",
      "node-density",
      // no thermodynamic properties, gasVolume, heatFlux, heatTransferCoeff,
      // or quality/fluidFront/fWet
    ]);
  });

  it("empty / garbage inventories yield no presets", () => {
    expect(presetsForInventory([], "steady")).toEqual([]);
    expect(presetsForInventory([], "transient")).toEqual([]);
    expect(
      presetsForInventory(null as unknown as ChannelDescriptor[], "steady"),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* defaultPreset: pressure → temperature → first                       */
/* ------------------------------------------------------------------ */

describe("defaultPreset", () => {
  it("prefers node pressure, then node+solid temperature, then the first available", () => {
    const full = presetsForInventory(steadyChannels, "steady");
    expect(defaultPreset(full)!.id).toBe("node-pressure");

    // No node pressure anywhere (boundary-less inventory): temperature wins.
    const noPressure = steadyChannels.filter(
      (c) => !(c.channel.entity === "node" && c.channel.field === "pressure"),
    );
    expect(defaultPreset(presetsForInventory(noPressure, "steady"))!.id).toBe(
      "node-solid-temperature",
    );

    // Neither pressure nor temperature: the first available preset wins.
    const mdotOnly = steadyChannels.filter(
      (c) => c.channel.entity === "branch" && c.channel.field === "mdot",
    );
    expect(defaultPreset(presetsForInventory(mdotOnly, "steady"))!.id).toBe(
      "branch-mdot",
    );
  });

  it("returns null for an empty availability list", () => {
    expect(defaultPreset([])).toBeNull();
    expect(defaultPreset(null as unknown as never[])).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* presetChannels: match correctness, order, cap, unit safety          */
/* ------------------------------------------------------------------ */

describe("presetChannels", () => {
  it("matches the correct channels per preset, in inventory (config) order", () => {
    expect(
      tripletKeys(presetChannels(transientChannels, "node-pressure").channels),
    ).toEqual(["node:n1:pressure", "node:n2:pressure"]);
    // node + solidNode temperature in one unit-safe group
    expect(
      tripletKeys(
        presetChannels(transientChannels, "node-solid-temperature").channels,
      ),
    ).toEqual([
      "node:n1:temperature",
      "node:n2:temperature",
      "solidNode:s1:temperature",
    ]);
    expect(
      tripletKeys(presetChannels(transientChannels, "branch-mdot").channels),
    ).toEqual(["branch:b1:mdot"]);
    expect(
      tripletKeys(
        presetChannels(transientChannels, "conductor-heat-rate").channels,
      ),
    ).toEqual(["conductor:c1:heatRate"]);
    expect(
      tripletKeys(presetChannels(transientChannels, "node-density").channels),
    ).toEqual(["node:n1:density", "node:n2:density"]);
    // multi-quantity groups, field order per element
    expect(
      tripletKeys(presetChannels(steadyChannels, "branch-flow").channels),
    ).toEqual(["branch:b1:dP", "branch:b1:velocity", "branch:b1:reynolds"]);
    expect(
      tripletKeys(
        presetChannels(steadyChannels, "branch-compressible").channels,
      ),
    ).toEqual([
      "branch:b1:massFlux",
      "branch:b1:dynamicPressure",
      "branch:b1:mach",
    ]);
    expect(
      tripletKeys(presetChannels(transientChannels, "node-transport").channels),
    ).toEqual(["node:n1:viscosity", "node:n1:speedOfSound"]);
    // both specificEnergy, so one honest axis
    expect(
      tripletKeys(presetChannels(transientChannels, "node-energy").channels),
    ).toEqual(["node:n1:enthalpy", "node:n1:internalEnergy"]);
    // optional conductor heatFlux / heatTransferCoeff
    expect(
      tripletKeys(
        presetChannels(transientChannels, "conductor-heat-flux").channels,
      ),
    ).toEqual(["conductor:c1:heatFlux"]);
    expect(
      tripletKeys(
        presetChannels(transientChannels, "conductor-heat-transfer-coeff")
          .channels,
      ),
    ).toEqual(["conductor:c1:heatTransferCoeff"]);
    expect(
      tripletKeys(
        presetChannels(transientChannels, "node-gas-volume").channels,
      ),
    ).toEqual(["node:n1:gasVolume"]);
    // dimensionless fractions: quality + fluidFront + fWet, transient side tables included
    expect(
      tripletKeys(
        presetChannels(transientChannels, "dimensionless-fractions").channels,
      ),
    ).toEqual(["node:n2:quality", "node:n2:fluidFront", "conductor:c1:fWet"]);
  });

  it("accepts a preset object as well as an id; unknown ids yield an empty selection", () => {
    const byId = presetChannels(transientChannels, "node-pressure");
    const byObj = presetChannels(
      transientChannels,
      channelViewPreset("node-pressure")!,
    );
    expect(byObj).toEqual(byId);
    const unknown = presetChannels(
      transientChannels,
      "nope" as ChannelViewPresetId,
    );
    expect(unknown).toEqual({ channels: [], total: 0, capped: false });
  });

  it("reports total/capped honestly and honors custom caps", () => {
    const sel = presetChannels(transientChannels, "node-pressure");
    expect(sel.total).toBe(2);
    expect(sel.capped).toBe(false);
    const one = presetChannels(transientChannels, "node-pressure", 1);
    expect(one.channels).toHaveLength(1);
    expect(one.total).toBe(2);
    expect(one.capped).toBe(true);
    expect(
      presetChannels(transientChannels, "node-pressure", 0).channels,
    ).toEqual([]);
    expect(
      presetChannels(transientChannels, "node-pressure", -3).channels,
    ).toEqual([]);
    // Non-finite cap falls back to the aggregate cap.
    expect(
      presetChannels(transientChannels, "node-pressure", NaN).channels,
    ).toHaveLength(2);
  });

  it(`caps at AGGREGATE_SERIES_CAP (${AGGREGATE_SERIES_CAP}) channels`, () => {
    expect(AGGREGATE_SERIES_CAP).toBe(40);
    const n = AGGREGATE_SERIES_CAP + 5;
    const bigConfig: NetworkConfig = {
      ...config,
      nodes: Array.from({ length: n }, (_, i) => ({
        id: `n${i}`,
        type: "internal" as const,
        x: i,
        y: 0,
        volume: 0.01,
      })),
    };
    const bigSteady: SteadyResult = {
      ...steady,
      nodes: Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `n${i}`,
          { pressure: 1000 + i, temperature: 300, density: 1000 },
        ]),
      ),
    };
    const inventory = listChannels(bigConfig, bigSteady);
    const sel = presetChannels(inventory, "node-pressure");
    expect(sel.total).toBe(n);
    expect(sel.channels).toHaveLength(AGGREGATE_SERIES_CAP);
    expect(sel.capped).toBe(true);
    // Cap cut is deterministic: the first AGGREGATE_SERIES_CAP in config order.
    expect(sel.channels[0].channel.id).toBe("n0");
    expect(sel.channels[AGGREGATE_SERIES_CAP - 1].channel.id).toBe(
      `n${AGGREGATE_SERIES_CAP - 1}`,
    );
  });

  it("is deterministic: repeated calls return identical order", () => {
    const a = presetChannels(transientChannels, "node-solid-temperature");
    const b = presetChannels(transientChannels, "node-solid-temperature");
    expect(tripletKeys(a.channels)).toEqual(tripletKeys(b.channels));
    // Inventory order (config order) is preserved, never re-sorted.
    expect(tripletKeys(a.channels)).toEqual(
      tripletKeys(transientChannels).filter((k) => k.endsWith(":temperature")),
    );
  });

  it("unit safety: the fractions axis admits only plain dimensionless channels", () => {
    const frac = presetChannels(transientChannels, "dimensionless-fractions");
    expect(frac.channels.every((c) => c.rawUnit === undefined)).toBe(true);
    expect(frac.channels.every((c) => c.quantity === "dimensionless")).toBe(
      true,
    );
    // Enthalpy is specificEnergy, so it cannot reach a fractions axis at all.
    expect(frac.channels.some((c) => c.channel.field === "enthalpy")).toBe(
      false,
    );
    const enthalpy = presetChannels(
      transientChannels,
      "node-energy",
    ).channels.find((c) => c.channel.field === "enthalpy")!;
    expect(enthalpy.quantity).toBe("specificEnergy");
    expect(enthalpy.rawUnit).toBeUndefined();

    // Defensive: even a hand-built rawUnit dimensionless channel with a
    // fraction-like field is excluded from the fraction group.
    const forged: ChannelDescriptor = {
      ...frac.channels[0],
      channel: { entity: "node", id: "evil", field: "quality" },
      key: channelKey({ entity: "node", id: "evil", field: "quality" }),
      rawUnit: "J/kg",
    };
    const guarded = presetChannels(
      [...transientChannels, forged],
      "dimensionless-fractions",
    );
    expect(guarded.channels.some((c) => c.channel.id === "evil")).toBe(false);
    expect(guarded.total).toBe(frac.total);
  });
});

/* ------------------------------------------------------------------ */
/* aggregateChartSeries: transient composition, baselines, skips       */
/* ------------------------------------------------------------------ */

describe("aggregateChartSeries", () => {
  it("composes one axis of primaries with stable colors on the shared grid", () => {
    const channels = presetChannels(
      transientChannels,
      "node-pressure",
    ).channels;
    const chart = aggregateChartSeries({ channels, current: transient });
    expect(chart.axes).toHaveLength(1);
    const axis = chart.axes[0];
    expect(axis.quantity).toBe("pressure");
    expect(axis.rawUnit).toBeUndefined();
    expect(axis.times).toEqual([0, 0.5, 1]);
    expect(chart.included).toBe(2);
    expect(chart.baselineOverlays).toBe(0);
    expect(chart.skipped).toEqual([]);
    expect(axis.series.map((s) => s.id)).toEqual(channels.map((c) => c.key));
    expect(axis.series[0].label).toBe("Feed Tank · Pressure");
    expect(axis.series[0].values).toEqual([101325, 101300, 101250]);
    expect(axis.series[0].color).toBe(seriesColor(channels[0].key));
    expect(axis.series[0].dashed).toBeUndefined();
  });

  it("splits unit-unsafe presets into one axis per quantity", () => {
    const channels = presetChannels(
      transientChannels,
      "node-transport",
    ).channels;
    const chart = aggregateChartSeries({ channels, current: transient });
    expect(chart.included).toBe(2);
    expect(chart.axes).toHaveLength(2);
    const [viscosity, soundSpeed] = chart.axes;
    expect(viscosity.quantity).toBe("viscosity");
    expect(viscosity.series.map((s) => s.label)).toEqual([
      "Feed Tank · Viscosity",
    ]);
    expect(soundSpeed.quantity).toBe("velocity");
    expect(soundSpeed.series.map((s) => s.label)).toEqual([
      "Feed Tank · Speed of sound",
    ]);
  });

  it("keeps a quantity-homogeneous preset on one axis", () => {
    const channels = presetChannels(transientChannels, "node-energy").channels;
    const chart = aggregateChartSeries({ channels, current: transient });
    expect(chart.axes).toHaveLength(1);
    expect(chart.axes[0].quantity).toBe("specificEnergy");
    expect(chart.axes[0].series.map((s) => s.label)).toEqual([
      "Feed Tank · Enthalpy",
      "Feed Tank · Internal energy",
    ]);
  });

  it("appends dashed color-locked baseline overlays after the primaries", () => {
    const baseline: TransientResult = {
      ...transient,
      nodes: {
        ...transient.nodes,
        n1: { ...transient.nodes.n1, pressure: [101000, 101000, 101000] },
      },
    };
    const channels = presetChannels(
      transientChannels,
      "node-pressure",
    ).channels;
    const chart = aggregateChartSeries({
      channels,
      current: transient,
      baseline,
    });
    expect(chart.included).toBe(2);
    expect(chart.baselineOverlays).toBe(2);
    const axis = chart.axes[0];
    expect(axis.series).toHaveLength(4);
    // Primaries first, then baselines in the same channel order.
    const [p1, p2, b1, b2] = axis.series;
    expect(b1.id).toBe(`baseline:${p1.id}`);
    expect(b1.label).toBe(`${p1.label} (baseline)`);
    expect(b1.dashed).toBe(true);
    expect(b1.opacity).toBe(0.55);
    expect(b1.matchColorOf).toBe(p1.id);
    expect(b2.matchColorOf).toBe(p2.id);
    // Same time grid → baseline values verbatim (no resampling).
    expect(b1.values).toEqual([101000, 101000, 101000]);
  });

  it("resamples baseline overlays onto the current grid when grids differ", () => {
    const baseline: TransientResult = {
      ...transient,
      times: [0, 1, 2, 3],
      nodes: {
        ...transient.nodes,
        n1: { ...transient.nodes.n1, pressure: [200, 100, 50, 25] },
      },
    };
    const channels = presetChannels(
      transientChannels,
      "node-pressure",
    ).channels.slice(0, 1);
    const chart = aggregateChartSeries({
      channels,
      current: transient,
      baseline,
    });
    const overlay = chart.axes[0].series.find((s) => s.dashed)!;
    expect(overlay.values).toEqual(
      resampleSeries([0, 1, 2, 3], [200, 100, 50, 25], [0, 0.5, 1]),
    );
    expect(overlay.values).toEqual([200, 150, 100]);
  });

  it("resamples a channel whose resolved grid differs from the axis grid", () => {
    // n2 has a non-finite mid-sample → its resolved grid is [0, 1] vs n1's [0, 0.5, 1].
    const ragged: TransientResult = {
      ...transient,
      nodes: {
        n1: { ...transient.nodes.n1 },
        n2: { ...transient.nodes.n2, pressure: [100, NaN, 300] },
      },
    };
    const inventory = listChannels(config, ragged);
    const channels = presetChannels(inventory, "node-pressure").channels;
    expect(channels).toHaveLength(2);
    const chart = aggregateChartSeries({ channels, current: ragged });
    expect(chart.included).toBe(2);
    expect(chart.skipped).toEqual([]);
    const axis = chart.axes[0];
    expect(axis.times).toEqual([0, 0.5, 1]); // first resolved channel's grid
    expect(axis.series[0].values).toEqual([101325, 101300, 101250]);
    // n2 resampled from [0,1] onto [0,0.5,1]: midpoint = mean of endpoints.
    expect(axis.series[1].values).toEqual([100, 200, 300]);
  });

  it("skips ragged/unresolved channels honestly and reports counts", () => {
    const ghost = transientChannels.find(
      (c) => c.channel.id === "n1" && c.channel.field === "pressure",
    )!;
    const ghostDescriptor: ChannelDescriptor = {
      ...ghost,
      channel: { entity: "node", id: "ghost", field: "pressure" },
      key: channelKey({ entity: "node", id: "ghost", field: "pressure" }),
      label: "ghost · Pressure",
    };
    const allNan: TransientResult = {
      ...transient,
      nodes: {
        ...transient.nodes,
        n2: { ...transient.nodes.n2, pressure: [NaN, NaN, NaN] },
      },
    };
    const inventory = listChannels(config, allNan);
    const channels = [
      ...presetChannels(inventory, "node-pressure").channels,
      ghostDescriptor,
    ];
    const chart = aggregateChartSeries({ channels, current: allNan });
    // n1 resolves; n2 is all-NaN → empty series; ghost is absent → unresolved.
    expect(chart.included).toBe(1);
    expect(chart.axes).toHaveLength(1);
    expect(chart.skipped).toHaveLength(2);
    const reasons = new Map(
      chart.skipped.map((s) => [s.descriptor.channel.id, s.reason]),
    );
    expect(reasons.get("n2")).toBe("empty-series");
    expect(reasons.get("ghost")).toBe("unresolved");
  });

  it("a steady current yields only non-series skips; a steady baseline adds no overlays", () => {
    const channels = presetChannels(steadyChannels, "node-pressure").channels;
    const chart = aggregateChartSeries({
      channels,
      current: steady,
      baseline: steady,
    });
    expect(chart.axes).toEqual([]);
    expect(chart.included).toBe(0);
    expect(chart.baselineOverlays).toBe(0);
    expect(chart.skipped.map((s) => s.reason)).toEqual([
      "non-series",
      "non-series",
    ]);

    // Transient current + steady baseline: primaries composed, no overlays.
    const tChannels = presetChannels(
      transientChannels,
      "node-pressure",
    ).channels;
    const mixed = aggregateChartSeries({
      channels: tChannels,
      current: transient,
      baseline: steady,
    });
    expect(mixed.included).toBe(2);
    expect(mixed.baselineOverlays).toBe(0);
  });

  it("handles empty/garbage input without throwing", () => {
    expect(aggregateChartSeries({ channels: [], current: transient })).toEqual({
      axes: [],
      included: 0,
      baselineOverlays: 0,
      skipped: [],
    });
    const garbage = aggregateChartSeries({
      channels: null as unknown as ChannelDescriptor[],
      current: null,
      baseline: 42 as unknown as SteadyResult,
    });
    expect(garbage.axes).toEqual([]);
    expect(garbage.included).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* aggregateRows: steady rows, deltas, non-finite                      */
/* ------------------------------------------------------------------ */

describe("aggregateRows", () => {
  it("derives finite rows in deterministic channel order", () => {
    const channels = presetChannels(steadyChannels, "node-pressure").channels;
    const rows = aggregateRows({ channels, current: steady });
    expect(rows.map((r) => `${r.descriptor.channel.id}:${r.value}`)).toEqual([
      "n1:101325",
      "n2:100000",
    ]);
    expect(
      rows.every((r) => r.baselineValue === undefined && r.delta === undefined),
    ).toBe(true);
  });

  it("adds baselineValue and delta = value − baselineValue when the baseline resolves", () => {
    const baseline: SteadyResult = {
      ...steady,
      nodes: {
        n1: { pressure: 100000, temperature: 300, density: 1000 },
        n2: { pressure: 100000, temperature: 299, density: 1001 }, // zero delta
      },
    };
    const channels = presetChannels(steadyChannels, "node-pressure").channels;
    const rows = aggregateRows({ channels, current: steady, baseline });
    expect(rows).toHaveLength(2);
    expect(rows[0].baselineValue).toBe(100000);
    expect(rows[0].delta).toBe(1325);
    expect(rows[1].delta).toBe(0);
  });

  it("omits baseline fields per-row when the baseline lacks that channel", () => {
    const baseline: SteadyResult = {
      ...steady,
      nodes: { n1: { pressure: 100000, temperature: 300, density: 1000 } },
    };
    const channels = presetChannels(steadyChannels, "node-pressure").channels;
    const rows = aggregateRows({ channels, current: steady, baseline });
    expect(rows[0].baselineValue).toBe(100000);
    expect(rows[1].baselineValue).toBeUndefined();
    expect(rows[1].delta).toBeUndefined();
  });

  it("is finite-only: non-finite scalars and unresolved channels are omitted", () => {
    const dirty: SteadyResult = {
      ...steady,
      nodes: {
        n1: { pressure: NaN, temperature: 300, density: 1000 },
        n2: { pressure: Infinity, temperature: 299, density: 1001 },
      },
    };
    const inventory = listChannels(config, dirty);
    const channels = [
      ...presetChannels(inventory, "node-pressure").channels,
      // a channel the result does not carry at all
      {
        ...inventory[0],
        channel: { entity: "node", id: "ghost", field: "pressure" } as const,
        key: channelKey({ entity: "node", id: "ghost", field: "pressure" }),
      },
    ];
    const rows = aggregateRows({ channels, current: dirty });
    expect(rows).toEqual([]);
  });

  it("yields no rows for a transient current (series are not scalars) and never throws", () => {
    const channels = presetChannels(transientChannels, "branch-mdot").channels;
    expect(aggregateRows({ channels, current: transient })).toEqual([]);
    expect(
      aggregateRows({
        channels: null as unknown as ChannelDescriptor[],
        current: null,
      }),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* displayChannelSet: preset vs custom pinned/primary                  */
/* ------------------------------------------------------------------ */

describe("displayChannelSet", () => {
  it("preset view = the capped preset channels", () => {
    const sel = displayChannelSet({
      view: { kind: "preset", preset: "node-density" },
      channels: transientChannels,
    });
    expect(sel.source).toBe("preset");
    expect(tripletKeys(sel.channels)).toEqual([
      "node:n1:density",
      "node:n2:density",
    ]);
    expect(sel.total).toBe(2);
    expect(sel.capped).toBe(false);
    expect(sel).toMatchObject(
      presetChannels(transientChannels, "node-density"),
    );
  });

  it("custom view = primary first, then pinned, deduped, stale keys dropped", () => {
    const keyOf = (entity: string, id: string, field: string) =>
      transientChannels.find(
        (c) =>
          c.channel.entity === entity &&
          c.channel.id === id &&
          c.channel.field === field,
      )!.key;
    const pN1 = keyOf("node", "n1", "pressure");
    const tN1 = keyOf("node", "n1", "temperature");
    const mB1 = keyOf("branch", "b1", "mdot");
    const sel = displayChannelSet({
      view: { kind: "custom" },
      channels: transientChannels,
      primaryKey: pN1,
      // pinned includes the primary (dedup), another channel, a stale key, junk
      pinned: [tN1, pN1, mB1, "ch1.stale-key", 42 as unknown as string],
    });
    expect(sel.source).toBe("custom");
    expect(sel.channels.map((c) => c.key)).toEqual([pN1, tN1, mB1]);
    expect(sel.total).toBe(3);
    expect(sel.capped).toBe(false);
  });

  it("custom view without primary uses pin order; empty custom yields an empty set", () => {
    const keys = transientChannels.slice(0, 3).map((c) => c.key);
    const sel = displayChannelSet({
      view: { kind: "custom" },
      channels: transientChannels,
      pinned: keys.reverse(),
    });
    expect(sel.channels.map((c) => c.key)).toEqual(keys);

    const empty = displayChannelSet({
      view: { kind: "custom" },
      channels: transientChannels,
      pinned: [],
    });
    expect(empty).toMatchObject({ channels: [], total: 0, capped: false });
  });

  it("honors the cap for custom sets and never throws on garbage", () => {
    const keys = transientChannels.map((c) => c.key);
    const sel = displayChannelSet({
      view: { kind: "custom" },
      channels: transientChannels,
      pinned: keys,
      cap: 5,
    });
    expect(sel.channels).toHaveLength(5);
    expect(sel.total).toBe(keys.length);
    expect(sel.capped).toBe(true);

    expect(() =>
      displayChannelSet({
        view: { kind: "custom" },
        channels: null as unknown as ChannelDescriptor[],
      }),
    ).not.toThrow();
  });
});
