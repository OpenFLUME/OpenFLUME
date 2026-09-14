/**
 * runSetup.ts — what fixed and adaptive time stepping share before their
 * loops diverge: context, controllers, the t = 0 state with boundary
 * conditions applied and correlation latches seeded, the logic runtime, the
 * result accumulators, and the `partial()` snapshot builder every early
 * return uses. The two drivers used to carry byte-identical copies of all
 * of this; a change to the t = 0 protocol had to be made twice.
 *
 * The ORDER here is part of the numerical contract and must not be
 * rearranged casually:
 *   1. controllers.initialize() writes `initialOutput` actuation BEFORE the
 *      t = 0 boundary application, so seeded overrides take effect from the
 *      first step;
 *   2. the darrHartwig / ttWf / fluidFront accepted-state latches are seeded
 *      from the fully-initialised t = 0 state (no-ops without such
 *      conductors);
 *   3. the logic runtime's `init` fires last, against that same state, and
 *      may terminate the run before the first step.
 */
import type { ResolvedNetworkConfig, TransientResult } from "../schema";
import type { SolverContext, StepState } from "../solver";
import {
  buildSolverContext,
  buildLogicScope,
  createInitialState,
  updateConductorLatches,
  updateFluidFrontStates,
} from "../solver";
import {
  transientStepControls,
  type StepControls,
} from "../solver/stepControls";
import {
  createLogicRuntime,
  logicResultFields,
  type LogicRuntime,
} from "../logicRuntime";
import {
  createControllerRuntime,
  controllerResultFields,
  type ControllerRuntime,
} from "../controllerRuntime";
import { applyBoundaryConditions } from "./boundaryConditions";
import type { HistoryRecorders } from "./historyRecorders";
import {
  initTransientResults,
  buildPartialTransientResult,
  type TransientResultAccumulators,
} from "./resultRecorder";

export interface TransientRun {
  ctx: SolverContext;
  state: StepState;
  controllers: ControllerRuntime | undefined;
  logic: LogicRuntime | undefined;
  acc: TransientResultAccumulators;
  /** solveStateStep options that come from `settings` (the loop adds dt,
   *  t and prevState). */
  controls: StepControls;
  /** Trajectory snapshot up to `stepIndex`, for progress and early exits. */
  partial: (
    stepIndex: number,
    converged: boolean,
    aborted?: boolean,
  ) => TransientResult;
  /** The logic/controller result fields every return path appends. */
  runtimeFields: () => Partial<TransientResult>;
}

export function prepareTransientRun(
  config: ResolvedNetworkConfig,
  history: HistoryRecorders,
): TransientRun {
  const ctx = buildSolverContext(config);

  // PID controller runtime (core/controllerRuntime.ts).  Undefined unless
  // the network configures controllers, in which case every path below is
  // unchanged.
  const controllers = createControllerRuntime(config, ctx);
  controllers?.initialize();

  const state = createInitialState(ctx, config);
  applyBoundaryConditions(ctx, config, state, 0);
  history.recordTtWf(updateConductorLatches(ctx, state));
  history.recordFluidFront(updateFluidFrontStates(ctx, state));

  // User-logic runtime (registers + LogicRule lifecycle — see
  // core/logicRuntime.ts).  Undefined unless the network configures
  // registers/logic, in which case every path below is unchanged.
  const logic = createLogicRuntime(config);

  const acc = initTransientResults(ctx, config, state);
  const partial = (stepIndex: number, converged: boolean, aborted?: boolean) =>
    buildPartialTransientResult(
      stepIndex,
      acc.times,
      acc.nodeResults,
      acc.branchResults,
      acc.solidResults,
      acc.conductorResults,
      acc.junctionResults,
      history.ttWfResultField(),
      history.fluidFrontResultField(),
      converged,
      aborted,
    );

  return {
    ctx,
    state,
    controllers,
    logic,
    acc,
    controls: transientStepControls(config.settings),
    partial,
    runtimeFields: () => ({
      ...logicResultFields(logic),
      ...controllerResultFields(controllers),
    }),
  };
}

/**
 * Logic lifecycle `init` at t = 0. Returns true when a rule stopped the run
 * before the first step (the caller returns `partial(0, true)` plus the
 * runtime fields).
 */
export function fireLogicInit(run: TransientRun): boolean {
  const { logic, controllers, ctx, state } = run;
  if (!logic) return false;
  logic.fire("init", buildLogicScope(ctx, state), { t: 0 });
  controllers?.syncRegisters(logic);
  if (logic.userTerminated) {
    logic.fire("solveEnd", buildLogicScope(ctx, state), { t: 0 });
    return true;
  }
  return false;
}
