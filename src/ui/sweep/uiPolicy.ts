/**
 * sweep/uiPolicy.ts — pure UI-policy helpers for the Sweep workspace
 * (src/ui/components/SweepPanel.tsx).  Everything here is a pure function
 * over the sweep domain contracts and plain view inputs — no React, no
 * zustand, no worker protocol — so the panel's behavior (target identity
 * keys for form controls, selection-driven preselection, grouping/filtering
 * for the target picker, default ranges, input parsing, per-variant row
 * formatting, the progress line, and CSV export generation) is testable
 * without a DOM.
 *
 * Both axis kinds pass through here: a numeric target contributes a default
 * range and a unit, a categorical one a default option selection and
 * per-option labels.  Option values are never formatted as numbers and
 * never carry a unit — an option names itself.
 *
 * Unit honesty policy:
 *   - The definition form and the variant VALUE column use the descriptor's
 *     `unit` verbatim.  That unit is the config-native unit by construction
 *     (base SI for real quantity kinds, 'deg' for angles, and the truthful
 *     raw symbol — kg, J/(kg·K), W/K — for dimensionless-reported raw
 *     fields), so entered/submitted values are config-native SI BY
 *     CONSTRUCTION and no conversion is ever applied (raw/dimensionless
 *     kinds can never be mis-converted).
 *   - Result-envelope columns (pressure / temperature / peak |mdot|) have
 *     real quantity kinds and honor the user's unit preferences via
 *     format.ts, exactly like the Analysis tables.  CSV envelope columns
 *     carry ONE resolved display unit per column (named in the header);
 *     the sweep value column and all other columns stay config-native/raw.
 */
import type { NetworkConfig } from "../../core";
import type { Selection } from "../types";
import type { ProgressPayload } from "../workerClient";
import type { QuantityKind, UnitPreferences } from "../units";
import {
  formatSig,
  formatWithUnit,
  resolveScale,
  type ScaleChoice,
} from "../format";
import { safeFilename } from "../utils";
import { csvCell, csvCommentValue } from "../csv";
import { resolveSweepTarget } from "./targets";
import { validateSweepDefinition } from "./variants";
import type {
  NumericSweepDescriptor,
  OptionSweepDescriptor,
  SolveJob,
  SweepTarget,
  SweepTargetDescriptor,
  SweepValue,
  SweepVariantRecord,
  SweepVariantStatus,
  ValueEnvelope,
} from "./types";
import { SWEEP_MAX_VARIANTS, isOptionSweep, isRangeSweep } from "./types";

/** Default variant count offered by the definition form. */
export const DEFAULT_SWEEP_COUNT = 5;

/* ------------------------------------------------------------------ */
/* Target identity for form controls (select option values)            */
/* ------------------------------------------------------------------ */

/**
 * Stable string key for a sweep target.  JSON key order is fixed by the
 * construction sites in targets.ts ({kind, id, field}), so stringify is a
 * canonical encoding; correlation sub-fields contain dots but no quotes.
 */
export function targetKey(target: SweepTarget): string {
  return JSON.stringify(target);
}

/**
 * Inverse of targetKey for select-change handling.  Shape-checked; field
 * literal types are NOT re-validated here (resolveSweepTarget is the
 * authority and reports bad fields without throwing).  Returns undefined
 * for malformed keys.
 */
