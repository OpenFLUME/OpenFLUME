/**
 * Aggregate channel-view policy — pure, headless rules for the preset /
 * custom "channel views" of a result (Stage: policy core; no React, no store).
 *
 * A ChannelView is either one of the FIXED presets below (a named, unit-aware
 * group of channels over the whole network — e.g. "all node pressures") or
 * the user's custom set (pinned channels plus the focused primary, as managed
 * by channelExplorer.ts).  This module is the single source of truth for:
 *
 *   - CHANNEL_VIEW_PRESETS / channelViewPreset — the fixed preset registry in
 *     canonical UI order.  Presets only ever group channels that are
 *     unit-comparable: every single-axis preset is quantity+rawUnit homogeneous,
 *     and the dimensionless fraction group (quality / fluidFront / fWet)
 *     defensively excludes rawUnit channels, so specific enthalpy ('dimensionless'
 *     but rawUnit 'J/kg') can NEVER share a fractions axis.  The two
 *     deliberately mixed presets (steady branch velocity/dP/reynolds;
 *     transient node gasVolume/enthalpy) are consumed as rows / multi-axis
 *     charts, never as one shared axis.
 *   - presetsForInventory(channels, mode) — the registry filtered to presets
 *     that apply to the result mode AND match ≥1 inventory channel (empty /
 *     inapplicable presets are excluded), in registry order.
 *   - defaultPreset — the deterministic default view: node pressure, else
 *     node+solid temperature, else the first available preset.
 *   - presetChannels — the preset's channels in deterministic inventory
 *     (config) order, capped at AGGREGATE_SERIES_CAP, reporting total/capped.
 *   - displayChannelSet — the current display/export channel set of a view:
 *     the capped preset channels for a preset view; the primary + pinned set
 *     (deduped, stale keys dropped) for the custom view.
 *   - aggregateChartSeries — transient aggregate chart composition: every
 *     resolved channel becomes a primary series (stable seriesColor, shared
 *     per-axis time grid reconciled with sameTimeGrid/resampleSeries) plus
 *     dashed, lower-opacity, color-locked baseline overlays — the
 *     ResultsPanel/ChannelExplorer conventions.  Channels that resolve to
 *     nothing usable (absent, scalar in a steady result, or an empty/ragged
 *     series) are skipped and REPORTED with a reason.  Channels are grouped
 *     into axes by (quantity, rawUnit) so unit/rawUnit safety is guaranteed
 *     for ANY preset, including the mixed ones.
 *   - aggregateRows — steady aggregate table rows {descriptor, value,
 *     baselineValue?, delta?}, finite-only, in deterministic input order.
 */

import type { SteadyResult, TransientResult } from "./types";
import type { QuantityKind } from "./units";
import {
  filterChannels,
  resolveChannel,
  type ChannelDescriptor,
  type ChannelFilter,
} from "./channels";
import { resampleSeries, sameTimeGrid } from "./runHistory";
import { seriesColor } from "./components/chartMath";

/* ------------------------------------------------------------------ */
/* View identity + preset registry                                     */
/* ------------------------------------------------------------------ */

export type ChannelViewMode = "steady" | "transient";

/** Strongly typed id of a fixed aggregate preset. */
export type ChannelViewPresetId =
  | "node-pressure"
  | "node-solid-temperature"
  | "branch-mdot"
  | "conductor-heat-rate"
  | "node-density"
  | "branch-flow"
  | "branch-compressible"
  | "node-energy"
  | "node-transport"
  | "conductor-heat-flux"
  | "conductor-heat-transfer-coeff"
  | "node-gas-volume"
  | "dimensionless-fractions";

export interface ChannelViewPreset {
  id: ChannelViewPresetId;
  /** Short UI label of the view. */
  label: string;
  /** Result mode(s) the preset applies to. */
  mode: ChannelViewMode | "both";
  /** Inventory filter (AND-combined criteria, OR within each). */
  match: ChannelFilter;
  /**
   * True when every matched channel is guaranteed to share ONE unit axis
   * (identical quantity AND rawUnit).  False for the deliberately mixed
   * presets (steady branch flow; transient gas/enthalpy) which are consumed
   * as rows / multi-axis charts.
   */
  singleAxis: boolean;
  /**
   * Defensive unit-safety guard: drop matched channels carrying a rawUnit.
   * Set on the dimensionless fraction group so a rawUnit-'J/kg' enthalpy
   * channel can never slip into a fractions axis even if field metadata
   * changes.
   */
  excludeRawUnit?: boolean;
}

