/**
 * Text projection for NetworkConfig (schema v2) — a deliberately simple,
 * line-oriented, LOSSLESS text rendering of the canonical config object.
 *
 * NetworkConfig (core/schema.ts) is canonical; this module only projects it
 * to/from text.  Parsing is strict and NEVER throws: every malformed input
 * produces ParseError entries and `config: undefined`.  All JSON values are
 * handled exclusively with JSON.stringify / JSON.parse — no eval, no
 * implicit conversions.
 *
 * ============================================================================
 * GRAMMAR
 * ============================================================================
 *
 * One record per line, LF newlines, no indentation in canonical output:
 *
 *   text         ::= header networkLine bodyLine* closeBrace
 *   header       ::= "// Fluid Network config v2"
 *   networkLine  ::= "network " jsonString " {"
 *   bodyLine     ::= fieldLine | markerLine | nodeRec | solidRec | branchRec
 *                  | conductorRec | groupRec | noteRec
 *   fieldLine    ::= fieldKey ": " jsonValue
 *   fieldKey     ::= "settings" | "fluid" | "fluids" | "closureParams" | "species"
 *                  | "registers" | "logic" | "controllers" | "componentLibrary"
 *   markerLine   ::= markerKey ": []"
 *   markerKey    ::= "solidNodes" | "conductors" | "groups" | "notes"
 *   nodeRec      ::= "node " jsonString " " nodeType
 *                    " @ (" num ", " num [", " (num | "null")] ") data: " jsonObject
 *   nodeType     ::= "internal" | "boundary"
 *   solidRec     ::= "solid " jsonString " " solidType
 *                    " @ (" num ", " num ") data: " jsonObject
 *   solidType    ::= "solid" | "ambient"
 *   branchRec    ::= "branch " jsonString ": " jsonString " -> " jsonString
 *                    " " componentType " data: " jsonObject
 *   conductorRec ::= "conductor " jsonString ": " jsonString " -> " jsonString
 *                    " " conductorKind " data: " jsonObject"
 *   conductorKind::= "conduction" | "convection" | "radiation"
 *   groupRec     ::= "group " jsonString " @ (" num ", " num ") data: " jsonObject
 *   noteRec      ::= "note " jsonString " @ (" num ", " num ") data: " jsonObject
 *   closeBrace   ::= "}"
 *
 * - `num` is a strict JSON number (no NaN/Infinity, no leading '+', no
 *   trailing/leading decimal point); jsonString is a JSON-quoted string
 *   (escapes preserved, so multiline source such as user code survives on
 *   one line via \n escaping); jsonObject is a single-line JSON object.
 * - Canonical emission order is fixed: header, network line, singleton field
 *   lines in fieldKey order (present fields only), then nodes, solidNodes,
 *   branches, conductors, groups, notes — each array in its config order.
 *   Object key order inside JSON payloads follows the config's own key order.
 * - PRESENCE METADATA: the optional entity arrays solidNodes / conductors /
 *   groups / notes distinguish ABSENT from PRESENT-BUT-EMPTY.  A non-empty array is
 *   implied by its records; a present-but-empty array is emitted as a single
 *   marker line `<key>: []` at the position where that category's records
 *   would appear.  A marker combined with records of the same category is a
 *   parse error, as is a marker with anything but the literal empty array.
 * - The parser is whitespace-tolerant (arbitrary spaces/tabs between tokens,
 *   blank lines ignored) but structurally strict: unknown record keywords,
 *   unknown field keys, duplicate singleton blocks, duplicate/conflicting
 *   presence markers, malformed JSON / numbers / coordinates, unknown
 *   node/solid types, unknown component types (the exact schema union),
 *   unknown conductor kinds, reserved keys inside data payloads,
 *   malformed/missing header or network line, missing closing brace, and
 *   trailing content after it are all rejected.
 * - Data payloads carry every field not already on the record line:
 *   node:  all fields except id/type/x/y.  Physical metres live in
 *   `position`; a legacy third `@` coordinate (or a `z` data field) is
 *   accepted on parse and folded into `position.z` at decode.
 *   solid: all fields except id/type/x/y (includes optional `position`).
 *   branch: { label?, initialMdot?, ...component fields except type }.
 *   conductor: { label?, ...type fields except kind }.
 *   group: all fields except id/x/y (includes the required label).
 *   note:  all fields except id/x/y (includes the required text).
 * - Elevation: physical `position.z` (and the legacy `@ (x, y, z)` third
 *   coordinate) round-trip through `position`.  As a hand-authoring
 *   convenience the branch data value "elevationChange": "derived" is
 *   replaced before decode with z_to - z_from (missing z counts as 0;
 *   unknown endpoints leave the marker in place so validateNetwork reports
 *   the dangling reference).  The serializer NEVER invents this marker:
 *   explicit numeric values stay explicit numbers.
 *
 * After structural assembly the parser runs the standard boundary pipeline:
 * decodeNetworkConfig (thrown ConfigDecodeErrors are converted to errors,
 * mapped back to the field/entity line where possible) followed by
 * validateNetwork.  Semantic errors are returned with severity 'error' and
 * no config; dangling-reference errors (branch/conductor endpoints, group
 * and component-library references, ...) are attributed to the referencing
 * entity's line, while genuinely whole-document errors carry no line
 * (ParseError.line is left undefined — there is no sentinel line number).
 *
 * TEMPORARY LIMITATION: SerializeOptions.preset / ParseOptions.preset exist
 * for API compatibility with the UI unit presets (a preset NAME or the
 * preset object itself, e.g. METRIC_PRESET), but this core always writes
 * and reads numeric values in raw SI units with NO unit labels; the option
 * is accepted and ignored so SI values round-trip bit-exactly regardless of
 * the display preset.  showGeometry is likewise reserved: geometry
 * (@ coordinates) is always emitted because it is part of the lossless
 * record.
 */

