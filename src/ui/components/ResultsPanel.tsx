import React, { useMemo, useState } from "react";
import { useStore } from "../store";
import { SteadyResult, TransientResult, NetworkConfig } from "../types";
import RunHistoryPanel from "./RunHistoryPanel";
import ConvergenceDiarySection from "./ConvergenceDiarySection";
import ChannelExplorer, {
  type ChannelExplorerRunOption,
} from "./ChannelExplorer";
import type { ComparableRun } from "./ResultPlots";
import AnalysisDisclosure from "./AnalysisDisclosure";
import { analysisDisclosureIds, type RunStripOutcome } from "../analysisShell";
import { diaryIndicatorText } from "../diaryPresentation";
import { fluidsSummary } from "../fluidsUi";
import { QuantityKind, getUnitDef, type UnitPreferences } from "../units";
import { channelFieldInfo } from "../channels";
import {
  resolveScale,
  formatWithUnit,
  formatSig,
  clampDisplayDelta,
  ScaleChoice,
} from "../format";
import { isTransientResult } from "../runHistory";
import type { RunRecord } from "../runHistory";
import { provenanceCommentLines } from "../provenance";
import { safeFilename } from "../utils";
import { csvRow } from "../csv";

type Config = NetworkConfig;

/** Currently pinned baseline run record (null when unpinned/deleted). */
function useBaselineRecord(): RunRecord | null {
  const runHistory = useStore((s) => s.runHistory);
  const baselineRunId = useStore((s) => s.baselineRunId);
  return useMemo(
    () =>
      baselineRunId
        ? (runHistory.find((r) => r.id === baselineRunId) ?? null)
        : null,
    [runHistory, baselineRunId],
  );
}

/**
 * Signed delta formatter in a resolved scale (offset-safe via factor).
 * Deltas below display resolution / FP noise (see clampDisplayDelta) render
 * as "+0" — never "-5.684e-14" noise between nominally identical runs.
 */
function deltaText(
  deltaSI: number,
  refSI: number,
  scale: ScaleChoice,
  sigFigs: number,
): string {
  const d = clampDisplayDelta(
    deltaSI * scale.factor,
    refSI * scale.factor,
    sigFigs,
  );
  return `${d >= 0 ? "+" : ""}${formatSig(d, sigFigs)}`;
}

function useUnitLabel(kind: QuantityKind): string {
  const unitId = useStore((s) => s.unitPreferences[kind]);
  return getUnitDef(kind, unitId).symbol;
}

/** id → display label lookup (labels are what analysts actually read). */
function useLabelMap(config: Config): Map<string, string> {
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const n of config.nodes) m.set(n.id, n.label || n.id);
    for (const b of config.branches) m.set(b.id, b.label || b.id);
    for (const s of config.solidNodes ?? []) m.set(s.id, s.label || s.id);
    for (const c of config.conductors ?? []) m.set(c.id, c.label || c.id);
    return m;
  }, [config]);
}

/** Secondary Analysis-view sections — all closed by default. */
type DisclosureKey = "summary" | "final" | "diary" | "runs";

