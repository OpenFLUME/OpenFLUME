/**
 * paramBindings.ts — STATIC model formula bindings.
 *
 * Scalar Property Panel inputs (an explicit allowlist, see schema.ts
 * NumberOrExpression) may hold a formula object instead of a literal SI
 * number:
 *
 *   volume: { expr: "pipe('seg1').volume" }
 *   area:   { expr: "pipe('seg1').surfaceArea" }
 *
 * Formulas are written in the SAFE expression language of
 * core/usercode/expression.ts (hand-written tokenizer/Pratt parser/tree
 * evaluator — no eval / new Function) and are resolved ONCE, at
 * validation/solve entry, against a STATIC view of the model.  They are
 * never evaluated during a transient step or a Newton iteration, so a
 * binding cannot feed solver state back into the residual/Jacobian.  The
 * solver always receives an immutable, fully-resolved numeric clone; the
 * user's model config keeps the formula objects untouched.
 *
 * STATIC SCOPE (all values SI):
 *   pipe('id')       → { length, diameter, roughness, elevationChange?,
 *                        area, volume, surfaceArea }   (area/volume/
 *                        surfaceArea derived from the RESOLVED length/diameter)
 *   heatedPipe('id') → pipe's set plus { ua, wallTemperature }
 *   bend('id')       → { diameter, angle, rOverD, roughness?, area }
 *   branch('id')     → the branch component's statically stored numeric
 *                      properties (any component type; no derived values)
 *   node('id')       → configured pressure, temperature, volume, heatInput,
 *                      position.{x,y,z} (and z as an alias of position.z;
 *                      never solved runtime state)
 *   conductor('id')  → the conductor's stored numeric properties
 *                      (conduction: k?, area, length — k when a plain
 *                      number or a `{ expr }` formula; table/material/
 *                      T-equation forms are not bindable; convection: h?,
 *                      area, correlation.{diameter, flowArea,
 *                      axialPosition, …}; radiation: emissivity,
 *                      area, viewFactor)
 *   solid('id')      → { mass?, temperature, position? }
 *   reg('name')      → initial register values only (config.registers);
 *                      logic-rule writes at solve time are NOT visible here
 *   helpers          → circleArea(d), circleDiameter(a),
 *                      cylinderVolume(L, d), cylinderArea(L, d), plus the
 *                      expression builtins (min/max/sqrt/…/pi)
 *
 * Reference ids must be string LITERALS: pipe('seg1'), never pipe(name).
 * Unknown ids, unknown properties, entity-type mismatches, non-finite
 * results, and dependency cycles (self or multi-field) are all reported as
 * readable, field-path-attributed error strings.
 *
 * Deliberately NOT in scope (static-phase enforcement): t, dt, solver state
 * (P/T/rho/mdot/…), and logic-mutated registers.  Referencing them fails
 * with the expression engine's "Unknown identifier" error.
 */

import type {
  Conductor,
  NetworkConfig,
  ResolvedNetworkConfig,
  SolidNode,
} from "./schema";
import {
  BINDABLE_COMPONENT_FIELDS,
  BINDABLE_CONDUCTOR_FIELDS,
  BINDABLE_CORRELATION_FIELDS,
  BINDABLE_NODE_FIELDS,
  BINDABLE_POSITION_AXES,
  BINDABLE_SOLID_FIELDS,
} from "./formulaFields";
import { withDerivedGeometry } from "./geometry";
import {
  compileExpression,
  ExpressionError,
  type CompiledExpression,
  type ExprNode,
  type ExprScope,
} from "./usercode/expression";

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Result of static parameter resolution.  On success, `config` is the
 * resolved network (the SAME reference as the input when no formulas were
 * present — the fast path — otherwise an immutable deep clone with every
 * formula object replaced by a finite SI number) and `resolved` maps each
 * bound field path (e.g. "branch 'seg1'.diameter") to its resolved value.
 */
export type ParameterResolution =
  | {
      ok: true;
      config: ResolvedNetworkConfig;
      resolved: Record<string, number>;
    }
  | { ok: false; errors: string[] };

/** Type guard for the formula-object form `{ expr: string }`. */
export function isParameterExpression(
  value: unknown,
): value is { expr: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { expr?: unknown }).expr === "string"
  );
}

/**
 * Resolve every formula-bound field of `config` against the static model
 * scope.  Pure: the input is never mutated.
 *
 * Fast path: a config with zero formula objects is returned BY REFERENCE
 * with an empty `resolved` map — existing literal configs keep exact
 * behaviour (and identity) through validateNetwork / solveSteady /
 * solveTransient.
 *
 * This function NEVER calls validateNetwork (no recursive validation);
 * validateNetwork calls this, then validates the resolved clone.
 */