import type { NetworkConfig } from "../core/schema";
import { ConfigDecodeError, decodeNetworkConfig } from "../core/config";
import { validateNetwork } from "../core/validate";

/* ------------------------------------------------------------------ */
/* Public API types                                                    */
/* ------------------------------------------------------------------ */

/**
 * Unit-preset reference accepted for API compatibility with the UI unit
 * presets (ui/units.ts): either a preset NAME ('SI', 'Metric engineering',
 * 'US customary') or the preset object itself (e.g. METRIC_PRESET).
 * TEMPORARY LIMITATION: the text projection is SI-only — numbers are always
 * written and read in SI units with no unit labels, so the preset is
 * accepted and ignored.
 */
export type UnitPresetReference = string | Record<string, string>;

export interface SerializeOptions {
  /** Accepted and ignored (SI-only emission); see UnitPresetReference. */
  preset?: UnitPresetReference;
  /**
   * Reserved view hint.  Canvas geometry (`@ (x, y)`) is ALWAYS emitted —
   * it is part of the lossless record — so this flag currently has no effect.
   */
  showGeometry?: boolean;
}

export interface ParseOptions {
  /** Accepted and ignored (SI-only parsing); see UnitPresetReference. */
  preset?: UnitPresetReference;
  /** Reserved view hint; currently no effect. */
  showGeometry?: boolean;
}

/** 1-based inclusive line range within the serialized text. */
export interface LineRange {
  /** 1-based inclusive first line of the range. */
  startLine: number;
  /** 1-based inclusive last line of the range (=== startLine: every record is a single line). */
  endLine: number;
}

/**
 * Maps entity keys — `node:<id>`, `solid:<id>`, `branch:<id>`,
 * `conductor:<id>`, `group:<id>` — to 1-based inclusive single-line ranges.
 */
export type LineMap = Map<string, LineRange>;

export type ParseErrorSeverity = "error" | "warning";

export interface ParseError {
  /**
   * 1-based line number for line-local problems.  OPTIONAL: omitted
   * (undefined) for whole-document problems where no line is known —
   * missing closing brace, decode failures without a locatable path, and
   * semantic validation errors that cannot be attributed to an entity.
   * There is deliberately no sentinel value.
   */
  line?: number;
  message: string;
  severity: ParseErrorSeverity;
}

export interface ParseResult {
  /** Reconstructed v2 config; undefined whenever `errors` is non-empty. */
  config?: NetworkConfig;
  errors: ParseError[];
  lineMap: LineMap;
}

/* ------------------------------------------------------------------ */
/* Schema-derived token sets (compile-time-exact)                      */
/* ------------------------------------------------------------------ */

const HEADER = "// Fluid Network config v2";

type ComponentTypeName = NetworkConfig["branches"][number]["component"]["type"];
/**
 * Exact mirror of the schema branch-component union: adding or removing a
 * component type in core/schema.ts without updating this table is a
 * compile-time error, keeping the parser's accepted set exact.
 */
const COMPONENT_TYPE_NAMES: Record<ComponentTypeName, true> = {
  pipe: true,
  orifice: true,
  orificeCompressible: true,
  cavitatingVenturi: true,
  resistance: true,
  valve: true,
  checkValve: true,
  dynamicCheckValve: true,
  reliefValve: true,
  pump: true,
  bend: true,
  areaChange: true,
  flowSource: true,
  regulator: true,
  heatedPipe: true,
  dpTable: true,
  customResistance: true,
  userComponent: true,
};
const COMPONENT_TYPES: ReadonlySet<string> = new Set(
  Object.keys(COMPONENT_TYPE_NAMES),
);

type ConductorKindName = NonNullable<
  NetworkConfig["conductors"]
>[number]["type"]["kind"];
const CONDUCTOR_KIND_NAMES: Record<ConductorKindName, true> = {
  conduction: true,
  convection: true,
  radiation: true,
};
const CONDUCTOR_KINDS: ReadonlySet<string> = new Set(
  Object.keys(CONDUCTOR_KIND_NAMES),
);

type NodeTypeName = NetworkConfig["nodes"][number]["type"];
const NODE_TYPE_NAMES: Record<NodeTypeName, true> = {
  internal: true,
  boundary: true,
};
const NODE_TYPES: ReadonlySet<string> = new Set(Object.keys(NODE_TYPE_NAMES));

type SolidTypeName = NonNullable<NetworkConfig["solidNodes"]>[number]["type"];
const SOLID_TYPE_NAMES: Record<SolidTypeName, true> = {
  solid: true,
  ambient: true,
};
const SOLID_TYPES: ReadonlySet<string> = new Set(Object.keys(SOLID_TYPE_NAMES));

/** Singleton top-level field lines, in deterministic emission order. */
const FIELD_ORDER = [
  "settings",
  "fluid",
  "fluids",
  "closureParams",
  "species",
  "registers",
  "logic",
  "controllers",
  "componentLibrary",
] as const;
type FieldKey = (typeof FIELD_ORDER)[number];
const FIELD_KEYS: ReadonlySet<string> = new Set(FIELD_ORDER);

/**
 * Optional entity arrays whose present-but-empty state must survive the
 * round trip (records already imply a present non-empty array).  A
 * present-empty array is emitted as the marker line `<key>: []`.
 */
const OPTIONAL_ENTITY_ARRAYS = [
  "solidNodes",
  "conductors",
  "groups",
  "notes",
] as const;
type OptionalEntityArrayKey = (typeof OPTIONAL_ENTITY_ARRAYS)[number];
const MARKER_KEYS: ReadonlySet<string> = new Set(OPTIONAL_ENTITY_ARRAYS);

