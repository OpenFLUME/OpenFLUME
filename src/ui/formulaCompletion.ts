/**
 * formulaCompletion.ts — pure, config-aware autocomplete for the formula
 * editor's static model bindings (core/paramBindings.ts is the resolution
 * authority; core/schema.ts `NumberOrExpression` is the storage form).
 *
 * Built on the tolerant lexer of core/usercode/formulaTokens.ts (via the
 * ui/formulaTokens.ts shim; tokenizeFormula only — no chips, no parsing, no
 * evaluation) plus the PUBLIC core surface
 * (NetworkConfig, previewNetworkParameters consumers, expressionBuiltinNames).
 * There is no React/DOM here and NOTHING throws: malformed sources,
 * out-of-range carets, and partial configs all degrade to a plain toplevel
 * completion (possibly with zero suggestions).
 *
 * The suggested reference properties deliberately mirror the STATIC SCOPE of
 * core/paramBindings.ts:
 *   pipe('id')       → length, diameter, roughness, elevationChange?,
 *                      area, volume, surfaceArea (derived from resolved L/d)
 *   heatedPipe('id') → pipe's set plus ua, wallTemperature
 *   bend('id')       → diameter, angle, rOverD, roughness?, area (derived)
 *   branch('id')     → the component's statically stored numeric properties
 *   node('id')       → configured pressure, temperature, volume, heatInput,
 *                      position.{x,y,z}, and z as an alias of position.z
 *   conductor('id')  → kind-specific numeric properties; convection with a
 *                      correlation block exposes correlation.diameter /
 *                      flowArea / axialPosition / … as nested leaves
 *   solid('id')      → temperature, mass?, heatInput?, position.{x,y,z}?
 *   reg('name')      → initial registers only (no property chain)
 * plus the helpers circleArea/circleDiameter/cylinderVolume/cylinderArea and
 * the expression builtins (min/max/sqrt/…/pi).
 *
 * Every LEAF suggestion is a complete, valid static reference: inserting it
 * into a formula-bound field on a valid config is accepted by
 * previewNetworkParameters (verified in tests/formulaCompletion.test.ts).
 */

import type { NetworkConfig } from "../core";
import { expressionBuiltinNames, isParameterExpression } from "../core";
import {
  BINDABLE_COMPONENT_FIELDS,
  BINDABLE_CORRELATION_FIELDS,
  BINDABLE_NODE_FIELDS,
  BINDABLE_POSITION_AXES,
  BINDABLE_SOLID_FIELDS,
} from "../core/formulaFields";
import {
  escapeFormulaId,
  quoteFormulaId,
  tokenizeFormula,
  type FormulaToken,
} from "./formulaTokens";

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

/** Model accessors that can root a static model reference. */
export type FormulaAccessor =
  | "pipe"
  | "heatedPipe"
  | "bend"
  | "branch"
  | "node"
  | "conductor"
  | "solid"
  | "reg";

/** A callable/constant name usable at expression level. */
export interface FormulaNameInfo {
  name: string;
  /** Display signature, e.g. "pipe('id')" or "cylinderVolume(L, d)". */
  signature: string;
  detail: string;
}

/**
 * A LEAF reference property of one entity.  `path` is the full property
 * chain after the accessor call, so nested correlation fields have
 * path ['correlation', 'diameter'].
 */
export interface FormulaPropertyInfo {
  /** Last path segment — what is typed after the final dot. */
  name: string;
  /** Full chain after the accessor call (length 1 or 2). */
  path: string[];
  /** Static numeric value hint, when known as a plain literal (or derived
   *  from plain literals).  Absent for formula-bound fields. */
  value?: number;
  /** True for geometry derived from other fields (area/volume/surfaceArea). */
  derived: boolean;
  /** Human hint: "= 0.05", "formula-bound", "derived π·d²/4 = 0.00196…". */
  detail: string;
}

/** One addressable model entity (branch / node / conductor / solid / register). */
export interface FormulaEntityInfo {
  id: string;
  accessor: FormulaAccessor;
  /** Type context, e.g. "pipe branch", "convection conductor", "register = 2.5". */
  detail: string;
  /** Leaf properties in canonical static-scope order (empty for reg). */
  properties: FormulaPropertyInfo[];
}

