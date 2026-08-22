/**
 * `settings.timeStepping: 'fixed'` (the default): uniform `settings.dt` from
 * t = 0 to `endTime`. Every step is appended to the trajectory, even a
 * non-converged one (flagged via `converged: false` and the per-step
 * `stepResiduals` / `stepResidualsScaled` series) — unlike adaptive stepping,
 * fixed stepping never retries with a smaller dt.
 */
import type { ResolvedNetworkConfig, TransientResult } from "../schema";
import {
  buildSolverContext,
  buildLogicScope,
  createInitialState,
  solveStateStep,
  updateConductorLatches,
  updateFluidFrontStates,
} from "../solver";
import { createLogicRuntime, logicResultFields } from "../logicRuntime";
import {
  createControllerRuntime,
  controllerResultFields,
} from "../controllerRuntime";
import { cloneState } from "./stateUtils";
import { applyBoundaryConditions } from "./boundaryConditions";
import { advanceStatefulComponents } from "./statefulComponents";
import type { HistoryRecorders } from "./historyRecorders";
import {
  initTransientResults,
  recordTransientStep,
  buildPartialTransientResult,
} from "./resultRecorder";
import type { SolveTransientOptions } from "./types";

export function runFixedTimeStepping(
  config: ResolvedNetworkConfig,
  endTime: number,
  options: SolveTransientOptions | undefined,
  history: HistoryRecorders,
): TransientResult {
  const {
    recordTtWf,
    recordFluidFront,
    ttWfResultField,
    fluidFrontResultField,
  } = history;

  const dt = config.settings.dt;
  if (dt === undefined || dt <= 0) {
    throw new Error("Transient simulation requires settings.dt > 0");
  }

  const ctx = buildSolverContext(config);
  const steps = Math.round(endTime / dt);
  const progressInterval =
    options?.progressInterval ?? Math.max(1, Math.floor(steps / 200));

  // PID controller runtime (core/controllerRuntime.ts).  Undefined unless
  // the network configures controllers, in which case every path below is
  // unchanged.  initialize() writes `initialOutput` actuation BEFORE the
  // t = 0 boundary application so seeded boundary overrides take effect
  // from the first step.
  const controllers = createControllerRuntime(config, ctx);
  controllers?.initialize();

  let state = createInitialState(ctx, config);
  applyBoundaryConditions(ctx, config, state, 0);
  // darrHartwig + ttWf + fluidFront: initialize the step-level accepted
  // states from the t=0 state (no-op when no such conductor is configured).
  recordTtWf(updateConductorLatches(ctx, state));
  recordFluidFront(updateFluidFrontStates(ctx, state));

  // User-logic runtime (registers + LogicRule lifecycle — see
  // core/logicRuntime.ts).  Undefined unless the network configures
  // registers/logic, in which case every path below is unchanged.
  const logic = createLogicRuntime(config);

  const acc = initTransientResults(ctx, config, state);
  const { times, nodeResults, branchResults, solidResults, conductorResults } =
    acc;

  const partial = (stepIndex: number, converged: boolean, aborted?: boolean) =>
    buildPartialTransientResult(
      stepIndex,
      times,
      nodeResults,
      branchResults,
      solidResults,
      conductorResults,
      ttWfResultField(),
      fluidFrontResultField(),
      converged,
      aborted,
    );

  if (options?.onProgress) {
    options.onProgress({
      step: 0,
      totalSteps: steps,
      time: 0,
      endTime,
      dt,
      partial: partial(0, true),
    });
  }

  // Logic lifecycle: init at t = 0 with the fully-initialized state.
  if (logic) {
    logic.fire("init", buildLogicScope(ctx, state), { t: 0 });
    controllers?.syncRegisters(logic);
    if (logic.userTerminated) {
      logic.fire("solveEnd", buildLogicScope(ctx, state), { t: 0 });
      return {
        ...partial(0, true),
        ...logicResultFields(logic),
        ...controllerResultFields(controllers),
      };
    }
  }

  let allConverged = true;
  const stepResiduals: number[] = [];
  const stepResidualsScaled: number[] = [];

  for (let step = 1; step <= steps; step++) {
    if (options?.shouldAbort && options.shouldAbort()) {
      logic?.fire("solveEnd", buildLogicScope(ctx, state), {
        t: (step - 1) * dt,
        dt,
      });
      return {
        ...partial(step - 1, allConverged, true),
        aborted: true,
        ...logicResultFields(logic),
        ...controllerResultFields(controllers),
      };
    }

    const t = step * dt;
    // Logic lifecycle: stepStart before the candidate solve.  `state` is
    // still the last accepted step here (boundary schedules for t are
    // applied below); fixed stepping accepts every step, so stepStart
    // register writes are committed only if the nonlinear step converges.
    const logicSnapshot = logic?.snapshot();
    logic?.fire("stepStart", buildLogicScope(ctx, state), { t, dt });
    if (logic?.userTerminated) {
      logic.fire("solveEnd", buildLogicScope(ctx, state), { t: t - dt, dt });
      return {
        ...partial(step - 1, allConverged),
        ...logicResultFields(logic),
        ...controllerResultFields(controllers),
      };
    }
    if (logic) controllers?.executeRegisters(logic);
    const prevState = cloneState(state);
    applyBoundaryConditions(ctx, config, state, t);

    const res = solveStateStep(ctx, state, {
      dt,
      t,
      tol: config.settings.tolerance,
      maxIterations: config.settings.maxIterations,
      relaxation: config.settings.relaxation ?? 1.0,
      prevState,
      jacobian: config.settings.jacobian ?? "hybrid",
      certifyAfterCoupling: config.settings.certifyAfterCoupling === true,
      globalization: config.settings.globalization ?? "lineSearch",
    });

    if (!res.converged) allConverged = false;
    // Fixed stepping retains failed states for the legacy diagnostic
    // trajectory, but stateful extensions advance only from a genuinely
    // converged numerical step.
    if (res.converged) {
      recordTtWf(updateConductorLatches(ctx, state, dt));
      recordFluidFront(updateFluidFrontStates(ctx, state, dt));
    }
    stepResiduals.push(res.residual);
    stepResidualsScaled.push(res.residualScaled ?? res.residual);

    recordTransientStep(ctx, config, acc, t, state, prevState, dt);

    if (res.converged) {
      // Branch-owned stateful dynamics (e.g. DynamicCheckValve poppet ODE):
      // advance from the ACCEPTED step state — effects take hold on the
      // NEXT step's Newton solve, same lagged-coupling discipline as PIDs.
      advanceStatefulComponents(ctx, state, dt);

      // Controller lifecycle: execute PIDs against the ACCEPTED step state
      // with the accepted dt — outputs take effect on the NEXT step.
      controllers?.executePid(state, dt);

      // Logic lifecycle: only a converged numerical step is accepted for
      // stateful extensions, even though fixed mode retains failed states
      // in its diagnostic trajectory.
      logic?.fire("stepAccepted", buildLogicScope(ctx, state), {
        t,
        dt,
        iter: res.iterations,
        residual: res.residual,
      });
    } else {
      if (logicSnapshot && logic) logic.restore(logicSnapshot);
      logic?.fire("stepRejected", buildLogicScope(ctx, prevState), {
        t,
        dt,
        iter: res.iterations,
        residual: res.residual,
      });
    }
    if (logic?.userTerminated) {
      logic.fire("solveEnd", buildLogicScope(ctx, state), {
        t,
        dt,
        iter: res.iterations,
        residual: res.residual,
      });
      return {
        ...partial(step, allConverged),
        stepResiduals,
        stepResidualsScaled,
        ...logicResultFields(logic),
        ...controllerResultFields(controllers),
      };
    }

    if (
      options?.onProgress &&
      (step % progressInterval === 0 || step === steps)
    ) {
      options.onProgress({
        step,
        totalSteps: steps,
        time: t,
        endTime,
        partial: partial(step, allConverged),
      });
    }
  }

  // Logic lifecycle: converged (all steps converged) then solveEnd.
  if (logic) {
    if (allConverged) {
      logic.fire("converged", buildLogicScope(ctx, state), {
        t: endTime,
        dt,
      });
    }
    logic.fire("solveEnd", buildLogicScope(ctx, state), { t: endTime, dt });
  }

  return {
    converged: allConverged,
    times,
    nodes: nodeResults,
    branches: branchResults,
    solidNodes: solidResults,
    conductors: conductorResults,
    ttWf: ttWfResultField(),
    fluidFront: fluidFrontResultField(),
    stepResiduals,
    stepResidualsScaled,
    ...logicResultFields(logic),
    ...controllerResultFields(controllers),
  };
}
