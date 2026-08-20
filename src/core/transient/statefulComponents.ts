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
