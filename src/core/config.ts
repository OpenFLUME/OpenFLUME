/**
 * Versioned runtime boundary decoder for NetworkConfig.
 *
 * validateNetwork (core/validate.ts) assumes a well-typed NetworkConfig and
 * THROWS on malformed input (null array elements, missing nested objects,
 * non-iterable "arrays").  decodeNetworkConfig is the boundary layer for
 * untrusted input — file uploads, localStorage hydration, worker run
 * messages.  It enforces just enough structure that validateNetwork never
 * crashes:
 *
 *   - the top-level value is a plain object;
 *   - meta is an object with a string name and the supported schema version
 *     (anything else is rejected explicitly);
 *   - settings / fluid are objects; nodes / branches are arrays of objects;
 *   - optional collections (solidNodes, conductors, groups, logic,
 *     controllers, species, registers, componentLibrary, closureParams,
 *     fluids)
 *     have the shapes validate walks;
 *   - the nested fields validate INDEXES or DESTRUCTURES (schedules, pump
 *     curves, dp/k tables, solid-property tables, branch.component,
 *     conductor.type, controller limits, …) are present with safe shapes.
 *
 * This is NOT exhaustive semantic validation: duplicate ids, ranges and
 * cross-references remain validateNetwork's job.
 */

import type { NetworkConfig } from "./schema";
import { FLUID_MODELS } from "./schema";
import { validateNetwork } from "./validate";
import {
  BINDABLE_COMPONENT_FIELDS,
  BINDABLE_CONDUCTOR_FIELDS,
  BINDABLE_CORRELATION_FIELDS,
  BINDABLE_NODE_FIELDS,
  BINDABLE_POSITION_AXES,
  BINDABLE_SOLID_FIELDS,
} from "./formulaFields";

/**
 * The canonical NetworkConfig schema version.  Decode accepts exactly this
 * version; anything else is rejected explicitly.
 */
export const SUPPORTED_CONFIG_VERSION = 2;

export type ConfigDecodeErrorCode =
  /** Top-level value (or a required object field) is not a plain object. */
  | "not-an-object"
  /** A required field is absent. */
  | "missing-field"
  /** A field is present but has the wrong shape. */
  | "invalid-type"
  /** meta.version is not a version this build supports. */
  | "unsupported-version";

/** Structured decode failure: `path` locates the value, `code` classifies the problem. */
export class ConfigDecodeError extends Error {
  readonly code: ConfigDecodeErrorCode;
  /** Dotted path to the offending value, e.g. "meta.version" or "nodes[2].component". */
  readonly path: string;

  constructor(code: ConfigDecodeErrorCode, path: string, message: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "ConfigDecodeError";
    this.code = code;
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/** Required plain-object field. */
function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) {
    throw new ConfigDecodeError(
      "missing-field",
      path,
      "required object is missing",
    );
  }
  if (!isRecord(value)) {
    throw new ConfigDecodeError(
      "invalid-type",
      path,
      `expected an object, got ${describe(value)}`,
    );
  }
  return value;
}

/** Required array field. */
function requireArray(value: unknown, path: string): unknown[] {
  if (value === undefined) {
    throw new ConfigDecodeError(
      "missing-field",
      path,
      "required array is missing",
    );
  }
  if (!Array.isArray(value)) {
    throw new ConfigDecodeError(
      "invalid-type",
      path,
      `expected an array, got ${describe(value)}`,
    );
  }
  return value;
}

/** Optional array field: absent is fine; present must be an array. */
function optionalArray(value: unknown, path: string): unknown[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ConfigDecodeError(
      "invalid-type",
      path,
      `expected an array, got ${describe(value)}`,
    );
  }
  return value;
}

/** Optional plain-object field: absent is fine; present must be an object. */
function optionalObject(
  value: unknown,
  path: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new ConfigDecodeError(
      "invalid-type",
      path,
      `expected an object, got ${describe(value)}`,
    );
  }
  return value;
}

