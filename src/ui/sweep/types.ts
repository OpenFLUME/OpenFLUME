/**
 * sweep/types.ts — pure domain contracts for the parameter-sweep
 * ("Exploration") POC.
 *
 * A sweep varies exactly ONE field of a NetworkConfig (a settings value, a
 * fluid/solid node value, a branch component value, or a conductor value)
 * along ONE of two axis kinds, producing up to SWEEP_MAX_VARIANTS immutable
 * variant configs that a later runner solves one by one:
 *
 *   - a NUMERIC axis over an inclusive linear range (start/end/count), for
 *     constrained scalar fields;
 *   - an OPTION axis over an explicit list of discrete choices, for the
 *     model's categorical fields — which heat-transfer correlation a
 *     conductor uses, which material supplies a wall's cp or k, whether a
 *     pipe carries fluid inertia.  These have no meaningful "range": the
 *     question is "which of these, side by side".
 *
 * Everything here is pure data + pure functions: no React, no store, no
 * worker protocol.
 *
 * Value convention: numeric values (start/end, descriptor currentValue,
 * variant value) are in config-native SI units — the same numbers the config
 * stores (Pa, K, m, m², m³, kg/s, W, …).  The one exception is bend `angle`,
 * which the schema stores in degrees; the units module (src/ui/units.ts)
 * treats 'deg' as the angle base unit, so the convention still holds.
 * Option values are opaque registry ids (see targets.ts), never numbers.
 */
import type { NetworkConfig, SteadyResult, TransientResult } from "../../core";
import type { RunDiary } from "../convergenceDiary";
import type { QuantityKind } from "../units";

/* ------------------------------------------------------------------ */
/* Sweep targets                                                       */
/* ------------------------------------------------------------------ */

/** Settings scalar fields eligible for sweeping (settings.dt / endTime are
 *  transient-only and are offered only when present on the config). */
export type SettingsSweepField = "dt" | "endTime" | "tolerance" | "relaxation";

/** Fluid-node scalar fields eligible for sweeping.  `quality`, schedules,
 *  mass-fraction maps and canvas/layout fields are deliberately excluded. */
export type FluidNodeSweepField =
  "pressure" | "temperature" | "volume" | "heatInput";

/** Solid-node scalar fields eligible for sweeping.  `cp` is offered only
 *  when it is a plain number (table / material forms are not sweepable);
 *  `mass` / `cp` are offered only for type:'solid' nodes (ambient nodes are
 *  infinite reservoirs without thermal mass). */
export type SolidNodeSweepField = "temperature" | "mass" | "heatInput" | "cp";

/** Solid-node categorical axes.  'cp.material' names the AXIS (cp, chosen
 *  by named material), not a subfield: applying it replaces `cp` wholesale
 *  with `{ material }`. */
export type SolidNodeOptionField = "cp.material";

/**
 * Constrained scalar sweep target — a discriminated union over the five
 * target families.  `field` for 'branch' targets is a component field name
 * validated against the branch's component variant (e.g. 'diameter' is valid
 * for pipe but not for orifice); for 'conductor' targets it is either a
 * direct type field ('k', 'area', 'h', 'emissivity', …) or a convection
 * correlation sub-field path ('correlation.diameter', …).  See
 * targets.ts for the authoritative field tables.
 */
export type SweepTarget =
  | { kind: "settings"; field: SettingsSweepField }
  | { kind: "node"; id: string; field: FluidNodeSweepField }
  | {
      kind: "solidNode";
      id: string;
      field: SolidNodeSweepField | SolidNodeOptionField;
    }
  | { kind: "branch"; id: string; field: string }
  | { kind: "conductor"; id: string; field: string };

/** Advisory bounds for a sweepable field, derived from validate.ts rules.
 *  `min` may be exclusive (e.g. strictly-positive fields report min: 0) —
 *  treat bounds as UI guidance; the authoritative check is always
 *  validateNetwork on the modified config. */
export interface SweepBounds {
  min?: number;
  max?: number;
}

/** One choice on an option axis.  `id` is the stable registry key stored in
 *  definitions and variant records; `label` is display-only. */
export interface SweepOption {
  id: string;
  /** Human name, e.g. "Dittus–Boelter", "Stainless steel 304". */
  label: string;
  /** Optional one-line note: provenance, validity envelope, or what the
   *  choice replaces (e.g. "keeps the current constant, 500 J/(kg·K)"). */
  hint?: string;
}

