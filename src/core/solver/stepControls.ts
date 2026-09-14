/**
 * stepControls.ts — the one place `settings` becomes solveStateStep options.
 *
 * Steady and transient solves share the same Newton kernel but not the same
 * defaults, and those defaults used to be written out at every call site
 * (once in steady.ts, once in fixedStepping.ts, three times in
 * adaptiveStepping.ts). Centralising them makes the asymmetry a stated
 * decision rather than something to discover by diffing call sites:
 *
 *  - Globalization defaults to `trustRegion` for steady solves and to
 *    `lineSearch` for transient steps. A steady solve starts far from its
 *    root and the dogleg's step-length control earns its keep; a transient
 *    step starts at the previous accepted state, close to the root, where
 *    the cheaper backtracking line search converges in a handful of
 *    iterations and the trust region's model-reduction bookkeeping is pure
 *    overhead.
 *  - `steadySolver` (pseudo-transient continuation vs direct Newton) exists
 *    only for steady solves.
 *  - `certifyAfterCoupling` (re-measure the certifying residual after the
 *    segregated coupling update) exists only for transient steps.
 */
import type { NetworkConfig } from "../schema";
import type { SolveStepOptions } from "./step";

type Settings = NetworkConfig["settings"];

/** Fields of SolveStepOptions that come from `settings` rather than from
 *  the driver loop (dt, t, prevState, callbacks). */
export type StepControls = Pick<
  SolveStepOptions,
  | "tol"
  | "maxIterations"
  | "relaxation"
  | "jacobian"
  | "globalization"
  | "steadySolver"
  | "certifyAfterCoupling"
>;

export function steadyStepControls(settings: Settings): StepControls {
  return {
    tol: settings.tolerance,
    maxIterations: settings.maxIterations,
    relaxation: settings.relaxation ?? 1.0,
    jacobian: settings.jacobian ?? "hybrid",
    globalization: settings.globalization ?? "trustRegion",
    steadySolver: settings.steadySolver ?? "ptc",
  };
}

export function transientStepControls(settings: Settings): StepControls {
  return {
    tol: settings.tolerance,
    maxIterations: settings.maxIterations,
    relaxation: settings.relaxation ?? 1.0,
    jacobian: settings.jacobian ?? "hybrid",
    globalization: settings.globalization ?? "lineSearch",
    certifyAfterCoupling: settings.certifyAfterCoupling === true,
  };
}
