/**
 * ResultPlots — a tab per plot, and the plot itself.
 *
 * A plot is an x axis and a list of channels; that is the entire model. There
 * is no "profile mode" or "trend mode" deciding which question the analyst
 * came to ask — choose an axis, add channels. Plotting against `station` gives
 * the grade line, against `time` the transient trace, against `positionX` the
 * spatial distribution, and none of them is presumed.
 *
 * The tabs are the app's ordinary tabs (`.tab`, same as the workspace strip and
 * the Configuration sections) so they read as tabs without having to be
 * learned. Plots live in the store, so leaving the Runs tab does not discard
 * them.
 */
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import type {
  NetworkConfig,
  Selection,
  SteadyResult,
  TransientResult,
} from "../types";
import { QUANTITY_LABELS, type QuantityKind } from "../units";
import InteractiveChart, { type Series } from "./InteractiveChart";
import PlotChannelPicker, {
  type PickerGrouping,
  type PickerKind,
} from "./PlotChannelPicker";
import { listFlowPaths, resolveFlowPath } from "../flowPath";
import { selectionForChannel, type ChannelDescriptor } from "../channels";
import { presetChannels, presetsForInventory } from "../channelViews";
import { buildPlotData, resampleOnto } from "../plotSeries";
import {
  PLOT_CHANNEL_CAP,
  PLOT_COMPARE_CAP,
  coercePlotAxis,
  compareRunIds,
  derivePlotName,
  isSpatialAxis,
  newPlot,
  plotChannels,
  setPlotChannels,
  toggleCompareRun,
  togglePlotChannel,
  xAxesFor,
  type PlotXAxis,
  type ResultPlot,
} from "../resultPlots";

export interface ResultPlotsBaseline {
  name: string;
  result: SteadyResult | TransientResult;
}

/** A run available to overlay: its own captured config and result. */
export interface ComparableRun {
  id: string;
  name: string;
  config: NetworkConfig;
  result: SteadyResult | TransientResult;
}

export interface ResultPlotsProps {
  displayConfig: NetworkConfig;
  result: SteadyResult | TransientResult;
  baseline?: ResultPlotsBaseline | null;
  channels: readonly ChannelDescriptor[];
  /** Other runs the analyst can overlay on any plot. */
  comparableRuns?: readonly ComparableRun[];
  /** Name of the displayed run, shown as the plot's own (unremovable) chip. */
  primaryRunName?: string;
  chartHeight?: number;
  /** Reported upward so the container can export exactly what is drawn. */
  onDisplayedChannelsChange?: (channels: ChannelDescriptor[]) => void;
}

function axisLabel(quantity: QuantityKind, rawUnit?: string): string {
  const base = QUANTITY_LABELS[quantity] ?? quantity;
  return rawUnit ? `${base} (${rawUnit})` : base;
}

