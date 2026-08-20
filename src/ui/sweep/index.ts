/**
 * sweep/index.ts — public surface of the parameter-sweep ("Exploration")
 * pure domain core.  No React, no store, no worker protocol: the runner
 * and UI layers build on these contracts and pure functions.
 */
export type {
  FluidNodeSweepField,
  NumericSweepDescriptor,
  OptionSweepDefinition,
  OptionSweepDescriptor,
  RangeSweepDefinition,
  SettingsSweepField,
  SolidNodeSweepField,
  SolveJob,
  SolveJobKind,
  SolveJobStatus,
  SolveResult,
  SweepBounds,
  SweepDefinition,
  SweepJobResult,
  SweepOption,
  SweepTarget,
  SweepTargetDescriptor,
  SweepValue,
  SweepVariant,
  SweepVariantRecord,
  SweepVariantStatus,
  ValueEnvelope,
  VariantSummary,
} from "./types";
export { SWEEP_MAX_VARIANTS, isOptionSweep, isRangeSweep } from "./types";

export type { SweepTargetResolution } from "./targets";
export {
  applySweepValue,
  CURRENT_OPTION_ID,
  listSweepTargets,
  resolveSweepTarget,
} from "./targets";

export type {
  InvalidSweepValue,
  SweepPoint,
  SweepValidation,
} from "./variants";
export {
  createSweepJob,
  deepFreeze,
  linspace,
  materializeSweepVariants,
  sweepPoints,
  SweepDefinitionError,
  validateSweepDefinition,
} from "./variants";

export { summarizeVariant } from "./summary";