export function resolveNetworkParameters(
  config: NetworkConfig,
): ParameterResolution {
  const { bindings, errors } = collectBindings(config);
  if (errors.length > 0) return { ok: false, errors };
  if (bindings.length === 0) {
    // No formula objects at any bindable position: apply derived geometry
    // (may clone) then return.  Identity is preserved when nothing is filled.
    return {
      ok: true,
      config: withDerivedGeometry(config) as ResolvedNetworkConfig,
      resolved: {},
    };
  }

  const index = buildModelIndex(config);

  // Compile + statically analyze each binding (literal-id enforcement,
  // entity/property checks, dependency edges to other bound fields).
  const compiled = new Map<string, CompiledExpression>();
  const deps = new Map<string, Set<string>>();
  const boundPaths = new Set(bindings.map((b) => b.path));
  for (const binding of bindings) {
    let ast: CompiledExpression;
    try {
      ast = compileExpression(binding.expr);
    } catch (e) {
      errors.push(`Parameter binding ${binding.path}: ${errorMessage(e)}`);
      continue;
    }
    compiled.set(binding.path, ast);
    const analysis = analyzeExpression(ast.ast, binding.path, index);
    errors.push(...analysis.errors);
    deps.set(
      binding.path,
      new Set([...analysis.deps].filter((d) => boundPaths.has(d))),
    );
  }
  if (errors.length > 0) return { ok: false, errors };

  // Dependency graph → topological evaluation order; cycles are readable.
  const order = topologicalOrder(
    bindings.map((b) => b.path),
    deps,
  );
  if (!order.ok) return { ok: false, errors: [order.error] };

  // Evaluate dependencies-first against the static scope.  A binding whose
  // own dependency failed is skipped quietly — the root error is already
  // reported and a secondary "depends on …" message adds no information.
  const resolvedSoFar = new Map<string, number>();
  const scope = buildStaticScope(config, index, resolvedSoFar);
  const failed = new Set<string>();
  const bindingByPath = new Map(bindings.map((b) => [b.path, b]));
  for (const path of order.paths) {
    const bindingDeps = deps.get(path)!;
    if ([...bindingDeps].some((d) => failed.has(d))) {
      failed.add(path);
      continue;
    }
    try {
      const value = compiled.get(path)!.evaluateNumber(scope);
      if (!Number.isFinite(value)) {
        throw new ExpressionError(
          "evaluate",
          `expression evaluated to ${String(value)}, which is not a finite number`,
        );
      }
      resolvedSoFar.set(path, value);
    } catch (e) {
      errors.push(`Parameter binding ${path}: ${errorMessage(e)}`);
      failed.add(path);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // Immutable resolved clone: apply each resolved number into a deep copy,
  // then deep-freeze so the solver can never mutate the shared snapshot.
  const clone = structuredClone(config);
  for (const binding of bindings) {
    bindingByPath
      .get(binding.path)!
      .apply(clone, resolvedSoFar.get(binding.path)!);
  }
  const withGeom = withDerivedGeometry(clone);
  deepFreeze(withGeom);
  return {
    ok: true,
    config: withGeom as unknown as ResolvedNetworkConfig,
    resolved: Object.fromEntries(resolvedSoFar),
  };
}

/**
 * UI-facing alias of {@link resolveNetworkParameters} — same pure,
 * non-throwing contract; intended for property-panel/sweep previews that
 * want to display resolved values without running validation.
 */
export function previewNetworkParameters(
  config: NetworkConfig,
): ParameterResolution {
  return resolveNetworkParameters(config);
}

/**
 * Evaluate one static expression against `config`'s model scope. Existing
 * formula bindings are resolved first (same as {@link previewNetworkParameters});
 * the expression itself need not be stored on a bindable field.
 *
 * Used by the property-panel preview when the field's `{ expr }` is known
 * but the snapshot's `resolved` map does not list that field path.
 */
export function evaluateStaticExpression(
  config: NetworkConfig,
  expr: string,
): { ok: true; value: number } | { ok: false; errors: string[] } {
  const resolution = resolveNetworkParameters(config);
  const forScope = (
    resolution.ok ? resolution.config : config
  ) as NetworkConfig;
  const index = buildModelIndex(forScope);
  const resolvedSoFar = new Map<string, number>(
    resolution.ok ? Object.entries(resolution.resolved) : [],
  );
  const scope = buildStaticScope(forScope, index, resolvedSoFar);
  try {
    const value = compileExpression(expr).evaluateNumber(scope);
    if (!Number.isFinite(value)) {
      return {
        ok: false,
        errors: [
          `expression evaluated to ${String(value)}, which is not a finite number`,
        ],
      };
    }
    return { ok: true, value };
  } catch (e) {
    return { ok: false, errors: [errorMessage(e)] };
  }
}

/** Readable field paths — used in `resolved` keys and error messages. */
const nodePath = (id: string, field: string): string => `node '${id}'.${field}`;
const branchPath = (id: string, field: string): string =>
  `branch '${id}'.${field}`;
const conductorPath = (id: string, field: string): string =>
  `conductor '${id}'.${field}`;
const solidPath = (id: string, field: string): string =>
  `solid '${id}'.${field}`;

/* ------------------------------------------------------------------ */
/* Binding collection                                                  */
/* ------------------------------------------------------------------ */

interface BindingSite {
  path: string;
  expr: string;
  /** Write the resolved number into a (mutable) config clone. */
  apply(target: NetworkConfig, value: number): void;
}

type Branch = NetworkConfig["branches"][number];
type FluidNode = NetworkConfig["nodes"][number];

function collectBindings(config: NetworkConfig): {
  bindings: BindingSite[];
  errors: string[];
} {
  const bindings: BindingSite[] = [];
  const errors: string[] = [];

  const visit = (
    value: unknown,
    path: string,
    apply: (target: NetworkConfig, v: number) => void,
  ): void => {
    if (value === undefined) return;
    if (isParameterExpression(value)) {
      bindings.push({ path, expr: value.expr, apply });
    } else if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(
        `Parameter binding ${path}: expected a number or { expr: string }`,
      );
    }
  };

  config.nodes.forEach((node, i) => {
    for (const field of BINDABLE_NODE_FIELDS) {
      visit(node[field], nodePath(node.id, field), (t, v) => {
        (t.nodes[i] as unknown as Record<string, unknown>)[field] = v;
      });
    }
    for (const axis of BINDABLE_POSITION_AXES) {
      visit(
        node.position?.[axis],
        nodePath(node.id, `position.${axis}`),
        (t, v) => {
          t.nodes[i].position![axis] = v;
        },
      );
    }
    if (node.gasCushion)
      for (const field of ["initialGasVolume", "polytropicIndex"] as const) {
        visit(
          node.gasCushion[field],
          nodePath(node.id, `gasCushion.${field}`),
          (t, v) => {
            (t.nodes[i].gasCushion as unknown as Record<string, unknown>)[
              field
            ] = v;
          },
        );
      }
  });

  (config.solidNodes ?? []).forEach((solid, i) => {
    for (const field of BINDABLE_SOLID_FIELDS) {
      visit(solid[field], solidPath(solid.id, field), (t, v) => {
        ((t.solidNodes ?? [])[i] as unknown as Record<string, unknown>)[field] =
          v;
      });
    }
    for (const axis of BINDABLE_POSITION_AXES) {
      visit(
        solid.position?.[axis],
        solidPath(solid.id, `position.${axis}`),
        (t, v) => {
          (t.solidNodes ?? [])[i].position![axis] = v;
        },
      );
    }
  });

  config.branches.forEach((branch, i) => {
    const comp = branch.component as unknown as Record<string, unknown>;
    for (const field of BINDABLE_COMPONENT_FIELDS[branch.component.type] ??
      []) {
      if (field === "elevationChange" && comp[field] === "derived") continue;
      visit(comp[field], branchPath(branch.id, field), (t, v) => {
        (t.branches[i].component as unknown as Record<string, unknown>)[field] =
          v;
      });
    }
  });

  (config.conductors ?? []).forEach((conductor, i) => {
    const type = conductor.type as unknown as Record<string, unknown>;
    for (const field of BINDABLE_CONDUCTOR_FIELDS[conductor.type.kind] ?? []) {
      visit(type[field], conductorPath(conductor.id, field), (t, v) => {
        (
          ((t.conductors ?? [])[i] as Conductor).type as unknown as Record<
            string,
            unknown
          >
        )[field] = v;
      });
    }
    // Conduction k is a SolidPropertySpec (number | table | material |
    // T-equation | timeTable) OR a constant `{ expr }` formula.  Only the
    // formula form is a binding; the other shapes stay for the thermal
    // property machinery.
    if (
      conductor.type.kind === "conduction" &&
      isParameterExpression(conductor.type.k)
    ) {
      visit(conductor.type.k, conductorPath(conductor.id, "k"), (t, v) => {
        const ct = ((t.conductors ?? [])[i] as Conductor).type;
        if (ct.kind === "conduction") ct.k = v;
      });
    }
    if (conductor.type.kind === "convection" && conductor.type.correlation) {
      for (const field of BINDABLE_CORRELATION_FIELDS) {
        visit(
          conductor.type.correlation[
            field as keyof typeof conductor.type.correlation
          ],
          conductorPath(conductor.id, `correlation.${field}`),
          (t, v) => {
            const ct = ((t.conductors ?? [])[i] as Conductor).type;
            if (ct.kind === "convection" && ct.correlation) {
              (ct.correlation as unknown as Record<string, unknown>)[field] = v;
            }
          },
        );
      }
    }
  });

  return { bindings, errors };
}

/* ------------------------------------------------------------------ */
/* Model index + static-scope views                                    */
/* ------------------------------------------------------------------ */

interface ModelIndex {
  branches: Map<string, Branch>;
  nodes: Map<string, FluidNode>;
  conductors: Map<string, Conductor>;
  solids: Map<string, SolidNode>;
  registers: Record<string, number>;
}

function buildModelIndex(config: NetworkConfig): ModelIndex {
  return {
    branches: new Map(config.branches.map((b) => [b.id, b])),
    nodes: new Map(config.nodes.map((n) => [n.id, n])),
    conductors: new Map((config.conductors ?? []).map((c) => [c.id, c])),
    solids: new Map((config.solidNodes ?? []).map((s) => [s.id, s])),
    registers: config.registers ?? {},
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof ExpressionError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/** Recursively freeze a resolved config clone (plain JSON tree). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Build a plain object whose properties are computed lazily on access. */
function lazyView(
  getters: Record<string, () => unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, get] of Object.entries(getters)) {
    Object.defineProperty(out, key, { enumerable: true, get });
  }
  return out;
}

/**
 * Build the static expression scope.  `resolvedSoFar` is read through the
 * closures, so accessors always see the values of already-resolved
 * dependency fields (evaluation runs in topological order).
 */
function buildStaticScope(
  config: NetworkConfig,
  index: ModelIndex,
  resolvedSoFar: Map<string, number>,
): ExprScope {
  const literalNumber = (v: unknown, what: string): number => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    throw new ExpressionError("evaluate", `${what} is not a finite number`);
  };
  /** Value of a possibly-bound field: resolved value wins, else literal. */
  const fieldNumber = (
    path: string,
    literal: unknown,
    what: string,
  ): number => {
    const resolved = resolvedSoFar.get(path);
    if (resolved !== undefined) return resolved;
    if (isParameterExpression(literal)) {
      // Topological order guarantees the dependency resolved first; reaching
      // this means a bug in the dependency analysis — fail loudly.
      throw new ExpressionError(
        "evaluate",
        `${what} has not been resolved yet (internal ordering error)`,
      );
    }
    return literalNumber(literal, what);
  };
  const idArg = (v: unknown, kind: string): string => {
    if (typeof v !== "string") {
      throw new ExpressionError(
        "evaluate",
        `${kind}(...) requires a string-literal id`,
      );
    }
    return v;
  };
  const numArg = (v: unknown, name: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new ExpressionError(
        "evaluate",
        `${name} requires finite number arguments`,
      );
    }
    return v;
  };
  const circleAreaOf = (d: number): number => (Math.PI * d * d) / 4;

  const branchOf = (kind: string, id: string): Branch => {
    const b = index.branches.get(id);
    if (!b)
      throw new ExpressionError(
        "evaluate",
        `${kind}('${id}') references unknown branch '${id}'`,
      );
    if (kind !== "branch" && b.component.type !== kind) {
      throw new ExpressionError(
        "evaluate",
        `${kind}('${id}') type mismatch: branch '${id}' is a ${b.component.type}`,
      );
    }
    return b;
  };

  const pipeGetters = (b: Branch): Record<string, () => number> => {
    const c = b.component as Extract<Branch["component"], { type: "pipe" }>;
    const L = () =>
      fieldNumber(
        branchPath(b.id, "length"),
        c.length,
        `pipe('${b.id}').length`,
      );
    const d = () =>
      fieldNumber(
        branchPath(b.id, "diameter"),
        c.diameter,
        `pipe('${b.id}').diameter`,
      );
    const getters: Record<string, () => number> = {
      length: L,
      diameter: d,
      roughness: () =>
        fieldNumber(
          branchPath(b.id, "roughness"),
          c.roughness,
          `pipe('${b.id}').roughness`,
        ),
      area: () => circleAreaOf(d()),
      volume: () => L() * circleAreaOf(d()),
      surfaceArea: () => Math.PI * d() * L(),
    };
    if (c.elevationChange !== undefined) {
      getters.elevationChange = () =>
        fieldNumber(
          branchPath(b.id, "elevationChange"),
          c.elevationChange,
          `pipe('${b.id}').elevationChange`,
        );
    }
    return getters;
  };

  const heatedPipeGetters = (b: Branch): Record<string, () => number> => {
    const c = b.component as Extract<
      Branch["component"],
      { type: "heatedPipe" }
    >;
    return {
      ...pipeGetters(b),
      ua: () =>
        fieldNumber(branchPath(b.id, "ua"), c.ua, `heatedPipe('${b.id}').ua`),
      wallTemperature: () =>
        fieldNumber(
          branchPath(b.id, "wallTemperature"),
          c.wallTemperature,
          `heatedPipe('${b.id}').wallTemperature`,
        ),
    };
  };

  const bendGetters = (b: Branch): Record<string, () => number> => {
    const c = b.component as Extract<Branch["component"], { type: "bend" }>;
    const d = () =>
      fieldNumber(
        branchPath(b.id, "diameter"),
        c.diameter,
        `bend('${b.id}').diameter`,
      );
    const getters: Record<string, () => number> = {
      diameter: d,
      angle: () => literalNumber(c.angle, `bend('${b.id}').angle`),
      rOverD: () =>
        fieldNumber(
          branchPath(b.id, "rOverD"),
          c.rOverD,
          `bend('${b.id}').rOverD`,
        ),
      area: () => circleAreaOf(d()),
    };
    if (c.roughness !== undefined) {
      getters.roughness = () =>
        fieldNumber(
          branchPath(b.id, "roughness"),
          c.roughness,
          `bend('${b.id}').roughness`,
        );
    }
    return getters;
  };

  /** branch('id'): statically STORED numeric component properties only. */
  const branchGetters = (b: Branch): Record<string, () => number> => {
    const c = b.component as unknown as Record<string, unknown>;
    const bindable = BINDABLE_COMPONENT_FIELDS[b.component.type] ?? [];
    const getters: Record<string, () => number> = {};
    for (const key of Object.keys(c)) {
      if (key === "type") continue;
      const v = c[key];
      if (typeof v === "number") {
        getters[key] = () => literalNumber(v, `branch('${b.id}').${key}`);
      } else if (isParameterExpression(v) && bindable.includes(key)) {
        const p = branchPath(b.id, key);
        getters[key] = () => fieldNumber(p, v, `branch('${b.id}').${key}`);
      }
      // Tables, schedules, strings, booleans, {kTable}, params: not numeric
      // static properties — simply not exposed.
    }
    return getters;
  };

  const nodeGetters = (n: FluidNode): Record<string, () => unknown> => {
    const getters: Record<string, () => unknown> = {};
    for (const key of ["pressure", "temperature", "heatInput"] as const) {
      if (n[key] !== undefined)
        getters[key] = () =>
          fieldNumber(nodePath(n.id, key), n[key], `node('${n.id}').${key}`);
    }
    if (n.volume !== undefined) {
      getters.volume = () =>
        fieldNumber(
          nodePath(n.id, "volume"),
          n.volume,
          `node('${n.id}').volume`,
        );
    }
    const pos = n.position;
    const z = pos?.z ?? n.z;
    if (pos !== undefined || z !== undefined) {
      const posGetters: Record<string, () => number> = {};
      if (pos?.x !== undefined) {
        posGetters.x = () =>
          fieldNumber(
            nodePath(n.id, "position.x"),
            pos.x,
            `node('${n.id}').position.x`,
          );
      }
      if (pos?.y !== undefined) {
        posGetters.y = () =>
          fieldNumber(
            nodePath(n.id, "position.y"),
            pos.y,
            `node('${n.id}').position.y`,
          );
      }
      if (z !== undefined) {
        const getZ = () =>
          fieldNumber(
            nodePath(n.id, "position.z"),
            z,
            `node('${n.id}').position.z`,
          );
        posGetters.z = getZ;
        getters.z = getZ;
      }
      if (Object.keys(posGetters).length > 0)
        getters.position = () => lazyView(posGetters);
    }
    return getters;
  };

  const conductorGetters = (c: Conductor): Record<string, () => unknown> => {
    const t = c.type;
    const field = (name: string, literal: unknown) =>
      fieldNumber(
        conductorPath(c.id, name),
        literal,
        `conductor('${c.id}').${name}`,
      );
    if (t.kind === "conduction") {
      const getters: Record<string, () => number> = {
        area: () => field("area", t.area),
        length: () => field("length", t.length),
      };
      if (typeof t.k === "number") {
        getters.k = () =>
          literalNumber(t.k as number, `conductor('${c.id}').k`);
      }
      return getters;
    }
    if (t.kind === "convection") {
      const getters: Record<string, () => unknown> = {
        area: () => field("area", t.area),
      };
      if (t.h !== undefined) {
        getters.h = () => field("h", t.h);
      }
      if (t.correlation) {
        const corr = t.correlation;
        const corrGetters: Record<string, () => number> = {
          diameter: () =>
            fieldNumber(
              conductorPath(c.id, "correlation.diameter"),
              corr.diameter,
              `conductor('${c.id}').correlation.diameter`,
            ),
        };
        if (corr.flowArea !== undefined) {
          corrGetters.flowArea = () =>
            fieldNumber(
              conductorPath(c.id, "correlation.flowArea"),
              corr.flowArea,
              `conductor('${c.id}').correlation.flowArea`,
            );
        }
        if (corr.axialPosition !== undefined) {
          corrGetters.axialPosition = () =>
            fieldNumber(
              conductorPath(c.id, "correlation.axialPosition"),
              corr.axialPosition,
              `conductor('${c.id}').correlation.axialPosition`,
            );
        }
        if (corr.inletLiquidReynolds !== undefined) {
          corrGetters.inletLiquidReynolds = () =>
            fieldNumber(
              conductorPath(c.id, "correlation.inletLiquidReynolds"),
              corr.inletLiquidReynolds,
              `conductor('${c.id}').correlation.inletLiquidReynolds`,
            );
        }
        if (corr.segmentLength !== undefined) {
          corrGetters.segmentLength = () =>
            fieldNumber(
              conductorPath(c.id, "correlation.segmentLength"),
              corr.segmentLength,
              `conductor('${c.id}').correlation.segmentLength`,
            );
        }
        if (corr.frontEnergyFactor !== undefined) {
          corrGetters.frontEnergyFactor = () =>
            fieldNumber(
              conductorPath(c.id, "correlation.frontEnergyFactor"),
              corr.frontEnergyFactor,
              `conductor('${c.id}').correlation.frontEnergyFactor`,
            );
        }
        if (corr.rewetHysteresisOffsetK !== undefined) {
          corrGetters.rewetHysteresisOffsetK = () =>
            fieldNumber(
              conductorPath(c.id, "correlation.rewetHysteresisOffsetK"),
              corr.rewetHysteresisOffsetK,
              `conductor('${c.id}').correlation.rewetHysteresisOffsetK`,
            );
        }
        getters.correlation = () => lazyView(corrGetters);
      }
      return getters;
    }
    // radiation
    const rad = t as Extract<Conductor["type"], { kind: "radiation" }>;
    return {
      emissivity: () => field("emissivity", rad.emissivity),
      area: () => field("area", rad.area),
      viewFactor: () => field("viewFactor", rad.viewFactor),
    };
  };

  const solidGetters = (s: SolidNode): Record<string, () => unknown> => {
    const getters: Record<string, () => unknown> = {
      temperature: () =>
        fieldNumber(
          solidPath(s.id, "temperature"),
          s.temperature,
          `solid('${s.id}').temperature`,
        ),
    };
    if (s.mass !== undefined) {
      getters.mass = () =>
        fieldNumber(solidPath(s.id, "mass"), s.mass, `solid('${s.id}').mass`);
    }
    if (s.heatInput !== undefined) {
      getters.heatInput = () =>
        fieldNumber(
          solidPath(s.id, "heatInput"),
          s.heatInput,
          `solid('${s.id}').heatInput`,
        );
    }
    const pos = s.position;
    if (pos !== undefined) {
      const posGetters: Record<string, () => number> = {};
      for (const axis of BINDABLE_POSITION_AXES) {
        if (pos[axis] !== undefined) {
          posGetters[axis] = () =>
            fieldNumber(
              solidPath(s.id, `position.${axis}`),
              pos[axis],
              `solid('${s.id}').position.${axis}`,
            );
        }
      }
      if (Object.keys(posGetters).length > 0)
        getters.position = () => lazyView(posGetters);
    }
    return getters;
  };

  return {
    pipe: (id: unknown) =>
      lazyView(pipeGetters(branchOf("pipe", idArg(id, "pipe")))),
    heatedPipe: (id: unknown) =>
      lazyView(
        heatedPipeGetters(branchOf("heatedPipe", idArg(id, "heatedPipe"))),
      ),
    bend: (id: unknown) =>
      lazyView(bendGetters(branchOf("bend", idArg(id, "bend")))),
    branch: (id: unknown) =>
      lazyView(branchGetters(branchOf("branch", idArg(id, "branch")))),
    node: (id: unknown) => {
      const nid = idArg(id, "node");
      const n = index.nodes.get(nid);
      if (!n)
        throw new ExpressionError(
          "evaluate",
          `node('${nid}') references unknown fluid node '${nid}'`,
        );
      return lazyView(nodeGetters(n));
    },
    conductor: (id: unknown) => {
      const cid = idArg(id, "conductor");
      const c = index.conductors.get(cid);
      if (!c)
        throw new ExpressionError(
          "evaluate",
          `conductor('${cid}') references unknown conductor '${cid}'`,
        );
      return lazyView(conductorGetters(c));
    },
    solid: (id: unknown) => {
      const sid = idArg(id, "solid");
      const s = index.solids.get(sid);
      if (!s)
        throw new ExpressionError(
          "evaluate",
          `solid('${sid}') references unknown solid node '${sid}'`,
        );
      return lazyView(solidGetters(s));
    },
    reg: (name: unknown) => {
      const key = idArg(name, "reg");
      const v = index.registers[key];
      // INITIAL registers only: logic-rule writes during a solve are not
      // visible to static bindings.
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new ExpressionError(
          "evaluate",
          `reg('${key}') references unknown register '${key}'`,
        );
      }
      return v;
    },
    circleArea: (d: unknown) => circleAreaOf(numArg(d, "circleArea")),
    circleDiameter: (a: unknown) =>
      Math.sqrt((4 * numArg(a, "circleDiameter")) / Math.PI),
    cylinderVolume: (L: unknown, d: unknown) =>
      numArg(L, "cylinderVolume") * circleAreaOf(numArg(d, "cylinderVolume")),
    cylinderArea: (L: unknown, d: unknown) =>
      Math.PI * numArg(d, "cylinderArea") * numArg(L, "cylinderArea"),
  };
}

