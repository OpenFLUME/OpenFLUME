/**
 * diaryPresentation.ts — pure presentation/export helpers for the solver
 * convergence diary (convergenceDiary.ts).
 *
 * One tested formatting core shared by every diary surface — the Analysis
 * "Solver diary" section (components/ConvergenceDiarySection.tsx), the
 * run-history diary affordance, and the sweep variant diary cell:
 *
 *   - coordinate / outcome / severity labels for the timeline,
 *   - collapsed-window slicing (first N events + hidden count),
 *   - retention-accounting lines (dropped / coalesced occurrences),
 *   - export payloads (JSON / plain text) and filesystem-safe filenames.
 *
 * Pure: no React, no DOM, no store.  Diary data is already sanitized at the
 * source (convergenceDiary.ts); export-context strings (run name/id) are
 * re-sanitized here before entering a payload, and filenames go through
 * safeFilename.  No wall-clock fields are added — exports stay as
 * deterministic as the diary itself.
 */
import {
  diaryToJson,
  diaryToText,
  sanitizeDiaryText,
  EXTERNAL_MESSAGE_CAP,
  type DiaryCoordinate,
  type DiaryEvent,
  type DiaryJsonPayload,
  type DiaryOutcome,
  type DiarySeverity,
  type RunDiary,
} from "./convergenceDiary";
import { formatSig } from "./format";
import { safeFilename } from "./utils";

/* ------------------------------------------------------------------ */
/* Timeline labels and slicing                                         */
/* ------------------------------------------------------------------ */

/** Events shown when the timeline is collapsed (Show all reveals the rest). */
export const DIARY_COLLAPSED_COUNT = 5;

/** Timeline coordinate label: `iter N` (steady) or `t = …s · step N`. */
export function diaryCoordinateLabel(at: DiaryCoordinate): string {
  return at.kind === "steady"
    ? `iter ${at.iteration}`
    : `t = ${formatSig(at.time)}s · step ${at.step}`;
}

export interface DiaryTimelineSlice {
  /** Events to render in the current expand state (first N when collapsed). */
  visible: DiaryEvent[];
  total: number;
  /** Events currently hidden by the collapsed window (0 when expanded). */
  hiddenCount: number;
  /** The collapsed window size in force. */
  collapsedCount: number;
}

/** Collapsed = the FIRST `collapsedCount` events; expanded = all. */
export function diaryTimelineSlice(
  events: readonly DiaryEvent[],
  expanded: boolean,
  collapsedCount: number = DIARY_COLLAPSED_COUNT,
): DiaryTimelineSlice {
  const limit = Math.max(1, Math.floor(collapsedCount));
  const total = events.length;
  const visible =
    expanded || total <= limit ? [...events] : events.slice(0, limit);
  return {
    visible,
    total,
    hiddenCount: total - visible.length,
    collapsedCount: limit,
  };
}

/* ------------------------------------------------------------------ */
/* Summary / severity presentation                                     */
/* ------------------------------------------------------------------ */

/** Human outcome label (mirrors the digest head wording). */
export function diaryOutcomeText(outcome: DiaryOutcome): string {
  switch (outcome) {
    case "converged":
      return "converged";
    case "notConverged":
      return "NOT converged";
    case "aborted":
      return "aborted";
    case "userTerminated":
      return "user-terminated";
    case "stoppedShort":
      return "stopped short";
    case "cancelled":
      return "cancelled";
    case "error":
      return "error";
    default:
      return "running";
  }
}

/** Pill tone per outcome (maps onto the shared .pill--* classes). */
export type DiaryOutcomeTone = "ok" | "info" | "muted" | "warn" | "danger";

export function diaryOutcomeTone(outcome: DiaryOutcome): DiaryOutcomeTone {
  switch (outcome) {
    case "converged":
      return "ok";
    case "running":
      return "info";
    case "cancelled":
    case "userTerminated":
      return "muted";
    case "error":
      return "danger";
    default:
      return "warn"; // notConverged | aborted | stoppedShort
  }
}

export type DiarySeverityCounts = Record<DiarySeverity, number>;

