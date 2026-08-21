/**
 * Channel Explorer policy core — Stage 3: pure state rules for the
 * ChannelExplorer component (components/ChannelExplorer.tsx).
 *
 * This module contains NO React and touches NO store: every function is pure
 * and operates on the channel inventory of ui/channels.ts plus plain state
 * records, so the whole explorer policy is unit-testable headless.
 *
 *   - PIN_CAP / pinKey / unpinKey      — the explicit pinned channel set is
 *                                        capped at 8 (mirroring
 *                                        DEFAULT_CHANNEL_LIMIT); pinKey
 *                                        reports `capped` instead of
 *                                        silently dropping.
 *   - derivePrimaryKey                 — the focused ("primary") channel:
 *                                        an explicit user pick (dirty) or a
 *                                        pinned focus sticks; otherwise the
 *                                        primary follows the global store
 *                                        selection via
 *                                        primaryChannelForSelection and
 *                                        falls back to the first inventory
 *                                        channel.  Deterministic, loop-free:
 *                                        picking a channel sets dirty AND
 *                                        (when the entity exists live) the
 *                                        store selection, and a dirty focus
 *                                        is never overwritten by the
 *                                        resulting selection echo.
 *   - watchlistChannels                — the channel set shown as chips: the
 *                                        pinned set (stale keys dropped), or
 *                                        the deterministic defaults of
 *                                        channels.ts when nothing is pinned.
 *   - clampTimeIndex                   — global timeIndex semantics shared
 *                                        with resolveChannelAt and the
 *                                        canvas scrubber: null/non-finite →
 *                                        final sample, fractional → rounded,
 *                                        clamped to [0, n-1].
 *   - sameQuantity / composeChartSeries— overlay eligibility (same
 *                                        QuantityKind AND same rawUnit, so
 *                                        dimensionless quality never shares
 *                                        an axis with J/kg enthalpy) and the
 *                                        primary + overlays + dashed
 *                                        baseline series list for
 *                                        InteractiveChart.
 *   - baselineSeries / baselineScalar  — baseline resolution against the
 *                                        CAPTURED baseline result, with
 *                                        transient grids reconciled by
 *                                        resampleSeries onto the current
 *                                        (resolved) grid.
 *   - entityExists / groupOfEntity     — live-config lookups driving the
 *                                        "Show on Diagram" honesty rule (a
 *                                        captured historical entity that no
 *                                        longer exists disables the action).
 *   - formatChannelValue /
 *     formatChannelDelta               — unit-honest scalar formatting:
 *                                        rawUnit channels (specific enthalpy)
 *                                        are never converted; deltas use
 *                                        clampDisplayDelta so FP noise
 *                                        renders as "+0".
 *   - matchesQuery                     — channel search predicate.
 *   - summarizeContextGraph            — one-sentence text summary used as
 *                                        the context SVG's accessible name.
 */

import type {
  NetworkConfig,
  Selection,
  SteadyResult,
  TransientResult,
} from "./types";
import type { UnitPreferences } from "./units";
import {
  defaultChannels,
  primaryChannelForSelection,
  resolveChannel,
  selectionForChannel,
  type ChannelDescriptor,
  type ChannelId,
} from "./channels";
import type { ChannelContextGraph } from "./channelContext";
import { resampleSeries, sameTimeGrid } from "./runHistory";
import {
  clampDisplayDelta,
  formatSig,
  formatWithUnit,
  resolveScale,
} from "./format";

/* ------------------------------------------------------------------ */
/* Pinned channel set (explicit, capped)                               */
/* ------------------------------------------------------------------ */

/** Maximum size of the explicit pinned channel set (and the cap message). */
export const PIN_CAP = 8;

/** Channels beyond this count are not rendered as rows (search/filter first). */
export const LIST_RENDER_CAP = 200;

export interface PinResult {
  pinned: string[];
  /** True when the pin was rejected because the set is already at PIN_CAP. */
  capped: boolean;
}

