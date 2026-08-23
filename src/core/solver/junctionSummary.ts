/**
 * Per-junction reporting summary (reacting junctions, core/schema.ts
 * JunctionConfig): the thermochemistry model re-evaluated once at a given
 * solved state. Reporting only — the coupling itself lives in the kernel's
 * closure rows (kernel.ts); nothing computed here feeds back into the solve.
 *
 * Shared by the steady packer (./steady.ts, one call at the converged state)
 * and the transient result recorder (../transient/resultRecorder.ts, one
 * call per accepted step) so both report identically — see
 * docs/combustion.md, "Transient reacting junctions".
 */
import type { JunctionSummary } from "../schema";
import type { SolverContext, StepState } from "./types";

export function computeJunctionSummaries(
  ctx: SolverContext,
  state: StepState,
): Record<string, JunctionSummary> | undefined {
  if (ctx.junctions.length === 0) return undefined;
  const result: Record<string, JunctionSummary> = {};
  for (const jn of ctx.junctions) {
    const mdotByRole: Record<string, number> = {};
    let mdotTotal = 0;
    const mdotMap = new Map<string, number>();
    for (const [role, idxs] of jn.roleBranches) {
      let sum = 0;
      for (const j of idxs) sum += Math.abs(state.mdots[j]);
      mdotByRole[role] = sum;
      mdotMap.set(role, sum);
      mdotTotal += sum;
    }
    const pc = state.nodeP.get(jn.nodeId)!;
    const evaluation = jn.model.evaluate(pc, mdotMap);
    const summary: JunctionSummary = {
      pc,
      productTemperature: state.nodeT.get(jn.nodeId)!,
      mdotByRole,
      mdotTotal,
      gas: evaluation.gas,
      clampedPc: evaluation.clampedPc,
      clampedOf: evaluation.clampedOf,
    };
    if (evaluation.of !== undefined) summary.of = evaluation.of;
    result[jn.id] = summary;
  }
  return result;
}
