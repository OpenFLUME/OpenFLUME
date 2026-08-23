/**
 * PlotChannelPicker — choose what one plot draws.
 *
 * Two problems this shape solves. First, what is currently plotted has to be
 * obvious: the chosen channels sit in their own **Plotted** block at the top,
 * so the answer is never somewhere down a scrolling list. Second, the controls
 * have to announce what they do — a row of toggle buttons reads as neither a
 * filter nor a sort. So the toolbar is the familiar one: a search box, a sort
 * control behind the sort glyph, and a filter control behind the funnel, all on
 * one line, with element glyphs in the filter menu.
 *
 * Rows read like the project outline deliberately: the same canvas glyphs, the
 * same full-width hover surface, values right-aligned in a column.
 */
import { useMemo } from "react";
import type { UnitPreferences } from "../units";
import EntityGlyph, { type EntityGlyphSpec } from "./EntityGlyph";
import PickerMenu, { FilterIcon, SortIcon } from "./PickerMenu";
import {
  resolveChannelAt,
  type ChannelDescriptor,
  type ChannelEntityKind,
} from "../channels";
import { formatChannelValue, matchesQuery } from "../channelExplorer";
import type { ChannelViewPreset } from "../channelViews";
import type { NetworkConfig, SteadyResult, TransientResult } from "../types";

/** How the list is bucketed. Quantity first: it answers "show me pressures". */
export type PickerGrouping = "quantity" | "element";
/** Entity-type filter; "all" is the default. */
export type PickerKind = "all" | ChannelEntityKind;

export interface PlotChannelPickerProps {
  channels: readonly ChannelDescriptor[];
  displayConfig: NetworkConfig;
  result: SteadyResult | TransientResult | null;
  timeIndex: number | null;
  unitPrefs: UnitPreferences;
  sigFigs: number;
  /** Keys the active plot draws, in plot order. */
  plotted: readonly string[];
  presets: readonly ChannelViewPreset[];
  query: string;
  onQueryChange: (q: string) => void;
  kind: PickerKind;
  onKindChange: (k: PickerKind) => void;
  grouping: PickerGrouping;
  onGroupingChange: (g: PickerGrouping) => void;
  onPickPreset: (preset: ChannelViewPreset) => void;
  onToggleChannel: (d: ChannelDescriptor) => void;
  onClear: () => void;
  /** Cap on rendered rows; large networks list thousands of channels. */
  renderCap?: number;
}

const KIND_GLYPH: Record<ChannelEntityKind, EntityGlyphSpec> = {
  node: { entity: "node", type: "internal" },
  branch: { entity: "branch", component: "pipe" },
  solidNode: { entity: "solidNode", type: "solid" },
  conductor: { entity: "conductor", kind: "convection" },
};

const KIND_OPTIONS: Array<{ value: PickerKind; label: string }> = [
  { value: "all", label: "All types" },
  { value: "node", label: "Fluid nodes" },
  { value: "branch", label: "Branches" },
  { value: "solidNode", label: "Solid nodes" },
  { value: "conductor", label: "Conductors" },
];

const SORT_OPTIONS: Array<{ value: PickerGrouping; label: string }> = [
  { value: "quantity", label: "Quantity" },
  { value: "element", label: "Element" },
];

interface PickerGroup {
  key: string;
  label: string;
  rows: ChannelDescriptor[];
}

/** Element glyph for a channel, using the real component type when known. */
function glyphFor(
  d: ChannelDescriptor,
  config: NetworkConfig,
): EntityGlyphSpec {
  const { entity, id } = d.channel;
  if (entity === "branch") {
    const branch = config.branches?.find((b) => b.id === id);
    if (branch)
      return { entity: "branch", component: branch.component?.type ?? "pipe" };
  }
  if (entity === "node") {
    const node = config.nodes?.find((n) => n.id === id);
    if (node)
      return {
        entity: "node",
        type: node.type === "boundary" ? "boundary" : "internal",
      };
  }
  if (entity === "conductor") {
    const cond = config.conductors?.find((c) => c.id === id);
    if (cond)
      return { entity: "conductor", kind: cond.type?.kind ?? "convection" };
  }
  return KIND_GLYPH[entity];
}

