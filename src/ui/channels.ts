/**
 * Channel data core — Stage 1: headless inventory + resolution.
 *
 * A "channel" is ONE numeric quantity of ONE network element as it appears
 * in a solver result — e.g. the pressure series of node "n1" in a transient
 * run, or the scalar mdot of branch "b1" in a steady run.  This module is the
 * single source of truth for:
 *
 *   - ChannelId             — strongly-typed (entity, id, field) union mirroring
 *                             the SteadyResult / TransientResult schema
 *                             (core/schema.ts).  Non-numeric fields (phase,
 *                             regime, rewetLatched, massFractions, step
 *                             residuals, stats) are deliberately NOT channels.
 *   - channelKey /
 *     parseChannelKey       — reversible, collision-free string encoding of a
 *                             ChannelId: a versioned prefix plus
 *                             base64url(JSON [entity, id, field]).  Element ids
 *                             are arbitrary user text, so the payload is never
 *                             split on separators (no ambiguous dot splitting).
 *   - listChannels          — deterministic inventory of the numeric channels
 *                             ACTUALLY PRESENT in a result (optional fields
 *                             that are absent are skipped).  Element labels
 *                             come from the supplied config snapshot and fall
 *                             back to ids; result elements missing from the
 *                             config are still listed (sorted after the
 *                             config-ordered ones).
 *   - resolveChannel /
 *     resolveChannelAt      — never-throwing accessors with one consistent
 *                             non-finite policy: series are truncated to the
 *                             aligned length of times/values and any
 *                             (time, value) pair with a non-finite member is
 *                             dropped; a non-finite scalar resolves to null.
 *
 * Unit conversion: `quantity` is always a real QuantityKind from ui/units.ts,
 * so every channel is unit-convertible under the user's unit preferences.
 * `rawUnit` remains as the escape hatch for a future quantity with no
 * convertible kind — a channel that sets it reports quantity 'dimensionless' and
 * consumers must display the raw SI value with that suffix rather than
 * converting it.  No field currently needs it.
 *
 * Signing: quantities that encode a direction are marked `signed: true` —
 * mdot / velocity / volumetricFlow / massFlux (flow direction), dP, and
 * heatRate / heatFlux (heat-transfer direction).  Magnitudes such as
 * dynamic pressure, Reynolds and Mach are unsigned.
 */

import type {
  NetworkConfig,
  SteadyResult,
  TransientResult,
  Selection,
} from "./types";
import type { QuantityKind } from "./units";

/* ------------------------------------------------------------------ */
/* Channel identity                                                    */
/* ------------------------------------------------------------------ */

export type ChannelEntityKind = "node" | "branch" | "solidNode" | "conductor";

/**
 * Numeric per-node fields of SteadyResult.nodes / TransientResult.nodes,
 * plus the transient fluid-front fraction keyed by node id in
 * TransientResult.fluidFront.  `phase` (string) and `massFractions`
 * (per-species record) are not scalar channels and are excluded.
 */
export type NodeChannelField =
  | "pressure"
  | "temperature"
  | "density"
  | "enthalpy"
  | "internalEnergy"
  | "entropy"
  | "specificHeat"
  | "viscosity"
  | "thermalConductivity"
  | "speedOfSound"
  | "gasVolume"
  | "quality"
  | "fluidFront";

/**
 * Branch fields.  All of the flow quantities exist in both modes; which ones
 * a given result actually carries depends on the network (mass flux and
 * dynamic pressure need a flow area, Mach needs a fluid model with a speed of
 * sound), and listChannels skips the absent ones.
 */
export type BranchChannelField =
  | "mdot"
  | "dP"
  | "velocity"
  | "volumetricFlow"
  | "massFlux"
  | "dynamicPressure"
  | "reynolds"
  | "mach";

export type SolidNodeChannelField = "temperature";

/**
 * Conductor fields of SteadyResult.conductors / TransientResult.conductors
 * (`heatTransferCoeff` / `heatFlux` optional), plus the transient TT-WF
 * wetted fraction keyed by conductor id in TransientResult.ttWf.
 */
export type ConductorChannelField =
  "heatRate" | "heatFlux" | "heatTransferCoeff" | "fWet";

/** Every field name any entity can carry. */
export type ChannelField =
  | NodeChannelField
  | BranchChannelField
  | SolidNodeChannelField
  | ConductorChannelField;

