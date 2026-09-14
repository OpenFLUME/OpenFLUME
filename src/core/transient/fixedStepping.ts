/**
 * `settings.timeStepping: 'fixed'` (the default): uniform `settings.dt` from
 * t = 0 to `endTime`. Every step is appended to the trajectory, even a
 * non-converged one (flagged via `converged: false` and the per-step
 * `stepResiduals` / `stepResidualsScaled` series) — unlike adaptive stepping,
 * fixed stepping never retries with a smaller dt.
 */
import type { ResolvedNetworkConfig, TransientResult } from "../schema";
import {
  buildLogicScope,
  solveStateStep,
  updateConductorLatches,
  updateFluidFrontStates,
} from "../solver";
import { cloneState } from "./stateUtils";
import { applyBoundaryConditions } from "./boundaryConditions";
import { advanceStatefulComponents } from "./statefulComponents";
import type { HistoryRecorders } from "./historyRecorders";
import { recordTransientStep } from "./resultRecorder";
import { prepareTransientRun, fireLogicInit } from "./runSetup";
import type { SolveTransientOptions } from "./types";

export function runFixedTimeStepping(
  config: ResolvedNetworkConfig,
  endTime: number,
  options: SolveTransientOptions | undefined,
  history: HistoryRecorders,
): TransientResult {
  const { recordTtWf, recordFluidFront } = history;

  const dt = config.settings.dt;
  if (dt === undefined || dt <= 0) {
    throw new Error("Transient simulation requires settings.dt > 0");
  }

  const run = prepareTransientRun(config, history);
  const { ctx, state, controllers, logic, acc, controls, partial } = run;
  const steps = Math.round(endTime / dt);
  const progressInterval =
    options?.progressInterval ?? Math.max(1, Math.floor(steps / 200));

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

  if (fireLogicInit(run)) {
    return { ...partial(0, true), ...run.runtimeFields() };
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
        ...run.runtimeFields(),
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
        ...run.runtimeFields(),
      };
    }
    if (logic) controllers?.executeRegisters(logic);
    const prevState = cloneState(state);
    applyBoundaryConditions(ctx, config, state, t);

    const res = solveStateStep(ctx, state, { ...controls, dt, t, prevState });

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
        ...run.runtimeFields(),
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
    times: acc.times,
    nodes: acc.nodeResults,
    branches: acc.branchResults,
    solidNodes: acc.solidResults,
    conductors: acc.conductorResults,
    junctions: acc.junctionResults,
    ttWf: history.ttWfResultField(),
    fluidFront: history.fluidFrontResultField(),
    stepResiduals,
    stepResidualsScaled,
    ...run.runtimeFields(),
  };
}