export function parseTargetKey(key: string): SweepTarget | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(key);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const t = raw as { kind?: unknown; id?: unknown; field?: unknown };
  if (typeof t.field !== "string" || t.field.length === 0) return undefined;
  if (t.kind === "settings") {
    return { kind: "settings", field: t.field } as SweepTarget;
  }
  if (
    (t.kind === "node" ||
      t.kind === "solidNode" ||
      t.kind === "branch" ||
      t.kind === "conductor") &&
    typeof t.id === "string" &&
    t.id.length > 0
  ) {
    return { kind: t.kind, id: t.id, field: t.field } as SweepTarget;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Preselection, grouping, filtering                                   */
/* ------------------------------------------------------------------ */

/**
 * Pick the descriptor to preselect: the first enumerated field of the
 * currently selected element (node / solid node / branch / conductor),
 * falling back to the first enumerated target overall.  Field-table order
 * is the priority order (a fluid node's pressure, a solid node's
 * temperature, a valve's area, …).
 */
export function preselectTarget(
  descriptors: readonly SweepTargetDescriptor[],
  selection: Selection,
): SweepTargetDescriptor | undefined {
  const match = descriptors.find((d) => {
    const t = d.target;
    switch (selection.kind) {
      case "node":
        return t.kind === "node" && t.id === selection.id;
      case "solidNode":
        return t.kind === "solidNode" && t.id === selection.id;
      case "branch":
        return t.kind === "branch" && t.id === selection.id;
      case "conductor":
        return t.kind === "conductor" && t.id === selection.id;
      default:
        return false;
    }
  });
  return match ?? descriptors[0];
}

/** Target picker group label per target family. */
export function sweepTargetGroupLabel(target: SweepTarget): string {
  switch (target.kind) {
    case "settings":
      return "Settings";
    case "node":
      return "Fluid nodes";
    case "solidNode":
      return "Solid nodes";
    case "branch":
      return "Branches";
    case "conductor":
      return "Conductors";
  }
}

export interface SweepTargetGroup {
  label: string;
  targets: SweepTargetDescriptor[];
}

/** Group descriptors by family for <optgroup> rendering, preserving the
 *  enumeration order of listSweepTargets; empty families are omitted. */
export function groupSweepTargets(
  descriptors: readonly SweepTargetDescriptor[],
): SweepTargetGroup[] {
  const byLabel = new Map<string, SweepTargetDescriptor[]>();
  for (const d of descriptors) {
    const label = sweepTargetGroupLabel(d.target);
    const group = byLabel.get(label);
    if (group) group.push(d);
    else byLabel.set(label, [d]);
  }
  return [...byLabel.entries()].map(([label, targets]) => ({ label, targets }));
}

/** Case-insensitive substring filter over the human target label. */
export function filterSweepTargets(
  descriptors: readonly SweepTargetDescriptor[],
  query: string,
): SweepTargetDescriptor[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...descriptors];
  return descriptors.filter((d) => d.label.toLowerCase().includes(q));
}

/* ------------------------------------------------------------------ */
/* Definition defaults and input parsing                               */
/* ------------------------------------------------------------------ */

/** Round advisory defaults to 6 significant figures so the pre-filled
 *  form shows clean numbers (300000*0.9 is 270000.00000000003 in FP). */
function clean(x: number): number {
  return Number.isFinite(x) ? parseFloat(x.toPrecision(6)) : x;
}

/**
 * Sensible initial range for a target: ±10% around the current value
 * (mirrored for negative values so start ≤ end), or [min ?? 0, max ?? 1]
 * when the current value is zero/non-finite (e.g. valve position 0 sweeps
 * its full [0, 1] domain).  Advisory only — per-value validateNetwork via
 * validateSweepDefinition remains authoritative.
 */
export function defaultSweepRange(d: NumericSweepDescriptor): {
  start: number;
  end: number;
  count: number;
} {
  const v = d.currentValue;
  let start: number;
  let end: number;
  if (Number.isFinite(v) && v !== 0) {
    start = clean(Math.min(v * 0.9, v * 1.1));
    end = clean(Math.max(v * 0.9, v * 1.1));
  } else {
    start = d.bounds?.min ?? 0;
    end = d.bounds?.max ?? 1;
    if (start === end) end = start + 1;
  }
  return { start, end, count: DEFAULT_SWEEP_COUNT };
}

/** Whether one option yields a valid model, and why not when it doesn't. */
export interface SweepOptionValidity {
  id: string;
  ok: boolean;
  /** First validateNetwork message for this option's config. */
  error?: string;
}

/**
 * Validate every option of a categorical target independently.  Each
 * variant config is validated on its own, so an option that fails alone
 * fails in any selection — this is the exact per-option answer, not an
 * estimate, and it is what the picker shows next to each unavailable
 * choice ("ttWf correlation requires segmentLength > 0").
 */
