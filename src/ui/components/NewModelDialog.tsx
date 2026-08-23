/**
 * NewModelDialog — the New-model flow with problem-type templates.
 *
 * "Blank network" is the default selection and the accept button keeps the
 * `confirm-dialog-accept` testid, so the historical New contract
 * (toolbar-new → confirm-dialog-accept → empty canvas) is preserved while
 * templates add a one-click seeded starting point (fluid, solver mode,
 * physics flags, starter topology — see problemTemplates.ts).
 */
import React from "react";
import { useStore } from "../store";
import {
  PROBLEM_TEMPLATES,
  buildTemplateConfig,
  type ProblemTemplate,
} from "../problemTemplates";

export default function NewModelDialog({ onClose }: { onClose: () => void }) {
  const newNetwork = useStore((s) => s.newNetwork);
  const newNetworkFrom = useStore((s) => s.newNetworkFrom);
  const [selected, setSelected] = React.useState<string>("blank");
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

  const accept = React.useCallback(() => {
    if (selected === "blank") {
      newNetwork();
    } else {
      const template = PROBLEM_TEMPLATES.find((t) => t.id === selected);
      if (template) newNetworkFrom(buildTemplateConfig(template));
      else newNetwork();
    }
    onClose();
  }, [selected, newNetwork, newNetworkFrom, onClose]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
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
  }, [onClose]);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog dialog--new-model"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="new-model-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div id={titleId} className="dialog__title" style={{ marginBottom: 4 }}>
          New network
        </div>
        <div className="new-model__hint">
          Replaces the current model and its autosaved copy (undo with
          Ctrl/Cmd+Z). Pick a problem type to start with a runnable seed —
          fluid, solver settings, and a starter layout — or begin blank.
        </div>
        <div
          className="new-model__grid"
          role="radiogroup"
          aria-label="Starting point"
        >
          <TemplateCard
            id="blank"
            label="Blank network"
            description="Empty canvas with default settings."
            seeds={["Water (incompressible)", "Steady solve"]}
            selected={selected === "blank"}
            onSelect={() => setSelected("blank")}
          />
          {PROBLEM_TEMPLATES.map((t: ProblemTemplate) => (
            <TemplateCard
              key={t.id}
              id={t.id}
              label={t.label}
              description={t.description}
              seeds={t.seeds}
              selected={selected === t.id}
              onSelect={() => setSelected(t.id)}
            />
          ))}
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
            className="btn btn--primary"
            data-testid="confirm-dialog-accept"
            onClick={accept}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

function TemplateCard({
  id,
  label,
  description,
  seeds,
  selected,
  onSelect,
}: {
  id: string;
  label: string;
  description: string;
  seeds: string[];
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      data-testid={`new-model-template-${id}`}
      className={
        selected ? "new-model-card new-model-card--selected" : "new-model-card"
      }
      onClick={onSelect}
      onDoubleClick={onSelect}
    >
      <span className="new-model-card__label">{label}</span>
      <span className="new-model-card__desc">{description}</span>
      <span className="new-model-card__seeds">
        {seeds.map((s) => (
          <span key={s} className="new-model-card__seed">
            {s}
          </span>
        ))}
      </span>
    </button>
  );
}
