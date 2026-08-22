/**
 * ChannelExplorer — the primary channel-centric Analysis surface.
 *
 * Channel views (policy core: ui/channelViews.ts): the explorer opens on a
 * full-width AGGREGATE preset (default: `defaultPreset`, normally all node
 * pressures) — one chart per quantity/rawUnit axis for transient
 * results, an accessible bar/value list for steady results.  The view
 * dropdown (`channel-explorer-view`) offers every preset applicable to the
 * inventory plus "Custom channels"; switching to Custom reveals the
 * searchable/filterable inventory of every numeric channel of the DISPLAYED
 * result (listChannels over the CAPTURED config + result, never the live
 * config), the pinned watchlist (max PIN_CAP, deterministic
 * selection-driven defaults), and the focused channel view — a chart with
 * cursor-synced global timeIndex for transient runs, or a prominent scalar
 * (with optional baseline delta) for steady runs.  CSV export has two
 * buttons: the displayed set (capped preset / custom watchlist) and the
 * full inventory (every numeric channel of the captured result).
 *
 * The read-only one-hop context diagram ("Show on Diagram" action per
 * ModelTableView precedent: select, switch to the editor/group tab, request
 * canvas focus) is part of the focused channel view: it appears in Custom
 * mode only, BELOW the full-width chart, and never reserves a column.
 *
 * Selection policy (pure, see ui/channelExplorer.ts): picking a channel
 * focuses it (dirty) and selects its entity in the store when that entity
 * still exists live; store selection changes move the primary only while the
 * explorer follows the selection (not dirty and primary not pinned).  The
 * component NEVER mutates config/undo/history — store writes are limited to
 * selection / timeIndex / tab / canvas-focus requests.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import type {
  NetworkConfig,
  Selection,
  SteadyResult,
  TransientResult,
} from "../types";
import { QUANTITY_LABELS, type QuantityKind } from "../units";
import InteractiveChart, { type Series } from "./InteractiveChart";
import {
  listChannels,
  resolveChannel,
  resolveChannelAt,
  selectionForChannel,
  type ChannelDescriptor,
  type ChannelEntityKind,
} from "../channels";
import {
  buildContextGraph,
  buildChannelsCsv,
  channelsExportFilename,
  layoutContextGraph,
} from "../channelContext";
import {
  FOLLOW_SELECTION,
  LIST_RENDER_CAP,
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
  summarizeContextGraph,
  unpinKey,
  watchlistChannels,
  type ExplorerFocus,
} from "../channelExplorer";
import {
  AGGREGATE_SERIES_CAP,
  aggregateChartSeries,
  aggregateRows,
  defaultPreset,
  displayChannelSet,
  presetsForInventory,
  type ChannelView,
  type ChannelViewPreset,
  type ChannelViewPresetId,
} from "../channelViews";
import { formatWithUnit } from "../format";
import {
  EDGE_BRANCH,
  EDGE_CONDUCTOR,
  NODE_FLUID,
  NODE_SOLID,
} from "../canvasPalette";
import { seriesColor } from "./chartMath";
import { sameTimeGrid } from "../runHistory";

/* ------------------------------------------------------------------ */
/* Props                                                               */
/* ------------------------------------------------------------------ */

/** Captured baseline run (comparison overlays / deltas). */
export interface ChannelExplorerBaseline {
  name: string;
  config: NetworkConfig;
  result: SteadyResult | TransientResult;
  /** Hash captured at run time (CSV provenance of overlays is current-run). */
  configHash?: string;
}

export interface ChannelExplorerProps {
  /** CAPTURED config snapshot the displayed result was solved from. */
  displayConfig: NetworkConfig;
  /** The displayed (captured or live-partial) result; null ⇒ empty state. */
  result: SteadyResult | TransientResult | null;
  /** True for a live (running/cancelled) partial result. */
  live?: boolean;
  /** True when the displayed result predates the current model state. */
  stale?: boolean;
  /** Optional pinned baseline run (same-mode overlays / deltas). */
  baseline?: ChannelExplorerBaseline | null;
  /** Hash captured at run time (e.g. RunRecord.configHash) for CSV provenance. */
  configHash?: string;
  /** Parent-supplied run/mode context line for the header. */
  runContext?: string;
  /** Chart height override (px). */
  chartHeight?: number;
}

const KIND_FILTERS: Array<{ value: "all" | ChannelEntityKind; label: string }> =
  [
    { value: "all", label: "All" },
    { value: "node", label: "Nodes" },
    { value: "branch", label: "Branches" },
    { value: "solidNode", label: "Solid nodes" },
    { value: "conductor", label: "Conductors" },
  ];

const KIND_BADGE: Record<ChannelEntityKind, string> = {
  node: "Node",
  branch: "Branch",
  solidNode: "Solid",
  conductor: "Conductor",
};

/** Selections that address a concrete element (always carry an id). */
type EntitySelection = Exclude<Selection, { kind: "none" } | { kind: "multi" }>;

const CUSTOM_VIEW_VALUE = "__custom__";

const viewValue = (v: ChannelView): string =>
  v.kind === "preset" ? v.preset : CUSTOM_VIEW_VALUE;

/**
 * Axis titles that read better than the generic quantity name in this
 * context: every 'power' channel in a result is a conductor heat rate.
 */
const AXIS_LABEL_OVERRIDES: Partial<Record<QuantityKind, string>> = {
  power: "Heat rate",
};

/** Human-readable axis name; the rawUnit itself is passed as yUnitLabel. */
function axisLabel(quantity: QuantityKind, rawUnit?: string): string {
  // rawUnit channels have no convertible QuantityKind (channels.ts
  // unit-conversion contract); the rawUnit symbol is the most specific name available.
  if (typeof rawUnit === "string" && rawUnit.length > 0) return rawUnit;
  return (
    AXIS_LABEL_OVERRIDES[quantity] ?? QUANTITY_LABELS[quantity] ?? quantity
  );
}

