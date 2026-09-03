/**
 * RepeatDialog — the Repeat-N flow (Phase 4a): chain the selected subgraph
 * unit into N TOTAL instances (the original plus N−1 copies) via the store's
 * repeatSelection action, which owns undo, the canvas re-selection, and the
 * duplicateNotice announcement.
 *
 * All derivation (count validation, spacing defaults, summary text, final
 * arguments) lives in ../repeatSelection.ts so this file stays a thin
 * presentational shell; RepeatMenuAction is the FlowCanvas selection-menu
 * entry point (kept here so the menu label/tooltip and the dialog cannot
 * drift apart).
 *
 * A11y follows ConfirmDialog: role="dialog" + aria-modal, initial focus on
 * the count field, Tab cycles inside the dialog, Escape closes, Enter
 * confirms from anywhere except a focused button (native activation there).
 */
import React from "react";
import type { NetworkConfig } from "../types";
import { useStore } from "../store";
import { CANVAS_GRID_SIZE } from "../canvasGeometry";
import {
  buildRepeatArgs,
  deriveRepeatDefaults,
  parseRepeatCount,
  perInstanceRepeatCounts,
  repeatSummaryText,
  repeatUnclonedWarnings,
  REPEAT_COUNT_MAX,
  REPEAT_COUNT_MIN,
  type Repeatability,
} from "../repeatSelection";

/** Selection-menu entry point: enabled iff the selection can repeat, with
 *  the reason as the tooltip when it cannot (matching Create subnetwork). */
export function RepeatMenuAction({
  repeatability,
  onClick,
}: {
  repeatability: Repeatability;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="selection-menu__action"
      data-testid="repeat-menu-action"
      disabled={!repeatability.canRepeat}
      title={
        repeatability.canRepeat
          ? "Chain the selected unit into multiple instances"
          : `Cannot repeat: ${repeatability.reason}`
      }
      onClick={onClick}
    >
      Repeat…
    </button>
  );
}