/* ------------------------------------------------------------------ */
/* Static expression analysis (dependencies + early errors)            */
/* ------------------------------------------------------------------ */

type AccessorKind =
  "pipe" | "heatedPipe" | "bend" | "branch" | "node" | "conductor" | "solid";
const ACCESSOR_NAMES = new Set([
  "pipe",
  "heatedPipe",
  "bend",
  "branch",
  "node",
  "conductor",
  "solid",
  "reg",
]);

/**
 * Which bindable component fields a pipe/heatedPipe/bend property reads
 * (derived properties map to their base fields).  Only fields that are
 * themselves formula-bound produce dependency edges.
 */
const PIPE_PROP_FIELDS: Record<string, ReadonlyArray<string>> = {
  length: ["length"],
  diameter: ["diameter"],
  roughness: ["roughness"],
  elevationChange: ["elevationChange"],
  area: ["diameter"],
  volume: ["length", "diameter"],
  surfaceArea: ["length", "diameter"],
};
const HEATED_PIPE_PROP_FIELDS: Record<string, ReadonlyArray<string>> = {
  ...PIPE_PROP_FIELDS,
  ua: ["ua"],
  wallTemperature: ["wallTemperature"],
};
const BEND_PROP_FIELDS: Record<string, ReadonlyArray<string>> = {
  diameter: ["diameter"],
  angle: [],
  rOverD: ["rOverD"],
  roughness: ["roughness"],
  area: ["diameter"],
};
const NODE_PROP_FIELDS: Record<string, ReadonlyArray<string>> = {
  pressure: ["pressure"],
  temperature: ["temperature"],
  heatInput: ["heatInput"],
  volume: ["volume"],
  z: ["position.z"],
};
const SOLID_PROPS = new Set(["mass", "temperature", "heatInput"]);
const CONDUCTION_PROP_FIELDS: Record<string, ReadonlyArray<string>> = {
  k: [],
  area: ["area"],
  length: ["length"],
};
const CONVECTION_PROP_FIELDS: Record<string, ReadonlyArray<string>> = {
  h: ["h"],
  area: ["area"],
};
const RADIATION_PROP_FIELDS: Record<string, ReadonlyArray<string>> = {
  emissivity: ["emissivity"],
  area: ["area"],
  viewFactor: ["viewFactor"],
};
const CORRELATION_PROPS: Record<string, ReadonlyArray<string>> = {
  diameter: ["correlation.diameter"],
  flowArea: ["correlation.flowArea"],
  axialPosition: ["correlation.axialPosition"],
  inletLiquidReynolds: ["correlation.inletLiquidReynolds"],
  segmentLength: ["correlation.segmentLength"],
  frontEnergyFactor: ["correlation.frontEnergyFactor"],
  rewetHysteresisOffsetK: ["correlation.rewetHysteresisOffsetK"],
};

