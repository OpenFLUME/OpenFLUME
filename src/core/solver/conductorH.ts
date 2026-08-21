/**
 * Convection-conductor coupling: the effective h map and the step-boundary
 * commits of the correlation/front shared states.
 *
 * The convection coefficient h of each conductor can come from a fixed
 * value or from a correlation evaluated at the current fluid/wall state.
 * `computeConductorHMap` refreshes those values between outer Picard
 * iterations (h is FROZEN inside each inner Newton solve).  The stateful
 * correlations (darrHartwig latch, ttWf wetted fraction, fluid-front
 * fraction) are advanced ONLY at accepted-step boundaries via
 * `updateConductorLatches` / `updateFluidFrontStates` — see the lifecycle
 * notes on SolverContext and docs/solver-convergence.md.
 */
import type { SolverContext, StepState } from "./types";
import {
  evaluateConvectionH,
  updateDarrHartwigLatches,
  updateTtWfStates,
} from "../correlations";
import type { TtWfStepSnapshot } from "../correlations";
import { advectFluidFrontUpwindBE } from "../fluidFront";
import { recordFluidFrontEvent } from "../diagnostics";

/** Build the minimal context expected by the correlation evaluator. */
function buildCorrelationCtx(
  ctx: SolverContext,
): import("../correlations").CorrelationCtx {
  return {
    fluid: ctx.fluid,
    fluidAssignment: ctx.fluidAssignment,
    isRealFluid: ctx.isRealFluid,
    branches: ctx.branches.map((b) => ({ id: b.id, from: b.from, to: b.to })),
    nBranch: ctx.nBranch,
    nodeMap: new Map(
      Array.from(ctx.nodeMap.entries()).map(([id, n]) => [
        id,
        { id: n.id, type: n.type },
      ]),
    ),
    closureParams: ctx.closureParams,
    // Shared BY REFERENCE: the latch must be the same mutable step-level
    // store across every h-map refresh of a step (frozen mid-step).
    darrHartwig:
      ctx.darrHartwig.axialPosition.size > 0 ? ctx.darrHartwig : undefined,
    // Same sharing for the ttWf accepted-step state.
    ttWf: ctx.ttWf.axialPosition.size > 0 ? ctx.ttWf : undefined,
    // Same sharing for the fluid-front accepted-step state (present only
    // when a ttWf conductor opts in via correlation.fluidFront).
    fluidFront: ctx.fluidFront,
    // Same sharing for the pre-compiled custom-correlation expressions.
    customExpressions:
      ctx.customExpressions.size > 0 ? ctx.customExpressions : undefined,
  };
}

/** Build the minimal state expected by the correlation evaluator. */
function buildCorrelationState(
  state: StepState,
): import("../correlations").CorrelationState {
  return {
    nodeP: state.nodeP,
    nodeT: state.nodeT,
    nodeH: state.nodeH,
    nodeQuality: state.nodeQuality,
    nodePhase: state.nodePhase,
    nodeMu: state.nodeMu,
    mdots: state.mdots,
    solidT: state.solidT,
  };
}

/**
 * Time-step-level update of the correlation accepted-step states:
 * the darrHartwig rewet-hysteresis latches (SPEC §7.4) and the ttWf
 * wetted-fraction/latch states (src/core/ttWf.ts).  Call ONLY at
 * step boundaries: once at t = 0 (memoryless initialization — omit `dt`)
 * and once per ACCEPTED step with the accepted step size `dt`.  Rejected
 * adaptive trial steps and all in-solve h-map refreshes must NOT call this —
 * a state flipping mid-Newton is the documented limit-cycle mechanism
 * (docs/solver-convergence.md).
 *
 * Returns the per-conductor TT-WF snapshots for TransientResult.ttWf
 * recording (undefined when no ttWf conductor is configured); the D-H latch
 * update has no result payload.
 */
export function updateConductorLatches(
  ctx: SolverContext,
  state: StepState,
  dt?: number,
): Map<string, TtWfStepSnapshot> | undefined {
  if (ctx.darrHartwig.axialPosition.size > 0) {
    updateDarrHartwigLatches(
      buildCorrelationCtx(ctx),
      ctx.conductors as import("../correlations").CorrelationConductor[],
      buildCorrelationState(state),
    );
  }
  if (ctx.ttWf.axialPosition.size === 0) return undefined;
  return updateTtWfStates(
    buildCorrelationCtx(ctx),
    ctx.conductors as import("../correlations").CorrelationConductor[],
    buildCorrelationState(state),
    dt,
  );
}

