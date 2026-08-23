/**
 * resultPlots.ts — the plot model behind the Results tab's tabs.
 *
 * A plot is an x axis plus a list of channels — nothing else. These tests pin
 * what the UI leans on: an empty plot on the mode's natural axis, names that
 * describe what is drawn, channel sets that survive a switch to a different
 * run, and an axis that cannot end up impossible for the result on screen.
 */
import { describe, it, expect } from "vitest";
import {
  addPlotChannels,
  coercePlotAxis,
  compareRunIds,
  toggleCompareRun,
  derivePlotName,
  isSpatialAxis,
  isXAxisAvailable,
  newPlot,
  plotChannels,
  setPlotChannels,
  togglePlotChannel,
  xAxesFor,
  type ResultPlot,
} from "../resultPlots";
import { listChannels } from "../channels";
import type { NetworkConfig, SteadyResult } from "../types";

const config = (): NetworkConfig =>
  ({
    meta: { name: "plots", version: 2 },
    settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
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
        id: "b1",
        from: "a",
        to: "b",
        component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
      },
    ],
  }) as unknown as NetworkConfig;

const steady = (): SteadyResult =>
  ({
    converged: true,
    iterations: 2,
    residual: 1e-9,
    nodes: {
      a: { pressure: 2e5, temperature: 300, density: 1000 },
      b: { pressure: 1e5, temperature: 300, density: 1000 },
    },
    branches: { b1: { mdot: 1, velocity: 1, dP: 1e5, reynolds: 9000 } },
  }) as unknown as SteadyResult;

const steadyInventory = () => listChannels(config(), steady());

describe("x axes", () => {
  it("offers Time only for a transient result", () => {
    expect(xAxesFor("transient").map((a) => a.id)).toContain("time");
    expect(xAxesFor("steady").map((a) => a.id)).not.toContain("time");
    expect(isXAxisAvailable("time", "steady")).toBe(false);
    expect(isXAxisAvailable("station", "steady")).toBe(true);
  });

  it("treats everything except time as spatial", () => {
    expect(isSpatialAxis("time")).toBe(false);
    for (const axis of [
      "station",
      "positionX",
      "positionY",
      "positionZ",
      "index",
    ] as const)
      expect(isSpatialAxis(axis)).toBe(true);
  });

  it("always offers an axis that needs no geometry", () => {
    // `index` is the fallback: a model with no lengths and no positions can
    // still be plotted against element order.
    expect(xAxesFor("steady").map((a) => a.id)).toContain("index");
  });
});

describe("newPlot", () => {
  it("starts EMPTY: we do not know what the analyst came to look at", () => {
    expect(newPlot("steady").channels).toEqual([]);
    expect(newPlot("transient").channels).toEqual([]);
  });

  it("opens on the mode's natural axis", () => {
    expect(newPlot("transient").xAxis).toBe("time");
    expect(newPlot("steady").xAxis).toBe("station");
  });

  it("gives every plot a distinct id", () => {
    expect(newPlot("steady").id).not.toBe(newPlot("steady").id);
  });
});

describe("derivePlotName", () => {
  it("names the quantity and axis when the channels share a field", () => {
    const pressures = steadyInventory().filter(
      (c) => c.channel.field === "pressure",
    );
    expect(derivePlotName({ xAxis: "station" }, pressures)).toBe(
      "Pressure vs station along path",
    );
    expect(derivePlotName({ xAxis: "time" }, pressures)).toBe(
      "Pressure vs time",
    );
  });

  it("counts a mixed set rather than picking a winner", () => {
    expect(derivePlotName({ xAxis: "time" }, steadyInventory())).toMatch(
      /^\d+ channels vs time$/,
    );
  });

  it("calls an empty plot what it is", () => {
    expect(derivePlotName({ xAxis: "time" }, [])).toBe("New plot");
  });
});