export default function PlotChannelPicker({
  channels,
  displayConfig,
  result,
  timeIndex,
  unitPrefs,
  sigFigs,
  plotted,
  presets,
  query,
  onQueryChange,
  kind,
  onKindChange,
  grouping,
  onGroupingChange,
  onPickPreset,
  onToggleChannel,
  onClear,
  renderCap = 400,
}: PlotChannelPickerProps) {
  const plottedSet = useMemo(() => new Set(plotted), [plotted]);
  const byKey = useMemo(
    () => new Map(channels.map((c) => [c.key, c])),
    [channels],
  );
  const plottedRows = useMemo(
    () =>
      plotted
        .map((key) => byKey.get(key))
        .filter((d): d is ChannelDescriptor => d !== undefined),
    [plotted, byKey],
  );

  const filtered = useMemo(
    () =>
      channels.filter(
        (d) =>
          (kind === "all" || d.channel.entity === kind) &&
          matchesQuery(d, query),
      ),
    [channels, kind, query],
  );

  const groups = useMemo<PickerGroup[]>(() => {
    const map = new Map<string, PickerGroup>();
    let rendered = 0;
    for (const d of filtered) {
      if (rendered >= renderCap) break;
      const key =
        grouping === "element"
          ? `${d.channel.entity}:${d.channel.id}`
          : d.quantity;
      const label =
        grouping === "element"
          ? d.elementLabel
          : (d.label.split(" · ").pop() ?? d.quantity);
      const group = map.get(key) ?? { key, label, rows: [] };
      group.rows.push(d);
      map.set(key, group);
      rendered++;
    }
    return [...map.values()];
  }, [filtered, grouping, renderCap]);

  const shown = groups.reduce((n, g) => n + g.rows.length, 0);
  const overflow = filtered.length - shown;

  const valueOf = (d: ChannelDescriptor): string => {
    const v = resolveChannelAt(result, d.channel, timeIndex);
    return v === null ? "—" : formatChannelValue(v, d, unitPrefs, sigFigs);
  };

  const row = (d: ChannelDescriptor, inPlotted: boolean) => (
    <button
      key={`${inPlotted ? "sel" : "all"}-${d.key}`}
      type="button"
      className={
        plottedSet.has(d.key)
          ? "channel-rail__row channel-rail__row--active"
          : "channel-rail__row"
      }
      data-testid={`${inPlotted ? "plotted" : "plot"}-channel-${d.key}`}
      aria-pressed={plottedSet.has(d.key)}
      onClick={() => onToggleChannel(d)}
      title={`${d.label} — ${plottedSet.has(d.key) ? "remove from" : "add to"} this plot`}
    >
      <EntityGlyph
        {...glyphFor(d, displayConfig)}
        size={14}
        className="channel-rail__glyph"
      />
      <span className="channel-rail__label">
        {inPlotted || grouping === "quantity"
          ? d.label
          : (d.label.split(" · ").pop() ?? d.label)}
      </span>
      <span className="channel-rail__value">{valueOf(d)}</span>
      {inPlotted && (
        <span className="channel-rail__remove" aria-hidden="true">
          ×
        </span>
      )}
    </button>
  );

  return (
    <div className="channel-rail" data-testid="plot-channel-picker">
      {/* One line: search, sort, filter — the familiar trio. */}
      <div className="channel-rail__toolbar">
        <label className="visually-hidden" htmlFor="plot-channel-search">
          Search channels
        </label>
        <input
          id="plot-channel-search"
          data-testid="plot-channel-search"
          className="input channel-rail__search-input"
          type="search"
          placeholder="Search channels…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        <PickerMenu
          icon={<SortIcon />}
          label="Group by"
          value={grouping}
          options={SORT_OPTIONS}
          onChange={onGroupingChange}
          testId="plot-channel-sort"
        />
        <PickerMenu
          icon={<FilterIcon />}
          label="Filter by element type"
          value={kind}
          options={KIND_OPTIONS.map((o) => ({
            ...o,
            icon:
              o.value === "all" ? undefined : (
                <EntityGlyph {...KIND_GLYPH[o.value]} size={13} />
              ),
          }))}
          onChange={onKindChange}
          testId="plot-channel-filter"
        />
      </div>

      <div className="channel-rail__list" data-testid="plot-channel-list">
        {/* What is plotted, always in view — never somewhere down the list. */}
        <div className="channel-rail__group channel-rail__group--plotted">
          <div className="channel-rail__group-label">
            <span>Plotted ({plottedRows.length})</span>
            {plottedRows.length > 0 && (
              <button
                type="button"
                className="channel-rail__clear"
                data-testid="plot-channel-clear"
                onClick={onClear}
                title="Remove every channel from this plot"
              >
                Clear
              </button>
            )}
          </div>
          {plottedRows.length === 0 ? (
            <div className="channel-rail__empty">
              Nothing plotted yet — pick channels below.
            </div>
          ) : (
            plottedRows.map((d) => row(d, true))
          )}
          {/* Swapping the whole set stays available once one is chosen, not
              only while the plot is empty. */}
          {presets.length > 0 && (
            <>
              <label className="visually-hidden" htmlFor="plot-channel-preset">
                Plot a preset channel set
              </label>
              <select
                id="plot-channel-preset"
                data-testid="plot-channel-preset"
                className="input channel-rail__preset"
                value=""
                onChange={(e) => {
                  const preset = presets.find((p) => p.id === e.target.value);
                  if (preset) onPickPreset(preset);
                }}
              >
                <option value="" disabled>
                  or plot a whole set…
                </option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>

        {groups.length === 0 && (
          <div className="channel-rail__empty" data-testid="plot-channel-empty">
            No channel matches the search and filter.
          </div>
        )}
        {groups.map((group) => (
          <div className="channel-rail__group" key={group.key}>
            <div className="channel-rail__group-label">
              <span>{group.label}</span>
              <span className="channel-rail__group-count">
                {group.rows.length}
              </span>
            </div>
            {group.rows.map((d) => row(d, false))}
          </div>
        ))}
        {overflow > 0 && (
          <div
            className="channel-rail__overflow"
            data-testid="plot-channel-overflow"
            role="status"
          >
            {overflow} more — narrow the search to see them.
          </div>
        )}
      </div>
    </div>
  );
}
