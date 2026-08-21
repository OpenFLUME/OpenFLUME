/**
 * sweep/targets.ts — sweep-target registry: which fields of a NetworkConfig
 * are sweepable, plus pure resolve/apply functions.
 *
 * Two axis kinds live here:
 *
 *   NUMERIC — the FieldSpec tables below.  They are the SINGLE source of
 *   truth, keyed by the schema's component/conductor discriminated unions
 *   via mapped types: adding a new component type or conductor kind to
 *   core/schema.ts without updating these tables is a compile error, and
 *   listing a field that does not exist on the variant is a compile error.
 *   Only finite scalar numeric fields that actually exist on the config are
 *   enumerated or resolved; arrays/tables (pump curve, dpTable points,
 *   kTable, schedules) and user-component dynamic params are excluded.
 *   Union-typed scalar-or-table fields (`customResistance.k`, conductor
 *   conduction `k`, solid-node `cp`) are numeric-sweepable only when the
 *   current value is a plain finite number (flagged `scalarOnly`).
 *
 *   OPTIONS — the OPTION_* builders below, for the model's categorical
 *   choices: which correlation a convection conductor uses, which registry
 *   material supplies a wall's cp or k, whether a pipe carries fluid
 *   inertia.  These are asked side by side, not over a range.
 *
 * Option applies are allowed to DROP companion fields that the chosen value
 * makes illegal — switching a correlation away from 'custom' removes the
 * custom `expression`/`params` that validate.ts rejects on named models, and
 * switching away from 'ttWf' removes the ttWf-only `fluidFront` gate.
 * Without that, every such variant would be reported invalid for a reason
 * that has nothing to do with the comparison being asked for.  Variant
 * configs are throwaway snapshots, never an edit to the user's model.
 */
import type {
  NetworkConfig,
  Conductor,
  SolidNode,
  SolidPropertySpec,
} from "../../core";
import { isParameterExpression, SOLID_MATERIALS } from "../../core";
import { UNITS, getBaseUnit, type QuantityKind } from "../units";
import { componentLabel, conductorLabel } from "../componentRegistry";
import { materialLabel, specSummaryShort } from "../solidPropertyUi";
import type {
  FluidNodeSweepField,
  NumericSweepDescriptor,
  OptionSweepDescriptor,
  SettingsSweepField,
  SolidNodeOptionField,
  SolidNodeSweepField,
  SweepBounds,
  SweepOption,
  SweepTarget,
  SweepTargetDescriptor,
  SweepValue,
} from "./types";

type Branch = NetworkConfig["branches"][number];
type BranchComponent = Branch["component"];
type BranchComponentType = BranchComponent["type"];
type ConductorType = Conductor["type"];
type ConductorKind = ConductorType["kind"];

/** Static description of one sweepable field. */
interface FieldSpec {
  quantity: QuantityKind;
  bounds?: SweepBounds;
  /** Display-unit override for raw-SI fields whose quantity reports
   *  'dimensionless' (e.g. mass in kg, cp in J/(kg·K)); defaults to the
   *  quantity kind's base-unit symbol. */
  unit?: string;
  /** True when the schema type is `number | <table/material form>`: the
   *  field is sweepable only while its current value is a finite number. */
  scalarOnly?: boolean;
}

const POSITIVE: SweepBounds = { min: 0 }; // strictly > 0 per validate.ts
const NONNEGATIVE: SweepBounds = { min: 0 }; // >= 0 per validate.ts

/* ------------------------------------------------------------------ */
/* Static field tables (exhaustive over the schema unions)             */
/* ------------------------------------------------------------------ */

const SETTINGS_FIELDS: Record<SettingsSweepField, FieldSpec> = {
  dt: { quantity: "time", bounds: POSITIVE },
  endTime: { quantity: "time", bounds: POSITIVE },
  tolerance: { quantity: "dimensionless", bounds: POSITIVE },
  relaxation: { quantity: "dimensionless" },
};

const FLUID_NODE_FIELDS: Record<FluidNodeSweepField, FieldSpec> = {
  pressure: { quantity: "pressure" },
  temperature: { quantity: "temperature" },
  volume: { quantity: "volume", bounds: POSITIVE },
  heatInput: { quantity: "power" },
};

const SOLID_NODE_FIELDS: Record<SolidNodeSweepField, FieldSpec> = {
  temperature: { quantity: "temperature" },
  // No 'mass' QuantityKind exists in units.ts — report dimensionless (raw
  // SI) with a truthful display unit instead of inventing a unit kind.
  mass: { quantity: "dimensionless", unit: "kg", bounds: POSITIVE },
  heatInput: { quantity: "power" },
  cp: { quantity: "specificHeat", bounds: POSITIVE, scalarOnly: true },
};

/**
 * Sweepable scalar fields per branch component variant.  The mapped type
 * ties keys to the schema union: a new variant in core/schema.ts forces an
 * explicit entry here (possibly {}), and unknown field names fail to
 * compile.  {} means "nothing scalar to sweep" (pump curve, dpTable
 * points are tables).
 */