interface AnalysisResult {
  /** Field paths this expression reads (only BOUND ones become edges). */
  deps: Set<string>;
  errors: string[];
}

/**
 * Peel a property chain (`pipe('a').volume`, `conductor('c').correlation.diameter`)
 * down to its accessor call.  Returns null when the chain is not rooted at a
 * model accessor.
 */
function peelAccessorChain(node: ExprNode): {
  kind: AccessorKind;
  call: Extract<ExprNode, { type: "call" }>;
  props: string[];
} | null {
  const props: string[] = [];
  let cur = node;
  while (cur.type === "prop") {
    props.unshift(cur.name);
    cur = cur.object;
  }
  if (
    cur.type === "call" &&
    cur.callee.type === "ident" &&
    ACCESSOR_NAMES.has(cur.callee.name) &&
    cur.callee.name !== "reg"
  ) {
    return { kind: cur.callee.name as AccessorKind, call: cur, props };
  }
  return null;
}

/** The single argument of an accessor call must be a string literal id. */
function literalIdArg(
  call: Extract<ExprNode, { type: "call" }>,
  kind: string,
  path: string,
  errors: string[],
): string | null {
  if (call.args.length !== 1 || call.args[0].type !== "str") {
    errors.push(
      `Parameter binding ${path}: ${kind}(...) requires exactly one string-literal id argument`,
    );
    return null;
  }
  return call.args[0].value;
}