export default function ResultPlots({
  displayConfig,
  result,
  baseline = null,
  channels,
  comparableRuns = [],
  primaryRunName,
  chartHeight = 320,
  onDisplayedChannelsChange,
}: ResultPlotsProps) {
  const plots = useStore((s) => s.resultPlots);
  const activePlotId = useStore((s) => s.activePlotId);
  const addPlot = useStore((s) => s.addResultPlot);
  const removePlot = useStore((s) => s.removeResultPlot);
  const setActivePlot = useStore((s) => s.setActiveResultPlot);
  const updatePlot = useStore((s) => s.updateResultPlot);
  const seedPlot = useStore((s) => s.seedResultPlot);
  const setSelection = useStore((s) => s.setSelection);
  const timeIndex = useStore((s) => s.timeIndex);
  const setTimeIndex = useStore((s) => s.setTimeIndex);
  const unitPrefs = useStore((s) => s.unitPreferences);
  const sigFigs = useStore((s) => s.resultSigFigs);

  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<PickerKind>("all");
  const [grouping, setGrouping] = useState<PickerGrouping>("quantity");
  const [renaming, setRenaming] = useState<string | null>(null);

  const transient = Array.isArray((result as TransientResult).times);
  const mode: "steady" | "transient" = transient ? "transient" : "steady";
  const rawTimes = transient ? (result as TransientResult).times : [];

  // The first plot is built during render, not in the effect that persists it,
  // so the very first paint already shows an empty plot to fill rather than a
  // blank frame. The effect stores that same object, ids included.
  const [firstPlot] = useState(() => newPlot(mode));
  useEffect(() => {
    if (plots.length === 0) seedPlot(firstPlot);
  }, [plots.length, firstPlot, seedPlot]);

  const stored =
    plots.find((p) => p.id === activePlotId) ?? plots[0] ?? firstPlot;
  // A plot can outlive the mode it was made for (a time axis, then a steady run).
  const plot: ResultPlot = coercePlotAxis(stored, mode);

  const drawn = useMemo(() => plotChannels(plot, channels), [plot, channels]);
  const capped = useMemo(() => drawn.slice(0, PLOT_CHANNEL_CAP), [drawn]);
  const displayedKeys = capped.map((c) => c.key).join("|");
  useEffect(() => {
    onDisplayedChannelsChange?.(capped);
    // Identity churns every render; the keys are what actually changed.
  }, [displayedKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  const presets = useMemo(
    () => presetsForInventory(channels, mode),
    [channels, mode],
  );

  const spatial = isSpatialAxis(plot.xAxis);
  const paths = useMemo(
    () =>
      plot.xAxis === "station"
        ? listFlowPaths(displayConfig, result, { timeIndex })
        : [],
    [plot.xAxis, displayConfig, result, timeIndex],
  );
  const path = useMemo(
    () => resolveFlowPath(paths, plot.pathId),
    [paths, plot.pathId],
  );

  const data = useMemo(
    () =>
      buildPlotData({
        channels: capped,
        xAxis: plot.xAxis,
        config: displayConfig,
        result,
        path,
        timeIndex,
      }),
    [plot, capped, displayConfig, result, path, timeIndex],
  );

  /**
   * Every run drawn on top of the displayed one: the pinned baseline, then
   * whatever the analyst added. One list, one code path — a baseline overlay
   * and a compared run differ only in how they got here.
   *
   * Each is resolved against ITS OWN captured config, so a variant that moved
   * a node or lengthened a pipe is plotted where that run actually put it.
   */
  // Keyed by content so the overlay memo is not invalidated by a fresh array
  // on every render of an unchanged plot.
  const compareKey = compareRunIds(plot).join("|");
  const selectedCompareIds = useMemo(
    () => (compareKey ? compareKey.split("|") : []),
    [compareKey],
  );
  const overlays = useMemo(() => {
    const runs: Array<{ key: string; name: string; run: ComparableRun }> = [];
    if (baseline)
      runs.push({
        key: "baseline",
        name: baseline.name,
        run: {
          id: "baseline",
          name: baseline.name,
          config: displayConfig,
          result: baseline.result,
        },
      });
    for (const id of selectedCompareIds.slice(0, PLOT_COMPARE_CAP)) {
      const run = comparableRuns.find((r) => r.id === id);
      if (run) runs.push({ key: `run:${run.id}`, name: run.name, run });
    }
    return runs.map((entry) => ({
      ...entry,
      data: buildPlotData({
        channels: capped,
        xAxis: plot.xAxis,
        config: entry.run.config,
        result: entry.run.result,
        path,
        timeIndex,
      }),
    }));
  }, [
    plot,
    capped,
    displayConfig,
    baseline,
    comparableRuns,
    selectedCompareIds,
    path,
    timeIndex,
  ]);

  /** Compared runs that landed nothing on this plot, so we can say so. */
  const emptyOverlays = overlays.filter(
    (o) => o.key !== "baseline" && o.data.axes.length === 0,
  );

  /** Persist a change, re-deriving the name while the user has not claimed it. */
  const patch = (next: ResultPlot) => {
    const name = next.renamed
      ? next.name
      : derivePlotName(next, plotChannels(next, channels));
    const withName = { ...next, name };
    // Before the seeding effect lands, the plot on screen is not in the store
    // yet; seed it with the edit rather than dropping the edit.
    if (plots.some((p) => p.id === next.id)) updatePlot(next.id, withName);
    else seedPlot(withName);
  };

  const axes = xAxesFor(mode);

  /**
   * The x-axis control, rendered by the chart in its axis label's place: the
   * axis is chosen AT the axis rather than in a toolbar somewhere above it.
   */
  const xAxisControl = (
    <span className="plot-axis-control">
      <label className="visually-hidden" htmlFor="plot-x-axis">
        X axis
      </label>
      <select
        id="plot-x-axis"
        data-testid="plot-x-axis"
        className="plot-axis-control__select"
        value={plot.xAxis}
        onChange={(e) => patch({ ...plot, xAxis: e.target.value as PlotXAxis })}
      >
        {axes.map((a) => (
          <option key={a.id} value={a.id} title={a.hint}>
            {a.label}
          </option>
        ))}
      </select>
      {plot.xAxis === "station" && paths.length > 0 && (
        <>
          <label className="visually-hidden" htmlFor="plot-path">
            Flow path
          </label>
          <select
            id="plot-path"
            data-testid="plot-path"
            className="plot-axis-control__select"
            value={path?.id ?? ""}
            onChange={(e) => patch({ ...plot, pathId: e.target.value })}
          >
            {paths.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.kind === "circuit" ? " (loop)" : ""}
              </option>
            ))}
          </select>
        </>
      )}
    </span>
  );

  /**
   * Which runs this plot draws. A plot belongs to a question ("is the new
   * orifice better?"), not to a run, so the run set is per-plot rather than
   * a global mode — one tab can compare two designs while the next reads the
   * latest run on its own.
   */
  const unselected = comparableRuns.filter(
    (r) => !selectedCompareIds.includes(r.id),
  );
  const atCap = selectedCompareIds.length >= PLOT_COMPARE_CAP;
  const compareControl =
    comparableRuns.length === 0 ? null : (
      <div className="plot-compare" data-testid="plot-compare">
        <span className="plot-compare__label">Runs</span>
        {primaryRunName && (
          <span
            className="plot-compare__chip"
            data-testid="plot-compare-primary"
          >
            {primaryRunName}
          </span>
        )}
        {selectedCompareIds.map((id) => {
          const run = comparableRuns.find((r) => r.id === id);
          if (!run) return null;
          return (
            <span
              key={id}
              className="plot-compare__chip plot-compare__chip--added"
              data-testid={`plot-compare-chip-${id}`}
            >
              {run.name}
              <button
                type="button"
                className="plot-compare__remove"
                data-testid={`plot-compare-remove-${id}`}
                aria-label={`Stop comparing ${run.name}`}
                onClick={() => patch(toggleCompareRun(plot, id))}
              >
                ×
              </button>
            </span>
          );
        })}
        {unselected.length > 0 && (
          <>
            <label className="visually-hidden" htmlFor="plot-compare-add">
              Compare another run
            </label>
            <select
              id="plot-compare-add"
              data-testid="plot-compare-add"
              className="plot-compare__add"
              value=""
              disabled={atCap}
              title={
                atCap
                  ? `At most ${PLOT_COMPARE_CAP} runs can be compared on one plot`
                  : "Overlay another run's values for these same channels"
              }
              onChange={(e) => {
                if (e.target.value)
                  patch(toggleCompareRun(plot, e.target.value));
              }}
            >
              <option value="">+ Compare run…</option>
              {unselected.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </>
        )}
        {emptyOverlays.length > 0 && (
          <span
            className="plot-compare__note"
            data-testid="plot-compare-note"
            role="status"
          >
            {emptyOverlays.map((o) => o.name).join(", ")} has nothing to draw on
            this axis.
          </span>
        )}
      </div>
    );

  return (
    <div className="result-plots" data-testid="result-plots">
      {/* Ordinary app tabs, so they read as tabs without explanation. */}
      <div
        className="tabs result-plots__tabs"
        role="tablist"
        aria-label="Plots"
      >
        {(plots.length > 0 ? plots : [plot]).map((p) => {
          const active = p.id === plot.id;
          if (renaming === p.id)
            return (
              <PlotNameInput
                key={p.id}
                name={p.name}
                onCommit={(name) => {
                  if (name.trim())
                    updatePlot(p.id, { name: name.trim(), renamed: true });
                  setRenaming(null);
                }}
                onCancel={() => setRenaming(null)}
              />
            );
          return (
            <div
              key={p.id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              className="tab"
              data-testid={`plot-tab-${p.id}`}
              title={`${p.name} — double-click to rename`}
              onClick={() => setActivePlot(p.id)}
              onDoubleClick={() => setRenaming(p.id)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                if (e.target !== e.currentTarget) return;
                e.preventDefault();
                setActivePlot(p.id);
              }}
            >
              {p.name}
              {plots.length > 1 && (
                <button
                  type="button"
                  className="tab__close"
                  data-testid={`plot-close-${p.id}`}
                  aria-label={`Close ${p.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    removePlot(p.id);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
        <button
          type="button"
          className="tab result-plots__add"
          data-testid="plot-add"
          title="New plot"
          onClick={() => addPlot(mode)}
        >
          + Plot
        </button>
      </div>

      <div className="result-plots__body">
        <PlotChannelPicker
          channels={channels}
          displayConfig={displayConfig}
          result={result}
          timeIndex={timeIndex}
          unitPrefs={unitPrefs}
          sigFigs={sigFigs}
          plotted={plot.channels}
          presets={presets}
          query={query}
          onQueryChange={setQuery}
          kind={kindFilter}
          onKindChange={setKindFilter}
          grouping={grouping}
          onGroupingChange={setGrouping}
          onPickPreset={(preset) =>
            patch(
              setPlotChannels(
                plot,
                presetChannels(channels, preset).channels.map((c) => c.key),
              ),
            )
          }
          onToggleChannel={(d) => {
            patch(togglePlotChannel(plot, d.key));
            const sel = selectionForChannel(d);
            if (sel) setSelection(sel as Selection);
          }}
          onClear={() => patch(setPlotChannels(plot, []))}
        />

        <div className="result-plots__plot">
          {compareControl}
          {drawn.length === 0 ? (
            // The axis is offered even before there is a chart to hang it
            // on, so it can be set up front rather than only corrected after.
            <div
              className="channel-explorer__empty"
              data-testid="plot-no-channels"
            >
              Pick channels on the left to plot them.
              <div className="plot-axis-control__standalone">
                {xAxisControl}
              </div>
            </div>
          ) : !data || data.axes.length === 0 ? (
            // The axis control comes too: an unresolved axis is exactly when
            // the user needs to change it, and there is no chart to host it.
            <div
              className="channel-explorer__empty"
              data-testid="plot-unresolved"
            >
              {plot.xAxis === "station" && paths.length === 0
                ? "No flow path to plot along: this result carries no mass flow. Choose another x axis."
                : "None of these channels resolve on this axis."}
              <div className="plot-axis-control__standalone">
                {xAxisControl}
              </div>
            </div>
          ) : (
            <>
              {data.skipped.length > 0 && (
                <div
                  className="channel-explorer__aggregate-note"
                  data-testid="plot-skipped-note"
                  role="status"
                >
                  {data.skipped.length} channel
                  {data.skipped.length === 1 ? "" : "s"} not on this axis:{" "}
                  {data.skipped
                    .slice(0, 3)
                    .map((d) => d.label)
                    .join(", ")}
                  {data.skipped.length > 3 ? "…" : ""}
                </div>
              )}
              {drawn.length > capped.length && (
                <div
                  className="channel-explorer__aggregate-note"
                  data-testid="plot-cap-note"
                  role="status"
                >
                  Drawing the first {capped.length} of {drawn.length} channels
                  (cap {PLOT_CHANNEL_CAP}).
                </div>
              )}
              {spatial && data.ordinal && (
                <div
                  className="channel-explorer__aggregate-note"
                  data-testid="plot-ordinal-note"
                  role="status"
                >
                  No distance available on this axis, so it is an index.
                </div>
              )}

              {data.axes.map((axis, i) => {
                /**
                 * A compared run keeps the colour of the channel it mirrors
                 * and is drawn dashed, so the eye groups by QUANTITY first
                 * and tells the runs apart second — the order in which the
                 * question "which design was better?" is actually asked.
                 */
                const overlaid: Series[] = overlays.flatMap((o) => {
                  const group = o.data.axes.find(
                    (a) =>
                      a.quantity === axis.quantity &&
                      a.rawUnit === axis.rawUnit,
                  );
                  if (!group) return [];
                  return group.series.map((s) => ({
                    id: `${o.key}:${s.id}`,
                    label: `${s.label} · ${o.name}`,
                    values: resampleOnto(data.x, o.data.x, s.values, s.step),
                    dashed: true,
                    opacity: 0.7,
                    matchColorOf: s.id,
                    ...(s.step ? { step: true } : {}),
                  }));
                });
                const series: Series[] = [
                  ...axis.series.map((s) => ({
                    id: s.id,
                    label:
                      overlays.length > 0 && primaryRunName
                        ? `${s.label} · ${primaryRunName}`
                        : s.label,
                    values: s.values,
                    ...(s.step ? { step: true } : {}),
                  })),
                  ...overlaid,
                ];
                return (
                  <div
                    className="channel-explorer__chart"
                    key={`${axis.quantity}-${axis.rawUnit ?? ""}-${i}`}
                  >
                    <InteractiveChart
                      dataTestid={i === 0 ? "plot-chart" : `plot-chart-${i}`}
                      exportTestid={i === 0 ? "plot-chart" : `plot-chart-${i}`}
                      series={series}
                      times={data.x}
                      xLabel={data.xLabel}
                      xQuantityKind={data.xQuantity}
                      yLabel={axisLabel(axis.quantity, axis.rawUnit)}
                      yQuantityKind={axis.quantity}
                      {...(axis.rawUnit !== undefined
                        ? { yUnitLabel: axis.rawUnit }
                        : {})}
                      height={chartHeight}
                      xAxisControl={xAxisControl}
                      {...(plot.xAxis === "time"
                        ? {
                            cursorTime:
                              rawTimes[timeIndex ?? rawTimes.length - 1],
                            onCursorCommit: (idx: number) => setTimeIndex(idx),
                          }
                        : {})}
                      provenanceConfig={displayConfig}
                    />
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Inline tab rename: commit on blur/Enter, Escape reverts. */
function PlotNameInput({
  name,
  onCommit,
  onCancel,
}: {
  name: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(name);
  return (
    <input
      className="input result-plots__rename"
      data-testid="plot-rename"
      autoFocus
      value={draft}
      aria-label="Plot name"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(draft);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}
