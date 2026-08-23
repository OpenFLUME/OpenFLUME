/**
 * MultiPropertyPanel — bulk property editing for a canvas multi-selection of
 * elements (fluid/solid nodes) and ties (branches/conductors).
 *
 * One section per entity kind present in the selection. Every field targets
 * the formula-bindable allowlist (core/formulaFields.ts) plus the type
 * discriminants, mirroring the single-entity PropertyPanel's labels, units
 * and steps. A field whose members disagree shows empty with a "Mixed
 * values" hint; committing a value applies it to every member of the section
 * as exactly ONE undoable edit (store.updateEntities).
 *
 * Deliberately out of scope (single-entity panel only): labels, endpoints,
 * schedules/tables, gas cushion, cp/k property specs, convection correlation
 * models, physical positions.
 */
import React from "react";
import { useStore, type EntityUpdate } from "../store";
import { NetworkConfig, MultiSelectionItem } from "../types";
import FormulaUnitInput from "./FormulaUnitInput";
import { QuantityKind } from "../units";
import { BRANCH_COMPONENTS, migrateComponent } from "../componentRegistry";
import type { BindableValue } from "../formulaBinding";
import { namedFluidNames, defaultFluidLabel } from "../fluidsUi";

type NodeConfig = NetworkConfig["nodes"][number];
type BranchConfig = NetworkConfig["branches"][number];
type SolidNodeConfig = NonNullable<NetworkConfig["solidNodes"]>[number];
type ConductorConfig = NonNullable<NetworkConfig["conductors"]>[number];

/** Same root as PropertyPanel: one complementary landmark either way. */
const PANEL_ROOT_PROPS = {
  className: "property-panel",
  "data-testid": "property-panel",
  role: "complementary",
  "aria-label": "Edit property",
} as const;

interface FieldMeta {
  key: string;
  label: string;
  quantityKind?: QuantityKind;
  unitNote?: string;
  step: number;
}

const AREA: FieldMeta = {
  key: "area",
  label: "Area",
  quantityKind: "area",
  step: 0.0001,
};
const CD: FieldMeta = {
  key: "cd",
  label: "Cd",
  quantityKind: "dimensionless",
  step: 0.01,
};
const LENGTH: FieldMeta = {
  key: "length",
  label: "Length",
  quantityKind: "length",
  step: 0.1,
};
const DIAMETER: FieldMeta = {
  key: "diameter",
  label: "Diameter",
  quantityKind: "length",
  step: 0.001,
};
const ROUGHNESS: FieldMeta = {
  key: "roughness",
  label: "Roughness",
  quantityKind: "length",
  step: 1e-6,
};
const ELEVATION: FieldMeta = {
  key: "elevationChange",
  label: "Elevation Change",
  quantityKind: "length",
  step: 0.1,
};

/** Bulk-editable fields per component type — the formula-bindable subset
 *  (core/formulaFields.ts BINDABLE_COMPONENT_FIELDS), with the single-entity
 *  panel's labels/units/steps. */
const COMPONENT_FIELDS: Record<string, FieldMeta[]> = {
  pipe: [LENGTH, DIAMETER, ROUGHNESS, ELEVATION],
  heatedPipe: [
    LENGTH,
    DIAMETER,
    ROUGHNESS,
    ELEVATION,
    { key: "ua", label: "UA", unitNote: "W/K", step: 0.1 },
    {
      key: "wallTemperature",
      label: "Wall Temperature",
      quantityKind: "temperature",
      step: 1,
    },
  ],
  bend: [
    DIAMETER,
    { key: "rOverD", label: "R/D", quantityKind: "dimensionless", step: 0.1 },
    ROUGHNESS,
  ],
  orifice: [AREA, CD],
  cavitatingVenturi: [
    {
      key: "throatArea",
      label: "Throat Area",
      quantityKind: "area",
      step: 0.000001,
    },
    CD,
    {
      key: "recoveryFactor",
      label: "Recovery Factor",
      quantityKind: "dimensionless",
      step: 0.05,
    },
  ],
  resistance: [
    { key: "k", label: "K factor", quantityKind: "dimensionless", step: 0.1 },
    AREA,
  ],
  valve: [
    AREA,
    CD,
    {
      key: "position",
      label: "Position",
      quantityKind: "dimensionless",
      step: 0.01,
    },
  ],
  checkValve: [AREA, CD],
  dynamicCheckValve: [
    AREA,
    CD,
    { key: "discArea", label: "Disc Area", quantityKind: "area", step: 0.0001 },
    { key: "mass", label: "Mass", unitNote: "kg", step: 0.001 },
    { key: "springRate", label: "Spring Rate", unitNote: "N/m", step: 10 },
    { key: "preload", label: "Preload", unitNote: "N", step: 1 },
    { key: "damping", label: "Damping", unitNote: "N·s/m", step: 0.1 },
    { key: "stroke", label: "Stroke", quantityKind: "length", step: 0.0001 },
    {
      key: "initialPosition",
      label: "Initial Position",
      quantityKind: "dimensionless",
      step: 0.01,
    },
  ],
  reliefValve: [
    {
      key: "crackPressure",
      label: "Crack Pressure",
      quantityKind: "pressure",
      step: 1000,
    },
    {
      key: "fullOpenPressure",
      label: "Full Open Pressure",
      quantityKind: "pressure",
      step: 1000,
    },
    AREA,
    CD,
  ],
  pump: [],
  areaChange: [
    { key: "areaIn", label: "Area In", quantityKind: "area", step: 0.0001 },
    { key: "areaOut", label: "Area Out", quantityKind: "area", step: 0.0001 },
  ],
  flowSource: [
    {
      key: "massFlow",
      label: "Mass Flow",
      quantityKind: "massFlow",
      step: 0.001,
    },
  ],
  regulator: [
    {
      key: "setPressure",
      label: "Set Pressure",
      quantityKind: "pressure",
      step: 1000,
    },
    { key: "maxCdA", label: "Max CdA", quantityKind: "area", step: 0.0001 },
  ],
  dpTable: [],
  customResistance: [AREA, DIAMETER],
  userComponent: [AREA],
};

