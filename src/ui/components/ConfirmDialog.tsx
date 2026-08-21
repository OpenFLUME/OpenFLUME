import React from "react";

export interface ConfirmRequest {
  title: string;
  message: string;
  acceptLabel: string;
  onAccept: () => void;
}

/**
 * Styled confirm dialog for destructive actions (New / Load over a modified
 * model). Focus-trapped, Escape/overlay-click cancels, initial focus on the
 * accept button, focus restored to the previously focused element on close.
 */
export default function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest;
  onClose: () => void;
}) {
  const acceptRef = React.useRef<HTMLButtonElement>(null);
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const restoreRef = React.useRef<Element | null>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    restoreRef.current = document.activeElement;
    acceptRef.current?.focus();
    return () => {
      (restoreRef.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      // Enter activates the primary accept action from anywhere in the
      // dialog — EXCEPT when focus sits on another button (native button
      // activation then applies, so a focused Cancel still cancels).
      if (e.key === "Enter") {
        const active = document.activeElement as HTMLElement | null;
        if (
          active &&
          active.tagName === "BUTTON" &&
          dialogRef.current?.contains(active)
        )
          return;
        e.preventDefault();
        e.stopPropagation();
        request.onAccept();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
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
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, request]);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog dialog--sm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="confirm-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div id={titleId} className="dialog__title" style={{ marginBottom: 8 }}>
          {request.title}
        </div>
        <div
          style={{
            fontSize: "var(--fs-body)",
            color: "var(--text-2)",
            marginBottom: 16,
          }}
        >
          {request.message}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            data-testid="confirm-dialog-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            ref={acceptRef}
            className="btn btn--danger"
            data-testid="confirm-dialog-accept"
            onClick={() => {
              request.onAccept();
              onClose();
            }}
          >
            {request.acceptLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