/** The full completion catalog for one config.  All arrays are in a fixed,
 *  deterministic order (entities sorted by id; everything else canonical). */
export interface FormulaCatalog {
  accessors: FormulaNameInfo[];
  helpers: FormulaNameInfo[];
  builtins: FormulaNameInfo[];
  entities: Record<FormulaAccessor, FormulaEntityInfo[]>;
}

export type FormulaSuggestionKind =
  "accessor" | "helper" | "builtin" | "id" | "property";

/** One ranked completion item. */
export interface FormulaSuggestion {
  kind: FormulaSuggestionKind;
  /** Text matched against the typed prefix (also the display label). */
  label: string;
  /** Source text inserted when the suggestion is accepted.  Ids are
   *  quote-escaped (and fully quoted when the caret is not already inside a
   *  string literal); properties gain a leading '.' when no dot has been
   *  typed yet. */
  insertText: string;
  detail: string;
}

/** Where the caret sits and what should be offered there. */
export interface FormulaCompletion {
  /** 'toplevel' — accessor/helper/builtin prefix position. */
  kind: "toplevel" | "id" | "property";
  /** Replace range (UTF-16 offsets) an accepted suggestion overwrites. */
  replaceStart: number;
  replaceEnd: number;
  /** Typed text between replaceStart and the caret (already filtered on). */
  prefix: string;
  /** Accessor rooting the reference ('id' and 'property' contexts). */
  accessor?: FormulaAccessor;
  /** Decoded id argument ('property' context only). */
  id?: string;
  /** Property chain completed before the caret, e.g. ['correlation']. */
  propertyChain: string[];
  /** Deterministically ranked, prefix-filtered suggestions. */
  suggestions: FormulaSuggestion[];
}

/* ------------------------------------------------------------------ */
/* Catalog metadata                                                    */
/* ------------------------------------------------------------------ */

/** Every accessor name, in catalog order (also the "is this a model
 *  reference?" authority for callers outside the catalog). */
export const ACCESSOR_ORDER: readonly FormulaAccessor[] = [
  "pipe",
  "heatedPipe",
  "bend",
  "branch",
  "node",
  "conductor",
  "solid",
  "reg",
];

const ACCESSOR_SET = new Set<string>(ACCESSOR_ORDER);

const ACCESSOR_META: Record<
  FormulaAccessor,
  { signature: string; detail: string }
> = {
  pipe: {
    signature: "pipe('id')",
    detail: "pipe branch geometry + derived area/volume/surfaceArea",
  },
  heatedPipe: {
    signature: "heatedPipe('id')",
    detail: "pipe's set plus ua/wallTemperature",
  },
  bend: {
    signature: "bend('id')",
    detail: "bend diameter/angle/rOverD + derived area",
  },
  branch: {
    signature: "branch('id')",
    detail: "any branch's stored numeric component properties",
  },
  node: {
    signature: "node('id')",
    detail: "fluid node volume/z (never solver state)",
  },
  conductor: {
    signature: "conductor('id')",
    detail: "conductor numeric properties (kind-specific)",
  },
  solid: { signature: "solid('id')", detail: "solid node temperature/mass" },
  reg: {
    signature: "reg('name')",
    detail: "initial register value (logic writes not visible)",
  },
};

const HELPER_META: ReadonlyArray<{
  name: string;
  signature: string;
  detail: string;
}> = [
  {
    name: "circleArea",
    signature: "circleArea(d)",
    detail: "circle area π·d²/4",
  },
  {
    name: "circleDiameter",
    signature: "circleDiameter(a)",
    detail: "diameter from area √(4·a/π)",
  },
  {
    name: "cylinderVolume",
    signature: "cylinderVolume(L, d)",
    detail: "cylinder volume L·π·d²/4",
  },
  {
    name: "cylinderArea",
    signature: "cylinderArea(L, d)",
    detail: "lateral area π·d·L",
  },
];