/**
 * Add `key` to the pinned set.  Idempotent for existing keys; rejects pins
 * beyond `cap` (default PIN_CAP) with `capped: true` and an UNCHANGED set so
 * the caller can surface the cap message.  Never throws.
 */
export function pinKey(
  pinned: readonly string[],
  key: string,
  cap: number = PIN_CAP,
): PinResult {
  const list = Array.isArray(pinned)
    ? pinned.filter((k) => typeof k === "string")
    : [];
  if (list.includes(key)) return { pinned: [...list], capped: false };
  const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : PIN_CAP;
  if (list.length >= limit) return { pinned: [...list], capped: true };
  return { pinned: [...list, key], capped: false };
}

/** Remove `key` from the pinned set (no-op when absent). */
export function unpinKey(pinned: readonly string[], key: string): string[] {
  return (Array.isArray(pinned) ? pinned : []).filter((k) => k !== key);
}

/* ------------------------------------------------------------------ */
/* Primary-channel derivation (selection ↔ explorer, loop-free)        */
/* ------------------------------------------------------------------ */

/**
 * Explorer focus state.  `key` is the last explicitly picked channel key;
 * `dirty` marks that pick as deliberate.  While dirty (or while the focused
 * channel is pinned) the primary does NOT follow global selection changes;
 * the parent clears dirty via an explicit "Follow selection" action.
 */
export interface ExplorerFocus {
  key: string | null;
  dirty: boolean;
}

/** Canonical "follow the global selection" focus (initial state). */
export const FOLLOW_SELECTION: ExplorerFocus = { key: null, dirty: false };

/**
 * The primary channel key for the explorer:
 *
 *   1. An explicitly picked channel (dirty) that is still in the inventory
 *      wins — this is what makes channel → selection → explorer feedback
 *      loop-free (the selection echo never overrides the user's pick).
 *   2. A focused channel that is ALSO pinned sticks even when not dirty
 *      ("pinned" counts as explicit per the explorer policy).
 *   3. Otherwise the canonical primary channel of the global selection
 *      (node→pressure, branch→mdot, …) when the selected element has one.
 *   4. Otherwise the first channel of the deterministic inventory, or null
 *      for an empty inventory.
 *
 * Pure and deterministic; keys that vanished from the inventory (a new
 * result) silently fall through to the next rule.
 */
export function derivePrimaryKey(
  channels: readonly ChannelDescriptor[],
  selection: Selection | null | undefined,
  focus: ExplorerFocus | null | undefined,
  pinned: readonly string[] = [],
): string | null {
  const key = focus?.key ?? null;
  if (
    key &&
    (focus?.dirty || pinned.includes(key)) &&
    channels.some((c) => c.key === key)
  ) {
    return key;
  }
  const selPrimary = primaryChannelForSelection(
    channels,
    selection ?? undefined,
  );
  if (selPrimary) return selPrimary.key;
  if (key && focus?.dirty === false && channels.some((c) => c.key === key))
    return key;
  return channels.length > 0 ? channels[0].key : null;
}

/* ------------------------------------------------------------------ */
/* Watchlist (pinned set or deterministic defaults)                    */
/* ------------------------------------------------------------------ */

export interface Watchlist {
  channels: ChannelDescriptor[];
  /** True when the list is the deterministic default pick (nothing pinned). */
  defaults: boolean;
}

/**
 * The channel set rendered as watchlist chips: the pinned set in pin order
 * (stale keys silently dropped) when anything is pinned, else the
 * deterministic `defaultChannels` pick for the current selection.
 */
export function watchlistChannels(
  channels: readonly ChannelDescriptor[],
  pinned: readonly string[],
  selection: Selection | null | undefined,
  limit: number = PIN_CAP,
): Watchlist {
  if (!Array.isArray(pinned) || pinned.length === 0) {
    return {
      channels: defaultChannels(channels, {
        selection: selection ?? null,
        limit,
      }),
      defaults: true,
    };
  }
  const byKey = new Map(channels.map((c) => [c.key, c]));
  const list: ChannelDescriptor[] = [];
  for (const key of pinned) {
    const d = byKey.get(key);
    if (d) list.push(d);
  }
  return { channels: list, defaults: false };
}

