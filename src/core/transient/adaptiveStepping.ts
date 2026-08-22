/**
 * `settings.timeStepping: 'adaptive'`: step-doubling local error estimation
 * over internal-node pressures and enthalpies/temperatures (plus solid
 * temperatures). A rejected step is retried with a smaller dt; dt is adapted
 * within [dtMin, dtMax] and truncated so every accepted step lands exactly
 * on schedule breakpoints and `endTime`. Unlike fixed stepping, a
 * non-converging Newton solve also triggers a dt retry rather than being
 * recorded. Accepted/rejected statistics are returned in `result.stats`.
 */
import type { ResolvedNetworkConfig, TransientResult } from "../schema";
import type { StepState } from "../solver";
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
import { RealFluid } from "../fluids/realFluid";
import { cloneState } from "./stateUtils";
import { applyBoundaryConditions } from "./boundaryConditions";
import { advanceStatefulComponents } from "./statefulComponents";
import type { HistoryRecorders } from "./historyRecorders";
import {
  initTransientResults,
  recordTransientStep,
  buildPartialTransientResult,
} from "./resultRecorder";
import { collectScheduleBreakpoints } from "./breakpoints";
import type { SolveTransientOptions } from "./types";

export function runAdaptiveTimeStepping(
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

  const a = config.settings.adaptive!;
  const dtMin = a.dtMin;
  const dtMax = a.dtMax;
  const relTol = a.relTol;
  const absTolP = a.absTolP ?? 100;
  const absTolT = a.absTolT ?? 0.01;
  const safety = a.safety ?? 0.9;
  const dtInitial =
    a.dtInitial ?? config.settings.dt ?? Math.sqrt(dtMin * dtMax);
  let currentDt = Math.min(dtMax, Math.max(dtMin, dtInitial));

  const ctx = buildSolverContext(config);
  // PID controller runtime (same discipline as the fixed-stepping path).
  const controllers = createControllerRuntime(config, ctx);
  controllers?.initialize();

  let state = createInitialState(ctx, config);
  applyBoundaryConditions(ctx, config, state, 0);
  // darrHartwig + ttWf: initialize the step-level accepted states from the
  // t=0 state.
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

  let acceptedSteps = 0;
  let rejectedSteps = 0;
  let dtAtMinCount = 0;
  let allConverged = true;
  let minDt = currentDt;
  let maxDt = currentDt;

  const stats = () => ({
    steps: acceptedSteps,
    rejectedSteps,
    minDt,
    maxDt,
    dtAtMinCount,
    accuracyLimited: dtAtMinCount > 0,
  });

  if (options?.onProgress) {
    options.onProgress({
      step: 0,
      time: 0,
      endTime,
      dt: currentDt,
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
        stats: stats(),
        ...logicResultFields(logic),
        ...controllerResultFields(controllers),
      };
    }
  }

  const sortedBreakpoints = collectScheduleBreakpoints(config, endTime);

  let t = 0;
  let nextBpIdx = 0;

  const progressInterval =
    options?.progressInterval ??
    Math.max(1, Math.floor(endTime / (currentDt * 200)));

  while (t < endTime) {
    if (options?.shouldAbort && options.shouldAbort()) {
      logic?.fire("solveEnd", buildLogicScope(ctx, state), {
        t,
        dt: currentDt,
      });
      return {
        ...partial(acceptedSteps, allConverged, true),
        aborted: true,
        stats: stats(),
        ...logicResultFields(logic),
        ...controllerResultFields(controllers),
      };
    }

    while (
      nextBpIdx < sortedBreakpoints.length &&
      sortedBreakpoints[nextBpIdx] <= t
    )
      nextBpIdx++;
    const nextEvent =
      nextBpIdx < sortedBreakpoints.length
        ? sortedBreakpoints[nextBpIdx]
        : endTime;
    const maxDtNow = nextEvent - t;

    let dt = Math.min(currentDt, maxDtNow, endTime - t);
    if (dt <= 0) dt = dtMin;

    let stepAccepted = false;
    let nrFailedAtMin = false;
    // The ACCEPTED half-step state of the step-doubling pair (sMid for the
    // accepted dt) — the fluid-front commit follows the accepted trajectory
    // as two half-step commits (see updateFluidFrontStates).
    let acceptedMid: StepState | undefined;
    // Solver-iteration telemetry of the ACCEPTED candidate (for the
    // stepAccepted logic scope).
    let acceptedIter: number | undefined;
    let acceptedResidual: number | undefined;
    let certifiedAccepted = true;
    const lifecycleBaseState = state;

    while (!stepAccepted) {
      // A stop requested by a stepRejected rule ends the retry loop; the
      // userTerminated check after the loop returns the partial result.
      if (logic?.userTerminated) break;
      if (options?.shouldAbort && options.shouldAbort()) {
        logic?.fire("solveEnd", buildLogicScope(ctx, state), { t, dt });
        return {
          ...partial(acceptedSteps, allConverged, true),
          aborted: true,
          stats: stats(),
          ...logicResultFields(logic),
          ...controllerResultFields(controllers),
        };
      }

      // Logic lifecycle: stepStart before each CANDIDATE solve.  `state` is
      // the last accepted state.  stepStart register writes are SPECULATIVE:
      // rejectCandidate() rolls them back before stepRejected fires, so a
      // rejected candidate leaves no persistent register trace.
      const logicSnapshot = logic?.snapshot();
      logic?.fire("stepStart", buildLogicScope(ctx, state), { t: t + dt, dt });
      if (logic?.userTerminated) {
        logic.fire("solveEnd", buildLogicScope(ctx, state), { t, dt });
        return {
          ...partial(acceptedSteps, allConverged),
          stats: stats(),
          ...logicResultFields(logic),
          ...controllerResultFields(controllers),
        };
      }
      if (logic) controllers?.executeRegisters(logic);
      const rejectCandidate = (): void => {
        if (!logic) return;
        if (logicSnapshot) logic.restore(logicSnapshot);
        logic.fire("stepRejected", buildLogicScope(ctx, state), {
          t: t + dt,
          dt,
        });
      };

      // One full BE step of size dt -> y1
      const s1 = cloneState(state);
      applyBoundaryConditions(ctx, config, s1, t + dt);
      const res1 = solveStateStep(ctx, s1, {
        dt,
        t: t + dt,
        tol: config.settings.tolerance,
        maxIterations: config.settings.maxIterations,
        relaxation: config.settings.relaxation ?? 1.0,
        prevState: state,
        jacobian: config.settings.jacobian ?? "hybrid",
        certifyAfterCoupling: config.settings.certifyAfterCoupling === true,
        globalization: config.settings.globalization ?? "lineSearch",
      });
      if (!res1.converged) {
        rejectCandidate();
        if (dt <= dtMin) {
          allConverged = false;
          nrFailedAtMin = true;
          break;
        }
        dt = Math.max(dtMin, dt / 2);
        continue;
      }

      // Two BE steps of dt/2 -> y2
      const sMid = cloneState(state);
      applyBoundaryConditions(ctx, config, sMid, t + dt / 2);
      const resMid = solveStateStep(ctx, sMid, {
        dt: dt / 2,
        t: t + dt / 2,
        tol: config.settings.tolerance,
        maxIterations: config.settings.maxIterations,
        relaxation: config.settings.relaxation ?? 1.0,
        prevState: state,
        jacobian: config.settings.jacobian ?? "hybrid",
        certifyAfterCoupling: config.settings.certifyAfterCoupling === true,
        globalization: config.settings.globalization ?? "lineSearch",
      });
      if (!resMid.converged) {
        rejectCandidate();
        if (dt <= dtMin) {
          allConverged = false;
          nrFailedAtMin = true;
          break;
        }
        dt = Math.max(dtMin, dt / 2);
        continue;
      }

      const s2 = cloneState(sMid);
      applyBoundaryConditions(ctx, config, s2, t + dt);
      const res2 = solveStateStep(ctx, s2, {
        dt: dt / 2,
        t: t + dt,
        tol: config.settings.tolerance,
        maxIterations: config.settings.maxIterations,
        relaxation: config.settings.relaxation ?? 1.0,
        prevState: sMid,
        jacobian: config.settings.jacobian ?? "hybrid",
        certifyAfterCoupling: config.settings.certifyAfterCoupling === true,
        globalization: config.settings.globalization ?? "lineSearch",
      });
      if (!res2.converged) {
        rejectCandidate();
        if (dt <= dtMin) {
          allConverged = false;
          nrFailedAtMin = true;
          break;
        }
        dt = Math.max(dtMin, dt / 2);
        continue;
      }

      // Error estimate (weighted RMS over all internal P, T (or H for realFluid) and solid T)
      let sumSq = 0;
      let nVars = 0;
      for (const id of ctx.internalIds) {
        const y2p = s2.nodeP.get(id)!;
        const diffP = y2p - s1.nodeP.get(id)!;
        const scaleP = absTolP + relTol * Math.abs(y2p);
        sumSq += (diffP / scaleP) ** 2;
        nVars++;

        if (ctx.fluidAssignment.node(id) instanceof RealFluid) {
          const y2h = s2.nodeH!.get(id)!;
          const diffH = y2h - s1.nodeH!.get(id)!;
          const scaleH = 1000 + relTol * Math.abs(y2h);
          sumSq += (diffH / scaleH) ** 2;
          nVars++;
        } else {
          const y2t = s2.nodeT.get(id)!;
          const diffT = y2t - s1.nodeT.get(id)!;
          const scaleT = absTolT + relTol * Math.abs(y2t);
          sumSq += (diffT / scaleT) ** 2;
          nVars++;
        }
      }
      for (const id of ctx.solidIds) {
        const y2t = s2.solidT.get(id)!;
        const diffT = y2t - s1.solidT.get(id)!;
        const scaleT = absTolT + relTol * Math.abs(y2t);
        sumSq += (diffT / scaleT) ** 2;
        nVars++;
      }
      const err = nVars > 0 ? Math.sqrt(sumSq / nVars) : 0;

      if (err <= 1) {
        stepAccepted = true;
        state = s2;
        acceptedMid = sMid;
        acceptedIter = res2.iterations;
        acceptedResidual = res2.residual;
        let growth = safety * Math.pow(err, -0.5);
        if (!isFinite(growth) || growth > 5) growth = 5;
        if (growth < 0.2) growth = 0.2;
        currentDt = Math.min(dtMax, Math.max(dtMin, dt * growth));
      } else {
        rejectedSteps++;
        if (dt <= dtMin) {
          stepAccepted = true;
          dtAtMinCount++;
          // The state is accepted at the configured error-control floor.
          // Nonlinear convergence remains valid; stats expose that requested
          // local accuracy could not be met at this step.
          certifiedAccepted = true;
          state = s2;
          acceptedMid = sMid;
          acceptedIter = res2.iterations;
          acceptedResidual = res2.residual;
          currentDt = dtMin;
        } else {
          // Error-estimate rejection: roll back the speculative stepStart
          // writes, THEN fire stepRejected (its own writes commit).
          rejectCandidate();
          let growth = safety * Math.pow(err, -0.5);
          if (!isFinite(growth) || growth > 5) growth = 5;
          if (growth < 0.2) growth = 0.2;
          let dtNew = dt * growth;
          if (dtNew < dtMin) dtNew = dtMin;
          dt = dtNew;
        }
      }
    }

    // A stop requested by a stepRejected rule ends the run at the last
    // ACCEPTED state (the rejected candidate is not recorded).
    if (logic?.userTerminated) {
      logic.fire("solveEnd", buildLogicScope(ctx, state), { t, dt });
      return {
        ...partial(acceptedSteps, allConverged),
        stats: stats(),
        ...logicResultFields(logic),
        ...controllerResultFields(controllers),
      };
    }

    if (nrFailedAtMin) break;

    t += dt;
    acceptedSteps++;
    // darrHartwig + ttWf: the step was ACCEPTED (state = s2) — commit the
    // accepted-step correlation states exactly once per accepted step, with
    // the accepted dt.  Rejected trial steps (the !stepAccepted loop above)
    // never reach this call, so their proposals never touch the committed
    // state.  The fluid-front commit receives the accepted HALF-step state
    // as well: its two-substep update follows the accepted trajectory
    // (updateFluidFrontStates has the rationale).
    if (certifiedAccepted) {
      recordTtWf(updateConductorLatches(ctx, state, dt));
      recordFluidFront(updateFluidFrontStates(ctx, state, dt, acceptedMid));
    }
    if (dt < minDt) minDt = dt;
    if (dt > maxDt) maxDt = dt;

    // The accepted state is the second half-step solution: its momentum rows
    // were solved from the mid state with dt/2 (the reported branch dP
    // subtracts the fluid-inertia term against exactly that pair).
    recordTransientStep(ctx, config, acc, t, state, acceptedMid, dt / 2);

    // Branch-owned stateful dynamics (e.g. DynamicCheckValve poppet ODE):
    // advance from the ACCEPTED step state — same "certified accepted"
    // gate as the correlation latches above, so an error-control floor
    // acceptance still advances it exactly once with the accepted dt.
    if (certifiedAccepted) advanceStatefulComponents(ctx, state, dt);

    // Controller lifecycle: execute PIDs against the ACCEPTED step state
    // with the accepted dt — outputs take effect on the NEXT step.
    if (certifiedAccepted) controllers?.executePid(state, dt);

    // Logic lifecycle: the step was ACCEPTED and recorded — stepAccepted
    // rules see the accepted persistent state; their register writes commit.
    // A stop rule ends the run with the partial result INCLUDING this
    // accepted step.
    logic?.fire(
      certifiedAccepted ? "stepAccepted" : "stepRejected",
      buildLogicScope(ctx, certifiedAccepted ? state : lifecycleBaseState),
      {
        t,
        dt,
        iter: acceptedIter,
        residual: acceptedResidual,
      },
    );
    if (logic?.userTerminated) {
      logic.fire("solveEnd", buildLogicScope(ctx, state), {
        t,
        dt,
        iter: acceptedIter,
        residual: acceptedResidual,
      });
      return {
        ...partial(acceptedSteps, allConverged),
        stats: stats(),
        ...logicResultFields(logic),
        ...controllerResultFields(controllers),
      };
    }

    if (
      options?.onProgress &&
      (acceptedSteps % progressInterval === 0 || t >= endTime)
    ) {
      options.onProgress({
        step: acceptedSteps,
        time: t,
        endTime,
        dt,
        partial: partial(acceptedSteps, allConverged),
      });
    }
  }

  // Logic lifecycle: converged only when the time loop ran to completion
  // with every step converged (NOT on the nrFailedAtMin break); solveEnd
  // on every exit that reaches this point.
  if (logic) {
    if (t >= endTime && allConverged) {
      logic.fire("converged", buildLogicScope(ctx, state), {
        t,
        dt: currentDt,
      });
    }
    logic.fire("solveEnd", buildLogicScope(ctx, state), { t, dt: currentDt });
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
    stats: stats(),
    ...logicResultFields(logic),
    ...controllerResultFields(controllers),
  };
}