/** Display metadata for the expression builtins; unknown names fall back to
 *  a generic entry so the catalog always covers expressionBuiltinNames(). */
const BUILTIN_META: Record<string, { signature: string; detail: string }> = {
  min: { signature: "min(a, b, …)", detail: "smallest argument" },
  max: { signature: "max(a, b, …)", detail: "largest argument" },
  abs: { signature: "abs(x)", detail: "absolute value" },
  sqrt: { signature: "sqrt(x)", detail: "square root" },
  exp: { signature: "exp(x)", detail: "eˣ" },
  log: { signature: "log(x)", detail: "natural logarithm" },
  sin: { signature: "sin(x)", detail: "sine (radians)" },
  cos: { signature: "cos(x)", detail: "cosine (radians)" },
  tanh: { signature: "tanh(x)", detail: "hyperbolic tangent" },
  clamp: { signature: "clamp(x, lo, hi)", detail: "x clamped to [lo, hi]" },
  smoothstep: {
    signature: "smoothstep(e0, e1, x)",
    detail: "smooth 0→1 step between edges",
  },
  pi: { signature: "pi", detail: "π ≈ 3.141592653589793" },
};

/* ------------------------------------------------------------------ */
/* Catalog construction                                                */
/* ------------------------------------------------------------------ */

type Branch = NetworkConfig["branches"][number];
type FluidNode = NetworkConfig["nodes"][number];
type Conductor = NonNullable<NetworkConfig["conductors"]>[number];
type SolidNode = NonNullable<NetworkConfig["solidNodes"]>[number];

const circleAreaOf = (d: number): number => (Math.PI * d * d) / 4;

/** Hint for a stored NumberOrExpression field; null when the field is
 *  absent or holds something the static scope could never read. */
function storedProp(
  name: string,
  path: string[],
  value: unknown,
): FormulaPropertyInfo | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { name, path, derived: false, value, detail: `= ${value}` };
  }
  if (isParameterExpression(value)) {
    return {
      name,
      path,
      derived: false,
      detail: "formula-bound (resolved before solve)",
    };
  }
  return null;
}

function derivedProp(
  name: string,
  formula: string,
  value: number | undefined,
): FormulaPropertyInfo {
  return {
    name,
    path: [name],
    derived: true,
    value,
    detail:
      value !== undefined
        ? `derived ${formula} = ${value}`
        : `derived ${formula}`,
  };
}

/** Literal value of a NumberOrExpression, when it is a plain finite number. */
function literalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function pipeLikeProperties(branch: Branch): FormulaPropertyInfo[] {
  const c = branch.component as Extract<Branch["component"], { type: "pipe" }>;
  const props: FormulaPropertyInfo[] = [];
  const push = (p: FormulaPropertyInfo | null): void => {
    if (p !== null) props.push(p);
  };
  push(storedProp("length", ["length"], c.length));
  push(storedProp("diameter", ["diameter"], c.diameter));
  push(storedProp("roughness", ["roughness"], c.roughness));
  if (c.elevationChange !== undefined) {
    push(storedProp("elevationChange", ["elevationChange"], c.elevationChange));
  }
  const L = literalNumber(c.length);
  const d = literalNumber(c.diameter);
  const area = d !== undefined ? circleAreaOf(d) : undefined;
  push(derivedProp("area", "π·d²/4", area));
  push(
    derivedProp(
      "volume",
      "L·π·d²/4",
      L !== undefined && d !== undefined ? L * circleAreaOf(d) : undefined,
    ),
  );
  push(
    derivedProp(
      "surfaceArea",
      "π·d·L",
      L !== undefined && d !== undefined ? Math.PI * d * L : undefined,
    ),
  );
  return props;
}

function heatedPipeProperties(branch: Branch): FormulaPropertyInfo[] {
  const c = branch.component as Extract<
    Branch["component"],
    { type: "heatedPipe" }
  >;
  const props = pipeLikeProperties(branch);
  const ua = storedProp("ua", ["ua"], c.ua);
  if (ua !== null) props.push(ua);
  const wall = storedProp(
    "wallTemperature",
    ["wallTemperature"],
    c.wallTemperature,
  );
  if (wall !== null) props.push(wall);
  return props;
}

