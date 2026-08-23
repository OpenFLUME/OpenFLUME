/**
 * ChannelExplorer — the frame around the Results tab's plots.
 *
 * This used to be the whole surface: one channel set, five views, and two
 * controls competing to choose the set (a preset dropdown and a channel list),
 * plus pinning, a "primary" channel and a follow-the-selection mode. Every
 * question was a mode change and no two answers could be on screen at once.
 *
 * It is now just the frame. Plots own the questions (components/ResultPlots),
 * each with its own kind, channels and path; this component keeps what belongs
 * to the tab rather than to a plot: the run context header, CSV export, the
 * stale/live banners, and the deterministic findings.
 *
 * Everything here reads the CAPTURED config/result snapshots it is handed, so a
 * historical run always shows the model it was solved on. The component never
 * mutates config/undo/history — store writes are limited to selection, time
 * index, and the plots themselves.
 */
import { useMemo, useState } from "react";
import { useStore } from "../store";
import type { NetworkConfig, SteadyResult, TransientResult } from "../types";
import ResultPlots, { type ComparableRun } from "./ResultPlots";
import { runStripView, type RunStripState } from "../analysisShell";
import FindingsStrip from "./FindingsStrip";
import { listChannels, type ChannelDescriptor } from "../channels";
import { buildChannelsCsv, channelsExportFilename } from "../channelContext";