/** Strongly typed channel identity: (entity, element id, field). */
export type ChannelId =
  | { entity: "node"; id: string; field: NodeChannelField }
  | { entity: "branch"; id: string; field: BranchChannelField }
  | { entity: "solidNode"; id: string; field: SolidNodeChannelField }
  | { entity: "conductor"; id: string; field: ConductorChannelField };

/** Which result mode(s) can carry the channel. */
export type ChannelAvailability = "steady" | "transient" | "both";

/* ------------------------------------------------------------------ */
/* Per-field metadata (single source of truth for listing + labels)    */
/* ------------------------------------------------------------------ */

interface FieldMeta {
  /** Short quantity name; the full label is `${elementLabel} · ${label}`. */
  label: string;
  quantity: QuantityKind;
  /** Raw SI unit symbol when no convertible QuantityKind exists. */
  rawUnit?: string;
  availability: ChannelAvailability;
  /** Sign-convention quantity (flow / heat direction). */
  signed: boolean;
}

/* Declaration order defines the canonical listing order per element. */
const NODE_FIELD_META: Record<NodeChannelField, FieldMeta> = {
  pressure: {
    label: "Pressure",
    quantity: "pressure",
    availability: "both",
    signed: false,
  },
  temperature: {
    label: "Temperature",
    quantity: "temperature",
    availability: "both",
    signed: false,
  },
  density: {
    label: "Density",
    quantity: "density",
    availability: "both",
    signed: false,
  },
  enthalpy: {
    label: "Enthalpy",
    quantity: "specificEnergy",
    availability: "both",
    signed: false,
  },
  internalEnergy: {
    label: "Internal energy",
    quantity: "specificEnergy",
    availability: "both",
    signed: false,
  },
  entropy: {
    label: "Entropy",
    quantity: "specificEntropy",
    availability: "both",
    signed: false,
  },
  specificHeat: {
    label: "Specific heat",
    quantity: "specificHeat",
    availability: "both",
    signed: false,
  },
  viscosity: {
    label: "Viscosity",
    quantity: "viscosity",
    availability: "both",
    signed: false,
  },
  thermalConductivity: {
    label: "Thermal conductivity",
    quantity: "thermalConductivity",
    availability: "both",
    signed: false,
  },
  speedOfSound: {
    label: "Speed of sound",
    quantity: "velocity",
    availability: "both",
    signed: false,
  },
  gasVolume: {
    label: "Gas volume",
    quantity: "volume",
    availability: "transient",
    signed: false,
  },
  quality: {
    label: "Quality",
    quantity: "dimensionless",
    availability: "both",
    signed: false,
  },
  fluidFront: {
    label: "Front fraction",
    quantity: "dimensionless",
    availability: "transient",
    signed: false,
  },
};

const BRANCH_FIELD_META: Record<BranchChannelField, FieldMeta> = {
  mdot: {
    label: "Mass flow",
    quantity: "massFlow",
    availability: "both",
    signed: true,
  },
  dP: {
    label: "Pressure drop",
    quantity: "pressure",
    availability: "both",
    signed: true,
  },
  velocity: {
    label: "Velocity",
    quantity: "velocity",
    availability: "both",
    signed: true,
  },
  volumetricFlow: {
    label: "Volumetric flow",
    quantity: "volumetricFlow",
    availability: "both",
    signed: true,
  },
  massFlux: {
    label: "Mass flux",
    quantity: "massFlux",
    availability: "both",
    signed: true,
  },
  dynamicPressure: {
    label: "Dynamic pressure",
    quantity: "pressure",
    availability: "both",
    signed: false,
  },
  reynolds: {
    label: "Reynolds",
    quantity: "dimensionless",
    availability: "both",
    signed: false,
  },
  mach: {
    label: "Mach",
    quantity: "dimensionless",
    availability: "both",
    signed: false,
  },
};

const SOLID_NODE_FIELD_META: Record<SolidNodeChannelField, FieldMeta> = {
  temperature: {
    label: "Temperature",
    quantity: "temperature",
    availability: "both",
    signed: false,
  },
};

