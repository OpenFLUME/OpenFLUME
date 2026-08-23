/**
 * SuggestedSettings — one-click, explainable solver-settings advisor.
 *
 * Renders core/modelAdvisor.suggestSolverSettings() output: each suggestion
 * with its reason, and an Apply button that merges the patch through the
 * store (one undoable edit).  Renders nothing at all when the current
 * settings already match every recommendation — the advisor never nags.
 */
import React from "react";
import { useStore } from "../store";
import { suggestSolverSettings } from "../../core";

export default function SuggestedSettings() {
  const config = useStore((s) => s.config);
  const updateSettings = useStore((s) => s.updateSettings);

  const suggestion = React.useMemo(
    () => suggestSolverSettings(config),
    [config],
  );

  if (suggestion.rationale.length === 0) return null;

  return (
    <div
      className="suggested-settings"
      data-testid="suggested-settings"
      role="group"
      aria-label="Suggested solver settings"
    >
      <div className="suggested-settings__header">
        <span className="suggested-settings__title">
          Suggested for this model
        </span>
        <button
          type="button"
          className="btn btn--sm btn--primary"
          data-testid="suggested-settings-apply"
          onClick={() => updateSettings(suggestion.patch)}
        >
          Apply all
        </button>
      </div>
      <ul className="suggested-settings__list">
        {suggestion.rationale.map((r) => (
          <li key={r.field} className="suggested-settings__item">
            <span className="suggested-settings__what">
              <code>{r.field}</code> → {r.suggestion}
            </span>
            <span className="suggested-settings__why">{r.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
