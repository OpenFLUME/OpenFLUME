import React from "react";
import { createLocalComponent, type LocalComponent } from "../componentLibrary";
import {
  generateComponentSource,
  suggestedComponentFileName,
  validateComponentDraft,
  type ComponentDraft,
  type ComponentDraftField,
} from "../componentAuthoring";

const STARTER_PARAMS = `[
  { "name": "K", "label": "Loss coefficient", "default": 1, "min": 0 }
]`;

const INITIAL_DRAFT: ComponentDraft = {
  name: "my-k-factor",
  label: "My K-factor",
  description: "Quadratic pressure loss using a configurable loss coefficient.",
  version: "1.0.0",
  params: STARTER_PARAMS,
  pressureDropBody:
    "const area = args.area ?? 1;\nreturn args.params.K * args.mdot * Math.abs(args.mdot) / (2 * args.rho * area * area);",
  heatBody: "",
};

export default function ComponentEditorDialog({
  libraryAvailable,
  onClose,
  onCreated,
}: {
  libraryAvailable: boolean;
  onClose: () => void;
  onCreated: (component: LocalComponent) => void;
}) {
  const [draft, setDraft] = React.useState(INITIAL_DRAFT);
  const [errors, setErrors] = React.useState<
    Partial<Record<ComponentDraftField | "save", string>>
  >({});
  const [saving, setSaving] = React.useState(false);
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const restoreRef = React.useRef<Element | null>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    restoreRef.current = document.activeElement;
    nameRef.current?.focus();
    return () => {
      (restoreRef.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!saving) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, input, textarea, summary, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("disabled"));
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !root.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !root.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, saving]);

  const update = (field: keyof ComponentDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({
      ...current,
      [field]: undefined,
      save: undefined,
    }));
  };
  const preview = (() => {
    try {
      return generateComponentSource(draft);
    } catch {
      return "Complete valid parameter JSON to preview the source.";
    }
  })();

  const create = async () => {
    const validation = validateComponentDraft(draft);
    if (!validation.source) {
      setErrors(validation.errors);
      return;
    }
    setSaving(true);
    setErrors({});
    try {
      const component = await createLocalComponent(
        suggestedComponentFileName(draft.name),
        validation.source,
      );
      onCreated(component);
      onClose();
    } catch (error) {
      setErrors({
        save: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const field = (
    id: string,
    label: string,
    key: keyof ComponentDraft,
    options?: { rows?: number; hint?: string; required?: boolean },
  ) => (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {options?.rows ? (
        <textarea
          id={id}
          className="input"
          rows={options.rows}
          value={String(draft[key] ?? "")}
          required={options.required}
          aria-invalid={Boolean(errors[key as ComponentDraftField])}
          aria-describedby={`${id}-help`}
          spellCheck={false}
          onChange={(event) => update(key, event.target.value)}
          style={{
            width: "100%",
            resize: "vertical",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-cap)",
          }}
        />
      ) : (
        <input
          id={id}
          ref={key === "name" ? nameRef : undefined}
          className="input"
          value={String(draft[key] ?? "")}
          required={options?.required}
          aria-invalid={Boolean(errors[key as ComponentDraftField])}
          aria-describedby={`${id}-help`}
          onChange={(event) => update(key, event.target.value)}
        />
      )}
      <div id={`${id}-help`} className="field__hint" style={{ marginTop: 3 }}>
        {errors[key as ComponentDraftField] ? (
          <span role="alert" style={{ color: "var(--danger)" }}>
            {errors[key as ComponentDraftField]}
          </span>
        ) : (
          options?.hint
        )}
      </div>
    </div>
  );

  return (
    <div
      className="dialog-overlay"
      style={{ zIndex: 60 }}
      onClick={() => {
        if (!saving) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        style={{ maxWidth: 760 }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            marginBottom: 12,
          }}
        >
          <div>
            <div id={titleId} className="dialog__title">
              New local component
            </div>
            <div className="field__hint">
              Creates {suggestedComponentFileName(draft.name)} without exposing
              boilerplate.
            </div>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onClose}
            disabled={saving}
            aria-label="Close component editor"
          >
            ×
          </button>
        </div>
        {!libraryAvailable && (
          <div
            role="status"
            style={{
              border: "1px solid var(--line-1)",
              borderRadius: "var(--r-2)",
              padding: 8,
              marginBottom: 12,
              color: "var(--text-2)",
              fontSize: "var(--fs-cap)",
            }}
          >
            Saving requires the local companion server. Run{" "}
            <code>npm run serve</code>; you can still prepare and validate the
            component here.
          </div>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
            gap: "0 12px",
          }}
        >
          {field("component-name", "Component key", "name", {
            required: true,
            hint: "Stable key: letters, numbers, dots, underscores, and hyphens.",
          })}
          {field("component-label", "Display label", "label")}
          {field("component-version", "Version", "version")}
          <div style={{ gridColumn: "1 / -1" }}>
            {field("component-description", "Description", "description")}
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            {field(
              "component-params",
              "Parameter definitions (JSON)",
              "params",
              {
                rows: 5,
                hint: "Array fields: name, label, unit, default, min, max.",
              },
            )}
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            {field(
              "component-pressure",
              "pressureDrop(args) body",
              "pressureDropBody",
              {
                rows: 5,
                required: true,
                hint: "Return Pa. args includes mdot, rho, mu, t, area, params, and fluid.",
              },
            )}
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            {field("component-heat", "heat(args) body (optional)", "heatBody", {
              rows: 3,
              hint: "Return heat rate in W. Leave empty to omit heat().",
            })}
          </div>
        </div>
        <details style={{ margin: "4px 0 14px" }}>
          <summary
            style={{
              cursor: "pointer",
              fontSize: "var(--fs-cap)",
              color: "var(--text-2)",
            }}
          >
            Generated source preview
          </summary>
          <textarea
            className="input"
            readOnly
            aria-label="Generated component source"
            rows={10}
            value={preview}
            style={{
              width: "100%",
              resize: "vertical",
              marginTop: 6,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-cap)",
            }}
          />
        </details>
        {errors.save && (
          <div
            role="alert"
            style={{
              color: "var(--danger)",
              fontSize: "var(--fs-cap)",
              marginBottom: 10,
            }}
          >
            {errors.save}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void create()}
            disabled={saving}
          >
            {saving ? "Creating..." : "Create component"}
          </button>
        </div>
      </div>
    </div>
  );
}