const CONDUCTOR_FIELD_META: Record<ConductorChannelField, FieldMeta> = {
  heatRate: {
    label: "Heat rate",
    quantity: "power",
    availability: "both",
    signed: true,
  },
  heatFlux: {
    label: "Heat flux",
    quantity: "heatFlux",
    availability: "both",
    signed: true,
  },
  heatTransferCoeff: {
    label: "Heat transfer coeff",
    quantity: "heatTransferCoeff",
    availability: "both",
    signed: false,
  },
  fWet: {
    label: "Wetted fraction",
    quantity: "dimensionless",
    availability: "transient",
    signed: false,
  },
};

const FIELD_META: Record<ChannelEntityKind, Record<string, FieldMeta>> = {
  node: NODE_FIELD_META,
  branch: BRANCH_FIELD_META,
  solidNode: SOLID_NODE_FIELD_META,
  conductor: CONDUCTOR_FIELD_META,
};

/**
 * One publishable quantity, independent of which element carries it — the
 * per-field half of the registry, with the entity kinds that can supply it.
 * `temperature` is the one field two entities share (fluid nodes and solid
 * nodes), and it means the same thing in both.
 */
export interface ChannelFieldInfo {
  field: ChannelField;
  label: string;
  quantity: QuantityKind;
  rawUnit?: string;
  availability: ChannelAvailability;
  signed: boolean;
  /** Entity kinds whose results can carry this field. */
  entities: ChannelEntityKind[];
}

/**
 * Every distinct field across all entity kinds, in canonical order (entity
 * order, then per-entity declaration order).  This is what lets a UI offer
 * "show me quantity X across the whole network" — canvas coloring, quantity
 * pickers — without maintaining a second hand-written list that can drift
 * from the field metadata above.
 */
export function listChannelFields(): ChannelFieldInfo[] {
  const byField = new Map<string, ChannelFieldInfo>();
  for (const entity of ENTITY_KINDS) {
    for (const [field, meta] of Object.entries(FIELD_META[entity])) {
      const existing = byField.get(field);
      if (existing) {
        existing.entities.push(entity);
        continue;
      }
      byField.set(field, {
        field: field as ChannelField,
        label: meta.label,
        quantity: meta.quantity,
        ...(meta.rawUnit !== undefined ? { rawUnit: meta.rawUnit } : {}),
        availability: meta.availability,
        signed: meta.signed,
        entities: [entity],
      });
    }
  }
  return Array.from(byField.values());
}

/** Field metadata by name, or undefined for an unknown field. */
export function channelFieldInfo(field: string): ChannelFieldInfo | undefined {
  return listChannelFields().find((f) => f.field === field);
}

/** Canonical "primary" field per entity (used by primaryChannelForSelection). */
const PRIMARY_FIELD: Record<ChannelEntityKind, string> = {
  node: "pressure",
  branch: "mdot",
  solidNode: "temperature",
  conductor: "heatRate",
};

const ENTITY_KINDS: readonly ChannelEntityKind[] = [
  "node",
  "branch",
  "solidNode",
  "conductor",
];

function asEntityKind(v: unknown): ChannelEntityKind | null {
  return typeof v === "string" &&
    (ENTITY_KINDS as readonly string[]).includes(v)
    ? (v as ChannelEntityKind)
    : null;
}