/** Every element of `arr` must be a plain object; `check` runs per element. */
function checkElements(
  arr: unknown[],
  path: string,
  check?: (el: Record<string, unknown>, elPath: string) => void,
): void {
  for (let i = 0; i < arr.length; i++) {
    const elPath = `${path}[${i}]`;
    const el = arr[i];
    if (!isRecord(el)) {
      throw new ConfigDecodeError(
        "invalid-type",
        elPath,
        `expected an object, got ${describe(el)}`,
      );
    }
    check?.(el, elPath);
  }
}

/**
 * Schedule/table field ([[t, v], …] pairs).  validate INDEXES pair elements
 * (and destructures table rows), so a non-array pair would crash it.
 */
function checkPairs(value: unknown, path: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new ConfigDecodeError(
      "invalid-type",
      path,
      `expected an array of pairs, got ${describe(value)}`,
    );
  }
  for (let i = 0; i < value.length; i++) {
    if (!Array.isArray(value[i])) {
      throw new ConfigDecodeError(
        "invalid-type",
        `${path}[${i}]`,
        `expected a pair array, got ${describe(value[i])}`,
      );
    }
  }
}

/** Solid-property spec (number | { table } | { material } | { expression, tRange }
 *  | { timeTable }); only the table/timeTable row shapes can crash validate. */
function checkSolidPropertySpec(value: unknown, path: string): void {
  if (value === undefined || typeof value === "number") return;
  if (isRecord(value) && value.table !== undefined) {
    checkPairs(value.table, `${path}.table`);
  }
  if (isRecord(value) && value.timeTable !== undefined) {
    checkPairs(value.timeTable, `${path}.timeTable`);
  }
  if (isRecord(value) && value.tRange !== undefined) {
    // tRange is indexed only after an Array.isArray/length guard in validate,
    // but reject a non-array here so the failure carries a precise path.
    if (!Array.isArray(value.tRange) || value.tRange.length !== 2) {
      throw new ConfigDecodeError(
        "invalid-type",
        `${path}.tRange`,
        `expected a [Tmin, Tmax] pair, got ${describe(value.tRange)}`,
      );
    }
  }
  // Every other shape is reported by validateSolidPropertySpec itself.
}

/**
 * Formula-bindable field (schema NumberOrExpression): a finite number or a
 * formula object `{ expr: string }` with no extra keys.  Anything else at an
 * allowlisted position is malformed structural input.
 */
function checkNumberOrExpression(value: unknown, path: string): void {
  if (value === undefined) return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new ConfigDecodeError(
      "invalid-type",
      path,
      `expected a finite number, got ${describe(value)}`,
    );
  }
  if (isRecord(value)) {
    if (typeof value.expr === "string" && Object.keys(value).length === 1)
      return;
    if (value.expr !== undefined) {
      throw new ConfigDecodeError(
        "invalid-type",
        `${path}.expr`,
        `expression object's "expr" must be a string, got ${describe(value.expr)}`,
      );
    }
  }
  throw new ConfigDecodeError(
    "invalid-type",
    path,
    `expected a number or { expr: string }, got ${describe(value)}`,
  );
}

function checkPhysicalPosition(value: unknown, path: string): void {
  if (value === undefined) return;
  const pos = requireObject(value, path);
  for (const axis of BINDABLE_POSITION_AXES) {
    checkNumberOrExpression(pos[axis], `${path}.${axis}`);
  }
}

function migrateLegacyElevation(node: Record<string, unknown>): void {
  const z = node.z;
  delete node.z;
  if (typeof z !== "number" || !Number.isFinite(z)) return;
  const pos = isRecord(node.position) ? node.position : {};
  if (pos.z === undefined) pos.z = z;
  node.position = pos;
}

function checkFluidSpec(spec: Record<string, unknown>, path: string): void {
  if (
    typeof spec.model !== "string" ||
    !(FLUID_MODELS as readonly string[]).includes(spec.model)
  ) {
    throw new ConfigDecodeError(
      "invalid-type",
      `${path}.model`,
      `unknown fluid model ${describe(spec.model)}`,
    );
  }
}

