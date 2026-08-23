import React from "react";
import { useStore, type ClosureParamGroup, type SettingsTabId } from "../store";
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
  DEFAULT_CLOSURE_PARAMS,
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
import { SETTINGS_TABS } from "../settingsTabs";
import SuggestedSettings from "./SuggestedSettings";

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

/**
 * The settings tab strip + active tab body, decoupled from the modal chrome
 * so shells can host global settings anywhere (modal, full page, or a single
 * stage).  Pass `only` to render exactly one section's body with no strip.
 */
export function SettingsSections({ only }: { only?: SettingsTabId }) {
  const config = useStore((s) => s.config);
  const updateAdvancedSection = useStore((s) => s.updateAdvancedSection);
  const updateSettings = useStore((s) => s.updateSettings);
  const setNamedFluid = useStore((s) => s.setNamedFluid);
  const renameNamedFluid = useStore((s) => s.renameNamedFluid);
  const removeNamedFluid = useStore((s) => s.removeNamedFluid);
  const unitPreferences = useStore((s) => s.unitPreferences);
  const setUnitPreset = useStore((s) => s.setUnitPreset);
  const setUnitPreference = useStore((s) => s.setUnitPreference);
  const storeTab = useStore((s) => s.settingsTab);
  const setTab = useStore((s) => s.setSettingsTab);
  const tab = only ?? storeTab;
  const updateAdaptive = (
    patch: Partial<NonNullable<typeof config.settings.adaptive>>,
  ) => {
    const adaptive = config.settings.adaptive;
    if (adaptive) updateSettings({ adaptive: { ...adaptive, ...patch } });
  };

  const activePreset = activeUnitPreset(unitPreferences);

  return (
    <>
      {!only && (
        <div
          className="settings-tabs tabs"
          role="tablist"
          aria-label="Settings sections"
        >
          {SETTINGS_TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="tab"
              role="tab"
              id={`settings-tab-${entry.id}`}
              data-testid={`settings-tab-${entry.id}`}
              title={entry.title}
              aria-selected={tab === entry.id}
              aria-controls={`settings-tab-panel-${entry.id}`}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}

      <div
        className="settings-tab-panel"
        role="tabpanel"
        id={`settings-tab-panel-${tab}`}
        aria-labelledby={only ? undefined : `settings-tab-${tab}`}
        aria-label={
          only ? SETTINGS_TABS.find((t) => t.id === tab)?.label : undefined
        }
        data-testid={`settings-tab-panel-${tab}`}
      >
        {tab === "solver" && (
          <SolverTab
            config={config}
            updateSettings={updateSettings}
            updateAdaptive={updateAdaptive}
          />
        )}
        {tab === "physics" && (
          <PhysicsTab config={config} updateSettings={updateSettings} />
        )}
        {tab === "fluids" && (
          <div className="settings-grid">
            <FluidsSection
              config={config}
              setNamedFluid={setNamedFluid}
              renameNamedFluid={renameNamedFluid}
              removeNamedFluid={removeNamedFluid}
            />
          </div>
        )}
        {tab === "species" && <SpeciesTab config={config} />}
        {tab === "units" && (
          <div className="settings-grid">
            <div>
              <div className="settings-section-title">Presets</div>
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
              <div className="field__hint">
                Display only — the model is always stored and solved in SI.
              </div>
            </div>
            <div className="settings-units-columns">
              <div className="settings-section-title">Per-quantity units</div>
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
        )}
        {tab === "extensibility" && (
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
        )}
      </div>
    </>
  );
}

/**
 * The Configuration workspace view: everything global about the model that is
 * not the network itself. One of the four center views (Model, Configuration,
 * Sweep, Runs), reached from the tab strip or from a Configuration row in the
 * project outline — which is why it shares that section's name.
 *
 * These settings belong to the ACTIVE VARIANT: editing them while a variant
 * is active records into that variant's patch, exactly like editing an
 * element does.
 */
export default function ConfigurationView() {
  return (
    // No visible heading: the selected tab already names this view, and a
    // second "Configuration" title under it read as a duplicate.
    <div
      data-testid="configuration-view"
      className="shell-studio__settings-page"
      role="region"
      aria-label="Configuration"
    >
      <SettingsSections />
    </div>
  );
}

type NetworkSettings = import("../../core").NetworkConfig["settings"];

/** Mode, convergence, time stepping, and — behind a disclosure — the Newton
 *  strategy knobs that used to be reachable only from the Text tab. */
function SolverTab({
  config,
  updateSettings,
  updateAdaptive,
}: {
  config: import("../../core").NetworkConfig;
  updateSettings: (patch: Partial<NetworkSettings>) => void;
  updateAdaptive: (
    patch: Partial<NonNullable<NetworkSettings["adaptive"]>>,
  ) => void;
}) {
  const settings = config.settings;
  const transient = settings.mode === "transient";
  const adaptive = transient && settings.timeStepping === "adaptive";
  return (
    <div className="settings-grid">
      <SuggestedSettings />
      <div>
        <div className="settings-section-title">Solution</div>
        <div className="field">
          <label className="field__label" htmlFor="settings-mode">
            Mode
          </label>
          <select
            id="settings-mode"
            data-testid="settings-mode"
            className="select"
            value={settings.mode}
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
          value={settings.tolerance}
          step={1e-9}
          onChange={(v) => updateSettings({ tolerance: v })}
        />
        <NumberField
          label="Max Iterations"
          value={settings.maxIterations}
          step={10}
          onChange={(v) => updateSettings({ maxIterations: v })}
        />
        <NumberField
          label="Relaxation"
          value={settings.relaxation}
          step={0.05}
          onChange={(v) => updateSettings({ relaxation: v })}
        />
      </div>

      <div>
        <div className="settings-section-title">Time stepping</div>
        {transient ? (
          <>
            <div className="field">
              <label className="field__label" htmlFor="settings-time-stepping">
                Stepping
              </label>
              <select
                id="settings-time-stepping"
                data-testid="settings-time-stepping"
                className="select"
                value={settings.timeStepping ?? "fixed"}
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
            {adaptive ? (
              <>
                <UnitInput
                  label="Min dt"
                  quantityKind="time"
                  value={settings.adaptive?.dtMin}
                  step={0.001}
                  onChange={(dtMin) => updateAdaptive({ dtMin })}
                />
                <UnitInput
                  label="Max dt"
                  quantityKind="time"
                  value={settings.adaptive?.dtMax}
                  step={0.001}
                  onChange={(dtMax) => updateAdaptive({ dtMax })}
                />
                <UnitInput
                  label="Initial dt"
                  quantityKind="time"
                  value={settings.adaptive?.dtInitial}
                  step={0.001}
                  onChange={(dtInitial) => updateAdaptive({ dtInitial })}
                />
                <NumberField
                  label="Relative tolerance"
                  value={settings.adaptive?.relTol}
                  step={1e-4}
                  onChange={(relTol) => updateAdaptive({ relTol })}
                />
                <NumberField
                  label="Safety factor"
                  value={settings.adaptive?.safety}
                  step={0.05}
                  onChange={(safety) => updateAdaptive({ safety })}
                />
                <NumberField
                  label="Absolute pressure tolerance"
                  unitNote="Pa, default 100"
                  dataTestId="settings-abs-tol-p"
                  value={settings.adaptive?.absTolP}
                  step={10}
                  onChange={(absTolP) => updateAdaptive({ absTolP })}
                />
                <NumberField
                  label="Absolute temperature tolerance"
                  unitNote="K, default 0.01"
                  dataTestId="settings-abs-tol-t"
                  value={settings.adaptive?.absTolT}
                  step={0.01}
                  onChange={(absTolT) => updateAdaptive({ absTolT })}
                />
                <div className="field__hint">
                  The error controller accepts a step when the relative
                  tolerance OR the matching absolute tolerance is met, so the
                  absolute floors stop tiny pressures and temperatures from
                  driving dt down needlessly.
                </div>
              </>
            ) : (
              <UnitInput
                label="Time Step"
                quantityKind="time"
                value={settings.dt}
                step={0.001}
                onChange={(v) => updateSettings({ dt: v })}
              />
            )}
            <UnitInput
              label="End Time"
              quantityKind="time"
              value={settings.endTime}
              step={0.1}
              onChange={(v) => updateSettings({ endTime: v })}
            />
          </>
        ) : (
          <div className="field__hint" data-testid="settings-stepping-na">
            Steady solves have no time axis. Switch Mode to Transient to set a
            time step and end time.
          </div>
        )}
      </div>

      <div>
        <div className="settings-section-title">Newton strategy</div>
        <details className="settings-disclosure">
          <summary data-testid="settings-numerics-toggle">
            Advanced numerics
          </summary>
          <div className="settings-disclosure__body">
            <div className="field__hint">
              Defaults suit every shipped example. Change these only when a
              solve will not converge.
            </div>
            <div className="field">
              <label className="field__label" htmlFor="settings-steady-solver">
                Steady solver
              </label>
              <select
                id="settings-steady-solver"
                data-testid="settings-steady-solver"
                className="select"
                disabled={transient}
                value={settings.steadySolver ?? "ptc"}
                onChange={(e) =>
                  updateSettings({
                    steadySolver: e.target.value as "ptc" | "direct",
                  })
                }
              >
                <option value="ptc">
                  Pseudo-transient continuation (default)
                </option>
                <option value="direct">Direct Newton</option>
              </select>
              {transient && (
                <div className="field__hint">Steady mode only.</div>
              )}
            </div>
            <div className="field">
              <label className="field__label" htmlFor="settings-globalization">
                Globalization
              </label>
              <select
                id="settings-globalization"
                data-testid="settings-globalization"
                className="select"
                value={
                  settings.globalization ??
                  (transient ? "lineSearch" : "trustRegion")
                }
                onChange={(e) =>
                  updateSettings({
                    globalization: e.target.value as
                      "trustRegion" | "lineSearch",
                  })
                }
              >
                <option value="trustRegion">
                  Trust region{transient ? "" : " (default)"}
                </option>
                <option value="lineSearch">
                  Line search{transient ? " (default)" : ""}
                </option>
              </select>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="settings-jacobian">
                Jacobian
              </label>
              <select
                id="settings-jacobian"
                data-testid="settings-jacobian"
                className="select"
                value={settings.jacobian ?? "hybrid"}
                onChange={(e) =>
                  updateSettings({
                    jacobian: e.target.value as "hybrid" | "fd",
                  })
                }
              >
                <option value="hybrid">Hybrid analytic/FD (default)</option>
                <option value="fd">Finite difference</option>
              </select>
            </div>
            <label className="field__label check-label">
              <input
                type="checkbox"
                data-testid="settings-certify-after-coupling"
                checked={!!settings.certifyAfterCoupling}
                onChange={(e) =>
                  updateSettings({
                    certifyAfterCoupling: e.target.checked || undefined,
                  })
                }
              />
              Re-certify after coupling
            </label>
            <div className="field__hint">
              EXPERIMENTAL. Re-measures the transient real-fluid residual after
              the wall solve and h-map refresh. Investigation flag only — leave
              off unless you are chasing a dome-edge stall.
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}

/** One-line description of the momentum/energy formulation the current flag
 *  combination selects, so the interaction between four booleans is legible
 *  without cross-referencing the manual. */
function formulationSummary(settings: NetworkSettings): string {
  const momentum = !!settings.momentumFlux;
  const energy = !!settings.kineticEnergy;
  if (momentum && energy) {
    const scheme =
      (settings.momentumFluxScheme ?? "upwind") === "central"
        ? "central (exact integral)"
        : "limited-upwind";
    return `Quasi-1-D compressible: ${scheme} momentum faces with stagnation-enthalpy transport. Fanno and Rayleigh choking and tapered nozzles are in scope.`;
  }
  if (momentum) {
    return "Convective acceleration only: branch momentum carries the flow-acceleration term, but energy transport stays static-enthalpy. Add kinetic energy for a full quasi-1-D formulation.";
  }
  if (energy) {
    return "Stagnation-enthalpy transport only: branches carry h + V²/2 without the momentum-flux term. Add momentum flux for a full quasi-1-D formulation.";
  }
  return "Incompressible baseline: algebraic branch momentum and static-enthalpy transport. This is the configuration the published benchmarks were validated against.";
}

/** Compressible-formulation flags plus the closure-calibration surface. */
function PhysicsTab({
  config,
  updateSettings,
}: {
  config: import("../../core").NetworkConfig;
  updateSettings: (patch: Partial<NetworkSettings>) => void;
}) {
  const settings = config.settings;
  const momentumFlux = !!settings.momentumFlux;
  const scheme = settings.momentumFluxScheme ?? "upwind";
  // The audit only has expansion-shock roots to choose between under the
  // central scheme, and it runs post-hoc on a steady solve.
  const auditApplies =
    momentumFlux && scheme === "central" && settings.mode === "steady";
  return (
    <div className="settings-grid">
      <div>
        <div className="settings-section-title">Compressible formulation</div>
        <label className="field__label check-label">
          <input
            type="checkbox"
            data-testid="settings-momentum-flux"
            checked={momentumFlux}
            onChange={(e) =>
              updateSettings({ momentumFlux: e.target.checked || undefined })
            }
          />
          Momentum flux
        </label>
        <div className="field__hint">
          Convective acceleration ΔP = (ṁ/A)²·(1/ρ_out − 1/ρ_in). Identically
          zero at constant density.
        </div>
        <label className="field__label check-label">
          <input
            type="checkbox"
            data-testid="settings-kinetic-energy"
            checked={!!settings.kineticEnergy}
            onChange={(e) =>
              updateSettings({ kineticEnergy: e.target.checked || undefined })
            }
          />
          Kinetic energy
        </label>
        <div className="field__hint">
          Branches transport ṁ·(h + V²/2). Required by reacting junctions, and
          it is what gives real fluids their Mach coupling.
        </div>
        <div
          className="settings-formulation"
          data-testid="settings-formulation-summary"
        >
          {formulationSummary(settings)}
        </div>
      </div>

      <div>
        <div className="settings-section-title">Transonic handling</div>
        <div className="field">
          <label className="field__label" htmlFor="settings-momentum-scheme">
            Momentum-flux scheme
          </label>
          <select
            id="settings-momentum-scheme"
            data-testid="settings-momentum-scheme"
            className="select"
            disabled={!momentumFlux}
            value={scheme}
            onChange={(e) =>
              updateSettings({
                momentumFluxScheme:
                  e.target.value === "central" ? "central" : undefined,
              })
            }
          >
            <option value="upwind">Limited upwind (default)</option>
            <option value="central">Central</option>
          </select>
          <div className="field__hint">
            {momentumFlux
              ? "Upwind has no expansion-shock roots by construction and is seed-robust; central is more accurate where it converges to the physical root."
              : "Enable Momentum flux to choose a scheme — it has no effect otherwise."}
          </div>
        </div>
        <label className="field__label check-label">
          <input
            type="checkbox"
            data-testid="settings-transonic-admissibility"
            disabled={!auditApplies}
            checked={settings.transonicAdmissibility ?? true}
            onChange={(e) =>
              updateSettings({
                // Default is ON, so only the opt-out is worth persisting.
                transonicAdmissibility: e.target.checked ? undefined : false,
              })
            }
          />
          Second-law admissibility audit
        </label>
        <div className="field__hint">
          {auditApplies
            ? "Audits every converged ideal-gas branch and re-seeds off an entropy-violating root. A clean residual is not by itself evidence of a physical answer here — leave this on."
            : "Applies to steady solves using Momentum flux with the central scheme. No effect in the current configuration."}
        </div>
      </div>

      <ClosureParamsSection config={config} />
    </div>
  );
}

/** Published closure constants, per correlation group. Placeholders show the
 *  default so an empty field reads as "published value", and clearing a field
 *  deletes the key rather than writing the default back — a config with no
 *  `closureParams` must stay bit-identical to one that specifies only
 *  defaults. */
const CLOSURE_GROUPS: {
  group: Exclude<ClosureParamGroup, "solidCpScale">;
  title: string;
  note: string;
  keys: { key: string; label: string; step: number }[];
}[] = [
  {
    group: "dittusBoelter",
    title: "Dittus–Boelter",
    note: "Nu = C·Re^m·Pr^n single-phase forced convection.",
    keys: [
      {
        key: "leadingCoefficient",
        label: "Leading coefficient C",
        step: 0.001,
      },
      { key: "reynoldsExponent", label: "Reynolds exponent m", step: 0.01 },
      { key: "prandtlExponent", label: "Prandtl exponent n", step: 0.01 },
    ],
  },
  {
    group: "miropolskii",
    title: "Miropolskii",
    note: "Dispersed-flow film boiling (cryogenic chilldown).",
    keys: [
      { key: "leadingCoefficient", label: "Leading coefficient", step: 0.001 },
      { key: "reynoldsExponent", label: "Reynolds exponent", step: 0.01 },
      { key: "prandtlExponent", label: "Prandtl exponent", step: 0.01 },
      { key: "yCoefficient", label: "Y coefficient", step: 0.01 },
      { key: "yDensityExponent", label: "Y density exponent", step: 0.01 },
      { key: "yQualityExponent", label: "Y quality exponent", step: 0.01 },
    ],
  },
  {
    group: "swameeJain",
    title: "Swamee–Jain",
    note: "Explicit Colebrook–White approximation for the Darcy factor.",
    keys: [
      { key: "leadingCoefficient", label: "Leading coefficient", step: 0.01 },
      { key: "roughnessDivisor", label: "Roughness divisor", step: 0.1 },
      { key: "reynoldsCoefficient", label: "Reynolds coefficient", step: 0.01 },
      { key: "reynoldsExponent", label: "Reynolds exponent", step: 0.01 },
    ],
  },
];

function ClosureParamsSection({
  config,
}: {
  config: import("../../core").NetworkConfig;
}) {
  const setClosureParam = useStore((s) => s.setClosureParam);
  const closure = config.closureParams;
  const overrideCount = closure
    ? CLOSURE_GROUPS.reduce(
        (total, { group }) =>
          total +
          Object.keys(
            (closure[group] as Record<string, number> | undefined) ?? {},
          ).length,
        0,
      ) + (closure.solidCpScale === undefined ? 0 : 1)
    : 0;
  return (
    <div>
      <div className="settings-section-title">Closure calibration</div>
      <div className="field__hint">
        Empirical constants of the physical correlations. Leave a field blank to
        use the published value. Solver numerics are structurally unreachable
        from here.
      </div>
      <details className="settings-disclosure">
        <summary data-testid="settings-closure-toggle">
          {overrideCount === 0
            ? "All published values"
            : `${overrideCount} override${overrideCount === 1 ? "" : "s"}`}
        </summary>
        <div className="settings-disclosure__body">
          {CLOSURE_GROUPS.map(({ group, title, note, keys }) => {
            const members =
              (closure?.[group] as Record<string, number> | undefined) ?? {};
            return (
              <div key={group} className="settings-closure-group">
                <div className="field__label">{title}</div>
                <div className="field__hint">{note}</div>
                {keys.map(({ key, label, step }) => (
                  <NumberField
                    key={key}
                    label={label}
                    unitNote={`default ${formatSig(
                      (
                        DEFAULT_CLOSURE_PARAMS[group] as unknown as Record<
                          string,
                          number
                        >
                      )[key],
                      4,
                    )}`}
                    dataTestId={`closure-${group}-${key}`}
                    step={step}
                    value={members[key]}
                    onChange={(v) => setClosureParam(group, key, v)}
                  />
                ))}
              </div>
            );
          })}
          <div className="settings-closure-group">
            <div className="field__label">Solid heat capacity</div>
            <div className="field__hint">
              A material property, not a closure constant: a uniform multiplier
              on every solid node&apos;s cp (constants and T-curves alike).
            </div>
            <NumberField
              label="cp scale"
              unitNote="default 1"
              dataTestId="closure-solidCpScale"
              step={0.05}
              value={closure?.solidCpScale}
              onChange={(v) => setClosureParam("solidCpScale", null, v)}
            />
          </div>
        </div>
      </details>
    </div>
  );
}

type SpeciesRoster = NonNullable<import("../../core").NetworkConfig["species"]>;
type SpeciesReaction = NonNullable<SpeciesRoster["reactions"]>[number];

/** Per-species arrays that are optional as a whole: present with one entry per
 *  species, or absent. Validation rejects a ragged array, so the UI toggles a
 *  whole column at a time rather than a single cell. */
const OPTIONAL_SPECIES_COLUMNS: {
  key: "cp" | "formationEnthalpy" | "viscosity";
  label: string;
  unitNote: string;
  seed: number;
  step: number;
}[] = [
  {
    key: "cp",
    label: "Specific heat",
    unitNote: "J/kg/K",
    seed: 1000,
    step: 10,
  },
  {
    key: "formationEnthalpy",
    label: "Formation enthalpy",
    unitNote: "J/kg",
    seed: 0,
    step: 1e5,
  },
  {
    key: "viscosity",
    label: "Viscosity",
    unitNote: "Pa·s",
    seed: 1.8e-5,
    step: 1e-6,
  },
];

/** Multi-species transport: the roster, the optional per-species property
 *  columns, and the Arrhenius reaction set. */
function SpeciesTab({
  config,
}: {
  config: import("../../core").NetworkConfig;
}) {
  const updateSpecies = useStore((s) => s.updateSpecies);
  const species = config.species;
  const idealGas = config.fluid.model === "idealGas";
  const multiFluid = Object.keys(config.fluids ?? {}).length > 0;

  if (!species) {
    return (
      <div className="settings-grid">
        <div>
          <div className="settings-section-title">Species transport</div>
          <div className="field__hint">
            Off. The network solves one homogeneous fluid with the
            single-species energy equation.
          </div>
          {!idealGas && (
            <div className="field__error" role="alert">
              Species transport is only supported for the idealGas fluid model;
              the default fluid is currently {config.fluid.model}.
            </div>
          )}
          {multiFluid && (
            <div className="field__error" role="alert">
              Species transport is not supported in multi-fluid networks —
              species is composition within one ideal gas.
            </div>
          )}
          <button
            type="button"
            className="btn btn--sm"
            data-testid="species-enable"
            onClick={() =>
              updateSpecies({
                names: ["N2", "O2"],
                molecularWeights: [0.0280134, 0.0319988],
              })
            }
          >
            + Add species transport
          </button>
        </div>
      </div>
    );
  }

  const commit = (next: SpeciesRoster) => updateSpecies(next);
  const count = species.names.length;

  const setName = (index: number, raw: string) => {
    const name = raw.trim();
    if (!name || species.names[index] === name) return;
    const names = [...species.names];
    const previous = names[index];
    names[index] = name;
    const reactions = species.reactions?.map((rxn) =>
      renameInReaction(rxn, previous, name),
    );
    commit({ ...species, names, ...(reactions ? { reactions } : {}) });
  };

  const setNumeric = (
    key: "molecularWeights" | "cp" | "formationEnthalpy" | "viscosity",
    index: number,
    value: number | undefined,
  ) => {
    const column = species[key];
    if (!column) return;
    const next = [...column];
    // A blank cell would make the column ragged, so hold the previous value.
    next[index] = value ?? next[index];
    commit({ ...species, [key]: next });
  };

  const addSpecies = () => {
    const name = nextSpeciesName(species.names);
    const next: SpeciesRoster = {
      ...species,
      names: [...species.names, name],
      molecularWeights: [...species.molecularWeights, 0.028],
    };
    for (const { key, seed } of OPTIONAL_SPECIES_COLUMNS) {
      if (species[key]) next[key] = [...species[key]!, seed];
    }
    commit(next);
  };

  const removeSpecies = (index: number) => {
    const name = species.names[index];
    if (count === 1) {
      updateSpecies(undefined);
      return;
    }
    const drop = <T,>(list: T[]) => list.filter((_, i) => i !== index);
    const next: SpeciesRoster = {
      ...species,
      names: drop(species.names),
      molecularWeights: drop(species.molecularWeights),
    };
    for (const { key } of OPTIONAL_SPECIES_COLUMNS) {
      if (species[key]) next[key] = drop(species[key]!);
    }
    if (species.reactions) {
      const reactions = species.reactions
        .map((rxn) => withoutSpecies(rxn, name))
        .filter(
          (rxn) =>
            Object.keys(rxn.reactants).length > 0 &&
            Object.keys(rxn.products).length > 0,
        );
      if (reactions.length > 0) next.reactions = reactions;
      else delete next.reactions;
    }
    commit(next);
  };

  const toggleColumn = (key: "cp" | "formationEnthalpy" | "viscosity") => {
    const column = OPTIONAL_SPECIES_COLUMNS.find((c) => c.key === key)!;
    const next = { ...species };
    if (species[key]) delete next[key];
    else next[key] = Array.from({ length: count }, () => column.seed);
    commit(next);
  };

  const setReactions = (reactions: SpeciesReaction[]) => {
    const next = { ...species };
    if (reactions.length > 0) next.reactions = reactions;
    else delete next.reactions;
    commit(next);
  };

  return (
    <div className="settings-grid settings-grid--wide">
      <div>
        <div className="settings-section-title">Species roster</div>
        {!idealGas && (
          <div className="field__error" role="alert">
            Species transport is only supported for the idealGas fluid model;
            the default fluid is currently {config.fluid.model}.
          </div>
        )}
        {multiFluid && (
          <div className="field__error" role="alert">
            Species transport is not supported in multi-fluid networks.
          </div>
        )}
        {config.settings.kineticEnergy && (
          <div className="field__hint">
            With kinetic energy on, species networks keep the segregated
            stagnation-enthalpy update — composition is not a coupled Newton
            unknown.
          </div>
        )}
        <div className="settings-columns-row">
          {OPTIONAL_SPECIES_COLUMNS.map(({ key, label }) => (
            <label key={key} className="field__label check-label">
              <input
                type="checkbox"
                data-testid={`species-column-${key}`}
                checked={!!species[key]}
                onChange={() => toggleColumn(key)}
              />
              {label}
            </label>
          ))}
        </div>
        <table className="species-table" data-testid="species-table">
          <thead>
            <tr>
              <th>Species</th>
              <th>
                MW <span className="field__unit">(kg/mol)</span>
              </th>
              {OPTIONAL_SPECIES_COLUMNS.filter(({ key }) => species[key]).map(
                ({ key, label, unitNote }) => (
                  <th key={key}>
                    {label} <span className="field__unit">({unitNote})</span>
                  </th>
                ),
              )}
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {species.names.map((name, index) => (
              <tr key={`${name}-${index}`}>
                <td>
                  <input
                    className="input"
                    data-testid={`species-name-${index}`}
                    defaultValue={name}
                    key={`name-${name}`}
                    aria-label={`Name of species ${index + 1}`}
                    onBlur={(e) => {
                      setName(index, e.target.value);
                      e.target.value = e.target.value.trim() || name;
                    }}
                  />
                </td>
                <td>
                  <InlineNumberEditor
                    value={species.molecularWeights[index]}
                    label={`Molecular weight of ${name}`}
                    onCommit={(v) => setNumeric("molecularWeights", index, v)}
                  />
                </td>
                {OPTIONAL_SPECIES_COLUMNS.filter(({ key }) => species[key]).map(
                  ({ key, label }) => (
                    <td key={key}>
                      <InlineNumberEditor
                        value={species[key]![index]}
                        label={`${label} of ${name}`}
                        onCommit={(v) => setNumeric(key, index, v)}
                      />
                    </td>
                  ),
                )}
                <td>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    data-testid={`species-remove-${index}`}
                    aria-label={`Remove ${name}`}
                    onClick={() => removeSpecies(index)}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="settings-columns-row">
          <button
            type="button"
            className="btn btn--sm"
            data-testid="species-add"
            onClick={addSpecies}
          >
            + Add species
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            data-testid="species-disable"
            onClick={() => updateSpecies(undefined)}
          >
            Remove species transport
          </button>
        </div>
      </div>

      <ReactionsSection
        names={species.names}
        reactions={species.reactions ?? []}
        onChange={setReactions}
      />
    </div>
  );
}

/** Arrhenius reaction set. Stoichiometry is entered per declared species, so a
 *  reaction can never name a species the roster does not have. */
function ReactionsSection({
  names,
  reactions,
  onChange,
}: {
  names: string[];
  reactions: SpeciesReaction[];
  onChange: (reactions: SpeciesReaction[]) => void;
}) {
  const patch = (index: number, next: SpeciesReaction) =>
    onChange(reactions.map((rxn, i) => (i === index ? next : rxn)));

  const setStoich = (
    index: number,
    side: "reactants" | "products",
    name: string,
    value: number | undefined,
  ) => {
    const rxn = reactions[index];
    const map = { ...rxn[side] };
    if (value === undefined) delete map[name];
    else map[name] = value;
    patch(index, { ...rxn, [side]: map });
  };

  return (
    <div>
      <div className="settings-section-title">Reactions</div>
      <div className="field__hint">
        Arrhenius rate k = A·T^b·exp(−Ea/RT), integrated per node with a stiff
        BDF1 sub-step. Leave a stoichiometry blank when a species does not take
        part.
      </div>
      {reactions.length === 0 && (
        <div className="field__hint" data-testid="reactions-empty">
          No reactions — species are transported without chemistry.
        </div>
      )}
      {reactions.map((rxn, index) => (
        <div
          key={index}
          className="reaction-card"
          data-testid={`reaction-${index}`}
        >
          <div className="reaction-card__header">
            <span className="field__label">
              {reactionLabel(rxn) || `Reaction ${index + 1}`}
            </span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              data-testid={`reaction-remove-${index}`}
              aria-label={`Remove reaction ${index + 1}`}
              onClick={() => onChange(reactions.filter((_, i) => i !== index))}
            >
              ×
            </button>
          </div>
          {(["reactants", "products"] as const).map((side) => (
            <div key={side} className="reaction-card__side">
              <div className="field__label">
                {side === "reactants" ? "Reactants" : "Products"}
              </div>
              <div className="reaction-card__stoich">
                {names.map((name) => (
                  <NumberField
                    key={name}
                    label={name}
                    ariaLabel={`${side === "reactants" ? "Reactant" : "Product"} ${name} in reaction ${index + 1}`}
                    dataTestId={`reaction-${index}-${side}-${name}`}
                    step={1}
                    value={rxn[side][name]}
                    onChange={(v) => setStoich(index, side, name, v)}
                  />
                ))}
              </div>
            </div>
          ))}
          <NumberField
            label="Pre-exponential A"
            dataTestId={`reaction-${index}-A`}
            step={1e6}
            value={rxn.A}
            onChange={(A) => patch(index, { ...rxn, A: A ?? 0 })}
          />
          <NumberField
            label="Temperature exponent b"
            dataTestId={`reaction-${index}-b`}
            step={0.1}
            value={rxn.b}
            onChange={(b) => patch(index, { ...rxn, b: b ?? 0 })}
          />
          <NumberField
            label="Activation energy Ea"
            unitNote="J/mol"
            dataTestId={`reaction-${index}-Ea`}
            step={1000}
            value={rxn.Ea}
            onChange={(Ea) => patch(index, { ...rxn, Ea: Ea ?? 0 })}
          />
          <NumberField
            label="Heat of reaction"
            unitNote="J/kg of mixture, optional"
            dataTestId={`reaction-${index}-heat`}
            step={1e5}
            value={rxn.heatOfReaction}
            onChange={(heatOfReaction) => {
              const next = { ...rxn };
              if (heatOfReaction === undefined) delete next.heatOfReaction;
              else next.heatOfReaction = heatOfReaction;
              patch(index, next);
            }}
          />
        </div>
      ))}
      <button
        type="button"
        className="btn btn--sm"
        data-testid="reaction-add"
        disabled={names.length < 2}
        onClick={() =>
          onChange([
            ...reactions,
            {
              reactants: { [names[0]]: 1 },
              products: { [names[1]]: 1 },
              A: 1e10,
              b: 0,
              Ea: 1e5,
            },
          ])
        }
      >
        + Add reaction
      </button>
      {names.length < 2 && (
        <div className="field__hint">
          A reaction needs at least two species to convert between.
        </div>
      )}
    </div>
  );
}

function reactionLabel(rxn: SpeciesReaction): string {
  const side = (map: Record<string, number>) =>
    Object.entries(map)
      .map(([name, stoich]) => (stoich === 1 ? name : `${stoich} ${name}`))
      .join(" + ");
  const left = side(rxn.reactants);
  const right = side(rxn.products);
  return left && right ? `${left} → ${right}` : "";
}

function renameInReaction(
  rxn: SpeciesReaction,
  from: string,
  to: string,
): SpeciesReaction {
  const rename = (map: Record<string, number>) => {
    if (!(from in map)) return map;
    const next = { ...map };
    next[to] = next[from];
    delete next[from];
    return next;
  };
  return {
    ...rxn,
    reactants: rename(rxn.reactants),
    products: rename(rxn.products),
  };
}

function withoutSpecies(rxn: SpeciesReaction, name: string): SpeciesReaction {
  const drop = (map: Record<string, number>) => {
    if (!(name in map)) return map;
    const next = { ...map };
    delete next[name];
    return next;
  };
  return {
    ...rxn,
    reactants: drop(rxn.reactants),
    products: drop(rxn.products),
  };
}

function nextSpeciesName(existing: string[]): string {
  const taken = new Set(existing);
  for (let i = existing.length + 1; ; i++) {
    const candidate = `S${i}`;
    if (!taken.has(candidate)) return candidate;
  }
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