function bendProperties(branch: Branch): FormulaPropertyInfo[] {
  const c = branch.component as Extract<Branch["component"], { type: "bend" }>;
  const props: FormulaPropertyInfo[] = [];
  const push = (p: FormulaPropertyInfo | null): void => {
    if (p !== null) props.push(p);
  };
  push(storedProp("diameter", ["diameter"], c.diameter));
  push(storedProp("angle", ["angle"], c.angle));
  push(storedProp("rOverD", ["rOverD"], c.rOverD));
  if (c.roughness !== undefined)
    push(storedProp("roughness", ["roughness"], c.roughness));
  const d = literalNumber(c.diameter);
  push(
    derivedProp(
      "area",
      "π·d²/4",
      d !== undefined ? circleAreaOf(d) : undefined,
    ),
  );
  return props;
}

/** branch('id'): statically STORED numeric component properties (no derived values). */
function genericBranchProperties(branch: Branch): FormulaPropertyInfo[] {
  const c = branch.component as unknown as Record<string, unknown>;
  const bindable = BINDABLE_COMPONENT_FIELDS[branch.component.type] ?? [];
  const props: FormulaPropertyInfo[] = [];
  for (const key of Object.keys(c)) {
    if (key === "type") continue;
    const v = c[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      props.push({
        name: key,
        path: [key],
        derived: false,
        value: v,
        detail: `= ${v}`,
      });
    } else if (isParameterExpression(v) && bindable.includes(key)) {
      props.push({
        name: key,
        path: [key],
        derived: false,
        detail: "formula-bound (resolved before solve)",
      });
    }
    // Tables, schedules, strings, booleans, params: not static numeric
    // properties — not exposed, mirroring the core scope.
  }
  return props;
}

function nodeProperties(node: FluidNode): FormulaPropertyInfo[] {
  const props: FormulaPropertyInfo[] = [];
  for (const field of BINDABLE_NODE_FIELDS) {
    const p = storedProp(
      field,
      [field],
      (node as unknown as Record<string, unknown>)[field],
    );
    if (p !== null) props.push(p);
  }
  const pos = node.position;
  for (const axis of BINDABLE_POSITION_AXES) {
    const value = axis === "z" ? (pos?.z ?? node.z) : pos?.[axis];
    if (value === undefined) continue;
    const property = storedProp(axis, ["position", axis], value);
    if (property !== null) props.push(property);
    if (axis === "z") {
      const alias = storedProp("z", ["z"], value);
      if (alias !== null) props.push(alias);
    }
  }
  return props;
}

function conductorProperties(conductor: Conductor): FormulaPropertyInfo[] {
  const t = conductor.type;
  const props: FormulaPropertyInfo[] = [];
  const push = (p: FormulaPropertyInfo | null): void => {
    if (p !== null) props.push(p);
  };
  if (t.kind === "conduction") {
    // k only when a plain number (table/material/expression forms are not
    // statically readable — mirrors core).
    if (typeof t.k === "number" && Number.isFinite(t.k)) {
      props.push({
        name: "k",
        path: ["k"],
        derived: false,
        value: t.k,
        detail: `= ${t.k}`,
      });
    }
    push(storedProp("area", ["area"], t.area));
    push(storedProp("length", ["length"], t.length));
    return props;
  }
  if (t.kind === "convection") {
    push(storedProp("area", ["area"], t.area));
    if (t.h !== undefined) push(storedProp("h", ["h"], t.h));
    const corr = t.correlation;
    if (corr) {
      if (corr.diameter !== undefined)
        push(
          storedProp("diameter", ["correlation", "diameter"], corr.diameter),
        );
      if (corr.flowArea !== undefined)
        push(
          storedProp("flowArea", ["correlation", "flowArea"], corr.flowArea),
        );
      for (const field of BINDABLE_CORRELATION_FIELDS) {
        if (field === "diameter" || field === "flowArea") continue;
        const v = (corr as unknown as Record<string, unknown>)[field];
        push(storedProp(field, ["correlation", field], v));
      }
    }
    return props;
  }
  // radiation
  push(storedProp("emissivity", ["emissivity"], t.emissivity));
  push(storedProp("area", ["area"], t.area));
  push(storedProp("viewFactor", ["viewFactor"], t.viewFactor));
  return props;
}