function downloadText(text: string, filename: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** One historical run offered by the title dropdown. */
export interface ChannelExplorerRunOption {
  id: string;
  name: string;
  /** Right-side hint, e.g. "14:02:11 · steady · converged". */
  meta?: string;
}

/**
 * The displayed run, rendered as the panel's TITLE rather than as a separate
 * strip above it: a heading that tells you which run you are reading and lets
 * you switch, instead of a heading that says "Plots" and a bar that repeats
 * itself. Reuses the run-strip view model so the wording stays in one place.
 */
export interface ChannelExplorerRun extends RunStripState {
  runs?: readonly ChannelExplorerRunOption[];
  selectedRunId?: string | null;
  onSelectRun?: (id: string | null) => void;
}

export interface ChannelExplorerBaseline {
  name: string;
  config: NetworkConfig;
  result: SteadyResult | TransientResult;
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
  /** Displayed run: the title dropdown, its badge and its flags. */
  run?: ChannelExplorerRun;
  /** Other recorded runs, any of which a plot can overlay. */
  comparableRuns?: readonly ComparableRun[];
  /** Chart height override (px). */
  chartHeight?: number;
}

export default function ChannelExplorer({
  displayConfig,
  result,
  live = false,
  stale = false,
  baseline = null,
  configHash,
  run,
  comparableRuns = [],
  chartHeight,
}: ChannelExplorerProps) {
  const unitPrefs = useStore((s) => s.unitPreferences);
  const [notice, setNotice] = useState("");
  const [displayed, setDisplayed] = useState<ChannelDescriptor[]>([]);

  const channels = useMemo(
    () => listChannels(displayConfig, result),
    [displayConfig, result],
  );

  // A live partial has no settled numbers to compare against, so a pinned
  // baseline is withheld until the run finishes rather than overlaying noise.
  const effectiveBaseline = !live && baseline ? baseline : null;

  const exportCsv = (kind: "view" | "all") => {
    const list = kind === "all" ? channels : displayed;
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

  return (
    <section
      className="channel-explorer"
      data-testid="channel-explorer"
      aria-labelledby="channel-explorer-title"
    >
      <div className="channel-explorer__header">
        <div className="plots-header">
          <RunTitle run={run} live={live} />
          <span style={{ flex: 1 }} />
          <button
            data-testid="channel-explorer-export-csv"
            className="btn btn--ghost btn--sm"
            onClick={() => exportCsv("view")}
            disabled={!result || displayed.length === 0}
            title="Download this plot's channels as CSV (captured config + result provenance)"
          >
            Export CSV
          </button>
          <button
            data-testid="channel-explorer-export-all-csv"
            className="btn btn--ghost btn--sm"
            onClick={() => exportCsv("all")}
            disabled={!result || channels.length === 0}
            title="Download every result channel as CSV, not just this plot (captured config + result provenance)"
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
      </div>

      {!result || channels.length === 0 ? (
        <div
          className="channel-explorer__empty"
          data-testid="channel-explorer-empty"
        >
          {!result
            ? "Run a simulation to plot its channels."
            : "This result carries no numeric channels."}
        </div>
      ) : (
        <div className="channel-explorer__body">
          <div
            className="channel-explorer__notice"
            data-testid="channel-explorer-status"
            role="status"
            aria-live="polite"
          >
            {notice}
          </div>

          <ResultPlots
            displayConfig={displayConfig}
            result={result}
            baseline={
              effectiveBaseline
                ? {
                    name: effectiveBaseline.name,
                    result: effectiveBaseline.result,
                  }
                : null
            }
            channels={channels}
            comparableRuns={comparableRuns}
            {...(run?.runName ? { primaryRunName: run.runName } : {})}
            {...(chartHeight !== undefined ? { chartHeight } : {})}
            onDisplayedChannelsChange={setDisplayed}
          />

          <FindingsStrip
            displayConfig={displayConfig}
            result={result}
            onSelectElement={useStore.getState().setSelection}
          />
        </div>
      )}
    </section>
  );
}

/** Value standing in for "latest run" in the native select (ids never empty). */
const LATEST_VALUE = "";

/**
 * The panel's heading IS the run selector: which run you are reading is the
 * first thing to know and the thing most often changed, so it earns the
 * title's weight rather than a strip of its own.
 */
function RunTitle({
  run,
  live = false,
}: {
  run?: ChannelExplorerRun;
  live?: boolean;
}) {
  const vm = runStripView(run ?? {});
  const options = run?.runs ?? [];
  const selectedId = run?.selectedRunId ?? null;
  const known = selectedId != null && options.some((r) => r.id === selectedId);

  return (
    <div className="plots-header__run">
      {options.length > 0 && run?.onSelectRun ? (
        <>
          <label className="visually-hidden" htmlFor="plots-run-select">
            Displayed run
          </label>
          <select
            id="plots-run-select"
            data-testid="run-title-select"
            className="plots-header__title plots-header__title--select"
            value={known ? selectedId! : LATEST_VALUE}
            onChange={(e) =>
              run.onSelectRun?.(
                e.target.value === LATEST_VALUE ? null : e.target.value,
              )
            }
          >
            <option value={LATEST_VALUE}>Latest run</option>
            {options.map((r) => (
              <option key={r.id} value={r.id}>
                {r.meta ? `${r.name} · ${r.meta}` : r.name}
              </option>
            ))}
          </select>
        </>
      ) : (
        <h2 className="plots-header__title" data-testid="run-title">
          {vm.title}
        </h2>
      )}
      {live && (
        <span className="pill" data-testid="channel-explorer-live">
          live partial
        </span>
      )}
      {vm.outcomeText && (
        <span
          className={`pill pill--${vm.outcomeTone}`}
          data-testid="run-title-outcome"
        >
          {vm.outcomeText}
        </span>
      )}
      {vm.detailText && (
        <span className="plots-header__detail" data-testid="run-title-detail">
          {vm.detailText}
        </span>
      )}
      {vm.partial && (
        <span className="pill pill--warn" data-testid="run-title-partial">
          partial
        </span>
      )}
      {vm.baselineText && (
        <span className="pill pill--info" data-testid="run-title-baseline">
          {vm.baselineText}
        </span>
      )}
      <span
        className="visually-hidden"
        role="status"
        data-testid="run-title-status"
      >
        {vm.statusText}
      </span>
    </div>
  );
}