/** Validated ChannelId factory: null when the field is not valid for the entity. */
export function makeChannelId(
  entity: ChannelEntityKind,
  id: string,
  field: string,
): ChannelId | null {
  switch (entity) {
    case "node":
      return field in NODE_FIELD_META
        ? { entity, id, field: field as NodeChannelField }
        : null;
    case "branch":
      return field in BRANCH_FIELD_META
        ? { entity, id, field: field as BranchChannelField }
        : null;
    case "solidNode":
      return field in SOLID_NODE_FIELD_META
        ? { entity, id, field: field as SolidNodeChannelField }
        : null;
    case "conductor":
      return field in CONDUCTOR_FIELD_META
        ? { entity, id, field: field as ConductorChannelField }
        : null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Channel keys: versioned prefix + base64url(JSON [entity, id, field]) */
/* ------------------------------------------------------------------ */

const KEY_PREFIX = "ch1.";

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): string | null {
  try {
    if (!/^[A-Za-z0-9\-_]*$/.test(text)) return null;
    let b64 = text.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Encode a ChannelId as a reversible, URL-safe string key.  Supports
 * arbitrary element ids (punctuation, whitespace, unicode, empty strings)
 * because the payload is base64url(JSON) — never separator-split.
 */
export function channelKey(channel: ChannelId): string {
  return (
    KEY_PREFIX +
    base64UrlEncode(JSON.stringify([channel.entity, channel.id, channel.field]))
  );
}

/** Inverse of channelKey; returns null (never throws) for any malformed key. */
export function parseChannelKey(key: string): ChannelId | null {
  try {
    if (typeof key !== "string" || !key.startsWith(KEY_PREFIX)) return null;
    const json = base64UrlDecode(key.slice(KEY_PREFIX.length));
    if (json === null) return null;
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [entity, id, field] = parsed as unknown[];
    if (typeof id !== "string" || typeof field !== "string") return null;
    const kind = asEntityKind(entity);
    if (!kind) return null;
    return makeChannelId(kind, id, field);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Channel descriptor + listing                                        */
/* ------------------------------------------------------------------ */

export interface ChannelDescriptor {
  /** Strongly typed channel identity. */
  channel: ChannelId;
  /** Reversible string key (channelKey(channel)). */
  key: string;
  /** Full display label: `${elementLabel} · ${fieldLabel}`. */
  label: string;
  /** Element label from the config snapshot, falling back to the id. */
  elementLabel: string;
  quantity: QuantityKind;
  /** Raw SI unit symbol for quantities without a convertible QuantityKind. */
  rawUnit?: string;
  availability: ChannelAvailability;
  /** True for sign-convention quantities (mdot, dP, heatRate). */
  signed: boolean;
}

type ResultMode = "steady" | "transient";

function resultMode(result: SteadyResult | TransientResult): ResultMode {
  return Array.isArray((result as TransientResult).times)
    ? "transient"
    : "steady";
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object"
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Raw (unvalidated) value source for one channel field, hiding the schema
 * layout: fluidFront lives in TransientResult.fluidFront, fWet in
 * TransientResult.ttWf, everything else in the per-entity record.
 */
function sourceValue(
  result: SteadyResult | TransientResult,
  mode: ResultMode,
  entity: ChannelEntityKind,
  id: string,
  field: string,
): unknown {
  if (mode === "transient") {
    const t = result as TransientResult;
    if (entity === "node" && field === "fluidFront")
      return asRecord(asRecord(t.fluidFront)?.[id])?.fraction;
    if (entity === "conductor" && field === "fWet")
      return asRecord(asRecord(t.ttWf)?.[id])?.fWet;
  }
  const table =
    entity === "node"
      ? (result as SteadyResult).nodes
      : entity === "branch"
        ? (result as SteadyResult).branches
        : entity === "solidNode"
          ? (result as SteadyResult).solidNodes
          : (result as SteadyResult).conductors;
  return asRecord(asRecord(table)?.[id])?.[field];
}

/** Map key separator that cannot collide with element id text. */
const KEY_SEP = " ";

function buildLabelMap(
  config: NetworkConfig | null | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  const put = (entity: ChannelEntityKind, el: unknown) => {
    const rec = asRecord(el);
    const id = rec?.id;
    if (typeof id !== "string") return;
    const label = rec?.label;
    map.set(
      `${entity}${KEY_SEP}${id}`,
      typeof label === "string" && label.length > 0 ? label : id,
    );
  };
  if (Array.isArray(config?.nodes))
    for (const n of config.nodes) put("node", n);
  if (Array.isArray(config?.branches))
    for (const b of config.branches) put("branch", b);
  if (Array.isArray(config?.solidNodes))
    for (const s of config.solidNodes) put("solidNode", s);
  if (Array.isArray(config?.conductors))
    for (const c of config.conductors) put("conductor", c);
  return map;
}

function configElements(
  config: NetworkConfig | null | undefined,
): Array<[ChannelEntityKind, string]> {
  const out: Array<[ChannelEntityKind, string]> = [];
  const collect = (entity: ChannelEntityKind, arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const el of arr) {
      const id = asRecord(el)?.id;
      if (typeof id === "string") out.push([entity, id]);
    }
  };
  collect("node", config?.nodes);
  collect("branch", config?.branches);
  collect("solidNode", config?.solidNodes);
  collect("conductor", config?.conductors);
  return out;
}

/** Element ids actually present in the result, per entity (including the
 *  transient-only fluidFront / ttWf side tables). */
function resultElements(
  result: SteadyResult | TransientResult,
  mode: ResultMode,
): Array<[ChannelEntityKind, string]> {
  const out: Array<[ChannelEntityKind, string]> = [];
  const keys = (table: unknown) => Object.keys(asRecord(table) ?? {});
  for (const id of keys((result as SteadyResult).nodes)) out.push(["node", id]);
  if (mode === "transient")
    for (const id of keys((result as TransientResult).fluidFront))
      out.push(["node", id]);
  for (const id of keys((result as SteadyResult).branches))
    out.push(["branch", id]);
  for (const id of keys((result as SteadyResult).solidNodes))
    out.push(["solidNode", id]);
  for (const id of keys((result as SteadyResult).conductors))
    out.push(["conductor", id]);
  if (mode === "transient")
    for (const id of keys((result as TransientResult).ttWf))
      out.push(["conductor", id]);
  return out;
}

function descriptor(
  labels: Map<string, string>,
  channel: ChannelId,
  meta: FieldMeta,
): ChannelDescriptor {
  const elementLabel =
    labels.get(`${channel.entity}${KEY_SEP}${channel.id}`) ?? channel.id;
  return {
    channel,
    key: channelKey(channel),
    label: `${elementLabel} · ${meta.label}`,
    elementLabel,
    quantity: meta.quantity,
    ...(meta.rawUnit !== undefined ? { rawUnit: meta.rawUnit } : {}),
    availability: meta.availability,
    signed: meta.signed,
  };
}

/**
 * Deterministic inventory of the numeric channels actually present in
 * `result`, in config order (nodes, branches, solidNodes, conductors; unknown
 * result elements appended, sorted by entity then id), with the canonical
 * per-element field order.
 *
 * Absent optional fields are skipped, which is what keeps the inventory
 * accurate as the published property set grows: entropy and conductivity only
 * appear for real fluids, Mach only where the fluid model has a speed of
 * sound, mass flux and dynamic pressure only for components with a flow
 * area, heat flux only where the conductor area is positive.  Also skipped
 * are fields that do not apply to the result's mode
 * (gasVolume/fluidFront/fWet in steady) and transient fields present only as
 * an EMPTY array (the solver packs `quality: []` for non-real-fluid runs — a
 * zero-sample series is not a channel).  Returns [] for a null/garbage
 * result; never throws.
 */
export function listChannels(
  config: NetworkConfig,
  result: SteadyResult | TransientResult | null | undefined,
): ChannelDescriptor[] {
  try {
    if (!result || typeof result !== "object") return [];
    const mode = resultMode(result);
    const labels = buildLabelMap(config);
    const out: ChannelDescriptor[] = [];
    const emitted = new Set<string>();

    const emit = (entity: ChannelEntityKind, id: string): void => {
      const seenKey = `${entity}${KEY_SEP}${id}`;
      if (emitted.has(seenKey)) return;
      const fields = Object.keys(FIELD_META[entity]).filter((field) => {
        const meta = FIELD_META[entity][field];
        if (meta.availability !== "both" && meta.availability !== mode)
          return false;
        const v = sourceValue(result, mode, entity, id, field);
        // Transient: an EMPTY array is not a channel — the solver packs
        // `quality: []` for non-real-fluid runs (never populated), which
        // would otherwise surface as a phantom channel that charts nothing.
        return mode === "steady"
          ? typeof v === "number"
          : Array.isArray(v) && v.length > 0;
      });
      if (fields.length === 0) return;
      emitted.add(seenKey);
      for (const field of fields) {
        const channel = makeChannelId(entity, id, field);
        if (!channel) continue;
        out.push(descriptor(labels, channel, FIELD_META[entity][field]));
      }
    };

    for (const [entity, id] of configElements(config)) emit(entity, id);

    const extras: Array<[ChannelEntityKind, string]> = [];
    for (const [entity, id] of resultElements(result, mode)) {
      if (!emitted.has(`${entity}${KEY_SEP}${id}`)) extras.push([entity, id]);
    }
    extras.sort(
      (a, b) =>
        ENTITY_KINDS.indexOf(a[0]) - ENTITY_KINDS.indexOf(b[0]) ||
        (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0),
    );
    for (const [entity, id] of extras) emit(entity, id);

    return out;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

/**
 * Resolved channel data: a finite steady scalar, or a transient series with
 * `times`/`values` aligned, truncated to the shorter side, and with every
 * pair containing a non-finite member dropped.
 */
export type ChannelData =
  | { kind: "scalar"; value: number }
  | { kind: "series"; times: number[]; values: number[] };

/** Runtime-validates the channel and extracts (entity, id, field), or null. */
function checkedChannel(
  channel: ChannelId | null | undefined,
): ChannelId | null {
  if (!channel || typeof channel !== "object") return null;
  const entity = asEntityKind((channel as ChannelId).entity);
  const id = (channel as ChannelId).id;
  const field = (channel as ChannelId).field;
  if (!entity || typeof id !== "string" || typeof field !== "string")
    return null;
  return makeChannelId(entity, id, field);
}

/**
 * Resolve a channel against a result.  Returns null when the result is null,
 * the channel is invalid, the element/field is absent, the channel does not
 * apply to the result's mode, or a steady scalar is non-finite.  A transient
 * channel whose field is present resolves to a (possibly empty) series with
 * non-finite pairs dropped.  Never throws.
 */
export function resolveChannel(
  result: SteadyResult | TransientResult | null | undefined,
  channel: ChannelId | null | undefined,
): ChannelData | null {
  try {
    if (!result || typeof result !== "object") return null;
    const ch = checkedChannel(channel);
    if (!ch) return null;
    const mode = resultMode(result);
    const v = sourceValue(result, mode, ch.entity, ch.id, ch.field);
    if (mode === "steady") {
      return typeof v === "number" && Number.isFinite(v)
        ? { kind: "scalar", value: v }
        : null;
    }
    const times = (result as TransientResult).times;
    if (!Array.isArray(times) || !Array.isArray(v)) return null;
    const n = Math.min(times.length, v.length);
    const t: number[] = [];
    const vals: number[] = [];
    for (let i = 0; i < n; i++) {
      const ti = times[i];
      const vi = (v as unknown[])[i];
      if (
        typeof ti === "number" &&
        Number.isFinite(ti) &&
        typeof vi === "number" &&
        Number.isFinite(vi)
      ) {
        t.push(ti);
        vals.push(vi);
      }
    }
    return { kind: "series", times: t, values: vals };
  } catch {
    return null;
  }
}

/**
 * Resolve a channel to one value at `timeIndex`.  Indexing applies to the
 * raw series truncated to the aligned length (BEFORE non-finite filtering, so
 * indices are stable and match the result's own sample indexing): null /
 * non-finite `timeIndex` selects the last aligned sample, fractional indices
 * are rounded, and the result is clamped to [0, n-1].  Returns null for empty
 * or absent series and when the addressed sample is non-finite.  Steady
 * scalars ignore `timeIndex`.  Never throws.
 */
export function resolveChannelAt(
  result: SteadyResult | TransientResult | null | undefined,
  channel: ChannelId | null | undefined,
  timeIndex: number | null = null,
): number | null {
  try {
    if (!result || typeof result !== "object") return null;
    const ch = checkedChannel(channel);
    if (!ch) return null;
    const mode = resultMode(result);
    const v = sourceValue(result, mode, ch.entity, ch.id, ch.field);
    if (mode === "steady") {
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    }
    const times = (result as TransientResult).times;
    if (!Array.isArray(times) || !Array.isArray(v)) return null;
    const n = Math.min(times.length, v.length);
    if (n === 0) return null;
    let idx: number;
    if (
      timeIndex === null ||
      timeIndex === undefined ||
      !Number.isFinite(timeIndex)
    ) {
      idx = n - 1;
    } else {
      idx = Math.round(timeIndex);
      if (idx < 0) idx = 0;
      if (idx > n - 1) idx = n - 1;
    }
    const sample = (v as unknown[])[idx];
    return typeof sample === "number" && Number.isFinite(sample)
      ? sample
      : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Filtering / grouping / default selection                            */
/* ------------------------------------------------------------------ */

/** AND-combined criteria; each criterion matches any of its values. */
export interface ChannelFilter {
  entity?: ChannelEntityKind | readonly ChannelEntityKind[];
  /** Element id(s). */
  id?: string | readonly string[];
  field?: string | readonly string[];
  quantity?: QuantityKind | readonly QuantityKind[];
  availability?: ChannelAvailability | readonly ChannelAvailability[];
  signed?: boolean;
}

function asList<T>(v: T | readonly T[] | undefined): readonly T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? (v as readonly T[]) : ([v] as readonly T[]);
}

/** Pure filter: AND across the given criteria, OR within each. */
export function filterChannels(
  channels: readonly ChannelDescriptor[],
  filter: ChannelFilter = {},
): ChannelDescriptor[] {
  const entities = asList(filter.entity);
  const ids = asList(filter.id);
  const fields = asList(filter.field);
  const quantities = asList(filter.quantity);
  const availabilities = asList(filter.availability);
  return channels.filter((c) => {
    if (entities && !entities.includes(c.channel.entity)) return false;
    if (ids && !ids.includes(c.channel.id)) return false;
    if (fields && !fields.includes(c.channel.field)) return false;
    if (quantities && !quantities.includes(c.quantity)) return false;
    if (availabilities && !availabilities.includes(c.availability))
      return false;
    if (filter.signed !== undefined && c.signed !== filter.signed) return false;
    return true;
  });
}

export interface ChannelQuantityGroup {
  quantity: QuantityKind;
  channels: ChannelDescriptor[];
}

/**
 * Group channels by quantity, preserving the order in which each quantity
 * first appears in the input (deterministic for deterministic input).
 */
export function groupChannelsByQuantity(
  channels: readonly ChannelDescriptor[],
): ChannelQuantityGroup[] {
  const byQuantity = new Map<QuantityKind, ChannelDescriptor[]>();
  for (const c of channels) {
    const arr = byQuantity.get(c.quantity);
    if (arr) arr.push(c);
    else byQuantity.set(c.quantity, [c]);
  }
  return Array.from(byQuantity, ([quantity, grouped]) => ({
    quantity,
    channels: grouped,
  }));
}

/** Default (and maximum-by-default) number of channels picked by defaultChannels. */
export const DEFAULT_CHANNEL_LIMIT = 8;

function selectionMatchesChannel(
  selection: Selection,
  c: ChannelDescriptor,
): boolean {
  return (
    selection.kind !== "none" &&
    selection.kind !== "group" &&
    selection.kind !== "multi" &&
    selection.kind === c.channel.entity &&
    selection.id === c.channel.id
  );
}

/**
 * Deterministic default channel pick: without a usable element selection this
 * is simply the first `limit` channels in input order.  With a node / branch
 * / solidNode / conductor selection that has channels, the element's primary
 * channel comes first, then its remaining channels (input order), then all
 * other channels (input order).  `limit` defaults to DEFAULT_CHANNEL_LIMIT
 * (8), is floored, and clamped at ≥ 0.
 */
export function defaultChannels(
  channels: readonly ChannelDescriptor[],
  opts: { selection?: Selection | null; limit?: number } = {},
): ChannelDescriptor[] {
  const cap = Math.max(0, Math.floor(opts.limit ?? DEFAULT_CHANNEL_LIMIT));
  if (!Number.isFinite(cap) || cap === 0) return [];
  const selection = opts.selection ?? null;
  const primary = selection
    ? primaryChannelForSelection(channels, selection)
    : undefined;
  if (!selection || !primary) return channels.slice(0, cap);
  const selectedRest = channels.filter(
    (c) => c !== primary && selectionMatchesChannel(selection, c),
  );
  const others = channels.filter(
    (c) => c !== primary && !selectionMatchesChannel(selection, c),
  );
  return [primary, ...selectedRest, ...others].slice(0, cap);
}

/** UI selection for a channel's element (entity kinds map 1:1). */
export function selectionForChannel(
  channel: ChannelId | ChannelDescriptor,
): Selection {
  const id = "channel" in channel ? channel.channel : channel;
  return { kind: id.entity, id: id.id };
}

/**
 * The primary channel of the selected element: the canonical primary field
 * (node→pressure, branch→mdot, solidNode→temperature, conductor→heatRate)
 * when present, else the element's first channel in input order.  Undefined
 * for 'none' / 'group' selections and when the element has no channels.
 */
export function primaryChannelForSelection(
  channels: readonly ChannelDescriptor[],
  selection: Selection | null | undefined,
): ChannelDescriptor | undefined {
  if (
    !selection ||
    selection.kind === "none" ||
    selection.kind === "group" ||
    selection.kind === "multi"
  )
    return undefined;
  const entity = selection.kind as ChannelEntityKind;
  const mine = channels.filter(
    (c) => c.channel.entity === entity && c.channel.id === selection.id,
  );
  if (mine.length === 0) return undefined;
  const primaryField = PRIMARY_FIELD[entity];
  return mine.find((c) => c.channel.field === primaryField) ?? mine[0];
}
