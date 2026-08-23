/**
 * plotSeries.ts — a plot's channels turned into chart data.
 *
 * The load-bearing distinction: on a TIME axis a channel is a series (three
 * node pressures make three lines), on a SPATIAL axis a channel is a point
 * (three node pressures make one line across the network). Getting that
 * backwards is what makes a generic plotter useless for network results, so
 * most of these tests are about it.
 */
import { describe, it, expect } from "vitest";
import { buildPlotData, resampleOnto } from "../plotSeries";
import { listChannels, type ChannelDescriptor } from "../channels";
import { listFlowPaths } from "../flowPath";
import type { NetworkConfig, SteadyResult, TransientResult } from "../types";

const config = (): NetworkConfig =>
  ({
    meta: { name: "plot fixture", version: 2 },
    settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "in",
        type: "boundary",
        x: 0,
        y: 0,
        position: { x: 0 },
        pressure: 3e5,
        temperature: 300,
      },
      {
        id: "mid",
        type: "internal",
        x: 1,
        y: 0,
        position: { x: 2 },
        pressure: 2e5,
        temperature: 300,
      },
      {
        id: "out",
        type: "boundary",
        x: 2,
        y: 0,
        position: { x: 5 },
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "b1",
        from: "in",
        to: "mid",
        component: { type: "pipe", length: 2, diameter: 0.02, roughness: 1e-5 },
      },
      {
        id: "b2",
        from: "mid",
        to: "out",
        component: { type: "pipe", length: 3, diameter: 0.02, roughness: 1e-5 },
      },
    ],
  }) as unknown as NetworkConfig;

const steady = (): SteadyResult =>
  ({
    converged: true,
    iterations: 3,
    residual: 1e-10,
    nodes: {
      in: { pressure: 3e5, temperature: 300, density: 1000 },
      mid: { pressure: 2e5, temperature: 310, density: 1000 },
      out: { pressure: 1e5, temperature: 320, density: 1000 },
    },
    branches: {
      b1: { mdot: 0.5, velocity: 1, dP: 1e5, reynolds: 9000 },
      b2: { mdot: 0.5, velocity: 1, dP: 1e5, reynolds: 9000 },
    },
  }) as unknown as SteadyResult;

const transient = (): TransientResult =>
  ({
    converged: true,
    times: [0, 1, 2],
    nodes: {
      in: {
        pressure: [3e5, 2.9e5, 2.8e5],
        temperature: [300, 300, 300],
        density: [1000, 1000, 1000],
      },
      mid: {
        pressure: [2e5, 1.9e5, 1.8e5],
        temperature: [300, 300, 300],
        density: [1000, 1000, 1000],
      },
      out: {
        pressure: [1e5, 1e5, 1e5],
        temperature: [300, 300, 300],
        density: [1000, 1000, 1000],
      },
    },
    branches: { b1: { mdot: [0.5, 0.4, 0.3] }, b2: { mdot: [0.5, 0.4, 0.3] } },
  }) as unknown as TransientResult;

const pick = (
  channels: readonly ChannelDescriptor[],
  field: string,
  ids?: string[],
): ChannelDescriptor[] =>
  channels.filter(
    (c) =>
      c.channel.field === field &&
      (ids === undefined || ids.includes(c.channel.id)),
  );

const cfg = config();
const steadyChannels = listChannels(cfg, steady());
const transientChannels = listChannels(cfg, transient());
const path = () => listFlowPaths(cfg, steady())[0]!;

