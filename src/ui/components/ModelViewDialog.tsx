import React from "react";
import ModelTableView from "./ModelTableView";
import TextModelView from "./TextModelView";

export type ModelViewDialogKind = "text" | "table";

export default function ModelViewDialog({
  view,
  onClose,
}: {
  view: ModelViewDialogKind;
  onClose: () => void;
}) {
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const restoreFocusRef = React.useRef<Element | null>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    restoreFocusRef.current = document.activeElement;
    closeRef.current?.focus();
    return () => {
      (restoreFocusRef.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("disabled"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
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
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const title = view === "text" ? "Model Text" : "Model Table";

  return (
    <div
      className="dialog-overlay"
      data-testid="model-view-dialog"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="dialog model-view-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="model-view-dialog__header">
          <div id={titleId} className="dialog__title">
            {title}
          </div>
          <button
            ref={closeRef}
            type="button"
            className="btn btn--ghost btn--sm"
            data-testid="model-view-dialog-close"
            aria-label={`Close ${title}`}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="model-view-dialog__body">
          {view === "text" ? (
            <TextModelView />
          ) : (
            <ModelTableView onNavigateToModel={onClose} />
          )}
        </div>
      </div>
    </div>
  );
}
