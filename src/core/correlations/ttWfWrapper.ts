/**
 * TT-WF — proposed two-temperature / wetted-fraction chilldown closure
 * (../ttWf.ts is the pure local model).
 *
 * This module is the fluid-bound wrapper plus the ACCEPTED-STEP state
 * lifecycle — the exact analogue of the D-H latch discipline in
 * darrHartwigWrapper.ts:
 *  - ttWfHeatFlux / evaluateTtWfConductor (h-map refresh, inside solves):
 *    read the frozen accepted state and evaluate the flux/h_eff map with
 *    dt = 0 (the proposed state is discarded — nothing outlives the call);
 *  - updateTtWfStates: called ONLY at step boundaries (t = 0 memoryless
 *    init; once per ACCEPTED transient step with the accepted dt).  This is
 *    the ONLY place TtWfSharedState.state is mutated.  Rejected adaptive
 *    trial steps and aborted runs never reach it.
 */
import { RealFluid, clampToValidPH } from "../fluids/realFluid";
import { recordTtWfEvaluation } from "../diagnostics";
import { darrHartwigWetTemperature } from "../darrHartwig";
import {
  evaluateTtWf,
  initTtWfState,
  TTWF_INITIAL_STATE,
  type TtWfParams,
  type TtWfState,
  type TtWfWallContext,
  type TtWfOutcome,
} from "../ttWf";
import type {
  CorrelationConductor,
  CorrelationCtx,
  CorrelationState,
  TtWfRegimeLabel,
  TtWfSharedState,
  TtWfStepSnapshot,
} from "./types";
import { assembleDhSatBundle } from "./dhSatBundle";
import { massFluxAtNode, conductorFluid } from "./massFlux";

export interface TtWfHeatFluxArgs {
  P: number;
  hNode: number; // fluid-node specific enthalpy [J/kg]
  Tnode: number; // fluid-node bulk temperature [K] (conductor reference)
  Tw: number; // wall temperature [K]
  G: number; // kg/m²·s (≥ 0, magnitude — the local model has no direction)
  D: number; // m
  L: number; // m, distance from quench front (pre-floor; floor+count inside)
  inletLiquidReynolds?: number; // Re_l,in override (else local-G estimate)
  segmentLength: number; // m, Δz of the subcell segment
  wall: TtWfWallContext; // wall energy context (m′_wall, H_s)
  state: TtWfState; // ACCEPTED state — read-only
  params?: Partial<TtWfParams>; // per-conductor physical params (defaults else)
  /** s — accepted-step size for the state proposal.  Pass 0 for a flux-only
   *  evaluation (h-map refresh inside a solve: the proposal is discarded). */
  dt: number;
}

/** Assemble the property bundle and evaluate the TT-WF closure.  Never throws
 *  into the solver and never returns a non-finite flux/h: any property failure
 *  or invalid input comes back as ok:false (caller substitutes the fallback h
 *  floor and counts it). */