function downloadText(text: string, filename: string, mime = "text/csv") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/* Main component                                                      */
/* ------------------------------------------------------------------ */

export default function ChannelExplorer({
  displayConfig,
  result,
  live = false,
  stale = false,
  baseline = null,
  configHash,
  runContext,
  chartHeight = 260,
}: ChannelExplorerProps) {
  const selection = useStore((s) => s.selection);
  const setSelection = useStore((s) => s.setSelection);
  const timeIndex = useStore((s) => s.timeIndex);
  const setTimeIndex = useStore((s) => s.setTimeIndex);
  const unitPrefs = useStore((s) => s.unitPreferences);
  const sigFigs = useStore((s) => s.resultSigFigs);
  const liveConfig = useStore((s) => s.config);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const openGroupTab = useStore((s) => s.openGroupTab);
  const requestCanvasFocus = useStore((s) => s.requestCanvasFocus);

  const [view, setView] = useState<ChannelView | null>(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | ChannelEntityKind>(
    "all",
  );
  const [focus, setFocus] = useState<ExplorerFocus>(FOLLOW_SELECTION);
  const [pinned, setPinned] = useState<string[]>([]);
  const [notice, setNotice] = useState("");

  // ── Inventory + view availability (pure policies) ──────────────────
  const channels = useMemo(
    () => listChannels(displayConfig, result),
    [displayConfig, result],
  );
  const channelByKey = useMemo(
    () => new Map(channels.map((c) => [c.key, c])),
    [channels],
  );
  const transient =
    result !== null && Array.isArray((result as TransientResult).times);
  const rawTimes = transient ? (result as TransientResult).times : [];
  const effectiveIdx = clampTimeIndex(timeIndex, rawTimes.length);
  const viewMode: "steady" | "transient" = transient ? "transient" : "steady";

  const availablePresets = useMemo(
    () => presetsForInventory(channels, viewMode),
    [channels, viewMode],
  );

  // Default / validity policy: an unset view (or a preset that no longer
  // applies to a new result/inventory) falls back to the deterministic
  // defaultPreset (normally All node pressures); a still-valid user choice —
  // preset or Custom — is preserved across selection/inventory changes.
  useEffect(() => {
    setView((current) => {
      if (current && current.kind === "custom") return current;
      if (current && availablePresets.some((p) => p.id === current.preset))
        return current;
      const d = defaultPreset(availablePresets);
      return d ? { kind: "preset", preset: d.id } : null;
    });
  }, [availablePresets]);

  const effectiveView: ChannelView | null =
    view &&
    (view.kind === "custom" ||
      availablePresets.some((p) => p.id === view.preset))
      ? view
      : (() => {
          const d = defaultPreset(availablePresets);
          return d ? { kind: "preset", preset: d.id } : null;
        })();

  const activePreset: ChannelViewPreset | null =
    effectiveView?.kind === "preset"
      ? (availablePresets.find(
          (p) =>
            p.id === (effectiveView as { preset: ChannelViewPresetId }).preset,
        ) ?? null)
      : null;

  // ── Custom-mode primary derivation (pure policy) ───────────────────
  const primaryKey = derivePrimaryKey(channels, selection, focus, pinned);
  const primary = primaryKey ? (channelByKey.get(primaryKey) ?? null) : null;
  const watchlist = useMemo(
    () => watchlistChannels(channels, pinned, selection),
    [channels, pinned, selection],
  );

  const primaryData = useMemo(
    () =>
      effectiveView?.kind === "custom" && primary
        ? resolveChannel(result, primary.channel)
        : null,
    [effectiveView, result, primary],
  );

  // ── Display set of the current view (drives aggregate + CSV export) ─
  const displaySet = useMemo(
    () =>
      effectiveView
        ? displayChannelSet({
            view: effectiveView,
            channels,
            pinned,
            primaryKey,
          })
        : null,
    [effectiveView, channels, pinned, primaryKey],
  );

  // Aggregate composition for the active preset (null-safe, never throws).
  const baselineResult = !live && baseline ? baseline.result : null;
  const aggChart = useMemo(
    () =>
      activePreset && transient
        ? aggregateChartSeries({
            channels: displaySet?.channels ?? [],
            current: result,
            baseline: baselineResult,
          })
        : null,
    [activePreset, transient, displaySet, result, baselineResult],
  );
  const aggRows = useMemo(
    () =>
      activePreset && !transient
        ? aggregateRows({
            channels: displaySet?.channels ?? [],
            current: result,
            baseline: baselineResult,
          })
        : null,
    [activePreset, transient, displaySet, result, baselineResult],
  );

  // Resampling: the aggregate chart reconciles ragged channels onto
  // the first resolved channel's grid; report when grids actually differed.
  const aggregateResampled = useMemo(() => {
    if (!aggChart || !result) return false;
    for (const axis of aggChart.axes) {
      for (const ser of axis.series) {
        const key = ser.id.startsWith("baseline:")
          ? ser.id.slice("baseline:".length)
          : ser.id;
        const d = channelByKey.get(key);
        if (!d) continue;
        const src = ser.id.startsWith("baseline:") ? baselineResult : result;
        const resolved = src ? resolveChannel(src, d.channel) : null;
        if (
          resolved &&
          resolved.kind === "series" &&
          !sameTimeGrid(resolved.times, axis.times)
        )
          return true;
      }
    }
    return false;
  }, [aggChart, result, baselineResult, channelByKey]);

  // Aggregate readout: values of every included primary at the time cursor.
  const aggregateReadout = useMemo(() => {
    if (!aggChart) return [];
    const out: Array<{ key: string; label: string; text: string }> = [];
    for (const axis of aggChart.axes) {
      for (const ser of axis.series) {
        if (ser.id.startsWith("baseline:")) continue;
        const d = channelByKey.get(ser.id);
        if (!d) continue;
        const v = resolveChannelAt(result, d.channel, timeIndex);
        if (v === null) continue;
        out.push({
          key: ser.id,
          label: d.label,
          text: formatChannelValue(v, d, unitPrefs, sigFigs),
        });
      }
    }
    return out;
  }, [aggChart, channelByKey, result, timeIndex, unitPrefs, sigFigs]);

  // ── Interactions ───────────────────────────────────────────────────
  /** Focus a channel (dirty) + select its entity live when it still exists. */
  const pickChannel = (d: ChannelDescriptor) => {
    setFocus({ key: d.key, dirty: true });
    const sel = selectionForChannel(d) as EntitySelection;
    const already =
      selection.kind === sel.kind &&
      "id" in selection &&
      selection.id === sel.id;
    if (!already && entityExists(liveConfig, sel)) {
      setSelection(sel);
    }
  };

  /** Aggregate → Custom: focus the channel and switch the view explicitly. */
  const focusCustomChannel = (d: ChannelDescriptor, origin: string) => {
    pickChannel(d);
    setView({ kind: "custom" });
    setNotice(`${origin}: ${d.label} — showing Custom channels.`);
  };

  const selectView = (value: string) => {
    if (value === CUSTOM_VIEW_VALUE) {
      setView({ kind: "custom" });
      const d = primary;
      setNotice(
        d ? `Custom channels — focused on ${d.label}.` : "Custom channels.",
      );
      return;
    }
    const p = availablePresets.find((x) => x.id === value);
    if (p) {
      setView({ kind: "preset", preset: p.id });
      setNotice(`${p.label}.`);
    }
  };

  const togglePin = (d: ChannelDescriptor) => {
    if (pinned.includes(d.key)) {
      setPinned(unpinKey(pinned, d.key));
      setNotice(`Unpinned ${d.label}.`);
      return;
    }
    const r = pinKey(pinned, d.key);
    if (r.capped) {
      setNotice(
        `Channel set is full (max ${PIN_CAP}). Unpin a channel to add another.`,
      );
      return;
    }
    setPinned(r.pinned);
    setNotice(`Pinned ${d.label}.`);
  };

  /** ModelTableView precedent: select, switch to editor (group tab if grouped), pan. */
  const showOnDiagram = (sel: EntitySelection) => {
    setSelection(sel);
    const group = groupOfEntity(liveConfig, sel.kind, sel.id);
    if (group) openGroupTab(group);
    else setActiveTab("editor");
    requestCanvasFocus(sel.kind, sel.id);
  };

  const primarySelection = primary
    ? (selectionForChannel(primary) as EntitySelection)
    : null;
  const primaryExistsLive = primarySelection
    ? entityExists(liveConfig, primarySelection)
    : false;

  /**
   * Aggregate legend locate: focus the channel in Custom mode (the diagram
   * is Custom-only), and select its entity live when it still exists.
   */
  const locateSeries = (seriesId: string) => {
    const key = seriesId.startsWith("baseline:")
      ? seriesId.slice("baseline:".length)
      : seriesId;
    const d = channelByKey.get(key);
    if (!d) return;
    focusCustomChannel(d, "Focused from chart legend");
  };

  /** Custom-mode focused-chart locate: reveal the element on the diagram. */
  const locateFocusedSeries = (seriesId: string) => {
    const key = seriesId.startsWith("baseline:")
      ? seriesId.slice("baseline:".length)
      : seriesId;
    const d = channelByKey.get(key);
    if (!d) return;
    const sel = selectionForChannel(d) as EntitySelection;
    if (entityExists(liveConfig, sel)) showOnDiagram(sel);
  };

  // ── CSV export: displayed set, or the full captured inventory ──────
  const exportList = displaySet?.channels ?? [];

  const exportCsv = (kind: "view" | "all") => {
    const list = kind === "all" ? channels : exportList;
    if (!result || list.length === 0) return;
    const text = buildChannelsCsv({
      config: displayConfig,
      result,
      channels: list,
      ...(configHash !== undefined ? { configHash } : {}),
      units: unitPrefs,
    });
    if (!text) return;
    downloadText(
      text,
      channelsExportFilename(displayConfig, list.length, kind),
    );
    setNotice(
      kind === "all"
        ? `Exported all ${list.length} channel${list.length === 1 ? "" : "s"} to CSV.`
        : `Exported ${list.length} channel${list.length === 1 ? "" : "s"} to CSV.`,
    );
  };

  // ── Filtered list (search + kind), capped for large networks ───────
  const filtered = useMemo(
    () =>
      channels.filter(
        (d) =>
          (kindFilter === "all" || d.channel.entity === kindFilter) &&
          matchesQuery(d, query),
      ),
    [channels, kindFilter, query],
  );
  const visibleRows = filtered.slice(0, LIST_RENDER_CAP);
  const overflow = filtered.length - visibleRows.length;

  const mode = displayConfig.settings.mode;
  const isCustom = effectiveView?.kind === "custom";
  const aggregateEmpty = aggChart !== null && aggChart.included === 0;

  const showingText = displaySet
    ? `Showing ${displaySet.channels.length} of ${displaySet.total} channel${displaySet.total === 1 ? "" : "s"}`
    : "";

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */
  return (
    <section
      className="channel-explorer"
      data-testid="channel-explorer"
      aria-labelledby="channel-explorer-title"
    >
      {/* ── Data-first header ─────────────────────────────────────── */}
      <div className="channel-explorer__header">
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <h2 id="channel-explorer-title" className="channel-explorer__title">
            Simulation channels
          </h2>
          <span className="pill" data-testid="channel-explorer-mode">
            {mode}
          </span>
          {live && (
            <span className="pill" data-testid="channel-explorer-live">
              live partial
            </span>
          )}
          {runContext && (
            <span
              data-testid="channel-explorer-run-context"
              style={{ color: "var(--text-3)", fontSize: "var(--fs-cap)" }}
            >
              {runContext}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button
            data-testid="channel-explorer-export-csv"
            className="btn btn--ghost btn--sm"
            onClick={() => exportCsv("view")}
            disabled={!result || exportList.length === 0}
            title="Download the displayed channels as CSV (captured config + result provenance)"
          >
            Export CSV
          </button>
          <button
            data-testid="channel-explorer-export-all-csv"
            className="btn btn--ghost btn--sm"
            onClick={() => exportCsv("all")}
            disabled={!result || channels.length === 0}
            title="Download every result channel as CSV, not just the current view (captured config + result provenance)"
          >
            Export all
          </button>
        </div>
        {stale && (
          <div
            className="stale-banner"
            data-testid="channel-explorer-stale"
            style={{ marginTop: 8, marginBottom: 0 }}
          >
            Results are from an earlier model state. Rerun before using these
            values for a design decision.
          </div>
        )}
        {result && channels.length > 0 && (
          <div className="channel-explorer__toolbar">
            <label
              htmlFor="channel-explorer-view"
              style={{ fontSize: "var(--fs-cap)", color: "var(--text-2)" }}
            >
              View
            </label>
            <select
              id="channel-explorer-view"
              data-testid="channel-explorer-view"
              className="input channel-explorer__view"
              aria-label="Channel view"
              value={viewValue(effectiveView ?? { kind: "custom" })}
              onChange={(e) => selectView(e.target.value)}
            >
              {availablePresets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value={CUSTOM_VIEW_VALUE}>Custom channels</option>
            </select>
            <span
              style={{
                color: "var(--text-3)",
                fontSize: "var(--fs-cap)",
                fontVariantNumeric: "tabular-nums",
              }}
              role="status"
              data-testid="channel-explorer-showing"
            >
              {showingText}
            </span>
            {isCustom && (
              <>
                <label
                  className="visually-hidden"
                  htmlFor="channel-explorer-search"
                >
                  Search channels
                </label>
                <input
                  id="channel-explorer-search"
                  data-testid="channel-explorer-search"
                  className="input"
                  type="search"
                  placeholder="Search channels…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{ maxWidth: 260 }}
                />
                <div
                  role="group"
                  aria-label="Filter by entity kind"
                  style={{ display: "flex", gap: 4, flexWrap: "wrap" }}
                >
                  {KIND_FILTERS.map((f) => (
                    <button
                      key={f.value}
                      data-testid={`channel-explorer-filter-${f.value}`}
                      className="btn btn--choice btn--sm"
                      aria-pressed={kindFilter === f.value}
                      onClick={() => setKindFilter(f.value)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <span
                  style={{ color: "var(--text-3)", fontSize: "var(--fs-cap)" }}
                  role="status"
                >
                  {filtered.length} of {channels.length} channels
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {!result || channels.length === 0 ? (
        <div
          className="channel-explorer__empty"
          data-testid="channel-explorer-empty"
        >
          {!result
            ? "Run a simulation to explore its channels."
            : "This result carries no numeric channels."}
        </div>
      ) : (
        <div className="channel-explorer__body">
          {/* Status announcements: visible AND aria-live (cap/pin/export/view). */}
          <div
            className="channel-explorer__notice"
            data-testid="channel-explorer-status"
            role="status"
            aria-live="polite"
          >
            {notice}
          </div>

          {/* ── Aggregate preset view (full width) ─────────────────── */}
          {activePreset && (
            <div
              className="channel-explorer__aggregate"
              data-testid="channel-explorer-aggregate"
            >
              {displaySet?.capped && (
                <div
                  className="channel-explorer__aggregate-note"
                  data-testid="channel-explorer-cap-note"
                  role="status"
                >
                  Showing first {displaySet.channels.length} of{" "}
                  {displaySet.total} channels (aggregate cap{" "}
                  {AGGREGATE_SERIES_CAP}). Pick a channel to focus it in Custom
                  channels.
                </div>
              )}
              {aggregateResampled && (
                <div
                  className="channel-explorer__aggregate-note"
                  data-testid="channel-explorer-resample-note"
                  role="status"
                >
                  Some channels were resampled onto a shared time grid.
                </div>
              )}
              {aggChart && aggChart.skipped.length > 0 && (
                <div
                  className="channel-explorer__aggregate-note"
                  data-testid="channel-explorer-skipped-note"
                  role="status"
                >
                  Skipped {aggChart.skipped.length} channel
                  {aggChart.skipped.length === 1 ? "" : "s"} (
                  {aggChart.skipped.map((s) => s.descriptor.label).join(", ")}):
                  not present as a time series in this result.
                </div>
              )}

              {aggChart &&
                aggChart.axes.map((axis, axisIdx) => (
                  <div
                    className="channel-explorer__chart"
                    key={`${axis.quantity}-${axis.rawUnit ?? ""}-${axisIdx}`}
                  >
                    <InteractiveChart
                      dataTestid={
                        axisIdx === 0
                          ? "channel-explorer-chart"
                          : `channel-explorer-chart-${axisIdx}`
                      }
                      exportTestid={
                        axisIdx === 0
                          ? "channel-explorer-chart"
                          : `channel-explorer-chart-${axisIdx}`
                      }
                      series={axis.series as Series[]}
                      times={axis.times}
                      xLabel="Time"
                      yLabel={axisLabel(axis.quantity, axis.rawUnit)}
                      yQuantityKind={axis.quantity}
                      {...(axis.rawUnit !== undefined
                        ? { yUnitLabel: axis.rawUnit }
                        : {})}
                      xQuantityKind="time"
                      height={chartHeight}
                      cursorTime={rawTimes[effectiveIdx]}
                      onCursorCommit={(idx) => {
                        const t = axis.times[idx];
                        if (t === undefined) {
                          setTimeIndex(idx);
                          return;
                        }
                        let best: number | null = null;
                        for (let i = 0; i < rawTimes.length; i++) {
                          if (
                            best === null ||
                            Math.abs(rawTimes[i] - t) <
                              Math.abs(rawTimes[best] - t)
                          )
                            best = i;
                        }
                        setTimeIndex(best ?? idx);
                      }}
                      onSeriesLocate={locateSeries}
                      provenanceConfig={displayConfig}
                    />
                  </div>
                ))}

              {aggChart && aggChart.included > 0 && (
                <div
                  className="channel-explorer__readout"
                  data-testid="channel-explorer-readout"
                >
                  {aggregateReadout.map((r) => (
                    <span
                      key={r.key}
                      style={{
                        fontSize: "var(--fs-cap)",
                        color: "var(--text-2)",
                      }}
                    >
                      <strong
                        style={{
                          color: "var(--text-1)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {r.text}
                      </strong>{" "}
                      {r.label}
                    </span>
                  ))}
                </div>
              )}

              {aggregateEmpty && (
                <div
                  className="channel-explorer__empty"
                  data-testid="channel-explorer-unresolved"
                >
                  No channels of this view resolve to time series in the
                  displayed result.
                </div>
              )}

              {aggRows && aggRows.length > 0 && (
                <AggregateBarList
                  rows={aggRows}
                  baselineName={!live && baseline ? baseline.name : null}
                  unitPrefs={unitPrefs}
                  sigFigs={sigFigs}
                  onPick={(d) =>
                    focusCustomChannel(d, "Focused from value list")
                  }
                />
              )}
              {aggRows && aggRows.length === 0 && (
                <div
                  className="channel-explorer__empty"
                  data-testid="channel-explorer-unresolved"
                >
                  No channels of this view resolve to a value in the displayed
                  result.
                </div>
              )}
            </div>
          )}

          {/* ── Custom channels view (full width) ──────────────────── */}
          {isCustom && (
            <div
              className="channel-explorer__custom"
              data-testid="channel-explorer-custom"
            >
              <div className="channel-explorer__custom-grid">
                {/* Channel list / picker */}
                <div className="channel-explorer__list-col">
                  <ul
                    className="channel-explorer__list"
                    data-testid="channel-explorer-list"
                    aria-label="Channels"
                  >
                    {visibleRows.map((d) => {
                      const isPrimary = d.key === primaryKey;
                      const isPinned = pinned.includes(d.key);
                      return (
                        <li key={d.key} className="channel-explorer__row">
                          <button
                            data-testid={`channel-item-${d.key}`}
                            className="channel-explorer__item"
                            aria-current={isPrimary ? "true" : undefined}
                            onClick={() => pickChannel(d)}
                            title={`${d.label} (${d.channel.entity} ${d.channel.id})`}
                          >
                            <span
                              className="channel-explorer__item-badge"
                              aria-hidden="true"
                            >
                              {KIND_BADGE[d.channel.entity]}
                            </span>
                            <span className="channel-explorer__item-label">
                              {d.label}
                            </span>
                            {isPrimary && (
                              <span className="channel-explorer__showing">
                                Showing
                              </span>
                            )}
                          </button>
                          <button
                            data-testid={`channel-pin-${d.key}`}
                            className="btn btn--ghost btn--sm channel-explorer__pin"
                            aria-pressed={isPinned}
                            aria-label={`${isPinned ? "Unpin" : "Pin"} ${d.label}`}
                            title={
                              isPinned ? "Unpin" : "Pin to the channel set"
                            }
                            onClick={() => togglePin(d)}
                          >
                            {isPinned ? "★" : "☆"}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {overflow > 0 && (
                    <div
                      className="channel-explorer__overflow"
                      data-testid="channel-explorer-overflow"
                      role="status"
                    >
                      Showing first {LIST_RENDER_CAP} of {filtered.length} —
                      refine the search or filters.
                    </div>
                  )}
                  {/* Watchlist: pinned set, or deterministic defaults */}
                  <div
                    className="channel-explorer__watchlist"
                    data-testid="channel-explorer-watchlist"
                  >
                    <div
                      style={{
                        fontSize: "var(--fs-micro)",
                        color: "var(--text-3)",
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        marginBottom: 4,
                      }}
                    >
                      {watchlist.defaults
                        ? `Default channels (up to ${PIN_CAP})`
                        : `Pinned channels (${pinned.length}/${PIN_CAP})`}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {watchlist.channels.map((d) => (
                        <button
                          key={d.key}
                          data-testid={`channel-chip-${d.key}`}
                          className="chip channel-explorer__chip"
                          aria-current={
                            d.key === primaryKey ? "true" : undefined
                          }
                          onClick={() => pickChannel(d)}
                          title={d.label}
                        >
                          {d.elementLabel} · {d.channel.field}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Focused channel */}
                <div className="channel-explorer__main">
                  {primary && (
                    <div className="channel-explorer__primary-head">
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{ fontWeight: 700, color: "var(--text-1)" }}
                          data-testid="channel-explorer-primary-label"
                        >
                          {primary.label}
                        </div>
                        <div
                          style={{
                            fontSize: "var(--fs-cap)",
                            color: "var(--text-3)",
                          }}
                        >
                          {KIND_BADGE[primary.channel.entity]} ·{" "}
                          {primary.channel.id}
                          {primary.signed
                            ? " · sign convention: flow/heat direction"
                            : ""}
                        </div>
                      </div>
                      <span style={{ flex: 1 }} />
                      {focus.dirty && (
                        <button
                          data-testid="channel-explorer-follow-selection"
                          className="btn btn--ghost btn--sm"
                          onClick={() => setFocus(FOLLOW_SELECTION)}
                          title="Stop holding this channel; the primary channel follows the model selection again"
                        >
                          Follow selection
                        </button>
                      )}
                      <button
                        data-testid="channel-explorer-show-on-diagram"
                        className="btn btn--sm"
                        disabled={!primaryExistsLive}
                        title={
                          primaryExistsLive
                            ? "Select this element and pan the diagram to it"
                            : "This element no longer exists in the current model"
                        }
                        onClick={() =>
                          primarySelection && showOnDiagram(primarySelection)
                        }
                      >
                        Show on Diagram
                      </button>
                    </div>
                  )}

                  {primary && primaryData === null && (
                    <div
                      className="channel-explorer__empty"
                      data-testid="channel-explorer-unresolved"
                    >
                      This channel is not present in the displayed result.
                    </div>
                  )}

                  {primary && primaryData?.kind === "series" && (
                    <TransientFocus
                      descriptor={primary}
                      data={primaryData}
                      result={result}
                      rawTimes={rawTimes}
                      effectiveIdx={effectiveIdx}
                      timeIndex={timeIndex}
                      setTimeIndex={setTimeIndex}
                      unitPrefs={unitPrefs}
                      sigFigs={sigFigs}
                      chartHeight={chartHeight}
                      baseline={!live && baseline ? baseline : null}
                      channelByKey={channelByKey}
                      pinned={pinned}
                      locateSeries={locateFocusedSeries}
                      displayConfig={displayConfig}
                    />
                  )}

                  {primary && primaryData?.kind === "scalar" && (
                    <SteadyFocus
                      descriptor={primary}
                      value={primaryData.value}
                      unitPrefs={unitPrefs}
                      sigFigs={sigFigs}
                      baseline={!live && baseline ? baseline : null}
                    />
                  )}
                </div>
              </div>

              {/* Context diagram: Custom-only, full width below the chart. */}
              {primary && (
                <details
                  className="channel-explorer__context-details"
                  data-testid="channel-explorer-context-details"
                >
                  <summary>Diagram context — {primary.elementLabel}</summary>
                  <ContextDiagram
                    displayConfig={displayConfig}
                    channel={primary}
                    onSelect={(sel) => setSelection(sel)}
                  />
                </details>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Aggregate steady bar/value list (full width, accessible)            */
/* ------------------------------------------------------------------ */

function AggregateBarList({
  rows,
  baselineName,
  unitPrefs,
  sigFigs,
  onPick,
}: {
  rows: ReturnType<typeof aggregateRows>;
  baselineName: string | null;
  unitPrefs: ReturnType<typeof useStore.getState>["unitPreferences"];
  sigFigs: number;
  onPick: (d: ChannelDescriptor) => void;
}) {
  const maxAbs = rows.reduce((m, r) => Math.max(m, Math.abs(r.value)), 0);
  return (
    <div
      className="channel-explorer__bars"
      data-testid="channel-explorer-bars"
      role="group"
      aria-label="Aggregate channel values"
    >
      {rows.map((r) => {
        const valueText = formatChannelValue(
          r.value,
          r.descriptor,
          unitPrefs,
          sigFigs,
        );
        const deltaText =
          r.baselineValue !== undefined && r.delta !== undefined
            ? formatChannelDelta(
                r.value,
                r.baselineValue,
                r.descriptor,
                unitPrefs,
                sigFigs,
              )
            : null;
        const pct = maxAbs > 0 ? (Math.abs(r.value) / maxAbs) * 100 : 0;
        const aria =
          `${r.descriptor.label}, ${valueText}` +
          (deltaText !== null && baselineName
            ? `, delta ${deltaText} versus baseline ${baselineName}`
            : "");
        return (
          <button
            key={r.descriptor.key}
            type="button"
            data-testid={`channel-bar-${r.descriptor.key}`}
            className="channel-explorer__bar"
            aria-label={aria}
            title={`${r.descriptor.label} — click to focus in Custom channels`}
            onClick={() => onPick(r.descriptor)}
          >
            <span className="channel-explorer__bar-label">
              {r.descriptor.label}
            </span>
            <span className="channel-explorer__bar-track" aria-hidden="true">
              <span
                className="channel-explorer__bar-fill"
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="channel-explorer__bar-value">{valueText}</span>
            {deltaText !== null && (
              <span
                className="channel-explorer__bar-delta"
                data-testid={`channel-bar-delta-${r.descriptor.key}`}
              >
                Δ {deltaText} vs baseline
                {baselineName ? ` ${baselineName}` : ""}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Transient focus: chart + readout                                    */
/* ------------------------------------------------------------------ */

function TransientFocus({
  descriptor,
  data,
  result,
  rawTimes,
  effectiveIdx,
  timeIndex,
  setTimeIndex,
  unitPrefs,
  sigFigs,
  chartHeight,
  baseline,
  channelByKey,
  pinned,
  locateSeries,
  displayConfig,
}: {
  descriptor: ChannelDescriptor;
  data: { kind: "series"; times: number[]; values: number[] };
  /** The displayed result (transient when a series resolved). */
  result: SteadyResult | TransientResult;
  rawTimes: number[];
  effectiveIdx: number;
  timeIndex: number | null;
  setTimeIndex: (i: number | null) => void;
  unitPrefs: ReturnType<typeof useStore.getState>["unitPreferences"];
  sigFigs: number;
  chartHeight: number;
  baseline: ChannelExplorerBaseline | null;
  channelByKey: Map<string, ChannelDescriptor>;
  pinned: string[];
  locateSeries: (id: string) => void;
  displayConfig: NetworkConfig;
}) {
  // Pinned same-quantity overlays on the primary's resolved grid only
  // (channels with a ragged grid are skipped rather than misaligned).
  const overlays = useMemo(() => {
    const out: Array<{ key: string; label: string; values: number[] }> = [];
    for (const key of pinned) {
      if (key === descriptor.key) continue;
      const d = channelByKey.get(key);
      if (!d || !sameQuantity(d, descriptor)) continue;
      const resolved = resolveChannel(result, d.channel);
      if (!resolved || resolved.kind !== "series") continue;
      if (!sameTimeGrid(resolved.times, data.times)) continue;
      out.push({ key: d.key, label: d.label, values: resolved.values });
    }
    return out;
  }, [pinned, channelByKey, descriptor, result, data.times]);

  const baselineValues = useMemo(
    () =>
      baseline
        ? baselineSeries(baseline.result, result, descriptor.channel)
        : null,
    [baseline, result, descriptor],
  );

  const series: Series[] = useMemo(
    () =>
      composeChartSeries({
        primary: {
          key: descriptor.key,
          label: descriptor.label,
          values: data.values,
        },
        overlays,
        baseline: baselineValues ? { values: baselineValues } : null,
      }).map((s) => ({
        ...s,
        color: s.matchColorOf ? undefined : seriesColor(s.id),
      })),
    [descriptor, data.values, overlays, baselineValues],
  );

  // Commit mapping: chart indices address the RESOLVED (finite-filtered)
  // grid; the global timeIndex addresses the raw accepted-step grid (same
  // semantics as resolveChannelAt and the canvas scrubber).
  const rawIndexByTime = useMemo(
    () => new Map(rawTimes.map((t, i) => [t, i])),
    [rawTimes],
  );
  const commitCursor = (chartIdx: number) => {
    const t = data.times[chartIdx];
    const raw = t !== undefined ? rawIndexByTime.get(t) : undefined;
    setTimeIndex(raw ?? chartIdx);
  };

  const readout = resolveChannelAt(result, descriptor.channel, timeIndex);
  const cursorTime = rawTimes[effectiveIdx];
  const atFinal = timeIndex === null;
  const timeFmt = (t: number | undefined) =>
    t === undefined ? "—" : formatWithUnit(t, "time", unitPrefs, sigFigs);

  return (
    <div data-testid="channel-explorer-transient">
      <InteractiveChart
        dataTestid="channel-explorer-chart"
        exportTestid="channel-explorer-chart"
        series={series}
        times={data.times}
        xLabel="Time"
        yLabel={descriptor.label}
        yQuantityKind={descriptor.quantity}
        {...(descriptor.rawUnit !== undefined
          ? { yUnitLabel: descriptor.rawUnit }
          : {})}
        xQuantityKind="time"
        height={chartHeight}
        cursorTime={cursorTime}
        onCursorCommit={commitCursor}
        onSeriesLocate={locateSeries}
        provenanceConfig={displayConfig}
      />
      {/* Scalar readout at the global timeIndex (set by the Diagram
          scrubber or by clicking/arrow-stepping the chart itself — the
          Analysis view carries no time bar of its own). */}
      <div
        className="channel-explorer__readout"
        data-testid="channel-explorer-readout"
      >
        <span
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: "var(--text-1)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {readout !== null
            ? formatChannelValue(readout, descriptor, unitPrefs, sigFigs)
            : "—"}
        </span>
        <span style={{ color: "var(--text-2)", fontSize: "var(--fs-cap)" }}>
          at t = {timeFmt(cursorTime)}
          {atFinal ? " (final)" : ""}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Steady focus: prominent scalar + baseline delta                     */
/* ------------------------------------------------------------------ */

function SteadyFocus({
  descriptor,
  value,
  unitPrefs,
  sigFigs,
  baseline,
}: {
  descriptor: ChannelDescriptor;
  value: number;
  unitPrefs: ReturnType<typeof useStore.getState>["unitPreferences"];
  sigFigs: number;
  baseline: ChannelExplorerBaseline | null;
}) {
  const base = baseline
    ? baselineScalar(baseline.result, descriptor.channel)
    : null;
  return (
    <div
      className="channel-explorer__scalar"
      data-testid="channel-explorer-scalar"
    >
      <div className="result-card-label">{descriptor.label}</div>
      <div
        className="result-card-value"
        data-testid="channel-explorer-scalar-value"
        style={{ fontSize: 28 }}
      >
        {formatChannelValue(value, descriptor, unitPrefs, sigFigs)}
      </div>
      {base !== null && baseline && (
        <div
          className="result-card-detail"
          data-testid="channel-explorer-baseline-delta"
        >
          Δ {formatChannelDelta(value, base, descriptor, unitPrefs, sigFigs)} vs
          baseline <strong>{baseline.name}</strong> (baseline{" "}
          {formatChannelValue(base, descriptor, unitPrefs, sigFigs)})
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Context diagram (read-only one-hop SVG)                             */
/* ------------------------------------------------------------------ */

/* The same families as the canvas (see canvasPalette): a reader moving between
   the drawing and this thumbnail should not have to relearn which network is
   which. Focus is amber, as selection is everywhere else — which is why no
   element type may be. */
const DIAGRAM_COLORS = {
  fluidFill: "#292929",
  fluidStroke: NODE_FLUID,
  solidFill: "#353535",
  solidStroke: NODE_SOLID,
  branch: EDGE_BRANCH,
  conductor: EDGE_CONDUCTOR,
  focused: "#c99a43",
  text: "#b5b5b5",
  textHi: "#e6e6e6",
};

function ContextDiagram({
  displayConfig,
  channel,
  onSelect,
}: {
  displayConfig: NetworkConfig;
  channel: ChannelDescriptor;
  onSelect: (sel: Selection) => void;
}) {
  const graph = useMemo(
    () => buildContextGraph(displayConfig, channel.channel),
    [displayConfig, channel],
  );
  const layout = useMemo(
    () => layoutContextGraph(graph, { width: 300, height: 200, padding: 34 }),
    [graph],
  );
  const summary = useMemo(() => summarizeContextGraph(graph), [graph]);
  const nodeById = useMemo(
    () => new Map(layout.nodes.map((n) => [n.id, n])),
    [layout.nodes],
  );

  if (layout.nodes.length === 0) {
    return (
      <div
        className="channel-explorer__context"
        data-testid="channel-explorer-context-empty"
      >
        <div className="channel-explorer__context-title">Context</div>
        <div style={{ color: "var(--text-3)", fontSize: "var(--fs-cap)" }}>
          No placeable topology context for this channel in the captured config.
        </div>
      </div>
    );
  }

  const activate = (sel: Selection) => (e: React.SyntheticEvent) => {
    e.stopPropagation();
    onSelect(sel);
  };
  const keyActivate = (sel: Selection) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      onSelect(sel);
    }
  };

  return (
    <div className="channel-explorer__context">
      <div className="channel-explorer__context-title">Context</div>
      <svg
        data-testid="channel-explorer-context"
        role="img"
        aria-label={summary}
        viewBox={layout.viewBox}
        width={layout.width}
        height={layout.height}
        style={{ display: "block", maxWidth: "100%" }}
      >
        <title>{`Topology context around ${channel.elementLabel}`}</title>
        <desc>{summary}</desc>
        {layout.edges.map((e) => {
          const a = nodeById.get(e.from);
          const b = nodeById.get(e.to);
          if (!a || !b) return null;
          const sel: Selection = { kind: e.kind, id: e.id };
          const stroke = e.focused
            ? DIAGRAM_COLORS.focused
            : e.kind === "branch"
              ? DIAGRAM_COLORS.branch
              : DIAGRAM_COLORS.conductor;
          return (
            <g
              key={`${e.kind}:${e.id}`}
              role="button"
              tabIndex={0}
              aria-label={`Select ${e.kind} ${e.id}`}
              onClick={activate(sel)}
              onKeyDown={keyActivate(sel)}
              style={{ cursor: "pointer" }}
            >
              {/* fat transparent hit area under the visible stroke */}
              <line
                x1={a.cx}
                y1={a.cy}
                x2={b.cx}
                y2={b.cy}
                stroke="transparent"
                strokeWidth={12}
              />
              <line
                x1={a.cx}
                y1={a.cy}
                x2={b.cx}
                y2={b.cy}
                stroke={stroke}
                strokeWidth={e.focused ? 2.5 : 1.5}
                strokeDasharray={e.kind === "conductor" ? "5 3" : undefined}
              />
              <text
                x={(a.cx + b.cx) / 2}
                y={(a.cy + b.cy) / 2 - 4}
                textAnchor="middle"
                fontSize={8.5}
                fill={DIAGRAM_COLORS.text}
              >
                {e.id}
              </text>
            </g>
          );
        })}
        {layout.nodes.map((n) => {
          const sel: Selection = { kind: n.kind, id: n.id };
          const stroke = n.focused
            ? DIAGRAM_COLORS.focused
            : n.kind === "node"
              ? DIAGRAM_COLORS.fluidStroke
              : DIAGRAM_COLORS.solidStroke;
          const fill =
            n.kind === "node"
              ? DIAGRAM_COLORS.fluidFill
              : DIAGRAM_COLORS.solidFill;
          return (
            <g
              key={`${n.kind}:${n.id}`}
              role="button"
              tabIndex={0}
              aria-label={`Select ${n.kind === "node" ? "fluid node" : "solid node"} ${n.label}`}
              onClick={activate(sel)}
              onKeyDown={keyActivate(sel)}
              style={{ cursor: "pointer" }}
            >
              {n.kind === "node" ? (
                <circle
                  cx={n.cx}
                  cy={n.cy}
                  r={n.focused ? 11 : 9}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={n.focused ? 2.5 : 1.5}
                />
              ) : (
                <rect
                  x={n.cx - (n.focused ? 11 : 9)}
                  y={n.cy - (n.focused ? 11 : 9)}
                  width={n.focused ? 22 : 18}
                  height={n.focused ? 22 : 18}
                  rx={3}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={n.focused ? 2.5 : 1.5}
                />
              )}
              <text
                x={n.cx}
                y={n.cy + (n.focused ? 24 : 21)}
                textAnchor="middle"
                fontSize={9}
                fontWeight={n.focused ? 700 : 400}
                fill={n.focused ? DIAGRAM_COLORS.textHi : DIAGRAM_COLORS.text}
              >
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>
      {/* Legend: shape + dash carry the meaning, not color alone */}
      <div
        className="channel-explorer__legend"
        data-testid="channel-explorer-context-legend"
        aria-hidden="true"
      >
        <span>
          <svg width="14" height="10">
            <circle
              cx="7"
              cy="5"
              r="4"
              fill={DIAGRAM_COLORS.fluidFill}
              stroke={DIAGRAM_COLORS.fluidStroke}
            />
          </svg>{" "}
          fluid node
        </span>
        <span>
          <svg width="14" height="10">
            <rect
              x="3"
              y="1"
              width="8"
              height="8"
              rx="2"
              fill={DIAGRAM_COLORS.solidFill}
              stroke={DIAGRAM_COLORS.solidStroke}
            />
          </svg>{" "}
          solid node
        </span>
        <span>
          <svg width="16" height="10">
            <line
              x1="1"
              y1="5"
              x2="15"
              y2="5"
              stroke={DIAGRAM_COLORS.branch}
              strokeWidth="1.5"
            />
          </svg>{" "}
          branch
        </span>
        <span>
          <svg width="16" height="10">
            <line
              x1="1"
              y1="5"
              x2="15"
              y2="5"
              stroke={DIAGRAM_COLORS.conductor}
              strokeWidth="1.5"
              strokeDasharray="4 2"
            />
          </svg>{" "}
          conductor
        </span>
        <span>
          <svg width="14" height="10">
            <circle
              cx="7"
              cy="5"
              r="4"
              fill="none"
              stroke={DIAGRAM_COLORS.focused}
              strokeWidth="2"
            />
          </svg>{" "}
          focused
        </span>
      </div>
    </div>
  );
}