const COMPONENT_FIELDS: {
  [T in BranchComponentType]: {
    [
      F in keyof Extract<BranchComponent, { type: T }> as F extends "type"
        ? never
        : F
    ]?: FieldSpec;
  };
} = {
  pipe: {
    length: { quantity: "length", bounds: POSITIVE },
    diameter: { quantity: "length", bounds: POSITIVE },
    roughness: { quantity: "length", bounds: NONNEGATIVE },
    elevationChange: { quantity: "length" },
    // inertia: boolean — excluded.
  },
  orifice: {
    area: { quantity: "area", bounds: POSITIVE },
    cd: { quantity: "dimensionless", bounds: POSITIVE },
  },
  orificeCompressible: {
    area: { quantity: "area", bounds: POSITIVE },
    cd: { quantity: "dimensionless", bounds: POSITIVE },
  },
  cavitatingVenturi: {
    throatArea: { quantity: "area", bounds: POSITIVE },
    cd: { quantity: "dimensionless", bounds: POSITIVE },
    recoveryFactor: { quantity: "dimensionless" },
  },
  resistance: {
    k: { quantity: "dimensionless", bounds: NONNEGATIVE },
    area: { quantity: "area", bounds: POSITIVE },
  },
  valve: {
    area: { quantity: "area", bounds: POSITIVE },
    cd: { quantity: "dimensionless", bounds: POSITIVE },
    position: { quantity: "dimensionless", bounds: { min: 0, max: 1 } },
    // positionSchedule: array — excluded.
  },
  checkValve: {
    area: { quantity: "area", bounds: POSITIVE },
    cd: { quantity: "dimensionless", bounds: POSITIVE },
  },
  dynamicCheckValve: {
    area: { quantity: "area", bounds: POSITIVE },
    cd: { quantity: "dimensionless", bounds: POSITIVE },
    discArea: { quantity: "area", bounds: POSITIVE },
    // No exact QuantityKind exists for mass/stiffness/damping/force — raw SI
    // (same convention as SOLID_NODE_FIELDS.mass and heatedPipe.ua).
    mass: { quantity: "dimensionless", unit: "kg", bounds: POSITIVE },
    springRate: { quantity: "dimensionless", unit: "N/m", bounds: POSITIVE },
    preload: { quantity: "dimensionless", unit: "N", bounds: NONNEGATIVE },
    damping: { quantity: "dimensionless", unit: "N·s/m", bounds: NONNEGATIVE },
    stroke: { quantity: "length", bounds: POSITIVE },
    initialPosition: { quantity: "dimensionless", bounds: { min: 0, max: 1 } },
  },
  reliefValve: {
    crackPressure: { quantity: "pressure", bounds: NONNEGATIVE },
    fullOpenPressure: { quantity: "pressure", bounds: POSITIVE },
    area: { quantity: "area", bounds: POSITIVE },
    cd: { quantity: "dimensionless", bounds: POSITIVE },
  },
  pump: {
    // curve: Array<[flow, rise]> — tabular, no sweepable scalar.
  },
  bend: {
    diameter: { quantity: "length", bounds: POSITIVE },
    // The schema stores bend angle in degrees (validate.ts: 0 < angle <= 180);
    // units.ts treats 'deg' as the angle base unit, so values stay as stored.
    angle: { quantity: "angle", bounds: { min: 0, max: 180 } },
    rOverD: { quantity: "dimensionless", bounds: NONNEGATIVE },
    roughness: { quantity: "length", bounds: NONNEGATIVE },
  },
  areaChange: {
    areaIn: { quantity: "area", bounds: POSITIVE },
    areaOut: { quantity: "area", bounds: POSITIVE },
  },
  flowSource: {
    massFlow: { quantity: "massFlow" },
    // massFlowSchedule: array — excluded.
  },
  regulator: {
    setPressure: { quantity: "pressure", bounds: POSITIVE },
    maxCdA: { quantity: "area", bounds: POSITIVE },
  },
  heatedPipe: {
    length: { quantity: "length", bounds: POSITIVE },
    diameter: { quantity: "length", bounds: POSITIVE },
    roughness: { quantity: "length", bounds: NONNEGATIVE },
    elevationChange: { quantity: "length" },
    // ua is a W/K conductance — no exact QuantityKind exists; raw SI.
    ua: { quantity: "dimensionless", unit: "W/K", bounds: NONNEGATIVE },
    wallTemperature: { quantity: "temperature" },
    // boilingModel: enum — excluded.
  },
  dpTable: {
    // points: table; extrapolate: enum — no sweepable scalar.
  },
  customResistance: {
    k: { quantity: "dimensionless", bounds: NONNEGATIVE, scalarOnly: true }, // { kTable } form excluded
    area: { quantity: "area", bounds: POSITIVE },
    diameter: { quantity: "length", bounds: POSITIVE },
  },
  userComponent: {
    area: { quantity: "area", bounds: POSITIVE },
    // component: library-name string; params: dynamic user params — excluded.
  },
};

/** Sweepable direct scalar fields per conductor kind (correlation
 *  sub-fields of convection are handled by CORRELATION_FIELDS below). */
