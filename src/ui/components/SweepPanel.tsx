/**
 * SweepPanel.tsx — the Sweep workspace: first-class UI for the session-only
 * parameter-sweep ("Exploration") POC built on src/ui/sweep.
 *
 * Layout: a definition card (target picker with search + grouped options,
 * start/end/count in the target's config-native unit, validation banners,
 * Create / Run Sweep / New sweep), a busy-explanation note (manual run or
 * another sweep active), and the session's job cards (status, summary,
 * frozen-snapshot staleness banner, Cancel / Rerun incomplete / Rerun all /
 * Discard / Export CSV, and — for the selected job — a live progress line
 * and the per-variant results table with Promote).
 *
 * Isolation guarantees come from the sweep store: creating/running a sweep
 * only READS the canonical config (a deep-frozen clone at job creation);
 * the model, its text, undo history, and localStorage are never touched.
 * The single bridge into the canonical store is Promote, which appends one
 * run record to Analysis run history and selects it.
 */
import React from "react";
import { useStore } from "../store";
import { configHash } from "../provenance";
import { diaryIndicatorText } from "../diaryPresentation";
import { formatNumber } from "../units";
import type { ProgressPayload } from "../workerClient";
import type { UnitPreferences } from "../units";
import {
  SWEEP_MAX_VARIANTS,
  isRangeSweep,
  listSweepTargets,
  resolveSweepTarget,
  validateSweepDefinition,
  type OptionSweepDescriptor,
  type SolveJob,
  type SweepDefinition,
  type SweepTargetDescriptor,
  type SweepValidation,
} from "../sweep";
import { useSweepStore } from "../sweep/store";
import {
  buildSweepCsv,
  checkSweepOptions,
  defaultOptionSelection,
  defaultSweepRange,
  filterSweepTargets,
  formatSweepValue,
  formatVariantRow,
  groupSweepTargets,
  parseCountInput,
  parseSweepNumber,
  preselectTarget,
  sweepCsvFilename,
  sweepProgressLine,
  targetKey,
  toggleOptionId,
  DEFAULT_SWEEP_COUNT,
  type SweepOptionValidity,
} from "../sweep/uiPolicy";

/** Blob + anchor download, mirroring downloadModelText's conventions. */
function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const STATUS_PILL_CLASS: Record<string, string> = {
  pending: "pill pill--muted",
  running: "pill pill--info",
  completed: "pill pill--ok",
  failed: "pill pill--danger",
  cancelled: "pill pill--warn",
};

function StatusPill({ status, testid }: { status: string; testid?: string }) {
  return (
    <span className={STATUS_PILL_CLASS[status] ?? "pill"} data-testid={testid}>
      {status}
    </span>
  );
}