/** Same HH:MM:SS row time as RunHistoryPanel (strip run-option meta). */
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function ResultsView() {
  const result = useStore((s) => s.result);
  const liveResult = useStore((s) => s.liveResult);
  const runStatus = useStore((s) => s.runStatus);
  const runProgress = useStore((s) => s.runProgress);
  const config = useStore((s) => s.config);
  const resultConfig = useStore((s) => s.resultConfig);
  const resultStale = useStore((s) => s.resultStale);
  const validationErrors = useStore((s) => s.validationErrors);
  const hasRunHistory = useStore((s) => s.runHistory.length > 0);
  const runHistory = useStore((s) => s.runHistory);
  const selectedRunId = useStore((s) => s.selectedRunId);
  const resultDiary = useStore((s) => s.resultDiary);
  const selectRun = useStore((s) => s.selectRun);
  const baselineRecord = useBaselineRecord();

  // Secondary sections (details / tables / diary / history) stay closed
  // until asked for; strip buttons and disclosure headers share state.
  const [openSections, setOpenSections] = useState<
    Record<DisclosureKey, boolean>
  >({
    summary: false,
    final: false,
    diary: false,
    runs: false,
  });
  const toggleSection = (key: DisclosureKey) => (open: boolean) =>
    setOpenSections((s) => ({ ...s, [key]: open }));
  /**
   * Open a disclosure, then move focus into it once the content has mounted
   * (next frame).  Diary jumps land on the diary itself — the disclosure
   * region is just a labelled container, the analyst asked for the diary —
   * falling back to the region for the legacy no-diary note.
   */
  const openSection = (key: DisclosureKey) => {
    setOpenSections((s) => ({ ...s, [key]: true }));
    requestAnimationFrame(() => {
      const el =
        key === "diary"
          ? (document.querySelector('[data-testid="solver-diary"]') ??
            document.getElementById(analysisDisclosureIds(key).contentId))
          : document.getElementById(analysisDisclosureIds(key).contentId);
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ block: "nearest" });
        el.focus({ preventScroll: true });
      }
    });
  };
  // Run-history diary pill: the panel selects the run; we open + focus the
  // diary disclosure once the selection re-render has mounted it.
  const showRunDiary = (_runId: string) => openSection("diary");

  // The record OWNING the displayed diary (reference identity: pushRunRecord
  // and selectRun both assign the record's own diary clone).  Cancelled/
  // errored runs own no record, so their diary exports without run context.
  const diaryOwner = useMemo(
    () =>
      resultDiary
        ? (runHistory.find((r) => r.diary === resultDiary) ?? null)
        : null,
    [runHistory, resultDiary],
  );

  // Historical runs display against THEIR config snapshot (labels, settings).
  const displayConfig = resultConfig ?? config;

  const steadyFinal =
    result && "iterations" in result && !("times" in result)
      ? (result as SteadyResult)
      : null;
  const transientFinal =
    result && "times" in result ? (result as TransientResult) : null;
  const transientLive = liveResult && "times" in liveResult ? liveResult : null;

  const isRunning = runStatus === "running" || runStatus === "loadingFluids";
  const isCancelled = runStatus === "cancelled";
  const mode = displayConfig.settings.mode;

  // The solver-diary section: rendered whenever a diary exists — including
  // cancelled/error states whose partial diary has no final result.  A
  // selected legacy record (no diary captured) gets a one-line note
  // instead; a fresh pre-run Analysis renders nothing at all.
  const selectedRecord = selectedRunId
    ? (runHistory.find((r) => r.id === selectedRunId) ?? null)
    : null;
  const legacyDiaryNote =
    !resultDiary &&
    selectedRecord &&
    !selectedRecord.diary &&
    (steadyFinal || transientFinal) ? (
      <div
        className="solver-diary solver-diary--legacy"
        data-testid="solver-diary-legacy"
        tabIndex={-1}
      >
        No solver diary was recorded for this run — the record predates diary
        capture.
      </div>
    ) : null;
  const diarySlot = resultDiary ? (
    <ConvergenceDiarySection
      diary={resultDiary}
      runName={diaryOwner?.name ?? null}
      runId={diaryOwner?.id ?? null}
    />
  ) : (
    legacyDiaryNote
  );
  const hasDiarySection = !!resultDiary || !!legacyDiaryNote;
  const hasResultData = !!(steadyFinal || transientFinal || transientLive);
  /** Displayed result (final preferred over a retained live partial). */
  const shownResult = steadyFinal ?? transientFinal ?? transientLive;

  /* ── Run-strip view model (mapped from the displayed run state) ─────── */
  const displayedFinal = steadyFinal ?? transientFinal;
  const stripOutcome: RunStripOutcome | null = isRunning
    ? "running"
    : isCancelled
      ? "cancelled"
      : displayedFinal
        ? displayedFinal.converged
          ? "converged"
          : "notConverged"
        : runStatus === "error"
          ? "error"
          : null;
  const stripDetail: string | null = (() => {
    if (steadyFinal)
      return `${steadyFinal.iterations} iter · res ${steadyFinal.residual.toExponential(2)}`;
    if (transientFinal) return `${transientFinal.times.length} accepted steps`;
    if (transientLive && transientLive.times.length)
      return `t = ${transientLive.times[transientLive.times.length - 1].toFixed(2)} s`;
    if (isRunning && runProgress && runProgress.kind === "steady")
      return `iter ${runProgress.iteration} · res ${runProgress.residual.toExponential(2)}`;
    return null;
  })();
  const stripMode: "steady" | "transient" | null = steadyFinal
    ? "steady"
    : transientFinal || transientLive
      ? "transient"
      : isRunning
        ? config.settings.mode
        : null;
  /**
   * Every history record is switchable from the title dropdown. The meta is
   * only the timestamp: mode and outcome sit in the badge beside the title,
   * and the selected option IS that title, so repeating them there would
   * make the heading a sentence.
   */
  const runOptions: ChannelExplorerRunOption[] = useMemo(
    () =>
      runHistory.map((r) => ({
        id: r.id,
        name: r.name,
        meta: fmtTime(r.timestamp),
      })),
    [runHistory],
  );

  /**
   * Every OTHER recorded run, offered to each plot as an overlay. Comparing a
   * design against its predecessor is the reason run history exists, and
   * flipping between two runs a second apart cannot answer "which is better".
   * Each carries its own captured config so a variant is plotted on the
   * geometry it actually ran.
   */
  const comparableRuns: ComparableRun[] = useMemo(
    () =>
      runHistory
        // Identity, not just the id: with no record selected the displayed
        // result IS the newest record, and a run overlaid on itself is a
        // second line drawn exactly on the first.
        .filter((r) => r.id !== selectedRunId && r.result !== shownResult)
        .map((r) => ({
          id: r.id,
          name: r.name,
          config: r.config,
          result: r.result,
        })),
    [runHistory, selectedRunId, shownResult],
  );

  /**
   * The displayed run, handed to the plots panel to render AS ITS TITLE. It
   * used to be a sticky strip of its own above the plots; a heading that says
   * "Plots" over a bar that says which run is a line of chrome spent saying
   * nothing.
   */
  const runProps = {
    runName: selectedRecord?.name ?? null,
    mode: stripMode,
    outcome: stripOutcome,
    outcomeDetail: stripDetail,
    stale: resultStale && !!displayedFinal,
    partial: isCancelled,
    baselineName: baselineRecord?.name ?? null,
    runCount: runHistory.length,
    diaryEventCount: resultDiary ? resultDiary.events.length : null,
    diaryWarningCount: resultDiary ? resultDiary.summary.warningCount : 0,
    runs: runOptions,
    selectedRunId,
    onSelectRun: selectRun,
  };

  const runsDisclosure = hasRunHistory ? (
    <AnalysisDisclosure
      id="runs"
      title="Run history"
      badge={runHistory.length}
      open={openSections.runs}
      onToggle={toggleSection("runs")}
    >
      <RunHistoryPanel onShowDiary={showRunDiary} />
    </AnalysisDisclosure>
  ) : null;

  /**
   * Critical run-state banners render BEFORE the sticky run strip so they
   * are never scrolled under (or initially hidden behind) it.  Kept out of
   * the strip itself: the strip stays one glanceable line, and a banner's
   * full message wraps naturally above it.
   */
  const statusBanners = (
    <>
      {runStatus === "error" && (
        <div
          data-testid="results-error-banner"
          className="banner banner--error"
          role="alert"
          style={{ marginBottom: 12 }}
        >
          {validationErrors.length > 0
            ? `Run failed — ${validationErrors[0]}`
            : "The run failed before producing results."}
        </div>
      )}
      {resultStale && (steadyFinal || transientFinal) && (
        <div className="stale-banner" data-testid="results-stale-banner">
          Results are from an earlier model state. Rerun before using these
          values for a design decision.
        </div>
      )}
      {isCancelled && (
        <div
          data-testid="cancelled-banner"
          className="banner banner--warn"
          style={{ marginBottom: 12 }}
        >
          {transientLive && transientLive.times.length > 0
            ? `Cancelled at t = ${transientLive.times[transientLive.times.length - 1].toFixed(2)} s — showing partial data`
            : "Cancelled before completion — the solver diary holds the partial evidence."}
        </div>
      )}
      {isRunning && mode === "steady" && (
        <div
          data-testid="steady-running"
          role="status"
          style={{ marginBottom: 12, fontSize: 13, color: "var(--text-2)" }}
        >
          Running steady solve…
          {runProgress && runProgress.kind === "steady" && (
            <span style={{ marginLeft: 8 }}>
              Iter {runProgress.iteration} | Residual{" "}
              {runProgress.residual.toExponential(2)}
            </span>
          )}
        </div>
      )}
    </>
  );

  // No data at all — the strip plus closed disclosures keep old results and a
  // cancelled/errored run's partial diary reachable without front-and-center
  // noise; the pre-run empty state stays one concise line.
  if (!hasResultData && !isRunning) {
    return (
      // The scroll container itself carries no top padding: the strip sticks
      // flush to the scrollport top (top: 0) instead of floating one padding
      // block below it with content scrolling visibly above it.
      <div
        data-testid="results-view"
        style={{ height: "100%", overflowY: "auto", color: "var(--text-2)" }}
      >
        <div className="analysis-page">
          <h1 className="visually-hidden">Analysis</h1>
          {statusBanners}
          {resultDiary && (
            <AnalysisDisclosure
              id="diary"
              title="Solver diary"
              badge={diaryIndicatorText(resultDiary)}
              open={openSections.diary}
              onToggle={toggleSection("diary")}
            >
              <ConvergenceDiarySection
                diary={resultDiary}
                runName={diaryOwner?.name ?? null}
                runId={diaryOwner?.id ?? null}
              />
            </AnalysisDisclosure>
          )}
          {runsDisclosure}
          {!resultDiary &&
            (hasRunHistory
              ? "Select a past run to review it, or run the model again."
              : "Run a simulation to see results")}
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="results-view"
      style={{ height: "100%", overflowY: "auto", color: "var(--text-1)" }}
    >
      <div className="analysis-page">
        <h1 className="visually-hidden">Analysis</h1>
        {statusBanners}
        {/* Primary channel explorer (captured config/result; never live config) */}
        {shownResult && (
          <ChannelExplorer
            displayConfig={displayConfig}
            result={shownResult}
            live={!steadyFinal && !transientFinal && !!transientLive}
            stale={resultStale}
            baseline={
              baselineRecord
                ? {
                    name: baselineRecord.name,
                    config: baselineRecord.config,
                    result: baselineRecord.result,
                    configHash: baselineRecord.configHash,
                  }
                : null
            }
            configHash={
              selectedRunId
                ? runHistory.find((r) => r.id === selectedRunId)?.configHash
                : undefined
            }
            run={runProps}
            comparableRuns={comparableRuns}
          />
        )}
        {shownResult && (
          <AnalysisDisclosure
            id="summary"
            title="Run details"
            open={openSections.summary}
            onToggle={toggleSection("summary")}
          >
            {(steadyFinal || transientFinal) && <PrecisionSelector />}
            <RunSummary result={shownResult} config={displayConfig} />
            {transientFinal && (
              <DownloadTimeSeries
                result={transientFinal}
                config={displayConfig}
              />
            )}
          </AnalysisDisclosure>
        )}
        {(steadyFinal || transientFinal) && (
          <AnalysisDisclosure
            id="final"
            title={steadyFinal ? "Result tables" : "Final-state tables"}
            open={openSections.final}
            onToggle={toggleSection("final")}
          >
            {steadyFinal ? (
              <SteadyTables result={steadyFinal} config={displayConfig} />
            ) : (
              <TransientFinalState
                result={transientFinal!}
                config={displayConfig}
              />
            )}
          </AnalysisDisclosure>
        )}
        {hasDiarySection && (
          <AnalysisDisclosure
            id="diary"
            title="Solver diary"
            badge={resultDiary ? diaryIndicatorText(resultDiary) : null}
            open={openSections.diary}
            onToggle={toggleSection("diary")}
          >
            {diarySlot}
          </AnalysisDisclosure>
        )}
        {runsDisclosure}
      </div>
    </div>
  );
}