/** Keys a data payload must NOT carry (they live on the record line). */
const NODE_RESERVED_KEYS: ReadonlySet<string> = new Set([
  "id",
  "type",
  "x",
  "y",
]);
const SOLID_RESERVED_KEYS: ReadonlySet<string> = new Set([
  "id",
  "type",
  "x",
  "y",
]);
// 'component' is deliberately NOT reserved: userComponent carries it.
const BRANCH_RESERVED_KEYS: ReadonlySet<string> = new Set([
  "id",
  "from",
  "to",
  "type",
]);
const CONDUCTOR_RESERVED_KEYS: ReadonlySet<string> = new Set([
  "id",
  "from",
  "to",
  "kind",
]);
const GROUP_RESERVED_KEYS: ReadonlySet<string> = new Set(["id", "x", "y"]);
const NOTE_RESERVED_KEYS: ReadonlySet<string> = new Set(["id", "x", "y"]);

/* ------------------------------------------------------------------ */
/* Serializer                                                          */
/* ------------------------------------------------------------------ */

export function serializeText(
  config: NetworkConfig,
  options?: SerializeOptions,
): string {
  return serializeTextWithLineMap(config, options).text;
}

export function serializeTextWithLineMap(
  config: NetworkConfig,
  options?: SerializeOptions,
): { text: string; lineMap: LineMap } {
  void options; // preset / showGeometry are reserved API surface; see SerializeOptions.
  const lines: string[] = [];
  const lineMap: LineMap = new Map();
  const pushEntity = (key: string, line: string): void => {
    lines.push(line);
    lineMap.set(key, { startLine: lines.length, endLine: lines.length });
  };
  /** Presence metadata: `<key>: []` iff the optional array is present AND empty. */
  const pushEmptyMarker = (
    key: OptionalEntityArrayKey,
    arr: readonly unknown[] | undefined,
  ): void => {
    if (arr !== undefined && arr.length === 0) lines.push(`${key}: []`);
  };

  lines.push(HEADER);
  lines.push(`network ${JSON.stringify(config.meta.name)} {`);

  // Singleton top-level fields, fixed order, present fields only.
  for (const key of FIELD_ORDER) {
    const value: unknown = config[key];
    if (value !== undefined) lines.push(`${key}: ${JSON.stringify(value)}`);
  }

  // Entities: fixed category order, config order within each array.  The
  // empty-array marker sits exactly where that category's records would.
  for (const node of config.nodes) {
    const { id, type, x, y, z, position, ...rest } = node;
    const pos = { ...position };
    if (z !== undefined && pos.z === undefined) pos.z = z;
    const data =
      Object.keys(pos).length > 0 ? { ...rest, position: pos } : rest;
    pushEntity(
      `node:${id}`,
      `node ${JSON.stringify(id)} ${type} @ (${JSON.stringify(x)}, ${JSON.stringify(y)}) data: ${JSON.stringify(data)}`,
    );
  }
  pushEmptyMarker("solidNodes", config.solidNodes);
  for (const solid of config.solidNodes ?? []) {
    const { id, type, x, y, ...rest } = solid;
    pushEntity(
      `solid:${id}`,
      `solid ${JSON.stringify(id)} ${type} @ (${JSON.stringify(x)}, ${JSON.stringify(y)}) data: ${JSON.stringify(rest)}`,
    );
  }
  for (const branch of config.branches) {
    const { id, label, initialMdot, from, to, component } = branch;
    const { type, ...componentFields } = component;
    const data = {
      ...(label === undefined ? {} : { label }),
      ...(initialMdot === undefined ? {} : { initialMdot }),
      ...componentFields,
    };
    pushEntity(
      `branch:${id}`,
      `branch ${JSON.stringify(id)}: ${JSON.stringify(from)} -> ${JSON.stringify(to)} ${type} data: ${JSON.stringify(data)}`,
    );
  }
  pushEmptyMarker("conductors", config.conductors);
  for (const conductor of config.conductors ?? []) {
    const { id, label, from, to, type } = conductor;
    const { kind, ...typeFields } = type;
    const data = label === undefined ? typeFields : { label, ...typeFields };
    pushEntity(
      `conductor:${id}`,
      `conductor ${JSON.stringify(id)}: ${JSON.stringify(from)} -> ${JSON.stringify(to)} ${kind} data: ${JSON.stringify(data)}`,
    );
  }
  pushEmptyMarker("groups", config.groups);
  for (const group of config.groups ?? []) {
    const { id, x, y, ...rest } = group;
    pushEntity(
      `group:${id}`,
      `group ${JSON.stringify(id)} @ (${JSON.stringify(x)}, ${JSON.stringify(y)}) data: ${JSON.stringify(rest)}`,
    );
  }
  pushEmptyMarker("notes", config.notes);
  for (const note of config.notes ?? []) {
    const { id, x, y, ...rest } = note;
    pushEntity(
      `note:${id}`,
      `note ${JSON.stringify(id)} @ (${JSON.stringify(x)}, ${JSON.stringify(y)}) data: ${JSON.stringify(rest)}`,
    );
  }

  lines.push("}");
  return { text: lines.join("\n") + "\n", lineMap };
}

/* ------------------------------------------------------------------ */
/* Parser — cursor helpers                                             */
/* ------------------------------------------------------------------ */

interface Cursor {
  /** The trimmed line being scanned. */
  text: string;
  pos: number;
}

function isWs(ch: string | undefined): boolean {
  return ch === " " || ch === "\t";
}

function skipWs(c: Cursor): void {
  while (isWs(c.text[c.pos])) c.pos++;
}

