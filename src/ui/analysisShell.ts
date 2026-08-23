/**
 * analysisShell.ts — pure view-model helpers for the reusable Analysis
 * shell components (components/AnalysisDisclosure.tsx and
 * components/AnalysisRunStrip.tsx).
 *
 * Pure: no React, no DOM, no store.  Components map their props through
 * these helpers so all wording/tone decisions live in one tested place,
 * mirroring the diaryPresentation.ts convention.
 */

/* ------------------------------------------------------------------ */
/* Disclosure id convention                                            */
/* ------------------------------------------------------------------ */

/**
 * Stable id / data-testid convention for an AnalysisDisclosure instance.
 * Shared by the component itself and by parents implementing the
 * open-then-focus jump:
 *
 *   onToggle(true)  →  re-render mounts the content  →
 *   document.getElementById(ids.contentId)?.focus()  (content is tabIndex -1)
 *
 * Ids are derived from the caller-supplied disclosure id, which must be
 * unique on the page.
 */
export function analysisDisclosureIds(id: string) {
  return {
    /** Id of the header toggle button (labels the content region). */
    headerId: `${id}-header`,
    /** Id of the content region (the programmatic focus target). */
    contentId: `${id}-content`,
    toggleTestId: `${id}-toggle`,
    contentTestId: `${id}-content`,
  } as const;
}

/* ------------------------------------------------------------------ */
/* Run-strip view model                                                */
/* ------------------------------------------------------------------ */

/** Outcome of the displayed run (null when there is nothing to report). */
export type RunStripOutcome =
  "converged" | "notConverged" | "running" | "cancelled" | "error";

/** Pill tone per outcome (maps onto the shared .pill--* classes). */
export type RunStripTone = "ok" | "warn" | "danger" | "info" | "muted";

export interface RunStripState {
  /** Displayed run's record name; null/blank → the latest (unrecorded) run. */
  runName?: string | null;
  /** Solve mode of the displayed result (null when nothing is displayed). */
  mode?: "steady" | "transient" | null;
  outcome?: RunStripOutcome | null;
  /** Extra outcome evidence, e.g. "12 iter · res 3.2e-9" or "t = 42.00 s". */
  outcomeDetail?: string | null;
  /** Displayed result no longer matches the current model config. */
  stale?: boolean;
  /** Cancelled/errored run — evidence ends at the last progress update. */
  partial?: boolean;
  /** Pinned comparison baseline name (null when unpinned). */
  baselineName?: string | null;
  /** Number of records in run history (badge on the Results section). */
  runCount?: number;
  /** Retained diary events for the displayed run (null → no diary). */
  diaryEventCount?: number | null;
  /** Diary warnings for the displayed run (drives the badge warn tone). */
  diaryWarningCount?: number;
}

export interface RunStripView {
  /** Run name, or "Latest run" when no record is selected. */
  title: string;
  modeText: string | null;
  /** Outcome pill text (null → no pill). */
  outcomeText: string | null;
  outcomeTone: RunStripTone;
  /** Secondary evidence shown after the pill (null → omitted). */
  detailText: string | null;
  stale: boolean;
  partial: boolean;
  /** "Baseline: <name>" (null → no baseline pill). */
  baselineText: string | null;
  /** Count badge for the Results section (null when history is empty). */
  runsBadge: string | null;
  /** Count badge for the Solver diary button (null when no diary). */
  diaryBadge: string | null;
  /** True when the diary badge should use the warning tone. */
  diaryBadgeWarn: boolean;
  /** One accessible sentence summarizing the whole strip. */
  statusText: string;
}

export function runStripOutcomeText(outcome: RunStripOutcome): string {
  switch (outcome) {
    case "converged":
      return "converged";
    case "notConverged":
      return "NOT converged";
    case "running":
      return "running";
    case "cancelled":
      return "cancelled";
    case "error":
      return "error";
  }
}

export function runStripOutcomeTone(outcome: RunStripOutcome): RunStripTone {
  switch (outcome) {
    case "converged":
      return "ok";
    case "notConverged":
      return "warn";
    case "running":
      return "info";
    case "cancelled":
      return "muted";
    case "error":
      return "danger";
  }
}

/** Displayed-run title: the record name, or "Latest run" for a live/fresh result. */
export function runStripTitle(runName?: string | null): string {
  const trimmed = runName?.trim();
  return trimmed ? trimmed : "Latest run";
}

/**
 * Map the displayed-run state to the strip's render model.  Tolerates every
 * combination the Analysis view can be in: zero history, a live running run
 * (no record yet), cancelled/error partials, and stale displayed results.
 */
export function runStripView(state: RunStripState): RunStripView {
  const title = runStripTitle(state.runName);
  const modeText = state.mode ?? null;
  const outcomeText = state.outcome ? runStripOutcomeText(state.outcome) : null;
  const outcomeTone = state.outcome
    ? runStripOutcomeTone(state.outcome)
    : "muted";
  const detailText = state.outcomeDetail?.trim()
    ? state.outcomeDetail.trim()
    : null;
  const stale = state.stale === true;
  const partial = state.partial === true;
  const baselineText = state.baselineName?.trim()
    ? `Baseline: ${state.baselineName.trim()}`
    : null;
  const runCount = state.runCount ?? 0;
  const runsBadge = runCount > 0 ? String(runCount) : null;
  const diaryEventCount = state.diaryEventCount ?? null;
  const diaryWarningCount = state.diaryWarningCount ?? 0;
  const diaryBadge = diaryEventCount != null ? String(diaryEventCount) : null;
  const diaryBadgeWarn = diaryEventCount != null && diaryWarningCount > 0;

  const parts = [`Showing ${title}`];
  if (modeText) parts.push(modeText);
  if (outcomeText)
    parts.push(detailText ? `${outcomeText} (${detailText})` : outcomeText);
  if (stale) parts.push("stale — rerun before design use");
  if (partial) parts.push("partial data");
  if (baselineText)
    parts.push(`compared against baseline ${state.baselineName!.trim()}`);
  return {
    title,
    modeText,
    outcomeText,
    outcomeTone,
    detailText,
    stale,
    partial,
    baselineText,
    runsBadge,
    diaryBadge,
    diaryBadgeWarn,
    statusText: `${parts.join(" · ")}.`,
  };
}