/**
 * Time-step-level update of the FLUID-FRONT transport state
 * (src/core/fluidFront.ts).  Call ONLY at step boundaries, together with
 * updateConductorLatches: once at t = 0 (omit `dt` — warm-filled init,
 * a = 0 everywhere; previous node masses seeded from the IC) and once per
 * ACCEPTED transient step with the accepted step size `dt` (one
 * conservative upwind/BE commit at the accepted state).  Rejected adaptive
 * trial steps, aborted runs, and all in-solve h-map refreshes must NOT call
 * this — the same frozen-state discipline as the correlation latches
 * (docs/solver-convergence.md).
 *
 * Returns the per-node accepted fractions for TransientResult.fluidFront
 * recording (undefined when the model is not enabled).
 */
export function updateFluidFrontStates(
  ctx: SolverContext,
  state: StepState,
  dt?: number,
  midState?: StepState,
): Map<string, number> | undefined {
  const ff = ctx.fluidFront;
  if (!ff) return undefined;

  const nodeMassOf = (st: StepState, id: string): number => {
    const rho = st.nodeRho.get(id) ?? 0;
    const V = ctx.nodeMap.get(id)?.volume ?? 0;
    return rho * V;
  };

  if (dt === undefined) {
    // t = 0: warm-filled line — no cryogenic inlet fluid has arrived yet.
    for (const id of ff.nodeIds) {
      ff.a.set(id, 0);
      ff.prevMass.set(id, nodeMassOf(state, id));
    }
    return new Map(ff.a);
  }

  // Accepted-step commit.  The commit follows the ACCEPTED trajectory so
  // that the converged nodal mass balance backing the [0,1]-boundedness
  // proof (docs/fluid-front-transport.md) holds on every sub-integration:
  //  - fixed stepping / plain accepted step: ONE backward-Euler upwind
  //    advection of size dt at the accepted end-of-step state;
  //  - adaptive step-doubling (midState = the accepted half-step state):
  //    TWO half commits (t → t+dt/2 at midState, t+dt/2 → t+dt at state) —
  //    the accepted trajectory is the pair of half steps, and a single
  //    full-dt commit would see the half-step mass-balance truncation
  //    mismatch as a spurious source.
  // A rejected evaluation (non-finite inputs — a solver bug, not physics)
  // keeps the previous accepted state and is counted (never silently
  // repaired).
  const branches = ctx.branches.map((b) => ({ from: b.from, to: b.to }));
  const commitOne = (endState: StepState, subDt: number): void => {
    const mass = new Map<string, number>();
    for (const id of ff.nodeIds) mass.set(id, nodeMassOf(endState, id));
    const res = advectFluidFrontUpwindBE({
      nodeIds: ff.nodeIds,
      branches,
      mdots: endState.mdots,
      mass,
      prevMass: ff.prevMass,
      aPrev: ff.a,
      boundary: ff.boundary,
      dt: subDt,
    });
    for (const id of ff.nodeIds) {
      ff.a.set(id, res.aNext.get(id)!);
      ff.prevMass.set(id, mass.get(id)!);
    }
    for (let k = 0; k < res.boundsClampCorrections; k++)
      recordFluidFrontEvent("boundsClampCount");
  };
  try {
    if (midState !== undefined) {
      commitOne(midState, dt / 2);
      commitOne(state, dt / 2);
    } else {
      commitOne(state, dt);
    }
    recordFluidFrontEvent("commitCount");
  } catch {
    recordFluidFrontEvent("invalidInputCount");
  }
  return new Map(ff.a);
}

/** Compute the effective h for every convection conductor from the current state.
 *  `t` is the solve time [s] exposed to custom-model h expressions (0 when
 *  omitted — steady solves and t = 0 recordings). */
export function computeConductorHMap(
  ctx: SolverContext,
  state: StepState,
  prevMap?: Map<string, number>,
  t?: number,
): Map<string, number> {
  const corrCtx = buildCorrelationCtx(ctx);
  const corrState = buildCorrelationState(state);
  const map = new Map<string, number>();
  for (const cond of ctx.conductors) {
    if (cond.type.kind !== "convection") continue;
    const prevH = prevMap?.get(cond.id);
    map.set(
      cond.id,
      evaluateConvectionH(
        cond as import("../correlations").CorrelationConductor,
        corrCtx,
        corrState,
        prevH,
        t,
      ),
    );
  }
  return map;
}