/**
 * The fixed preset registry, in canonical UI order.  Declaration order is
 * the order presets are offered by presetsForInventory.
 */
export const CHANNEL_VIEW_PRESETS: readonly ChannelViewPreset[] = [
  {
    id: "node-pressure",
    label: "Node pressure",
    mode: "both",
    match: { entity: "node", field: "pressure" },
    singleAxis: true,
  },
  {
    id: "node-solid-temperature",
    label: "Node & solid temperature",
    mode: "both",
    match: { entity: ["node", "solidNode"], field: "temperature" },
    singleAxis: true,
  },
  {
    id: "branch-mdot",
    label: "Branch mass flow",
    mode: "both",
    match: { entity: "branch", field: "mdot" },
    singleAxis: true,
  },
  {
    id: "conductor-heat-rate",
    label: "Conductor heat rate",
    mode: "both",
    match: { entity: "conductor", field: "heatRate" },
    singleAxis: true,
  },
  {
    id: "node-density",
    label: "Node density",
    mode: "both",
    match: { entity: "node", field: "density" },
    singleAxis: true,
  },
  {
    id: "branch-flow",
    label: "Branch velocity / ΔP / Reynolds",
    mode: "both",
    match: { entity: "branch", field: ["velocity", "dP", "reynolds"] },
    // velocity / pressure / dimensionless: rows or a multi-axis chart,
    // never one shared axis.
    singleAxis: false,
  },
  {
    id: "branch-compressible",
    label: "Branch Mach / mass flux / dynamic pressure",
    mode: "both",
    match: { entity: "branch", field: ["mach", "massFlux", "dynamicPressure"] },
    // dimensionless / mass flux / pressure: multi-axis.
    singleAxis: false,
  },
  {
    id: "node-energy",
    label: "Node enthalpy & internal energy",
    mode: "both",
    // Both are specificEnergy, so they share one J/kg axis.
    match: { entity: "node", field: ["enthalpy", "internalEnergy"] },
    singleAxis: true,
  },
  {
    id: "node-transport",
    label: "Node transport & thermodynamic properties",
    mode: "both",
    match: {
      entity: "node",
      field: [
        "entropy",
        "specificHeat",
        "viscosity",
        "thermalConductivity",
        "speedOfSound",
      ],
    },
    // Five different quantity kinds: multi-axis chart / rows.
    singleAxis: false,
  },
  {
    id: "conductor-heat-flux",
    label: "Conductor heat flux",
    mode: "both",
    match: { entity: "conductor", field: "heatFlux" },
    singleAxis: true,
  },
  {
    id: "conductor-heat-transfer-coeff",
    label: "Conductor heat transfer coefficient",
    mode: "both",
    // Optional field: absent conductors are simply not in the inventory.
    match: { entity: "conductor", field: "heatTransferCoeff" },
    singleAxis: true,
  },
  {
    id: "node-gas-volume",
    label: "Node gas volume",
    mode: "transient",
    match: { entity: "node", field: "gasVolume" },
    singleAxis: true,
  },
  {
    id: "dimensionless-fractions",
    label: "Quality / front / wetted fractions",
    // quality exists in both modes; fluidFront/fWet are transient-only, so
    // the group simply shrinks to whatever fraction channels exist.
    mode: "both",
    match: {
      field: ["quality", "fluidFront", "fWet"],
      quantity: "dimensionless",
    },
    singleAxis: true,
    // Fractions must never mix enthalpy: all three fields are plain
    // dimensionless, and this guard keeps it that way by construction.
    excludeRawUnit: true,
  },
];

/** Registry lookup by id; undefined for an unknown id. */
export function channelViewPreset(
  id: ChannelViewPresetId,
): ChannelViewPreset | undefined {
  return CHANNEL_VIEW_PRESETS.find((p) => p.id === id);
}

/** The current view: a fixed preset, or the user's custom pinned/primary set. */
export type ChannelView =
  { kind: "preset"; preset: ChannelViewPresetId } | { kind: "custom" };