/** Significant-figures selector for all result tables (persisted). */
function PrecisionSelector() {
  const sigFigs = useStore((s) => s.resultSigFigs);
  const setSigFigs = useStore((s) => s.setResultSigFigs);
  return (
    <div data-testid="results-precision" className="precision-selector">
      <span>Precision</span>
      {[3, 4, 5, 6].map((n) => (
        <button
          key={n}
          className="btn btn--choice btn--sm"
          aria-pressed={sigFigs === n}
          onClick={() => setSigFigs(n)}
        >
          {n}
        </button>
      ))}
      <span className="text-3">sig figs</span>
    </div>
  );
}

function RunSummary({
  result,
  config,
}: {
  result: SteadyResult | TransientResult;
  config: Config;
}) {
  const preferences = useStore((s) => s.unitPreferences);
  const timeUnit = useUnitLabel("time");
  const stats = "stats" in result ? result.stats : undefined;
  return (
    <div className="analysis-section">
      <div className="analysis-section__title">Run Summary</div>
      <div className="fact-grid">
        <Fact label="Mode" value={config.settings.mode} />
        <Fact
          label="Converged"
          value={result.converged ? "Yes" : "No"}
          tone={result.converged ? "ok" : "danger"}
        />
        {"iterations" in result && (
          <Fact label="Iterations" value={result.iterations} />
        )}
        {"times" in result && (
          <Fact label="Steps" value={result.times.length} />
        )}
        {"residual" in result && (
          <Fact label="Residual" value={result.residual.toExponential(2)} />
        )}
        <Fact label="Fluid" value={fluidsSummary(config)} />
        <Fact label="Time unit" value={timeUnit} />
        {stats && (
          <>
            <Fact label="Accepted" value={stats.steps} />
            <Fact label="Rejected" value={stats.rejectedSteps} />
            <Fact
              label="dt range"
              value={`${formatWithUnit(stats.minDt, "time", preferences, 2)} – ${formatWithUnit(stats.maxDt, "time", preferences, 2)}`}
            />
            {stats.dtAtMinCount ? (
              <Fact label="dtMin hits" value={stats.dtAtMinCount} tone="warn" />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** One labelled run statistic: label above value, values on a shared baseline. */
function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "ok" | "warn" | "danger";
}) {
  return (
    <div className="fact">
      <div className="fact__label micro-label">{label}</div>
      <div
        className={tone ? `fact__value fact__value--${tone}` : "fact__value"}
      >
        {value}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="analysis-section">
      <div className="analysis-section__title">{title}</div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sortable, CSV-exportable result table.
// ---------------------------------------------------------------------------

interface Column<Row> {
  key: string;
  /** Header text (unit already resolved, e.g. "Pressure (kPa)"). */
  header: string;
  /** CSV header (same as header by default). */
  csvHeader?: string;
  /** Numeric sort key (SI or display value — ordering is identical). */
  numeric?: (row: Row) => number | undefined;
  /** Display cell text (formatted in the column's resolved scale). */
  text: (row: Row) => string;
  /** CSV cell value (display units, full precision). */
  csv?: (row: Row) => string;
  cellTestid?: (row: Row) => string;
  title?: (row: Row) => string;
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

function ResultTable<Row extends { id: string }>({
  testid,
  exportTestid,
  columns,
  rows,
  name,
}: {
  testid?: string;
  /** Exact testids for the CSV buttons, e.g. "table" → table-copy-csv. */
  exportTestid?: string;
  columns: Column<Row>[];
  rows: Row[];
  name: string;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const arr = [...rows];
    arr.sort((a, b) => {
      if (col.numeric) {
        const av = col.numeric(a) ?? -Infinity;
        const bv = col.numeric(b) ?? -Infinity;
        return (av - bv) * sort.dir;
      }
      return col.text(a).localeCompare(col.text(b)) * sort.dir;
    });
    return arr;
  }, [rows, sort, columns]);

  const csvBody = useMemo(() => {
    const header = csvRow(columns.map((c) => c.csvHeader ?? c.header));
    const lines = sorted.map((r) =>
      csvRow(columns.map((c) => (c.csv ? c.csv(r) : c.text(r)))),
    );
    return [header, ...lines].join("\n");
  }, [columns, sorted]);

  /** CSV with a `#`-comment provenance block above the header (Excel-safe). */
  const csvWithProvenance = async () => {
    const meta = await provenanceCommentLines(
      useStore.getState().resultConfig ?? useStore.getState().config,
    );
    return [...meta, csvBody].join("\n");
  };

  const copyCsv = async () => {
    const text = await csvWithProvenance();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  };

  const downloadCsv = async () => {
    const text = await csvWithProvenance();
    const modelName = useStore.getState().config.meta.name;
    downloadText(text, `${safeFilename(modelName)}-${name}.csv`);
  };

  return (
    <div className="results-table-wrap">
      <div className="results-table-wrap__tools">
        <span className="micro-label">{rows.length} rows</span>
        <button
          data-testid={exportTestid ? `${exportTestid}-copy-csv` : undefined}
          className="btn btn--ghost btn--sm"
          onClick={() => void copyCsv()}
          title="Copy table as CSV with provenance header (displayed units)"
        >
          Copy CSV
        </button>
        <button
          data-testid={
            exportTestid ? `${exportTestid}-download-csv` : undefined
          }
          className="btn btn--ghost btn--sm"
          onClick={() => void downloadCsv()}
          title="Download table as CSV with provenance header (displayed units)"
        >
          Download CSV
        </button>
      </div>
      <table data-testid={testid} className="table table--dense">
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  className={c.numeric ? "table__num" : undefined}
                  aria-sort={
                    active
                      ? sort!.dir === 1
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                  style={{ cursor: "pointer", userSelect: "none" }}
                  onClick={() =>
                    setSort((prev) =>
                      prev?.key === c.key
                        ? { key: c.key, dir: (prev.dir * -1) as 1 | -1 }
                        : { key: c.key, dir: 1 },
                    )
                  }
                >
                  {c.header} {active ? (sort!.dir === 1 ? "▲" : "▼") : ""}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.id}>
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={c.numeric ? "table__num" : undefined}
                  data-testid={c.cellTestid ? c.cellTestid(r) : undefined}
                  title={c.title ? c.title(r) : undefined}
                >
                  {c.text(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Resolve one scale for a column of SI values and return format helpers. */
function columnScale(
  values: number[],
  kind: QuantityKind,
  unitId: string,
): ScaleChoice {
  return resolveScale(values, kind, unitId);
}

/**
 * The published quantities each table appends beyond its hand-written core
 * columns.  Names are channel field names, so labels and unit kinds come from
 * the registry (ui/channels.ts) and the tables stay in step with whatever the
 * solver publishes.  Order here is the column order.
 */
const NODE_EXTRA_FIELDS = [
  "quality",
  "enthalpy",
  "internalEnergy",
  "entropy",
  "specificHeat",
  "viscosity",
  "thermalConductivity",
  "speedOfSound",
  "gasVolume",
] as const;

const BRANCH_EXTRA_FIELDS = [
  "volumetricFlow",
  "massFlux",
  "dynamicPressure",
  "mach",
] as const;

const CONDUCTOR_EXTRA_FIELDS = ["heatFlux", "heatTransferCoeff"] as const;

/** Transient branch quantities that a steady table already shows inline. */
const TRANSIENT_BRANCH_CORE_FIELDS = ["velocity", "dP", "reynolds"] as const;

function numericField(row: { id: string }, field: string): number | undefined {
  const v = (row as Record<string, unknown>)[field];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Build a column per field that at least one row actually carries, sized to
 * that column's own values.  A quantity the run does not publish (entropy
 * without a real fluid, Mach without a compressible model, heat flux without
 * an area) contributes no column at all rather than a column of dashes.
 */
function extraColumns<Row extends { id: string }>(
  fields: readonly string[],
  rows: Row[],
  unitPrefs: UnitPreferences,
  sigFigs: number,
): Column<Row>[] {
  const columns: Column<Row>[] = [];
  for (const field of fields) {
    const info = channelFieldInfo(field);
    if (!info) continue;
    const values = rows
      .map((r) => numericField(r, field))
      .filter((v): v is number => v !== undefined);
    if (values.length === 0) continue;
    const scale = columnScale(values, info.quantity, unitPrefs[info.quantity]);
    const suffix = scale.unitLabel === "-" ? "" : ` (${scale.unitLabel})`;
    columns.push({
      key: field,
      header: `${info.label}${suffix}`,
      numeric: (r) => numericField(r, field),
      text: (r) => {
        const v = numericField(r, field);
        return v === undefined ? "—" : formatSig(scale.convert(v), sigFigs);
      },
      csv: (r) => {
        const v = numericField(r, field);
        return v === undefined ? "" : String(scale.convert(v));
      },
    });
  }
  return columns;
}

/** Steady result tables (the "final" disclosure); Run Summary lives in the run-details disclosure. */
function SteadyTables({
  result,
  config,
}: {
  result: SteadyResult;
  config: Config;
}) {
  const unitPrefs = useStore((s) => s.unitPreferences);
  const sigFigs = useStore((s) => s.resultSigFigs);
  const labels = useLabelMap(config);
  const baseline = useBaselineRecord();
  // Baseline deltas only for a steady baseline pinned against a steady run.
  const bSteady: SteadyResult | null =
    baseline && !isTransientResult(baseline.result) ? baseline.result : null;

  const nodeRows = Object.entries(result.nodes).map(([id, n]) => ({
    id,
    ...n,
  }));
  const branchRows = Object.entries(result.branches).map(([id, b]) => ({
    id,
    ...b,
  }));
  const solidRows = Object.entries(result.solidNodes ?? {}).map(([id, n]) => ({
    id,
    ...n,
  }));
  const conductorRows = Object.entries(result.conductors ?? {}).map(
    ([id, c]) => ({ id, ...c }),
  );

  const pScale = columnScale(
    nodeRows.map((r) => r.pressure),
    "pressure",
    unitPrefs.pressure,
  );
  const tScale = columnScale(
    nodeRows.map((r) => r.temperature),
    "temperature",
    unitPrefs.temperature,
  );
  const dScale = columnScale(
    nodeRows.map((r) => r.density),
    "density",
    unitPrefs.density,
  );
  const mScale = columnScale(
    branchRows.map((r) => r.mdot),
    "massFlow",
    unitPrefs.massFlow,
  );
  const vScale = columnScale(
    branchRows.map((r) => r.velocity),
    "velocity",
    unitPrefs.velocity,
  );
  const dpScale = columnScale(
    branchRows.map((r) => r.dP),
    "pressure",
    unitPrefs.pressure,
  );
  const qScale = columnScale(
    conductorRows.map((r) => r.heatRate),
    "power",
    unitPrefs.power,
  );

  const nameCol = <Row extends { id: string }>(): Column<Row> => ({
    key: "name",
    header: "Name",
    text: (r) => labels.get(r.id) ?? r.id,
    title: (r) => r.id,
  });
  const idCol = <Row extends { id: string }>(): Column<Row> => ({
    key: "id",
    header: "ID",
    text: (r) => r.id,
  });

  /** Delta column vs the pinned baseline for one id→SI-value extractor. */
  const deltaCol = <Row extends { id: string }>(
    key: string,
    header: string,
    scale: ScaleChoice,
    cur: (r: Row) => number,
    base: (id: string) => number | undefined,
  ): Column<Row> => ({
    key,
    header: `Δ${header} (${scale.unitLabel})`,
    // CSV keeps the RAW full-precision delta (displayed cells are clamped);
    // the header says so explicitly.
    csvHeader: `Δ${header} (${scale.unitLabel}, raw)`,
    numeric: (r) => {
      const b = base(r.id);
      return b === undefined ? undefined : cur(r) - b;
    },
    text: (r) => {
      const b = base(r.id);
      return b === undefined
        ? "—"
        : deltaText(
            cur(r) - b,
            Math.max(Math.abs(cur(r)), Math.abs(b)),
            scale,
            sigFigs,
          );
    },
    csv: (r) => {
      const b = base(r.id);
      return b === undefined ? "" : String((cur(r) - b) * scale.factor);
    },
    title: (r) => {
      const b = base(r.id);
      return b === undefined
        ? "Not present in the baseline run"
        : `Baseline: ${formatSig(scale.convert(b), sigFigs)} ${scale.unitLabel}`;
    },
  });

  // Baseline lookups (steady baseline only)
  const bNodes = bSteady?.nodes ?? {};
  const bBranches = bSteady?.branches ?? {};
  const bSolids = bSteady?.solidNodes ?? {};
  const bConductors = bSteady?.conductors ?? {};

  return (
    <>
      {bSteady && (
        <div
          className="banner banner--info"
          data-testid="baseline-delta-note"
          style={{ marginBottom: 16 }}
        >
          Δ columns compare against baseline: <strong>{baseline!.name}</strong>{" "}
          ({new Date(baseline!.timestamp).toLocaleString()}).
        </div>
      )}
      <Section title="Nodes">
        <div data-testid="steady-results">
          <ResultTable
            testid="steady-nodes-table"
            exportTestid="table"
            name="steady-nodes"
            rows={nodeRows}
            columns={[
              nameCol(),
              idCol(),
              {
                key: "p",
                header: `Pressure (${pScale.unitLabel})`,
                numeric: (r) => r.pressure,
                text: (r) => formatSig(pScale.convert(r.pressure), sigFigs),
                csv: (r) => String(pScale.convert(r.pressure)),
              },
              ...(bSteady
                ? [
                    deltaCol(
                      "dp",
                      "P",
                      pScale,
                      (r: (typeof nodeRows)[number]) => r.pressure,
                      (id) => bNodes[id]?.pressure,
                    ),
                  ]
                : []),
              {
                key: "t",
                header: `Temperature (${tScale.unitLabel})`,
                numeric: (r) => r.temperature,
                text: (r) => formatSig(tScale.convert(r.temperature), sigFigs),
                csv: (r) => String(tScale.convert(r.temperature)),
              },
              ...(bSteady
                ? [
                    deltaCol(
                      "dt",
                      "T",
                      tScale,
                      (r: (typeof nodeRows)[number]) => r.temperature,
                      (id) => bNodes[id]?.temperature,
                    ),
                  ]
                : []),
              {
                key: "d",
                header: `Density (${dScale.unitLabel})`,
                numeric: (r) => r.density,
                text: (r) => formatSig(dScale.convert(r.density), sigFigs),
                csv: (r) => String(dScale.convert(r.density)),
              },
              ...extraColumns(NODE_EXTRA_FIELDS, nodeRows, unitPrefs, sigFigs),
            ]}
          />
        </div>
      </Section>
      <Section title="Branches">
        <ResultTable
          testid="steady-branches-table"
          name="steady-branches"
          rows={branchRows}
          columns={[
            nameCol(),
            idCol(),
            {
              key: "mdot",
              header: `Mass flow (${mScale.unitLabel})`,
              numeric: (r) => r.mdot,
              text: (r) => formatSig(mScale.convert(r.mdot), sigFigs),
              csv: (r) => String(mScale.convert(r.mdot)),
              cellTestid: (r) => `mdot-${r.id}`,
            },
            ...(bSteady
              ? [
                  deltaCol(
                    "dmdot",
                    "ṁ",
                    mScale,
                    (r: (typeof branchRows)[number]) => r.mdot,
                    (id) => bBranches[id]?.mdot,
                  ),
                ]
              : []),
            {
              key: "v",
              header: `Velocity (${vScale.unitLabel})`,
              numeric: (r) => r.velocity,
              text: (r) => formatSig(vScale.convert(r.velocity), sigFigs),
              csv: (r) => String(vScale.convert(r.velocity)),
            },
            {
              key: "dp",
              header: `ΔP (${dpScale.unitLabel})`,
              numeric: (r) => r.dP,
              text: (r) => formatSig(dpScale.convert(r.dP), sigFigs),
              csv: (r) => String(dpScale.convert(r.dP)),
            },
            ...(bSteady
              ? [
                  deltaCol(
                    "ddp",
                    "ΔP",
                    dpScale,
                    (r: (typeof branchRows)[number]) => r.dP,
                    (id) => bBranches[id]?.dP,
                  ),
                ]
              : []),
            {
              key: "re",
              header: "Re",
              numeric: (r) => r.reynolds,
              text: (r) => formatSig(r.reynolds, sigFigs),
              csv: (r) => String(r.reynolds),
            },
            ...extraColumns(
              BRANCH_EXTRA_FIELDS,
              branchRows,
              unitPrefs,
              sigFigs,
            ),
          ]}
        />
      </Section>
      {solidRows.length > 0 && (
        <Section title="Solid Nodes">
          <ResultTable
            testid="steady-solid-nodes-table"
            name="steady-solid-nodes"
            rows={solidRows}
            columns={[
              nameCol(),
              idCol(),
              {
                key: "t",
                header: `Temperature (${tScale.unitLabel})`,
                numeric: (r) => r.temperature,
                text: (r) => formatSig(tScale.convert(r.temperature), sigFigs),
                csv: (r) => String(tScale.convert(r.temperature)),
              },
              ...(bSteady
                ? [
                    deltaCol(
                      "dt",
                      "T",
                      tScale,
                      (r: (typeof solidRows)[number]) => r.temperature,
                      (id) => bSolids[id]?.temperature,
                    ),
                  ]
                : []),
            ]}
          />
        </Section>
      )}
      {conductorRows.length > 0 && (
        <Section title="Conductors">
          <ResultTable
            testid="steady-conductors-table"
            name="steady-conductors"
            rows={conductorRows}
            columns={[
              nameCol(),
              idCol(),
              {
                key: "q",
                header: `Heat Rate (${qScale.unitLabel})`,
                numeric: (r) => r.heatRate,
                text: (r) => formatSig(qScale.convert(r.heatRate), sigFigs),
                csv: (r) => String(qScale.convert(r.heatRate)),
              },
              ...(bSteady
                ? [
                    deltaCol(
                      "dq",
                      "Q",
                      qScale,
                      (r: (typeof conductorRows)[number]) => r.heatRate,
                      (id) => bConductors[id]?.heatRate,
                    ),
                  ]
                : []),
              ...extraColumns(
                CONDUCTOR_EXTRA_FIELDS,
                conductorRows,
                unitPrefs,
                sigFigs,
              ),
            ]}
          />
        </Section>
      )}
    </>
  );
}

/**
 * Complete-time-series CSV export (t + every node P/T + every branch mdot in
 * ONE file, display units) — the single legacy full-network capability the
 * explorer's displayed-channel CSV does not cover.  Relocated from the
 * removed "Full-network charts" disclosure into Run details; no charts are
 * restored.  Provenance uses the CAPTURED config of the displayed run.
 */
function DownloadTimeSeries({
  result,
  config,
}: {
  result: TransientResult;
  config: Config;
}) {
  const unitPrefs = useStore((s) => s.unitPreferences);
  const labels = useLabelMap(config);

  const downloadTimeSeries = async () => {
    const nodeIds = Object.keys(result.nodes);
    const branchIds = Object.keys(result.branches);
    const times = result.times;
    const pS = columnScale(
      nodeIds.flatMap((id) => result.nodes[id].pressure),
      "pressure",
      unitPrefs.pressure,
    );
    const tS = columnScale(
      nodeIds.flatMap((id) => result.nodes[id].temperature),
      "temperature",
      unitPrefs.temperature,
    );
    const mS = columnScale(
      branchIds.flatMap((id) => result.branches[id].mdot),
      "massFlow",
      unitPrefs.massFlow,
    );
    const tmS = columnScale(times, "time", unitPrefs.time);
    const header = [
      `t (${tmS.unitLabel})`,
      ...nodeIds.map((id) => `${labels.get(id) ?? id} P (${pS.unitLabel})`),
      ...nodeIds.map((id) => `${labels.get(id) ?? id} T (${tS.unitLabel})`),
      ...branchIds.map(
        (id) => `${labels.get(id) ?? id} mdot (${mS.unitLabel})`,
      ),
    ];
    const lines = [csvRow(header)];
    for (let i = 0; i < times.length; i++) {
      const row = [
        String(tmS.convert(times[i])),
        ...nodeIds.map((id) =>
          String(pS.convert(result.nodes[id].pressure[i])),
        ),
        ...nodeIds.map((id) =>
          String(tS.convert(result.nodes[id].temperature[i])),
        ),
        ...branchIds.map((id) =>
          String(mS.convert(result.branches[id].mdot[i])),
        ),
      ];
      lines.push(csvRow(row));
    }
    const meta = await provenanceCommentLines(config);
    downloadText(
      [...meta, ...lines].join("\n"),
      `${safeFilename(config.meta.name || "network")}-timeseries.csv`,
    );
  };

  return (
    <div style={{ marginBottom: 24 }}>
      <button
        data-testid="download-timeseries-csv"
        className="btn btn--sm"
        onClick={() => void downloadTimeSeries()}
        title="Download t + every node pressure/temperature + every branch mass flow as one CSV (displayed units, captured-config provenance)"
      >
        Download complete time series (CSV)
      </button>
    </div>
  );
}

/**
 * Final-state (last recorded step) tables for a completed transient run —
 * the "final" disclosure.  Not rendered for live partials (the old
 * `!live` guard on the Final State section).
 */
function TransientFinalState({
  result,
  config,
}: {
  result: TransientResult;
  config: Config;
}) {
  const nodeIds = useMemo(() => Object.keys(result.nodes), [result.nodes]);
  const branchIds = useMemo(
    () => Object.keys(result.branches),
    [result.branches],
  );
  const solidNodeIds = useMemo(
    () => (result.solidNodes ? Object.keys(result.solidNodes) : []),
    [result.solidNodes],
  );
  const conductorIds = useMemo(
    () => (result.conductors ? Object.keys(result.conductors) : []),
    [result.conductors],
  );
  const times = result.times;
  const unitPrefs = useStore((s) => s.unitPreferences);
  const sigFigs = useStore((s) => s.resultSigFigs);
  const labels = useLabelMap(config);

  const finalState = useMemo(() => {
    const last = times.length - 1;
    // Everything the recorder published as a per-step numeric trajectory
    // becomes a final-state field; the named ones are restated afterwards so
    // the core columns keep their non-optional types.
    const lastSample = (entry: object): Record<string, number | undefined> => {
      const out: Record<string, number | undefined> = {};
      for (const [key, series] of Object.entries(entry)) {
        if (!Array.isArray(series)) continue;
        const v = series[last];
        if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
      }
      return out;
    };
    return {
      nodes: Object.fromEntries(
        nodeIds.map((id) => [
          id,
          {
            ...lastSample(result.nodes[id]),
            pressure: result.nodes[id].pressure[last],
            temperature: result.nodes[id].temperature[last],
            density: result.nodes[id].density[last],
          },
        ]),
      ),
      branches: Object.fromEntries(
        branchIds.map((id) => [
          id,
          {
            ...lastSample(result.branches[id]),
            mdot: result.branches[id].mdot[last],
          },
        ]),
      ),
      solidNodes: Object.fromEntries(
        solidNodeIds.map((id) => [
          id,
          {
            temperature: result.solidNodes![id].temperature[last],
          },
        ]),
      ),
      conductors: Object.fromEntries(
        conductorIds.map((id) => [
          id,
          {
            ...lastSample(result.conductors![id]),
            heatRate: result.conductors![id].heatRate[last],
          },
        ]),
      ),
    };
  }, [result, nodeIds, branchIds, solidNodeIds, conductorIds, times.length]);

  const nodeRows = Object.entries(finalState.nodes).map(([id, n]) => ({
    id,
    ...n,
  }));
  const branchRows = Object.entries(finalState.branches).map(([id, b]) => ({
    id,
    ...b,
  }));
  const solidRows = Object.entries(finalState.solidNodes).map(([id, n]) => ({
    id,
    ...n,
  }));
  const conductorRows = Object.entries(finalState.conductors).map(
    ([id, c]) => ({ id, ...c }),
  );

  const pScale = columnScale(
    nodeRows.map((r) => r.pressure),
    "pressure",
    unitPrefs.pressure,
  );
  const tScale = columnScale(
    nodeRows.map((r) => r.temperature),
    "temperature",
    unitPrefs.temperature,
  );
  const dScale = columnScale(
    nodeRows.map((r) => r.density),
    "density",
    unitPrefs.density,
  );
  const mScale = columnScale(
    branchRows.map((r) => r.mdot),
    "massFlow",
    unitPrefs.massFlow,
  );
  const qScale = columnScale(
    conductorRows.map((r) => r.heatRate),
    "power",
    unitPrefs.power,
  );

  const nameCol = <Row extends { id: string }>(): Column<Row> => ({
    key: "name",
    header: "Name",
    text: (r) => labels.get(r.id) ?? r.id,
    title: (r) => r.id,
  });
  const idCol = <Row extends { id: string }>(): Column<Row> => ({
    key: "id",
    header: "ID",
    text: (r) => r.id,
  });

  return (
    <Section title="Final State">
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 380px" }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            Nodes
          </div>
          <ResultTable
            name="final-nodes"
            rows={nodeRows}
            columns={[
              nameCol(),
              idCol(),
              {
                key: "p",
                header: `Pressure (${pScale.unitLabel})`,
                numeric: (r) => r.pressure,
                text: (r) => formatSig(pScale.convert(r.pressure), sigFigs),
                csv: (r) => String(pScale.convert(r.pressure)),
              },
              {
                key: "t",
                header: `Temperature (${tScale.unitLabel})`,
                numeric: (r) => r.temperature,
                text: (r) => formatSig(tScale.convert(r.temperature), sigFigs),
                csv: (r) => String(tScale.convert(r.temperature)),
              },
              {
                key: "d",
                header: `Density (${dScale.unitLabel})`,
                numeric: (r) => r.density,
                text: (r) => formatSig(dScale.convert(r.density), sigFigs),
                csv: (r) => String(dScale.convert(r.density)),
              },
              ...extraColumns(NODE_EXTRA_FIELDS, nodeRows, unitPrefs, sigFigs),
            ]}
          />
        </div>
        <div style={{ flex: "1 1 300px" }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            Branches
          </div>
          <ResultTable
            name="final-branches"
            rows={branchRows}
            columns={[
              nameCol(),
              idCol(),
              {
                key: "mdot",
                header: `Mass flow (${mScale.unitLabel})`,
                numeric: (r) => r.mdot,
                text: (r) => formatSig(mScale.convert(r.mdot), sigFigs),
                csv: (r) => String(mScale.convert(r.mdot)),
                cellTestid: (r) => `mdot-${r.id}`,
              },
              ...extraColumns(
                [...TRANSIENT_BRANCH_CORE_FIELDS, ...BRANCH_EXTRA_FIELDS],
                branchRows,
                unitPrefs,
                sigFigs,
              ),
            ]}
          />
        </div>
        {solidRows.length > 0 && (
          <div style={{ flex: "1 1 260px" }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
              Solid Nodes
            </div>
            <ResultTable
              name="final-solid-nodes"
              rows={solidRows}
              columns={[
                nameCol(),
                idCol(),
                {
                  key: "t",
                  header: `Temperature (${tScale.unitLabel})`,
                  numeric: (r) => r.temperature,
                  text: (r) =>
                    formatSig(tScale.convert(r.temperature), sigFigs),
                  csv: (r) => String(tScale.convert(r.temperature)),
                },
              ]}
            />
          </div>
        )}
        {conductorRows.length > 0 && (
          <div style={{ flex: "1 1 260px" }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
              Conductors
            </div>
            <ResultTable
              name="final-conductors"
              rows={conductorRows}
              columns={[
                nameCol(),
                idCol(),
                {
                  key: "q",
                  header: `Heat Rate (${qScale.unitLabel})`,
                  numeric: (r) => r.heatRate,
                  text: (r) => formatSig(qScale.convert(r.heatRate), sigFigs),
                  csv: (r) => String(qScale.convert(r.heatRate)),
                },
                ...extraColumns(
                  CONDUCTOR_EXTRA_FIELDS,
                  conductorRows,
                  unitPrefs,
                  sigFigs,
                ),
              ]}
            />
          </div>
        )}
      </div>
    </Section>
  );
}