/* ------------------------------------------------------------------ */
/* Time index                                                          */
/* ------------------------------------------------------------------ */

/**
 * Clamp the global timeIndex onto [0, sampleCount-1].  null / undefined /
 * non-finite select the FINAL sample (matching resolveChannelAt and the
 * canvas scrubber); fractional indices round.  Returns 0 for empty series.
 */
export function clampTimeIndex(
  timeIndex: number | null | undefined,
  sampleCount: number,
): number {
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) return 0;
  const last = sampleCount - 1;
  if (
    timeIndex === null ||
    timeIndex === undefined ||
    !Number.isFinite(timeIndex)
  )
    return last;
  const idx = Math.round(timeIndex);
  return idx < 0 ? 0 : idx > last ? last : idx;
}

/* ------------------------------------------------------------------ */
/* Chart series composition                                            */
/* ------------------------------------------------------------------ */

/**
 * True when two channels can share one chart axis: same QuantityKind AND the
 * same rawUnit situation (both plain or the identical rawUnit).  Every
 * registered field currently has an honest QuantityKind, so the rawUnit half
 * is the guard that keeps a future raw-SI channel off a plain axis of the
 * same nominal kind.
 */
export function sameQuantity(
  a: ChannelDescriptor,
  b: ChannelDescriptor,
): boolean {
  return (
    a.quantity === b.quantity && (a.rawUnit ?? null) === (b.rawUnit ?? null)
  );
}

/** Minimal series shape consumed by InteractiveChart (structural match). */
export interface ExplorerSeriesSpec {
  id: string;
  label: string;
  values: number[];
  dashed?: boolean;
  opacity?: number;
  matchColorOf?: string;
}

export interface SeriesInput {
  key: string;
  label: string;
  values: number[];
}

/**
 * The focused-chart series list: primary first, then pinned same-quantity
 * overlays in the order given (duplicates of the primary skipped), then the
 * optional baseline overlay of the PRIMARY channel — dashed, lower opacity,
 * color-locked to the primary via matchColorOf (mirrors the ResultsPanel
 * baseline overlay convention).
 */
