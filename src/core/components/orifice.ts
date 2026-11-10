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

/** Zero-flow linearisation threshold [kg/s] for the orifice momentum row —
 *  the same value as solver/pressureDrop.ts ZERO_FLOW_THRESHOLD. */
const ORIFICE_ZERO_FLOW = 1e-7;

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
   * Momentum-row residual for the Y-factor closure, in pressure units:
   *
   *   R = [ sgn(P_from − P_to) · ṁ_exp² − q(ṁ) ] / (2 ρ_hi (C_d A)²)
   *     = sgn · Y² ΔP_eff − q(ṁ) / (2 ρ_hi (C_d A)²)
   *
   * with ṁ_exp = massFlowFromState(P_hi, P_lo, ρ_hi, κ) evaluated at the
   * pressure-upstream (high) node and q(ṁ) = ṁ|ṁ|, replaced by its secant
   * m₀·ṁ below m₀ = 1e-7 kg/s (the zero-flow linearisation every ΔP-form
   * row uses, solver/pressureDrop.ts).  Its root is ṁ = sgn · ṁ_exp, for
   * either flow direction.  The ṁ-form ṁ − sgn · ṁ_exp has the same root
   * but an unbounded slope ∂/∂P ∝ 1/√ΔP at ΔP → 0, on which Newton cycles
   * (ΔP → −ΔP) at a zero-flow (dead-end) orifice; in pressure units the
   * row is smooth in P through ΔP = 0, like the liquid Bernoulli row.
   */
  residualPa(
    mdot: number,
    pFrom: number,
    pTo: number,
    rhoHi: number,
    kappa?: number,
  ): number {
    const fromIsHigh = pFrom >= pTo;
    const pHi = fromIsHigh ? pFrom : pTo;
    const pLo = fromIsHigh ? pTo : pFrom;
    const mExp = this.massFlowFromState(pHi, pLo, rhoHi, kappa);
    const absM = Math.abs(mdot);
    const q = absM > ORIFICE_ZERO_FLOW ? mdot * absM : ORIFICE_ZERO_FLOW * mdot;
    const cdA = this.cd * this.area;
    const rho = rhoHi > 0 ? rhoHi : 1;
    return ((fromIsHigh ? 1 : -1) * mExp * mExp - q) / (2 * rho * cdA * cdA);
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
