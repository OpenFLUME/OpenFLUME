import React from "react";
import { useStore } from "../store";
import UnitInput from "./UnitInput";
import NumberField from "./NumberField";
import {
  QuantityKind,
  QUANTITY_LABELS,
  UnitId,
  PRESETS,
  UNITS,
  activeUnitPreset,
} from "../units";
import { formatSig } from "../format";
import {
  IncompressibleLiquid,
  IdealGas,
  ExpandableLiquid,
  validateNetwork,
} from "../../core";
import {
  FLUID_CATALOGUE,
  CURATED_REAL_FLUIDS,
  canonicalizeFluidName,
  getFluidCatalogueEntry,
  type FluidCatalogueEntry,
} from "../../core/fluids/fluidCatalogue";
import { cloneConfig } from "../utils";
import {
  AdvancedConfigSection,
  parseAdvancedConfigJson,
} from "../settingsJson";
import type { FluidSpec } from "../../core";
import {
  namedFluidNames,
  nextNamedFluidName,
  fluidSpecLabel,
} from "../fluidsUi";

/** Canonical preset parameter values, pulled from the core fluid classes so
 *  the dialog can show a named preset's properties read-only. */
function presetParams(
  model: string,
  preset: string | undefined,
): { key: string; label: string; value: number }[] {
  if (model === "incompressible" && preset === "water") {
    const w = IncompressibleLiquid.WATER;
    return [
      { key: "rho", label: "Density rho", value: w.rho },
      { key: "mu", label: "Viscosity mu", value: w.mu },
      { key: "cp", label: "Specific heat cp", value: w.cp(101325, 293) },
    ];
  }
  if (model === "idealGas" && preset === "air") {
    const a = IdealGas.AIR;
    return [
      { key: "R", label: "Gas constant R", value: a.R },
      { key: "gamma", label: "Heat ratio gamma", value: a.gamma ?? 1.4 },
      { key: "mu", label: "Viscosity mu", value: a.mu },
      { key: "cp", label: "Specific heat cp", value: a.cp(101325, 293) },
    ];
  }
  if (model === "expandableLiquid" && preset === "waterExpandable") {
    const w = ExpandableLiquid.WATER_EXPANDABLE;
    return [
      { key: "rho0", label: "Ref density rho0", value: w.rho0 },
      { key: "beta", label: "Thermal expansion beta", value: w.beta },
      { key: "T0", label: "Ref temperature T0", value: w.T0 },
      { key: "mu", label: "Viscosity mu", value: w.mu },
      { key: "cp", label: "Specific heat cp", value: w.cp(101325, 293) },
    ];
  }
  return [];
}

const FLUID_MODEL_OPTIONS: { value: FluidSpec["model"]; label: string }[] = [
  { value: "incompressible", label: "Incompressible" },
  { value: "idealGas", label: "Ideal Gas" },
  { value: "expandableLiquid", label: "Expandable Liquid" },
  { value: "realFluid", label: "Real fluid (CoolProp)" },
];

/** The one built-in preset each analytic model offers; realFluid has none
 *  because its substance comes from the CoolProp catalogue instead. */
const MODEL_PRESET: Record<
  FluidSpec["model"],
  { value: NonNullable<FluidSpec["preset"]>; label: string } | undefined
> = {
  incompressible: { value: "water", label: "Water" },
  idealGas: { value: "air", label: "Air" },
  expandableLiquid: { value: "waterExpandable", label: "Water Expandable" },
  realFluid: undefined,
};

function specForModel(model: FluidSpec["model"]): FluidSpec {
  const preset = MODEL_PRESET[model];
  return preset
    ? { model, preset: preset.value }
    : { model, params: { fluidName: "Nitrogen" } };
}

/** Editable numeric parameters for an analytic model, in `createFluidModel`
 *  order so the form matches the constructor. */