function solidProperties(solid: SolidNode): FormulaPropertyInfo[] {
  const props: FormulaPropertyInfo[] = [];
  for (const field of BINDABLE_SOLID_FIELDS) {
    const property = storedProp(
      field,
      [field],
      (solid as unknown as Record<string, unknown>)[field],
    );
    if (property !== null) props.push(property);
  }
  const pos = solid.position;
  for (const axis of BINDABLE_POSITION_AXES) {
    if (pos?.[axis] === undefined) continue;
    const property = storedProp(axis, ["position", axis], pos[axis]);
    if (property !== null) props.push(property);
  }
  return props;
}

const byId = (a: FormulaEntityInfo, b: FormulaEntityInfo): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Build the completion catalog for `config`.  Pure and tolerant: partial or
 * malformed configs simply yield fewer entries.  Entity lists are sorted by
 * id so ranking is fully deterministic for a given config.
 */
export function buildFormulaCatalog(config: NetworkConfig): FormulaCatalog {
  const entities: Record<FormulaAccessor, FormulaEntityInfo[]> = {
    pipe: [],
    heatedPipe: [],
    bend: [],
    branch: [],
    node: [],
    conductor: [],
    solid: [],
    reg: [],
  };

  for (const branch of config.branches ?? []) {
    const type = branch?.component?.type;
    if (typeof type !== "string") continue;
    entities.branch.push({
      id: branch.id,
      accessor: "branch",
      detail: `${type} branch`,
      properties: genericBranchProperties(branch),
    });
    if (type === "pipe" || type === "heatedPipe" || type === "bend") {
      const properties =
        type === "pipe"
          ? pipeLikeProperties(branch)
          : type === "heatedPipe"
            ? heatedPipeProperties(branch)
            : bendProperties(branch);
      entities[type].push({
        id: branch.id,
        accessor: type,
        detail: `${type} branch`,
        properties,
      });
    }
  }

  for (const node of config.nodes ?? []) {
    entities.node.push({
      id: node.id,
      accessor: "node",
      detail: `${node.type} node`,
      properties: nodeProperties(node),
    });
  }

  for (const conductor of config.conductors ?? []) {
    entities.conductor.push({
      id: conductor.id,
      accessor: "conductor",
      detail: `${conductor.type.kind} conductor`,
      properties: conductorProperties(conductor),
    });
  }

  for (const solid of config.solidNodes ?? []) {
    entities.solid.push({
      id: solid.id,
      accessor: "solid",
      detail: `${solid.type} solid node`,
      properties: solidProperties(solid),
    });
  }

  const registers = config.registers ?? {};
  for (const name of Object.keys(registers)) {
    const v = registers[name];
    if (typeof v !== "number" || !Number.isFinite(v)) continue; // mirrors the core scope check
    entities.reg.push({
      id: name,
      accessor: "reg",
      detail: `register = ${v}`,
      properties: [],
    });
  }

  for (const accessor of ACCESSOR_ORDER) entities[accessor].sort(byId);

  return {
    accessors: ACCESSOR_ORDER.map((name) => ({ name, ...ACCESSOR_META[name] })),
    helpers: HELPER_META.map((h) => ({ ...h })),
    builtins: expressionBuiltinNames().map((name) => {
      const meta = BUILTIN_META[name];
      return {
        name,
        signature: meta?.signature ?? name,
        detail: meta?.detail ?? "expression builtin",
      };
    }),
    entities,
  };
}

const catalogCache = new WeakMap<NetworkConfig, FormulaCatalog>();

/** Reuse one catalog across formula inputs rendering the same immutable config. */
export function formulaCatalogForConfig(config: NetworkConfig): FormulaCatalog {
  const cached = catalogCache.get(config);
  if (cached) return cached;
  const catalog = buildFormulaCatalog(config);
  catalogCache.set(config, catalog);
  return catalog;
}