/** Consume at least one whitespace character. */
function requireWs(c: Cursor): boolean {
  const before = c.pos;
  skipWs(c);
  return c.pos > before;
}

/** Skip whitespace; true when nothing but whitespace remains on the line. */
function atLineEnd(c: Cursor): boolean {
  skipWs(c);
  return c.pos >= c.text.length;
}

function expectChar(c: Cursor, ch: string): boolean {
  if (c.text[c.pos] === ch) {
    c.pos++;
    return true;
  }
  return false;
}

/** Consume `literal` exactly (no word-boundary check — used for punctuation). */
function expectLiteral(c: Cursor, literal: string): boolean {
  if (c.text.startsWith(literal, c.pos)) {
    c.pos += literal.length;
    return true;
  }
  return false;
}

/** Consume `word` only when not immediately followed by another identifier char. */
function scanKeyword(c: Cursor, word: string): boolean {
  if (!c.text.startsWith(word, c.pos)) return false;
  const next = c.text[c.pos + word.length];
  if (next !== undefined && /[A-Za-z0-9]/.test(next)) return false;
  c.pos += word.length;
  return true;
}

function scanIdentifier(c: Cursor): string | null {
  const m = /^[A-Za-z][A-Za-z0-9]*/.exec(c.text.slice(c.pos));
  if (!m) return null;
  c.pos += m[0].length;
  return m[0];
}

/**
 * Scan a JSON string token starting at the cursor (which must be on '"').
 * Escape-aware: a '\\' skips the next character so '"' inside the string
 * never terminates the scan early; JSON.parse then validates the token
 * (legal escapes, no raw control characters) and produces the value.
 */
function scanJsonString(c: Cursor): string | null {
  if (c.text[c.pos] !== '"') return null;
  let i = c.pos + 1;
  while (i < c.text.length) {
    const ch = c.text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') {
      try {
        const value: unknown = JSON.parse(c.text.slice(c.pos, i + 1));
        if (typeof value !== "string") return null;
        c.pos = i + 1;
        return value;
      } catch {
        return null;
      }
    }
    i++;
  }
  return null;
}

/** Strict JSON number grammar (rejects NaN/Infinity, '+1', '.5', '1.', '01'). */
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

function scanNumber(c: Cursor): number | null {
  const m = NUMBER_RE.exec(c.text.slice(c.pos));
  if (!m) return null;
  const value = JSON.parse(m[0]) as number;
  if (!Number.isFinite(value)) return null; // e.g. 1e999 overflows to Infinity
  c.pos += m[0].length;
  return value;
}

/** Scan the shared `@ (<x>, <y>` prefix, leaving the closing token unread. */
function scanCoordPairPrefix(c: Cursor): [number, number] | null {
  skipWs(c);
  if (!expectChar(c, "@")) return null;
  skipWs(c);
  if (!expectChar(c, "(")) return null;
  skipWs(c);
  const x = scanNumber(c);
  if (x === null) return null;
  skipWs(c);
  if (!expectChar(c, ",")) return null;
  skipWs(c);
  const y = scanNumber(c);
  if (y === null) return null;
  skipWs(c);
  return [x, y];
}

function scanCoordList(c: Cursor): [number, number] | null {
  const pair = scanCoordPairPrefix(c);
  if (!pair) return null;
  if (!expectChar(c, ")")) return null;
  return pair;
}

