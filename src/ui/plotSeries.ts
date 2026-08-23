/**
 * plotSeries.ts — turn a plot (an x axis plus some channels) into chart data.
 *
 * Two shapes, decided by the axis:
 *
 *   - TIME: a channel is a series. Three node pressures make three lines, each
 *     tracing one element through the run.
 *   - SPATIAL (station / position / index): a channel is a POINT. Three node
 *     pressures make one line across the network, because the thing varying
 *     along the axis is the element, not the sample. Series are therefore
 *     grouped by field: pressure is one line, temperature another.
 *
 * Getting that distinction wrong is what makes naive plotting tools useless
 * for network results — three flat one-point lines instead of a grade line.
 *
 * Series sharing a quantity share an axis; different quantities get their own,
 * because pressure in Pa and quality in [0,1] on one scale is a flat line and
 * a spike. Pure: reads only the captured config/result it is handed.
 */
import { physicalPosition } from "../core";
import type { NetworkConfig, SteadyResult, TransientResult } from "./types";
import type { QuantityKind } from "./units";
import {
  channelFieldInfo,
  resolveChannel,
  resolveChannelAt,
  type ChannelDescriptor,
} from "./channels";
import { isSpatialAxis, type PlotXAxis } from "./resultPlots";
import type { FlowPath } from "./flowPath";

export interface PlotSeries {
  id: string;
  label: string;
  /** Aligned to the shared `x` array; non-finite where this series has no point. */
  values: number[];
  /** Stairs rather than a line: a per-span quantity has no gradient. */
  step?: boolean;
}

export interface PlotAxisGroup {
  quantity: QuantityKind;
  rawUnit?: string;
  series: PlotSeries[];
}

export interface PlotData {
  /** Shared x coordinates, ascending. */
  x: number[];
  xLabel: string;
  xQuantity: QuantityKind;
  /** One entry per y axis (quantity + rawUnit). */
  axes: PlotAxisGroup[];
  /** Channels that carry no coordinate on this axis, for an honest message. */
  skipped: ChannelDescriptor[];
  /** True when a spatial axis fell back to an index because no distance existed. */
  ordinal: boolean;
}

const EMPTY: PlotData = {
  x: [],
  xLabel: "",
  xQuantity: "dimensionless",
  axes: [],
  skipped: [],
  ordinal: false,
};

function axisKey(quantity: QuantityKind, rawUnit?: string): string {
  return `${quantity}|${rawUnit ?? ""}`;
}

/**
 * The element's coordinate on a spatial axis, or undefined when it has none
 * (a node off the chosen path, an element with no physical position). An
 * element without a coordinate is dropped and reported, never placed at zero.
 */
function coordinateOf(
  descriptor: ChannelDescriptor,
  axis: PlotXAxis,
  config: NetworkConfig,
  path: FlowPath | null,
  order: Map<string, number>,
): number | undefined {
  const { entity, id } = descriptor.channel;

  if (axis === "index") return order.get(`${entity}:${id}`);

  if (axis === "station") {
    if (!path) return undefined;
    const station = path.stations.find((s) => s.nodeId === id);
    if (station) return station.station;
    // A branch sits between two stations; place it at its upstream end so a
    // per-component value starts where the component does.
    const segment = path.segments.find((s) => s.branchId === id);
    return segment?.fromStation;
  }

  const key = axis === "positionX" ? "x" : axis === "positionY" ? "y" : "z";
  const nodePos = (nodeId: string): number | undefined => {
    const node =
      config.nodes?.find((n) => n.id === nodeId) ??
      config.solidNodes?.find((n) => n.id === nodeId);
    const pos = physicalPosition(node);
    const value = pos?.[key];
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  };

  if (entity === "node" || entity === "solidNode") return nodePos(id);

  // An edge spans two nodes: its midpoint is the honest single coordinate.
  const edge =
    entity === "branch"
      ? config.branches?.find((b) => b.id === id)
      : config.conductors?.find((c) => c.id === id);
  if (!edge) return undefined;
  const a = nodePos(edge.from);
  const b = nodePos(edge.to);
  if (a === undefined || b === undefined) return undefined;
  return (a + b) / 2;
}

/** Config order of every element, for the `index` axis. */
function elementOrder(config: NetworkConfig): Map<string, number> {
  const order = new Map<string, number>();
  let i = 0;
  for (const n of config.nodes ?? []) order.set(`node:${n.id}`, i++);
  for (const s of config.solidNodes ?? []) order.set(`solidNode:${s.id}`, i++);
  for (const b of config.branches ?? []) order.set(`branch:${b.id}`, i++);
  for (const c of config.conductors ?? []) order.set(`conductor:${c.id}`, i++);
  return order;
}

export interface BuildPlotDataArgs {
  channels: readonly ChannelDescriptor[];
  xAxis: PlotXAxis;
  config: NetworkConfig;
  result: SteadyResult | TransientResult | null | undefined;
  /** Resolved flow path, required only for the `station` axis. */
  path?: FlowPath | null;
  /** Sample index for spatial axes over a transient result. */
  timeIndex?: number | null;
}

/**
 * Chart data for one plot. Never throws; an unusable combination yields empty
 * data with the offending channels listed in `skipped`.
 */
export function buildPlotData(args: BuildPlotDataArgs): PlotData {
  try {
    const { channels, xAxis, result } = args;
    if (channels.length === 0 || !result) return EMPTY;
    return isSpatialAxis(xAxis)
      ? spatialData(args)
      : timeData(channels, result);
  } catch {
    return EMPTY;
  }
}