function checkNode(node: Record<string, unknown>, path: string): void {
  if (node.type !== "internal" && node.type !== "boundary") {
    throw new ConfigDecodeError(
      "invalid-type",
      `${path}.type`,
      `expected "internal" or "boundary", got ${describe(node.type)}`,
    );
  }
  if (node.fluid !== undefined && typeof node.fluid !== "string") {
    throw new ConfigDecodeError(
      "invalid-type",
      `${path}.fluid`,
      `expected a string, got ${describe(node.fluid)}`,
    );
  }
  checkPairs(node.pressureSchedule, `${path}.pressureSchedule`);
  checkPairs(node.temperatureSchedule, `${path}.temperatureSchedule`);
  checkPhysicalPosition(node.position, `${path}.position`);
  for (const field of BINDABLE_NODE_FIELDS)
    checkNumberOrExpression(node[field], `${path}.${field}`);
  if (isRecord(node.gasCushion)) {
    checkNumberOrExpression(
      node.gasCushion.initialGasVolume,
      `${path}.gasCushion.initialGasVolume`,
    );
    checkNumberOrExpression(
      node.gasCushion.polytropicIndex,
      `${path}.gasCushion.polytropicIndex`,
    );
  }
}

function checkSolidNode(node: Record<string, unknown>, path: string): void {
  if (node.type !== "solid" && node.type !== "ambient") {
    throw new ConfigDecodeError(
      "invalid-type",
      `${path}.type`,
      `expected "solid" or "ambient", got ${describe(node.type)}`,
    );
  }
  checkPairs(node.temperatureSchedule, `${path}.temperatureSchedule`);
  checkSolidPropertySpec(node.cp, `${path}.cp`);
  checkPhysicalPosition(node.position, `${path}.position`);
  for (const field of BINDABLE_SOLID_FIELDS)
    checkNumberOrExpression(node[field], `${path}.${field}`);
}

function checkBranch(branch: Record<string, unknown>, path: string): void {
  // validate reads branch.component.type unconditionally.
  const component = requireObject(branch.component, `${path}.component`);
  const cPath = `${path}.component`;
  if (
    typeof component.type !== "string" ||
    !Object.hasOwn(BINDABLE_COMPONENT_FIELDS, component.type)
  ) {
    throw new ConfigDecodeError(
      "invalid-type",
      `${cPath}.type`,
      `unknown branch component type ${describe(component.type)}`,
    );
  }
  checkPairs(component.positionSchedule, `${cPath}.positionSchedule`);
  checkPairs(component.massFlowSchedule, `${cPath}.massFlowSchedule`);
  checkPairs(component.curve, `${cPath}.curve`);
  checkPairs(component.points, `${cPath}.points`);
  if (component.params !== undefined && !isRecord(component.params)) {
    throw new ConfigDecodeError(
      "invalid-type",
      `${cPath}.params`,
      `expected an object, got ${describe(component.params)}`,
    );
  }
  if (isRecord(component.k) && component.k.kTable !== undefined) {
    checkPairs(component.k.kTable, `${cPath}.k.kTable`);
  }
  // Formula-bindable geometry fields: number | { expr: string }.
  if (typeof component.type === "string") {
    for (const field of BINDABLE_COMPONENT_FIELDS[component.type] ?? []) {
      // Text projection temporarily preserves this marker when an endpoint is
      // missing so semantic validation can report the more useful dangling ref.
      if (field === "elevationChange" && component[field] === "derived")
        continue;
      checkNumberOrExpression(component[field], `${cPath}.${field}`);
    }
  }
}

