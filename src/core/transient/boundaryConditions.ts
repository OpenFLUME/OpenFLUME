/**
 * Time-varying boundary-node/ambient-solid updates applied at the START of
 * every transient step (before the nonlinear solve): pressure/temperature
 * schedules, then controller actuation overrides (which always win — see
 * core/controllerRuntime.ts).
 */
import type { NetworkConfig } from "../schema";
import type { SolverContext, StepState } from "../solver";
import { interpolateSchedule } from "../components";
import { RealFluid } from "../fluids/realFluid";

export function applyBoundaryConditions(
  ctx: SolverContext,
  config: NetworkConfig,
  state: StepState,
  t: number,
) {
  for (const node of config.nodes) {
    if (node.type === "boundary") {
      // Candidates are computed in LOCALS and committed together at the end:
      // a failed property evaluation must never leave the node in a mixed
      // state (new P/T with stale h/rho/mu/quality/phase).
      let P = state.nodeP.get(node.id)!;
      let T = state.nodeT.get(node.id)!;
      let updated = false;
      if (node.pressureSchedule && node.pressureSchedule.length > 0) {
        P = interpolateSchedule(node.pressureSchedule, t);
        updated = true;
      }
      if (node.temperatureSchedule && node.temperatureSchedule.length > 0) {
        T = interpolateSchedule(node.temperatureSchedule, t);
        updated = true;
      }
      // Controller actuation overrides (core/controllerRuntime.ts) are the
      // base schedules' superior: applied AFTER them so a written override
      // always wins.  Empty maps when no controller is configured — the
      // paths below are then bit-identical.
      const pOverride = ctx.boundaryPressureOverride.get(node.id);
      if (pOverride !== undefined) {
        P = pOverride;
        updated = true;
      }
      const tOverride = ctx.boundaryTemperatureOverride.get(node.id);
      if (tOverride !== undefined) {
        T = tOverride;
        updated = true;
      }
      if (updated) {
        const nodeFluid = ctx.fluidAssignment.node(node.id);
        if (nodeFluid instanceof RealFluid && state.nodeH) {
          // Real-fluid NODE (per-node dispatch — mixed-EOS networks carry
          // analytic boundaries too): use PH-path (statePH) so two-phase
          // boundary nodes receive HEM mixture density and McAdams viscosity
          // consistently with the solver's momentum residual path.  ATOMIC:
          // h and the flash results are fully evaluated before ANY map is
          // written; a failure throws with context and leaves the node's
          // previous (consistent) state untouched.
          const fluid = nodeFluid;
          let h: number;
          let ph: ReturnType<RealFluid["statePH"]>;
          try {
            h =
              node.quality !== undefined
                ? fluid.enthalpyPQ(P, node.quality)
                : fluid.enthalpyPT(P, T);
            ph = fluid.statePH(P, h);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(
              `applyBoundaryConditions: real-fluid update failed for boundary node "${node.id}" ` +
                `at t=${t} (P=${P}, T=${T}): ${msg}`,
            );
          }
          state.nodeP.set(node.id, P);
          state.nodeT.set(node.id, ph.T);
          state.nodeH.set(node.id, h);
          state.nodeRho.set(node.id, ph.rho);
          state.nodeMu.set(node.id, ph.mu);
          state.nodeQuality!.set(node.id, ph.quality);
          state.nodePhase!.set(node.id, ph.phase);
        } else {
          // Evaluate BEFORE committing so a throwing property call leaves
          // the node's maps untouched (error propagates as before).
          const rho = nodeFluid.density(P, T);
          const mu = nodeFluid.viscosity(P, T);
          state.nodeP.set(node.id, P);
          state.nodeT.set(node.id, T);
          state.nodeRho.set(node.id, rho);
          state.nodeMu.set(node.id, mu);
          // Mixed-EOS: keep the analytic boundary's h entry in lockstep.
          if (state.nodeH?.has(node.id)) {
            state.nodeH.set(node.id, nodeFluid.enthalpyPT(P, T));
          }
        }
      }
    }
  }
  for (const sNode of config.solidNodes ?? []) {
    if (
      sNode.type === "ambient" &&
      sNode.temperatureSchedule &&
      sNode.temperatureSchedule.length > 0
    ) {
      state.solidT.set(
        sNode.id,
        interpolateSchedule(sNode.temperatureSchedule, t),
      );
    }
  }
}