export function checkSweepOptions(
  config: NetworkConfig,
  d: OptionSweepDescriptor,
): SweepOptionValidity[] {
  return d.options.map((o) => {
    const check = validateSweepDefinition(config, {
      target: d.target,
      spacing: "options",
      optionIds: [o.id],
    });
    if (!check.ok) return { id: o.id, ok: false, error: check.errors[0] };
    const invalid = check.invalidValues[0];
    return invalid
      ? { id: o.id, ok: false, error: invalid.errors[0] }
      : { id: o.id, ok: true };
  });
}

/**
 * Initial option selection for a categorical target: every option that
 * produces a valid model on its own, so the form is runnable as offered.
 * Options that need something the model lacks are left unchecked rather
 * than hidden — the picker states why, which is the useful answer.  Falls
 * back to the current option when nothing validates, so the axis is never
 * empty.
 */
export function defaultOptionSelection(
  config: NetworkConfig,
  d: OptionSweepDescriptor,
): string[] {
  const valid = checkSweepOptions(config, d)
    .filter((v) => v.ok)
    .map((v) => v.id)
    .slice(0, SWEEP_MAX_VARIANTS);
  if (valid.length > 0) return valid;
  const fallback = d.currentOptionId ?? d.options[0]?.id;
  return fallback !== undefined ? [fallback] : [];
}

/** Toggle one option id, preserving the list's existing order. */
export function toggleOptionId(
  selected: readonly string[],
  id: string,
): string[] {
  return selected.includes(id)
    ? selected.filter((x) => x !== id)
    : [...selected, id];
}

/** Parse a free-form numeric input; undefined for blank/non-finite text. */
export function parseSweepNumber(raw: string): number | undefined {
  const t = raw.trim();
  if (t === "" || t === "-" || t === ".") return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}

/** Parse the variant-count input; undefined for non-integers (range is
 *  enforced by validateSweepDefinition so the exact value stays visible). */
export function parseCountInput(raw: string): number | undefined {
  const v = parseSweepNumber(raw);
  return v !== undefined && Number.isInteger(v) ? v : undefined;
}

/* ------------------------------------------------------------------ */
/* Per-variant row formatting                                          */
/* ------------------------------------------------------------------ */

/**
 * Display text for one axis value: the option label frozen with the variant
 * (never re-derived, so a later registry rename cannot relabel a finished
 * run), else the number at the reader's significant figures.
 */
export function formatSweepValue(
  point: { value: SweepValue; valueLabel?: string },
  sigFigs = 4,
): string {
  if (point.valueLabel !== undefined) return point.valueLabel;
  return typeof point.value === "number"
    ? formatSig(point.value, sigFigs)
    : point.value;
}