/** Convection's h belongs to its heat-transfer model (ConvectionModelEditor);
 *  bulk edit exposes only the geometry shared by every model. */
const CONDUCTOR_FIELDS: Record<string, FieldMeta[]> = {
  conduction: [
    AREA,
    { key: "length", label: "Length", quantityKind: "length", step: 0.001 },
  ],
  convection: [AREA],
  radiation: [
    {
      key: "emissivity",
      label: "Emissivity",
      quantityKind: "dimensionless",
      step: 0.01,
    },
    AREA,
    {
      key: "viewFactor",
      label: "View Factor",
      quantityKind: "dimensionless",
      step: 0.01,
    },
  ],
};

const NODE_FIELDS: FieldMeta[] = [
  { key: "pressure", label: "Pressure", quantityKind: "pressure", step: 1000 },
  {
    key: "temperature",
    label: "Temperature",
    quantityKind: "temperature",
    step: 1,
  },
  { key: "volume", label: "Volume", quantityKind: "volume", step: 0.001 },
  { key: "heatInput", label: "Heat Input", quantityKind: "power", step: 1 },
];

const SOLID_FIELDS: FieldMeta[] = [
  {
    key: "temperature",
    label: "Temperature",
    quantityKind: "temperature",
    step: 1,
  },
  { key: "mass", label: "Mass", unitNote: "kg", step: 0.1 },
  { key: "heatInput", label: "Heat Input", quantityKind: "power", step: 1 },
];

function sameValue(a: BindableValue, b: BindableValue): boolean {
  if (typeof a === "object" && a !== null)
    return typeof b === "object" && b !== null && a.expr === b.expr;
  return a === b;
}

/**
 * One bulk field: shows the shared value when every member agrees, an empty
 * input plus a "Mixed values" hint otherwise. A commit applies to all
 * members; blurring through an untouched mixed/unset field never commits
 * (an empty input would otherwise CLEAR the value on every member).
 */
function MultiFormulaField({
  meta,
  values,
  path,
  dataTestId,
  onCommit,
}: {
  meta: FieldMeta;
  values: BindableValue[];
  /** First member's binding path — powers the ƒ preview when uniform. */
  path: string;
  dataTestId: string;
  onCommit: (v: number | { expr: string } | undefined) => void;
}) {
  const uniform = values.every((v) => sameValue(v, values[0]));
  const value = uniform ? values[0] : undefined;
  return (
    <>
      <FormulaUnitInput
        label={meta.label}
        quantityKind={meta.quantityKind}
        unitNote={meta.unitNote}
        step={meta.step}
        value={value}
        path={path}
        dataTestId={dataTestId}
        onChange={(v) => {
          if (v === undefined && value === undefined) return;
          onCommit(v);
        }}
      />
      {!uniform && (
        <div className="field__hint" data-testid={`${dataTestId}-mixed`}>
          Mixed values — enter a value to apply to all {values.length}.
        </div>
      )}
    </>
  );
}

/** Enum select for a bulk section; disagreement shows a disabled "Mixed"
 *  placeholder until the user picks a value for all members. */