describe("channel editing", () => {
  const base = (): ResultPlot => newPlot("transient");

  it("adds in click order", () => {
    let plot = base();
    plot = togglePlotChannel(plot, "k2");
    plot = togglePlotChannel(plot, "k1");
    expect(plot.channels).toEqual(["k2", "k1"]);
  });

  it("toggles a channel off again", () => {
    let plot = addPlotChannels(base(), ["k1", "k2"]);
    plot = togglePlotChannel(plot, "k1");
    expect(plot.channels).toEqual(["k2"]);
  });

  it("adding a preset skips channels already present", () => {
    const plot = addPlotChannels(base(), ["k1", "k2"]);
    expect(addPlotChannels(plot, ["k2", "k3"]).channels).toEqual([
      "k1",
      "k2",
      "k3",
    ]);
  });

  it("returns the same object when an add changes nothing", () => {
    const plot = addPlotChannels(base(), ["k1"]);
    expect(addPlotChannels(plot, ["k1"])).toBe(plot);
  });

  it("replacing the set de-duplicates", () => {
    expect(setPlotChannels(base(), ["k1", "k1", "k2"]).channels).toEqual([
      "k1",
      "k2",
    ]);
  });

  it("never mutates the input plot", () => {
    const plot = base();
    togglePlotChannel(plot, "k1");
    addPlotChannels(plot, ["k2"]);
    expect(plot.channels).toEqual([]);
  });
});

describe("plotChannels", () => {
  it("resolves in the plot's order, not the inventory's", () => {
    const inventory = steadyInventory();
    const [first, second] = inventory;
    const plot = addPlotChannels(newPlot("steady"), [second!.key, first!.key]);
    expect(plotChannels(plot, inventory).map((c) => c.key)).toEqual([
      second!.key,
      first!.key,
    ]);
  });

  it("drops keys the displayed result does not carry", () => {
    // A plot outlives the run it was made for: switching to a run without
    // these channels must not litter it with dead rows.
    const plot = addPlotChannels(newPlot("steady"), [
      steadyInventory()[0]!.key,
      "ch1.gone",
    ]);
    expect(plotChannels(plot, steadyInventory())).toHaveLength(1);
    expect(plotChannels(plot, [])).toEqual([]);
  });
});

describe("coercePlotAxis", () => {
  it("leaves a usable axis alone, object identity included", () => {
    const plot = newPlot("steady");
    expect(coercePlotAxis(plot, "steady")).toBe(plot);
    expect(coercePlotAxis(plot, "transient")).toBe(plot);
  });

  it("rescues a time-axis plot shown against a steady result", () => {
    expect(coercePlotAxis(newPlot("transient"), "steady").xAxis).toBe(
      "station",
    );
  });
});

describe("comparing runs on one plot", () => {
  it("starts with no overlay: a plot reads one run until asked otherwise", () => {
    expect(newPlot("steady").compareRunIds).toEqual([]);
    expect(compareRunIds(newPlot("transient"))).toEqual([]);
  });

  it("tolerates a plot stored before the field existed", () => {
    const legacy = { ...newPlot("steady") } as ResultPlot;
    delete (legacy as Partial<ResultPlot>).compareRunIds;
    expect(compareRunIds(legacy)).toEqual([]);
    expect(toggleCompareRun(legacy, "r1").compareRunIds).toEqual(["r1"]);
  });

  it("adds in the order asked and removes on a second toggle", () => {
    const plot = toggleCompareRun(
      toggleCompareRun(newPlot("steady"), "r2"),
      "r1",
    );
    expect(plot.compareRunIds).toEqual(["r2", "r1"]);
    expect(toggleCompareRun(plot, "r2").compareRunIds).toEqual(["r1"]);
    expect(toggleCompareRun(plot, "nope").compareRunIds).toEqual([
      "r2",
      "r1",
      "nope",
    ]);
  });

  it("leaves the rest of the plot untouched", () => {
    const base = addPlotChannels(newPlot("steady"), [
      steadyInventory()[0]!.key,
    ]);
    const next = toggleCompareRun(base, "r1");
    expect(next.channels).toEqual(base.channels);
    expect(next.xAxis).toBe(base.xAxis);
    expect(base.compareRunIds).toEqual([]);
  });
});