function fluidParamDefs(
  model: FluidSpec["model"],
): { key: string; label: string; step: number }[] {
  if (model === "expandableLiquid") {
    return [
      { key: "rho0", label: "Ref density rho0", step: 0.1 },
      { key: "beta", label: "Thermal expansion beta", step: 1e-6 },
      { key: "T0", label: "Ref temperature T0", step: 1 },
      { key: "mu", label: "Viscosity mu", step: 1e-5 },
      { key: "cp", label: "Specific heat cp", step: 1 },
    ];
  }
  if (model === "idealGas") {
    return [
      { key: "R", label: "Gas constant R", step: 0.1 },
      { key: "gamma", label: "Heat ratio gamma", step: 0.01 },
      { key: "mu", label: "Viscosity mu", step: 1e-6 },
      { key: "cp", label: "Specific heat cp", step: 1 },
    ];
  }
  return [
    { key: "rho", label: "Density rho", step: 0.1 },
    { key: "mu", label: "Viscosity mu", step: 1e-5 },
    { key: "cp", label: "Specific heat cp", step: 1 },
  ];
}

/** Element ids (also used as data-testids) for one fluid editor instance, so
 *  the default fluid keeps its historical ids and each named card gets its
 *  own unique set. */
interface FluidEditorIds {
  model: string;
  preset: string;
  search: string;
  fluidName: string;
  presetProps: string;
  /** Prefix for the per-parameter number fields. */
  param: string;
}

const DEFAULT_FLUID_IDS: FluidEditorIds = {
  model: "settings-fluid-model",
  preset: "settings-fluid-preset",
  search: "settings-real-fluid-search",
  fluidName: "settings-real-fluid-name",
  presetProps: "fluid-preset-props",
  param: "settings-fluid-param",
};

function namedFluidIds(name: string): FluidEditorIds {
  return {
    model: `named-fluid-model-${name}`,
    preset: `named-fluid-preset-${name}`,
    search: `named-fluid-search-${name}`,
    fluidName: `named-fluid-heos-${name}`,
    presetProps: `named-fluid-preset-props-${name}`,
    param: `named-fluid-param-${name}`,
  };
}

/** The whole fluid roster in ONE column: the default fluid as the first
 *  (non-removable) card, then every named continuum, then Add. */
function FluidsSection({
  config,
  setNamedFluid,
  renameNamedFluid,
  removeNamedFluid,
}: {
  config: import("../../core").NetworkConfig;
  setNamedFluid: (name: string, fluid: FluidSpec) => void;
  renameNamedFluid: (name: string, nextName: string) => void;
  removeNamedFluid: (name: string) => void;
}) {
  const names = namedFluidNames(config);
  return (
    <div>
      <div className="settings-section-title">Fluids</div>
      <div className="field__hint named-fluids-hint">
        Named fluids are isolated continua — a branch may only join nodes of the
        same fluid. Couple unlike fluids through a solid wall.
      </div>
      <div className="named-fluid-card named-fluid-card--default">
        <div className="named-fluid-card__header">
          <span className="named-fluid-card__default-label">Default</span>
          <span className="named-fluid-card__aside">
            nodes with no fluid assignment
          </span>
        </div>
        <DefaultFluidEditor />
      </div>
      {names.map((name) => (
        <NamedFluidCard
          key={name}
          name={name}
          spec={config.fluids![name]}
          setNamedFluid={setNamedFluid}
          renameNamedFluid={renameNamedFluid}
          removeNamedFluid={removeNamedFluid}
        />
      ))}
      <button
        type="button"
        className="btn btn--sm"
        data-testid="named-fluid-add"
        onClick={() => {
          const id = nextNamedFluidName(config);
          setNamedFluid(id, { ...config.fluid });
        }}
      >
        + Add fluid
      </button>
    </div>
  );
}

/** One named continuum as a compact card: editable name and a × delete in
 *  the header, then the same full spec editor the default fluid gets. */
function NamedFluidCard({
  name,
  spec,
  setNamedFluid,
  renameNamedFluid,
  removeNamedFluid,
}: {
  name: string;
  spec: FluidSpec;
  setNamedFluid: (name: string, fluid: FluidSpec) => void;
  renameNamedFluid: (name: string, nextName: string) => void;
  removeNamedFluid: (name: string) => void;
}) {
  return (
    <div className="named-fluid-card" data-testid={`named-fluid-${name}`}>
      <div className="named-fluid-card__header">
        <input
          id={`named-fluid-name-${name}`}
          data-testid={`named-fluid-name-${name}`}
          className="input named-fluid-card__name"
          defaultValue={name}
          aria-label={`Name of fluid ${name}`}
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next && next !== name) renameNamedFluid(name, next);
            else e.target.value = name;
          }}
        />
        <span className="named-fluid-card__summary">
          {fluidSpecLabel(spec)}
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--sm named-fluid-card__delete"
          data-testid={`named-fluid-delete-${name}`}
          aria-label={`Delete ${name}`}
          title={`Delete ${name}`}
          onClick={() => removeNamedFluid(name)}
        >
          ×
        </button>
      </div>
      <div className="named-fluid-card__body">
        <FluidSpecEditor
          spec={spec}
          onChange={(next) => setNamedFluid(name, next)}
          ids={namedFluidIds(name)}
          compact
          ariaContext={`for ${name}`}
        />
      </div>
    </div>
  );
}