export function composeChartSeries(args: {
  primary: SeriesInput;
  overlays?: readonly SeriesInput[];
  baseline?: { values: number[] } | null;
}): ExplorerSeriesSpec[] {
  const { primary } = args;
  const out: ExplorerSeriesSpec[] = [
    { id: primary.key, label: primary.label, values: primary.values },
  ];
  const seen = new Set([primary.key]);
  for (const o of args.overlays ?? []) {
    if (!o || seen.has(o.key)) continue;
    seen.add(o.key);
    out.push({ id: o.key, label: o.label, values: o.values });
  }
  if (args.baseline && Array.isArray(args.baseline.values)) {
    out.push({
      id: `baseline:${primary.key}`,
      label: `${primary.label} (baseline)`,
      values: args.baseline.values,
      dashed: true,
      opacity: 0.55,
      matchColorOf: primary.key,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Baseline resolution (against the CAPTURED baseline result)          */
/* ------------------------------------------------------------------ */

/**
 * The baseline overlay of `channel` for a transient current result: resolves
 * the channel against the captured baseline result and, when the accepted-step
 * grids differ, linearly resamples onto the CURRENT resolved grid (the one the
 * chart displays).  Returns null unless BOTH sides resolve to series.
 */
export function baselineSeries(
  baselineResult: SteadyResult | TransientResult | null | undefined,
  currentResult: SteadyResult | TransientResult | null | undefined,
  channel: ChannelId | null | undefined,
): number[] | null {
  const cur = resolveChannel(currentResult, channel);
  const base = resolveChannel(baselineResult, channel);
  if (!cur || cur.kind !== "series" || !base || base.kind !== "series")
    return null;
  if (cur.times.length === 0) return null;
  return sameTimeGrid(base.times, cur.times)
    ? base.values
    : resampleSeries(base.times, base.values, cur.times);
}

/** The baseline scalar of `channel` for a steady comparison, or null. */
export function baselineScalar(
  baselineResult: SteadyResult | TransientResult | null | undefined,
  channel: ChannelId | null | undefined,
): number | null {
  const base = resolveChannel(baselineResult, channel);
  return base && base.kind === "scalar" ? base.value : null;
}

/* ------------------------------------------------------------------ */
/* Live-config entity lookups (selection mapping + Show on Diagram)    */
/* ------------------------------------------------------------------ */

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object"
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * True when `sel` addresses an entity present in `config` (the LIVE config —
 * a captured historical entity may have been deleted since the run).  Group
 * and 'none' selections return false here: the explorer only maps the four
 * element kinds.
 */
export function entityExists(
  config: NetworkConfig | null | undefined,
  sel: Selection,
): boolean {
  if (!config || typeof config !== "object") return false;
  if (sel.kind === "none" || sel.kind === "group" || sel.kind === "multi")
    return false;
  const id = sel.id;
  const has = (arr: unknown) =>
    Array.isArray(arr) && arr.some((el) => asRecord(el)?.id === id);
  switch (sel.kind) {
    case "node":
      return has(config.nodes);
    case "branch":
      return has(config.branches);
    case "solidNode":
      return has(config.solidNodes);
    case "conductor":
      return has(config.conductors);
    default:
      return false;
  }
}

/**
 * Selection to apply when the user picks a channel: the channel's element,
 * or null when that element no longer exists in the live config (the caller
 * then focuses the channel WITHOUT touching the global selection).
 */
export function selectionForExistingEntity(
  config: NetworkConfig | null | undefined,
  channel: ChannelId | ChannelDescriptor,
): Selection | null {
  const sel = selectionForChannel(channel);
  return entityExists(config, sel) ? sel : null;
}

/** The live group of a node/solidNode (for the openGroupTab path), if any. */
export function groupOfEntity(
  config: NetworkConfig | null | undefined,
  kind: Selection["kind"],
  id: string,
): string | undefined {
  if (!config || (kind !== "node" && kind !== "solidNode")) return undefined;
  const arr = kind === "node" ? config.nodes : config.solidNodes;
  if (!Array.isArray(arr)) return undefined;
  const rec = asRecord(arr.find((el) => asRecord(el)?.id === id));
  return typeof rec?.group === "string" ? rec.group : undefined;
}

/* ------------------------------------------------------------------ */
/* Unit-honest value formatting                                        */
/* ------------------------------------------------------------------ */

/**
 * Format a resolved channel value.  Channels with a `rawUnit` (specific
 * enthalpy, J/kg) are NEVER unit-converted — the raw SI value is shown with
 * the rawUnit suffix, per the channels.ts unit-honesty contract.
 */
export function formatChannelValue(
  value: number,
  d: Pick<ChannelDescriptor, "quantity" | "rawUnit">,
  prefs?: Partial<UnitPreferences>,
  sigFigs = 4,
): string {
  if (typeof d.rawUnit === "string" && d.rawUnit.length > 0) {
    return `${formatSig(value, sigFigs)} ${d.rawUnit}`;
  }
  return formatWithUnit(value, d.quantity, prefs, sigFigs);
}

/**
 * Signed "current − baseline" delta text in the channel's display unit,
 * snapped to "+0" below display resolution / FP noise (clampDisplayDelta).
 * Offset units (°C/°F) are delta-safe: the display delta is exactly
 * factor·Δsi.  rawUnit channels delta in raw SI units.
 */
export function formatChannelDelta(
  current: number,
  baseline: number,
  d: Pick<ChannelDescriptor, "quantity" | "rawUnit">,
  prefs?: Partial<UnitPreferences>,
  sigFigs = 4,
): string {
  const sign = (v: number) => (v >= 0 ? "+" : "");
  if (typeof d.rawUnit === "string" && d.rawUnit.length > 0) {
    const delta = clampDisplayDelta(
      current - baseline,
      Math.max(Math.abs(current), Math.abs(baseline)),
      sigFigs,
    );
    return `${sign(delta)}${formatSig(delta, sigFigs)} ${d.rawUnit}`;
  }
  const scale = resolveScale(
    [current, baseline],
    d.quantity,
    prefs?.[d.quantity],
  );
  const cur = scale.convert(current);
  const base = scale.convert(baseline);
  const delta = clampDisplayDelta(
    cur - base,
    Math.max(Math.abs(cur), Math.abs(base)),
    sigFigs,
  );
  return `${sign(delta)}${formatSig(delta, sigFigs)} ${scale.unitLabel}`;
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

/**
 * Case-insensitive substring match over the channel label, element id, field
 * and entity kind.  Empty/whitespace queries match everything.
 */
export function matchesQuery(d: ChannelDescriptor, query: string): boolean {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return true;
  return (
    d.label.toLowerCase().includes(q) ||
    d.channel.id.toLowerCase().includes(q) ||
    d.elementLabel.toLowerCase().includes(q) ||
    String(d.channel.field).toLowerCase().includes(q) ||
    d.channel.entity.toLowerCase().includes(q)
  );
}

/* ------------------------------------------------------------------ */
/* Context-graph text summary (accessible name of the context SVG)     */
/* ------------------------------------------------------------------ */

const KIND_NOUN: Record<string, string> = {
  node: "fluid node",
  solidNode: "solid node",
  branch: "branch",
  conductor: "conductor",
  group: "group",
};

/**
 * One-sentence summary of a context graph, used as the SVG's accessible
 * description: the focused element plus its one-hop neighbors and connecting
 * branches/conductors.  Neighbor/edge names are listed (first few) so the
 * summary carries the topology, not just counts.
 */
export function summarizeContextGraph(
  graph: ChannelContextGraph,
  maxNames = 4,
): string {
  if (!graph || !graph.focusedKey || graph.nodes.length === 0) {
    return "No topology context available for this channel.";
  }
  const [kind, ...idParts] = graph.focusedKey.split(":");
  const focusId = idParts.join(":");
  const focused = graph.nodes.find((n) => n.focused);
  const focusLabel = focused ? focused.label : focusId;
  const noun = KIND_NOUN[kind] ?? kind;
  const neighbors = graph.nodes.filter((n) => n.neighbor);
  const names = (items: Array<{ label?: string; id: string }>) =>
    items
      .slice(0, maxNames)
      .map((n) => n.label ?? n.id)
      .join(", ");
  const parts: string[] = [];
  if (neighbors.length > 0) {
    const suffix =
      neighbors.length > maxNames
        ? ` and ${neighbors.length - maxNames} more`
        : "";
    parts.push(
      `${neighbors.length} neighbor node${neighbors.length === 1 ? "" : "s"} (${names(neighbors)}${suffix})`,
    );
  }
  if (graph.edges.length > 0) {
    const branchCount = graph.edges.filter((e) => e.kind === "branch").length;
    const conductorCount = graph.edges.length - branchCount;
    const bits: string[] = [];
    if (branchCount > 0)
      bits.push(`${branchCount} branch${branchCount === 1 ? "" : "es"}`);
    if (conductorCount > 0)
      bits.push(
        `${conductorCount} conductor${conductorCount === 1 ? "" : "s"}`,
      );
    parts.push(
      `connected by ${bits.join(" and ")} (${names(graph.edges)}${graph.edges.length > maxNames ? ", …" : ""})`,
    );
  }
  const tail =
    parts.length > 0
      ? ` with ${parts.join(" ")}`
      : " with no connected elements";
  return `${noun} "${focusLabel}"${tail}.`;
}