function checkConductor(
  conductor: Record<string, unknown>,
  path: string,
): void {
  // validate reads conductor.type.kind unconditionally.
  const type = requireObject(conductor.type, `${path}.type`);
  if (
    typeof type.kind !== "string" ||
    !Object.hasOwn(BINDABLE_CONDUCTOR_FIELDS, type.kind)
  ) {
    throw new ConfigDecodeError(
      "invalid-type",
      `${path}.type.kind`,
      `unknown conductor kind ${describe(type.kind)}`,
    );
  }
  if (type.kind === "conduction") {
    // Constant-k formulas (`{ expr }`) resolve in paramBindings before
    // semantic validation; the T-dependent SolidPropertySpec shapes are
    // checked here so a malformed table cannot crash validate.
    const k = type.k;
    if (
      isRecord(k) &&
      typeof k.expr === "string" &&
      Object.keys(k).length === 1
    ) {
      /* formula — ok */
    } else {
      checkSolidPropertySpec(k, `${path}.type.k`);
    }
  }
  if (typeof type.kind === "string") {
    for (const field of BINDABLE_CONDUCTOR_FIELDS[type.kind] ?? []) {
      checkNumberOrExpression(type[field], `${path}.type.${field}`);
    }
  }
  if (isRecord(type.correlation)) {
    checkNumberOrExpression(
      type.correlation.diameter,
      `${path}.type.correlation.diameter`,
    );
    checkNumberOrExpression(
      type.correlation.flowArea,
      `${path}.type.correlation.flowArea`,
    );
    for (const field of BINDABLE_CORRELATION_FIELDS) {
      if (field === "diameter" || field === "flowArea") continue;
      checkNumberOrExpression(
        type.correlation[field],
        `${path}.type.correlation.${field}`,
      );
    }
    // 'custom' model: validate's finite-number walk needs a plain object.
    if (
      type.correlation.params !== undefined &&
      !isRecord(type.correlation.params)
    ) {
      throw new ConfigDecodeError(
        "invalid-type",
        `${path}.type.correlation.params`,
        `expected an object, got ${describe(type.correlation.params)}`,
      );
    }
  }
}

function checkNote(note: Record<string, unknown>, path: string): void {
  // The canvas and the text projection both render `text` as a string.
  if (typeof note.text !== "string") {
    throw new ConfigDecodeError(
      "invalid-type",
      `${path}.text`,
      `expected a string, got ${describe(note.text)}`,
    );
  }
  // Absent size means "auto"; a present size is used directly as a px box.
  for (const field of ["width", "height"] as const) {
    const value = note[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new ConfigDecodeError(
        "invalid-type",
        `${path}.${field}`,
        `expected a positive finite number, got ${describe(value)}`,
      );
    }
  }
}

function checkController(
  controller: Record<string, unknown>,
  path: string,
): void {
  // validate reads controller.limits.min/max without a null guard.
  optionalObject(controller.limits, `${path}.limits`);
}

function checkSpecies(species: Record<string, unknown>, path: string): void {
  for (const key of [
    "names",
    "molecularWeights",
    "cp",
    "formationEnthalpy",
    "viscosity",
  ] as const) {
    if (species[key] !== undefined && !Array.isArray(species[key])) {
      throw new ConfigDecodeError(
        "invalid-type",
        `${path}.${key}`,
        `expected an array, got ${describe(species[key])}`,
      );
    }
  }
  const reactions = optionalArray(species.reactions, `${path}.reactions`);
  if (reactions) {
    checkElements(reactions, `${path}.reactions`, (reaction, reactionPath) => {
      requireObject(reaction.reactants, `${reactionPath}.reactants`);
      requireObject(reaction.products, `${reactionPath}.products`);
    });
  }
}

/**
 * Decode untrusted input into a NetworkConfig, throwing ConfigDecodeError
 * (structured path/code/message) on any structural problem.  On success the
 * result is safe to pass to validateNetwork — it will report semantic
 * errors as strings instead of crashing.
 *
 * Schema versioning: any `meta.version` other than SUPPORTED_CONFIG_VERSION
 * is rejected with an 'unsupported-version' error.  This is a structural
 * boundary check only — duplicate ids, parameter ranges and cross-references
 * remain {@link validateNetwork}'s job.
 *
 * @param input - Untrusted value (file upload, localStorage hydration, worker message)
 * @returns The canonical v2 configuration
 * @throws {ConfigDecodeError} on unsupported schema versions or structural
 *   failures (missing or wrongly-typed objects, arrays, or nested fields)
 */