function MixedSelect({
  label,
  value,
  mixed,
  onChange,
  dataTestId,
  children,
}: {
  label: string;
  value: string;
  mixed: boolean;
  onChange: (v: string) => void;
  dataTestId?: string;
  children: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        data-testid={dataTestId}
        className="select"
        value={mixed ? "" : value}
        onChange={(e) => {
          if (e.target.value) onChange(e.target.value);
        }}
      >
        {mixed && (
          <option value="" disabled>
            Mixed
          </option>
        )}
        {children}
      </select>
    </div>
  );
}

export default function MultiPropertyPanel({
  items,
}: {
  items: MultiSelectionItem[];
}) {
  const config = useStore((s) => s.config);
  const updateEntities = useStore((s) => s.updateEntities);

  // Resolve against the live config; entities deleted since selection are dropped.
  const fluidNodes = items.flatMap((i) =>
    i.kind === "node" ? config.nodes.filter((n) => n.id === i.id) : [],
  );
  const solidNodes = items.flatMap((i) =>
    i.kind === "solidNode"
      ? (config.solidNodes ?? []).filter((n) => n.id === i.id)
      : [],
  );
  const branches = items.flatMap((i) =>
    i.kind === "branch" ? config.branches.filter((b) => b.id === i.id) : [],
  );
  const conductors = items.flatMap((i) =>
    i.kind === "conductor"
      ? (config.conductors ?? []).filter((c) => c.id === i.id)
      : [],
  );
  const total =
    fluidNodes.length + solidNodes.length + branches.length + conductors.length;

  if (total === 0) {
    return (
      <div {...PANEL_ROOT_PROPS}>
        <div className="property-panel__empty">
          Select a node, branch, or group to edit properties.
        </div>
      </div>
    );
  }

  const summary = [
    fluidNodes.length
      ? `${fluidNodes.length} node${fluidNodes.length === 1 ? "" : "s"}`
      : null,
    solidNodes.length
      ? `${solidNodes.length} solid node${solidNodes.length === 1 ? "" : "s"}`
      : null,
    branches.length
      ? `${branches.length} branch${branches.length === 1 ? "" : "es"}`
      : null,
    conductors.length
      ? `${conductors.length} conductor${conductors.length === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

  const patchNodes = (patch: Partial<NodeConfig>) =>
    updateEntities(
      fluidNodes.map((n): EntityUpdate => ({ kind: "node", id: n.id, patch })),
    );
  const patchSolidNodes = (patch: Partial<SolidNodeConfig>) =>
    updateEntities(
      solidNodes.map((n): EntityUpdate => ({
        kind: "solidNode",
        id: n.id,
        patch,
      })),
    );
  /** Per-branch merge into its own component object. */
  const patchBranchComponents = (key: string, v: BindableValue) =>
    updateEntities(
      branches.map((b): EntityUpdate => ({
        kind: "branch",
        id: b.id,
        patch: {
          component: {
            ...b.component,
            [key]: v,
          } as BranchConfig["component"],
        },
      })),
    );
  /** Per-conductor merge; an undefined value REMOVES the key (the single-
   *  entity panel's model-switch semantics). */
  const patchConductorTypes = (key: string, v: BindableValue) =>
    updateEntities(
      conductors.map((c): EntityUpdate => {
        const merged: Record<string, unknown> = { ...c.type, [key]: v };
        if (v === undefined) delete merged[key];
        return {
          kind: "conductor",
          id: c.id,
          patch: { type: merged as ConductorConfig["type"] },
        };
      }),
    );

  const nodeType = fluidNodes[0]?.type ?? "internal";
  const nodeTypeMixed = fluidNodes.some((n) => n.type !== nodeType);
  const solidType = solidNodes[0]?.type ?? "solid";
  const solidTypeMixed = solidNodes.some((n) => n.type !== solidType);
  const branchType = branches[0]?.component.type ?? "pipe";
  const branchTypeMixed = branches.some((b) => b.component.type !== branchType);
  const conductorKind = conductors[0]?.type.kind ?? "conduction";
  const conductorKindMixed = conductors.some(
    (c) => c.type.kind !== conductorKind,
  );

  const valueOf = (owner: object, key: string): BindableValue =>
    (owner as Record<string, unknown>)[key] as BindableValue;

  return (
    <div {...PANEL_ROOT_PROPS}>
      <div className="property-panel__title" data-testid="multi-panel-title">
        {total} selected
      </div>
      <div className="property-panel__hint">
        {summary}. Edits apply to every selected entity of the section.
      </div>

      {fluidNodes.length > 0 && (
        <>
          <div className="micro-label property-panel__group">
            Nodes ({fluidNodes.length})
          </div>
          <MixedSelect
            label="Type"
            dataTestId="multi-node-type-select"
            value={nodeType}
            mixed={nodeTypeMixed}
            onChange={(v) => patchNodes({ type: v as NodeConfig["type"] })}
          >
            <option value="internal">Internal</option>
            <option value="boundary">Boundary</option>
          </MixedSelect>
          {namedFluidNames(config).length > 0 && (
            <MixedSelect
              label="Fluid"
              dataTestId="multi-node-fluid-select"
              value={fluidNodes[0].fluid || "__default__"}
              mixed={fluidNodes.some(
                (n) => (n.fluid || "") !== (fluidNodes[0].fluid || ""),
              )}
              onChange={(v) =>
                patchNodes({ fluid: v === "__default__" ? undefined : v })
              }
            >
              <option value="__default__">{defaultFluidLabel(config)}</option>
              {namedFluidNames(config).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </MixedSelect>
          )}
          {NODE_FIELDS.map((meta) => (
            <MultiFormulaField
              key={meta.key}
              meta={meta}
              values={fluidNodes.map((n) => valueOf(n, meta.key))}
              path={`node '${fluidNodes[0].id}'.${meta.key}`}
              dataTestId={`multi-node-${meta.key}`}
              onCommit={(v) =>
                patchNodes({ [meta.key]: v } as Partial<NodeConfig>)
              }
            />
          ))}
        </>
      )}

      {solidNodes.length > 0 && (
        <>
          <div className="micro-label property-panel__group">
            Solid Nodes ({solidNodes.length})
          </div>
          <MixedSelect
            label="Type"
            dataTestId="multi-solid-type-select"
            value={solidType}
            mixed={solidTypeMixed}
            onChange={(v) =>
              patchSolidNodes({ type: v as SolidNodeConfig["type"] })
            }
          >
            <option value="solid">Solid</option>
            <option value="ambient">Ambient</option>
          </MixedSelect>
          {SOLID_FIELDS.map((meta) => (
            <MultiFormulaField
              key={meta.key}
              meta={meta}
              values={solidNodes.map((n) => valueOf(n, meta.key))}
              path={`solid '${solidNodes[0].id}'.${meta.key}`}
              dataTestId={`multi-solid-${meta.key}`}
              onCommit={(v) =>
                patchSolidNodes({ [meta.key]: v } as Partial<SolidNodeConfig>)
              }
            />
          ))}
        </>
      )}

      {branches.length > 0 && (
        <>
          <div className="micro-label property-panel__group">
            Branches ({branches.length})
          </div>
          <MixedSelect
            label="Component Type"
            dataTestId="multi-branch-type-select"
            value={branchType}
            mixed={branchTypeMixed}
            onChange={(v) =>
              updateEntities(
                branches.map((b): EntityUpdate => ({
                  kind: "branch",
                  id: b.id,
                  patch: {
                    component: migrateComponent(
                      v as BranchConfig["component"]["type"],
                      b.component,
                    ),
                  },
                })),
              )
            }
          >
            <optgroup label="Common">
              {BRANCH_COMPONENTS.filter((c) => c.category === "common").map(
                (c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ),
              )}
            </optgroup>
            <optgroup label="Advanced">
              {BRANCH_COMPONENTS.filter((c) => c.category === "advanced").map(
                (c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ),
              )}
            </optgroup>
            <optgroup label="Custom">
              {BRANCH_COMPONENTS.filter((c) => c.category === "custom").map(
                (c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ),
              )}
            </optgroup>
          </MixedSelect>
          {branchTypeMixed ? (
            <div className="property-panel__hint">
              Mixed component types — pick one type to edit shared parameters.
            </div>
          ) : (
            (COMPONENT_FIELDS[branchType] ?? []).map((meta) => (
              <MultiFormulaField
                key={meta.key}
                meta={meta}
                values={branches.map((b) => valueOf(b.component, meta.key))}
                path={`branch '${branches[0].id}'.${meta.key}`}
                dataTestId={`multi-branch-${meta.key}`}
                onCommit={(v) => patchBranchComponents(meta.key, v)}
              />
            ))
          )}
        </>
      )}

      {conductors.length > 0 && (
        <>
          <div className="micro-label property-panel__group">
            Conductors ({conductors.length})
          </div>
          {conductorKindMixed ? (
            <div className="property-panel__hint">
              Mixed conductor kinds — select conductors of one kind to edit
              shared parameters.
            </div>
          ) : (
            <>
              <div className="field__label">Kind: {conductorKind}</div>
              {(CONDUCTOR_FIELDS[conductorKind] ?? []).map((meta) => (
                <MultiFormulaField
                  key={meta.key}
                  meta={meta}
                  values={conductors.map((c) => valueOf(c.type, meta.key))}
                  path={`conductor '${conductors[0].id}'.${meta.key}`}
                  dataTestId={`multi-conductor-${meta.key}`}
                  onCommit={(v) => patchConductorTypes(meta.key, v)}
                />
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