/** The default fluid's editor, rendered inside the roster's Default card. */
function DefaultFluidEditor() {
  const fluid = useStore((s) => s.config.fluid);
  const updateFluid = useStore((s) => s.updateFluid);
  return (
    <FluidSpecEditor
      spec={fluid}
      // Spell every key out: updateFluid merges, so an omitted `preset` or
      // `params` would survive a model change instead of being cleared.
      onChange={(next) =>
        updateFluid({
          model: next.model,
          preset: next.preset,
          params: next.params,
        })
      }
      ids={DEFAULT_FLUID_IDS}
    />
  );
}

/**
 * Model + preset/CoolProp picker + parameters for one fluid spec, shared by
 * the default fluid and every named continuum.  `compact` drops the field
 * labels and lays the two selects out on one row for the narrower cards.
 */
function FluidSpecEditor({
  spec,
  onChange,
  ids,
  compact = false,
  ariaContext = "",
}: {
  spec: FluidSpec;
  onChange: (next: FluidSpec) => void;
  ids: FluidEditorIds;
  compact?: boolean;
  ariaContext?: string;
}) {
  const presetOption = MODEL_PRESET[spec.model];
  const presetProps = presetParams(spec.model, spec.preset);

  const modelSelect = (
    <select
      id={ids.model}
      data-testid={ids.model}
      className="select"
      aria-label={compact ? `Model ${ariaContext}`.trim() : undefined}
      value={spec.model}
      onChange={(e) =>
        onChange(specForModel(e.target.value as FluidSpec["model"]))
      }
    >
      {FLUID_MODEL_OPTIONS.map(({ value, label }) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );

  const presetSelect = presetOption && (
    <select
      id={ids.preset}
      data-testid={ids.preset}
      className="select"
      aria-label={compact ? `Preset ${ariaContext}`.trim() : undefined}
      value={spec.preset || ""}
      onChange={(e) => {
        if (e.target.value) {
          onChange({ model: spec.model, preset: presetOption.value });
          return;
        }
        // Seed Custom from the preset's constants so the fields open on a
        // working fluid rather than blank.
        const seeded: Record<string, number | string> = {};
        for (const row of presetProps) seeded[row.key] = row.value;
        onChange({
          model: spec.model,
          preset: undefined,
          params: { ...seeded, ...(spec.params ?? {}) },
        });
      }}
    >
      <option value="">Custom</option>
      <option value={presetOption.value}>{presetOption.label}</option>
    </select>
  );

  return (
    <>
      {compact ? (
        // Full-width stacked rows: the card is too narrow to show both
        // "Expandable Liquid" and "Water Expandable" side by side.
        <>
          <div className="field">{modelSelect}</div>
          {presetSelect && <div className="field">{presetSelect}</div>}
        </>
      ) : (
        <>
          <div className="field">
            <label className="field__label" htmlFor={ids.model}>
              Model
            </label>
            {modelSelect}
          </div>
          {presetSelect && (
            <div className="field">
              <label className="field__label" htmlFor={ids.preset}>
                Preset
              </label>
              {presetSelect}
            </div>
          )}
        </>
      )}
      {spec.model === "realFluid" ? (
        <CataloguePickerFields
          searchId={ids.search}
          selectId={ids.fluidName}
          searchTestId={ids.search}
          selectTestId={ids.fluidName}
          rawName={(spec.params?.fluidName as string) || ""}
          onSelect={(fluidName) =>
            onChange({ model: "realFluid", params: { fluidName } })
          }
          compact={compact}
          ariaContext={ariaContext}
        />
      ) : presetProps.length > 0 ? (
        <>
          {!compact && (
            <div className="field__label">
              Preset properties{" "}
              <span className="field__unit">
                (read-only — choose Custom to edit)
              </span>
            </div>
          )}
          <FluidParamsReadOnly
            rows={presetProps}
            testId={ids.presetProps}
            ariaContext={ariaContext}
          />
        </>
      ) : (
        <>
          {!compact && <div className="field__label">Custom Parameters</div>}
          <FluidParamsEditor
            model={spec.model}
            params={spec.params}
            onChange={(params) =>
              onChange({ model: spec.model, preset: undefined, params })
            }
            idPrefix={ids.param}
            ariaContext={ariaContext}
            allowExtraParams={!compact}
          />
        </>
      )}
    </>
  );
}

export default function SettingsDialog() {
  const show = useStore((s) => s.showSettings);
  const setShow = useStore((s) => s.setShowSettings);
  const config = useStore((s) => s.config);
  const updateAdvancedSection = useStore((s) => s.updateAdvancedSection);
  const updateSettings = useStore((s) => s.updateSettings);
  const setNamedFluid = useStore((s) => s.setNamedFluid);
  const renameNamedFluid = useStore((s) => s.renameNamedFluid);
  const removeNamedFluid = useStore((s) => s.removeNamedFluid);
  const unitPreferences = useStore((s) => s.unitPreferences);
  const setUnitPreset = useStore((s) => s.setUnitPreset);
  const setUnitPreference = useStore((s) => s.setUnitPreference);
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const restoreFocusRef = React.useRef<Element | null>(null);
  const titleId = React.useId();
  const updateAdaptive = (
    patch: Partial<NonNullable<typeof config.settings.adaptive>>,
  ) => {
    const adaptive = config.settings.adaptive;
    if (adaptive) updateSettings({ adaptive: { ...adaptive, ...patch } });
  };

  const activePreset = activeUnitPreset(unitPreferences);

  // Initial focus + restore focus on close.
  React.useEffect(() => {
    if (!show) return;
    restoreFocusRef.current = document.activeElement;
    closeRef.current?.focus();
    return () => {
      (restoreFocusRef.current as HTMLElement | null)?.focus?.();
    };
  }, [show]);

  // Escape closes; Tab is trapped inside the dialog.
  React.useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShow(false);
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, setShow]);

  if (!show) return null;

  return (
    <div
      data-testid="settings-dialog"
      className="dialog-overlay"
      onClick={() => setShow(false)}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog__header">
          <div id={titleId} className="dialog__title">
            Global Settings
          </div>
          <button
            ref={closeRef}
            data-testid="settings-close"
            className="btn btn--ghost dialog__close"
            onClick={() => setShow(false)}
            aria-label="Close settings"
          >
            ×
          </button>
        </div>

        <div className="settings-grid">
          <div>
            <div className="settings-section-title">Solver</div>
            <div className="field">
              <label className="field__label" htmlFor="settings-mode">
                Mode
              </label>
              <select
                id="settings-mode"
                data-testid="settings-mode"
                className="select"
                value={config.settings.mode}
                onChange={(e) =>
                  updateSettings({
                    mode: e.target.value as "steady" | "transient",
                  })
                }
              >
                <option value="steady">Steady</option>
                <option value="transient">Transient</option>
              </select>
            </div>
            <NumberField
              label="Tolerance"
              value={config.settings.tolerance}
              step={1e-9}
              onChange={(v) => updateSettings({ tolerance: v })}
            />
            <NumberField
              label="Max Iterations"
              value={config.settings.maxIterations}
              step={10}
              onChange={(v) => updateSettings({ maxIterations: v })}
            />
            <NumberField
              label="Relaxation"
              value={config.settings.relaxation}
              step={0.05}
              onChange={(v) => updateSettings({ relaxation: v })}
            />
            {config.settings.mode === "transient" && (
              <>
                <div className="field">
                  <label
                    className="field__label"
                    htmlFor="settings-time-stepping"
                  >
                    Time stepping
                  </label>
                  <select
                    id="settings-time-stepping"
                    data-testid="settings-time-stepping"
                    className="select"
                    value={config.settings.timeStepping ?? "fixed"}
                    onChange={(e) =>
                      updateSettings({
                        timeStepping: e.target.value as "fixed" | "adaptive",
                      })
                    }
                  >
                    <option value="fixed">Fixed dt</option>
                    <option value="adaptive">Adaptive</option>
                  </select>
                </div>
                {config.settings.timeStepping === "adaptive" ? (
                  <>
                    <UnitInput
                      label="Min dt"
                      quantityKind="time"
                      value={config.settings.adaptive?.dtMin}
                      step={0.001}
                      onChange={(dtMin) => updateAdaptive({ dtMin })}
                    />
                    <UnitInput
                      label="Max dt"
                      quantityKind="time"
                      value={config.settings.adaptive?.dtMax}
                      step={0.001}
                      onChange={(dtMax) => updateAdaptive({ dtMax })}
                    />
                    <UnitInput
                      label="Initial dt"
                      quantityKind="time"
                      value={config.settings.adaptive?.dtInitial}
                      step={0.001}
                      onChange={(dtInitial) => updateAdaptive({ dtInitial })}
                    />
                    <NumberField
                      label="Relative tolerance"
                      value={config.settings.adaptive?.relTol}
                      step={1e-4}
                      onChange={(relTol) => updateAdaptive({ relTol })}
                    />
                    <NumberField
                      label="Safety factor"
                      value={config.settings.adaptive?.safety}
                      step={0.05}
                      onChange={(safety) => updateAdaptive({ safety })}
                    />
                  </>
                ) : (
                  <>
                    <UnitInput
                      label="Time Step"
                      quantityKind="time"
                      value={config.settings.dt}
                      step={0.001}
                      onChange={(v) => updateSettings({ dt: v })}
                    />
                  </>
                )}
                <UnitInput
                  label="End Time"
                  quantityKind="time"
                  value={config.settings.endTime}
                  step={0.1}
                  onChange={(v) => updateSettings({ endTime: v })}
                />
              </>
            )}
          </div>
          <FluidsSection
            config={config}
            setNamedFluid={setNamedFluid}
            renameNamedFluid={renameNamedFluid}
            removeNamedFluid={removeNamedFluid}
          />
          <div>
            <div className="settings-section-title">Units</div>
            <div className="settings-preset-row">
              {Object.keys(PRESETS).map((name) => (
                <button
                  key={name}
                  data-testid={`unit-preset-${name.replace(/\s+/g, "-").toLowerCase()}`}
                  className="btn btn--sm btn--choice"
                  aria-pressed={activePreset === name}
                  onClick={() => setUnitPreset(name)}
                >
                  {name}
                </button>
              ))}
            </div>
            <div className="settings-unit-list">
              {(Object.keys(UNITS) as QuantityKind[]).map((kind) => (
                <div key={kind} className="field settings-unit-row">
                  <label
                    className="field__label settings-unit-row__label"
                    htmlFor={`unit-select-${kind}`}
                  >
                    {QUANTITY_LABELS[kind]}
                  </label>
                  <select
                    id={`unit-select-${kind}`}
                    data-testid={`unit-select-${kind}`}
                    className="select"
                    value={unitPreferences[kind]}
                    onChange={(e) =>
                      setUnitPreference(kind, e.target.value as UnitId)
                    }
                  >
                    {UNITS[kind].map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.symbol}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="settings-section-title settings-section-title--advanced">
          Advanced Extensibility
        </div>
        <div className="settings-grid settings-grid--advanced">
          <AdvancedJsonEditor
            section="registers"
            value={config.registers ?? {}}
            hint="Named finite numbers available as reg('name') or bare identifiers in expressions."
            onApply={(value) => {
              updateAdvancedSection(
                "registers",
                value as NonNullable<typeof config.registers>,
              );
            }}
          />
          <AdvancedJsonEditor
            section="logic"
            value={config.logic ?? []}
            hint="Rules use expression strings such as t > 1 and node('inlet').P. Lifecycle on: init, stepStart, stepRejected, stepAccepted, converged, solveEnd."
            onApply={(value) => {
              updateAdvancedSection(
                "logic",
                value as NonNullable<typeof config.logic>,
              );
            }}
          />
          <AdvancedJsonEditor
            section="controllers"
            value={config.controllers ?? []}
            hint="Transient-only PID: setpoint, gains { kp, ki, kd }, sense, output, and optional limits/initialOutput. Runs on stepAccepted."
            onApply={(value) => {
              updateAdvancedSection(
                "controllers",
                value as NonNullable<typeof config.controllers>,
              );
            }}
          />
        </div>
      </div>
    </div>
  );
}

function AdvancedJsonEditor({
  section,
  value,
  hint,
  onApply,
}: {
  section: AdvancedConfigSection;
  value: unknown;
  hint: string;
  onApply: (value: unknown) => void;
}) {
  const config = useStore((s) => s.config);
  const serializedValue = JSON.stringify(value, null, 2);
  const [draft, setDraft] = React.useState(() => serializedValue);
  const [error, setError] = React.useState<string | null>(null);
  const [dirtyDraft, setDirtyDraft] = React.useState(false);
  const label =
    section === "registers"
      ? "Registers"
      : section === "logic"
        ? "Logic Rules"
        : "Controllers";
  const helpId = `settings-${section}-help`;
  const errorId = `settings-${section}-error`;

  React.useEffect(() => {
    if (!dirtyDraft) {
      setDraft(serializedValue);
      setError(null);
    }
  }, [serializedValue, dirtyDraft]);

  const apply = () => {
    const parsed = parseAdvancedConfigJson(section, draft);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    const candidate = cloneConfig(config);
    if (section === "registers")
      candidate.registers = parsed.value as NonNullable<
        typeof candidate.registers
      >;
    else if (section === "logic")
      candidate.logic = parsed.value as NonNullable<typeof candidate.logic>;
    else
      candidate.controllers = parsed.value as NonNullable<
        typeof candidate.controllers
      >;
    const validationPrefix =
      section === "registers"
        ? "Register "
        : section === "logic"
          ? "Logic rule "
          : "Controller";
    const validationErrors = validateNetwork(candidate).filter((message) =>
      message.startsWith(validationPrefix),
    );
    if (validationErrors.length > 0) {
      setError(validationErrors.slice(0, 3).join(" "));
      return;
    }
    setError(null);
    setDirtyDraft(false);
    onApply(parsed.value);
  };

  return (
    <div className="field settings-json-field">
      <label className="field__label" htmlFor={`settings-${section}`}>
        {label} JSON
      </label>
      <textarea
        id={`settings-${section}`}
        data-testid={`settings-${section}`}
        className="input settings-json"
        rows={8}
        spellCheck={false}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setDirtyDraft(true);
        }}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={`${helpId}${error ? ` ${errorId}` : ""}`}
      />
      <div id={helpId} className="field__hint">
        {hint}
      </div>
      {error && (
        <div id={errorId} role="alert" className="field__error">
          {error}
        </div>
      )}
      <button
        className="btn btn--sm settings-json-field__apply"
        onClick={apply}
      >
        Apply {label}
      </button>
    </div>
  );
}

/** Display labels for the curated favorites (formula hints for common fluids). */
const FAVORITE_FLUID_LABELS: Record<string, string> = {
  Nitrogen: "Nitrogen (N₂)",
  Oxygen: "Oxygen (O₂)",
  Hydrogen: "Hydrogen (H₂)",
  ParaHydrogen: "Parahydrogen (p-H₂)",
  Helium: "Helium (He)",
  Methane: "Methane (CH₄)",
  CarbonDioxide: "Carbon dioxide (CO₂)",
  Water: "Water/steam (H₂O)",
  NitrousOxide: "Nitrous oxide (N₂O)",
};

/** Suffix markers for catalogue fluids in the picker. */
function catalogueOptionLabel(entry: FluidCatalogueEntry): string {
  const markers: string[] = [];
  if (!entry.pure) markers.push("mixture");
  if (entry.transport.viscosity !== "yes") markers.push("⚠ no transport model");
  else if (entry.transport.conductivity !== "yes")
    markers.push("⚠ no conductivity model");
  return markers.length > 0
    ? `${entry.name} (${markers.join(", ")})`
    : entry.name;
}

/**
 * Searchable CoolProp HEOS fluid picker fields: the curated favorites
 * optgroup first, then every fluid of the generated catalogue (all 124 HEOS
 * pure and pseudo-pure fluids; INCOMP/REFPROP strings are not part of the
 * catalogue).  The select stays a NATIVE select (e2e drives it with
 * selectOption); the search box only filters which options are rendered.
 *
 * A saved fluid name that no longer resolves to the catalogue is rendered as
 * its own visible, invalid option — never silently swapped for a default.
 *
 * Serves both the default-fluid column (labelled fields + all-good hint) and
 * the named-fluid cards (`compact`: no field labels, warnings only).
 */
function CataloguePickerFields({
  searchId,
  selectId,
  searchTestId,
  selectTestId,
  rawName,
  onSelect,
  compact = false,
  ariaContext = "",
}: {
  searchId: string;
  selectId: string;
  searchTestId: string;
  selectTestId: string;
  rawName: string;
  onSelect: (fluidName: string) => void;
  /** Named-fluid card mode: skip the field labels and the all-good hint. */
  compact?: boolean;
  /** Accessible-name suffix in compact mode, e.g. "for coolant". */
  ariaContext?: string;
}) {
  const [query, setQuery] = React.useState("");

  const canonical = canonicalizeFluidName(rawName);
  const known = canonical !== undefined;
  const selectedEntry = known ? getFluidCatalogueEntry(canonical) : undefined;

  const q = query.trim().toLowerCase();
  const matches = (entry: FluidCatalogueEntry): boolean => {
    if (q.length === 0) return true;
    if (entry.name.toLowerCase().includes(q)) return true;
    if (entry.cas.toLowerCase().includes(q)) return true;
    return entry.aliases.some((a) => a.toLowerCase().includes(q));
  };

  const favorites = CURATED_REAL_FLUIDS.map((name) =>
    getFluidCatalogueEntry(name)!,
  ).filter(matches);
  const all = FLUID_CATALOGUE.filter(matches);

  return (
    <>
      <div className="field">
        {!compact && (
          <label className="field__label" htmlFor={searchId}>
            Search fluids
          </label>
        )}
        <input
          id={searchId}
          data-testid={searchTestId}
          className="input"
          type="search"
          placeholder="Filter by name, alias, or CAS…"
          aria-label={
            compact ? `Search fluids ${ariaContext}`.trim() : undefined
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="field">
        {!compact && (
          <label className="field__label" htmlFor={selectId}>
            Fluid
          </label>
        )}
        <select
          id={selectId}
          data-testid={selectTestId}
          className="select"
          aria-label={
            compact ? `CoolProp fluid ${ariaContext}`.trim() : undefined
          }
          value={known ? canonical : rawName}
          aria-invalid={
            !known || selectedEntry?.transport.viscosity !== "yes"
              ? true
              : undefined
          }
          onChange={(e) => onSelect(e.target.value)}
        >
          {!known && (
            <option value={rawName}>
              ⚠ Unknown fluid: {rawName || "(none)"}
            </option>
          )}
          {favorites.length > 0 && (
            <optgroup label="Favorites">
              {favorites.map((entry) => (
                <option key={`fav-${entry.name}`} value={entry.name}>
                  {FAVORITE_FLUID_LABELS[entry.name] ?? entry.name}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label={`All CoolProp HEOS fluids (${all.length})`}>
            {all.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {catalogueOptionLabel(entry)}
              </option>
            ))}
          </optgroup>
        </select>
      </div>
      {!known ? (
        <div
          className="field__hint"
          role="alert"
          style={{
            fontSize: "var(--fs-cap)",
            marginTop: 4,
            color: "var(--danger)",
          }}
        >
          Saved fluid "{rawName || "(none)"}" is not a CoolProp HEOS fluid —
          pick one from the list to fix the configuration.
        </div>
      ) : selectedEntry && selectedEntry.transport.viscosity !== "yes" ? (
        <div
          className="field__hint"
          role="alert"
          style={{
            fontSize: "var(--fs-cap)",
            marginTop: 4,
            color: "var(--danger)",
          }}
        >
          {selectedEntry.name} has no viscosity
          {selectedEntry.transport.conductivity !== "yes"
            ? " or thermal-conductivity"
            : ""}{" "}
          model in CoolProp HEOS; a solve would use zero transport (no friction
          / no convection).
        </div>
      ) : !compact ? (
        <div
          className="field__hint"
          style={{ fontSize: "var(--fs-cap)", marginTop: 4 }}
        >
          NIST-grade properties via CoolProp (single-phase only)
          {selectedEntry && !selectedEntry.pure ? " — pseudo-pure mixture" : ""}
        </div>
      ) : null}
    </>
  );
}

/** Read-only display of a named fluid preset's properties. */
function FluidParamsReadOnly({
  rows,
  testId,
  ariaContext = "",
}: {
  rows: { key: string; label: string; value: number }[];
  testId: string;
  ariaContext?: string;
}) {
  return (
    <div data-testid={testId}>
      {rows.map(({ key, label, value }) => (
        <div
          key={key}
          style={{
            display: "flex",
            gap: 4,
            marginBottom: 4,
            alignItems: "center",
          }}
        >
          <span
            className="field__label"
            style={{ width: 110, marginBottom: 0 }}
          >
            {label}
          </span>
          <input
            className="input"
            style={{ flex: 1 }}
            value={formatSig(value, 4)}
            readOnly
            disabled
            aria-label={`${label} ${ariaContext}`.trim()}
          />
        </div>
      ))}
    </div>
  );
}

function InlineNumberEditor({
  value,
  label,
  onCommit,
}: {
  value: number | string;
  label: string;
  onCommit: (value: number) => void;
}) {
  const [raw, setRaw] = React.useState(String(value));
  React.useEffect(() => setRaw(String(value)), [value]);
  const commit = () => {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) onCommit(parsed);
    else setRaw(String(value));
  };
  return (
    <input
      className="input"
      style={{ flex: 1 }}
      type="text"
      inputMode="decimal"
      value={raw}
      aria-label={label}
      onChange={(event) => setRaw(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter")
          (event.currentTarget as HTMLInputElement).blur();
        else if (event.key === "Escape") {
          setRaw(String(value));
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function FluidParamsEditor({
  model,
  params,
  onChange,
  idPrefix,
  ariaContext = "",
  allowExtraParams = true,
}: {
  model: FluidSpec["model"];
  params: FluidSpec["params"];
  onChange: (params: Record<string, number | string>) => void;
  idPrefix: string;
  ariaContext?: string;
  /** Show the free-form key/value adder. `createFluidModel` ignores keys
   *  outside the model's own set, so the cards leave it off. */
  allowExtraParams?: boolean;
}) {
  const [newKey, setNewKey] = React.useState("");
  const [newVal, setNewVal] = React.useState("");

  const entries = Object.entries(params || {});
  const update = (key: string, value: number | undefined) => {
    const next = { ...(params || {}) };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };

  const paramDefs = React.useMemo(() => fluidParamDefs(model), [model]);
  const suffix = ariaContext ? ` ${ariaContext}` : "";

  return (
    <div>
      {paramDefs.map(({ key, label, step }) => (
        <NumberField
          key={key}
          label={label}
          ariaLabel={suffix ? `${label}${suffix}` : undefined}
          dataTestId={`${idPrefix}-${key}`}
          step={step}
          value={
            typeof params?.[key] === "number"
              ? (params[key] as number)
              : undefined
          }
          onChange={(v) => update(key, v)}
        />
      ))}
      {entries
        .filter(([k]) => !paramDefs.some((d) => d.key === k))
        .map(([k, v]) => (
          <div key={k} style={{ display: "flex", gap: 4, marginBottom: 4 }}>
            <input
              className="input"
              style={{ flex: 1 }}
              value={k}
              readOnly
              aria-label={`Parameter ${k}${suffix}`}
            />
            <InlineNumberEditor
              value={v}
              label={`Value for ${k}${suffix}`}
              onCommit={(value) => update(k, value)}
            />
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => update(k, undefined)}
              aria-label={`Remove ${k}${suffix}`}
            >
              ×
            </button>
          </div>
        ))}
      {allowExtraParams && (
        <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder="key"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            aria-label={`New parameter key${suffix}`}
          />
          <input
            className="input"
            style={{ flex: 1 }}
            type="number"
            step={0.1}
            placeholder="value"
            value={newVal}
            onChange={(e) => setNewVal(e.target.value)}
            aria-label={`New parameter value${suffix}`}
          />
          <button
            className="btn btn--sm"
            disabled={!newKey.trim() || !Number.isFinite(Number(newVal))}
            aria-label={`Add parameter${suffix}`}
            onClick={() => {
              const value = Number(newVal);
              if (newKey.trim() && Number.isFinite(value)) {
                update(newKey.trim(), value);
                setNewKey("");
                setNewVal("");
              }
            }}
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