export function decodeNetworkConfig(input: unknown): NetworkConfig {
  if (!isRecord(input)) {
    throw new ConfigDecodeError(
      "not-an-object",
      "",
      `expected a config object, got ${describe(input)}`,
    );
  }

  // meta: object, string name, a supported schema version.
  const meta = requireObject(input.meta, "meta");
  if (meta.name === undefined) {
    throw new ConfigDecodeError(
      "missing-field",
      "meta.name",
      "required field is missing",
    );
  }
  if (typeof meta.name !== "string") {
    throw new ConfigDecodeError(
      "invalid-type",
      "meta.name",
      `expected a string, got ${describe(meta.name)}`,
    );
  }
  if (meta.version === undefined) {
    throw new ConfigDecodeError(
      "missing-field",
      "meta.version",
      "required field is missing",
    );
  }
  if (meta.version !== SUPPORTED_CONFIG_VERSION) {
    throw new ConfigDecodeError(
      "unsupported-version",
      "meta.version",
      `unsupported config version ${JSON.stringify(meta.version)} — this build supports version ${SUPPORTED_CONFIG_VERSION}`,
    );
  }

  // Required top-level structure validate walks unconditionally.
  const settings = requireObject(input.settings, "settings");
  if (settings.mode === undefined) {
    throw new ConfigDecodeError(
      "missing-field",
      "settings.mode",
      "required field is missing",
    );
  }
  if (settings.mode !== "steady" && settings.mode !== "transient") {
    throw new ConfigDecodeError(
      "invalid-type",
      "settings.mode",
      `expected "steady" or "transient", got ${describe(settings.mode)}`,
    );
  }
  const fluid = requireObject(input.fluid, "fluid");
  checkFluidSpec(fluid, "fluid");
  const fluids = optionalObject(input.fluids, "fluids");
  if (fluids) {
    for (const key of Object.keys(fluids)) {
      checkFluidSpec(
        requireObject(fluids[key], `fluids.${key}`),
        `fluids.${key}`,
      );
    }
  }
  checkElements(requireArray(input.nodes, "nodes"), "nodes", checkNode);
  checkElements(
    requireArray(input.branches, "branches"),
    "branches",
    checkBranch,
  );

  // Optional collections.
  const solidNodes = optionalArray(input.solidNodes, "solidNodes");
  if (solidNodes) checkElements(solidNodes, "solidNodes", checkSolidNode);
  const conductors = optionalArray(input.conductors, "conductors");
  if (conductors) checkElements(conductors, "conductors", checkConductor);
  const groups = optionalArray(input.groups, "groups");
  if (groups) checkElements(groups, "groups");
  const notes = optionalArray(input.notes, "notes");
  if (notes) checkElements(notes, "notes", checkNote);
  const logic = optionalArray(input.logic, "logic");
  if (logic) checkElements(logic, "logic");
  const controllers = optionalArray(input.controllers, "controllers");
  if (controllers) checkElements(controllers, "controllers", checkController);
  const species = optionalObject(input.species, "species");
  if (species) checkSpecies(species, "species");
  optionalObject(input.registers, "registers");
  optionalObject(input.closureParams, "closureParams");
  const componentLibrary = optionalObject(
    input.componentLibrary,
    "componentLibrary",
  );
  if (componentLibrary) {
    for (const key of Object.keys(componentLibrary)) {
      requireObject(componentLibrary[key], `componentLibrary.${key}`);
    }
  }

  // Structural safety is established.  Fold the Stage-1 `nodes[].z` alias
  // into `position.z` so the rest of the pipeline sees one field.
  const nodes = input.nodes;
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      if (isRecord(node)) migrateLegacyElevation(node);
    }
  }
  const solidNodesIn = input.solidNodes;
  if (Array.isArray(solidNodesIn)) {
    for (const node of solidNodesIn) {
      if (isRecord(node)) migrateLegacyElevation(node);
    }
  }

  return input as unknown as NetworkConfig;
}

export interface DecodedNetwork {
  config: NetworkConfig;
  /** Semantic validation errors from validateNetwork (empty = runnable). */
  errors: string[];
}

/**
 * Boundary decode + full semantic validation in one call.  Throws
 * ConfigDecodeError for malformed input; otherwise returns the decoded
 * config together with validateNetwork's error strings.
 */
export function decodeAndValidateNetwork(input: unknown): DecodedNetwork {
  const config = decodeNetworkConfig(input);
  return { config, errors: validateNetwork(config) };
}
