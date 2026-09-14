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
  buildLogicScope,
  solveStateStep,
  updateConductorLatches,
  updateFluidFrontStates,
} from "../solver";
import { cloneState } from "./stateUtils";
import { applyBoundaryConditions } from "./boundaryConditions";
import {
  advanceStatefulComponents,
  restoreStatefulComponents,
  snapshotStatefulComponents,
  statefulComponentState,
} from "./statefulComponents";
import type { HistoryRecorders } from "./historyRecorders";
import { recordTransientStep } from "./resultRecorder";
import { collectScheduleBreakpoints } from "./breakpoints";
import { prepareTransientRun, fireLogicInit } from "./runSetup";
import type { SolveTransientOptions } from "./types";

export function runAdaptiveTimeStepping(
  config: ResolvedNetworkConfig,
  endTime: number,
  options: SolveTransientOptions | undefined,
  history: HistoryRecorders,
): TransientResult {
  const { recordTtWf, recordFluidFront } = history;

  const a = config.settings.adaptive!;
  const dtMin = a.dtMin;
  const dtMax = a.dtMax;
  const relTol = a.relTol;
  const absTolP = a.absTolP ?? 100;
  const absTolT = a.absTolT ?? 0.01;
  const absTolMdot = a.absTolMdot ?? 1e-4;
  /** Component dynamic states are O(1) dimensionless (fractional opening). */
  const ABS_TOL_COMPONENT = 1e-3;
  const safety = a.safety ?? 0.9;
  const dtInitial =
    a.dtInitial ?? config.settings.dt ?? Math.sqrt(dtMin * dtMax);
  let currentDt = Math.min(dtMax, Math.max(dtMin, dtInitial));

  const run = prepareTransientRun(config, history);
  const { ctx, controllers, logic, acc, controls, partial } = run;
  let state = run.state;

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

  if (fireLogicInit(run)) {
    return { ...partial(0, true), stats: stats(), ...run.runtimeFields() };
  }

  const sortedBreakpoints = collectScheduleBreakpoints(config, endTime);

  let t = 0;
  let nextBpIdx = 0;

  const progressInterval =
    options?.progressInterval ??
    Math.max(1, Math.floor(endTime / (currentDt * 200)));

  // `t` accumulates the accepted dts, so after the step that lands on
  // endTime it can sit a few ulps short of it (0.49999999999999994 for 0.5).
  // Treating that residue as "one more step" would attempt a ~1e-16 s step,
  // which a stiff momentum row (fluid inertia: (L/A)·Δṁ/dt) cannot converge
  // — and the run would be reported unconverged at its own end time.
  const T_EPS = 1e-12 * Math.max(endTime, 1);
  const reachedEnd = () => endTime - t <= T_EPS;

  while (!reachedEnd()) {
    if (options?.shouldAbort && options.shouldAbort()) {
      logic?.fire("solveEnd", buildLogicScope(ctx, state), {
        t,
        dt: currentDt,
      });
      return {
        ...partial(acceptedSteps, allConverged, true),
        aborted: true,
        stats: stats(),
        ...run.runtimeFields(),
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
          ...run.runtimeFields(),
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
          ...run.runtimeFields(),
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

      // One backward-Euler candidate from `from`, boundary conditions
      // applied at its target time. Returns the solved state, or undefined
      // when the Newton did not certify.
      const candidate = (
        from: StepState,
        stepDt: number,
        target: number,
      ): { s: StepState; iterations: number; residual: number } | undefined => {
        const s = cloneState(from);
        applyBoundaryConditions(ctx, config, s, target);
        const res = solveStateStep(ctx, s, {
          ...controls,
          dt: stepDt,
          t: target,
          prevState: from,
        });
        return res.converged
          ? { s, iterations: res.iterations, residual: res.residual }
          : undefined;
      };
      // Stateful components (a check valve's poppet) advance along EACH
      // candidate trajectory so their motion enters the error estimate and
      // the two-half-step path sees the mid-step state; every exit that does
      // not accept must first return them to the accepted state's components.
      const componentsAtStart = snapshotStatefulComponents(ctx);
      const rollbackComponents = () =>
        restoreStatefulComponents(ctx, componentsAtStart);
      // A candidate that failed to converge: retry at half the step, or give
      // up when already at the floor. Returns true when the retry loop must
      // stop (the caller breaks out).
      const halveOrGiveUp = (): boolean => {
        rollbackComponents();
        rejectCandidate();
        if (dt <= dtMin) {
          allConverged = false;
          nrFailedAtMin = true;
          return true;
        }
        dt = Math.max(dtMin, dt / 2);
        return false;
      };

      // One full BE step of size dt -> y1, components advanced once by dt.
      const c1 = candidate(state, dt, t + dt);
      if (!c1) {
        if (halveOrGiveUp()) break;
        continue;
      }
      const s1 = c1.s;
      advanceStatefulComponents(ctx, s1, dt);
      const components1 = statefulComponentState(ctx);
      rollbackComponents();

      // Two BE steps of dt/2 -> y2, components advanced twice by dt/2 (the
      // second half-step solves against the mid-step component state).
      const cMid = candidate(state, dt / 2, t + dt / 2);
      if (!cMid) {
        if (halveOrGiveUp()) break;
        continue;
      }
      const sMid = cMid.s;
      advanceStatefulComponents(ctx, sMid, dt / 2);

      const c2 = candidate(sMid, dt / 2, t + dt);
      if (!c2) {
        if (halveOrGiveUp()) break;
        continue;
      }
      const s2 = c2.s;
      advanceStatefulComponents(ctx, s2, dt / 2);
      const components2 = statefulComponentState(ctx);
      const res2 = { iterations: c2.iterations, residual: c2.residual };

      // Error estimate: weighted RMS over every DYNAMIC state — internal-node
      // P and T (or h for enthalpy-state fluids), solid T, the mass flow of
      // branches with fluid inertia (an ODE state, not an algebraic result),
      // and the components' own integrated state.
      let sumSq = 0;
      let nVars = 0;
      for (const id of ctx.internalIds) {
        const y2p = s2.nodeP.get(id)!;
        const diffP = y2p - s1.nodeP.get(id)!;
        const scaleP = absTolP + relTol * Math.abs(y2p);
        sumSq += (diffP / scaleP) ** 2;
        nVars++;

        if (ctx.fluidAssignment.node(id).capabilities.enthalpyState) {
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
      for (let j = 0; j < ctx.branches.length; j++) {
        if (!ctx.branches[j].inertia) continue;
        const y2m = s2.mdots[j];
        const diffM = y2m - s1.mdots[j];
        const scaleM = absTolMdot + relTol * Math.abs(y2m);
        sumSq += (diffM / scaleM) ** 2;
        nVars++;
      }
      for (let k = 0; k < components2.length; k++) {
        const diffC = components2[k] - components1[k];
        const scaleC = ABS_TOL_COMPONENT + relTol * Math.abs(components2[k]);
        sumSq += (diffC / scaleC) ** 2;
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
          // Error-estimate rejection: roll back the components and the
          // speculative stepStart writes, THEN fire stepRejected (its own
          // writes commit).
          rollbackComponents();
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
        ...run.runtimeFields(),
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

    // Branch-owned stateful dynamics (e.g. DynamicCheckValve poppet ODE)
    // were advanced along the accepted two-half-step trajectory inside the
    // candidate loop, so their state already belongs to `state` here.

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
        ...run.runtimeFields(),
      };
    }

    if (
      options?.onProgress &&
      (acceptedSteps % progressInterval === 0 || reachedEnd())
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
    if (reachedEnd() && allConverged) {
      logic.fire("converged", buildLogicScope(ctx, state), {
        t,
        dt: currentDt,
      });
    }
    logic.fire("solveEnd", buildLogicScope(ctx, state), { t, dt: currentDt });
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
    stats: stats(),
    ...run.runtimeFields(),
  };
}
