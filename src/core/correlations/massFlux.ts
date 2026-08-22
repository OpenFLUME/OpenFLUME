import type { FluidModel } from "../fluids";
import type { CorrelationCtx } from "./types";

/** Documented mass-flux convention:
 *  G = ṁ_node / flowArea, where ṁ_node = ½·Σ|mdot| over branches attached
 *  to that node.  At mass conservation the half-sum equals the node's total
 *  THROUGHFLOW: exact single-duct flow for series (2-branch) nodes, and the
 *  full flow through the junction volume at tees/manifolds (3+ branches).
 *  Note the manifold semantics deliberately: a correlation conductor at a
 *  manifold node sees the whole throughflow over ITS OWN flowArea — not any
 *  single attached pipe's mass flux, which is not well-defined at a node
 *  shared by unequal branches.  Attach the conductor to a dedicated
 *  series node when a specific pipe's G is intended.
 */
export function massFluxAtNode(
  nodeId: string,
  branches: Array<{ id: string; from: string; to: string }>,
  mdots: number[],
): number {
  let sumAbsMdot = 0;
  for (let j = 0; j < branches.length; j++) {
    const b = branches[j];
    if (b.from === nodeId || b.to === nodeId) {
      sumAbsMdot += Math.abs(mdots[j]);
    }
  }
  return sumAbsMdot * 0.5;
}

export function conductorFluid(
  ctx: CorrelationCtx,
  fluidNodeId: string,
): FluidModel {
  return ctx.fluidAssignment?.node(fluidNodeId) ?? ctx.fluid;
}