/* ------------------------------------------------------------------ */
/* Insertion text / escaping                                           */
/* ------------------------------------------------------------------ */

// escapeFormulaId / quoteFormulaId live in core/usercode/formulaTokens.ts
// (the encode side of its decodeStringLiteral) so core-side transforms
// share them; re-exported here for existing UI consumers of this module.
export { escapeFormulaId, quoteFormulaId };

/** Complete reference source, e.g. pipe('seg1').volume or reg('gain'). */
export function referenceSource(
  accessor: FormulaAccessor,
  id: string,
  propertyPath: readonly string[] = [],
  quote: "'" | '"' = "'",
): string {
  let out = `${accessor}(${quoteFormulaId(id, quote)})`;
  for (const p of propertyPath) out += `.${p}`;
  return out;
}

/**
 * Apply a suggestion to `source`, replacing the completion's range with the
 * suggestion's insertText.  Returns the new source and the caret position at
 * the end of the inserted text.  Never throws: ranges are clamped.
 */
export function applyFormulaCompletion(
  source: string,
  completion: Pick<FormulaCompletion, "replaceStart" | "replaceEnd">,
  suggestion: Pick<FormulaSuggestion, "insertText">,
): { source: string; caret: number } {
  const src = typeof source === "string" ? source : "";
  const clamp = (n: number): number =>
    Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 0), src.length) : 0;
  const start = clamp(completion.replaceStart);
  const end = Math.max(start, clamp(completion.replaceEnd));
  const insert =
    typeof suggestion.insertText === "string" ? suggestion.insertText : "";
  return {
    source: src.slice(0, start) + insert + src.slice(end),
    caret: start + insert.length,
  };
}

/* ------------------------------------------------------------------ */
/* Context detection + ranking                                         */
/* ------------------------------------------------------------------ */

/**
 * Decode a string literal's raw inner text — mirrors decodeStringLiteral in
 * core/usercode/formulaTokens.ts / core/usercode/expression.ts (\n and \t
 * special, any other escaped char stands for itself).
 */
function decodeLiteralInner(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\" && i + 1 < raw.length) {
      const esc = raw[i + 1];
      if (esc === "n") out += "\n";
      else if (esc === "t") out += "\t";
      else out += esc;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

function isAccessorName(value: string): value is FormulaAccessor {
  return ACCESSOR_SET.has(value);
}

/** True when the string token has a closing quote (≥ 2 chars, ends on it). */
function isTerminatedString(source: string, token: FormulaToken): boolean {
  return (
    token.end - token.start >= 2 &&
    source[token.end - 1] === source[token.start]
  );
}

function clampCaret(caret: number, length: number): number {
  if (!Number.isFinite(caret)) return length;
  return Math.min(Math.max(Math.floor(caret), 0), length);
}

function isCatalog(x: FormulaCatalog | NetworkConfig): x is FormulaCatalog {
  return (
    typeof x === "object" && x !== null && "entities" in x && "accessors" in x
  );
}

/**
 * Prefix-filter + deterministic rank.  All candidate labels already start
 * with the prefix after filtering; an exact match floats to the top and the
 * remaining relative order is the (fixed) catalog order — stable sort, no
 * locale dependence.
 */
function rankSuggestions(
  prefix: string,
  items: FormulaSuggestion[],
): FormulaSuggestion[] {
  const filtered =
    prefix === ""
      ? items.slice()
      : items.filter((s) => s.label.startsWith(prefix));
  return filtered
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ea = a.s.label === prefix && prefix !== "" ? 0 : 1;
      const eb = b.s.label === prefix && prefix !== "" ? 0 : 1;
      return ea - eb || a.i - b.i;
    })
    .map((x) => x.s);
}

function idSuggestion(
  entity: FormulaEntityInfo,
  quoted: boolean,
): FormulaSuggestion {
  return {
    kind: "id",
    label: entity.id,
    insertText: quoted ? quoteFormulaId(entity.id) : escapeFormulaId(entity.id),
    detail: entity.detail,
  };
}

