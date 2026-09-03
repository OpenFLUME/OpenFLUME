/**
 * SplitPipeDialog — the Split flow (Phase 4b): divide the selected
 * pipe/heatedPipe branch into N equal series segments via the store's
 * splitBranch action, which owns the single undo step and the
 * duplicateNotice announcement.
 *
 * Split lives in the canvas selection menu (SplitMenuAction below), not the
 * property panel: it is a verb, and a persistent panel form pre-filled with
 * a count read as though the pipe were ALREADY discretized.  The menu
 * action is kept here so the menu label/tooltip and the dialog cannot
 * drift apart (the RepeatDialog arrangement).
 *
 * All derivation (eligibility, count validation, the resolved total length,
 * the summary text, the final arguments) lives in ../repeatSelection.ts so
 * this file stays a thin presentational shell, like RepeatDialog.
 *
 * A11y follows ConfirmDialog/RepeatDialog: role="dialog" + aria-modal,
 * initial focus on the count field, Tab cycles inside the dialog, Escape
 * closes, Enter confirms from anywhere except a focused button (native
 * activation there), and focus returns to the opener on close.
 */
import React from "react";
import type { NetworkConfig } from "../types";
import { useStore } from "../store";
import {
  buildSplitArgs,
  parseSplitCount,
  resolvedBranchLength,
  splitSummaryText,
  splitUnclonedWarnings,
  REPEAT_COUNT_MAX,
  REPEAT_COUNT_MIN,
  type Splittability,
} from "../repeatSelection";

/** Selection-menu entry point: enabled iff the selection is exactly one
 *  pipe/heatedPipe branch, with the reason as the tooltip when it is not
 *  (matching RepeatMenuAction). */
export function SplitMenuAction({
  splittability,
  onClick,
}: {
  splittability: Splittability;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="selection-menu__action"
      data-testid="split-menu-action"
      disabled={splittability.branchId === null}
      title={
        splittability.branchId !== null
          ? "Split the branch into equal series segments"
          : `Cannot split: ${splittability.reason}`
      }
      onClick={onClick}
    >
      Split…
    </button>
  );
}

export default function SplitPipeDialog({
  config,
  branchId,
  onClose,
  initialSegments,
}: {
  config: NetworkConfig;
  branchId: string;
  onClose: () => void;
  /** Seed for the count field — used by SSR tests to render non-default
   *  validation states (the repo has no DOM environment for typing). */
  initialSegments?: string;
}) {
  const [segments, setSegments] = React.useState(
    initialSegments ?? String(REPEAT_COUNT_MIN),
  );
  const [linkParams, setLinkParams] = React.useState(true);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const countRef = React.useRef<HTMLInputElement>(null);
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const restoreRef = React.useRef<Element | null>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    restoreRef.current = document.activeElement;
    countRef.current?.focus();
    countRef.current?.select();
    return () => {
      (restoreRef.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  // Memoized: resolving the length runs a full-model parameter preview
  // (collectBindings + compile + topological sort + a frozen deep clone),
  // which must not re-run on every keystroke in an unrelated field.
  const totalLength = React.useMemo(
    () => resolvedBranchLength(config, branchId),
    [config, branchId],
  );
  // Targeted caveat: only when a controller/junction/logic rule actually
  // references THIS branch — it keeps its id as the last segment, so the
  // record then sees only that segment.
  const unclonedWarnings = React.useMemo(
    () => splitUnclonedWarnings(config, branchId),
    [config, branchId],
  );

  const branch = config.branches.find((b) => b.id === branchId);
  const heated = branch?.component.type === "heatedPipe";

  const parsed = parseSplitCount(segments);
  const built = buildSplitArgs({ segments, linkParams });
  const summary = parsed.ok
    ? splitSummaryText(parsed.value, totalLength)
    : null;

  const confirm = React.useCallback(() => {
    const builtNow = buildSplitArgs({ segments, linkParams });
    if (!builtNow.ok) return;
    const result = useStore
      .getState()
      .splitBranch(branchId, builtNow.args.segments, {
        linkParams: builtNow.args.linkParams,
      });
    if (result) {
      onClose();
    } else {
      // The store announced the reason via duplicateNotice — surface it here
      // too, since that channel is screen-reader-only.
      setSubmitError(useStore.getState().duplicateNotice || "Split failed.");
    }
  }, [branchId, segments, linkParams, onClose]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      // Enter confirms from anywhere in the dialog — EXCEPT when focus sits
      // on a button (native button activation then applies, so a focused
      // Cancel still cancels).
      if (event.key === "Enter") {
        const active = document.activeElement as HTMLElement | null;
        if (
          active &&
          active.tagName === "BUTTON" &&
          dialogRef.current?.contains(active)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        confirm();
        return;
      }
      if (event.key !== "Tab") return;
      // Minimal focus trap: keep Tab cycling inside the dialog.
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !root.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, confirm]);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog dialog--sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="split-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div id={titleId} className="dialog__title" style={{ marginBottom: 4 }}>
          Split pipe into segments
        </div>
        <div className="field__hint" style={{ marginBottom: 12 }}>
          Divides the branch into equal series segments: new internal nodes and
          seam pipes are inserted upstream, and the original branch keeps its id
          as the last segment. One undo step.
        </div>
        {unclonedWarnings.length > 0 && (
          <div
            className="banner banner--warn"
            role="note"
            data-testid="split-uncloned-warning"
            style={{ marginBottom: 12 }}
          >
            {unclonedWarnings.map((warning) => (
              <div key={warning}>{warning}</div>
            ))}
          </div>
        )}
        <div className="field">
          <label className="field__label" htmlFor="split-segments">
            Split into segments
          </label>
          <input
            id="split-segments"
            ref={countRef}
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
            Editing the first segment then updates them all — and the first
            segment stays the sweepable one (formula-bound fields cannot be
            swept directly; sweeping it propagates through the links). Uncheck
            for independent segments.
          </div>
        </div>
        <div className="field__hint" style={{ marginBottom: 12 }}>
          {heated
            ? "Total length, elevation change and UA are preserved — each is divided across the segments, not duplicated."
            : "Total length and elevation change are preserved — divided across the segments, not duplicated."}
        </div>
        {summary && (
          <div
            className="field__hint"
            role="status"
            data-testid="split-summary"
            style={{ marginBottom: 12 }}
          >
            {summary}
          </div>
        )}
        {submitError && (
          <div
            className="field__error"
            role="alert"
            data-testid="split-submit-error"
            style={{ marginBottom: 12 }}
          >
            {submitError}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            data-testid="split-dialog-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="split-dialog-accept"
            disabled={!built.ok}
            onClick={confirm}
          >
            Split
          </button>
        </div>
      </div>
    </div>
  );
}