/** Canvas `@ (x, y)` plus optional legacy third z / null. */
function scanNodeCoordList(
  c: Cursor,
): { x: number; y: number; z?: number | null } | null {
  const pair = scanCoordPairPrefix(c);
  if (!pair) return null;
  const [x, y] = pair;
  if (c.text[c.pos] === ",") {
    c.pos += 1;
    skipWs(c);
    let z: number | null;
    if (c.text.startsWith("null", c.pos)) {
      c.pos += 4;
      z = null;
    } else {
      const value = scanNumber(c);
      if (value === null) return null;
      z = value;
    }
    skipWs(c);
    if (!expectChar(c, ")")) return null;
    return { x, y, z };
  }
  if (!expectChar(c, ")")) return null;
  return { x, y };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ------------------------------------------------------------------ */
/* Semantic-error line attribution                                     */
/* ------------------------------------------------------------------ */

/**
 * validateNetwork returns flat message strings.  Dangling references name
 * the referencing entity; map those messages back to the entity's record
 * line via the line map.  Rules keyed by message prefix; first match wins.
 */
const SEMANTIC_ENTITY_PATTERNS: ReadonlyArray<
  readonly [RegExp, (id: string) => string]
> = [
  [/^Branch (\S+) references missing node/, (id) => `branch:${id}`],
  [/^Conductor (\S+) references missing node/, (id) => `conductor:${id}`],
  [/^Node (\S+) references unknown group/, (id) => `node:${id}`],
  [/^Solid node (\S+) references unknown group/, (id) => `solid:${id}`],
  [
    /^User component (\S+) references unknown componentLibrary entry/,
    (id) => `branch:${id}`,
  ],
];

/** Messages attributable to a singleton field line rather than an entity. */
const SEMANTIC_FIELD_PATTERNS: ReadonlyArray<readonly [RegExp, FieldKey]> = [
  [/^Logic rule /, "logic"],
  [/^Controllers? /, "controllers"],
  [/^Component library /, "componentLibrary"],
  [/^Register /, "registers"],
  [/^Reaction /, "species"],
  [/^Species transport /, "species"],
  [/^Named fluid /, "fluids"],
  [/^settings\./, "settings"],
];

function lineForSemanticError(
  message: string,
  lineMap: LineMap,
  fieldLines: Map<FieldKey, number>,
): number | undefined {
  for (const [re, keyOf] of SEMANTIC_ENTITY_PATTERNS) {
    const m = re.exec(message);
    if (m) {
      const line = lineMap.get(keyOf(m[1]))?.startLine;
      if (line !== undefined) return line;
    }
  }
  for (const [re, field] of SEMANTIC_FIELD_PATTERNS) {
    if (re.test(message)) {
      const line = fieldLines.get(field);
      if (line !== undefined) return line;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Parser — main entry                                                 */
/* ------------------------------------------------------------------ */

export function parseText(text: string, options?: ParseOptions): ParseResult {
  void options; // preset / showGeometry are reserved API surface; see ParseOptions.
  const errors: ParseError[] = [];
  const lineMap: LineMap = new Map();
  const fail = (line: number | undefined, message: string): void => {
    const error: ParseError = { message, severity: "error" };
    if (line !== undefined) error.line = line;
    errors.push(error);
  };

  // Accumulators are unknown-typed records: decodeNetworkConfig is the
  // structural boundary, validateNetwork the semantic one.
  const fields: Partial<Record<FieldKey, unknown>> = {};
  const fieldLines = new Map<FieldKey, number>();
  const seenFields = new Set<FieldKey>();
  const nodes: Array<Record<string, unknown>> = [];
  const solidNodes: Array<Record<string, unknown>> = [];
  const branches: Array<Record<string, unknown>> = [];
  const conductors: Array<Record<string, unknown>> = [];
  const groups: Array<Record<string, unknown>> = [];
  const notes: Array<Record<string, unknown>> = [];
  /** Empty-array presence markers: category -> line of the `<key>: []` line. */
  const emptyMarkers = new Map<OptionalEntityArrayKey, number>();
  /** Entity-array parse-order line numbers, for mapping decode-error paths. */
  const entityLines = {
    nodes: [] as number[],
    solidNodes: [] as number[],
    branches: [] as number[],
    conductors: [] as number[],
    groups: [] as number[],
    notes: [] as number[],
  };
  const zByNodeId = new Map<string, number>();

  /** Parse the shared `data: <jsonObject>` tail; null return = error pushed. */
  const parseDataPayload = (
    c: Cursor,
    lineNo: number,
    ctx: string,
    reservedKeys: ReadonlySet<string>,
  ): Record<string, unknown> | null => {
    if (!requireWs(c) || !scanKeyword(c, "data")) {
      fail(lineNo, `${ctx}: expected 'data: <JSON>'`);
      return null;
    }
    skipWs(c);
    if (!expectChar(c, ":")) {
      fail(lineNo, `${ctx}: expected ':' after 'data'`);
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(c.text.slice(c.pos).trim());
    } catch (e) {
      fail(lineNo, `${ctx}: malformed data JSON — ${errorMessage(e)}`);
      return null;
    }
    if (!isPlainObject(value)) {
      fail(lineNo, `${ctx}: data payload must be a JSON object`);
      return null;
    }
    for (const key of Object.keys(value)) {
      if (reservedKeys.has(key)) {
        fail(
          lineNo,
          `${ctx}: data payload contains reserved key ${JSON.stringify(key)}`,
        );
        return null;
      }
    }
    if (value.label !== undefined && typeof value.label !== "string") {
      fail(lineNo, `${ctx}: label must be a string`);
      return null;
    }
    if (
      value.initialMdot !== undefined &&
      (typeof value.initialMdot !== "number" ||
        !Number.isFinite(value.initialMdot))
    ) {
      fail(lineNo, `${ctx}: initialMdot must be a finite number`);
      return null;
    }
    return value;
  };

  const parseFieldLine = (key: FieldKey, c: Cursor, lineNo: number): void => {
    skipWs(c);
    if (!expectChar(c, ":")) {
      fail(lineNo, `'${key}' field: expected '<key>: <JSON>'`);
      return;
    }
    if (seenFields.has(key)) {
      fail(lineNo, `duplicate singleton block '${key}'`);
      return;
    }
    seenFields.add(key);
    let value: unknown;
    try {
      value = JSON.parse(c.text.slice(c.pos).trim());
    } catch (e) {
      fail(lineNo, `'${key}' field: malformed JSON — ${errorMessage(e)}`);
      return;
    }
    fields[key] = value;
    fieldLines.set(key, lineNo);
  };

  /**
   * Presence-metadata line `<key>: []` for an optional entity array.  Any
   * value other than the literal empty array is rejected; the conflict with
   * records of the same category is reported after the body scan.
   */
  const parseMarkerLine = (
    key: OptionalEntityArrayKey,
    c: Cursor,
    lineNo: number,
  ): void => {
    skipWs(c);
    if (!expectChar(c, ":")) {
      fail(lineNo, `'${key}' marker: expected '${key}: []'`);
      return;
    }
    if (emptyMarkers.has(key)) {
      fail(lineNo, `duplicate '${key}' marker`);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(c.text.slice(c.pos).trim());
    } catch (e) {
      fail(lineNo, `'${key}' marker: malformed JSON — ${errorMessage(e)}`);
      return;
    }
    if (!Array.isArray(value) || value.length !== 0) {
      fail(
        lineNo,
        `'${key}' marker must be the empty array literal '[]' (records already imply presence)`,
      );
      return;
    }
    emptyMarkers.set(key, lineNo);
  };

  const parseNodeRecord = (c: Cursor, lineNo: number): void => {
    if (!requireWs(c)) {
      fail(
        lineNo,
        "node record: expected `node <JSON-id> <type> @ (<x>, <y>) data: <JSON>`",
      );
      return;
    }
    const id = scanJsonString(c);
    if (id === null) {
      fail(lineNo, "node record: expected JSON-quoted id");
      return;
    }
    const ctx = `node ${JSON.stringify(id)}`;
    if (!requireWs(c)) {
      fail(lineNo, `${ctx}: expected node type ('internal' | 'boundary')`);
      return;
    }
    const type = scanIdentifier(c);
    if (type === null || !NODE_TYPES.has(type)) {
      fail(
        lineNo,
        type === null
          ? `${ctx}: expected node type ('internal' | 'boundary')`
          : `${ctx}: unknown node type ${JSON.stringify(type)} (expected 'internal' | 'boundary')`,
      );
      return;
    }
    if (!requireWs(c)) {
      fail(lineNo, `${ctx}: expected '@ (<x>, <y>)'`);
      return;
    }
    const coords = scanNodeCoordList(c);
    if (coords === null) {
      fail(
        lineNo,
        `${ctx}: malformed coordinates — expected '@ (<x>, <y>)' (legacy third z still accepted)`,
      );
      return;
    }
    const data = parseDataPayload(c, lineNo, ctx, NODE_RESERVED_KEYS);
    if (data === null) return;
    const node: Record<string, unknown> = {
      id,
      type,
      x: coords.x,
      y: coords.y,
    };
    if (coords.z !== undefined && coords.z !== null) node.z = coords.z;
    Object.assign(node, data);
    entityLines.nodes.push(lineNo);
    nodes.push(node);
    const pos = isPlainObject(node.position) ? node.position : undefined;
    const elev =
      typeof pos?.z === "number"
        ? pos.z
        : typeof node.z === "number"
          ? node.z
          : 0;
    zByNodeId.set(id, elev);
    lineMap.set(`node:${id}`, { startLine: lineNo, endLine: lineNo });
  };

  const parseSolidRecord = (c: Cursor, lineNo: number): void => {
    if (!requireWs(c)) {
      fail(
        lineNo,
        "solid record: expected `solid <JSON-id> <type> @ (<x>, <y>) data: <JSON>`",
      );
      return;
    }
    const id = scanJsonString(c);
    if (id === null) {
      fail(lineNo, "solid record: expected JSON-quoted id");
      return;
    }
    const ctx = `solid ${JSON.stringify(id)}`;
    if (!requireWs(c)) {
      fail(lineNo, `${ctx}: expected solid node type ('solid' | 'ambient')`);
      return;
    }
    const type = scanIdentifier(c);
    if (type === null || !SOLID_TYPES.has(type)) {
      fail(
        lineNo,
        type === null
          ? `${ctx}: expected solid node type ('solid' | 'ambient')`
          : `${ctx}: unknown solid node type ${JSON.stringify(type)} (expected 'solid' | 'ambient')`,
      );
      return;
    }
    if (!requireWs(c)) {
      fail(lineNo, `${ctx}: expected '@ (<x>, <y>)'`);
      return;
    }
    const coords = scanCoordList(c);
    if (coords === null) {
      fail(lineNo, `${ctx}: malformed coordinates — expected '@ (<x>, <y>)'`);
      return;
    }
    const [x, y] = coords as [number, number];
    const data = parseDataPayload(c, lineNo, ctx, SOLID_RESERVED_KEYS);
    if (data === null) return;
    entityLines.solidNodes.push(lineNo);
    solidNodes.push({ id, type, x, y, ...data });
    lineMap.set(`solid:${id}`, { startLine: lineNo, endLine: lineNo });
  };

  /** Shared scan for `branch`/`conductor` endpoints: `: <from> -> <to>`. */
  const scanEndpoints = (
    c: Cursor,
    lineNo: number,
    ctx: string,
  ): { from: string; to: string } | null => {
    skipWs(c);
    if (!expectChar(c, ":")) {
      fail(lineNo, `${ctx}: expected ':' after id`);
      return null;
    }
    skipWs(c);
    const from = scanJsonString(c);
    if (from === null) {
      fail(lineNo, `${ctx}: expected JSON-quoted 'from' id`);
      return null;
    }
    skipWs(c);
    if (!expectLiteral(c, "->")) {
      fail(lineNo, `${ctx}: expected '->'`);
      return null;
    }
    skipWs(c);
    const to = scanJsonString(c);
    if (to === null) {
      fail(lineNo, `${ctx}: expected JSON-quoted 'to' id`);
      return null;
    }
    return { from, to };
  };

  const parseBranchRecord = (c: Cursor, lineNo: number): void => {
    if (!requireWs(c)) {
      fail(
        lineNo,
        "branch record: expected `branch <JSON-id>: <JSON-from> -> <JSON-to> <component-type> data: <JSON>`",
      );
      return;
    }
    const id = scanJsonString(c);
    if (id === null) {
      fail(lineNo, "branch record: expected JSON-quoted id");
      return;
    }
    const ctx = `branch ${JSON.stringify(id)}`;
    const endpoints = scanEndpoints(c, lineNo, ctx);
    if (endpoints === null) return;
    if (!requireWs(c)) {
      fail(lineNo, `${ctx}: expected component type`);
      return;
    }
    const type = scanIdentifier(c);
    if (type === null) {
      fail(lineNo, `${ctx}: expected component type`);
      return;
    }
    if (!COMPONENT_TYPES.has(type)) {
      fail(lineNo, `${ctx}: unknown component type ${JSON.stringify(type)}`);
      return;
    }
    const data = parseDataPayload(c, lineNo, ctx, BRANCH_RESERVED_KEYS);
    if (data === null) return;
    const { label, initialMdot, ...componentFields } = data;
    const branch: Record<string, unknown> = {
      id,
      from: endpoints.from,
      to: endpoints.to,
    };
    if (label !== undefined) branch.label = label;
    if (initialMdot !== undefined) branch.initialMdot = initialMdot;
    branch.component = { type, ...componentFields };
    entityLines.branches.push(lineNo);
    branches.push(branch);
    lineMap.set(`branch:${id}`, { startLine: lineNo, endLine: lineNo });
  };

  const parseConductorRecord = (c: Cursor, lineNo: number): void => {
    if (!requireWs(c)) {
      fail(
        lineNo,
        "conductor record: expected `conductor <JSON-id>: <JSON-from> -> <JSON-to> <kind> data: <JSON>`",
      );
      return;
    }
    const id = scanJsonString(c);
    if (id === null) {
      fail(lineNo, "conductor record: expected JSON-quoted id");
      return;
    }
    const ctx = `conductor ${JSON.stringify(id)}`;
    const endpoints = scanEndpoints(c, lineNo, ctx);
    if (endpoints === null) return;
    if (!requireWs(c)) {
      fail(
        lineNo,
        `${ctx}: expected conductor kind ('conduction' | 'convection' | 'radiation')`,
      );
      return;
    }
    const kind = scanIdentifier(c);
    if (kind === null || !CONDUCTOR_KINDS.has(kind)) {
      fail(
        lineNo,
        kind === null
          ? `${ctx}: expected conductor kind ('conduction' | 'convection' | 'radiation')`
          : `${ctx}: unknown conductor kind ${JSON.stringify(kind)} (expected 'conduction' | 'convection' | 'radiation')`,
      );
      return;
    }
    const data = parseDataPayload(c, lineNo, ctx, CONDUCTOR_RESERVED_KEYS);
    if (data === null) return;
    const { label, ...typeFields } = data;
    const conductor: Record<string, unknown> = {
      id,
      from: endpoints.from,
      to: endpoints.to,
    };
    if (label !== undefined) conductor.label = label;
    conductor.type = { kind, ...typeFields };
    entityLines.conductors.push(lineNo);
    conductors.push(conductor);
    lineMap.set(`conductor:${id}`, { startLine: lineNo, endLine: lineNo });
  };

  const parseGroupRecord = (c: Cursor, lineNo: number): void => {
    if (!requireWs(c)) {
      fail(
        lineNo,
        "group record: expected `group <JSON-id> @ (<x>, <y>) data: <JSON>`",
      );
      return;
    }
    const id = scanJsonString(c);
    if (id === null) {
      fail(lineNo, "group record: expected JSON-quoted id");
      return;
    }
    const ctx = `group ${JSON.stringify(id)}`;
    if (!requireWs(c)) {
      fail(lineNo, `${ctx}: expected '@ (<x>, <y>)'`);
      return;
    }
    const coords = scanCoordList(c);
    if (coords === null) {
      fail(lineNo, `${ctx}: malformed coordinates — expected '@ (<x>, <y>)'`);
      return;
    }
    const [x, y] = coords as [number, number];
    const data = parseDataPayload(c, lineNo, ctx, GROUP_RESERVED_KEYS);
    if (data === null) return;
    entityLines.groups.push(lineNo);
    groups.push({ id, x, y, ...data });
    lineMap.set(`group:${id}`, { startLine: lineNo, endLine: lineNo });
  };

  const parseNoteRecord = (c: Cursor, lineNo: number): void => {
    if (!requireWs(c)) {
      fail(
        lineNo,
        "note record: expected `note <JSON-id> @ (<x>, <y>) data: <JSON>`",
      );
      return;
    }
    const id = scanJsonString(c);
    if (id === null) {
      fail(lineNo, "note record: expected JSON-quoted id");
      return;
    }
    const ctx = `note ${JSON.stringify(id)}`;
    if (!requireWs(c)) {
      fail(lineNo, `${ctx}: expected '@ (<x>, <y>)'`);
      return;
    }
    const coords = scanCoordList(c);
    if (coords === null) {
      fail(lineNo, `${ctx}: malformed coordinates — expected '@ (<x>, <y>)'`);
      return;
    }
    const [x, y] = coords as [number, number];
    const data = parseDataPayload(c, lineNo, ctx, NOTE_RESERVED_KEYS);
    if (data === null) return;
    entityLines.notes.push(lineNo);
    notes.push({ id, x, y, ...data });
    lineMap.set(`note:${id}`, { startLine: lineNo, endLine: lineNo });
  };

  const parseBodyLine = (line: string, lineNo: number): void => {
    const c: Cursor = { text: line, pos: 0 };
    const keyword = scanIdentifier(c);
    if (keyword === null) {
      fail(lineNo, `unrecognized line: ${JSON.stringify(line)}`);
      return;
    }
    switch (keyword) {
      case "node":
        parseNodeRecord(c, lineNo);
        return;
      case "solid":
        parseSolidRecord(c, lineNo);
        return;
      case "branch":
        parseBranchRecord(c, lineNo);
        return;
      case "conductor":
        parseConductorRecord(c, lineNo);
        return;
      case "group":
        parseGroupRecord(c, lineNo);
        return;
      case "note":
        parseNoteRecord(c, lineNo);
        return;
      default:
        if (FIELD_KEYS.has(keyword)) {
          parseFieldLine(keyword as FieldKey, c, lineNo);
        } else if (MARKER_KEYS.has(keyword)) {
          parseMarkerLine(keyword as OptionalEntityArrayKey, c, lineNo);
        } else {
          fail(lineNo, `unknown record keyword ${JSON.stringify(keyword)}`);
        }
    }
  };

  /** Map a ConfigDecodeError path ("settings", "nodes[2].x", ...) to a line. */
  const lineForDecodeError = (e: ConfigDecodeError): number | undefined => {
    const m = /^([A-Za-z]+)(?:\[(\d+)\])?/.exec(e.path);
    if (!m) return undefined;
    const root = m[1];
    if (m[2] !== undefined && root in entityLines) {
      const linesFor = entityLines[root as keyof typeof entityLines];
      return linesFor[Number(m[2])];
    }
    if (FIELD_KEYS.has(root)) return fieldLines.get(root as FieldKey);
    return undefined;
  };

  try {
    const lines = text.split("\n");

    // Line 1: exact header.
    if ((lines[0] ?? "").trimEnd() !== HEADER) {
      fail(
        1,
        `missing or malformed header: expected first line ${JSON.stringify(HEADER)}`,
      );
      return { errors, lineMap };
    }

    // Network line (first non-blank line after the header).
    let i = 1;
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) {
      fail(
        lines.length + 1,
        "missing network line: expected `network <JSON-quoted-name> {`",
      );
      return { errors, lineMap };
    }
    let name: string;
    {
      const lineNo = i + 1;
      const c: Cursor = { text: lines[i].trim(), pos: 0 };
      const keywordOk = scanKeyword(c, "network") && requireWs(c);
      const parsedName = keywordOk ? scanJsonString(c) : null;
      const braceOk = parsedName !== null && (skipWs(c), expectChar(c, "{"));
      if (parsedName === null || !braceOk || !atLineEnd(c)) {
        fail(
          lineNo,
          "malformed network line: expected `network <JSON-quoted-name> {`",
        );
        return { errors, lineMap };
      }
      name = parsedName;
      i++;
    }

    // Body lines until the closing brace.
    let closed = false;
    for (; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed === "") continue;
      if (trimmed === "}") {
        closed = true;
        i++;
        break;
      }
      parseBodyLine(trimmed, i + 1);
    }
    if (!closed) {
      fail(lines.length, `missing closing brace '}'`);
    } else {
      for (; i < lines.length; i++) {
        if (lines[i].trim() === "") continue;
        fail(i + 1, `unexpected content after closing brace '}'`);
        break;
      }
    }

    // Presence-marker conflicts: `<key>: []` contradicts records of the same
    // category (checked regardless of relative order in the body).
    const markerConflicts: Array<[OptionalEntityArrayKey, number]> = [
      ["solidNodes", solidNodes.length],
      ["conductors", conductors.length],
      ["groups", groups.length],
      ["notes", notes.length],
    ];
    for (const [key, count] of markerConflicts) {
      const markerLine = emptyMarkers.get(key);
      if (markerLine !== undefined && count > 0) {
        fail(
          markerLine,
          `'${key}' declared empty by marker but ${count} record(s) of that category are present`,
        );
      }
    }
    if (errors.length > 0) return { errors, lineMap };

    // Derived-elevation marker: "elevationChange": "derived" becomes
    // z_to - z_from (missing z counts as 0).  Unknown endpoints leave the
    // marker so validateNetwork reports the dangling reference instead.
    for (const branch of branches) {
      const component = branch.component as Record<string, unknown>;
      if (component.elevationChange === "derived") {
        const zFrom = zByNodeId.get(branch.from as string);
        const zTo = zByNodeId.get(branch.to as string);
        if (zFrom !== undefined && zTo !== undefined) {
          component.elevationChange = zTo - zFrom;
        }
      }
    }

    // Assemble in schema key order; optional fields omitted stay omitted,
    // optional arrays present-empty (via marker) stay present-empty.
    const assembled: Record<string, unknown> = { meta: { name, version: 2 } };
    if (fields.closureParams !== undefined)
      assembled.closureParams = fields.closureParams;
    if (fields.settings !== undefined) assembled.settings = fields.settings;
    if (fields.fluid !== undefined) assembled.fluid = fields.fluid;
    if (fields.fluids !== undefined) assembled.fluids = fields.fluids;
    if (fields.species !== undefined) assembled.species = fields.species;
    if (fields.registers !== undefined) assembled.registers = fields.registers;
    if (fields.logic !== undefined) assembled.logic = fields.logic;
    if (fields.controllers !== undefined)
      assembled.controllers = fields.controllers;
    if (fields.componentLibrary !== undefined)
      assembled.componentLibrary = fields.componentLibrary;
    assembled.nodes = nodes;
    if (solidNodes.length > 0 || emptyMarkers.has("solidNodes"))
      assembled.solidNodes = solidNodes;
    if (conductors.length > 0 || emptyMarkers.has("conductors"))
      assembled.conductors = conductors;
    if (groups.length > 0 || emptyMarkers.has("groups"))
      assembled.groups = groups;
    if (notes.length > 0 || emptyMarkers.has("notes")) assembled.notes = notes;
    assembled.branches = branches;

    // Structural boundary: convert thrown decode errors into parse errors.
    let config: NetworkConfig;
    try {
      config = decodeNetworkConfig(assembled);
    } catch (e) {
      fail(
        e instanceof ConfigDecodeError ? lineForDecodeError(e) : undefined,
        `config decode failed: ${errorMessage(e)}`,
      );
      return { errors, lineMap };
    }

    // Semantic validation: dangling refs, bad ranges, cross-field rules.
    let semanticErrors: string[];
    try {
      semanticErrors = validateNetwork(config);
    } catch (e) {
      fail(undefined, `validation failed unexpectedly: ${errorMessage(e)}`);
      return { errors, lineMap };
    }
    for (const message of semanticErrors) {
      fail(lineForSemanticError(message, lineMap, fieldLines), message);
    }
    if (errors.length > 0) return { errors, lineMap };
    return { config, errors, lineMap };
  } catch (e) {
    // Never-throw safety net: the parser must not crash on any input.
    return {
      errors: [
        {
          message: `internal parser error: ${errorMessage(e)}`,
          severity: "error",
        },
      ],
      lineMap,
    };
  }
}
