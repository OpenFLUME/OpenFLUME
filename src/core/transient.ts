/**
 * Transient thermal-fluid network solver — public entry point.
 *
 * The implementation lives in ./transient/, split by concern:
 *
 *   transient/fixedStepping.ts     runFixedTimeStepping — uniform-dt driver
 *                                  (the default; settings.timeStepping
 *                                  unset or 'fixed')
 *   transient/adaptiveStepping.ts  runAdaptiveTimeStepping — step-doubling
 *                                  error control with dt adaptation and
 *                                  schedule-event alignment
 *   transient/resultRecorder.ts    Trajectory-array accumulation shared by
 *                                  both steppers, and the partial-result
 *                                  slicer used by onProgress/abort/logic-stop
 *   transient/historyRecorders.ts  TT-WF / fluid-front accepted-step history
 *   transient/boundaryConditions.ts applyBoundaryConditions — time-varying
 *                                  boundary schedules + controller overrides
 *   transient/breakpoints.ts       Schedule-event collection (adaptive only)
 *   transient/stateUtils.ts        cloneState
 *
 * Both steppers solve ONE state per call via solveStateStep (see
 * ./solver/step.ts); this file only owns resolving parameters, dispatching
 * on settings.timeStepping, and validating endTime/dt up front.
 */
import type { NetworkConfig, TransientResult } from "./schema";
import { resolveNetworkParameters } from "./paramBindings";
import { createHistoryRecorders } from "./transient/historyRecorders";
import { runFixedTimeStepping } from "./transient/fixedStepping";
import { runAdaptiveTimeStepping } from "./transient/adaptiveStepping";
import type { SolveTransientOptions } from "./transient/types";

export { applyBoundaryConditions } from "./transient/boundaryConditions";
export { cloneState } from "./transient/stateUtils";

/**
 * Solve a transient thermal-fluid network from t = 0 to `settings.endTime`.
 *
 * Backward-Euler time integration with a coupled Newton–Raphson solve at
 * every step (mass/energy storage terms included). Two stepping modes:
 *
 * - `settings.timeStepping: 'fixed'` (default) — uniform `settings.dt`.
 *   Every step is appended to the trajectory, even a non-converged one
 *   (flagged via `converged: false` and the per-step `stepResiduals` /
 *   `stepResidualsScaled` series).
 * - `settings.timeStepping: 'adaptive'` — step-doubling local error
 *   estimation over internal-node pressures and temperatures. A rejected
 *   step is retried with a smaller dt; dt is adapted within
 *   [dtMin, dtMax] and truncated so every accepted step lands exactly on
 *   schedule breakpoints and `endTime`. Accepted/rejected statistics are
 *   returned in `result.stats` ({ steps, rejectedSteps, minDt, maxDt,
 *   dtAtMinCount, accuracyLimited }).
 *
 * @param config - Validated network configuration (call {@link validateNetwork} first);
 *   internal nodes must have a positive `volume`
 * @param options - `onProgress` receives `{ step, totalSteps?, time, endTime, dt?, partial }`
 *   where `partial` is the trajectory recorded so far (`totalSteps` is only
 *   present for fixed stepping); `progressInterval` overrides the default
 *   emission cadence (~200 emissions per run); `shouldAbort` stops the run
 *   at the next opportunity and the returned result carries the partial
 *   trajectory with `aborted: true`
 * @returns Time series for every node and branch variable, aligned 1:1 with `times`
 * @throws {Error} if `settings.endTime` (or `settings.dt` in fixed mode) is
 *   missing or non-positive, or if config is structurally invalid (use
 *   {@link decodeNetworkConfig} + {@link validateNetwork} first)
 */
export function solveTransient(
  inputConfig: NetworkConfig,
  options?: SolveTransientOptions,
): TransientResult {
  // Defense in depth (validateNetwork already resolves bindings): solve the
  // immutable parameter-resolved clone (core/paramBindings.ts) — formulas
  // are evaluated once here, never inside a transient step.
  const resolution = resolveNetworkParameters(inputConfig);
  if (!resolution.ok) {
    throw new Error(
      `solveTransient: invalid parameter bindings:\n${resolution.errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
  const config = resolution.config;
  const isAdaptive = config.settings.timeStepping === "adaptive";
  const endTime = config.settings.endTime;
  if (endTime === undefined || endTime <= 0) {
    throw new Error("Transient simulation requires settings.endTime > 0");
  }

  const history = createHistoryRecorders();
  return isAdaptive
    ? runAdaptiveTimeStepping(config, endTime, options, history)
    : runFixedTimeStepping(config, endTime, options, history);
}