function analyzeExpression(
  ast: ExprNode,
  path: string,
  index: ModelIndex,
): AnalysisResult {
  const deps = new Set<string>();
  const errors: string[] = [];

  const handleAccessor = (
    kind: AccessorKind,
    id: string,
    props: string[],
  ): void => {
    const fail = (msg: string): void => {
      errors.push(`Parameter binding ${path}: ${msg}`);
    };
    switch (kind) {
      case "pipe":
      case "heatedPipe":
      case "bend": {
        const b = index.branches.get(id);
        if (!b)
          return fail(`${kind}('${id}') references unknown branch '${id}'`);
        if (b.component.type !== kind) {
          return fail(
            `${kind}('${id}') type mismatch: branch '${id}' is a ${b.component.type}`,
          );
        }
        if (props.length === 0) return; // bare object: evaluation requires a number
        const table =
          kind === "pipe"
            ? PIPE_PROP_FIELDS
            : kind === "heatedPipe"
              ? HEATED_PIPE_PROP_FIELDS
              : BEND_PROP_FIELDS;
        const prop = props[0];
        if (props.length > 1 || !Object.hasOwn(table, prop)) {
          return fail(
            `${kind}('${id}') has no static property '${props.join(".")}'`,
          );
        }
        for (const f of table[prop]) deps.add(branchPath(id, f));
        return;
      }
      case "branch": {
        const b = index.branches.get(id);
        if (!b)
          return fail(`branch('${id}') references unknown branch '${id}'`);
        if (props.length === 0) return;
        const prop = props[0];
        const comp = b.component as unknown as Record<string, unknown>;
        if (props.length > 1 || prop === "type" || !Object.hasOwn(comp, prop)) {
          return fail(
            `branch('${id}') has no static property '${props.join(".")}'`,
          );
        }
        const v = comp[prop];
        if (typeof v === "number") return;
        if (
          isParameterExpression(v) &&
          (BINDABLE_COMPONENT_FIELDS[b.component.type] ?? []).includes(prop)
        ) {
          deps.add(branchPath(id, prop));
          return;
        }
        return fail(`branch('${id}').${prop} is not a static numeric property`);
      }
      case "node": {
        const n = index.nodes.get(id);
        if (!n)
          return fail(`node('${id}') references unknown fluid node '${id}'`);
        if (props.length === 0) return;
        const prop = props[0];
        if (prop === "position") {
          const axis = props[1];
          if (
            props.length !== 2 ||
            (axis !== "x" && axis !== "y" && axis !== "z")
          ) {
            return fail(
              `node('${id}').position has no static property '${props.slice(1).join(".")}'`,
            );
          }
          deps.add(nodePath(id, `position.${axis}`));
          return;
        }
        if (props.length > 1 || !Object.hasOwn(NODE_PROP_FIELDS, prop)) {
          return fail(
            `node('${id}') has no static property '${props.join(".")}'`,
          );
        }
        for (const f of NODE_PROP_FIELDS[prop]) deps.add(nodePath(id, f));
        return;
      }
      case "conductor": {
        const c = index.conductors.get(id);
        if (!c)
          return fail(
            `conductor('${id}') references unknown conductor '${id}'`,
          );
        if (props.length === 0) return;
        const prop = props[0];
        if (prop === "correlation") {
          if (c.type.kind !== "convection") {
            return fail(
              `conductor('${id}') (${c.type.kind}) has no correlation block`,
            );
          }
          const sub = props[1];
          if (
            props.length !== 2 ||
            sub === undefined ||
            !Object.hasOwn(CORRELATION_PROPS, sub)
          ) {
            return fail(
              `conductor('${id}').correlation has no static property '${props.slice(1).join(".")}'`,
            );
          }
          const stored = (
            c.type.correlation as unknown as Record<string, unknown> | undefined
          )?.[sub];
          if (typeof stored === "number" && Number.isFinite(stored)) return;
          if (isParameterExpression(stored)) {
            for (const field of CORRELATION_PROPS[sub])
              deps.add(conductorPath(id, field));
            return;
          }
          return fail(`conductor('${id}').correlation.${sub} is not set`);
        }
        if (props.length > 1) {
          return fail(
            `conductor('${id}') has no static property '${props.join(".")}'`,
          );
        }
        const table =
          c.type.kind === "conduction"
            ? CONDUCTION_PROP_FIELDS
            : c.type.kind === "convection"
              ? CONVECTION_PROP_FIELDS
              : RADIATION_PROP_FIELDS;
        if (!Object.hasOwn(table, prop)) {
          return fail(
            `conductor('${id}') (${c.type.kind}) has no static property '${prop}'`,
          );
        }
        if (
          prop === "k" &&
          c.type.kind === "conduction" &&
          typeof c.type.k !== "number"
        ) {
          return fail(
            `conductor('${id}').k is not a static number (table/material forms are not bindable)`,
          );
        }
        for (const f of table[prop]) deps.add(conductorPath(id, f));
        return;
      }
      case "solid": {
        const s = index.solids.get(id);
        if (!s)
          return fail(`solid('${id}') references unknown solid node '${id}'`);
        if (props.length === 0) return;
        if (props[0] === "position") {
          const axis = props[1];
          if (
            props.length !== 2 ||
            (axis !== "x" && axis !== "y" && axis !== "z")
          ) {
            return fail(
              `solid('${id}').position has no static property '${props.slice(1).join(".")}'`,
            );
          }
          deps.add(solidPath(id, `position.${axis}`));
          return;
        }
        if (props.length > 1 || !SOLID_PROPS.has(props[0])) {
          return fail(
            `solid('${id}') has no static property '${props.join(".")}'`,
          );
        }
        deps.add(solidPath(id, props[0]));
        return;
      }
    }
  };

  const visit = (n: ExprNode): void => {
    // Accessor-rooted property chain: handle as one unit (the chain's own
    // call node is validated for its literal id and not re-descended).
    if (n.type === "prop") {
      const chain = peelAccessorChain(n);
      if (chain) {
        const id = literalIdArg(chain.call, chain.kind, path, errors);
        if (id !== null) handleAccessor(chain.kind, id, chain.props);
        return;
      }
      visit(n.object);
      return;
    }
    if (n.type === "call") {
      if (n.callee.type === "ident" && ACCESSOR_NAMES.has(n.callee.name)) {
        const name = n.callee.name;
        const id = literalIdArg(n, name, path, errors);
        if (id !== null) {
          if (name === "reg") {
            const v = index.registers[id];
            if (typeof v !== "number" || !Number.isFinite(v)) {
              errors.push(
                `Parameter binding ${path}: reg('${id}') references unknown register '${id}'`,
              );
            }
          } else {
            // Bare accessor call (no property read): still validate the
            // reference now; evaluation reports the object/number mismatch.
            handleAccessor(name as AccessorKind, id, []);
          }
        }
        return; // args are string literals — nothing else to descend into
      }
      // Helper/builtin call: descend into callee + arguments.
      visit(n.callee);
      for (const a of n.args) visit(a);
      return;
    }
    switch (n.type) {
      case "unary":
        visit(n.arg);
        return;
      case "binary":
        visit(n.left);
        visit(n.right);
        return;
      case "cond":
        visit(n.cond);
        visit(n.then);
        visit(n.else);
        return;
      default:
        return; // num / str / ident
    }
  };
  visit(ast);
  return { deps, errors };
}