export function ttWfHeatFlux(
  fluid: RealFluid,
  args: TtWfHeatFluxArgs,
): TtWfOutcome {
  try {
    const bundle = assembleDhSatBundle(fluid, args.P);
    if (!bundle) return { ok: false, reason: "saturation property failure" };
    const { sat, vaporProps } = bundle;
    // Re_l,in: configured value (one global per pipe) or local-G estimate.
    const ReLin = args.inletLiquidReynolds ?? (args.G * args.D) / sat.muf;
    const outcome = evaluateTtWf({
      sat,
      vaporProps,
      Tw: args.Tw,
      Tnode: args.Tnode,
      hNode: args.hNode,
      G: args.G,
      D: args.D,
      L: args.L,
      ReLin,
      segmentLength: args.segmentLength,
      dt: args.dt,
      state: args.state,
      wall: args.wall,
      params: args.params,
    });
    if (
      outcome.ok &&
      (!isFinite(outcome.result.hEff) || !isFinite(outcome.result.qBar))
    ) {
      return { ok: false, reason: "non-finite flux/hEff" };
    }
    return outcome;
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Quench-front axial coordinate for the TT-WF L bookkeeping: the most
 *  downstream axial position whose ACCEPTED latch is rewetted (mirrors the
 *  D-H convention, SPEC §3.4).  −Infinity when nothing is latched yet.
 *  Reads the frozen accepted states — call BEFORE mutating any of them. */
export function ttWfQuenchFrontZ(shared: TtWfSharedState): number {
  let zQf = -Infinity;
  for (const [id, st] of shared.state) {
    if (!st.rewetLatched) continue;
    const zp = shared.axialPosition.get(id);
    if (zp !== undefined && zp > zQf) zQf = zp;
  }
  return zQf;
}

/** Assemble the per-conductor local state and evaluate the TT-WF closure.
 *  Shared by the h-map path (via evaluateConvectionH) and the commit path.
 *  L = z − z_qf uses the supplied (frozen) front coordinate. */
export function evaluateTtWfConductor(
  ctx: CorrelationCtx,
  cond: CorrelationConductor,
  state: CorrelationState,
  fluid: RealFluid,
  shared: TtWfSharedState,
  accepted: TtWfState,
  zQf: number,
  dt: number,
): TtWfOutcome {
  const corr = cond.type.correlation!;
  const fluidNodeId = ctx.nodeMap.has(cond.from) ? cond.from : cond.to;
  const wallNodeId = fluidNodeId === cond.from ? cond.to : cond.from;
  const Tw = state.solidT?.get(wallNodeId);
  const wall = shared.wall.get(cond.id);
  if (
    Tw === undefined ||
    wall === undefined ||
    corr.segmentLength === undefined
  ) {
    // validate.ts makes this unreachable (solid wall endpoint with thermal
    // mass + segmentLength are required); loud, never silently repaired.
    return {
      ok: false,
      reason: "missing wall temperature/context or segmentLength",
    };
  }
  const P = state.nodeP.get(fluidNodeId) ?? 1e5;
  const Tnode = state.nodeT.get(fluidNodeId) ?? 300;
  const hNodeRaw = state.nodeH?.get(fluidNodeId);
  const hNode =
    hNodeRaw !== undefined
      ? clampToValidPH(fluid.fluidName, P, hNodeRaw)[1]
      : fluid.enthalpyPT(P, Tnode);
  // ttWf is a named model: validate.ts requires a positive diameter, so the
  // (optionally-typed) field is always set here — the assertion is
  // compile-time only.
  const D = corr.diameter!;
  const flowArea = corr.flowArea ?? (Math.PI / 4) * D * D;
  const G = massFluxAtNode(fluidNodeId, ctx.branches, state.mdots) / flowArea;
  const z = corr.axialPosition ?? 0;
  const L = zQf > -Infinity ? z - zQf : z;
  return ttWfHeatFlux(fluid, {
    P,
    hNode,
    Tnode,
    Tw,
    G,
    D,
    L,
    inletLiquidReynolds: corr.inletLiquidReynolds,
    segmentLength: corr.segmentLength,
    wall,
    state: accepted,
    dt,
    params: {
      frontEnergyFactor: corr.frontEnergyFactor,
      rewetHysteresisOffsetK: corr.rewetHysteresisOffsetK,
    },
  });
}

/** Diagnostics-only snapshot from an evaluation outcome (regime label of the
 *  area-dominant side at the COMMITTED fWet). */
function ttWfSnapshotFrom(
  outcome: TtWfOutcome,
  committed: TtWfState,
  fallback: TtWfRegimeLabel,
): TtWfStepSnapshot {
  let regime = fallback;
  if (outcome.ok) {
    const r = outcome.result;
    regime = committed.fWet >= 0.5 ? r.wetRegime : r.dryRegime;
  }
  return { fWet: committed.fWet, rewetLatched: committed.rewetLatched, regime };
}

/**
 * THE TT-WF accepted-step state lifecycle (Phase-2 integration).
 *
 * Call ONLY at time-step boundaries:
 *  - dt === undefined: t = 0 memoryless initialization (Phase-1 contract):
 *    a wall at/below T_wet(G, P) starts wetted (f = 1, latched); a hotter
 *    wall starts UNWETTED (f = 0, unlatched) — never arbitrarily wet.
 *  - dt = accepted step size: evaluate the closure ONCE per conductor at the
 *    accepted local state and commit the proposed fWet/latch.  A failed
 *    evaluation keeps the previous state (robustness, as the D-H latch) and
 *    is counted via recordTtWfEvaluation (invalidInput).
 *
 * NEVER call from inside a solve: the state is frozen through all
 * Newton/Picard iterations and rejected adaptive trials.  L (quench-front
 * distance) uses the START-of-step accepted latches (frozen step-level
 * semantics, exactly the D-H latch bookkeeping).
 *
 * D-H validity clamps of the evaluation are NOT mapped here — they are
 * counted on the h-map path (evaluateConvectionH), which evaluates the same
 * accepted state at the end of the step.  TT-WF-specific counters
 * (fWetClamp/latch/limiter/invalidInput) are mapped HERE, once per accepted
 * step, so the counters track accepted-time events only.
 *
 * Returns one snapshot per ttWf conductor (for TransientResult.ttWf
 * recording), or undefined when no ttWf conductor is configured.
 */
export function updateTtWfStates(
  ctx: CorrelationCtx,
  conductors: CorrelationConductor[],
  state: CorrelationState,
  dt?: number,
): Map<string, TtWfStepSnapshot> | undefined {
  const shared = ctx.ttWf;
  if (!shared || !ctx.isRealFluid) return undefined;
  const snapshots = new Map<string, TtWfStepSnapshot>();
  // Front coordinate from the START-of-step accepted latches (frozen
  // step-level semantics) — computed before any commit mutates the map.
  const zQf = ttWfQuenchFrontZ(shared);
  for (const cond of conductors) {
    const corr = cond.type.correlation;
    if (cond.type.kind !== "convection" || !corr || corr.model !== "ttWf")
      continue;

    const fluidNodeId = ctx.nodeMap.has(cond.from) ? cond.from : cond.to;
    const cf = conductorFluid(ctx, fluidNodeId);
    if (!(cf instanceof RealFluid)) continue; // analytic node: no ttWf state
    const fluid = cf;

    if (dt === undefined) {
      // ── t = 0 memoryless initialization (no counters: not a step) ──
      let init = TTWF_INITIAL_STATE;
      const wallNodeId = fluidNodeId === cond.from ? cond.to : cond.from;
      const Tw = state.solidT?.get(wallNodeId);
      if (Tw !== undefined) {
        try {
          const P = state.nodeP.get(fluidNodeId) ?? 1e5;
          const D = corr.diameter;
          const flowArea = corr.flowArea ?? (Math.PI / 4) * D * D;
          const G =
            massFluxAtNode(fluidNodeId, ctx.branches, state.mdots) / flowArea;
          const sat = fluid.saturationProperties(P);
          const { Twet } = darrHartwigWetTemperature(
            G,
            D,
            sat.rhof,
            fluid.surfaceTension(P),
            fluid.criticalTemperature(),
          );
          init = initTtWfState(Tw, Twet);
        } catch {
          init = TTWF_INITIAL_STATE; // property failure at t=0: hot/dry default
        }
      }
      shared.state.set(cond.id, init);
      // Regime label from a counters-free dt = 0 evaluation (diagnostics only).
      const outcome = evaluateTtWfConductor(
        ctx,
        cond,
        state,
        fluid,
        shared,
        init,
        zQf,
        0,
      );
      const snap = ttWfSnapshotFrom(
        outcome,
        init,
        shared.lastSnapshot.get(cond.id)?.regime ?? "FB",
      );
      shared.lastSnapshot.set(cond.id, snap);
      snapshots.set(cond.id, snap);
      continue;
    }

    // ── accepted-step commit: exactly once per conductor per accepted step ──
    const prev = shared.state.get(cond.id) ?? TTWF_INITIAL_STATE;
    const outcome = evaluateTtWfConductor(
      ctx,
      cond,
      state,
      fluid,
      shared,
      prev,
      zQf,
      dt,
    );
    recordTtWfEvaluation(outcome); // TT-WF-specific counters (accepted-time events)
    const committed = outcome.ok ? outcome.result.proposedState : prev;
    if (outcome.ok) shared.state.set(cond.id, committed);
    const snap = ttWfSnapshotFrom(
      outcome,
      committed,
      shared.lastSnapshot.get(cond.id)?.regime ?? "FB",
    );
    shared.lastSnapshot.set(cond.id, snap);
    snapshots.set(cond.id, snap);
  }
  return snapshots;
}
