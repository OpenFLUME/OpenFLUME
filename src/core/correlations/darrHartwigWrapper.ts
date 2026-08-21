/**
 * Darr–Hartwig 2020 LH2 set — fluid-bound wrapper + step-level latch update.
 *
 * The pure algebra lives in ../darrHartwig.ts (every constant cited to the
 * spec); this section only assembles the property bundle from a RealFluid
 * and maps results onto the conductor framework.  See darrHartwig.ts's
 * module header for the h_eff-secant integration contract, the blends, and
 * the latch design.
 */
import { RealFluid } from "../fluids/realFluid";
import {
  evaluateDarrHartwig,
  darrHartwigWetTemperature,
  DH_HYSTERESIS,
  type DHResult,
} from "../darrHartwig";
import type {
  CorrelationConductor,
  CorrelationCtx,
  CorrelationState,
} from "./types";
import { assembleDhSatBundle } from "./dhSatBundle";
import { massFluxAtNode, conductorFluid } from "./massFlux";

export interface DarrHartwigHeatFluxArgs {
  P: number;
  hNode: number; // fluid-node specific enthalpy [J/kg] (x_e from enthalpy)
  Tnode: number; // fluid-node bulk temperature [K] (conductor reference)
  Tw: number; // wall temperature [K]
  G: number; // kg/m²·s
  D: number; // m
  L: number; // m, distance from quench front (pre-floor; floor+count inside)
  inletLiquidReynolds?: number; // Re_l,in override (else local-G estimate)
  latched: boolean; // frozen step-level rewet latch
}

export type DarrHartwigHeatFluxOutcome =
  { ok: true; result: DHResult } | { ok: false };

/** Assemble the property bundle and evaluate the Darr–Hartwig regime map.
 *  Returns ok:false on ANY property failure (caller substitutes the fallback
 *  h floor and counts it) — the correlation never throws into the solver and
 *  never returns a non-finite h. */
export function darrHartwigHeatFlux(
  fluid: RealFluid,
  args: DarrHartwigHeatFluxArgs,
): DarrHartwigHeatFluxOutcome {
  try {
    const bundle = assembleDhSatBundle(fluid, args.P);
    if (!bundle) return { ok: false };
    const { sat, vaporProps } = bundle;
    // Equilibrium quality from node enthalpy: x_e = (h − h_f)/h_fg ∈ ℝ.
    const xe = (args.hNode - sat.hf) / sat.hfg;
    // Re_l,in: configured value (one global per pipe) or local-G estimate.
    const ReLin = args.inletLiquidReynolds ?? (args.G * args.D) / sat.muf;
    const result = evaluateDarrHartwig({
      sat,
      vaporProps,
      Tw: args.Tw,
      Tnode: args.Tnode,
      G: args.G,
      xe,
      D: args.D,
      L: args.L,
      ReLin,
      latched: args.latched,
    });
    if (!isFinite(result.hEff) || !isFinite(result.qFlux)) return { ok: false };
    return { ok: true, result };
  } catch {
    return { ok: false };
  }
}

/**
 * Step-level rewet-hysteresis latch update for darrHartwig conductors
 * (SPEC §7.4 — solver stabilization, not in P1).  Call ONLY at time-step
 * boundaries: once at t = 0 (memoryless initialization from the ICs) and
 * once per ACCEPTED step.  Never call from inside a solve — the latch is
 * frozen while Newton runs so the regime map cannot flap mid-iteration.
 *
 * Semantics per conductor: T_w ≤ T_wet ⇒ latched (rewetted); a latched
 * conductor stays latched until T_w > T_wet + DH_HYSTERESIS (2 K).  While
 * latched, evaluation shifts the FB boundary to T_wet,eff = T_wet + 2 K.
 * Property failure keeps the previous latch (robustness).
 */
export function updateDarrHartwigLatches(
  ctx: CorrelationCtx,
  conductors: CorrelationConductor[],
  state: CorrelationState,
): void {
  const shared = ctx.darrHartwig;
  if (!shared || !ctx.isRealFluid) return;
  for (const cond of conductors) {
    const corr = cond.type.correlation;
    if (
      cond.type.kind !== "convection" ||
      !corr ||
      corr.model !== "darrHartwig"
    )
      continue;
    const fluidNodeId = ctx.nodeMap.has(cond.from) ? cond.from : cond.to;
    const cf = conductorFluid(ctx, fluidNodeId);
    if (!(cf instanceof RealFluid)) continue; // analytic node: no D-H latch
    const fluid = cf;
    const wallNodeId = fluidNodeId === cond.from ? cond.to : cond.from;
    const Tw = state.solidT?.get(wallNodeId);
    if (Tw === undefined) continue; // keep previous latch
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
      const entry = shared.latch.get(cond.id) ?? { rewetLatched: Tw <= Twet };
      if (Tw <= Twet) entry.rewetLatched = true;
      else if (Tw > Twet + DH_HYSTERESIS) entry.rewetLatched = false;
      shared.latch.set(cond.id, entry);
    } catch {
      // keep previous latch
    }
  }
}
