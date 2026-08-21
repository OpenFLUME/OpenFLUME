import React from "react";
import { useStore } from "../store";
import { NetworkConfig } from "../types";
import type {
  CombustionPropellants,
  JunctionConfig,
  PhysicalPosition,
  SolidPropertySpec,
} from "../../core";
import { listCombustionPropellants } from "../../core";
import UnitInput from "./UnitInput";
import NumberField from "./NumberField";
import FormulaUnitInput from "./FormulaUnitInput";
import ConvectionModelEditor from "./ConvectionModelEditor";
import MultiPropertyPanel from "./MultiPropertyPanel";
import ScheduleEditor, { ScheduleRow as ScheduleRowT } from "./ScheduleEditor";
import SolidPropertyField from "./SolidPropertyField";
import { NOTE_MIN_HEIGHT, NOTE_MIN_WIDTH } from "../canvasGeometry";
import { convertToSI, convertFromSI } from "../units";
import { formatWithUnit, formatSig, siNumber } from "../format";
import { resolveSnapshot } from "../colorData";
import { CustomResistance } from "../../core/components";
import { BRANCH_COMPONENTS, migrateComponent } from "../componentRegistry";
import {
  compatibleConductorKinds,
  compatibleConductorNodeIds,
} from "../connectionRules";
import {
  resolveUserComponentDescriptor,
  useComponentLibrary,
} from "../componentLibrary";
import { namedFluidNames, defaultFluidLabel } from "../fluidsUi";

type NodeConfig = NetworkConfig["nodes"][number];
type BranchConfig = NetworkConfig["branches"][number];
type SolidNodeConfig = NonNullable<NetworkConfig["solidNodes"]>[number];
type ConductorConfig = NonNullable<NetworkConfig["conductors"]>[number];
type ScheduleRow = ScheduleRowT;

/** Formula objects are resolved before the numeric NetworkConfig reaches the solver. */
const formulaPatch = <T extends object>(
  patch: Record<string, unknown>,
): Partial<T> => patch as Partial<T>;

/** Mean of the given nodes' current temperatures (fluid + solid), for
 *  seeding T-dependent conduction-k defaults; undefined when none resolve. */
function meanNodeTemperature(
  config: NetworkConfig,
  ids: string[],
): number | undefined {
  const temps: number[] = [];
  for (const id of ids) {
    const t =
      config.nodes.find((n) => n.id === id)?.temperature ??
      (config.solidNodes ?? []).find((n) => n.id === id)?.temperature;
    if (typeof t === "number" && Number.isFinite(t) && t > 0) temps.push(t);
  }
  if (temps.length === 0) return undefined;
  return temps.reduce((a, b) => a + b, 0) / temps.length;
}

/**
 * Root props shared by every selection-state render of the panel: one
 * complementary landmark ("Edit property") no matter which entity form is
 * showing. App unmounts the panel entirely outside the Diagram views, so a
 * hidden panel can never linger in the tab order.
 */
const PANEL_ROOT_PROPS = {
  className: "property-panel",
  "data-testid": "property-panel",
  role: "complementary",
  "aria-label": "Edit property",
} as const;

function TextInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
}) {
  const id = React.useId();
  const [raw, setRaw] = React.useState(value ?? "");
  const [focused, setFocused] = React.useState(false);

  React.useEffect(() => {
    if (!focused) setRaw(value ?? "");
  }, [value, focused]);

  const commit = () => {
    setFocused(false);
    if (raw !== (value ?? "")) onChange(raw);
  };

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        type="text"
        value={focused ? raw : (value ?? "")}
        onFocus={() => {
          setRaw(value ?? "");
          setFocused(true);
        }}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </div>
  );
}

/**
 * Multi-line prose field (note text).  Same commit-on-blur contract as
 * TextInput so a paragraph costs one undo step, but Enter inserts a newline
 * instead of committing — a note's line breaks are part of its content.
 */
function MultilineInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = React.useId();
  const [raw, setRaw] = React.useState(value);
  const [focused, setFocused] = React.useState(false);

  React.useEffect(() => {
    if (!focused) setRaw(value);
  }, [value, focused]);

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        data-testid="note-text-input"
        className="input property-panel__textarea"
        rows={5}
        value={focused ? raw : value}
        onFocus={() => {
          setRaw(value);
          setFocused(true);
        }}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => {
          setFocused(false);
          if (raw !== value) onChange(raw);
        }}
      />
    </div>
  );
}

/** Plain schematic-coordinate pair (canvas X/Y are NOT physical lengths —
 *  they must never go through the unit system). Both share one row: two
 *  three-digit numbers do not each need a full-width input of their own. */
function PositionFields({
  x,
  y,
  onChangeX,
  onChangeY,
}: {
  x: number;
  y: number;
  onChangeX: (v: number) => void;
  onChangeY: (v: number) => void;
}) {
  return (
    <div className="field-row">
      <NumberField
        label="X"
        value={x}
        step={1}
        onChange={(v) => onChangeX(v ?? 0)}
      />
      <NumberField
        label="Y"
        value={y}
        step={1}
        onChange={(v) => onChangeY(v ?? 0)}
      />
    </div>
  );
}

function patchPhysicalAxis(
  current: PhysicalPosition | undefined,
  axis: keyof PhysicalPosition,
  value: number | { expr: string } | undefined,
): PhysicalPosition | undefined {
  const next: PhysicalPosition = { ...current };
  if (
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "object" && typeof value.expr === "string")
  ) {
    next[axis] = value;
  } else delete next[axis];
  if (next.x === undefined && next.y === undefined && next.z === undefined)
    return undefined;
  return next;
}

function PhysicalPositionFields({
  id,
  kind,
  position,
  onChange,
}: {
  id: string;
  kind: "node" | "solid";
  position: PhysicalPosition | undefined;
  onChange: (next: PhysicalPosition | undefined) => void;
}) {
  const prefix = kind === "node" ? `node '${id}'` : `solid '${id}'`;
  return (
    <>
      <div className="micro-label property-panel__group">Position (m)</div>
      <FormulaUnitInput
        label="X"
        quantityKind="length"
        value={position?.x}
        step={0.1}
        path={`${prefix}.position.x`}
        requirePositive={false}
        dataTestId={`${kind}-position-x`}
        onChange={(v) => onChange(patchPhysicalAxis(position, "x", v))}
      />
      <FormulaUnitInput
        label="Y"
        quantityKind="length"
        value={position?.y}
        step={0.1}
        path={`${prefix}.position.y`}
        requirePositive={false}
        dataTestId={`${kind}-position-y`}
        onChange={(v) => onChange(patchPhysicalAxis(position, "y", v))}
      />
      <FormulaUnitInput
        label="Z"
        quantityKind="length"
        value={position?.z}
        step={0.1}
        path={`${prefix}.position.z`}
        requirePositive={false}
        dataTestId={`${kind}-position-z`}
        onChange={(v) => onChange(patchPhysicalAxis(position, "z", v))}
      />
    </>
  );
}