export default function RepeatDialog({
  config,
  repeatability,
  onClose,
}: {
  config: NetworkConfig;
  repeatability: Repeatability;
  onClose: () => void;
}) {
  const defaults = React.useMemo(
    () => deriveRepeatDefaults(config, repeatability),
    [config, repeatability],
  );
  const perInstance = React.useMemo(
    () => perInstanceRepeatCounts(config, repeatability),
    [config, repeatability],
  );
  // Targeted caveat (user manual §3.13): controllers, junctions and logic
  // rules are never cloned — warn only when one actually references the
  // selected unit, rather than carrying a permanent notice.
  const unclonedWarnings = React.useMemo(
    () => repeatUnclonedWarnings(config, repeatability),
    [config, repeatability],
  );

  const [count, setCount] = React.useState(String(REPEAT_COUNT_MIN));
  const [linkParams, setLinkParams] = React.useState(true);
  const [canvasX, setCanvasX] = React.useState(String(defaults.canvasOffset.x));
  const [canvasY, setCanvasY] = React.useState(String(defaults.canvasOffset.y));
  const [physX, setPhysX] = React.useState(String(defaults.physicalOffset.x));
  const [physY, setPhysY] = React.useState(String(defaults.physicalOffset.y));
  const [physZ, setPhysZ] = React.useState(String(defaults.physicalOffset.z));
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

  const parsedCount = parseRepeatCount(count);
  const built = buildRepeatArgs({
    count,
    linkParams,
    canvasX,
    canvasY,
    physX,
    physY,
    physZ,
  });
  const canConfirm = repeatability.canRepeat && built.ok;
  const summary =
    perInstance && parsedCount.ok
      ? repeatSummaryText(parsedCount.value, perInstance)
      : null;

  const confirm = React.useCallback(() => {
    const builtNow = buildRepeatArgs({
      count,
      linkParams,
      canvasX,
      canvasY,
      physX,
      physY,
      physZ,
    });
    if (!repeatability.canRepeat || !builtNow.ok) return;
    const result = useStore.getState().repeatSelection(builtNow.args);
    if (result) {
      onClose();
    } else {
      // The store announced the reason via duplicateNotice — surface it here
      // too, since that channel is screen-reader-only.
      setSubmitError(useStore.getState().duplicateNotice || "Repeat failed.");
    }
  }, [
    repeatability,
    count,
    linkParams,
    canvasX,
    canvasY,
    physX,
    physY,
    physZ,
    onClose,
  ]);

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
        data-testid="repeat-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div id={titleId} className="dialog__title" style={{ marginBottom: 4 }}>
          Repeat selection
        </div>
        <div className="field__hint" style={{ marginBottom: 12 }}>
          Chains the selected unit end-to-end: the seam branch is cloned per
          instance and the exit rewires to the last copy. One undo step.
        </div>
        {unclonedWarnings.length > 0 && (
          <div
            className="banner banner--warn"
            role="note"
            data-testid="repeat-uncloned-warning"
            style={{ marginBottom: 12 }}
          >
            {unclonedWarnings.map((warning) => (
              <div key={warning}>{warning}</div>
            ))}
          </div>
        )}
        {!repeatability.canRepeat && (
          <div
            className="field__error"
            role="alert"
            data-testid="repeat-reason"
            style={{ marginBottom: 12 }}
          >
            Cannot repeat: {repeatability.reason}
          </div>
        )}
        <div className="field">
          <label className="field__label" htmlFor="repeat-count">
            Total instances (including the original)
          </label>
          <input
            id="repeat-count"
            ref={countRef}
            className="input"
            type="number"
            min={REPEAT_COUNT_MIN}
            max={REPEAT_COUNT_MAX}
            step={1}
            value={count}
            data-testid="repeat-count"
            aria-invalid={!parsedCount.ok}
            aria-describedby="repeat-count-help"
            onChange={(event) => setCount(event.target.value)}
          />
          <div id="repeat-count-help" className="field__hint">
            {parsedCount.ok ? (
              `Between ${REPEAT_COUNT_MIN} and ${REPEAT_COUNT_MAX}.`
            ) : (
              <span role="alert" style={{ color: "var(--danger)" }}>
                {parsedCount.error}
              </span>
            )}
          </div>
        </div>
        <div className="field">
          <label className="field__label check-label">
            <input
              type="checkbox"
              data-testid="repeat-link-params"
              checked={linkParams}
              onChange={(event) => setLinkParams(event.target.checked)}
            />
            Link parameters to the first instance
          </label>
          <div className="field__hint">
            Editing the first instance then updates them all — and the first
            instance stays the sweepable one (formula-bound fields cannot be
            swept directly; sweeping it propagates through the links). Uncheck
            for independent copies.
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label className="field__label" htmlFor="repeat-canvas-x">
              Canvas spacing X (px)
            </label>
            <input
              id="repeat-canvas-x"
              className="input"
              type="number"
              step={CANVAS_GRID_SIZE}
              value={canvasX}
              data-testid="repeat-canvas-x"
              aria-invalid={!built.ok && parsedCount.ok}
              onChange={(event) => setCanvasX(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="repeat-canvas-y">
              Canvas spacing Y (px)
            </label>
            <input
              id="repeat-canvas-y"
              className="input"
              type="number"
              step={CANVAS_GRID_SIZE}
              value={canvasY}
              data-testid="repeat-canvas-y"
              aria-invalid={!built.ok && parsedCount.ok}
              onChange={(event) => setCanvasY(event.target.value)}
            />
          </div>
        </div>
        <div className="field__hint" style={{ marginBottom: 12 }}>
          Pixels between instances on the canvas — the default tiles the unit
          without overlapping.
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: "var(--sp-2)",
          }}
        >
          <div className="field">
            <label className="field__label" htmlFor="repeat-physical-x">
              Physical Δx (m)
            </label>
            <input
              id="repeat-physical-x"
              className="input"
              type="number"
              step="any"
              value={physX}
              data-testid="repeat-physical-x"
              onChange={(event) => setPhysX(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="repeat-physical-y">
              Physical Δy (m)
            </label>
            <input
              id="repeat-physical-y"
              className="input"
              type="number"
              step="any"
              value={physY}
              data-testid="repeat-physical-y"
              onChange={(event) => setPhysY(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="repeat-physical-z">
              Physical Δz (m)
            </label>
            <input
              id="repeat-physical-z"
              className="input"
              type="number"
              step="any"
              value={physZ}
              data-testid="repeat-physical-z"
              onChange={(event) => setPhysZ(event.target.value)}
            />
          </div>
        </div>
        <div className="field__hint" style={{ marginBottom: 12 }}>
          Advances each instance&apos;s physical position — used for
          hydrostatics and the 3D view. Defaults to the seam pipe&apos;s
          resolved length along +x; blank means 0.
        </div>
        {!built.ok && parsedCount.ok && (
          <div
            className="field__error"
            role="alert"
            data-testid="repeat-spacing-error"
            style={{ marginBottom: 12 }}
          >
            {built.error}
          </div>
        )}
        {summary && (
          <div
            className="field__hint"
            role="status"
            data-testid="repeat-summary"
            style={{ marginBottom: 12 }}
          >
            {summary}
          </div>
        )}
        {submitError && (
          <div
            className="field__error"
            role="alert"
            data-testid="repeat-submit-error"
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
            data-testid="repeat-dialog-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="repeat-dialog-accept"
            disabled={!canConfirm}
            onClick={confirm}
          >
            Repeat
          </button>
        </div>
      </div>
    </div>
  );
}
