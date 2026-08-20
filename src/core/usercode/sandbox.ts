/**
 * Sandboxed compilation of user-authored branch components.
 *
 * Two source formats (schema.ts UserComponentLibraryEntry.format):
 *   'defineComponent' (default): a script body that calls
 *       defineComponent({ metadata: {...}, pressureDrop(args) {...}, heat?(args) {...} })
 *   'inline': a bare function body receiving `args` and returning the
 *       pressure drop in Pa, e.g.  return args.params.K * args.mdot * Math.abs(args.mdot) / (2 * args.rho * args.area * args.area);
 *
 * Compilation uses `new Function` in strict mode with only the injected
 * `defineComponent` / `args` parameters in scope.  Everything here is
 * SYNCHRONOUS.  This is convenience sandboxing (no ambient-module access in
 * strict-mode function bodies beyond the global object), not a security
 * boundary — only load component code from sources the user already trusts
 * (their own network files).
 *
 * Runtime invocation wraps user errors and non-finite outputs in
 * UserCodeError carrying the source id and lifecycle phase.
 */

export type UserCodePhase = "compile" | "define" | "evaluate" | "heat";

export class UserCodeError extends Error {
  readonly sourceId: string;
  readonly phase: UserCodePhase;

  constructor(sourceId: string, phase: UserCodePhase, message: string) {
    super(`[${sourceId}] ${phase}: ${message}`);
    this.name = "UserCodeError";
    this.sourceId = sourceId;
    this.phase = phase;
  }
}

/** Declarative parameter descriptor for a user component (UI + defaults). */
export interface UserComponentParamSpec {
  name: string;
  label?: string;
  unit?: string;
  default: number;
  min?: number;
  max?: number;
}

export interface UserComponentMetadata {
  name: string;
  label?: string;
  description?: string;
  version?: string | number;
  params?: UserComponentParamSpec[];
}

/** Read-only, class-agnostic fluid-property view supplied by the solver.
 * It is scoped to the branch's working fluid so this contract remains valid
 * when networks gain per-branch fluids. */
export interface UserFluidAccessor {
  density(P: number, T: number): number;
  viscosity(P: number, T: number): number;
  cp(P: number, T: number): number;
  cv(P: number, T: number): number;
  enthalpy(P: number, T: number): number;
  internalEnergy(P: number, T: number): number;
  temperatureFromEnthalpy(P: number, h: number): number;
  saturationTemperature(P: number): number;
  hSatLiquid(P: number): number;
  hSatVapor(P: number): number;
  criticalPressure(): number;
  criticalTemperature(): number;
}

/** Arguments handed to a user pressureDrop function (frozen before the call). */
export interface UserPressureDropArgs {
  mdot: number; // kg/s, signed
  rho: number; // kg/m^3
  mu: number; // Pa·s
  t: number; // s
  T?: number; // K, upstream temperature when known
  pFrom?: number; // Pa
  pTo?: number; // Pa
  area?: number; // m^2, contextual flow area if configured
  params: Readonly<Record<string, number>>;
  fluid?: UserFluidAccessor;
}

/** Arguments handed to a user heat function (frozen before the call). */
export interface UserHeatArgs {
  mdot: number; // kg/s, signed
  Tup: number; // K, upstream temperature
  cp: number; // J/kg/K
  P?: number; // Pa
  h?: number; // J/kg
  area?: number; // m^2
  params: Readonly<Record<string, number>>;
  fluid?: UserFluidAccessor;
}

export interface UserComponentDefinition {
  metadata: UserComponentMetadata;
  /** Returns pressure drop in Pa (positive = drop in from→to direction). */
  pressureDrop(args: UserPressureDropArgs): number;
  /** Optional heat rate to the stream in W. */
  heat?(args: UserHeatArgs): number;
}

