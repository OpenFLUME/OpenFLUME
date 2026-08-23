import type { BranchComponent } from "./branchComponent";
import type { Dual } from "../dual";
import { mul, div, abs, toDual } from "../dual";

/**
 * ISO/AGA-style expansibility (expansion) factor for a simple restriction
 * (β → 0, no pipe-area recovery):
 *
 *   Y(r, κ) = √[ (κ/(κ−1)) · (r^{2/κ} − r^{(κ+1)/κ}) / (1 − r) ]
 *
 * Y → 1 as r → 1 (recovers incompressible Bernoulli). `kappa` omitted or
 * not > 1 means the fluid has no isentropic exponent — Y = 1.
 */
export function expansibilityY(r: number, kappa?: number): number {
  if (kappa === undefined || !(kappa > 1) || !Number.isFinite(kappa)) return 1;
  if (!(r > 0) || r >= 1) return 1;
  const omr = 1 - r;
  if (omr < 1e-10) return 1;
  const term = Math.pow(r, 2 / kappa) - Math.pow(r, (kappa + 1) / kappa);
  if (!(term > 0)) return 0;
  return Math.sqrt(((kappa / (kappa - 1)) * term) / omr);
}

/** Critical (choking) pressure ratio r* = (2/(κ+1))^{κ/(κ−1)}. */
export function criticalPressureRatio(kappa: number): number {
  return Math.pow(2 / (kappa + 1), kappa / (kappa - 1));
}

/**
 * Isentropic exponent κ used by the orifice Y-factor.
 *
 *   - Ideal gas: the constant `gamma`.
 *   - Real fluid: κ = a² ρ / P  (since a² = (∂P/∂ρ)_s).
 *   - Liquid / no sound-speed model: undefined → Y = 1.
 *
 * Never throws: a failed CoolProp flash (two-phase dome, no a(P,T))
 * degrades to undefined rather than aborting the Newton iteration.
 */
export function orificeKappa(
  fluid: {
    gamma?: number;
    speedOfSound?(P: number, T: number): number;
  },
  P: number,
  T: number,
  rho: number,
): number | undefined {
  if (
    fluid.gamma !== undefined &&
    Number.isFinite(fluid.gamma) &&
    fluid.gamma > 1
  ) {
    return fluid.gamma;
  }
  if (fluid.speedOfSound === undefined || !(P > 0) || !(rho > 0))
    return undefined;
  try {
    const a = fluid.speedOfSound(P, T);
    if (!(a > 0) || !Number.isFinite(a)) return undefined;
    const kappa = (a * a * rho) / P;
    return Number.isFinite(kappa) && kappa > 1 ? kappa : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Orifice: one restriction, one mass-flow law
 *
 *   ṁ = C_d A Y(r, κ) √(2 ρ_up ΔP_eff)
 *
 * Y is the expansibility factor above. κ comes from the branch fluid
 * (`orificeKappa`): constant γ for ideal gas, a²ρ/P for a real fluid
 * with a sound-speed model, omitted (Y = 1) for incompressible liquids.
 *
 * When κ is available the solver uses this as an ṁ − ṁ_expected residual
 * (choking: r is clamped at r*). When it is not, the equivalent inverted
 * Bernoulli `pressureDrop` is used so the analytic dual Jacobian stays
 * exact for liquids.
 */
export class Orifice implements BranchComponent {
  readonly area: number;
  readonly cd: number;
  readonly elevationChange = 0;

  constructor(area: number, cd: number) {
    this.area = area;
    this.cd = cd;
  }

  pressureDrop(mdot: number, rho: number, _mu?: number, _t?: number): number {
    const denom = 2 * rho * Math.pow(this.cd * this.area, 2);
    return (mdot * Math.abs(mdot)) / denom;
  }

  pressureDropDual(
    mdot: Dual,
    rho: number | Dual,
    _mu?: number | Dual,
    _t?: number,
  ): Dual {
    const denom = mul(toDual(rho), 2 * Math.pow(this.cd * this.area, 2));
    return div(mul(mdot, abs(mdot)), denom);
  }

  /**
   * Universal orifice mass flow: ṁ = Cd·A·Y(r,κ)·√(2 ρ ΔP_eff).
   *
   * `kappa` omitted → Y = 1 (Bernoulli). When κ > 1 and the pressure
   * ratio is below r*, ΔP_eff uses the critical downstream pressure so
   * ṁ is independent of further back-pressure drop (choked).
   */
  massFlowFromState(
    pUp: number,
    pDown: number,
    rho: number,
    kappa?: number,
  ): number {
    if (!(pUp > 0) || !(rho > 0)) return 0;
    if (pDown >= pUp) return 0;
    let r = pDown / pUp;
    if (kappa !== undefined && Number.isFinite(kappa) && kappa > 1) {
      const rCrit = criticalPressureRatio(kappa);
      if (r < rCrit) r = rCrit;
    }
    const Y = expansibilityY(r, kappa);
    const dP = pUp * (1 - r);
    if (!(dP > 0) || !(Y > 0)) return 0;
    return this.cd * this.area * Y * Math.sqrt(2 * rho * dP);
  }

  /**
   * Ideal-gas convenience: ρ = P/(R T), κ = γ. Algebraically identical
   * to the classical isentropic/choked mass-flux function. Kept so RK4
   * references and unit tests can call one function without an EOS.
   */
  massFlow(
    pUp: number,
    pDown: number,
    Tup: number,
    R: number,
    gamma: number,
  ): number {
    if (!(pUp > 0) || !(Tup > 0) || !(R > 0)) return 0;
    return this.massFlowFromState(pUp, pDown, pUp / (R * Tup), gamma);
  }
}
