/**
 * RunHistoryPanel — run history + baseline pinning (Runs view).
 *
 * The store ring-buffers the last 10 completed runs; running again never
 * destroys prior results. Each row: editable name, timestamp, mode, outcome,
 * config-hash prefix; actions to view, pin as comparison baseline, discard.
 * A pinned baseline drives delta columns in steady tables, dashed overlays
 * in transient charts, and the comparison CSV export.
 *
 * Discarding asks first (shared copy in runDiscard.ts) because it is
 * permanent: outside the undo history, and it clears the browser-storage
 * mirror so a reload will not bring the run back.
 */
import React from "react";
import { useStore } from "../store";
import ConfirmDialog, { type ConfirmRequest } from "./ConfirmDialog";
import { confirmDiscardRun } from "../runDiscard";
import {
  RunRecord,
  checkRunCompatibility,
  isTransientResult,
} from "../runHistory";
import { resolveScale } from "../format";
import { provenanceCommentLines } from "../provenance";
import { safeFilename } from "../utils";
import { diaryIndicator } from "../diaryPresentation";
import type { QuantityKind } from "../units";
import type { SteadyResult, TransientResult } from "../types";
import { csvRow } from "../csv";

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function downloadText(text: string, filename: string) {
  const blob = new Blob([text], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Long-format comparison rows: one row per element × quantity. */
function comparisonRows(
  current: RunRecord,
  baseline: RunRecord,
  prefs: ReturnType<typeof useStore.getState>["unitPreferences"],
): { header: string; lines: string[] } {
  const lines: string[] = [];
  const header = csvRow([
    "section",
    "element_id",
    "name",
    "quantity",
    "unit",
    "current",
    "baseline",
    "delta",
  ]);
  const labels = new Map<string, string>();
  for (const n of current.config.nodes) labels.set(n.id, n.label || n.id);
  for (const b of current.config.branches) labels.set(b.id, b.label || b.id);
  for (const s of current.config.solidNodes ?? [])
    labels.set(s.id, s.label || s.id);
  for (const c of current.config.conductors ?? [])
    labels.set(c.id, c.label || c.id);

  /** Extract a per-id scalar map from a run result (final step for transient). */
  const scalar = (
    r: SteadyResult | TransientResult,
    pick:
      | "nodePressure"
      | "nodeTemperature"
      | "branchMdot"
      | "branchDP"
      | "solidTemperature"
      | "conductorHeatRate",
  ): Map<string, number> => {
    const out = new Map<string, number>();
    if (isTransientResult(r)) {
      const last = r.times.length - 1;
      if (pick === "nodePressure")
        for (const [id, n] of Object.entries(r.nodes))
          out.set(id, n.pressure[last]);
      else if (pick === "nodeTemperature")
        for (const [id, n] of Object.entries(r.nodes))
          out.set(id, n.temperature[last]);
      else if (pick === "branchMdot")
        for (const [id, b] of Object.entries(r.branches))
          out.set(id, b.mdot[last]);
      else if (pick === "solidTemperature")
        for (const [id, n] of Object.entries(r.solidNodes ?? {}))
          out.set(id, n.temperature[last]);
      else if (pick === "conductorHeatRate")
        for (const [id, c] of Object.entries(r.conductors ?? {}))
          out.set(id, c.heatRate[last]);
    } else {
      if (pick === "nodePressure")
        for (const [id, n] of Object.entries(r.nodes)) out.set(id, n.pressure);
      else if (pick === "nodeTemperature")
        for (const [id, n] of Object.entries(r.nodes))
          out.set(id, n.temperature);
      else if (pick === "branchMdot")
        for (const [id, b] of Object.entries(r.branches)) out.set(id, b.mdot);
      else if (pick === "branchDP")
        for (const [id, b] of Object.entries(r.branches)) out.set(id, b.dP);
      else if (pick === "solidTemperature")
        for (const [id, n] of Object.entries(r.solidNodes ?? {}))
          out.set(id, n.temperature);
      else if (pick === "conductorHeatRate")
        for (const [id, c] of Object.entries(r.conductors ?? {}))
          out.set(id, c.heatRate);
    }
    return out;
  };

  type PickKind =
    | "nodePressure"
    | "nodeTemperature"
    | "branchMdot"
    | "branchDP"
    | "solidTemperature"
    | "conductorHeatRate";
  const emit = (
    section: string,
    pick: PickKind,
    quantity: string,
    kind: QuantityKind,
    prefKey: QuantityKind,
  ) => {
    const cur = scalar(current.result, pick);
    const base = scalar(baseline.result, pick);
    const all = [...cur.keys()].filter((id) => base.has(id));
    if (all.length === 0) return;
    const scale = resolveScale(
      [...all.flatMap((id) => [cur.get(id)!, base.get(id)!])],
      kind,
      prefs[prefKey],
    );
    for (const id of all) {
      const c = scale.convert(cur.get(id)!);
      const b = scale.convert(base.get(id)!);
      const d = (cur.get(id)! - base.get(id)!) * scale.factor;
      lines.push(
        csvRow([
          section,
          id,
          labels.get(id) ?? id,
          quantity,
          scale.unitLabel,
          c,
          b,
          d,
        ]),
      );
    }
  };

  emit("nodes", "nodePressure", "pressure", "pressure", "pressure");
  emit("nodes", "nodeTemperature", "temperature", "temperature", "temperature");
  emit("branches", "branchMdot", "mass flow", "massFlow", "massFlow");
  emit("branches", "branchDP", "pressure drop", "pressure", "pressure");
  emit(
    "solidNodes",
    "solidTemperature",
    "temperature",
    "temperature",
    "temperature",
  );
  emit("conductors", "conductorHeatRate", "heat rate", "power", "power");
  return { header, lines };
}

export default function RunHistoryPanel({
  onShowDiary,
}: { onShowDiary?: (runId: string) => void } = {}) {
  const runHistory = useStore((s) => s.runHistory);
  const selectedRunId = useStore((s) => s.selectedRunId);
  const baselineRunId = useStore((s) => s.baselineRunId);
  const selectRun = useStore((s) => s.selectRun);
  const renameRun = useStore((s) => s.renameRun);
  const deleteRun = useStore((s) => s.deleteRun);
  const setBaselineRunId = useStore((s) => s.setBaselineRunId);
  const unitPrefs = useStore((s) => s.unitPreferences);
  const modelName = useStore((s) => s.config.meta.name);

  const [confirm, setConfirm] = React.useState<ConfirmRequest | null>(null);

  const current = runHistory.find((r) => r.id === selectedRunId) ?? null;
  const baseline = runHistory.find((r) => r.id === baselineRunId) ?? null;

  if (runHistory.length === 0) return null;

  /** Diary affordance: select the run (normal row selection semantics), then
   *  bring the Solver diary section into view and focus it.  When the parent
   *  owns the diary section (ResultsPanel's disclosure), it gets the callback
   *  so it can open + focus that section after the selection re-render. */
  const showRunDiary = (r: RunRecord) => {
    if (r.id !== selectedRunId) selectRun(r.id);
    if (onShowDiary) {
      onShowDiary(r.id);
      return;
    }
    // Defer past the selection re-render so the section is in the DOM.
    requestAnimationFrame(() => {
      const el = document.querySelector('[data-testid="solver-diary"]');
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ block: "nearest" });
        el.focus({ preventScroll: true });
      }
    });
  };

  const exportComparison = async () => {
    if (!current || !baseline) return;
    const meta = await provenanceCommentLines(current.config);
    meta.push(
      `# baseline=${baseline.name} (${baseline.configHash.slice(0, 12)}, ${new Date(baseline.timestamp).toISOString()})`,
    );
    if (isTransientResult(current.result))
      meta.push("# note=values compared at final recorded time step");
    const { header, lines } = comparisonRows(current, baseline, unitPrefs);
    downloadText(
      [...meta, header, ...lines].join("\n"),
      `${safeFilename(modelName)}-comparison.csv`,
    );
  };

  return (
    <div data-testid="run-history" className="run-history">
      <div className="run-history__header">
        <span className="run-history__title">Run history</span>
        {baseline && (
          <span
            className="pill pill--info"
            data-testid="baseline-indicator"
            title={`Baseline pinned: ${baseline.name}`}
          >
            Baseline: {baseline.name}
            <button
              type="button"
              className="run-history__chip-x"
              data-testid="baseline-clear"
              aria-label="Clear baseline"
              onClick={() => setBaselineRunId(null)}
            >
              ×
            </button>
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="comparison-csv"
          className="btn btn--ghost btn--sm"
          disabled={!current || !baseline}
          title={
            current && baseline
              ? "Download current vs baseline comparison CSV (current, baseline, delta columns)"
              : "Pin a baseline run to enable the comparison export"
          }
          onClick={() => void exportComparison()}
        >
          Comparison CSV
        </button>
      </div>
      <ul className="run-history__list">
        {[...runHistory].reverse().map((r) => {
          const selected = r.id === selectedRunId;
          const isBaseline = r.id === baselineRunId;
          const compat = current
            ? checkRunCompatibility(current, r)
            : { ok: false, reason: "No current run" };
          const pinnable = !selected && compat.ok;
          const diaryInfo = r.diary ? diaryIndicator(r.diary) : null;
          return (
            <li
              key={r.id}
              data-testid="run-history-item"
              className={`run-history__item${selected ? " run-history__item--selected" : ""}`}
            >
              <button
                type="button"
                className="run-history__view"
                data-testid="run-history-view"
                onClick={() => selectRun(r.id)}
                title={
                  selected ? "Currently displayed" : "Show this run’s results"
                }
                aria-current={selected}
              >
                {selected ? "●" : "○"}
              </button>
              <RunNameInput
                name={r.name}
                onCommit={(name) => renameRun(r.id, name)}
              />
              <span
                className="run-history__meta"
                title={`Config hash ${r.configHash} · ${new Date(r.timestamp).toISOString()}`}
              >
                {fmtTime(r.timestamp)} · {r.mode} · {r.summary} ·{" "}
                {r.configHash.slice(0, 8)}
              </span>
              {diaryInfo && (
                <button
                  type="button"
                  data-testid="run-history-diary"
                  className={`run-history__diary pill ${diaryInfo.warnings > 0 ? "pill--warn" : "pill--muted"}`}
                  title={`Solver diary — ${diaryInfo.digest}`}
                  aria-label={`Show solver diary for ${r.name}: ${diaryInfo.events} event${diaryInfo.events === 1 ? "" : "s"}${diaryInfo.warnings > 0 ? `, ${diaryInfo.warnings} warning${diaryInfo.warnings === 1 ? "" : "s"}` : ""}`}
                  onClick={() => showRunDiary(r)}
                >
                  Diary · {diaryInfo.events}
                  {diaryInfo.warnings > 0
                    ? ` · ${diaryInfo.warnings} warn`
                    : ""}
                </button>
              )}
              {isBaseline && (
                <span className="pill pill--info run-history__baseline-tag">
                  baseline
                </span>
              )}
              <button
                type="button"
                data-testid="pin-baseline"
                className="btn btn--ghost btn--sm"
                aria-pressed={isBaseline}
                disabled={!pinnable && !isBaseline}
                title={
                  isBaseline
                    ? "Unpin baseline"
                    : pinnable
                      ? "Pin as comparison baseline"
                      : `Cannot pin: ${compat.reason ?? "incompatible"}`
                }
                onClick={() => setBaselineRunId(isBaseline ? null : r.id)}
              >
                {isBaseline ? "Unpin" : "Pin baseline"}
              </button>
              <button
                type="button"
                data-testid="run-history-delete"
                className="btn btn--ghost btn--sm"
                aria-label={`Discard ${r.name}`}
                title="Discard this run (records are immutable until discarded)"
                onClick={() =>
                  setConfirm(confirmDiscardRun(r.name, () => deleteRun(r.id)))
                }
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
      {confirm && (
        <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      )}
    </div>
  );
}

/** Editable run name (commit on blur/Enter, Escape reverts). */
function RunNameInput({
  name,
  onCommit,
}: {
  name: string;
  onCommit: (v: string) => void;
}) {
  const [raw, setRaw] = React.useState(name);
  const [focused, setFocused] = React.useState(false);
  React.useEffect(() => {
    if (!focused) setRaw(name);
  }, [name, focused]);
  const commit = () => {
    setFocused(false);
    const t = raw.trim();
    if (t && t !== name) onCommit(t);
    else setRaw(name);
  };
  return (
    <input
      data-testid="run-history-name"
      className="input run-history__name"
      type="text"
      value={focused ? raw : name}
      aria-label="Run name"
      onFocus={() => {
        setRaw(name);
        setFocused(true);
      }}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setRaw(name);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