/** Type-identity helper for TS-authored component definitions. */
export function defineComponent(
  def: UserComponentDefinition,
): UserComponentDefinition {
  return def;
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function validateDefinition(
  raw: unknown,
  sourceId: string,
): UserComponentDefinition {
  if (raw === undefined || raw === null) {
    throw new UserCodeError(
      sourceId,
      "define",
      "source did not call defineComponent({...})",
    );
  }
  if (typeof raw !== "object") {
    throw new UserCodeError(
      sourceId,
      "define",
      `defineComponent argument must be an object (got ${typeof raw})`,
    );
  }
  const def = raw as Partial<UserComponentDefinition>;
  const meta = def.metadata;
  if (
    meta === undefined ||
    typeof meta !== "object" ||
    typeof meta.name !== "string" ||
    meta.name.length === 0
  ) {
    throw new UserCodeError(
      sourceId,
      "define",
      "metadata.name (non-empty string) is required",
    );
  }
  if (meta.params !== undefined) {
    if (!Array.isArray(meta.params)) {
      throw new UserCodeError(
        sourceId,
        "define",
        "metadata.params must be an array",
      );
    }
    for (const p of meta.params) {
      if (
        typeof p !== "object" ||
        p === null ||
        typeof p.name !== "string" ||
        p.name.length === 0
      ) {
        throw new UserCodeError(
          sourceId,
          "define",
          "each metadata.params entry requires a non-empty name",
        );
      }
      if (typeof p.default !== "number" || !Number.isFinite(p.default)) {
        throw new UserCodeError(
          sourceId,
          "define",
          `param "${p.name}" requires a finite numeric default`,
        );
      }
    }
  }
  if (typeof def.pressureDrop !== "function") {
    throw new UserCodeError(
      sourceId,
      "define",
      "pressureDrop(args) function is required",
    );
  }
  if (def.heat !== undefined && typeof def.heat !== "function") {
    throw new UserCodeError(
      sourceId,
      "define",
      "heat must be a function if provided",
    );
  }
  return def as UserComponentDefinition;
}

/**
 * Compile a `defineComponent({...})` source string into a validated,
 * shallowly-frozen UserComponentDefinition.  The source body IS invoked once
 * here (with the injected defineComponent) to obtain the definition — use
 * checkUserCodeSyntax for a no-execution syntax check.
 */
export function compileUserComponent(
  source: string,
  sourceId = "userComponent",
): UserComponentDefinition {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new UserCodeError(
      sourceId,
      "compile",
      "source must be a non-empty string",
    );
  }
  let factory: (dc: (def: unknown) => unknown) => void;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    factory = new Function(
      "defineComponent",
      `"use strict";\n${source}`,
    ) as typeof factory;
  } catch (e) {
    throw new UserCodeError(sourceId, "compile", describeError(e));
  }
  let raw: unknown;
  const defineComponentHook = (def: unknown): unknown => {
    raw = def;
    return def;
  };
  try {
    factory(defineComponentHook);
  } catch (e) {
    throw new UserCodeError(sourceId, "define", describeError(e));
  }
  const def = validateDefinition(raw, sourceId);
  return Object.freeze(def);
}

/**
 * Compile an inline pressure-drop body into a `(args) => number` function.
 * The body is NOT executed here; each later call receives a fresh frozen
 * args object from the caller.
 */
export function compileInlinePressureDrop(
  source: string,
  sourceId = "inline",
): (args: UserPressureDropArgs) => number {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new UserCodeError(
      sourceId,
      "compile",
      "source must be a non-empty string",
    );
  }
  let fn: (args: UserPressureDropArgs) => unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    fn = new Function("args", `"use strict";\n${source}`) as typeof fn;
  } catch (e) {
    throw new UserCodeError(sourceId, "compile", describeError(e));
  }
  return (args: UserPressureDropArgs): number => {
    let result: unknown;
    try {
      result = fn(Object.freeze(args));
    } catch (e) {
      throw new UserCodeError(sourceId, "evaluate", describeError(e));
    }
    if (typeof result !== "number" || !Number.isFinite(result)) {
      throw new UserCodeError(
        sourceId,
        "evaluate",
        `pressure drop must be a finite number (got ${String(result)})`,
      );
    }
    return result;
  };
}

/**
 * No-execution syntax check for user source.  Compiles (new Function parses
 * the body) but never invokes it.  Returns null on success, or an error
 * message string.  Used by validate.ts.
 */
export function checkUserCodeSyntax(
  source: unknown,
  format: "defineComponent" | "inline",
): string | null {
  if (typeof source !== "string" || source.trim().length === 0) {
    return "code must be a non-empty string";
  }
  try {
    if (format === "defineComponent") {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function("defineComponent", `"use strict";\n${source}`);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function("args", `"use strict";\n${source}`);
    }
    return null;
  } catch (e) {
    return describeError(e);
  }
}