interface SweepDescriptorBase {
  target: SweepTarget;
  /** Human label, e.g. "Settings · dt", "Node in · pressure",
   *  "Pipe b1 · diameter", "Convection c1 · heat-transfer model". */
  label: string;
}

/** A resolved numeric target: quantity kind, unit symbol, current SI value. */
export interface NumericSweepDescriptor extends SweepDescriptorBase {
  axis: "numeric";
  /** Quantity kind from src/ui/units.ts.  Fields with no exact unit kind
   *  (node/solid mass, specific heat cp, heated-pipe ua, …) report
   *  'dimensionless' — raw SI — rather than an invented unit; `unit` still
   *  carries the truthful SI symbol for display. */
  quantity: QuantityKind;
  /** Display symbol for the stored value's unit (base SI unit for the
   *  quantity kind, e.g. 'Pa'; 'deg' for angles; 'kg' / 'J/(kg·K)' / 'W/K'
   *  for raw-SI fields; '-' for true dimensionless). */
  unit: string;
  /** Current value in config-native (SI) units. */
  currentValue: number;
  bounds?: SweepBounds;
}

/** A resolved categorical target: the choices available for this field on
 *  this element, and which one the config currently holds. */
export interface OptionSweepDescriptor extends SweepDescriptorBase {
  axis: "options";
  /** Every choice the registry offers here, in a stable display order.
   *  Whether a choice yields a VALID config is a separate question,
   *  answered per variant by validateNetwork (a conductor switched to
   *  'ttWf' without a segmentLength is offered, then reported invalid). */
  options: SweepOption[];
  /** Id of the option matching the config's current value, when one does
   *  (a cp given as a hand-entered table matches no material). */
  currentOptionId?: string;
}

export type SweepTargetDescriptor =
  NumericSweepDescriptor | OptionSweepDescriptor;

/** One point on a sweep axis: an SI number, or an option id. */
export type SweepValue = number | string;

/* ------------------------------------------------------------------ */
/* Sweep definition and variants                                       */
/* ------------------------------------------------------------------ */

/** Hard cap on variants per sweep (keeps POC runs bounded and reviewable). */
export const SWEEP_MAX_VARIANTS = 25;

/**
 * A validated-before-use sweep specification.  `spacing` is the
 * discriminant: 'linear' lays the axis out as an inclusive linspace,
 * 'options' as the given list of registry option ids (in the order the user
 * chose them, which is the order they are solved and reported).
 */
export type SweepDefinition = RangeSweepDefinition | OptionSweepDefinition;

export interface RangeSweepDefinition {
  target: SweepTarget;
  /** Inclusive range start, config-native SI units. */
  start: number;
  /** Inclusive range end; may equal or be less than `start`. */
  end: number;
  /** Integer variant count, 1..SWEEP_MAX_VARIANTS. */
  count: number;
  spacing: "linear";
}

export interface OptionSweepDefinition {
  target: SweepTarget;
  spacing: "options";
  /** 1..SWEEP_MAX_VARIANTS registry option ids; duplicates are rejected. */
  optionIds: string[];
}

/** True for the linspace form (the numeric axis). */
export function isRangeSweep(
  definition: SweepDefinition,
): definition is RangeSweepDefinition {
  return definition.spacing === "linear";
}

/** True for the discrete-choice form (the option axis). */
export function isOptionSweep(
  definition: SweepDefinition,
): definition is OptionSweepDefinition {
  return definition.spacing === "options";
}

/** One materialized sweep point: an immutable config snapshot + its hash. */
export interface SweepVariant {
  /** 0-based position along the axis. */
  index: number;
  /** The swept field's value at this point: an SI number for a range
   *  sweep, an option id for an option sweep. */
  value: SweepValue;
  /** Display name for an option value ("Dittus–Boelter"), frozen with the
   *  variant so a later rename in the registry can't relabel a finished
   *  run.  Absent for numeric values, which are formatted on demand at the
   *  reader's significant figures. */
  valueLabel?: string;
  /**
   * Deep-frozen config snapshot with exactly the target field changed.
   * Fully independent of the base config (no shared references), so
   * freezing can never leak back into the editor's config.
   */
  config: NetworkConfig;
  /** FNV-1a/64 of the canonical config JSON (same hash as run records). */
  configHash: string;
}

/* ------------------------------------------------------------------ */
/* Variant result summary                                              */
/* ------------------------------------------------------------------ */

