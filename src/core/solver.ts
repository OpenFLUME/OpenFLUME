/**
 * Thermal-fluid network solver — public entry point.
 *
 * The implementation lives in ./solver/, split by concern.  Start with the
 * two drivers and drill down as needed:
 *
 *   solver/steady.ts       solveSteady — the steady-state driver
 *                          (solveTransient lives in ./transient.ts and uses
 *                          the same step solver with a dt)
 *   solver/step.ts         solveStateStep — converge ONE state (steady, or
 *                          one implicit transient step): the retry cascade,
 *                          the outer Picard loop, and the inner Newton loop
 *                          with trust-region/line-search globalization and
 *                          PTC.  The "how the solve actually works" file.
 *   solver/kernel.ts       The Newton kernel: the residual R(x) over
 *                          x = [P, ṁ (, h)] (mass/momentum/energy rows) and
 *                          the FD + hybrid-dual Jacobian builders.
 *                          The "what equations are solved" file.
 *   solver/thermal.ts      The segregated solid/ambient wall subsystem:
 *                          conductances, heat rates, exact-Jacobian Newton.
 *   solver/conductorH.ts   Convection h-map refresh + the step-boundary
 *                          commits of the stateful correlation/front models.
 *   solver/context.ts      buildSolverContext / createInitialState /
 *                          buildLogicScope — per-solve setup.
 *   solver/types.ts        SolverContext and StepState (the two data
 *                          structures threaded through everything).
 *   solver/pressureDrop.ts Branch dP wrappers (elevation term + zero-flow
 *                          linearisation), scalar and dual.
 *   solver/safeProps.ts    Crash-proof CoolProp property access with a
 *                          counted fallback cascade.
 *   solver/linalg.ts       Dense Gaussian elimination + small vector helpers.
 *   solver/derivedProperties.ts
 *                          Reporting-only derived quantities (enthalpy,
 *                          entropy, Mach, heat flux, …) shared by the steady
 *                          packer and the transient recorder.
 *   solver/junctionSummary.ts
 *                          Reacting-junction reporting summary (Pc, O/F,
 *                          product gas state), likewise shared by the steady
 *                          packer and the transient recorder.
 *
 * Everything re-exported here is used by transient.ts, controllerRuntime.ts,
 * continuation.ts, and the test suite; the narrower stable public API is
 * defined in ./index.ts (solveSteady + componentPressureDrop only).
 */
export {
  componentPressureDrop,
  componentPressureDropDual,
} from "./solver/pressureDrop";
export type { ConductorEntry, SolverContext, StepState } from "./solver/types";
export { heatInputOf } from "./solver/types";
export {
  buildSolverContext,
  createInitialState,
  buildLogicScope,
} from "./solver/context";
export {
  updateConductorLatches,
  updateFluidFrontStates,
  computeConductorHMap,
} from "./solver/conductorH";
export {
  computeConductorHeatRate,
  probeThermalSubsystem,
} from "./solver/thermal";
export {
  branchDerivedProperties,
  conductorHeatFlux,
  definedOnly,
  nodeDerivedMap,
  nodeDerivedProperties,
} from "./solver/derivedProperties";
export type {
  BranchDerivedProperties,
  NodeDerivedProperties,
} from "./solver/derivedProperties";
export { probeJacobians } from "./solver/kernel";
export type { JacobianProbeResult } from "./solver/kernel";
export { solveStateStep } from "./solver/step";
export { solveSteady } from "./solver/steady";
export { computeJunctionSummaries } from "./solver/junctionSummary";