/* ------------------------------------------------------------------ */
/* Dependency ordering + cycle detection                               */
/* ------------------------------------------------------------------ */

/**
 * Kahn-style topological order (dependencies first), stable in collection
 * order.  On a cycle, returns a readable chain of field paths
 * (a → b → a) covering self-cycles and multi-field cycles alike.
 */
function topologicalOrder(
  paths: string[],
  deps: Map<string, Set<string>>,
): { ok: true; paths: string[] } | { ok: false; error: string } {
  // DFS with colors for a readable cycle chain.
  const state = new Map<string, "visiting" | "done">();
  const order: string[] = [];
  const stack: string[] = [];

  const dfs = (path: string): string | null => {
    state.set(path, "visiting");
    stack.push(path);
    for (const dep of deps.get(path) ?? []) {
      if (dep === path) {
        stack.push(dep);
        return stack.slice(stack.indexOf(path)).join(" → ");
      }
      const s = state.get(dep);
      if (s === "visiting") {
        stack.push(dep);
        return stack.slice(stack.indexOf(dep)).join(" → ");
      }
      if (s === undefined) {
        const cycle = dfs(dep);
        if (cycle !== null) return cycle;
      }
    }
    stack.pop();
    state.set(path, "done");
    order.push(path);
    return null;
  };

  for (const path of paths) {
    if (state.get(path) === undefined) {
      const cycle = dfs(path);
      if (cycle !== null) {
        return { ok: false, error: `Parameter binding cycle: ${cycle}` };
      }
    }
  }
  return { ok: true, paths: order };
}
