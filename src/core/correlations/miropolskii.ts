import { RealFluid, clampToValidPH } from "../fluids/realFluid";
import {
  DEFAULT_CLOSURE_PARAMS,
  type ResolvedClosureParams,
} from "../closureParams";
import { FALLBACK_H_FLOOR } from "./types";
import { dittusBoelterH } from "./dittusBoelter";

/** Miropolskii film-boiling correlation (Cross, Majumdar et al., J. Spacecraft & Rockets 2002).
 *  Falls back to Dittus–Boelter when the node is single-phase.
 */
function miropolskiiH(
  G: number,
  D: number,
  fluid: RealFluid,
  P: number,
  hNode: number,
  flowArea: number,
  closure: ResolvedClosureParams = DEFAULT_CLOSURE_PARAMS,
): number {
  const [cP, cH] = clampToValidPH(fluid.fluidName, P, hNode);
  const ph = fluid.statePH(cP, cH);

  if (ph.phase !== "twoPhase" || ph.quality === undefined) {
    // Single-phase fallback: use the single-phase state directly
    const mu = ph.mu;
    const k = ph.k ?? 0;
    const cp = ph.cp ?? 0;
    if (!k || !cp || mu <= 0) return FALLBACK_H_FLOOR;
    return dittusBoelterH(G, D, mu, k, cp, closure.dittusBoelter);
  }

  const sat = fluid.saturationProperties(P);
  const x = Math.max(0.01, Math.min(0.99, ph.quality));

  const rhof = sat.rhof;
  const rhog = sat.rhog;
  const mug = sat.mug;
  const kg = sat.kg;
  const cpg = sat.cpg;

  if (mug <= 0 || kg <= 0 || cpg <= 0 || rhof <= 0 || rhog <= 0) {
    return FALLBACK_H_FLOOR;
  }

  const mp = closure.miropolskii;
  const Re_g = (G * D) / mug;
  const Pr_g = (cpg * mug) / kg;
  const Y =
    1 -
    mp.yCoefficient *
      Math.pow(rhof / rhog - 1, mp.yDensityExponent) *
      Math.pow(1 - x, mp.yQualityExponent);
  const Nu =
    mp.leadingCoefficient *
    Math.pow(Re_g * (x + (rhog / rhof) * (1 - x)), mp.reynoldsExponent) *
    Math.pow(Pr_g, mp.prandtlExponent) *
    Y;
  return (Nu * kg) / D;
}

export { miropolskiiH };

/** Convenience: compute Miropolskii h for a pipe branch (HeatedPipe boiling option). */
export function miropolskiiPipeH(
  mdot: number,
  diameter: number,
  fluid: RealFluid,
  P: number,
  hNode: number,
  closure: ResolvedClosureParams = DEFAULT_CLOSURE_PARAMS,
): number {
  const flowArea = (Math.PI / 4) * diameter * diameter;
  const G = Math.abs(mdot) / flowArea;
  return miropolskiiH(G, diameter, fluid, P, hNode, flowArea, closure);
}
