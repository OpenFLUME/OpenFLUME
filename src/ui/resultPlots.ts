/**
 * resultPlots.ts — the plot model of the Runs tab.
 *
 * A plot is deliberately dumb: an x axis and a list of channels. That is the
 * whole model. Earlier versions offered named views (profile, breakdown,
 * trend, distribution), which sounds helpful and is not: each one decides for
 * the analyst which question they came to ask, and none of them is the
 * question often enough. Choosing an axis and some channels asks nothing.
 *
 * The named views survive as axis choices — plotting against `station` IS the
 * profile — so nothing is lost except the presumption.
 *
 * Pure and defensive: no React, no store. Every function returns new objects so
 * the caller can hand results straight to a setState.
 */
import type { ChannelDescriptor } from "./channels";

/**
 * What runs along the bottom of the plot.
 *
 *   - `time`      — the sample axis of a transient result.
 *   - `station`   — distance (or index) along a chosen flow path.
 *   - `positionX/Y/Z` — the element's physical coordinate in metres.
 *   - `index`     — element order, the fallback that always exists.
 *
 * Every axis except `time` is SPATIAL: one point per element rather than one
 * series per element, so a set of node pressures becomes a line across the
 * network instead of a set of flat lines.
 */
export type PlotXAxis =
  "time" | "station" | "positionX" | "positionY" | "positionZ" | "index";

export interface XAxisOption {
  id: PlotXAxis;
  label: string;
  /** Shown next to the option so the choice explains itself. */
  hint: string;
}

export const X_AXES: XAxisOption[] = [
  { id: "time", label: "Time", hint: "The transient sample axis" },
  {
    id: "station",
    label: "Station along path",
    hint: "Distance through the network along a flow path",
  },
  { id: "positionX", label: "Position X", hint: "Physical x coordinate (m)" },
  { id: "positionY", label: "Position Y", hint: "Physical y coordinate (m)" },
  { id: "positionZ", label: "Position Z", hint: "Physical z coordinate (m)" },
  { id: "index", label: "Element order", hint: "Order in the model" },
];

/** True when the axis puts one point per element rather than a time series. */
export function isSpatialAxis(axis: PlotXAxis): boolean {
  return axis !== "time";
}

export interface ResultPlot {
  id: string;
  /** Tab label. Auto-derived from the contents until the user renames it. */
  name: string;
  /** True once renamed, so auto-naming stops fighting the user. */
  renamed?: boolean;
  xAxis: PlotXAxis;
  /** Channel keys, in the order they were added. */
  channels: string[];
  /** Flow path id when `xAxis === "station"`; null means "the best one". */
  pathId: string | null;
  /**
   * Run record ids overlaid on top of the displayed run, in the order added.
   *
   * The question a design study actually asks is "which one was better?", and
   * that cannot be answered by flipping between two runs a second apart. The
   * same channels are resolved against each of these runs and drawn on the
   * same axes.
   */
  compareRunIds: string[];
}

/**
 * More channels than this in one plot stops being a plot and starts being
 * wallpaper; the extra are kept but not drawn, and the UI says so.
 */
export const PLOT_CHANNEL_CAP = 40;

let seq = 0;

/** Monotonic, collision-free within a session; ids are never user-visible. */
function nextPlotId(): string {
  seq += 1;
  return `plot-${Date.now().toString(36)}-${seq}`;
}

/** Axes that make sense for a result of this mode. */
export function xAxesFor(mode: "steady" | "transient"): XAxisOption[] {
  return mode === "transient" ? X_AXES : X_AXES.filter((a) => a.id !== "time");
}

export function isXAxisAvailable(
  axis: PlotXAxis,
  mode: "steady" | "transient",
): boolean {
  return xAxesFor(mode).some((a) => a.id === axis);
}

/**
 * A name from what the plot draws: the quantity when its channels share one,
 * else the axis. Beats "Plot 3" when picking a tab out of five, and costs the
 * user nothing because it stops the moment they type their own.
 */
export function derivePlotName(
  plot: Pick<ResultPlot, "xAxis">,
  channels: readonly ChannelDescriptor[],
): string {
  const axis = X_AXES.find((a) => a.id === plot.xAxis)?.label ?? "Plot";
  if (channels.length === 0) return "New plot";
  const fields = new Set(channels.map((c) => c.channel.field));
  if (fields.size === 1) {
    const label = channels[0]!.label.split(" · ").pop();
    if (label) return `${label} vs ${axis.toLowerCase()}`;
  }
  return `${channels.length} channels vs ${axis.toLowerCase()}`;
}

/**
 * A new plot: EMPTY, on the mode's natural axis.
 *
 * Nothing is pre-selected on purpose. Seeding it with node pressures assumes
 * the analyst came to look at pressure, and the whole point of a plot the user
 * composes is that we do not know what they came for.
 */
export function newPlot(mode: "steady" | "transient"): ResultPlot {
  return {
    id: nextPlotId(),
    name: "New plot",
    xAxis: mode === "transient" ? "time" : "station",
    channels: [],
    pathId: null,
    compareRunIds: [],
  };
}

/**
 * More than this many runs on one plot and the overlays are indistinguishable
 * from each other; the rest are kept in the plot but not drawn.
 */
export const PLOT_COMPARE_CAP = 4;

/** The compared runs, tolerating plots stored before the field existed. */
export function compareRunIds(plot: ResultPlot): string[] {
  return plot.compareRunIds ?? [];
}

/** Overlay this run, or stop overlaying it. Order is the order added. */
export function toggleCompareRun(plot: ResultPlot, runId: string): ResultPlot {
  const current = compareRunIds(plot);
  return {
    ...plot,
    compareRunIds: current.includes(runId)
      ? current.filter((id) => id !== runId)
      : [...current, runId],
  };
}

/** Add or remove one channel, preserving insertion order. */
export function togglePlotChannel(plot: ResultPlot, key: string): ResultPlot {
  const channels = plot.channels.includes(key)
    ? plot.channels.filter((k) => k !== key)
    : [...plot.channels, key];
  return { ...plot, channels };
}

/** Add several channels at once (a preset), skipping ones already present. */
export function addPlotChannels(
  plot: ResultPlot,
  keys: readonly string[],
): ResultPlot {
  const present = new Set(plot.channels);
  const added = keys.filter((k) => !present.has(k));
  return added.length === 0
    ? plot
    : { ...plot, channels: [...plot.channels, ...added] };
}

/** Replace the channel set outright. */
export function setPlotChannels(
  plot: ResultPlot,
  keys: readonly string[],
): ResultPlot {
  return { ...plot, channels: [...new Set(keys)] };
}

/**
 * The plot's channels resolved against an inventory, in the plot's order.
 *
 * Keys the current result does not carry are dropped rather than rendered as
 * gaps: a plot outlives the run it was made for, and switching to a run
 * without conductors should not litter it with dead rows.
 */
export function plotChannels(
  plot: ResultPlot,
  channels: readonly ChannelDescriptor[],
): ChannelDescriptor[] {
  const byKey = new Map(channels.map((c) => [c.key, c]));
  const out: ChannelDescriptor[] = [];
  for (const key of plot.channels) {
    const found = byKey.get(key);
    if (found) out.push(found);
  }
  return out;
}

/**
 * Keep a plot usable against a result of `mode`: a time axis cannot draw a
 * steady result, so it falls back to the spatial default rather than rendering
 * an empty chart.
 */
export function coercePlotAxis(
  plot: ResultPlot,
  mode: "steady" | "transient",
): ResultPlot {
  if (isXAxisAvailable(plot.xAxis, mode)) return plot;
  return { ...plot, xAxis: "station" };
}