export default function SweepPanel(): React.ReactElement {
  const config = useStore((s) => s.config);
  const selection = useStore((s) => s.selection);
  const unitPrefs = useStore((s) => s.unitPreferences);
  const sigFigs = useStore((s) => s.resultSigFigs);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const manualBusy = useStore(
    (s) => s.running || s.preparingOperation !== null,
  );

  const jobs = useSweepStore((s) => s.jobs);
  const activeJobId = useSweepStore((s) => s.activeJobId);
  const activeVariantIndex = useSweepStore((s) => s.activeVariantIndex);
  const activeProgress = useSweepStore((s) => s.activeProgress);
  const sweepRunning = activeJobId !== null;

  const liveHash = React.useMemo(() => configHash(config), [config]);
  const targets = React.useMemo(() => listSweepTargets(config), [config]);

  /* ── Definition form state (raw strings + committed values; numeric
   *    inputs commit on blur/Enter, matching NumberField/UnitInput). ── */
  const [query, setQuery] = React.useState("");
  const [selectedKey, setSelectedKey] = React.useState("");
  const [startRaw, setStartRaw] = React.useState("");
  const [endRaw, setEndRaw] = React.useState("");
  const [countRaw, setCountRaw] = React.useState(String(DEFAULT_SWEEP_COUNT));
  const [startVal, setStartVal] = React.useState<number | undefined>(undefined);
  const [endVal, setEndVal] = React.useState<number | undefined>(undefined);
  const [countVal, setCountVal] = React.useState<number | undefined>(
    DEFAULT_SWEEP_COUNT,
  );
  /** Chosen option ids for a categorical target, in click order. */
  const [optionIds, setOptionIds] = React.useState<string[]>([]);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null);
  /** True once the user edits anything; stops selection-follow preselection
   *  from clobbering their form. */
  const touchedRef = React.useRef(false);

  const descriptor = React.useMemo(
    () => targets.find((d) => targetKey(d.target) === selectedKey),
    [targets, selectedKey],
  );

  const applyDescriptor = React.useCallback(
    (d: SweepTargetDescriptor) => {
      setSelectedKey(targetKey(d.target));
      setNotice(null);
      if (d.axis === "options") {
        setOptionIds(defaultOptionSelection(config, d));
        return;
      }
      const range = defaultSweepRange(d);
      setStartRaw(formatNumber(range.start));
      setEndRaw(formatNumber(range.end));
      setCountRaw(String(range.count));
      setStartVal(range.start);
      setEndVal(range.end);
      setCountVal(range.count);
    },
    [config],
  );

  /* Preselection: on mount / when the selected target vanishes from the
   * live config, preselect from the current canvas selection (else the
   * first target).  While the form is untouched, follow selection changes. */
  React.useEffect(() => {
    if (targets.length === 0) return;
    const current = targets.find((d) => targetKey(d.target) === selectedKey);
    if (current) {
      if (!touchedRef.current) {
        const wanted = preselectTarget(targets, selection);
        if (wanted && targetKey(wanted.target) !== targetKey(current.target))
          applyDescriptor(wanted);
      }
      return;
    }
    applyDescriptor(
      preselectTarget(
        targets,
        touchedRef.current ? { kind: "none" } : selection,
      ) ?? targets[0],
    );
  }, [targets, selectedKey, selection, applyDescriptor]);

  const definition: SweepDefinition | null = React.useMemo(() => {
    if (!descriptor) return null;
    if (descriptor.axis === "options") {
      if (optionIds.length === 0) return null;
      return { target: descriptor.target, spacing: "options", optionIds };
    }
    if (
      startVal === undefined ||
      endVal === undefined ||
      countVal === undefined
    )
      return null;
    return {
      target: descriptor.target,
      start: startVal,
      end: endVal,
      count: countVal,
      spacing: "linear",
    };
  }, [descriptor, startVal, endVal, countVal, optionIds]);

  /** Per-option validity for a categorical target, shown inline in the
   *  picker so an unavailable choice explains itself. */
  const optionValidity = React.useMemo(
    () =>
      descriptor?.axis === "options"
        ? checkSweepOptions(config, descriptor)
        : [],
    [config, descriptor],
  );

  /* Advisory live validation (commit granularity — never per keystroke).
   * The authoritative gate re-validates at creation time in handleCreate. */
  const validation: SweepValidation | null = React.useMemo(
    () => (definition ? validateSweepDefinition(config, definition) : null),
    [config, definition],
  );

  const formIncomplete = definition === null;
  const definitionErrors =
    validation && !validation.ok ? validation.errors : [];
  const invalidValues = validation?.ok ? validation.invalidValues : [];
  const canSubmit =
    !formIncomplete &&
    definitionErrors.length === 0 &&
    invalidValues.length === 0;
  const startBlocked = sweepRunning || manualBusy;

  const handleCreate = (run: boolean) => {
    setNotice(null);
    if (!definition) {
      setNotice(
        descriptor?.axis === "options"
          ? "Choose a target and select at least one option."
          : "Choose a target and enter finite start/end values plus an integer count.",
      );
      return;
    }
    // Re-validate against the freshest canonical config at creation time.
    const fresh = validateSweepDefinition(
      useStore.getState().config,
      definition,
    );
    if (!fresh.ok) {
      setNotice(fresh.errors.join(" "));
      return;
    }
    if (fresh.invalidValues.length > 0) {
      setNotice(
        `${fresh.invalidValues.length} of ${fresh.values.length} variant values fail model validation — ` +
          (descriptor?.axis === "options"
            ? "deselect those options before creating the sweep."
            : "adjust the range before creating the sweep."),
      );
      return;
    }
    let job: SolveJob;
    try {
      job = useSweepStore.getState().createJob(definition);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
      return;
    }
    setSelectedJobId(job.id);
    if (!run) return;
    const started = useSweepStore.getState().startJob(job.id);
    if (!started.ok) {
      setNotice(
        `${started.reason} — the job was created; start it from its card below.`,
      );
      return;
    }
    // The terminal job state lands in the store; `finished` only rejects in
    // the (impossible here) job-disappeared path — swallow defensively.
    void started.finished.catch(() => {});
  };

  const handleNewSweep = () => {
    touchedRef.current = false;
    setNotice(null);
    const pre = preselectTarget(targets, selection) ?? targets[0];
    if (pre) {
      applyDescriptor(pre);
    } else {
      setSelectedKey("");
      setStartRaw("");
      setEndRaw("");
      setCountRaw(String(DEFAULT_SWEEP_COUNT));
      setStartVal(undefined);
      setEndVal(undefined);
      setCountVal(DEFAULT_SWEEP_COUNT);
      setOptionIds([]);
    }
  };

  const handleStart = (job: SolveJob) => {
    setNotice(null);
    const started = useSweepStore.getState().startJob(job.id);
    if (!started.ok) {
      setNotice(started.reason);
      return;
    }
    setSelectedJobId(job.id);
    void started.finished.catch(() => {});
  };

  const handleCancel = (job: SolveJob) => {
    const r = useSweepStore.getState().cancelJob(job.id);
    if (!r.ok) setNotice(r.reason);
  };

  const handleRerun = (job: SolveJob, scope: "incomplete" | "all") => {
    setNotice(null);
    const store = useSweepStore.getState();
    const rr = store.rerunJob(job.id, { scope });
    if (!rr.ok) {
      setNotice(rr.reason);
      return;
    }
    const started = store.startJob(job.id);
    if (!started.ok) {
      setNotice(
        `${started.reason} — the job was reset to pending; start it from its card.`,
      );
      return;
    }
    setSelectedJobId(job.id);
    void started.finished.catch(() => {});
  };

  const handleDiscard = (job: SolveJob) => {
    const r = useSweepStore.getState().discardJob(job.id);
    if (!r.ok) {
      setNotice(r.reason);
      return;
    }
    if (selectedJobId === job.id) setSelectedJobId(null);
  };

  const handlePromote = (job: SolveJob, index: number) => {
    const r = useSweepStore.getState().promoteVariant(job.id, index);
    if (!r.ok) {
      setNotice(r.reason);
      return;
    }
    setActiveTab("results");
  };

  const handleExport = (job: SolveJob) => {
    downloadCsv(buildSweepCsv(job, { unitPrefs }), sweepCsvFilename(job));
  };

  /* The target picker keeps the selected target visible even when the
   * search filter hides it. */
  const filteredTargets = React.useMemo(() => {
    const filtered = filterSweepTargets(targets, query);
    if (
      descriptor &&
      !filtered.some((d) => targetKey(d.target) === selectedKey)
    ) {
      filtered.unshift(descriptor);
    }
    return filtered;
  }, [targets, query, descriptor, selectedKey]);
  const groups = React.useMemo(
    () => groupSweepTargets(filteredTargets),
    [filteredTargets],
  );

  const shownJob =
    jobs.find((j) => j.id === selectedJobId) ??
    jobs.find((j) => j.id === activeJobId) ??
    jobs[jobs.length - 1];

  const numericDescriptor =
    descriptor?.axis === "numeric" ? descriptor : undefined;
  const optionDescriptor =
    descriptor?.axis === "options" ? descriptor : undefined;

  const boundsHint = numericDescriptor?.bounds
    ? ` · advisory ${[
        numericDescriptor.bounds.min !== undefined
          ? `min ${formatNumber(numericDescriptor.bounds.min)}`
          : "",
        numericDescriptor.bounds.max !== undefined
          ? `max ${formatNumber(numericDescriptor.bounds.max)}`
          : "",
      ]
        .filter(Boolean)
        .join(", ")}`
    : "";

  return (
    <div data-testid="sweep-panel" className="sweep-panel">
      <div
        className="banner banner--info"
        data-testid="sweep-session-note"
        role="note"
      >
        Parameter sweeps are session-only: jobs are never written to the model
        file or browser storage, and creating or running a sweep never changes
        the model, its text, or undo history. Promote a completed variant to
        keep its result in Analysis run history.
      </div>

      <section className="card" aria-labelledby="sweep-definition-title">
        <h2 id="sweep-definition-title" className="sweep-card-title">
          Define a sweep
        </h2>
        {targets.length === 0 ? (
          <p className="text-3" data-testid="sweep-no-targets">
            No sweepable fields yet — add nodes, branches, conductors, or
            transient settings first.
          </p>
        ) : (
          <>
            <div className="sweep-form-row">
              <div className="field">
                <label className="field__label" htmlFor="sweep-target-search">
                  Filter targets
                </label>
                <input
                  id="sweep-target-search"
                  data-testid="sweep-target-search"
                  className="input"
                  type="text"
                  value={query}
                  placeholder="Type to filter…"
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="field field--target">
                <label className="field__label" htmlFor="sweep-target">
                  Sweep target
                </label>
                <select
                  id="sweep-target"
                  data-testid="sweep-target"
                  className="select"
                  value={selectedKey}
                  onChange={(e) => {
                    touchedRef.current = true;
                    const next = targets.find(
                      (d) => targetKey(d.target) === e.target.value,
                    );
                    if (next) applyDescriptor(next);
                  }}
                >
                  {groups.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.targets.map((d) => (
                        <option
                          key={targetKey(d.target)}
                          value={targetKey(d.target)}
                        >
                          {d.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            </div>
            <div className="sweep-form-row">
              {optionDescriptor ? (
                <SweepOptionPicker
                  descriptor={optionDescriptor}
                  selected={optionIds}
                  validity={optionValidity}
                  onToggle={(id) => {
                    touchedRef.current = true;
                    setOptionIds((prev) => toggleOptionId(prev, id));
                  }}
                />
              ) : (
                <>
                  <SweepNumberInput
                    id="sweep-start"
                    label="Start"
                    unit={numericDescriptor?.unit}
                    raw={startRaw}
                    invalid={startRaw.trim() !== "" && startVal === undefined}
                    onRawChange={(v) => {
                      touchedRef.current = true;
                      setStartRaw(v);
                    }}
                    onCommit={() => setStartVal(parseSweepNumber(startRaw))}
                  />
                  <SweepNumberInput
                    id="sweep-end"
                    label="End"
                    unit={numericDescriptor?.unit}
                    raw={endRaw}
                    invalid={endRaw.trim() !== "" && endVal === undefined}
                    onRawChange={(v) => {
                      touchedRef.current = true;
                      setEndRaw(v);
                    }}
                    onCommit={() => setEndVal(parseSweepNumber(endRaw))}
                  />
                  <SweepNumberInput
                    id="sweep-count"
                    label="Variants"
                    raw={countRaw}
                    invalid={countRaw.trim() !== "" && countVal === undefined}
                    onRawChange={(v) => {
                      touchedRef.current = true;
                      setCountRaw(v);
                    }}
                    onCommit={() => setCountVal(parseCountInput(countRaw))}
                  />
                </>
              )}
              <div className="sweep-form-actions">
                <button
                  type="button"
                  data-testid="sweep-run"
                  className="btn btn--primary"
                  disabled={!canSubmit || startBlocked}
                  title={
                    startBlocked
                      ? "Blocked while another run is active"
                      : !canSubmit
                        ? "Fix the definition errors below first"
                        : "Create the sweep and run all variants sequentially"
                  }
                  onClick={() => handleCreate(true)}
                >
                  Run Sweep
                </button>
                <button
                  type="button"
                  data-testid="sweep-create"
                  className="btn"
                  disabled={!canSubmit}
                  title={
                    canSubmit
                      ? "Create the sweep job without starting it"
                      : "Fix the definition errors below first"
                  }
                  onClick={() => handleCreate(false)}
                >
                  Create
                </button>
                <button
                  type="button"
                  data-testid="sweep-new"
                  className="btn btn--ghost"
                  title="Reset the form to selection-based defaults"
                  onClick={handleNewSweep}
                >
                  New sweep
                </button>
              </div>
            </div>
            {numericDescriptor && (
              <div
                className="field__hint sweep-hint"
                data-testid="sweep-target-hint"
              >
                Current value {formatNumber(numericDescriptor.currentValue)}
                {numericDescriptor.unit !== "-"
                  ? ` ${numericDescriptor.unit}`
                  : ""}{" "}
                · values are entered in{" "}
                {numericDescriptor.unit !== "-"
                  ? numericDescriptor.unit
                  : "raw config units"}{" "}
                (config-native SI) · linear spacing · 1–{SWEEP_MAX_VARIANTS}{" "}
                variants{boundsHint}; per-variant model validation is
                authoritative
              </div>
            )}
            {optionDescriptor && (
              <div
                className="field__hint sweep-hint"
                data-testid="sweep-target-hint"
              >
                {optionIds.length} of {optionDescriptor.options.length} options
                selected · one variant per option, solved in the order shown ·
                each variant changes only this field (and drops companion
                settings the choice makes invalid); per-variant model validation
                is authoritative
              </div>
            )}
            {formIncomplete && targets.length > 0 && (
              <div
                className="field__hint sweep-hint"
                data-testid="sweep-form-incomplete"
              >
                {optionDescriptor
                  ? "Select at least one option to enable Run."
                  : "Enter finite start/end values and an integer variant count to enable Run."}
              </div>
            )}
            {definitionErrors.length > 0 && (
              <div
                className="banner banner--error"
                role="alert"
                data-testid="sweep-definition-errors"
              >
                <ul>
                  {definitionErrors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
            {invalidValues.length > 0 && validation?.ok && (
              <div
                className="banner banner--error"
                role="alert"
                data-testid="sweep-invalid-values"
              >
                <div>
                  {invalidValues.length} of {validation.values.length} variant
                  values fail model validation — the sweep cannot be created:
                </div>
                <ul>
                  {invalidValues.slice(0, 5).map((iv) => (
                    <li key={iv.index}>
                      value {formatSweepValue(iv)}: {iv.errors[0]}
                      {iv.errors.length > 1
                        ? ` (+${iv.errors.length - 1} more)`
                        : ""}
                    </li>
                  ))}
                  {invalidValues.length > 5 && (
                    <li>… and {invalidValues.length - 5} more</li>
                  )}
                </ul>
              </div>
            )}
            {validation?.ok && invalidValues.length === 0 && descriptor && (
              <div className="sweep-values" data-testid="sweep-values-preview">
                <span className="sweep-values__label">
                  Values
                  {numericDescriptor && numericDescriptor.unit !== "-"
                    ? ` (${numericDescriptor.unit})`
                    : ""}
                  :
                </span>{" "}
                {validation.values
                  .slice(0, 8)
                  .map((v) =>
                    typeof v === "number"
                      ? formatNumber(v)
                      : (optionDescriptor?.options.find((o) => o.id === v)
                          ?.label ?? v),
                  )
                  .join(", ")}
                {validation.values.length > 8
                  ? `, … (${validation.values.length} total)`
                  : ""}
              </div>
            )}
          </>
        )}
      </section>

      {startBlocked && (
        <div
          className="banner banner--warn"
          role="status"
          data-testid="sweep-busy-note"
        >
          {manualBusy
            ? "A manual run is active — sweeps can be defined and created now, but starting is blocked until it finishes."
            : "A sweep is already running — cancel it or wait for completion before starting another."}
        </div>
      )}

      {notice && (
        <div
          className="banner banner--error"
          role="alert"
          data-testid="sweep-notice"
        >
          {notice}
        </div>
      )}

      <section aria-label="Sweep jobs" className="sweep-jobs">
        {jobs.length === 0 ? (
          <p className="empty-state" data-testid="sweep-empty">
            No sweeps yet this session.
          </p>
        ) : (
          jobs.map((job) => (
            <SweepJobCard
              key={job.id}
              job={job}
              isActive={job.id === activeJobId}
              isSelected={shownJob?.id === job.id}
              activeVariantIndex={activeVariantIndex}
              activeProgress={activeProgress}
              stale={job.baseConfigHash !== liveHash}
              startBlocked={startBlocked}
              unitPrefs={unitPrefs}
              sigFigs={sigFigs}
              onSelect={() => setSelectedJobId(job.id)}
              onStart={() => handleStart(job)}
              onCancel={() => handleCancel(job)}
              onRerun={(scope) => handleRerun(job, scope)}
              onDiscard={() => handleDiscard(job)}
              onExport={() => handleExport(job)}
              onPromote={(index) => handlePromote(job, index)}
            />
          ))
        )}
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Job card                                                                */
/* ---------------------------------------------------------------------- */

function SweepJobCard({
  job,
  isActive,
  isSelected,
  activeVariantIndex,
  activeProgress,
  stale,
  startBlocked,
  unitPrefs,
  sigFigs,
  onSelect,
  onStart,
  onCancel,
  onRerun,
  onDiscard,
  onExport,
  onPromote,
}: {
  job: SolveJob;
  isActive: boolean;
  isSelected: boolean;
  activeVariantIndex: number | null;
  activeProgress: ProgressPayload | null;
  stale: boolean;
  startBlocked: boolean;
  unitPrefs: UnitPreferences;
  sigFigs: number;
  onSelect: () => void;
  onStart: () => void;
  onCancel: () => void;
  onRerun: (scope: "incomplete" | "all") => void;
  onDiscard: () => void;
  onExport: () => void;
  onPromote: (index: number) => void;
}) {
  const valueUnit = React.useMemo(() => {
    const r = resolveSweepTarget(job.baseConfig, job.sweep.target);
    return r.ok && r.descriptor.axis === "numeric" ? r.descriptor.unit : "-";
  }, [job]);

  /** The axis in one phrase: a range's endpoints, or the option count. */
  const axisText = isRangeSweep(job.sweep)
    ? `${formatNumber(job.sweep.start)} … ${formatNumber(job.sweep.end)}`
    : `${job.sweep.optionIds.length} options`;

  const terminal =
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "cancelled";
  const progressPct =
    job.progress.total > 0
      ? Math.min(
          100,
          Math.round((job.progress.completed / job.progress.total) * 100),
        )
      : 0;

  return (
    <div className="card sweep-job" data-testid="sweep-job">
      <div className="sweep-job__header">
        <button
          type="button"
          className="sweep-job__heading"
          data-testid="sweep-job-toggle"
          onClick={onSelect}
          aria-expanded={isSelected}
          title={isSelected ? "Hide variant table" : "Show variant table"}
        >
          <span className="sweep-job__title">{job.targetLabel}</span>
          <span className="sweep-job__meta">
            {axisText} · {job.variants.length} variants ·{" "}
            {new Date(job.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        </button>
        <StatusPill status={job.status} testid="sweep-job-status" />
        {job.summary && (
          <span className="sweep-job__meta" data-testid="sweep-job-summary">
            {job.summary}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {job.status === "pending" && (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            data-testid="sweep-start"
            disabled={startBlocked}
            title={
              startBlocked
                ? "Blocked while another run is active"
                : "Start this sweep"
            }
            onClick={onStart}
          >
            Start
          </button>
        )}
        {job.status === "running" && (
          <button
            type="button"
            className="btn btn--danger btn--sm"
            data-testid="sweep-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
        {terminal && (
          <>
            <button
              type="button"
              className="btn btn--sm"
              data-testid="sweep-rerun-incomplete"
              disabled={startBlocked}
              title="Reset failed/cancelled/unsolved variants to pending and run them (completed results are kept)"
              onClick={() => onRerun("incomplete")}
            >
              Rerun incomplete
            </button>
            <button
              type="button"
              className="btn btn--sm"
              data-testid="sweep-rerun-all"
              disabled={startBlocked}
              title="Reset every variant to pending and rerun the whole sweep"
              onClick={() => onRerun("all")}
            >
              Rerun all
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              data-testid="sweep-discard"
              title="Remove this sweep job from the session list"
              onClick={onDiscard}
            >
              Discard
            </button>
          </>
        )}
        {job.status === "pending" && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            data-testid="sweep-discard"
            title="Remove this sweep job from the session list"
            onClick={onDiscard}
          >
            Discard
          </button>
        )}
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          data-testid="sweep-export-csv"
          title="Download one-row-per-variant CSV with provenance (base hash, target, start/end/count)"
          onClick={onExport}
        >
          Export CSV
        </button>
      </div>

      {stale && (
        <div
          className="banner banner--warn"
          role="status"
          data-testid="sweep-stale-banner"
        >
          The model changed since this sweep was created. The job solves a
          frozen snapshot taken at creation (base hash{" "}
          {job.baseConfigHash.slice(0, 8)}); its results stay valid for that
          snapshot and never overwrite the current model. Create a new sweep to
          use the current model.
        </div>
      )}

      {job.error && (
        <div
          className="banner banner--error"
          role="alert"
          data-testid="sweep-job-error"
        >
          {job.error}
        </div>
      )}

      {isSelected && (
        <>
          <div
            className="sweep-status-line"
            role="status"
            aria-live="polite"
            data-testid="sweep-progress"
          >
            {sweepProgressLine({
              job,
              activeVariantIndex: isActive ? activeVariantIndex : null,
              activeProgress: isActive ? activeProgress : null,
              valueUnit,
              sigFigs,
            })}
          </div>
          {job.status === "running" && (
            <div
              className="progress__track sweep-progress-track"
              role="progressbar"
              aria-label="Sweep variant progress"
              aria-valuemin={0}
              aria-valuemax={job.progress.total}
              aria-valuenow={job.progress.completed}
              data-testid="sweep-progress-bar"
            >
              <div
                className="progress__fill"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          )}
          <div className="results-table-wrap sweep-variants-wrap">
            <table className="table" data-testid="sweep-variants-table">
              <caption className="visually-hidden">
                Sweep variants for {job.targetLabel}; base config hash{" "}
                {job.baseConfigHash}
              </caption>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">
                    Value{valueUnit !== "-" ? ` (${valueUnit})` : ""}
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Converged</th>
                  <th scope="col">Solve detail</th>
                  <th
                    scope="col"
                    title="Convergence diary captured during the variant's solve (event count · warnings)"
                  >
                    Diary
                  </th>
                  <th scope="col">Peak |ṁ|</th>
                  <th scope="col">Pressure range</th>
                  <th scope="col">Temperature range</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {job.variants.map((v) => {
                  const row = formatVariantRow(v, { unitPrefs, sigFigs });
                  return (
                    <tr key={v.index} data-testid="sweep-variant-row">
                      <td>{v.index + 1}</td>
                      <td data-testid={`sweep-variant-value-${v.index}`}>
                        {row.value}
                      </td>
                      <td>
                        <StatusPill
                          status={v.status}
                          testid={`sweep-variant-status-${v.index}`}
                        />
                      </td>
                      <td data-testid={`sweep-variant-converged-${v.index}`}>
                        {row.converged}
                      </td>
                      <td
                        className={row.error ? "sweep-cell-error" : undefined}
                        title={row.error || undefined}
                      >
                        {row.detail}
                      </td>
                      <td
                        data-testid={`sweep-variant-diary-${v.index}`}
                        className={
                          v.diary && v.diary.summary.warningCount > 0
                            ? "sweep-cell-warn"
                            : undefined
                        }
                        title={
                          v.diary
                            ? `Solver diary — ${v.diary.summary.digest}`
                            : undefined
                        }
                      >
                        {v.diary ? diaryIndicatorText(v.diary) : "—"}
                      </td>
                      <td>{row.peakMdot}</td>
                      <td>{row.pressure}</td>
                      <td>{row.temperature}</td>
                      <td>{row.duration}</td>
                      <td>
                        {v.status === "completed" && (
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            data-testid={`sweep-promote-${v.index}`}
                            title="Append this variant's result to Analysis run history and show it"
                            onClick={() => onPromote(v.index)}
                          >
                            Promote
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Commit-on-blur/Enter numeric input (NumberField semantics, local raw)   */
/* ---------------------------------------------------------------------- */

/**
 * Checklist for a categorical target: one row per registry option, with the
 * choice the model currently holds marked, and the validateNetwork reason
 * shown inline on any option that cannot be solved as things stand (a
 * missing segmentLength, a correlation that needs the realFluid model).
 * Unavailable options stay checkable — selecting one puts its reason in the
 * definition banner, which is how you learn what the comparison needs.
 */
function SweepOptionPicker({
  descriptor,
  selected,
  validity,
  onToggle,
}: {
  descriptor: OptionSweepDescriptor;
  selected: readonly string[];
  validity: readonly SweepOptionValidity[];
  onToggle: (id: string) => void;
}) {
  return (
    <fieldset className="field field--options" data-testid="sweep-options">
      <legend className="field__label">Options</legend>
      <div className="sweep-options__list">
        {descriptor.options.map((option) => {
          const invalid = validity.find((v) => v.id === option.id && !v.ok);
          const isCurrent = option.id === descriptor.currentOptionId;
          return (
            <label
              key={option.id}
              className={`sweep-option${invalid ? " sweep-option--invalid" : ""}`}
              data-testid={`sweep-option-${option.id}`}
            >
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                onChange={() => onToggle(option.id)}
              />
              <span className="sweep-option__label">
                {option.label}
                {isCurrent && (
                  <span className="sweep-option__badge">current</span>
                )}
              </span>
              {(invalid?.error ?? option.hint) && (
                <span className="sweep-option__hint">
                  {invalid?.error ?? option.hint}
                </span>
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function SweepNumberInput({
  id,
  label,
  unit,
  raw,
  invalid,
  onRawChange,
  onCommit,
}: {
  id: string;
  label: string;
  unit?: string;
  raw: string;
  invalid: boolean;
  onRawChange: (v: string) => void;
  onCommit: () => void;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {unit && unit !== "-" ? (
          <>
            {" "}
            <span className="field__unit">({unit})</span>
          </>
        ) : null}
      </label>
      <input
        id={id}
        data-testid={id}
        className="input"
        type="text"
        inputMode="decimal"
        value={raw}
        aria-invalid={invalid}
        onChange={(e) => onRawChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onCommit();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}