describe("time axis", () => {
  it("gives each channel its own series over the sample grid", () => {
    const data = buildPlotData({
      channels: pick(transientChannels, "pressure"),
      xAxis: "time",
      config: cfg,
      result: transient(),
    });
    expect(data.x).toEqual([0, 1, 2]);
    expect(data.xLabel).toBe("Time");
    expect(data.xQuantity).toBe("time");
    expect(data.axes).toHaveLength(1);
    // Three nodes, three lines — NOT one line across the network.
    expect(data.axes[0].series).toHaveLength(3);
    expect(data.axes[0].series[0].values).toEqual([3e5, 2.9e5, 2.8e5]);
  });

  it("splits quantities onto separate axes", () => {
    const data = buildPlotData({
      channels: [
        ...pick(transientChannels, "pressure", ["in"]),
        ...pick(transientChannels, "mdot"),
      ],
      xAxis: "time",
      config: cfg,
      result: transient(),
    });
    expect(data.axes.map((a) => a.quantity).sort()).toEqual([
      "massFlow",
      "pressure",
    ]);
  });

  it("reports channels with no time series instead of drawing zeros", () => {
    const data = buildPlotData({
      channels: pick(steadyChannels, "pressure"),
      xAxis: "time",
      config: cfg,
      result: steady(),
    });
    expect(data.axes).toEqual([]);
    expect(data.skipped).toHaveLength(3);
  });
});

describe("station axis", () => {
  it("collapses one field into ONE line across the network", () => {
    const data = buildPlotData({
      channels: pick(steadyChannels, "pressure"),
      xAxis: "station",
      config: cfg,
      result: steady(),
      path: path(),
    });
    expect(data.axes).toHaveLength(1);
    expect(data.axes[0].series).toHaveLength(1);
    // Three stations at 0 / 2 / 5 m, pressures descending along them.
    expect(data.x).toEqual([0, 2, 5]);
    expect(data.axes[0].series[0].values).toEqual([3e5, 2e5, 1e5]);
    expect(data.xLabel).toBe("Distance along path");
    expect(data.ordinal).toBe(false);
  });

  it("keeps two fields as two lines on their own axes", () => {
    const data = buildPlotData({
      channels: [
        ...pick(steadyChannels, "pressure"),
        ...pick(steadyChannels, "temperature"),
      ],
      xAxis: "station",
      config: cfg,
      result: steady(),
      path: path(),
    });
    expect(data.axes).toHaveLength(2);
    for (const axis of data.axes) expect(axis.series).toHaveLength(1);
  });

  it("draws per-component quantities as stairs", () => {
    const data = buildPlotData({
      channels: pick(steadyChannels, "mdot"),
      xAxis: "station",
      config: cfg,
      result: steady(),
      path: path(),
    });
    expect(data.axes[0].series[0].step).toBe(true);
    // A branch sits at its upstream station.
    expect(data.x).toEqual([0, 2]);
  });

  it("skips channels that are not on the chosen path", () => {
    const other = {
      ...steadyChannels[0]!,
      key: "ch1.elsewhere",
      channel: {
        entity: "node" as const,
        id: "ghost",
        field: "pressure" as const,
      },
    };
    const data = buildPlotData({
      channels: [...pick(steadyChannels, "pressure"), other],
      xAxis: "station",
      config: cfg,
      result: steady(),
      path: path(),
    });
    expect(data.skipped.map((d) => d.key)).toEqual(["ch1.elsewhere"]);
  });

  it("is empty without a path rather than inventing one", () => {
    const data = buildPlotData({
      channels: pick(steadyChannels, "pressure"),
      xAxis: "station",
      config: cfg,
      result: steady(),
      path: null,
    });
    expect(data.axes).toEqual([]);
    expect(data.skipped).toHaveLength(3);
  });
});

describe("position axis", () => {
  it("places each node at its physical coordinate", () => {
    const data = buildPlotData({
      channels: pick(steadyChannels, "pressure"),
      xAxis: "positionX",
      config: cfg,
      result: steady(),
    });
    expect(data.x).toEqual([0, 2, 5]);
    expect(data.xLabel).toBe("Position x");
    expect(data.xQuantity).toBe("length");
  });

  it("places a branch at the midpoint of its endpoints", () => {
    const data = buildPlotData({
      channels: pick(steadyChannels, "mdot", ["b1"]),
      xAxis: "positionX",
      config: cfg,
      result: steady(),
    });
    // b1 spans x = 0 to x = 2.
    expect(data.x).toEqual([1]);
  });

  it("skips elements with no position rather than placing them at zero", () => {
    const bare = config();
    for (const node of bare.nodes)
      delete (node as { position?: unknown }).position;
    const data = buildPlotData({
      channels: pick(listChannels(bare, steady()), "pressure"),
      xAxis: "positionX",
      config: bare,
      result: steady(),
    });
    expect(data.axes).toEqual([]);
    expect(data.skipped).toHaveLength(3);
  });
});