/** Retained-event counts by severity. */
export function diarySeverityCounts(diary: RunDiary): DiarySeverityCounts {
  const counts: DiarySeverityCounts = { info: 0, notice: 0, warning: 0 };
  for (const e of diary.events) counts[e.severity]++;
  return counts;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * One-line meta under the digest, e.g.
 * "12 events · 2 warnings · 1 notice · 66 progress updates".  The progress
 * count is omitted for final-evidence diaries (0 updates — the
 * `finalEvidenceOnly` notice event already explains the missing stream).
 */
export function diaryMetaText(diary: RunDiary): string {
  const counts = diarySeverityCounts(diary);
  const parts = [
    plural(diary.events.length, "event"),
    plural(counts.warning, "warning"),
    plural(counts.notice, "notice"),
  ];
  if (diary.summary.progressUpdates > 0)
    parts.push(plural(diary.summary.progressUpdates, "progress update"));
  return parts.join(" · ");
}

/**
 * Retention accounting: null when nothing was dropped or coalesced,
 * otherwise e.g. "3 event occurrences dropped by the retention cap (200) ·
 * 5 repeated occurrences folded into ×counts".
 */
export function diaryAccountingText(diary: RunDiary): string | null {
  const { dropped, coalesced, cap } = diary.accounting;
  const parts: string[] = [];
  if (dropped > 0)
    parts.push(
      `${plural(dropped, "event occurrence")} dropped by the retention cap (${cap})`,
    );
  if (coalesced > 0)
    parts.push(
      `${plural(coalesced, "repeated occurrence")} folded into ×counts`,
    );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/* ------------------------------------------------------------------ */
/* Compact indicator (run-history button / sweep table cell)           */
/* ------------------------------------------------------------------ */

export interface DiaryIndicatorInfo {
  events: number;
  warnings: number;
  outcome: DiaryOutcome;
  digest: string;
  partial: boolean;
}

export function diaryIndicator(diary: RunDiary): DiaryIndicatorInfo {
  return {
    events: diary.events.length,
    warnings: diary.summary.warningCount,
    outcome: diary.summary.outcome,
    digest: diary.summary.digest,
    partial: diary.summary.partial === true,
  };
}

/** Compact cell text, e.g. "12 events" / "12 events · 2 warnings". */
export function diaryIndicatorText(diary: RunDiary): string {
  const ind = diaryIndicator(diary);
  return ind.warnings > 0
    ? `${plural(ind.events, "event")} · ${plural(ind.warnings, "warning")}`
    : plural(ind.events, "event");
}

/* ------------------------------------------------------------------ */
/* Export payloads and filenames                                       */
/* ------------------------------------------------------------------ */

/** Optional run-record context attached to exports (name/id of the record
 *  that owns the diary).  Absent for cancelled/error diaries, which own no
 *  RunRecord. */
export interface DiaryExportContext {
  runId?: string | null;
  runName?: string | null;
}

function sanitizeContext(context: DiaryExportContext): {
  id: string;
  name: string;
} {
  return {
    id: context.runId
      ? sanitizeDiaryText(context.runId, EXTERNAL_MESSAGE_CAP)
      : "",
    name: context.runName
      ? sanitizeDiaryText(context.runName, EXTERNAL_MESSAGE_CAP)
      : "",
  };
}

/** JSON export payload: the versioned diary payload plus optional run context. */
export type DiaryJsonExport = DiaryJsonPayload & {
  run?: { id?: string; name?: string };
};

export function buildDiaryJsonExport(
  diary: RunDiary,
  context: DiaryExportContext = {},
): DiaryJsonExport {
  const payload: DiaryJsonExport = diaryToJson(diary);
  const { id, name } = sanitizeContext(context);
  if (id || name)
    payload.run = { ...(id ? { id } : {}), ...(name ? { name } : {}) };
  return payload;
}

/**
 * Plain-text export: an optional `run=…` context line above the
 * deterministic diaryToText body (which already carries model/settings/hash
 * provenance).  Without context the body is returned verbatim.
 */
export function buildDiaryTextExport(
  diary: RunDiary,
  context: DiaryExportContext = {},
): string {
  const body = diaryToText(diary);
  const { id, name } = sanitizeContext(context);
  if (!id && !name) return body;
  return `run=${name || "unnamed"}${id ? ` (${id})` : ""}\n${body}`;
}

/**
 * Filesystem-safe export name: `<stem>-diary-<hash8>.<ext>` where the stem
 * is the owning run's name when available, else the diary's model name
 * (covers cancelled/error diaries).  The config-hash prefix disambiguates
 * exports across model edits, mirroring the sweep CSV convention.
 */
export function diaryExportFilename(
  diary: RunDiary,
  format: "json" | "txt",
  context: DiaryExportContext = {},
): string {
  const stem = safeFilename(
    context.runName?.trim() || diary.provenance.modelName || "run",
  );
  return `${stem}-diary-${diary.provenance.configHash.slice(0, 8)}.${format}`;
}