export function formatDurationMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${formatSig(ms / 1000, 3)} s`;
}

function envelopeText(
  env: ValueEnvelope | undefined,
  kind: QuantityKind,
  prefs: Partial<UnitPreferences> | undefined,
  sigFigs: number,
): string {
  if (!env) return "—";
  return `${formatWithUnit(env.min, kind, prefs, sigFigs)} – ${formatWithUnit(env.max, kind, prefs, sigFigs)}`;
}

/** Everything the variants table needs for one row, pre-formatted. */
export interface VariantRowText {
  value: string;
  status: SweepVariantStatus;
  converged: string;
  /** Steady: "N iter · res R"; transient: "N steps · M rejected …";
   *  the error message for failed variants. */
  detail: string;
  peakMdot: string;
  pressure: string;
  temperature: string;
  duration: string;
  error: string;
}

export function formatVariantRow(
  record: SweepVariantRecord,
  opts: { unitPrefs?: Partial<UnitPreferences>; sigFigs?: number } = {},
): VariantRowText {
  const sig = opts.sigFigs ?? 4;
  const prefs = opts.unitPrefs;
  const s = record.summary;

  let detail: string;
  if (record.error) {
    detail = record.error;
  } else if (!s) {
    detail = record.status === "running" ? "solving…" : "—";
  } else if (s.mode === "steady") {
    detail = `${s.iterations ?? "—"} iter · res ${s.residual !== undefined ? formatSig(s.residual, 2) : "—"}`;
  } else {
    const parts = [`${s.steps ?? 0} steps`];
    if (s.rejectedSteps) parts.push(`${s.rejectedSteps} rejected`);
    if (s.aborted) parts.push("aborted");
    else if (s.userTerminated) parts.push("terminated");
    else if (s.reachedEnd === false) parts.push("incomplete");
    detail = parts.join(" · ");
  }

  return {
    value: formatSweepValue(record, sig),
    status: record.status,
    converged: s ? (s.converged ? "yes" : "no") : "—",
    detail,
    peakMdot:
      s?.peakAbsMassFlow !== undefined
        ? formatWithUnit(s.peakAbsMassFlow, "massFlow", prefs, sig)
        : "—",
    pressure: envelopeText(s?.pressure, "pressure", prefs, sig),
    temperature: envelopeText(s?.temperature, "temperature", prefs, sig),
    duration: formatDurationMs(record.durationMs),
    error: record.error ?? "",
  };
}

/* ------------------------------------------------------------------ */
/* Progress / status line                                              */
/* ------------------------------------------------------------------ */

/**
 * One-line live status for a job: "Running variant k/N · value V unit ·
 * iter/res or t-progress detail" while running; the frozen job summary
 * ("5/5 completed · 4 converged") at terminal states.
 */
export function sweepProgressLine(args: {
  job: SolveJob;
  activeVariantIndex: number | null;
  activeProgress: ProgressPayload | null;
  valueUnit: string;
  sigFigs?: number;
}): string {
  const { job, activeVariantIndex, activeProgress, valueUnit } = args;
  const sig = args.sigFigs ?? 4;
  const total = job.variants.length;

  if (job.status === "running") {
    const record =
      activeVariantIndex !== null
        ? job.variants[activeVariantIndex]
        : undefined;
    // An option value names itself; only a bare number needs a unit.
    const unitSuffix = (r: SweepVariantRecord) =>
      r.valueLabel === undefined && valueUnit !== "-" ? ` ${valueUnit}` : "";
    const head = record
      ? `Running variant ${record.index + 1}/${total} · value ${formatSweepValue(record, sig)}${unitSuffix(record)}`
      : `Running · ${job.progress.completed}/${total} completed`;
    if (activeProgress?.kind === "steady") {
      return `${head} · iter ${activeProgress.iteration} · residual ${formatSig(activeProgress.residual, 2)}`;
    }
    if (activeProgress?.kind === "transient") {
      return `${head} · t = ${formatSig(activeProgress.time, 3)} s / ${formatSig(activeProgress.endTime, 3)} s`;
    }
    return head;
  }
  if (job.status === "pending") {
    const kept = job.progress.completed;
    return kept > 0
      ? `Ready to rerun · ${kept}/${total} completed results kept`
      : `Ready to run · ${total} variants`;
  }
  return job.summary ?? job.status;
}

/* ------------------------------------------------------------------ */
/* CSV export                                                          */
/* ------------------------------------------------------------------ */

/** RFC-4180 cell quoting (only when the value needs it), with a
 *  spreadsheet formula-injection guard: a free-text cell whose first
 *  character is a formula trigger (= + - @ TAB CR) is prefixed with a
 *  single quote so Excel/Sheets/LibreOffice import it as literal text
 *  (OWASP CSV-injection guidance).  Only the error column is free text —
 *  every other column is numeric, an enum, or a hex hash. */
const commentSafe = csvCommentValue;

const num = (v: number | undefined): string =>
  v === undefined || !Number.isFinite(v) ? "" : String(v);
const scaled = (scale: ScaleChoice, v: number | undefined): string =>
  v === undefined || !Number.isFinite(v) ? "" : String(scale.convert(v));

/**
 * Build the sweep CSV: `# key=value` provenance comments (base config hash,
 * target, the axis definition, status), one header row, and ONE row per
 * variant — failed/cancelled/pending variants keep their rows with empty
 * result columns.  A range sweep's value column is config-native (unit in
 * the header); an option sweep's carries the option id, with the display
 * name in an extra `value_label` column, because an id is what identifies
 * the choice and a label is what reads.  Pressure/temperature/peak-mdot
 * envelope columns honor the user's unit preferences via a single resolved
 * scale per column (unit in the header); everything else is raw SI.  Pure;
 * `now` pins the timestamp for deterministic tests.
 */