function propertySuggestion(
  prop: FormulaPropertyInfo,
  chainDepth: number,
  needsDot: boolean,
): FormulaSuggestion {
  // At the accessor root suggest the whole (possibly nested) path so every
  // suggestion is a COMPLETE valid reference; inside a typed chain suggest
  // just the next segment.
  const text = chainDepth === 0 ? prop.path.join(".") : prop.name;
  return {
    kind: "property",
    label: text,
    insertText: (needsDot ? "." : "") + text,
    detail: prop.detail,
  };
}

function toplevelItems(catalog: FormulaCatalog): FormulaSuggestion[] {
  return [
    ...catalog.accessors.map((a) => ({
      kind: "accessor" as const,
      label: a.name,
      insertText: a.name,
      detail: `${a.signature} — ${a.detail}`,
    })),
    ...catalog.helpers.map((h) => ({
      kind: "helper" as const,
      label: h.name,
      insertText: h.name,
      detail: `${h.signature} — ${h.detail}`,
    })),
    ...catalog.builtins.map((b) => ({
      kind: "builtin" as const,
      label: b.name,
      insertText: b.name,
      detail:
        b.signature === b.name ? b.detail : `${b.signature} — ${b.detail}`,
    })),
  ];
}

function emptyCompletion(
  kind: FormulaCompletion["kind"],
  pos: number,
): FormulaCompletion {
  return {
    kind,
    replaceStart: pos,
    replaceEnd: pos,
    prefix: "",
    propertyChain: [],
    suggestions: [],
  };
}