describe("index axis", () => {
  it("orders elements by their place in the model and says it is an index", () => {
    const data = buildPlotData({
      channels: pick(steadyChannels, "pressure"),
      xAxis: "index",
      config: cfg,
      result: steady(),
    });
    expect(data.x).toEqual([0, 1, 2]);
    expect(data.ordinal).toBe(true);
    expect(data.xQuantity).toBe("dimensionless");
    expect(data.xLabel).toBe("Element order");
  });

  it("works when the model carries no geometry at all", () => {
    const bare = config();
    for (const node of bare.nodes)
      delete (node as { position?: unknown }).position;
    const data = buildPlotData({
      channels: pick(listChannels(bare, steady()), "pressure"),
      xAxis: "index",
      config: bare,
      result: steady(),
    });
    expect(data.axes[0].series[0].values).toEqual([3e5, 2e5, 1e5]);
  });
});

describe("robustness", () => {
  it("is empty for no channels or no result", () => {
    expect(
      buildPlotData({
        channels: [],
        xAxis: "time",
        config: cfg,
        result: transient(),
      }).axes,
    ).toEqual([]);
    expect(
      buildPlotData({
        channels: pick(steadyChannels, "pressure"),
        xAxis: "index",
        config: cfg,
        result: null,
      }).axes,
    ).toEqual([]);
  });

  it("never throws on garbage", () => {
    expect(() =>
      buildPlotData({
        channels: [null as unknown as ChannelDescriptor],
        xAxis: "index",
        config: {} as NetworkConfig,
        result: steady(),
      }),
    ).not.toThrow();
  });
});

describe("resampleOnto", () => {
  it("passes an identical grid straight through", () => {
    const x = [0, 1, 2];
    expect(resampleOnto(x, x, [10, 20, 30])).toEqual([10, 20, 30]);
    // Same numbers, different array identity: still a pass-through.
    expect(resampleOnto([0, 1, 2], [0, 1, 2], [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("interpolates a coarser run onto a finer grid", () => {
    // The whole point: a run sampled every 2 s still reads correctly against
    // one sampled every 1 s, instead of sliding along the axis by index.
    expect(resampleOnto([0, 1, 2, 3, 4], [0, 2, 4], [0, 20, 40])).toEqual([
      0, 10, 20, 30, 40,
    ]);
  });

  it("holds the previous value for a stepped (per-span) quantity", () => {
    // Holds, but still does not run past the last sample: 3 s is beyond
    // this run, and a held value there would be an invention.
    const out = resampleOnto([0, 1, 2, 3], [0, 2], [5, 9], true);
    expect(out.slice(0, 3)).toEqual([5, 5, 9]);
    expect(out[3]).toBeNaN();
  });

  it("refuses to extrapolate beyond what the run actually covers", () => {
    // A run that stopped at 3 s has nothing to say about 5 s.
    const out = resampleOnto([0, 2, 4, 6], [1, 3], [10, 30]);
    expect(out[0]).toBeNaN();
    expect(out[1]).toBe(20);
    expect(out[2]).toBeNaN();
    expect(out[3]).toBeNaN();
  });

  it("yields all-NaN for an empty or unusable source", () => {
    expect(resampleOnto([0, 1], [], [])).toEqual([Number.NaN, Number.NaN]);
    expect(resampleOnto([0, 1], [0, 1], [])).toEqual([Number.NaN, Number.NaN]);
  });

  it("does not invent a value where the source has a gap", () => {
    const out = resampleOnto([0, 1, 2], [0, 1, 2], [1, Number.NaN, 3]);
    expect(out[0]).toBe(1);
    expect(out[1]).toBeNaN();
    expect(out[2]).toBe(3);
  });

  it("survives a repeated x (zero-width span) without dividing by zero", () => {
    // Deterministic: the later of two samples at the same coordinate wins.
    expect(resampleOnto([0, 1], [1, 1], [4, 8])).toEqual([Number.NaN, 8]);
  });
});