export function buildSweepCsv(
  job: SolveJob,
  opts: { unitPrefs?: Partial<UnitPreferences>; now?: number } = {},
): string {
  const prefs = opts.unitPrefs;
  const resolved = resolveSweepTarget(job.baseConfig, job.sweep.target);
  const valueUnit =
    resolved.ok && resolved.descriptor.axis === "numeric"
      ? resolved.descriptor.unit
      : "-";
  const optionSweep = isOptionSweep(job.sweep);

  const summaries = job.variants.map((v) => v.summary);
  const pScale = resolveScale(
    summaries.flatMap((s) =>
      s?.pressure ? [s.pressure.min, s.pressure.max] : [],
    ),
    "pressure",
    prefs?.pressure,
  );
  const tScale = resolveScale(
    summaries.flatMap((s) =>
      s?.temperature ? [s.temperature.min, s.temperature.max] : [],
    ),
    "temperature",
    prefs?.temperature,
  );
  const mScale = resolveScale(
    summaries.flatMap((s) =>
      s?.peakAbsMassFlow !== undefined ? [s.peakAbsMassFlow] : [],
    ),
    "massFlow",
    prefs?.massFlow,
  );

  const comments = [
    `# model=${commentSafe(job.baseConfig.meta.name)}`,
    `# generated=${new Date(opts.now ?? Date.now()).toISOString()}`,
    `# mode=${job.baseConfig.settings.mode}`,
    `# sweep_target=${commentSafe(job.targetLabel)}`,
    ...(isRangeSweep(job.sweep)
      ? [
          `# sweep_start=${job.sweep.start}`,
          `# sweep_end=${job.sweep.end}`,
          `# sweep_count=${job.sweep.count}`,
        ]
      : [
          `# sweep_options=${commentSafe(job.sweep.optionIds.join("|"))}`,
          `# sweep_count=${job.sweep.optionIds.length}`,
        ]),
    `# sweep_spacing=${job.sweep.spacing}`,
    `# base_config_hash=${job.baseConfigHash}`,
    `# job_status=${job.status}`,
    `# note=Session-only parameter sweep; one row per variant; the value column is config-native and envelope columns use the units named in the header.`,
  ];

  const header = [
    "index",
    ...(optionSweep ? ["value", "value_label"] : [`value (${valueUnit})`]),
    "status",
    "converged",
    "mode",
    "iterations",
    "residual",
    "steps",
    "rejected_steps",
    "end_time (s)",
    `peak_abs_mdot (${mScale.unitLabel})`,
    `pressure_min (${pScale.unitLabel})`,
    `pressure_max (${pScale.unitLabel})`,
    `temperature_min (${tScale.unitLabel})`,
    `temperature_max (${tScale.unitLabel})`,
    "duration_ms",
    "config_hash",
    "error",
  ].join(",");

  const rows = job.variants.map((v) => {
    const s = v.summary;
    return [
      String(v.index),
      ...(optionSweep
        ? [csvCell(String(v.value)), csvCell(v.valueLabel ?? "")]
        : [String(v.value)]),
      v.status,
      s ? (s.converged ? "yes" : "no") : "",
      s?.mode ?? "",
      num(s?.iterations),
      num(s?.residual),
      num(s?.steps),
      num(s?.rejectedSteps),
      num(s?.endTime),
      scaled(mScale, s?.peakAbsMassFlow),
      scaled(pScale, s?.pressure?.min),
      scaled(pScale, s?.pressure?.max),
      scaled(tScale, s?.temperature?.min),
      scaled(tScale, s?.temperature?.max),
      num(v.durationMs),
      v.configHash,
      csvCell(v.error ?? ""),
    ].join(",");
  });

  return [...comments, header, ...rows].join("\n");
}

/** Download name: model stem + swept field + base-hash prefix. */
export function sweepCsvFilename(job: SolveJob): string {
  const field = job.sweep.target.field.replace(/[^\w.-]+/g, "_");
  return `${safeFilename(job.baseConfig.meta.name)}-sweep-${field}-${job.baseConfigHash.slice(0, 8)}.csv`;
}