/* ------------------------------------------------------------------ */
/* Availability / default                                              */
/* ------------------------------------------------------------------ */

/** Channels matched by a preset, in input (inventory/config) order. */
function matchPreset(
  channels: readonly ChannelDescriptor[],
  preset: ChannelViewPreset,
): ChannelDescriptor[] {
  const matched = filterChannels(channels, preset.match);
  return preset.excludeRawUnit
    ? matched.filter((c) => c.rawUnit === undefined)
    : matched;
}

/**
 * The presets applicable to `mode` with at least one channel in the
 * inventory (empty / inapplicable presets excluded), in registry order.
 * Never throws on garbage input.
 */
export function presetsForInventory(
  channels: readonly ChannelDescriptor[],
  mode: ChannelViewMode,
): ChannelViewPreset[] {
  const list = Array.isArray(channels) ? channels : [];
  return CHANNEL_VIEW_PRESETS.filter(
    (p) =>
      (p.mode === "both" || p.mode === mode) && matchPreset(list, p).length > 0,
  );
}

/**
 * The deterministic default view: node pressure when available, else node +
 * solid temperature, else the first available preset; null when nothing is
 * available (empty inventory).
 */
export function defaultPreset(
  available: readonly ChannelViewPreset[],
): ChannelViewPreset | null {
  if (!Array.isArray(available) || available.length === 0) return null;
  return (
    available.find((p) => p.id === "node-pressure") ??
    available.find((p) => p.id === "node-solid-temperature") ??
    available[0]
  );
}

/* ------------------------------------------------------------------ */
/* Preset channel selection (capped)                                   */
/* ------------------------------------------------------------------ */

/** Maximum number of series an aggregate view charts (rest are reported capped). */
export const AGGREGATE_SERIES_CAP = 40;

function normalizeCap(cap: number): number {
  return Number.isFinite(cap)
    ? Math.max(0, Math.floor(cap))
    : AGGREGATE_SERIES_CAP;
}

export interface PresetChannelSelection {
  /** Matched channels in deterministic inventory order, capped at `cap`. */
  channels: ChannelDescriptor[];
  /** Total matched channels before capping. */
  total: number;
  /** True when at least one matched channel was cut by the cap. */
  capped: boolean;
}

/**
 * The channels of a preset: the inventory filtered by the preset's match
 * (input order preserved — the deterministic config order of listChannels),
 * capped at AGGREGATE_SERIES_CAP (floor, clamp ≥ 0).  An unknown preset id
 * yields an empty selection.  Never throws.
 */
export function presetChannels(
  channels: readonly ChannelDescriptor[],
  preset: ChannelViewPreset | ChannelViewPresetId,
  cap: number = AGGREGATE_SERIES_CAP,
): PresetChannelSelection {
  const p = typeof preset === "string" ? channelViewPreset(preset) : preset;
  const list = Array.isArray(channels) ? channels : [];
  if (!p) return { channels: [], total: 0, capped: false };
  const matched = matchPreset(list, p);
  const limit = normalizeCap(cap);
  const picked = matched.slice(0, limit);
  return {
    channels: picked,
    total: matched.length,
    capped: matched.length > picked.length,
  };
}

/* ------------------------------------------------------------------ */
/* Display / export channel set of a view                              */
/* ------------------------------------------------------------------ */

export interface DisplayChannelSet {
  view: ChannelView;
  /** The channel set to display/export, in deterministic order, capped. */
  channels: ChannelDescriptor[];
  /** Set size before capping. */
  total: number;
  capped: boolean;
  source: "preset" | "custom";
}

/**
 * The current display/export channel set of a view:
 *
 *   - preset — `presetChannels` of the preset (inventory order, capped).
 *   - custom — the primary (focused) channel first when given and present,
 *     then the pinned channels in pin order; stale keys (not in the
 *     inventory) are dropped and duplicates are removed by key.  Empty when
 *     nothing is pinned and no primary is focused.
 *
 * Never throws.
 */
