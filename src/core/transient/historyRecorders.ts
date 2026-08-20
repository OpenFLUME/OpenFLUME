/**
 * TT-WF / fluid-front accepted-step history accumulators.
 *
 * Both histories are appended to ONLY at t = 0 and after an accepted step —
 * the snapshots come from `updateConductorLatches` / `updateFluidFrontStates`
 * (the sole commit points), so a rejected adaptive trial or an aborted step
 * can never append (nor advance the underlying state).
 */
import type { TtWfConductorHistory, FluidFrontNodeHistory } from "../schema";
import type { TtWfStepSnapshot } from "../correlations";

export interface HistoryRecorders {
  recordTtWf(snap: Map<string, TtWfStepSnapshot> | undefined): void;
  recordFluidFront(snap: Map<string, number> | undefined): void;
  ttWfResultField(): Record<string, TtWfConductorHistory> | undefined;
  fluidFrontResultField(): Record<string, FluidFrontNodeHistory> | undefined;
}

export function createHistoryRecorders(): HistoryRecorders {
  const ttWfResults: Record<string, TtWfConductorHistory> = {};
  const fluidFrontResults: Record<string, FluidFrontNodeHistory> = {};

  return {
    recordTtWf(snap) {
      if (!snap) return;
      for (const [id, s] of snap) {
        const h = (ttWfResults[id] ??= {
          fWet: [],
          rewetLatched: [],
          regime: [],
        });
        h.fWet.push(s.fWet);
        h.rewetLatched.push(s.rewetLatched);
        h.regime.push(s.regime);
      }
    },
    recordFluidFront(snap) {
      if (!snap) return;
      for (const [id, a] of snap) {
        const h = (fluidFrontResults[id] ??= { fraction: [] });
        h.fraction.push(a);
      }
    },
    ttWfResultField: () =>
      Object.keys(ttWfResults).length > 0 ? ttWfResults : undefined,
    fluidFrontResultField: () =>
      Object.keys(fluidFrontResults).length > 0 ? fluidFrontResults : undefined,
  };
}