/** Min/max envelope of a scalar quantity across a variant's result. */
export interface ValueEnvelope {
  min: number;
  max: number;
}

/**
 * Compact, pure summary of one variant's solve result (steady or
 * transient).  Envelope fields are undefined (never NaN/Infinity) when the
 * result carries no data for them.
 */
export interface VariantSummary {
  mode: "steady" | "transient";
  converged: boolean;
  aborted: boolean;
  userTerminated: boolean;
  /* Steady-only. */
  iterations?: number;
  residual?: number;
  /* Transient-only.  steps/rejectedSteps/minDt/maxDt come from
   * TransientResult.stats when present (adaptive), otherwise steps is
   * derived from the accepted-step time grid (times.length - 1). */
  steps?: number;
  rejectedSteps?: number;
  minDt?: number;
  maxDt?: number;
  /** Last recorded time (undefined for an empty trajectory). */
  endTime?: number;
  /** Whether the solve ran to the configured end time: compared against
   *  the optional expected end time when given, else inferred as
   *  "not aborted / not user-terminated with a non-empty trajectory". */
  reachedEnd?: boolean;
  /* Envelopes across all nodes (steady: single state; transient: all
   *  recorded times). */
  pressure?: ValueEnvelope;
  temperature?: ValueEnvelope;
  /** Peak |mdot| across all branches (and times). */
  peakAbsMassFlow?: number;
}

/* ------------------------------------------------------------------ */
/* Solve-job contracts (for the later runner)                          */
/* ------------------------------------------------------------------ */

export type SolveJobKind = "parameterSweep";

export type SolveJobStatus =
  "pending" | "running" | "completed" | "failed" | "cancelled";

export type SweepVariantStatus =
  "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * Per-variant record inside a job.  Deliberately light: the immutable
 * config snapshot itself is NOT stored here — the runner re-materializes
 * variant configs deterministically from (baseConfig, sweep) via
 * materializeSweepVariants and matches them by index/configHash.
 *
 * `result` (the raw solve result) is retained only on the live, session-only
 * job held by the sweep runner store, so a completed variant can be promoted
 * into run history.  It is never persisted.
 */
export interface SweepVariantRecord {
  index: number;
  value: SweepValue;
  /** Display name for an option value; absent for numeric values (see
   *  SweepVariant.valueLabel). */
  valueLabel?: string;
  configHash: string;
  status: SweepVariantStatus;
  error?: string;
  summary?: VariantSummary;
  /** Raw solve result, present iff status is 'completed'.  Session-only. */
  result?: SolveResult;
  /**
   * Convergence diary of this variant's solve, built from the live progress
   * stream (one collector per variant run): completed variants get a
   * finalized result diary, failed ones a partial error diary, and a variant
   * cancelled mid-flight a partial cancelled diary.  Variants cancelled
   * before they ever started have no diary (no evidence crossed the worker
   * boundary).  Session-only, never persisted; treated as immutable.
   */
  diary?: RunDiary;
  /** Epoch ms when this variant's solve started. */
  startedAt?: number;
  /** Wall-clock solve duration for this variant. */
  durationMs?: number;
}

/** Aggregate job outcome, filled when the job reaches a terminal status. */
export interface SweepJobResult {
  total: number;
  completed: number;
  failed: number;
  /** Variants whose solve reported converged (steady or transient). */
  converged: number;
}

/**
 * A parameter-sweep solve job.  `baseConfig` is a deep-frozen snapshot
 * taken at job creation; `baseConfigHash` labels it exactly like run
 * records do, so a sweep result can be audited against the model that
 * produced it.
 */
export interface SolveJob {
  id: string;
  kind: SolveJobKind;
  status: SolveJobStatus;
  /** Immutable (deep-frozen) base snapshot the sweep was defined against. */
  baseConfig: NetworkConfig;
  baseConfigHash: string;
  sweep: SweepDefinition;
  /** Denormalized descriptor label for list displays. */
  targetLabel: string;
  variants: SweepVariantRecord[];
  /** Epoch ms. */
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  progress: { completed: number; total: number };
  /** Job-level error (definition/validation failure, runner crash, …). */
  error?: string;
  result?: SweepJobResult;
  /** One-line human summary, e.g. "5/5 completed · 4 converged". */
  summary?: string;
}

/** Union helper for APIs that accept either result shape. */
export type SolveResult = SteadyResult | TransientResult;
