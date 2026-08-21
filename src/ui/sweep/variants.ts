/**
 * sweep/variants.ts — axis point generation (a deterministic linspace for
 * range sweeps, the chosen option list for option sweeps), sweep-definition
 * validation, and immutable variant/job materialization.
 *
 * Validation is layered so a UI can SHOW invalid variants instead of
 * failing the whole sweep:
 *   - validateSweepDefinition returns a discriminated result: structural
 *     problems (non-finite endpoints, bad count, unresolvable target) make
 *     it `ok:false`; a structurally-valid definition returns the descriptor,
 *     the exact values, AND any per-value validateNetwork failures in
 *     `invalidValues` (empty when every variant config is valid).
 *   - materializeSweepVariants / createSweepJob are the strict path for
 *     runners: they throw SweepDefinitionError on structural problems and
 *     never mutate (or freeze) the caller's base config.
 */
import type { NetworkConfig } from "../../core";
import { validateNetwork } from "../../core";
import { configHash } from "../provenance";
import { applySweepValue, resolveSweepTarget } from "./targets";
import type {
  SolveJob,
  SweepDefinition,
  SweepTargetDescriptor,
  SweepValue,
  SweepVariant,
} from "./types";
import { SWEEP_MAX_VARIANTS, isRangeSweep } from "./types";

/** Thrown by the strict materialization path on structural definition
 *  errors (validateSweepDefinition reports them without throwing). */
export class SweepDefinitionError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join("; "));
    this.name = "SweepDefinitionError";
    this.errors = errors;
  }
}

/**
 * Deterministic inclusive linspace.
 *  - count = 1 yields [start] (numpy linspace semantics);
 *  - count >= 2 yields v_i = start + (end - start) * i / (count - 1), with
 *    the last value pinned to `end` exactly (no floating-point drift), so
 *    both endpoints are always included;
 *  - reversed (end < start) and equal (start === end) ranges are supported.
 * Callers must pass finite endpoints and an integer count >= 1 —
 * validateSweepDefinition enforces this for user-supplied definitions.
 */
export function linspace(start: number, end: number, count: number): number[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new SweepDefinitionError([
      `linspace count must be an integer >= 1 (got ${count})`,
    ]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new SweepDefinitionError([
      `linspace endpoints must be finite (got ${start}, ${end})`,
    ]);
  }
  if (count === 1) return [start];
  const step = (end - start) / (count - 1);
  const values = new Array<number>(count);
  for (let i = 0; i < count - 1; i++) {
    values[i] = start + step * i;
  }
  values[count - 1] = end;
  return values;
}

/** One point on a sweep axis, ready to apply. */
export interface SweepPoint {
  value: SweepValue;
  /** Display name for an option value; absent for numeric values. */
  label?: string;
}

/** One variant value whose modified config failed validateNetwork. */
export interface InvalidSweepValue {
  index: number;
  value: SweepValue;
  /** Display name for an option value; absent for numeric values. */
  valueLabel?: string;
  /** validateNetwork messages for the modified config. */
  errors: string[];
}

export type SweepValidation =
  | {
      ok: true;
      descriptor: SweepTargetDescriptor;
      /** Exact swept values, in solve order (a range sweep's linspace, or
       *  the chosen option ids). */
      values: SweepValue[];
      /** Per-value validateNetwork failures; empty when all variants are
       *  valid.  Non-empty does NOT fail the definition — the UI can show
       *  those variants as invalid and let the user decide. */
      invalidValues: InvalidSweepValue[];
    }
  | { ok: false; errors: string[] };

/** Structural definition-error messages (empty when structurally valid). */
function structuralErrors(
  config: NetworkConfig,
  definition: SweepDefinition,
): string[] {
  const errors: string[] = [];
  const resolved = resolveSweepTarget(config, definition.target);
  if (!resolved.ok) {
    errors.push(resolved.error);
  }

  if (isRangeSweep(definition)) {
    if (resolved.ok && resolved.descriptor.axis !== "numeric") {
      errors.push(
        `${resolved.descriptor.label} is a choice between options, not a range — sweep it as an option list`,
      );
    }
    if (
      !Number.isFinite(definition.start) ||
      !Number.isFinite(definition.end)
    ) {
      errors.push(
        `Sweep endpoints must be finite numbers (got start=${definition.start}, end=${definition.end})`,
      );
    }
    if (!Number.isInteger(definition.count)) {
      errors.push(`Sweep count must be an integer (got ${definition.count})`);
    } else if (definition.count < 1 || definition.count > SWEEP_MAX_VARIANTS) {
      errors.push(
        `Sweep count must be in 1..${SWEEP_MAX_VARIANTS} (got ${definition.count})`,
      );
    }
    return errors;
  }

  if (definition.spacing !== "options") {
    errors.push(
      `Unsupported spacing ${JSON.stringify((definition as { spacing: unknown }).spacing)} (expected 'linear' or 'options')`,
    );
    return errors;
  }

  const ids = definition.optionIds;
  if (!Array.isArray(ids) || ids.length < 1) {
    errors.push("An option sweep needs at least one selected option");
  } else if (ids.length > SWEEP_MAX_VARIANTS) {
    errors.push(
      `Option sweeps are limited to ${SWEEP_MAX_VARIANTS} options (got ${ids.length})`,
    );
  } else {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id))
        errors.push(`Option ${JSON.stringify(id)} is selected more than once`);
      seen.add(id);
    }
  }
  if (resolved.ok) {
    if (resolved.descriptor.axis !== "options") {
      errors.push(
        `${resolved.descriptor.label} takes a numeric range, not an option list`,
      );
    } else if (Array.isArray(ids)) {
      const known = new Set(resolved.descriptor.options.map((o) => o.id));
      for (const id of ids) {
        if (!known.has(id)) {
          errors.push(
            `${JSON.stringify(id)} is not an option of ${resolved.descriptor.label} (options: ${[...known].join(", ")})`,
          );
        }
      }
    }
  }
  return errors;
}