const CONDUCTOR_FIELDS: {
  [K in ConductorKind]: {
    [
      F in keyof Extract<ConductorType, { kind: K }> as F extends
        "kind" | "correlation"
        ? never
        : F
    ]?: FieldSpec;
  };
} = {
  conduction: {
    k: { quantity: "thermalConductivity", bounds: POSITIVE, scalarOnly: true }, // table/material forms excluded
    area: { quantity: "area", bounds: POSITIVE },
    length: { quantity: "length", bounds: POSITIVE },
  },
  convection: {
    h: { quantity: "heatTransferCoeff", bounds: POSITIVE },
    area: { quantity: "area", bounds: POSITIVE },
  },
  radiation: {
    emissivity: { quantity: "dimensionless", bounds: { min: 0, max: 1 } },
    area: { quantity: "area", bounds: POSITIVE },
    viewFactor: { quantity: "dimensionless", bounds: { min: 0, max: 1 } },
  },
};

/** Sweepable numeric sub-fields of a convection `correlation` block
 *  (target field path 'correlation.<name>').  `model` (enum) and
 *  `fluidFront` (boolean) are excluded. */
const CORRELATION_FIELDS: Record<string, FieldSpec> = {
  diameter: { quantity: "length", bounds: POSITIVE },
  flowArea: { quantity: "area", bounds: POSITIVE },
  axialPosition: { quantity: "length", bounds: NONNEGATIVE },
  inletLiquidReynolds: { quantity: "dimensionless", bounds: POSITIVE },
  frontEnergyFactor: {
    quantity: "dimensionless",
    bounds: { min: 0.25, max: 4 },
  },
  rewetHysteresisOffsetK: {
    quantity: "temperature",
    bounds: { min: 0, max: 5 },
  },
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Formula-bound fields (core/paramBindings.ts) cannot be sweep targets: a
 * sweep writes literal numbers, and silently overwriting a binding would
 * lose the formula.  Sweeping a literal field that a formula REFERENCES is
 * fine — the binding re-resolves per variant at validate/solve entry.
 */
function formulaBoundError(what: string, value: { expr: string }): string {
  return `${what} is bound to a formula (${JSON.stringify(value.expr)}) — formula-bound fields cannot be swept directly; sweep a referenced literal field instead`;
}

function unitSymbol(spec: FieldSpec): string {
  if (spec.unit !== undefined) return spec.unit;
  return (
    UNITS[spec.quantity].find((d) => d.id === getBaseUnit(spec.quantity))
      ?.symbol ?? "-"
  );
}

function descriptor(
  target: SweepTarget,
  label: string,
  spec: FieldSpec,
  currentValue: number,
): NumericSweepDescriptor {
  return {
    axis: "numeric",
    target,
    label,
    quantity: spec.quantity,
    unit: unitSymbol(spec),
    currentValue,
    ...(spec.bounds ? { bounds: spec.bounds } : {}),
  };
}

function elementName(el: { id: string; label?: string }): string {
  return el.label ?? el.id;
}

/* Element prefixes shared by the listing and resolution paths, so a target
 * reads identically however it was reached. */
function solidNodeName(node: SolidNode): string {
  return `${node.type === "ambient" ? "Ambient node" : "Solid node"} ${elementName(node)}`;
}

function branchName(branch: Branch): string {
  return `${componentLabel(branch.component.type)} ${elementName(branch)}`;
}

function conductorName(conductor: Conductor): string {
  return `${conductorLabel(conductor.type.kind)} ${elementName(conductor)}`;
}

function findBranch(config: NetworkConfig, id: string): Branch | undefined {
  return config.branches.find((b) => b.id === id);
}

function findConductor(
  config: NetworkConfig,
  id: string,
): Conductor | undefined {
  return (config.conductors ?? []).find((c) => c.id === id);
}

function findSolidNode(
  config: NetworkConfig,
  id: string,
): SolidNode | undefined {
  return (config.solidNodes ?? []).find((s) => s.id === id);
}

/** Field spec + current value for a branch component target, or an error. */
function componentField(
  branch: Branch,
  field: string,
): { ok: true; spec: FieldSpec; value: number } | { ok: false; error: string } {
  const comp = branch.component;
  const table = COMPONENT_FIELDS[comp.type] as Record<
    string,
    FieldSpec | undefined
  >;
  const spec = table[field];
  if (!spec) {
    const valid = [
      ...Object.keys(table),
      ...Object.keys(branchOptionAxes(branch)),
    ];
    return {
      ok: false,
      error:
        valid.length > 0
          ? `Branch ${branch.id} (${comp.type}) has no sweepable field ${JSON.stringify(field)} (sweepable: ${valid.join(", ")})`
          : `Branch ${branch.id} (${comp.type}) has no sweepable fields`,
    };
  }
  const value = (comp as unknown as Record<string, unknown>)[field];
  if (isParameterExpression(value)) {
    return {
      ok: false,
      error: formulaBoundError(`Branch ${branch.id} field ${field}`, value),
    };
  }
  if (!isFiniteNumber(value)) {
    return {
      ok: false,
      error: spec.scalarOnly
        ? `Branch ${branch.id} field ${field} is not a plain number (table/material forms are not sweepable)`
        : `Branch ${branch.id} field ${field} is not set to a finite number`,
    };
  }
  return { ok: true, spec, value };
}

/** Field spec + current value for a conductor target, or an error. */
function conductorField(
  conductor: Conductor,
  field: string,
): { ok: true; spec: FieldSpec; value: number } | { ok: false; error: string } {
  const t = conductor.type;
  if (field.startsWith("correlation.")) {
    const sub = field.slice("correlation.".length);
    if (t.kind !== "convection") {
      return {
        ok: false,
        error: `Conductor ${conductor.id} (${t.kind}) has no correlation block`,
      };
    }
    const value = t.correlation?.[sub as keyof typeof t.correlation];
    if (isParameterExpression(value)) {
      return {
        ok: false,
        error: formulaBoundError(
          `Conductor ${conductor.id} correlation field ${sub}`,
          value,
        ),
      };
    }
    const spec = CORRELATION_FIELDS[sub];
    if (!spec) {
      return {
        ok: false,
        error: `Conductor ${conductor.id} correlation has no sweepable field ${JSON.stringify(sub)} (sweepable: ${Object.keys(CORRELATION_FIELDS).join(", ")})`,
      };
    }
    if (!isFiniteNumber(value)) {
      return {
        ok: false,
        error: `Conductor ${conductor.id} correlation field ${sub} is not set to a finite number`,
      };
    }
    return { ok: true, spec, value };
  }
  const table = CONDUCTOR_FIELDS[t.kind] as Record<
    string,
    FieldSpec | undefined
  >;
  const spec = table[field];
  if (!spec) {
    const valid = [
      ...Object.keys(table),
      ...Object.keys(conductorOptionAxes(conductor)),
    ];
    return {
      ok: false,
      error: `Conductor ${conductor.id} (${t.kind}) has no sweepable field ${JSON.stringify(field)} (sweepable: ${valid.join(", ")})`,
    };
  }
  const value = (t as unknown as Record<string, unknown>)[field];
  if (isParameterExpression(value)) {
    return {
      ok: false,
      error: formulaBoundError(
        `Conductor ${conductor.id} field ${field}`,
        value,
      ),
    };
  }
  if (!isFiniteNumber(value)) {
    return {
      ok: false,
      error: spec.scalarOnly
        ? `Conductor ${conductor.id} field ${field} is not a plain number (table/material forms are not sweepable)`
        : `Conductor ${conductor.id} field ${field} is not set to a finite number`,
    };
  }
  return { ok: true, spec, value };
}

/* ------------------------------------------------------------------ */
/* Option (categorical) axes                                           */
/* ------------------------------------------------------------------ */

/** Option id meaning "whatever the model already holds" — the baseline a
 *  material comparison exists to challenge.  Not a registry material name,
 *  so it can never collide with one. */
export const CURRENT_OPTION_ID = "current";

/** One choice, plus how to write it into a cloned config. */
interface OptionChoice extends SweepOption {
  /** Mutates `holder` — an object inside a fresh clone — in place. */
  apply: (holder: Record<string, unknown>) => void;
}

/** A resolved categorical axis: its choices and where they get written. */
interface OptionAxis {
  /** Field label, shown after '· ' in the target label. */
  label: string;
  choices: OptionChoice[];
  /** Id of the choice the config currently holds, when one matches. */
  currentOptionId?: string;
  /** Re-finds the object owning the field inside a cloned config. */
  holder: (config: NetworkConfig) => Record<string, unknown> | undefined;
}

/**
 * The convection correlations, in the schema's declaration order.  Hints
 * state each model's validity envelope and its required companion fields,
 * because those are exactly what decides whether a variant will validate.
 */
const CONVECTION_MODELS: Array<{
  id: "dittusBoelter" | "miropolskii" | "darrHartwig" | "ttWf" | "custom";
  label: string;
  hint: string;
}> = [
  {
    id: "dittusBoelter",
    label: "Dittus–Boelter",
    hint: "single-phase forced convection",
  },
  { id: "miropolskii", label: "Miropolskii", hint: "film boiling" },
  {
    id: "darrHartwig",
    label: "Darr–Hartwig",
    hint: "LH₂ chilldown regime map (NB/TB/FB); needs axialPosition, LH₂ vertical upflow only",
  },
  {
    id: "ttWf",
    label: "Two-temperature / wetted fraction",
    hint: "proposed chilldown closure; needs axialPosition + segmentLength, transient mode, a solid wall",
  },
  {
    id: "custom",
    label: "Specified h equation",
    hint: "the h equation already on this conductor",
  },
];

/** Registry material curves are stated per property; k is missing for some. */
const MATERIAL_PROPERTY_UNIT: Record<"cp" | "k", string> = {
  cp: "J/(kg·K)",
  k: "W/(m·K)",
};

function isMaterialSpec(
  spec: SolidPropertySpec | { expr: string } | undefined,
): spec is { material: string } {
  return typeof spec === "object" && spec !== null && "material" in spec;
}

/**
 * Named-material axis for a solid property (solid-node cp, conduction k).
 * The current value leads the list as an explicit baseline whenever it is
 * not already a registry material: comparing four materials is only
 * meaningful next to the constant they are replacing.
 */
function materialAxis(args: {
  property: "cp" | "k";
  /** Field written on the holder — 'cp' or 'k'. */
  field: "cp" | "k";
  label: string;
  current: SolidPropertySpec | { expr: string } | undefined;
  holder: (config: NetworkConfig) => Record<string, unknown> | undefined;
}): OptionAxis | undefined {
  const { property, field, current } = args;
  const choices: OptionChoice[] = [];

  if (current !== undefined && !isMaterialSpec(current)) {
    const summary =
      typeof current === "number"
        ? `${specSummaryShort(current)} ${MATERIAL_PROPERTY_UNIT[property]}`
        : specSummaryShort(current);
    choices.push({
      id: CURRENT_OPTION_ID,
      label: `Current — ${summary}`,
      hint: "the model as it stands, kept in the comparison",
      apply: (holder) => {
        holder[field] = structuredClone(current);
      },
    });
  }

  for (const [key, material] of Object.entries(SOLID_MATERIALS)) {
    if (property === "k" && !material.kTable) continue;
    const [lo, hi] = material.provenance.validityRangeK;
    choices.push({
      id: key,
      label: materialLabel(key),
      hint: `${property}(T) fit, valid ${lo}–${hi} K (clamped outside)`,
      apply: (holder) => {
        holder[field] = { material: key };
      },
    });
  }

  const currentMaterial = isMaterialSpec(current)
    ? current.material
    : undefined;
  return {
    label: args.label,
    choices,
    holder: args.holder,
    ...(currentMaterial !== undefined && SOLID_MATERIALS[currentMaterial]
      ? { currentOptionId: currentMaterial }
      : {}),
  };
}

/** Two-state axis for an optional flag/enum field: 'off' removes the field
 *  (the schema default), the other id writes `onValue`. */
function toggleAxis(args: {
  label: string;
  field: string;
  offLabel: string;
  offHint?: string;
  onId: string;
  onLabel: string;
  onHint?: string;
  onValue: unknown;
  /** True when the config currently has the field ON. */
  isOn: boolean;
  holder: (config: NetworkConfig) => Record<string, unknown> | undefined;
}): OptionAxis {
  const { field } = args;
  return {
    label: args.label,
    currentOptionId: args.isOn ? args.onId : "off",
    holder: args.holder,
    choices: [
      {
        id: "off",
        label: args.offLabel,
        ...(args.offHint ? { hint: args.offHint } : {}),
        apply: (holder) => {
          delete holder[field];
        },
      },
      {
        id: args.onId,
        label: args.onLabel,
        ...(args.onHint ? { hint: args.onHint } : {}),
        apply: (holder) => {
          holder[field] = args.onValue;
        },
      },
    ],
  };
}

function findClonedBranchComponent(id: string) {
  return (config: NetworkConfig): Record<string, unknown> | undefined =>
    findBranch(config, id)?.component as unknown as
      Record<string, unknown> | undefined;
}

function findClonedConductorType(id: string) {
  return (config: NetworkConfig): Record<string, unknown> | undefined =>
    findConductor(config, id)?.type as unknown as
      Record<string, unknown> | undefined;
}

function findClonedCorrelation(id: string) {
  return (config: NetworkConfig): Record<string, unknown> | undefined => {
    const t = findConductor(config, id)?.type;
    if (!t || t.kind !== "convection") return undefined;
    return t.correlation as unknown as Record<string, unknown> | undefined;
  };
}

/** Categorical axes of one solid node, keyed by target field name. */
function solidNodeOptionAxes(
  node: SolidNode,
): Partial<Record<SolidNodeOptionField, OptionAxis>> {
  // Ambient nodes are infinite reservoirs: no thermal mass, so no cp.
  if (node.type === "ambient") return {};
  const axis = materialAxis({
    property: "cp",
    field: "cp",
    label: "cp material",
    current: node.cp,
    holder: (config) =>
      findSolidNode(config, node.id) as unknown as
        Record<string, unknown> | undefined,
  });
  return axis ? { "cp.material": axis } : {};
}

/** Categorical axes of one branch, keyed by target field name. */
function branchOptionAxes(branch: Branch): Record<string, OptionAxis> {
  const comp = branch.component;
  const holder = findClonedBranchComponent(branch.id);
  switch (comp.type) {
    case "pipe":
      return {
        inertia: toggleAxis({
          label: "fluid inertia",
          field: "inertia",
          offLabel: "Quasi-steady",
          offHint: "no ρL/A dṁ/dt term",
          onId: "on",
          onLabel: "Fluid inertia",
          onHint: "transient momentum storage in the line",
          onValue: true,
          isOn: comp.inertia === true,
          holder,
        }),
      };
    case "heatedPipe":
      return {
        boilingModel: toggleAxis({
          label: "boiling model",
          field: "boilingModel",
          offLabel: "UA·ΔT fallback",
          offHint: "crude two-phase treatment",
          onId: "miropolskii",
          onLabel: "Miropolskii film boiling",
          onHint: "needs the realFluid model to engage",
          onValue: "miropolskii",
          isOn: comp.boilingModel === "miropolskii",
          holder,
        }),
      };
    case "dpTable":
      return {
        extrapolate: {
          label: "extrapolation",
          currentOptionId: comp.extrapolate ?? "clamp",
          holder,
          choices: [
            {
              id: "clamp",
              label: "Clamp",
              hint: "hold the end knot beyond the table",
              apply: (h) => {
                h.extrapolate = "clamp";
              },
            },
            {
              id: "linear",
              label: "Linear",
              hint: "continue the end slope beyond the table",
              apply: (h) => {
                h.extrapolate = "linear";
              },
            },
          ],
        },
      };
    default:
      return {};
  }
}

/** Categorical axes of one conductor, keyed by target field name. */
function conductorOptionAxes(conductor: Conductor): Record<string, OptionAxis> {
  const t = conductor.type;
  if (t.kind === "conduction") {
    const axis = materialAxis({
      property: "k",
      field: "k",
      label: "k material",
      current: t.k,
      holder: findClonedConductorType(conductor.id),
    });
    return axis ? { "k.material": axis } : {};
  }
  if (!t || t.kind !== "convection" || !t.correlation) return {};
  const corr = t.correlation;
  const axes: Record<string, OptionAxis> = {
    "correlation.model": {
      label: "heat-transfer model",
      currentOptionId: corr.model,
      holder: findClonedCorrelation(conductor.id),
      choices: CONVECTION_MODELS
        // 'custom' is a correlation the user has to have WRITTEN: offering
        // it without an expression can only produce an invalid variant.
        .filter((m) => m.id !== "custom" || typeof corr.expression === "string")
        .map((m) => ({
          id: m.id,
          label: m.label,
          hint: m.hint,
          apply: (holder) => {
            holder.model = m.id;
            // Companion fields the target model rejects (validate.ts).
            if (m.id !== "custom") {
              delete holder.expression;
              delete holder.params;
            }
            if (m.id !== "ttWf") delete holder.fluidFront;
          },
        })),
    },
  };
  // The front gate is a TT-WF state; it is meaningless on any other model.
  if (corr.model === "ttWf") {
    axes["correlation.fluidFront"] = toggleAxis({
      label: "fluid-front gate",
      field: "fluidFront",
      offLabel: "Ungated",
      offHint: "dry-side exchange independent of the transported front",
      onId: "on",
      onLabel: "Front-gated dry side",
      onHint: "q_dry scaled by the transported cryogenic fraction",
      onValue: true,
      isOn: corr.fluidFront === true,
      holder: findClonedCorrelation(conductor.id),
    });
  }
  return axes;
}

/** Element id for messages; settings has no element of its own. */
function targetElementId(target: SweepTarget): string {
  return target.kind === "settings" ? "settings" : target.id;
}

/** Every categorical axis of a target's element, keyed by field name. */
function optionAxesFor(
  config: NetworkConfig,
  target: SweepTarget,
): Record<string, OptionAxis> {
  switch (target.kind) {
    case "solidNode": {
      const node = findSolidNode(config, target.id);
      return node ? solidNodeOptionAxes(node) : {};
    }
    case "branch": {
      const branch = findBranch(config, target.id);
      return branch ? branchOptionAxes(branch) : {};
    }
    case "conductor": {
      const conductor = findConductor(config, target.id);
      return conductor ? conductorOptionAxes(conductor) : {};
    }
    default:
      return {};
  }
}

/** Public view of an axis (no apply closures) for a resolved descriptor. */
function optionDescriptor(
  target: SweepTarget,
  elementLabel: string,
  axis: OptionAxis,
): OptionSweepDescriptor {
  return {
    axis: "options",
    target,
    label: `${elementLabel} · ${axis.label}`,
    options: axis.choices.map((c) => ({
      id: c.id,
      label: c.label,
      ...(c.hint ? { hint: c.hint } : {}),
    })),
    ...(axis.currentOptionId !== undefined
      ? { currentOptionId: axis.currentOptionId }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** All currently-sweepable targets of a config — numeric fields holding a
 *  finite scalar, plus the categorical axes of each element — in a stable
 *  order: settings, fluid nodes, solid nodes, branches, conductors, each in
 *  config order, and each element's numeric fields before its option axes. */
export function listSweepTargets(
  config: NetworkConfig,
): SweepTargetDescriptor[] {
  const out: SweepTargetDescriptor[] = [];

  for (const [field, spec] of Object.entries(SETTINGS_FIELDS) as Array<
    [SettingsSweepField, FieldSpec]
  >) {
    const value = config.settings[field];
    if (isFiniteNumber(value)) {
      out.push(
        descriptor(
          { kind: "settings", field },
          `Settings · ${field}`,
          spec,
          value,
        ),
      );
    }
  }

  for (const node of config.nodes) {
    for (const [field, spec] of Object.entries(FLUID_NODE_FIELDS) as Array<
      [FluidNodeSweepField, FieldSpec]
    >) {
      const value = node[field];
      if (isFiniteNumber(value)) {
        out.push(
          descriptor(
            { kind: "node", id: node.id, field },
            `Node ${elementName(node)} · ${field}`,
            spec,
            value,
          ),
        );
      }
    }
  }

  for (const sNode of config.solidNodes ?? []) {
    const name = solidNodeName(sNode);
    for (const [field, spec] of Object.entries(SOLID_NODE_FIELDS) as Array<
      [SolidNodeSweepField, FieldSpec]
    >) {
      // mass/cp are meaningful only for type:'solid' (ambient nodes are
      // infinite reservoirs with no thermal mass).
      if (sNode.type === "ambient" && (field === "mass" || field === "cp"))
        continue;
      const value = sNode[field];
      if (isFiniteNumber(value)) {
        out.push(
          descriptor(
            { kind: "solidNode", id: sNode.id, field },
            `${name} · ${field}`,
            spec,
            value,
          ),
        );
      }
    }
    for (const [field, axis] of Object.entries(
      solidNodeOptionAxes(sNode),
    ) as Array<[SolidNodeOptionField, OptionAxis]>) {
      out.push(
        optionDescriptor(
          { kind: "solidNode", id: sNode.id, field },
          name,
          axis,
        ),
      );
    }
  }

  for (const branch of config.branches) {
    const name = branchName(branch);
    const table = COMPONENT_FIELDS[branch.component.type] as Record<
      string,
      FieldSpec | undefined
    >;
    for (const [field, spec] of Object.entries(table)) {
      if (!spec) continue;
      const value = (branch.component as unknown as Record<string, unknown>)[
        field
      ];
      if (isFiniteNumber(value)) {
        out.push(
          descriptor(
            { kind: "branch", id: branch.id, field },
            `${name} · ${field}`,
            spec,
            value,
          ),
        );
      }
    }
    for (const [field, axis] of Object.entries(branchOptionAxes(branch))) {
      out.push(
        optionDescriptor({ kind: "branch", id: branch.id, field }, name, axis),
      );
    }
  }

  for (const conductor of config.conductors ?? []) {
    const t = conductor.type;
    const name = conductorName(conductor);
    const table = CONDUCTOR_FIELDS[t.kind] as Record<
      string,
      FieldSpec | undefined
    >;
    for (const [field, spec] of Object.entries(table)) {
      if (!spec) continue;
      const value = (t as unknown as Record<string, unknown>)[field];
      if (isFiniteNumber(value)) {
        out.push(
          descriptor(
            { kind: "conductor", id: conductor.id, field },
            `${name} · ${field}`,
            spec,
            value,
          ),
        );
      }
    }
    if (t.kind === "convection" && t.correlation) {
      for (const [sub, spec] of Object.entries(CORRELATION_FIELDS)) {
        const value = t.correlation[sub as keyof typeof t.correlation];
        if (isFiniteNumber(value)) {
          out.push(
            descriptor(
              {
                kind: "conductor",
                id: conductor.id,
                field: `correlation.${sub}`,
              },
              `${name} · correlation.${sub}`,
              spec,
              value,
            ),
          );
        }
      }
    }
    for (const [field, axis] of Object.entries(
      conductorOptionAxes(conductor),
    )) {
      out.push(
        optionDescriptor(
          { kind: "conductor", id: conductor.id, field },
          name,
          axis,
        ),
      );
    }
  }

  return out;
}

export type SweepTargetResolution =
  | { ok: true; descriptor: SweepTargetDescriptor }
  | { ok: false; error: string };

/**
 * Resolve a target against a config.  The element must exist, and the field
 * must either be one of the element's categorical axes or currently hold a
 * finite scalar number.
 */
export function resolveSweepTarget(
  config: NetworkConfig,
  target: SweepTarget,
): SweepTargetResolution {
  if (
    target.kind === "solidNode" ||
    target.kind === "branch" ||
    target.kind === "conductor"
  ) {
    const axis = optionAxesFor(config, target)[target.field];
    if (axis) {
      if (axis.choices.length === 0) {
        return {
          ok: false,
          error: `${target.field} on ${target.id} offers no options in this model`,
        };
      }
      const name =
        target.kind === "solidNode"
          ? solidNodeName(findSolidNode(config, target.id)!)
          : target.kind === "branch"
            ? branchName(findBranch(config, target.id)!)
            : conductorName(findConductor(config, target.id)!);
      return { ok: true, descriptor: optionDescriptor(target, name, axis) };
    }
  }

  switch (target.kind) {
    case "settings": {
      const spec = SETTINGS_FIELDS[target.field];
      if (!spec)
        return {
          ok: false,
          error: `Unknown settings sweep field ${JSON.stringify(target.field)}`,
        };
      const value = config.settings[target.field];
      if (!isFiniteNumber(value)) {
        return {
          ok: false,
          error: `settings.${target.field} is not set to a finite number`,
        };
      }
      return {
        ok: true,
        descriptor: descriptor(
          target,
          `Settings · ${target.field}`,
          spec,
          value,
        ),
      };
    }
    case "node": {
      const node = config.nodes.find((n) => n.id === target.id);
      if (!node)
        return { ok: false, error: `Unknown fluid node: ${target.id}` };
      const spec = FLUID_NODE_FIELDS[target.field];
      if (!spec)
        return {
          ok: false,
          error: `Node ${target.id} has no sweepable field ${JSON.stringify(target.field)}`,
        };
      const value = node[target.field];
      if (isParameterExpression(value)) {
        return {
          ok: false,
          error: formulaBoundError(
            `Node ${target.id} field ${target.field}`,
            value,
          ),
        };
      }
      if (!isFiniteNumber(value)) {
        return {
          ok: false,
          error: `Node ${target.id} field ${target.field} is not set to a finite number`,
        };
      }
      return {
        ok: true,
        descriptor: descriptor(
          target,
          `Node ${elementName(node)} · ${target.field}`,
          spec,
          value,
        ),
      };
    }
    case "solidNode": {
      const sNode = findSolidNode(config, target.id);
      if (!sNode)
        return { ok: false, error: `Unknown solid node: ${target.id}` };
      // Option fields of this node were handled above; anything left must
      // be one of the numeric fields.
      const spec = (SOLID_NODE_FIELDS as Record<string, FieldSpec | undefined>)[
        target.field
      ];
      if (!spec) {
        const valid = [
          ...Object.keys(SOLID_NODE_FIELDS),
          ...Object.keys(solidNodeOptionAxes(sNode)),
        ];
        return {
          ok: false,
          error: `Solid node ${target.id} has no sweepable field ${JSON.stringify(target.field)} (sweepable: ${valid.join(", ")})`,
        };
      }
      if (
        sNode.type === "ambient" &&
        (target.field === "mass" || target.field === "cp")
      ) {
        return {
          ok: false,
          error: `Ambient node ${target.id} has no thermal-mass field ${target.field}`,
        };
      }
      const value = (sNode as unknown as Record<string, unknown>)[target.field];
      if (!isFiniteNumber(value)) {
        return {
          ok: false,
          error:
            target.field === "cp"
              ? `Solid node ${target.id} cp is not a plain number (table/material forms are not sweepable)`
              : `Solid node ${target.id} field ${target.field} is not set to a finite number`,
        };
      }
      return {
        ok: true,
        descriptor: descriptor(
          target,
          `${solidNodeName(sNode)} · ${target.field}`,
          spec,
          value,
        ),
      };
    }
    case "branch": {
      const branch = findBranch(config, target.id);
      if (!branch) return { ok: false, error: `Unknown branch: ${target.id}` };
      const r = componentField(branch, target.field);
      if (!r.ok) return r;
      return {
        ok: true,
        descriptor: descriptor(
          target,
          `${componentLabel(branch.component.type)} ${elementName(branch)} · ${target.field}`,
          r.spec,
          r.value,
        ),
      };
    }
    case "conductor": {
      const conductor = findConductor(config, target.id);
      if (!conductor)
        return { ok: false, error: `Unknown conductor: ${target.id}` };
      const r = conductorField(conductor, target.field);
      if (!r.ok) return r;
      return {
        ok: true,
        descriptor: descriptor(
          target,
          `${conductorLabel(conductor.type.kind)} ${elementName(conductor)} · ${target.field}`,
          r.spec,
          r.value,
        ),
      };
    }
    default: {
      // Exhaustiveness guard: a new SweepTarget kind must be handled above.
      const never: never = target;
      return {
        ok: false,
        error: `Unknown sweep target kind ${JSON.stringify((never as { kind: unknown }).kind)}`,
      };
    }
  }
}

/** Human list of an axis's option ids, for error messages. */
function optionIdList(axis: OptionAxis): string {
  return axis.choices.map((c) => c.id).join(", ");
}

/**
 * Return a deep-new config with exactly the target field set to `value` —
 * a finite SI number for a numeric target, a registry option id for a
 * categorical one.  The input is never mutated and shares no references
 * with the result (structuredClone), so variant snapshots can be
 * deep-frozen safely.  Throws when the target does not currently resolve or
 * the value does not suit its axis — callers handling user input should use
 * resolveSweepTarget / validateSweepDefinition first.
 */
export function applySweepValue(
  config: NetworkConfig,
  target: SweepTarget,
  value: SweepValue,
): NetworkConfig {
  const resolved = resolveSweepTarget(config, target);
  if (!resolved.ok) {
    throw new Error(`applySweepValue: ${resolved.error}`);
  }

  if (resolved.descriptor.axis === "options") {
    const axis = optionAxesFor(config, target)[target.field]!;
    const choice = axis.choices.find((c) => c.id === value);
    if (!choice) {
      throw new Error(
        `applySweepValue: ${JSON.stringify(String(value))} is not an option of ${target.field} (options: ${optionIdList(axis)})`,
      );
    }
    const next = structuredClone(config);
    const holder = axis.holder(next);
    if (!holder) {
      throw new Error(
        `applySweepValue: could not locate ${target.field} on ${targetElementId(target)}`,
      );
    }
    choice.apply(holder);
    return next;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`applySweepValue: value must be finite (got ${value})`);
  }
  const next = structuredClone(config);
  switch (target.kind) {
    case "settings": {
      (next.settings as Record<string, unknown>)[target.field] = value;
      return next;
    }
    case "node": {
      const node = next.nodes.find((n) => n.id === target.id)!;
      (node as unknown as Record<string, unknown>)[target.field] = value;
      return next;
    }
    case "solidNode": {
      const sNode = (next.solidNodes ?? []).find((s) => s.id === target.id)!;
      (sNode as unknown as Record<string, unknown>)[target.field] = value;
      return next;
    }
    case "branch": {
      const branch = next.branches.find((b) => b.id === target.id)!;
      (branch.component as unknown as Record<string, unknown>)[target.field] =
        value;
      return next;
    }
    case "conductor": {
      const conductor = (next.conductors ?? []).find(
        (c) => c.id === target.id,
      )!;
      if (target.field.startsWith("correlation.")) {
        const sub = target.field.slice("correlation.".length);
        const t = conductor.type as Extract<
          ConductorType,
          { kind: "convection" }
        >;
        (t.correlation as unknown as Record<string, unknown>)[sub] = value;
      } else {
        (conductor.type as unknown as Record<string, unknown>)[target.field] =
          value;
      }
      return next;
    }
    default: {
      const never: never = target;
      throw new Error(
        `applySweepValue: unknown target kind ${JSON.stringify((never as { kind: unknown }).kind)}`,
      );
    }
  }
}