export function displayChannelSet(args: {
  view: ChannelView;
  channels: readonly ChannelDescriptor[];
  pinned?: readonly string[];
  primaryKey?: string | null;
  cap?: number;
}): DisplayChannelSet {
  const inventory = Array.isArray(args.channels) ? args.channels : [];
  const cap = args.cap ?? AGGREGATE_SERIES_CAP;
  const view = args.view;
  if (view.kind === "preset") {
    const sel = presetChannels(inventory, view.preset, cap);
    return { view, source: "preset", ...sel };
  }
  const byKey = new Map(inventory.map((c) => [c.key, c]));
  const ordered: ChannelDescriptor[] = [];
  const seen = new Set<string>();
  const push = (key: string | null | undefined): void => {
    if (typeof key !== "string" || seen.has(key)) return;
    const d = byKey.get(key);
    if (!d) return;
    seen.add(key);
    ordered.push(d);
  };
  push(args.primaryKey);
  if (Array.isArray(args.pinned)) for (const k of args.pinned) push(k);
  const limit = normalizeCap(cap);
  const picked = ordered.slice(0, limit);
  return {
    view,
    source: "custom",
    channels: picked,
    total: ordered.length,
    capped: ordered.length > picked.length,
  };
}

/* ------------------------------------------------------------------ */
/* Transient aggregate chart series                                    */
/* ------------------------------------------------------------------ */

/** Chart-ready series (structural match of InteractiveChart's series prop). */
export interface AggregateSeriesSpec {
  id: string;
  label: string;
  values: number[];
  color?: string;
  dashed?: boolean;
  opacity?: number;
  matchColorOf?: string;
}

/** One unit axis of an aggregate chart: identical quantity AND rawUnit. */
export interface AggregateChartAxis {
  quantity: QuantityKind;
  rawUnit?: string;
  /** The shared chart time grid (the first resolved channel's resolved grid). */
  times: number[];
  /** Primaries in channel order, then baseline overlays in the same order. */
  series: AggregateSeriesSpec[];
}

export type AggregateSkipReason = "unresolved" | "non-series" | "empty-series";

export interface AggregateChart {
  /** Axis groups in first-appearance order of the channel set. */
  axes: AggregateChartAxis[];
  /** Number of channels charted as primary series. */
  included: number;
  /** Number of baseline overlay series appended. */
  baselineOverlays: number;
  /** Channels skipped, with the reason. */
  skipped: Array<{
    descriptor: ChannelDescriptor;
    reason: AggregateSkipReason;
  }>;
}

/**
 * Compose the transient aggregate chart series for a set of channels (the
 * displayChannelSet / presetChannels output) against the current result,
 * with baseline overlays:
 *
 *   - Each channel resolving to a NON-EMPTY series becomes a primary:
 *     id = channel key, label = descriptor label, color = seriesColor(key).
 *   - Channels are grouped into axes by (quantity, rawUnit) — the
 *     sameQuantity rule — so unit/rawUnit safety holds for every preset,
 *     including the mixed ones (gasVolume vs J/kg enthalpy split axes).
 *   - The axis grid is the FIRST resolved channel's resolved time grid; a
 *     later channel whose resolved grid differs is linearly resampled onto
 *     it (sameTimeGrid short-circuit, resampleSeries) — the runHistory
 *     reconciliation convention.
 *   - When a baseline result is given, each primary whose channel resolves
 *     to a non-empty series in the baseline gets an overlay: resampled onto
 *     the axis grid when grids differ, id `baseline:${key}`, dashed,
 *     opacity 0.55, matchColorOf the primary key, label suffix ' (baseline)'
 *     — the ResultsPanel/ChannelExplorer baseline convention.  A baseline
 *     that does not resolve (e.g. a steady baseline under a transient
 *     current) simply yields no overlay.
 *   - Channels that resolve to null (absent), to a scalar (steady current),
 *     or to an empty series (ragged / all non-finite) are skipped and
 *     reported in `skipped` with the reason; `included` /
 *     `baselineOverlays` report the composed counts.
 *
 * Never throws; garbage inputs yield an empty chart with skips reported.
 */