/**
 * The exact points a structurally-valid definition sweeps, in solve order.
 * Throws SweepDefinitionError on structural problems.
 */
export function sweepPoints(
  config: NetworkConfig,
  definition: SweepDefinition,
): SweepPoint[] {
  const errors = structuralErrors(config, definition);
  if (errors.length > 0) throw new SweepDefinitionError(errors);
  if (isRangeSweep(definition)) {
    return linspace(definition.start, definition.end, definition.count).map(
      (value) => ({ value }),
    );
  }
  const resolved = resolveSweepTarget(config, definition.target);
  const options =
    resolved.ok && resolved.descriptor.axis === "options"
      ? resolved.descriptor.options
      : [];
  return definition.optionIds.map((id) => {
    const option = options.find((o) => o.id === id);
    return { value: id, ...(option ? { label: option.label } : {}) };
  });
}

/**
 * Validate a sweep definition against a config WITHOUT throwing.
 * Structural problems → { ok: false, errors }.  Otherwise the definition is
 * usable; per-value validateNetwork failures are reported in invalidValues
 * so the UI can mark individual invalid variants instead of rejecting the
 * whole sweep.
 */
export function validateSweepDefinition(
  config: NetworkConfig,
  definition: SweepDefinition,
): SweepValidation {
  const errors = structuralErrors(config, definition);
  if (errors.length > 0) return { ok: false, errors };
  // structuralErrors guarantees resolution succeeded.
  const { descriptor } = resolveSweepTarget(config, definition.target) as {
    ok: true;
    descriptor: SweepTargetDescriptor;
  };
  const points = sweepPoints(config, definition);
  const invalidValues: InvalidSweepValue[] = [];
  for (let i = 0; i < points.length; i++) {
    const modified = applySweepValue(
      config,
      definition.target,
      points[i].value,
    );
    const configErrors = validateNetwork(modified);
    if (configErrors.length > 0) {
      invalidValues.push({
        index: i,
        value: points[i].value,
        ...(points[i].label !== undefined
          ? { valueLabel: points[i].label }
          : {}),
        errors: configErrors,
      });
    }
  }
  return {
    ok: true,
    descriptor,
    values: points.map((p) => p.value),
    invalidValues,
  };
}

/** Recursively freeze a config snapshot (configs are plain JSON trees). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Materialize immutable variant snapshots for a structurally-valid
 * definition.  Each variant config is deep-new (no shared references with
 * the base config) and deep-frozen; its hash matches the run-record hash
 * scheme.  The base config is neither mutated nor frozen.
 *
 * Throws SweepDefinitionError on structural problems — run
 * validateSweepDefinition first when handling user input.  Per-value
 * validateNetwork failures do NOT throw here; check invalidValues via
 * validateSweepDefinition.
 */
export function materializeSweepVariants(
  config: NetworkConfig,
  definition: SweepDefinition,
): SweepVariant[] {
  return sweepPoints(config, definition).map((point, index) => {
    const snapshot = deepFreeze(
      applySweepValue(config, definition.target, point.value),
    );
    return {
      index,
      value: point.value,
      ...(point.label !== undefined ? { valueLabel: point.label } : {}),
      config: snapshot,
      configHash: configHash(snapshot),
    };
  });
}

/**
 * Create a pending parameter-sweep job: validates the definition,
 * materializes variant records, and stores a deep-frozen base snapshot +
 * hash.  Throws SweepDefinitionError on structural problems.
 */
export function createSweepJob(args: {
  id: string;
  baseConfig: NetworkConfig;
  definition: SweepDefinition;
  /** Epoch ms override for deterministic tests. */
  now?: number;
}): SolveJob {
  const { id, baseConfig, definition } = args;
  const errors = structuralErrors(baseConfig, definition);
  if (errors.length > 0) throw new SweepDefinitionError(errors);
  const { descriptor } = resolveSweepTarget(baseConfig, definition.target) as {
    ok: true;
    descriptor: SweepTargetDescriptor;
  };
  const base = deepFreeze(structuredClone(baseConfig));
  const variants = materializeSweepVariants(baseConfig, definition);
  return {
    id,
    kind: "parameterSweep",
    status: "pending",
    baseConfig: base,
    baseConfigHash: configHash(base),
    sweep: structuredClone(definition),
    targetLabel: descriptor.label,
    variants: variants.map((v) => ({
      index: v.index,
      value: v.value,
      ...(v.valueLabel !== undefined ? { valueLabel: v.valueLabel } : {}),
      configHash: v.configHash,
      status: "pending" as const,
    })),
    createdAt: args.now ?? Date.now(),
    progress: { completed: 0, total: variants.length },
  };
}
