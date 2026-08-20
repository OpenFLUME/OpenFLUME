import type { FluidModel } from "../fluids";
import type { CorrelationCtx } from "./types";

/** Documented mass-flux convention:
 *  G = ṁ_node / flowArea, where ṁ_node = ½·Σ|mdot| over branches attached to that node.
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