export function aggregateChartSeries(args: {
  channels: readonly ChannelDescriptor[];
  current: SteadyResult | TransientResult | null | undefined;
  baseline?: SteadyResult | TransientResult | null;
}): AggregateChart {
  const out: AggregateChart = {
    axes: [],
    included: 0,
    baselineOverlays: 0,
    skipped: [],
  };
  const list = Array.isArray(args.channels) ? args.channels : [];
  interface AxisBuild {
    axis: AggregateChartAxis;
    primaries: Array<{ descriptor: ChannelDescriptor; values: number[] }>;
  }
  const builds: AxisBuild[] = [];
  const axisIndex = new Map<string, AxisBuild>();

  for (const d of list) {
    if (!d || typeof d !== "object" || !d.channel) continue;
    const resolved = resolveChannel(args.current, d.channel);
    if (!resolved) {
      out.skipped.push({ descriptor: d, reason: "unresolved" });
      continue;
    }
    if (resolved.kind !== "series") {
      out.skipped.push({ descriptor: d, reason: "non-series" });
      continue;
    }
    if (resolved.times.length === 0) {
      out.skipped.push({ descriptor: d, reason: "empty-series" });
      continue;
    }
    const axisKey = `${d.quantity} ${d.rawUnit ?? ""}`;
    let build = axisIndex.get(axisKey);
    if (!build) {
      const axis: AggregateChartAxis = {
        quantity: d.quantity,
        ...(typeof d.rawUnit === "string" ? { rawUnit: d.rawUnit } : {}),
        times: resolved.times,
        series: [],
      };
      build = { axis, primaries: [] };
      axisIndex.set(axisKey, build);
      builds.push(build);
      out.axes.push(axis);
    }
    const values = sameTimeGrid(resolved.times, build.axis.times)
      ? resolved.values
      : resampleSeries(resolved.times, resolved.values, build.axis.times);
    build.primaries.push({ descriptor: d, values });
    build.axis.series.push({
      id: d.key,
      label: d.label,
      values,
      color: seriesColor(d.key),
    });
    out.included++;
  }

  // Baseline overlays AFTER all primaries of the axis (ResultsPanel order).
  const baseline = args.baseline ?? null;
  if (baseline) {
    for (const build of builds) {
      for (const { descriptor } of build.primaries) {
        const base = resolveChannel(baseline, descriptor.channel);
        if (!base || base.kind !== "series" || base.times.length === 0)
          continue;
        const values = sameTimeGrid(base.times, build.axis.times)
          ? base.values
          : resampleSeries(base.times, base.values, build.axis.times);
        build.axis.series.push({
          id: `baseline:${descriptor.key}`,
          label: `${descriptor.label} (baseline)`,
          values,
          dashed: true,
          opacity: 0.55,
          matchColorOf: descriptor.key,
        });
        out.baselineOverlays++;
      }
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Steady aggregate rows                                               */
/* ------------------------------------------------------------------ */

export interface AggregateRow {
  descriptor: ChannelDescriptor;
  /** Current finite scalar value (raw SI / rawUnit value). */
  value: number;
  /** Baseline scalar, present only when the baseline resolves finite. */
  baselineValue?: number;
  /** value − baselineValue, present only with baselineValue. */
  delta?: number;
}

/**
 * Steady aggregate rows for a channel set, in deterministic input order:
 * every channel resolving to a finite scalar yields one row; channels that
 * do not (absent, non-finite scalar, or a series under a transient current)
 * are omitted — rows are finite-only.  With a baseline result, a finite
 * baseline scalar adds baselineValue and delta = value − baselineValue.
 * Never throws.
 */
export function aggregateRows(args: {
  channels: readonly ChannelDescriptor[];
  current: SteadyResult | TransientResult | null | undefined;
  baseline?: SteadyResult | TransientResult | null;
}): AggregateRow[] {
  const list = Array.isArray(args.channels) ? args.channels : [];
  const baseline = args.baseline ?? null;
  const rows: AggregateRow[] = [];
  for (const d of list) {
    if (!d || typeof d !== "object" || !d.channel) continue;
    const resolved = resolveChannel(args.current, d.channel);
    if (
      !resolved ||
      resolved.kind !== "scalar" ||
      !Number.isFinite(resolved.value)
    )
      continue;
    const row: AggregateRow = { descriptor: d, value: resolved.value };
    if (baseline) {
      const base = resolveChannel(baseline, d.channel);
      if (base && base.kind === "scalar" && Number.isFinite(base.value)) {
        row.baselineValue = base.value;
        row.delta = resolved.value - base.value;
      }
    }
    rows.push(row);
  }
  return rows;
}
