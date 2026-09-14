/**
 * Branch-owned time-integrated state (BranchComponent.advanceState — e.g.
 * DynamicCheckValve's spring-mass poppet position) is advanced exactly ONCE
 * per ACCEPTED transient step, from the pressure/flow of the step just
 * solved — mirroring the controller-runtime discipline (executePid runs
 * against the accepted step state; outputs take effect on the NEXT step).
 * Never called during the Newton solve itself, so pressureDrop/
 * pressureDropDual stay pure at every trial iterate (see the purity note on
 * BranchComponent.advanceState).
 */
import type { SolverContext, StepState } from "../solver";

export function advanceStatefulComponents(
  ctx: SolverContext,
  state: StepState,
  dt: number,
): void {
  for (let j = 0; j < ctx.branches.length; j++) {
    const b = ctx.branches[j];
    if (!b.component.advanceState) continue;
    const pFrom = state.nodeP.get(b.from)!;
    const pTo = state.nodeP.get(b.to)!;
    b.component.advanceState(dt, state.mdots[j], pFrom, pTo);
  }
}

/** Opaque per-branch snapshots (undefined for stateless branches). */
export type StatefulComponentSnapshot = Array<unknown | undefined>;

/**
 * Snapshot every stateful component so a candidate trajectory can be rolled
 * back. Adaptive step doubling advances the components along BOTH candidate
 * paths (one full step, two half steps) and must return to the accepted
 * state's components before retrying or after rejecting.
 */
export function snapshotStatefulComponents(
  ctx: SolverContext,
): StatefulComponentSnapshot {
  return ctx.branches.map((b) =>
    b.component.advanceState ? b.component.snapshotState?.() : undefined,
  );
}

export function restoreStatefulComponents(
  ctx: SolverContext,
  snapshot: StatefulComponentSnapshot,
): void {
  ctx.branches.forEach((b, j) => {
    if (b.component.advanceState && snapshot[j] !== undefined)
      b.component.restoreState?.(snapshot[j]);
  });
}

/** Concatenated O(1) dynamic state of every stateful component, for the
 *  adaptive error norm. Stable length and order for a given context. */
export function statefulComponentState(ctx: SolverContext): number[] {
  const out: number[] = [];
  for (const b of ctx.branches) {
    const values = b.component.dynamicState?.();
    if (values) out.push(...values);
  }
  return out;
}