function NodeDropdown({
  label,
  value,
  onChange,
  config,
  excludeId,
  dataTestId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  config: NetworkConfig;
  excludeId?: string;
  dataTestId?: string;
}) {
  const id = React.useId();
  const groups = config.groups ?? [];
  const groupedNodes = new Map<string | undefined, NodeConfig[]>();
  for (const n of config.nodes) {
    if (n.id === excludeId) continue;
    const g = n.group;
    if (!groupedNodes.has(g)) groupedNodes.set(g, []);
    groupedNodes.get(g)!.push(n);
  }
  const noneList = groupedNodes.get(undefined) ?? [];
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        data-testid={dataTestId}
        className="select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <optgroup label="Ungrouped">
          {noneList.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label || n.id}
            </option>
          ))}
        </optgroup>
        {groups.map((g) => (
          <optgroup key={g.id} label={g.label || g.id}>
            {(groupedNodes.get(g.id) ?? []).map((n) => (
              <option key={n.id} value={n.id}>
                {n.label || n.id}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

function AllNodeDropdown({
  label,
  value,
  onChange,
  config,
  excludeId,
  dataTestId,
  allowedIds,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  config: NetworkConfig;
  excludeId?: string;
  dataTestId?: string;
  allowedIds?: Set<string>;
}) {
  const id = React.useId();
  const groups = config.groups ?? [];
  const allEntries: Array<{
    id: string;
    label?: string;
    group?: string;
    kind: string;
  }> = [
    ...config.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      group: n.group,
      kind: "fluid",
    })),
    ...(config.solidNodes ?? []).map((n) => ({
      id: n.id,
      label: n.label,
      group: n.group,
      kind: "solid",
    })),
  ].filter((n) => n.id !== excludeId && (!allowedIds || allowedIds.has(n.id)));

  const grouped = new Map<string | undefined, typeof allEntries>();
  for (const n of allEntries) {
    const g = n.group;
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g)!.push(n);
  }
  const noneList = grouped.get(undefined) ?? [];
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        data-testid={dataTestId}
        className="select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <optgroup label="Ungrouped">
          {noneList.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label || n.id} ({n.kind})
            </option>
          ))}
        </optgroup>
        {groups.map((g) => (
          <optgroup key={g.id} label={g.label || g.id}>
            {(grouped.get(g.id) ?? []).map((n) => (
              <option key={n.id} value={n.id}>
                {n.label || n.id} ({n.kind})
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

function FieldSelect({
  label,
  value,
  onChange,
  dataTestId,
  children,
}: {
  label: string;
  value: string;
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
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </div>
  );
}

/** Roles each thermochemistry model's junction inlets must be mapped to
 *  (validate/junctions.ts rejects a junction missing any of them). */
const JUNCTION_MODEL_ROLES: Record<JunctionConfig["model"]["type"], string[]> =
  {
    ceaTable: ["oxidizer", "fuel"],
  };

/**
 * Reacting-junction editor for an internal fluid node (config.junctions,
 * keyed by junction.node — see core/schema.ts JunctionConfig and
 * docs/combustion.md).  Rendered inside the node PropertyPanel branch as a
 * gas-cushion-style opt-in section: a checkbox declares the node a junction,
 * and the conditional form edits the thermochemistry model, propellants,
 * efficiency, product fluid, and the role of each inbound branch.
 */
function JunctionSection({
  node,
  config,
}: {
  node: NodeConfig;
  config: NetworkConfig;
}) {
  const upsertJunction = useStore((s) => s.upsertJunction);
  const removeJunction = useStore((s) => s.removeJunction);
  const junction = (config.junctions ?? []).find((j) => j.node === node.id);
  // Junction inlets must END at the junction node (validate/junctions.ts),
  // so only inbound branches are role candidates.
  const inbound = config.branches.filter((b) => b.to === node.id);
  const propellantChoices = listCombustionPropellants();
  // The product fluid must be a NAMED idealGas entry — its params are
  // rewritten from the thermochemistry lookup between outer iterations.
  const productFluidChoices = Object.entries(config.fluids ?? {})
    .filter(([, f]) => f.model === "idealGas")
    .map(([name]) => name);

  const commit = (patch: Partial<JunctionConfig>) => {
    if (junction) upsertJunction({ ...junction, ...patch });
  };
  const roles = junction
    ? JUNCTION_MODEL_ROLES[junction.model.type]
    : JUNCTION_MODEL_ROLES.ceaTable;
  const setRole = (branchId: string, role: string) => {
    if (!junction) return;
    const inlets = junction.inlets.filter((i) => i.branch !== branchId);
    if (role !== "") inlets.push({ branch: branchId, role });
    commit({ inlets });
  };

  // productFluid is REQUIRED (schema) — without a named idealGas fluid to
  // point it at, a junction cannot be validly declared at all.
  const canCreate = productFluidChoices.length > 0;

  return (
    <>
      <div className="field">
        <label className="field__label check-label">
          <input
            type="checkbox"
            data-testid="node-junction-toggle"
            checked={junction !== undefined}
            disabled={junction === undefined && !canCreate}
            onChange={(e) => {
              if (e.target.checked) {
                const taken = new Set(
                  (config.junctions ?? []).map((j) => j.id),
                );
                let jid = `${node.id}Combustor`;
                for (let n = 2; taken.has(jid); n++)
                  jid = `${node.id}Combustor${n}`;
                upsertJunction({
                  id: jid,
                  node: node.id,
                  // Left for the user: which feed branch carries which role.
                  inlets: [],
                  model: {
                    type: "ceaTable",
                    propellants:
                      propellantChoices[0] as CombustionPropellants,
                  },
                  productFluid:
                    node.fluid && productFluidChoices.includes(node.fluid)
                      ? node.fluid
                      : productFluidChoices[0],
                });
              } else {
                removeJunction(node.id);
              }
            }}
            style={{ cursor: "pointer" }}
          />
          Reacting junction (combustor)
        </label>
      </div>
      {!junction && !canCreate && (
        <div className="property-panel__hint">
          Requires a named idealGas fluid to act as the combustion product
          (its R/γ/μ/cp are rewritten from the thermochemistry lookup). Add
          one under Settings → Fluids first.
        </div>
      )}
      {junction && (
        <>
          <TextInput
            label="Junction Label"
            value={junction.label}
            onChange={(v) => commit({ label: v })}
          />
          <FieldSelect
            label="Thermochemistry Model"
            dataTestId="junction-model-select"
            value={junction.model.type}
            onChange={() => {
              /* single model type in v1 — nothing to switch to */
            }}
          >
            <option value="ceaTable">NASA CEA equilibrium table</option>
          </FieldSelect>
          <FieldSelect
            label="Propellants"
            dataTestId="junction-propellants-select"
            value={junction.model.propellants}
            onChange={(v) =>
              commit({
                model: {
                  ...junction.model,
                  propellants: v as CombustionPropellants,
                },
              })
            }
          >
            {propellantChoices.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </FieldSelect>
          <NumberField
            label="Efficiency (enthalpy rise, 0–1]"
            dataTestId="junction-efficiency"
            value={junction.model.efficiency}
            step={0.01}
            min={0}
            max={1}
            onChange={(v) =>
              commit({
                model: {
                  ...junction.model,
                  ...(v === undefined
                    ? { efficiency: undefined }
                    : { efficiency: v }),
                },
              })
            }
          />
          <FieldSelect
            label="Product Fluid"
            dataTestId="junction-product-fluid-select"
            value={junction.productFluid}
            onChange={(v) => commit({ productFluid: v })}
          >
            {productFluidChoices.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </FieldSelect>
          <div className="micro-label property-panel__group">
            Inlet Roles
          </div>
          {inbound.length === 0 ? (
            <div className="property-panel__hint">
              No branch ends at this node yet. Draw the reactant feed
              branches into it, then assign each one a role here.
            </div>
          ) : (
            inbound.map((b) => (
              <FieldSelect
                key={b.id}
                label={b.label || b.id}
                dataTestId={`junction-role-${b.id}`}
                value={
                  junction.inlets.find((i) => i.branch === b.id)?.role ?? ""
                }
                onChange={(v) => setRole(b.id, v)}
              >
                <option value="">Not an inlet</option>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </FieldSelect>
            ))
          )}
          <div className="property-panel__hint">
            The node&apos;s energy equation becomes the thermochemical
            closure h = efficiency · h(T0(Pc, O/F)) solved inside the Newton
            system; the product fluid&apos;s gas properties refresh from the
            same lookup. Requires steady mode with kinetic energy enabled,
            and every role above must be covered by at least one inlet.
          </div>
        </>
      )}
    </>
  );
}

/**
 * Read-only view of the `{ kTable }` form of `customResistance.k`.
 *
 * A scalar input cannot represent a Reynolds table, and letting one try was
 * worse than useless: the field rendered blank, so nothing indicated a table
 * was there at all, and any keystroke silently replaced the whole table with a
 * constant — an emptied field wrote `k: 0`, a frictionless branch that
 * validation accepts. So the table gets its own display and collapsing it to a
 * constant is an explicit, labelled action.
 *
 * K is interpolated with the solver's own `CustomResistance.kAtRe`, so the value
 * shown here cannot drift from the one the solve used.
 */
function KTableField({
  branchId,
  table,
  onCollapseToConstant,
}: {
  branchId: string;
  table: Array<[number, number]>;
  onCollapseToConstant: (k: number) => void;
}) {
  const config = useStore((s) => s.config);
  const result = useStore((s) => s.result);
  const liveResult = useStore((s) => s.liveResult);
  const runStatus = useStore((s) => s.runStatus);
  const timeIndex = useStore((s) => s.timeIndex);

  const snapshot = React.useMemo(
    () => resolveSnapshot(config, result, liveResult, runStatus, timeIndex),
    [config, result, liveResult, runStatus, timeIndex],
  );
  const interpolator = React.useMemo(
    () => new CustomResistance({ kTable: table }, 1),
    [table],
  );

  const reMin = table[0][0];
  const reMax = table[table.length - 1][0];
  const re = snapshot.branches[branchId]?.reynolds;
  const solvedRe = re === undefined ? undefined : Math.abs(re);
  // Outside the knots K is held flat, so the friction model is no longer the
  // curve the table describes — worth saying out loud.
  const clamped =
    solvedRe !== undefined && (solvedRe < reMin || solvedRe > reMax);

  return (
    <div className="field">
      <div className="field__label">K factor — K(Re) table</div>
      <div className="property-panel__readout" data-testid="ktable-summary">
        <div className="kv">
          <span className="kv__key">Table</span>
          <span className="kv__value">
            {table.length} points, Re {formatSig(reMin, 3)}–
            {formatSig(reMax, 3)}
          </span>
        </div>
        {solvedRe !== undefined && (
          <div className="kv">
            <span className="kv__key">K at Re {formatSig(solvedRe, 4)}</span>
            <span className="kv__value">
              {formatSig(interpolator.kAtRe(solvedRe), 4)}
              {clamped && (
                <span className="pill pill--warn" style={{ marginLeft: 6 }}>
                  clamped
                </span>
              )}
            </span>
          </div>
        )}
      </div>
      <div className="field__hint">
        Edit the points in the model text view. Replacing the table with a
        constant discards it.
      </div>
      <button
        type="button"
        className="btn btn--sm"
        data-testid="ktable-collapse"
        onClick={() =>
          onCollapseToConstant(
            interpolator.kAtRe(solvedRe ?? (reMin + reMax) / 2),
          )
        }
      >
        Replace with constant K
      </button>
    </div>
  );
}

/**
 * Per-selection results at the current time index (the .property-panel__results
 * slot). Shown only when a result exists; tinted when the config has moved on
 * since the run (resultStale).
 */
function SelectionResults({
  selection,
}: {
  selection: { kind: string; id: string };
}) {
  const config = useStore((s) => s.config);
  const result = useStore((s) => s.result);
  const liveResult = useStore((s) => s.liveResult);
  const runStatus = useStore((s) => s.runStatus);
  const timeIndex = useStore((s) => s.timeIndex);
  const resultStale = useStore((s) => s.resultStale);
  const unitPrefs = useStore((s) => s.unitPreferences);

  const snapshot = React.useMemo(
    () => resolveSnapshot(config, result, liveResult, runStatus, timeIndex),
    [config, result, liveResult, runStatus, timeIndex],
  );

  if (
    !result &&
    !(liveResult && (runStatus === "running" || runStatus === "loadingFluids"))
  )
    return null;

  const rows: Array<[string, string]> = [];
  if (selection.kind === "node") {
    const s = snapshot.nodes[selection.id];
    if (!s || (s.pressure === undefined && s.temperature === undefined))
      return null;
    if (s.pressure !== undefined)
      rows.push([
        "Pressure",
        formatWithUnit(s.pressure, "pressure", unitPrefs, 4),
      ]);
    if (s.temperature !== undefined)
      rows.push([
        "Temperature",
        formatWithUnit(s.temperature, "temperature", unitPrefs, 4),
      ]);
    if (s.density !== undefined)
      rows.push([
        "Density",
        formatWithUnit(s.density, "density", unitPrefs, 4),
      ]);
  } else if (selection.kind === "solidNode") {
    const s = snapshot.solidNodes[selection.id];
    if (!s || s.temperature === undefined) return null;
    rows.push([
      "Temperature",
      formatWithUnit(s.temperature, "temperature", unitPrefs, 4),
    ]);
  } else if (selection.kind === "branch") {
    const s = snapshot.branches[selection.id];
    if (!s || s.mdot === undefined) return null;
    rows.push(["ṁ", formatWithUnit(s.mdot, "massFlow", unitPrefs, 4)]);
    if (s.dP !== undefined)
      rows.push(["ΔP", formatWithUnit(s.dP, "pressure", unitPrefs, 4)]);
    if (s.velocity !== undefined)
      rows.push([
        "Velocity",
        formatWithUnit(s.velocity, "velocity", unitPrefs, 4),
      ]);
    if (s.reynolds !== undefined)
      rows.push([
        "Re",
        formatWithUnit(s.reynolds, "dimensionless", unitPrefs, 4),
      ]);
  } else if (selection.kind === "conductor") {
    const s = snapshot.conductors[selection.id];
    if (!s || s.heatRate === undefined) return null;
    rows.push(["Heat rate", formatWithUnit(s.heatRate, "power", unitPrefs, 4)]);
  } else {
    return null;
  }
  if (rows.length === 0) return null;

  return (
    <div
      className="property-panel__results"
      data-testid="property-panel-results"
    >
      <div className="property-panel__results-head">
        <span className="micro-label">
          Results{timeIndex !== null ? ` @ step ${timeIndex}` : ""}
        </span>
        {resultStale && (
          <span
            className="pill pill--warn"
            data-testid="property-panel-results-stale"
          >
            stale
          </span>
        )}
      </div>
      <div
        className={
          resultStale
            ? "property-panel__readout property-panel__readout--stale"
            : "property-panel__readout"
        }
      >
        {rows.map(([label, value]) => (
          <div key={label} className="kv">
            <span className="kv__key">{label}</span>
            <span className="kv__value">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PropertyPanel() {
  const config = useStore((s) => s.config);
  const selection = useStore((s) => s.selection);
  const updateNode = useStore((s) => s.updateNode);
  const updateBranch = useStore((s) => s.updateBranch);
  const updateSolidNode = useStore((s) => s.updateSolidNode);
  const updateConductor = useStore((s) => s.updateConductor);
  const moveNodesToGroup = useStore((s) => s.moveNodesToGroup);
  const moveSolidNodesToGroup = useStore((s) => s.moveSolidNodesToGroup);
  const openGroupTab = useStore((s) => s.openGroupTab);
  const removeGroup = useStore((s) => s.removeGroup);
  const updateGroup = useStore((s) => s.updateGroup);
  const updateNote = useStore((s) => s.updateNote);
  const removeNote = useStore((s) => s.removeNote);
  const localLibrary = useComponentLibrary();
  const updateEmbeddedComponentFromLocal = useStore(
    (s) => s.updateEmbeddedComponentFromLocal,
  );

  if (selection.kind === "none") {
    return (
      <div {...PANEL_ROOT_PROPS}>
        <div className="property-panel__empty">
          Select a node, branch, or group to edit properties.
        </div>
      </div>
    );
  }

  if (selection.kind === "multi") {
    return <MultiPropertyPanel items={selection.items} />;
  }

  if (selection.kind === "group") {
    const group = config.groups?.find((g) => g.id === selection.id);
    if (!group) return null;
    const members = config.nodes.filter((n) => n.group === group.id);
    return (
      <div {...PANEL_ROOT_PROPS}>
        <div className="property-panel__title">
          Subnetwork: {group.label || group.id}
        </div>
        <TextInput
          label="Label"
          value={group.label}
          onChange={(v) => updateGroup(group.id, { label: v })}
        />
        <PositionFields
          x={group.x}
          y={group.y}
          onChangeX={(v) => updateGroup(group.id, { x: v })}
          onChangeY={(v) => updateGroup(group.id, { y: v })}
        />
        <div className="field__label property-panel__group">
          Members: {members.length}
        </div>
        <button
          data-testid="open-group-tab"
          className="btn btn--sm btn--block"
          style={{ marginBottom: 8 }}
          onClick={() => openGroupTab(group.id)}
        >
          Open Tab
        </button>
        <button
          data-testid="ungroup-button"
          className="btn btn--sm btn--danger btn--block"
          onClick={() => removeGroup(group.id)}
        >
          Ungroup
        </button>
      </div>
    );
  }

  if (selection.kind === "note") {
    const note = config.notes?.find((n) => n.id === selection.id);
    if (!note) return null;
    return (
      <div {...PANEL_ROOT_PROPS}>
        <div className="property-panel__title">Note: {note.id}</div>
        <MultilineInput
          label="Text"
          value={note.text}
          onChange={(v) => updateNote(note.id, { text: v })}
        />
        <PositionFields
          x={note.x}
          y={note.y}
          onChangeX={(v) => updateNote(note.id, { x: v })}
          onChangeY={(v) => updateNote(note.id, { y: v })}
        />
        {/* Keyboard-reachable equivalent of the card's corner handle; blank is
            the auto size, which is also how you get back to it after a drag. */}
        <div className="field-row">
          <NumberField
            label="Width"
            value={note.width}
            step={15}
            min={NOTE_MIN_WIDTH}
            onChange={(v) => updateNote(note.id, { width: v })}
          />
          <NumberField
            label="Height"
            value={note.height}
            step={15}
            min={NOTE_MIN_HEIGHT}
            onChange={(v) => updateNote(note.id, { height: v })}
          />
        </div>
        <div className="property-panel__hint">
          Leave width or height blank to fit the text. Annotation only — notes
          never reach the solver and never affect results.
        </div>
        <button
          data-testid="delete-note-button"
          className="btn btn--sm btn--danger btn--block"
          onClick={() => removeNote(note.id)}
        >
          Delete note
        </button>
      </div>
    );
  }

  if (selection.kind === "node") {
    const node = config.nodes.find((n) => n.id === selection.id);
    if (!node) return null;
    const groups = config.groups ?? [];
    return (
      <div {...PANEL_ROOT_PROPS}>
        <div className="property-panel__title">Node: {node.id}</div>
        <TextInput
          label="Label"
          value={node.label}
          onChange={(v) => updateNode(node.id, { label: v })}
        />
        <FieldSelect
          label="Type"
          dataTestId="node-type-select"
          value={node.type}
          onChange={(v) =>
            updateNode(node.id, { type: v as NodeConfig["type"] })
          }
        >
          <option value="internal">Internal</option>
          <option value="boundary">Boundary</option>
        </FieldSelect>
        <FieldSelect
          label="Subnetwork"
          dataTestId="node-group-select"
          value={node.group || ""}
          onChange={(v) => moveNodesToGroup([node.id], v || undefined)}
        >
          <option value="">None</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label || g.id}
            </option>
          ))}
        </FieldSelect>
        {namedFluidNames(config).length > 0 && (
          <FieldSelect
            label="Fluid"
            dataTestId="node-fluid-select"
            value={node.fluid || ""}
            onChange={(v) => updateNode(node.id, { fluid: v || undefined })}
          >
            <option value="">{defaultFluidLabel(config)}</option>
            {namedFluidNames(config).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </FieldSelect>
        )}
        <PhysicalPositionFields
          id={node.id}
          kind="node"
          position={node.position}
          onChange={(position) =>
            updateNode(node.id, { position, z: undefined })
          }
        />
        <div className="micro-label property-panel__group">Conditions</div>
        <FormulaUnitInput
          label="Pressure"
          quantityKind="pressure"
          value={node.pressure}
          step={1000}
          path={`node '${node.id}'.pressure`}
          onChange={(v) =>
            updateNode(node.id, formulaPatch<NodeConfig>({ pressure: v }))
          }
        />
        <FormulaUnitInput
          label="Temperature"
          quantityKind="temperature"
          value={node.temperature}
          step={1}
          path={`node '${node.id}'.temperature`}
          onChange={(v) =>
            updateNode(node.id, formulaPatch<NodeConfig>({ temperature: v }))
          }
        />
        <FormulaUnitInput
          label="Volume"
          quantityKind="volume"
          value={node.volume}
          step={0.001}
          path={`node '${node.id}'.volume`}
          dataTestId="node-volume"
          onChange={(v) => updateNode(node.id, { volume: v })}
        />
        {node.type === "internal" && (
          <>
            <div className="field">
              <label className="field__label check-label">
                <input
                  type="checkbox"
                  checked={!!node.gasCushion}
                  onChange={(e) => {
                    if (e.target.checked) {
                      updateNode(node.id, {
                        gasCushion: {
                          initialGasVolume: siNumber(node.volume) ?? 0.001,
                          polytropicIndex: 1.03,
                        },
                      });
                    } else {
                      updateNode(node.id, { gasCushion: undefined });
                    }
                  }}
                  style={{ cursor: "pointer" }}
                />
                Trapped gas cushion
              </label>
            </div>
            {(() => {
              const gc = node.gasCushion;
              if (!gc) return null;
              return (
                <>
                  <FormulaUnitInput
                    label="Initial Gas Volume"
                    quantityKind="volume"
                    value={gc.initialGasVolume}
                    step={0.0001}
                    path={`node '${node.id}'.gasCushion.initialGasVolume`}
                    onChange={(v) =>
                      updateNode(
                        node.id,
                        formulaPatch<NodeConfig>({
                          gasCushion: {
                            initialGasVolume: v ?? 0.001,
                            polytropicIndex: gc.polytropicIndex,
                          },
                        }),
                      )
                    }
                  />
                  <FormulaUnitInput
                    label="Polytropic Index (1.0–1.4)"
                    step={0.01}
                    quantityKind="dimensionless"
                    path={`node '${node.id}'.gasCushion.polytropicIndex`}
                    value={gc.polytropicIndex}
                    onChange={(v) =>
                      updateNode(
                        node.id,
                        formulaPatch<NodeConfig>({
                          gasCushion: {
                            initialGasVolume: gc.initialGasVolume,
                            polytropicIndex: v ?? 1.03,
                          },
                        }),
                      )
                    }
                  />
                </>
              );
            })()}
            <JunctionSection node={node} config={config} />
          </>
        )}
        <FormulaUnitInput
          label="Heat Input"
          quantityKind="power"
          value={node.heatInput}
          step={1}
          path={`node '${node.id}'.heatInput`}
          onChange={(v) =>
            updateNode(node.id, formulaPatch<NodeConfig>({ heatInput: v }))
          }
        />
        {node.type === "boundary" && (
          <>
            <div className="field__label property-panel__group">
              Pressure Schedule
            </div>
            <ScheduleEditor
              testid="node-pressure-schedule"
              rows={(node.pressureSchedule as ScheduleRow[]) || []}
              onChange={(rows) =>
                updateNode(node.id, {
                  pressureSchedule: rows as [number, number][],
                })
              }
              leftKind="time"
              rightKind="pressure"
              leftLabel="Time"
              rightLabel="Pressure"
            />
            <div className="field__label property-panel__group">
              Temperature Schedule
            </div>
            <ScheduleEditor
              testid="node-temperature-schedule"
              rows={(node.temperatureSchedule as ScheduleRow[]) || []}
              onChange={(rows) =>
                updateNode(node.id, {
                  temperatureSchedule: rows as [number, number][],
                })
              }
              leftKind="time"
              rightKind="temperature"
              leftLabel="Time"
              rightLabel="Temperature"
            />
          </>
        )}
        <SelectionResults selection={selection} />
      </div>
    );
  }

  if (selection.kind === "solidNode") {
    const node = config.solidNodes?.find((n) => n.id === selection.id);
    if (!node) return null;
    const groups = config.groups ?? [];
    return (
      <div {...PANEL_ROOT_PROPS}>
        <div className="property-panel__title">Solid Node: {node.id}</div>
        <TextInput
          label="Label"
          value={node.label}
          onChange={(v) => updateSolidNode(node.id, { label: v })}
        />
        <FieldSelect
          label="Type"
          dataTestId="solid-node-type-select"
          value={node.type}
          onChange={(v) =>
            updateSolidNode(node.id, { type: v as SolidNodeConfig["type"] })
          }
        >
          <option value="solid">Solid</option>
          <option value="ambient">Ambient</option>
        </FieldSelect>
        <FieldSelect
          label="Subnetwork"
          dataTestId="solid-node-group-select"
          value={node.group || ""}
          onChange={(v) => moveSolidNodesToGroup([node.id], v || undefined)}
        >
          <option value="">None</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label || g.id}
            </option>
          ))}
        </FieldSelect>
        <PhysicalPositionFields
          id={node.id}
          kind="solid"
          position={node.position}
          onChange={(position) => updateSolidNode(node.id, { position })}
        />
        <div className="micro-label property-panel__group">Conditions</div>
        <FormulaUnitInput
          label="Temperature"
          quantityKind="temperature"
          value={node.temperature}
          step={1}
          path={`solid '${node.id}'.temperature`}
          onChange={(v) =>
            updateSolidNode(
              node.id,
              formulaPatch<SolidNodeConfig>({ temperature: v }),
            )
          }
        />
        {node.type === "solid" && (
          <>
            <FormulaUnitInput
              label="Mass"
              unitNote="kg"
              step={0.1}
              value={node.mass}
              path={`solid '${node.id}'.mass`}
              onChange={(v) =>
                updateSolidNode(
                  node.id,
                  formulaPatch<SolidNodeConfig>({ mass: v }),
                )
              }
            />
            <SolidPropertyField
              property="cp"
              spec={node.cp}
              referenceT={
                typeof node.temperature === "number" ? node.temperature : 300
              }
              owner={`Solid node ${node.id}`}
              testid="solid-cp"
              onChange={(cp) =>
                updateSolidNode(node.id, {
                  cp: cp as SolidPropertySpec | undefined,
                })
              }
              renderConstant={(value, commit) => (
                <NumberField
                  label="cp"
                  unitNote="J/kg·K"
                  step={1}
                  value={typeof value === "number" ? value : undefined}
                  onChange={commit}
                />
              )}
            />
          </>
        )}
        <FormulaUnitInput
          label="Heat Input"
          quantityKind="power"
          value={node.heatInput}
          step={1}
          path={`solid '${node.id}'.heatInput`}
          onChange={(v) =>
            updateSolidNode(
              node.id,
              formulaPatch<SolidNodeConfig>({ heatInput: v }),
            )
          }
        />
        {node.type === "ambient" && (
          <>
            <div className="field__label property-panel__group">
              Temperature Schedule
            </div>
            <ScheduleEditor
              testid="ambient-temperature-schedule"
              rows={(node.temperatureSchedule as ScheduleRow[]) || []}
              onChange={(rows) =>
                updateSolidNode(node.id, {
                  temperatureSchedule: rows as [number, number][],
                })
              }
              leftKind="time"
              rightKind="temperature"
              leftLabel="Time"
              rightLabel="Temperature"
            />
          </>
        )}
        <SelectionResults selection={selection} />
      </div>
    );
  }

  if (selection.kind === "conductor") {
    const conductor = config.conductors?.find((c) => c.id === selection.id);
    if (!conductor) return null;
    const comp = conductor.type;
    const allowedFrom = compatibleConductorNodeIds(
      config,
      comp.kind,
      conductor.to,
    );
    const allowedTo = compatibleConductorNodeIds(
      config,
      comp.kind,
      conductor.from,
    );
    const allowedKinds = compatibleConductorKinds(
      config,
      conductor.from,
      conductor.to,
    );

    /** Patch the conductor type; a key set to undefined is REMOVED, so a
     *  heat-transfer model switch can clear the block the previous model
     *  owned instead of merging it back in (ui/convectionModelUi.ts). */
    const updateComp = (patch: Record<string, unknown>) => {
      const merged: Record<string, unknown> = { ...comp, ...patch };
      for (const key of Object.keys(merged)) {
        if (merged[key] === undefined) delete merged[key];
      }
      updateConductor(conductor.id, {
        type: merged as ConductorConfig["type"],
      });
    };

    return (
      <div {...PANEL_ROOT_PROPS}>
        <div className="property-panel__title">Conductor: {conductor.id}</div>
        <TextInput
          label="Label"
          value={conductor.label}
          onChange={(v) => updateConductor(conductor.id, { label: v })}
        />
        <AllNodeDropdown
          label="From"
          value={conductor.from}
          config={config}
          excludeId={conductor.to}
          allowedIds={allowedFrom}
          onChange={(v) => updateConductor(conductor.id, { from: v })}
          dataTestId="conductor-from-select"
        />
        <AllNodeDropdown
          label="To"
          value={conductor.to}
          config={config}
          excludeId={conductor.from}
          allowedIds={allowedTo}
          onChange={(v) => updateConductor(conductor.id, { to: v })}
          dataTestId="conductor-to-select"
        />
        <FieldSelect
          label="Kind"
          dataTestId="conductor-kind-select"
          value={comp.kind}
          onChange={(v) => {
            const kind = v as ConductorConfig["type"]["kind"];
            let newType: ConductorConfig["type"];
            if (kind === "conduction")
              newType = { kind: "conduction", k: 1, area: 0.01, length: 0.1 };
            else if (kind === "convection")
              newType = { kind: "convection", h: 100, area: 0.01 };
            else
              newType = {
                kind: "radiation",
                emissivity: 0.8,
                area: 0.01,
                viewFactor: 1,
              };
            updateConductor(conductor.id, { type: newType });
          }}
        >
          <option value="conduction" disabled={!allowedKinds.has("conduction")}>
            Conduction
          </option>
          <option value="convection" disabled={!allowedKinds.has("convection")}>
            Convection
          </option>
          <option value="radiation" disabled={!allowedKinds.has("radiation")}>
            Radiation
          </option>
        </FieldSelect>
        {comp.kind === "conduction" && (
          <>
            <SolidPropertyField
              property="k"
              spec={comp.k}
              referenceT={meanNodeTemperature(config, [
                conductor.from,
                conductor.to,
              ])}
              owner={`Conductor ${conductor.id}`}
              testid="conductor-k"
              onChange={(k) => updateComp({ k })}
              renderConstant={(value, commit) => (
                <FormulaUnitInput
                  label="k"
                  quantityKind="thermalConductivity"
                  value={value}
                  step={0.1}
                  path={`conductor '${conductor.id}'.k`}
                  dataTestId="conductor-k-value"
                  onChange={commit}
                />
              )}
            />
            <FormulaUnitInput
              label="Area"
              quantityKind="area"
              value={comp.area}
              step={0.0001}
              path={`conductor '${conductor.id}'.area`}
              dataTestId="conduction-area"
              onChange={(v) => updateComp({ area: v })}
            />
            <FormulaUnitInput
              label="Length"
              quantityKind="length"
              value={comp.length}
              step={0.001}
              path={`conductor '${conductor.id}'.length`}
              dataTestId="conduction-length"
              onChange={(v) => updateComp({ length: v })}
            />
          </>
        )}
        {comp.kind === "convection" && (
          <ConvectionModelEditor
            conductorId={conductor.id}
            type={comp}
            updateComp={updateComp}
            testid="convection"
          />
        )}
        {comp.kind === "radiation" && (
          <>
            <FormulaUnitInput
              label="Emissivity"
              quantityKind="dimensionless"
              value={comp.emissivity}
              step={0.01}
              path={`conductor '${conductor.id}'.emissivity`}
              onChange={(v) => updateComp({ emissivity: v })}
            />
            <FormulaUnitInput
              label="Area"
              quantityKind="area"
              value={comp.area}
              step={0.0001}
              path={`conductor '${conductor.id}'.area`}
              dataTestId="radiation-area"
              onChange={(v) => updateComp({ area: v })}
            />
            <FormulaUnitInput
              label="View Factor"
              quantityKind="dimensionless"
              value={comp.viewFactor}
              step={0.01}
              path={`conductor '${conductor.id}'.viewFactor`}
              onChange={(v) => updateComp({ viewFactor: v })}
            />
          </>
        )}
        <SelectionResults selection={selection} />
      </div>
    );
  }

  const branch = config.branches.find((b) => b.id === selection.id);
  if (!branch) return null;

  const comp = branch.component;

  const updateComp = (patch: Record<string, unknown>) => {
    updateBranch(branch.id, {
      component: { ...comp, ...patch } as BranchConfig["component"],
    });
  };

  // Registry-driven: defaults come from componentRegistry and compatible
  // params (same key, same JS type) survive the type switch.
  const setType = (type: BranchConfig["component"]["type"]) => {
    updateBranch(branch.id, { component: migrateComponent(type, comp) });
  };

  const userDescriptor =
    comp.type === "userComponent"
      ? resolveUserComponentDescriptor(
          comp.component,
          config.componentLibrary,
          localLibrary.components,
        )
      : undefined;

  return (
    <div {...PANEL_ROOT_PROPS}>
      <div className="property-panel__title">Branch: {branch.id}</div>
      <TextInput
        label="Label"
        value={branch.label}
        onChange={(v) => updateBranch(branch.id, { label: v })}
      />
      <NodeDropdown
        label="From"
        value={branch.from}
        config={config}
        excludeId={branch.to}
        onChange={(v) => updateBranch(branch.id, { from: v })}
        dataTestId="branch-from-select"
      />
      <NodeDropdown
        label="To"
        value={branch.to}
        config={config}
        excludeId={branch.from}
        onChange={(v) => updateBranch(branch.id, { to: v })}
        dataTestId="branch-to-select"
      />
      <FieldSelect
        label="Component Type"
        dataTestId="branch-type-select"
        value={comp.type}
        onChange={(v) => setType(v as BranchConfig["component"]["type"])}
      >
        <optgroup label="Common">
          {BRANCH_COMPONENTS.filter((c) => c.category === "common").map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
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
          {BRANCH_COMPONENTS.filter((c) => c.category === "custom").map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </optgroup>
      </FieldSelect>
      {comp.type === "pipe" && (
        <>
          <FormulaUnitInput
            label="Length"
            quantityKind="length"
            value={comp.length}
            step={0.1}
            path={`branch '${branch.id}'.length`}
            dataTestId="pipe-length"
            onChange={(v) => updateComp({ length: v })}
          />
          <FormulaUnitInput
            label="Diameter"
            quantityKind="length"
            value={comp.diameter}
            step={0.001}
            path={`branch '${branch.id}'.diameter`}
            dataTestId="pipe-diameter"
            onChange={(v) => updateComp({ diameter: v })}
          />
          <FormulaUnitInput
            label="Roughness"
            quantityKind="length"
            value={comp.roughness}
            step={1e-6}
            path={`branch '${branch.id}'.roughness`}
            onChange={(v) => updateComp({ roughness: v })}
          />
          <FormulaUnitInput
            label="Elevation Change"
            quantityKind="length"
            value={comp.elevationChange}
            step={0.1}
            path={`branch '${branch.id}'.elevationChange`}
            onChange={(v) => updateComp({ elevationChange: v })}
          />
          <div className="field">
            <label className="field__label check-label">
              <input
                type="checkbox"
                checked={!!comp.inertia}
                onChange={(e) => updateComp({ inertia: e.target.checked })}
                style={{ cursor: "pointer" }}
              />
              Include fluid inertia
            </label>
          </div>
        </>
      )}
      {comp.type === "orifice" && (
        <>
          <FormulaUnitInput
            label="Area"
            quantityKind="area"
            value={comp.area}
            step={0.0001}
            path={`branch '${branch.id}'.area`}
            onChange={(v) => updateComp({ area: v })}
          />
          <FormulaUnitInput
            label="Discharge Coeff"
            quantityKind="dimensionless"
            value={comp.cd}
            step={0.01}
            path={`branch '${branch.id}'.cd`}
            onChange={(v) => updateComp({ cd: v })}
          />
        </>
      )}
      {comp.type === "orificeCompressible" && (
        <>
          <FormulaUnitInput
            label="Area"
            quantityKind="area"
            value={comp.area}
            step={0.0001}
            path={`branch '${branch.id}'.area`}
            onChange={(v) => updateComp({ area: v })}
          />
          <FormulaUnitInput
            label="Discharge Coeff"
            quantityKind="dimensionless"
            value={comp.cd}
            step={0.01}
            path={`branch '${branch.id}'.cd`}
            onChange={(v) => updateComp({ cd: v })}
          />
        </>
      )}
      {comp.type === "cavitatingVenturi" && (
        <>
          <FormulaUnitInput
            label="Throat Area"
            quantityKind="area"
            value={comp.throatArea}
            step={0.000001}
            path={`branch '${branch.id}'.throatArea`}
            onChange={(v) => updateComp({ throatArea: v })}
          />
          <FormulaUnitInput
            label="Discharge Coeff"
            quantityKind="dimensionless"
            value={comp.cd}
            step={0.01}
            path={`branch '${branch.id}'.cd`}
            onChange={(v) => updateComp({ cd: v })}
          />
          <FormulaUnitInput
            label="Recovery Factor"
            quantityKind="dimensionless"
            step={0.05}
            path={`branch '${branch.id}'.recoveryFactor`}
            value={comp.recoveryFactor}
            onChange={(v) => updateComp({ recoveryFactor: v })}
          />
        </>
      )}
      {comp.type === "resistance" && (
        <>
          <FormulaUnitInput
            label="K factor"
            quantityKind="dimensionless"
            value={comp.k}
            step={0.1}
            path={`branch '${branch.id}'.k`}
            onChange={(v) => updateComp({ k: v })}
          />
          <FormulaUnitInput
            label="Area"
            quantityKind="area"
            value={comp.area}
            step={0.0001}
            path={`branch '${branch.id}'.area`}
            onChange={(v) => updateComp({ area: v })}
          />
        </>
      )}
      {comp.type === "valve" && (
        <>
          <FormulaUnitInput
            label="Area"
            quantityKind="area"
            value={comp.area}
            step={0.0001}
            path={`branch '${branch.id}'.area`}
            onChange={(v) => updateComp({ area: v })}
          />
          <FormulaUnitInput
            label="Cd"
            quantityKind="dimensionless"
            value={comp.cd}
            step={0.01}
            path={`branch '${branch.id}'.cd`}
            onChange={(v) => updateComp({ cd: v })}
          />
          <FormulaUnitInput
            label="Position"
            quantityKind="dimensionless"
            value={comp.position}
            step={0.01}
            path={`branch '${branch.id}'.position`}
            onChange={(v) => updateComp({ position: v })}
          />
          <div className="field__label property-panel__group">
            Position Schedule
          </div>
          <ScheduleEditor
            testid="valve-position-schedule"
            rows={(comp.positionSchedule as ScheduleRow[]) || []}
            onChange={(rows) =>
              updateComp({ positionSchedule: rows as [number, number][] })
            }
            leftKind="time"
            rightKind="dimensionless"
            leftLabel="Time"
            rightLabel="Position"
          />
        </>
      )}
      {comp.type === "checkValve" && (
        <>
          <FormulaUnitInput
            label="Area"
            quantityKind="area"
            value={comp.area}
            step={0.0001}
            path={`branch '${branch.id}'.area`}
            onChange={(v) => updateComp({ area: v })}
          />
          <FormulaUnitInput
            label="Cd"
            quantityKind="dimensionless"
            value={comp.cd}
            step={0.01}
            path={`branch '${branch.id}'.cd`}
            onChange={(v) => updateComp({ cd: v })}
          />
        </>
      )}
      {comp.type === "dynamicCheckValve" && (
        <>
          <FormulaUnitInput
            label="Area"
            quantityKind="area"
            value={comp.area}
            step={0.0001}
            path={`branch '${branch.id}'.area`}
            onChange={(v) => updateComp({ area: v })}
          />
          <FormulaUnitInput
            label="Cd"
            quantityKind="dimensionless"
            value={comp.cd}
            step={0.01}
            path={`branch '${branch.id}'.cd`}
            onChange={(v) => updateComp({ cd: v })}
          />
          <FormulaUnitInput
            label="Disc Area (defaults to Area)"
            quantityKind="area"
            value={comp.discArea}
            step={0.0001}
            path={`branch '${branch.id}'.discArea`}
            requirePositive={false}
            onChange={(v) => updateComp({ discArea: v })}
          />
          <FormulaUnitInput
            label="Mass"
            unitNote="kg"
            value={comp.mass}
            step={0.001}
            path={`branch '${branch.id}'.mass`}
            onChange={(v) => updateComp({ mass: v })}
          />
          <FormulaUnitInput
            label="Spring Rate"
            unitNote="N/m"
            value={comp.springRate}
            step={10}
            path={`branch '${branch.id}'.springRate`}
            onChange={(v) => updateComp({ springRate: v })}
          />
          <FormulaUnitInput
            label="Preload"
            unitNote="N"
            value={comp.preload}
            step={1}
            path={`branch '${branch.id}'.preload`}
            requirePositive={false}
            onChange={(v) => updateComp({ preload: v })}
          />
          <FormulaUnitInput
            label="Damping"
            unitNote="N·s/m"
            value={comp.damping}
            step={0.1}
            path={`branch '${branch.id}'.damping`}
            requirePositive={false}
            onChange={(v) => updateComp({ damping: v })}
          />
          <FormulaUnitInput
            label="Stroke"
            quantityKind="length"
            value={comp.stroke}
            step={0.0001}
            path={`branch '${branch.id}'.stroke`}
            onChange={(v) => updateComp({ stroke: v })}
          />
          <FormulaUnitInput
            label="Initial Position (0-1)"
            quantityKind="dimensionless"
            value={comp.initialPosition}
            step={0.01}
            path={`branch '${branch.id}'.initialPosition`}
            requirePositive={false}
            onChange={(v) => updateComp({ initialPosition: v })}
          />
        </>
      )}
      {comp.type === "reliefValve" && (
        <>
          <FormulaUnitInput
            label="Crack Pressure"
            quantityKind="pressure"
            value={comp.crackPressure}
            step={1000}
            path={`branch '${branch.id}'.crackPressure`}
            onChange={(v) => updateComp({ crackPressure: v })}
          />
          <FormulaUnitInput
            label="Full Open Pressure"
            quantityKind="pressure"
            value={comp.fullOpenPressure}
            step={1000}
            path={`branch '${branch.id}'.fullOpenPressure`}
            onChange={(v) => updateComp({ fullOpenPressure: v })}
          />
          <FormulaUnitInput
            label="Area"
            quantityKind="area"
            value={comp.area}
            step={0.0001}
            path={`branch '${branch.id}'.area`}
            onChange={(v) => updateComp({ area: v })}
          />
          <FormulaUnitInput
            label="Cd"
            quantityKind="dimensionless"
            value={comp.cd}
            step={0.01}
            path={`branch '${branch.id}'.cd`}
            onChange={(v) => updateComp({ cd: v })}
          />
        </>
      )}
      {comp.type === "pump" && (
        <>
          <div className="field__label" style={{ marginBottom: 4 }}>
            Pump Curve
          </div>
          <ScheduleEditor
            testid="pump-curve"
            rows={(comp.curve as ScheduleRow[]) || []}
            onChange={(rows) =>
              updateComp({ curve: rows as [number, number][] })
            }
            leftKind="volumetricFlow"
            rightKind="pressure"
            leftLabel="Flow"
            rightLabel="ΔP rise"
          />
        </>
      )}
      {comp.type === "bend" && (
        <>
          <FormulaUnitInput
            label="Diameter"
            quantityKind="length"
            value={comp.diameter}
            step={0.001}
            path={`branch '${branch.id}'.diameter`}
            onChange={(v) => updateComp({ diameter: v })}
          />
          {/* comp.angle is stored in degrees; convert through the unit system
              exactly once (deg → SI rad for UnitInput, back on commit). */}
          <UnitInput
            label="Angle"
            quantityKind="angle"
            value={convertToSI("angle", comp.angle ?? 90, "deg")}
            step={1}
            onChange={(v) =>
              updateComp({
                angle:
                  v === undefined
                    ? undefined
                    : convertFromSI("angle", v, "deg"),
              })
            }
          />
          <FormulaUnitInput
            label="R/D"
            quantityKind="dimensionless"
            value={comp.rOverD}
            step={0.1}
            path={`branch '${branch.id}'.rOverD`}
            onChange={(v) => updateComp({ rOverD: v })}
          />
          <FormulaUnitInput
            label="Roughness"
            quantityKind="length"
            value={comp.roughness}
            step={1e-6}
            path={`branch '${branch.id}'.roughness`}
            onChange={(v) => updateComp({ roughness: v })}
          />
        </>
      )}
      {comp.type === "areaChange" && (
        <>
          <FormulaUnitInput
            label="Area In"
            quantityKind="area"
            value={comp.areaIn}
            step={0.0001}
            path={`branch '${branch.id}'.areaIn`}
            onChange={(v) => updateComp({ areaIn: v })}
          />
          <FormulaUnitInput
            label="Area Out"
            quantityKind="area"
            value={comp.areaOut}
            step={0.0001}
            path={`branch '${branch.id}'.areaOut`}
            onChange={(v) => updateComp({ areaOut: v })}
          />
        </>
      )}
      {comp.type === "flowSource" && (
        <>
          <FormulaUnitInput
            label="Mass Flow"
            quantityKind="massFlow"
            value={comp.massFlow}
            step={0.001}
            path={`branch '${branch.id}'.massFlow`}
            onChange={(v) => updateComp({ massFlow: v })}
          />
          <div className="field__label property-panel__group">
            Mass Flow Schedule
          </div>
          <ScheduleEditor
            testid="flow-source-schedule"
            rows={(comp.massFlowSchedule as ScheduleRow[]) || []}
            onChange={(rows) =>
              updateComp({ massFlowSchedule: rows as [number, number][] })
            }
            leftKind="time"
            rightKind="massFlow"
            leftLabel="Time"
            rightLabel="Mass flow"
          />
        </>
      )}
      {comp.type === "regulator" && (
        <>
          <FormulaUnitInput
            label="Set Pressure"
            quantityKind="pressure"
            value={comp.setPressure}
            step={1000}
            path={`branch '${branch.id}'.setPressure`}
            onChange={(v) => updateComp({ setPressure: v })}
          />
          <FormulaUnitInput
            label="Max CdA"
            quantityKind="area"
            value={comp.maxCdA}
            step={0.0001}
            path={`branch '${branch.id}'.maxCdA`}
            onChange={(v) => updateComp({ maxCdA: v })}
          />
        </>
      )}
      {comp.type === "heatedPipe" && (
        <>
          <FormulaUnitInput
            label="Length"
            quantityKind="length"
            value={comp.length}
            step={0.1}
            path={`branch '${branch.id}'.length`}
            dataTestId="heated-pipe-length"
            onChange={(v) => updateComp({ length: v })}
          />
          <FormulaUnitInput
            label="Diameter"
            quantityKind="length"
            value={comp.diameter}
            step={0.001}
            path={`branch '${branch.id}'.diameter`}
            dataTestId="heated-pipe-diameter"
            onChange={(v) => updateComp({ diameter: v })}
          />
          <FormulaUnitInput
            label="Roughness"
            quantityKind="length"
            value={comp.roughness}
            step={1e-6}
            path={`branch '${branch.id}'.roughness`}
            onChange={(v) => updateComp({ roughness: v })}
          />
          <FormulaUnitInput
            label="Elevation Change"
            quantityKind="length"
            value={comp.elevationChange}
            step={0.1}
            path={`branch '${branch.id}'.elevationChange`}
            onChange={(v) => updateComp({ elevationChange: v })}
          />
          <FormulaUnitInput
            label="UA"
            unitNote="W/K"
            step={0.1}
            value={comp.ua}
            path={`branch '${branch.id}'.ua`}
            dataTestId="heated-pipe-ua"
            onChange={(v) => updateComp({ ua: v })}
          />
          <FormulaUnitInput
            label="Wall Temperature"
            quantityKind="temperature"
            value={comp.wallTemperature}
            step={1}
            path={`branch '${branch.id}'.wallTemperature`}
            onChange={(v) => updateComp({ wallTemperature: v })}
          />
        </>
      )}
      {comp.type === "dpTable" && (
        <>
          <div className="field__label" style={{ marginBottom: 4 }}>
            Pressure Drop Curve
          </div>
          <ScheduleEditor
            testid="dp-table-points"
            rows={comp.points as ScheduleRow[]}
            onChange={(rows) =>
              updateComp({ points: rows as [number, number][] })
            }
            leftKind="massFlow"
            rightKind="pressure"
            leftLabel="Mass flow"
            rightLabel="Pressure drop"
          />
          <FieldSelect
            label="Extrapolation"
            value={comp.extrapolate ?? "clamp"}
            onChange={(v) =>
              updateComp({ extrapolate: v as "clamp" | "linear" })
            }
          >
            <option value="clamp">Clamp</option>
            <option value="linear">Linear</option>
          </FieldSelect>
        </>
      )}
      {comp.type === "customResistance" && (
        <>
          {typeof comp.k === "number" ? (
            <UnitInput
              label="K factor"
              quantityKind="dimensionless"
              value={comp.k}
              step={0.1}
              onChange={(v) => updateComp({ k: v ?? 0 })}
            />
          ) : (
            <KTableField
              branchId={branch.id}
              table={comp.k.kTable}
              onCollapseToConstant={(k) => updateComp({ k })}
            />
          )}
          <FormulaUnitInput
            label="Area"
            quantityKind="area"
            value={comp.area}
            step={0.0001}
            path={`branch '${branch.id}'.area`}
            onChange={(v) => updateComp({ area: v ?? 0 })}
          />
          {/* Diameter only matters for the kTable form; it was previously
              text-only — expose it (formula-capable) when present. */}
          {comp.diameter !== undefined && (
            <FormulaUnitInput
              label="Diameter"
              quantityKind="length"
              value={comp.diameter}
              step={0.001}
              path={`branch '${branch.id}'.diameter`}
              onChange={(v) => updateComp({ diameter: v })}
            />
          )}
        </>
      )}
      {comp.type === "userComponent" && (
        <>
          <FieldSelect
            label="Local Component"
            dataTestId="user-component-select"
            value={comp.component}
            onChange={(key) => {
              const local = localLibrary.components.find(
                (component) => component.key === key,
              );
              if (!local) return;
              updateBranch(branch.id, {
                component: {
                  type: "userComponent",
                  component: key,
                  area: comp.area ?? 0.001,
                  params: Object.fromEntries(
                    (local.metadata.params ?? []).map((param) => [
                      param.name,
                      comp.params?.[param.name] ?? param.default,
                    ]),
                  ),
                },
              });
              // The selected source becomes embedded through the same explicit
              // update path used for local drift, preserving all references.
              useStore
                .getState()
                .updateEmbeddedComponentFromLocal(branch.id, local);
            }}
          >
            <option value="">Select a local component</option>
            {localLibrary.components.map((component) => (
              <option
                key={`${component.key}:${component.path}`}
                value={component.key}
              >
                {component.metadata.label || component.key}
              </option>
            ))}
          </FieldSelect>
          {localLibrary.status === "unavailable" && (
            <div className="field__hint">
              Local component library unavailable.
            </div>
          )}
          {userDescriptor?.drift && userDescriptor.local && (
            <div
              className="field__hint"
              data-testid="user-component-drift"
              role="status"
            >
              Embedded component differs from the local library. Existing
              parameters use the embedded source.
              <button
                type="button"
                className="btn btn--sm"
                data-testid="user-component-update-local"
                style={{ marginTop: 6 }}
                onClick={() =>
                  updateEmbeddedComponentFromLocal(
                    branch.id,
                    userDescriptor.local!,
                  )
                }
              >
                Update to local source
              </button>
            </div>
          )}
          {userDescriptor?.error && (
            <div className="field__hint" role="alert">
              Embedded component metadata could not be read:{" "}
              {userDescriptor.error}
            </div>
          )}
          <FormulaUnitInput
            label="Area"
            quantityKind="area"
            value={comp.area}
            step={0.0001}
            path={`branch '${branch.id}'.area`}
            onChange={(v) => updateComp({ area: v })}
          />
          {(userDescriptor?.metadata?.params ?? []).map((param) => (
            <NumberField
              key={param.name}
              label={param.label || param.name}
              unitNote={param.unit}
              value={comp.params?.[param.name] ?? param.default}
              min={param.min}
              max={param.max}
              step={0.1}
              onChange={(value) =>
                updateComp({
                  params: {
                    ...(comp.params ?? {}),
                    [param.name]: value ?? param.default,
                  },
                })
              }
            />
          ))}
        </>
      )}
      <SelectionResults selection={selection} />
    </div>
  );
}