function computeCompletion(
  source: string,
  pos: number,
  catalog: FormulaCatalog,
): FormulaCompletion {
  const tokens = tokenizeFormula(source);
  const before = tokens.filter((t) => t.start < pos);
  const last = before[before.length - 1];

  /* ---- id-string context: accessor ( '…|  -------------------------- */
  if (last !== undefined && last.kind === "string" && pos > last.start) {
    const open = before[before.length - 2];
    const head = before[before.length - 3];
    if (
      open !== undefined &&
      open.kind === "punct" &&
      open.value === "(" &&
      head !== undefined &&
      head.kind === "ident" &&
      isAccessorName(head.value)
    ) {
      const accessor = head.value;
      const innerStart = last.start + 1;
      const innerEnd = isTerminatedString(source, last)
        ? last.end - 1
        : last.end;
      const prefix = source.slice(innerStart, Math.min(pos, innerEnd));
      return {
        kind: "id",
        replaceStart: innerStart,
        replaceEnd: innerEnd,
        prefix,
        accessor,
        propertyChain: [],
        // Already inside a string literal: insert the escaped id, no quotes.
        suggestions: rankSuggestions(
          prefix,
          catalog.entities[accessor].map((e) => idSuggestion(e, false)),
        ),
      };
    }
    // Inside a string that is not an accessor argument: nothing meaningful.
    return emptyCompletion("toplevel", pos);
  }

  /* ---- id context right after the opening paren: accessor( | -------- */
  if (last !== undefined && last.kind === "punct" && last.value === "(") {
    const head = before[before.length - 2];
    if (
      head !== undefined &&
      head.kind === "ident" &&
      isAccessorName(head.value)
    ) {
      const accessor = head.value;
      // Swallow an existing complete string starting at the caret so the
      // replacement does not duplicate it.
      const next = tokens.find((t) => t.start === pos);
      const replaceEnd =
        next !== undefined && next.kind === "string" ? next.end : pos;
      return {
        kind: "id",
        replaceStart: pos,
        replaceEnd,
        prefix: "",
        accessor,
        propertyChain: [],
        // No quote typed yet: insert a fully quoted, escaped id literal.
        suggestions: rankSuggestions(
          "",
          catalog.entities[accessor].map((e) => idSuggestion(e, true)),
        ),
      };
    }
  }

  /* ---- property-chain context: accessor('id')(.prop)* --------------- */
  // Find the rightmost accessor( <string> ) head whose following tokens form
  // a property-chain suffix: ('.' ident)* then optionally '.' or a partial ident.
  for (let i = before.length - 4; i >= 0; i--) {
    const head = before[i];
    if (head.kind !== "ident" || !isAccessorName(head.value)) continue;
    const open = before[i + 1];
    const arg = before[i + 2];
    const close = before[i + 3];
    if (open === undefined || open.kind !== "punct" || open.value !== "(")
      continue;
    if (
      arg === undefined ||
      arg.kind !== "string" ||
      !isTerminatedString(source, arg)
    )
      continue;
    if (close === undefined || close.kind !== "punct" || close.value !== ")")
      continue;

    const rest = before.slice(i + 4);
    const chain: string[] = [];
    let partial: FormulaToken | undefined;
    let valid = true;
    for (let j = 0; j < rest.length; j += 2) {
      const dot = rest[j];
      if (dot.kind !== "punct" || dot.value !== ".") {
        valid = false;
        break;
      }
      const name = rest[j + 1];
      if (name === undefined) break; // dangling trailing dot
      if (name.kind !== "ident") {
        valid = false;
        break;
      }
      if (j + 2 === rest.length) partial = name;
      else chain.push(name.value);
    }
    if (!valid) continue;

    const id = decodeLiteralInner(source.slice(arg.start + 1, arg.end - 1));
    const replaceStart = partial !== undefined ? partial.start : pos;
    let replaceEnd = partial !== undefined ? partial.end : pos;
    // Extend over an ident starting exactly at the caret (mid-token edits).
    if (partial === undefined) {
      const next = tokens.find((t) => t.start === pos);
      if (next !== undefined && next.kind === "ident") replaceEnd = next.end;
    }
    const prefix =
      partial !== undefined ? source.slice(partial.start, pos) : "";
    const needsDot = source[replaceStart - 1] !== ".";

    const entity = catalog.entities[head.value].find((e) => e.id === id);
    // At the reference root offer EVERY leaf (nested correlation leaves keep
    // their full dotted path, so each suggestion is a complete reference);
    // inside a typed chain offer only its direct children.
    const candidates =
      entity === undefined
        ? []
        : entity.properties.filter(
            (p) =>
              chain.length === 0 ||
              (p.path.length === chain.length + 1 &&
                chain.every((seg, k) => p.path[k] === seg)),
          );
    return {
      kind: "property",
      replaceStart,
      replaceEnd,
      prefix,
      accessor: head.value,
      id,
      propertyChain: chain,
      suggestions: rankSuggestions(
        prefix,
        candidates.map((p) => propertySuggestion(p, chain.length, needsDot)),
      ),
    };
  }

  /* ---- toplevel: accessor / helper / builtin prefix ------------------ */
  let replaceStart = pos;
  let replaceEnd = pos;
  let prefix = "";
  if (last !== undefined && last.kind === "ident") {
    replaceStart = last.start;
    replaceEnd = last.end;
    prefix = source.slice(last.start, pos);
  } else {
    const next = tokens.find((t) => t.start === pos);
    if (next !== undefined && next.kind === "ident") replaceEnd = next.end;
  }
  return {
    kind: "toplevel",
    replaceStart,
    replaceEnd,
    prefix,
    propertyChain: [],
    suggestions: rankSuggestions(prefix, toplevelItems(catalog)),
  };
}

/**
 * Detect the completion context of `caret` in `source` and return ranked,
 * prefix-filtered suggestions from the catalog (built on the fly when a raw
 * NetworkConfig is passed).  NEVER throws — any internal irregularity
 * degrades to an empty toplevel completion at the clamped caret.
 */
export function completionContext(
  source: string,
  caret: number,
  catalogOrConfig: FormulaCatalog | NetworkConfig,
): FormulaCompletion {
  const src = typeof source === "string" ? source : "";
  const pos = clampCaret(caret, src.length);
  try {
    const catalog = isCatalog(catalogOrConfig)
      ? catalogOrConfig
      : buildFormulaCatalog(catalogOrConfig);
    return computeCompletion(src, pos, catalog);
  } catch {
    return emptyCompletion("toplevel", pos);
  }
}
