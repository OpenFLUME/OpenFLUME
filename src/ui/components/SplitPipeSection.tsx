/**
 * SplitPipeSection — the inline "Split into N segments" control (Phase 4b),
 * rendered by the property panel when the selected branch is a pipe or
 * heatedPipe.  One integer field, a live summary, and the link-params
 * toggle; applying goes through the store's splitBranch action, which owns
 * the single undo step and the duplicateNotice announcement.
 *
 * Inline rather than a modal dialog on purpose: this is a single-branch
 * operation with exactly one meaningful parameter, and the property panel
 * is already where that branch is edited — a dialog would add a
 * focus-trapping round trip without buying any extra structure.
 *
 * All derivation (count validation, the resolved total length, the summary
 * text, the final arguments) lives in ../repeatSelection.ts so this file
 * stays a thin presentational shell, like RepeatDialog.
 */
import React from "react";
import type { NetworkConfig } from "../types";
import { useStore } from "../store";
import {
  buildSplitArgs,
  isSplittableComponentType,
  parseSplitCount,
  resolvedBranchLength,
  splitSummaryText,
  REPEAT_COUNT_MAX,
  REPEAT_COUNT_MIN,
} from "../repeatSelection";

export default function SplitPipeSection({
  config,
  branchId,
  initialSegments,
}: {
  config: NetworkConfig;
  branchId: string;
  /** Seed for the count field — used by SSR tests to render non-default
   *  validation states (the repo has no DOM environment for typing). */
  initialSegments?: string;
}) {
  const [segments, setSegments] = React.useState(
    initialSegments ?? String(REPEAT_COUNT_MIN),
  );
  const [linkParams, setLinkParams] = React.useState(true);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const branch = config.branches.find((b) => b.id === branchId);
  if (!branch || !isSplittableComponentType(branch.component.type)) {
    return null;
  }
  const heated = branch.component.type === "heatedPipe";

  const parsed = parseSplitCount(segments);
  const built = buildSplitArgs({ segments, linkParams });
  const totalLength = resolvedBranchLength(config, branchId);
  const summary = parsed.ok
    ? splitSummaryText(parsed.value, totalLength)
    : null;

  const apply = () => {
    const builtNow = buildSplitArgs({ segments, linkParams });
    if (!builtNow.ok) return;
    const result = useStore
      .getState()
      .splitBranch(branchId, builtNow.args.segments, {
        linkParams: builtNow.args.linkParams,
      });
    if (result) {
      // The branch keeps its id (it becomes the last segment), so the panel
      // stays put; reset the count for a plausible further refinement.
      setSegments(String(REPEAT_COUNT_MIN));
      setSubmitError(null);
    } else {
      // The store announced the reason via duplicateNotice — surface it here
      // too, since that channel is screen-reader-only.
      setSubmitError(useStore.getState().duplicateNotice || "Split failed.");
    }
  };

  return (
    <>
      <div className="micro-label property-panel__group">Discretize</div>
      <div className="field">
        <label className="field__label" htmlFor="split-segments">
          Split into segments
        </label>
        <input
          id="split-segments"
          className="input"
          type="number"
          min={REPEAT_COUNT_MIN}
          max={REPEAT_COUNT_MAX}
          step={1}
          value={segments}
          data-testid="split-segments"
          aria-invalid={!parsed.ok}
          aria-describedby="split-segments-help"
          onChange={(event) => setSegments(event.target.value)}
        />
        <div id="split-segments-help" className="field__hint">
          {parsed.ok ? (
            `Between ${REPEAT_COUNT_MIN} and ${REPEAT_COUNT_MAX}. The original pipe becomes the last segment.`
          ) : (
            <span role="alert" style={{ color: "var(--danger)" }}>
              {parsed.error}
            </span>
          )}
        </div>
      </div>
      {summary && (
        <div
          className="field__hint"
          role="status"
          data-testid="split-summary"
          style={{ marginBottom: 8 }}
        >
          {summary}
        </div>
      )}
      <div className="field">
        <label className="field__label check-label">
          <input
            type="checkbox"
            data-testid="split-link-params"
            checked={linkParams}
            onChange={(event) => setLinkParams(event.target.checked)}
          />
          Link parameters to the first segment
        </label>
        <div className="field__hint">
          Editing the first segment then updates them all. Uncheck for
          independent segments.
        </div>
      </div>
      <div className="field__hint" style={{ marginBottom: 8 }}>
        {heated
          ? "Total length, elevation change and UA are preserved — each is divided across the segments, not duplicated."
          : "Total length and elevation change are preserved — divided across the segments, not duplicated."}
      </div>
      {submitError && (
        <div
          className="field__error"
          role="alert"
          data-testid="split-submit-error"
          style={{ marginBottom: 8 }}
        >
          {submitError}
        </div>
      )}
      <button
        type="button"
        className="btn btn--sm"
        data-testid="split-apply"
        disabled={!built.ok}
        onClick={apply}
      >
        Split
      </button>
    </>
  );
}