/** One series per channel, over the result's own sample grid. */
function timeData(
  channels: readonly ChannelDescriptor[],
  result: SteadyResult | TransientResult,
): PlotData {
  const axes = new Map<string, PlotAxisGroup>();
  const skipped: ChannelDescriptor[] = [];
  // Channels of one run share sample instants, so the first resolved grid is
  // the shared axis; a channel on a different grid is reported, not stretched.
  let x: number[] = [];

  for (const d of channels) {
    const data = resolveChannel(result, d.channel);
    if (!data || data.kind !== "series" || data.times.length === 0) {
      skipped.push(d);
      continue;
    }
    if (x.length === 0) x = data.times;
    const key = axisKey(d.quantity, d.rawUnit);
    const group = axes.get(key) ?? {
      quantity: d.quantity,
      ...(d.rawUnit !== undefined ? { rawUnit: d.rawUnit } : {}),
      series: [],
    };
    // Align onto the shared grid by index; a shorter series simply stops.
    const values = x.map((_, i) =>
      i < data.values.length ? data.values[i]! : Number.NaN,
    );
    group.series.push({ id: d.key, label: d.label, values });
    axes.set(key, group);
  }

  return {
    x,
    xLabel: "Time",
    xQuantity: "time",
    axes: [...axes.values()],
    skipped,
    ordinal: false,
  };
}

/** One point per channel, grouped into a line per field. */
function spatialData(args: BuildPlotDataArgs): PlotData {
  const { channels, xAxis, config, result, path = null } = args;
  const timeIndex = args.timeIndex ?? null;
  const order = elementOrder(config);
  const skipped: ChannelDescriptor[] = [];

  interface Point {
    x: number;
    y: number;
  }
  const byField = new Map<
    string,
    {
      descriptor: ChannelDescriptor;
      points: Point[];
    }
  >();

  for (const d of channels) {
    const x = coordinateOf(d, xAxis, config, path, order);
    const y = resolveChannelAt(result, d.channel, timeIndex);
    if (x === undefined || y === null) {
      skipped.push(d);
      continue;
    }
    const group = byField.get(d.channel.field) ?? { descriptor: d, points: [] };
    group.points.push({ x, y });
    byField.set(d.channel.field, group);
  }

  const xs = new Set<number>();
  for (const group of byField.values())
    for (const p of group.points) xs.add(p.x);
  const x = [...xs].sort((a, b) => a - b);

  const axes = new Map<string, PlotAxisGroup>();
  for (const [field, group] of byField) {
    const info = channelFieldInfo(field);
    const quantity = info?.quantity ?? group.descriptor.quantity;
    const rawUnit = info?.rawUnit ?? group.descriptor.rawUnit;
    const byX = new Map(group.points.map((p) => [p.x, p.y]));
    const values = x.map((coord) => byX.get(coord) ?? Number.NaN);
    const key = axisKey(quantity, rawUnit);
    const axis = axes.get(key) ?? {
      quantity,
      ...(rawUnit !== undefined ? { rawUnit } : {}),
      series: [],
    };
    axis.series.push({
      id: field,
      label: info?.label ?? field,
      values,
      // Branch and conductor values belong to the span between stations, so
      // they hold their value to the next point rather than sloping to it.
      step:
        group.descriptor.channel.entity === "branch" ||
        group.descriptor.channel.entity === "conductor",
    });
    axes.set(key, axis);
  }

  const ordinal =
    xAxis === "index" || (xAxis === "station" && path?.axis === "ordinal");

  return {
    x,
    xLabel: xAxisLabel(xAxis, ordinal),
    xQuantity: ordinal ? "dimensionless" : "length",
    axes: [...axes.values()],
    skipped,
    ordinal,
  };
}

/**
 * An overlay's values, re-expressed on another plot's x grid.
 *
 * Two runs almost never share a sample grid — a different timestep, a longer
 * pipe moving every station — and a chart draws all its series against ONE x
 * array. Reading the overlay off by index would silently slide it along the
 * axis, which is exactly the error a comparison plot exists to prevent. So
 * interpolate: linearly between the source points, or holding the previous
 * value for a per-span quantity that has no gradient to interpolate along.
 *
 * Beyond the source's range the answer is NaN, not an extrapolation: a run
 * that stopped at 3 s has nothing to say about 5 s.
 */
export function resampleOnto(
  targetX: readonly number[],
  sourceX: readonly number[],
  values: readonly number[],
  step = false,
): number[] {
  const n = Math.min(sourceX.length, values.length);
  if (n === 0) return targetX.map(() => Number.NaN);
  if (
    targetX.length === n &&
    targetX.every((x, i) => Object.is(x, sourceX[i]))
  ) {
    return values.slice(0, n);
  }

  return targetX.map((x) => {
    if (!Number.isFinite(x)) return Number.NaN;
    if (x < sourceX[0]! || x > sourceX[n - 1]!) return Number.NaN;
    // Rightmost source point at or before x.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (sourceX[mid]! <= x) lo = mid;
      else hi = mid - 1;
    }
    const y0 = values[lo];
    if (typeof y0 !== "number" || !Number.isFinite(y0)) return Number.NaN;
    if (step || lo === n - 1 || sourceX[lo] === x) return y0;
    const y1 = values[lo + 1];
    if (typeof y1 !== "number" || !Number.isFinite(y1)) return y0;
    const span = sourceX[lo + 1]! - sourceX[lo]!;
    if (span === 0) return y0;
    return y0 + ((x - sourceX[lo]!) / span) * (y1 - y0);
  });
}

function xAxisLabel(axis: PlotXAxis, ordinal: boolean): string {
  switch (axis) {
    case "station":
      return ordinal ? "Station" : "Distance along path";
    case "positionX":
      return "Position x";
    case "positionY":
      return "Position y";
    case "positionZ":
      return "Position z";
    case "index":
      return "Element order";
    default:
      return "Time";
  }
}
