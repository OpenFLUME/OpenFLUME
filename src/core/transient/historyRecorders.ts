/**
 * TT-WF / fluid-front accepted-step history accumulators.
 *
 * Both histories are appended to ONLY at t = 0 and after an accepted step —
 * the snapshots come from `updateConductorLatches` / `updateFluidFrontStates`
 * (the sole commit points), so a rejected adaptive trial or an aborted step
 * can never append (nor advance the underlying state).
 */
import type {
  TtWfConductorHistory,
  FluidFrontNodeHistory,
  CapillaryHistory,
} from "../schema";
import type { CapillaryNetwork } from "../capillary";
import type { TtWfStepSnapshot } from "../correlations";

export interface HistoryRecorders {
  recordTtWf(snap: Map<string, TtWfStepSnapshot> | undefined): void;
  recordFluidFront(snap: Map<string, number> | undefined): void;
  ttWfResultField(): Record<string, TtWfConductorHistory> | undefined;
  fluidFrontResultField(): Record<string, FluidFrontNodeHistory> | undefined;
  /** Append the capillary network's current state (one entry per recorded
   *  time, so the history stays aligned with TransientResult.times). */
  recordCapillary(network: CapillaryNetwork | undefined, t: number): void;
  /** Capillary history sliced to `[0, stepIndex]` (all when omitted). */
  capillaryResultField(stepIndex?: number): CapillaryHistory | undefined;
}

export function createHistoryRecorders(): HistoryRecorders {
  const ttWfResults: Record<string, TtWfConductorHistory> = {};
  const fluidFrontResults: Record<string, FluidFrontNodeHistory> = {};
  let capillary: CapillaryHistory | undefined;
  /** Time of each capillary record (to cut the event log for partials). */
  const capillaryTimes: number[] = [];

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
    recordCapillary(network, t) {
      if (!network) return;
      const snap = network.report();
      capillary ??= { branches: {}, nodes: {}, events: [] };
      for (const [id, b] of Object.entries(snap.branches)) {
        const h = (capillary.branches[id] ??= {
          fill: [],
          status: [],
          fillEnd: [],
        });
        h.fill.push(b.fill);
        h.status.push(b.status);
        h.fillEnd.push(b.fillEnd);
      }
      for (const [id, n] of Object.entries(snap.nodes)) {
        (capillary.nodes[id] ??= { wet: [] }).wet.push(n.wet);
      }
      capillary.events = snap.events;
      capillaryTimes.push(t);
    },
    capillaryResultField(stepIndex) {
      if (!capillary) return undefined;
      if (stepIndex === undefined) return capillary;
      const n = stepIndex + 1;
      const branches: CapillaryHistory["branches"] = {};
      for (const [id, b] of Object.entries(capillary.branches)) {
        branches[id] = {
          fill: b.fill.slice(0, n),
          status: b.status.slice(0, n),
          fillEnd: b.fillEnd.slice(0, n),
        };
      }
      const nodes: CapillaryHistory["nodes"] = {};
      for (const [id, v] of Object.entries(capillary.nodes)) {
        nodes[id] = { wet: v.wet.slice(0, n) };
      }
      const cutoff = capillaryTimes[Math.min(n, capillaryTimes.length) - 1];
      const events =
        cutoff === undefined
          ? []
          : capillary.events.filter((e) => !(e.time > cutoff));
      return { branches, nodes, events };
    },
    ttWfResultField: () =>
      Object.keys(ttWfResults).length > 0 ? ttWfResults : undefined,
    fluidFrontResultField: () =>
      Object.keys(fluidFrontResults).length > 0 ? fluidFrontResults : undefined,
  };
}
