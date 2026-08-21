import { RealFluid, getFluidLimits } from "../fluids/realFluid";
import type { DHSatState, DHVaporProps } from "../darrHartwig";

/**
 * Shared property-bundle assembly for the D-H-based correlation wrappers
 * (darrHartwig and ttWf): the saturation state at local P plus the vapor PT
 * lookup clamped into the single-phase validity window.  Returns undefined on
 * a failed/invalid saturation evaluation (callers substitute the fallback h
 * floor and count it).  Throws only out of the CoolProp calls — both callers
 * wrap in try/catch.
 */
export function assembleDhSatBundle(
  fluid: RealFluid,
  P: number,
): { sat: DHSatState; vaporProps: (T: number) => DHVaporProps } | undefined {
  const sat0 = fluid.saturationProperties(P); // throws at/above Pc
  const hfg = sat0.hg - sat0.hf;
  if (
    !(hfg > 0) ||
    !(sat0.rhof > 0) ||
    !(sat0.rhog > 0) ||
    !(sat0.muf > 0) ||
    !(sat0.mug > 0) ||
    !(sat0.cpf > 0) ||
    !(sat0.cpg > 0) ||
    !(sat0.kf > 0) ||
    !(sat0.kg > 0)
  ) {
    return undefined;
  }
  const sigma = fluid.surfaceTension(P);
  const sat: DHSatState = {
    Tsat: sat0.Tsat,
    hf: sat0.hf,
    hfg,
    rhof: sat0.rhof,
    rhog: sat0.rhog,
    muf: sat0.muf,
    mug: sat0.mug,
    cpf: sat0.cpf,
    cpg: sat0.cpg,
    kf: sat0.kf,
    kg: sat0.kg,
    sigma,
    Tcr: fluid.criticalTemperature(),
    TvapMax: 0.95 * getFluidLimits(fluid.fluidName).Tmax,
  };
  // Vapor PT lookup, clamped into the single-phase validity window:
  // [T_sat + 0.25 K] keeps guardSinglePhase clear of the dome (property-call
  // guard only — in-envelope states never bind; continuity preserved since
  // vapor props at T_sat + 0.25 ≈ saturated vapor), [TvapMax] the package
  // ceiling.  T_v itself is separately clamped (counted) in the pure core.
  const T_LO = sat.Tsat + 0.25;
  const T_HI = Math.max(sat.TvapMax, T_LO);
  const vaporProps = (T: number): DHVaporProps =>
    fluid.transportPropsPT(P, Math.min(Math.max(T, T_LO), T_HI));
  return { sat, vaporProps };
}
