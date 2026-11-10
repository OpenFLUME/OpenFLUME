import type { BranchComponent } from "./branchComponent";
import type { FluidModel } from "../fluids";
import type { Dual } from "../dual";
import { constant, add, mul, div, abs, toDual } from "../dual";

/** Area change: sudden expansion or contraction.
 * Expansion (A_out > A_in): K = (1 − A_in/A_out)² on inlet velocity.
 * Contraction (A_out < A_in): K ≈ 0.5(1 − A_out/A_in)^0.75 on outlet velocity.
 * Direction-aware: reversed flow swaps inlet/outlet roles, and the whole
 * ΔP (reversible + loss) changes sign with ṁ, so ΔP(−ṁ) on the declared
 * geometry equals −ΔP(ṁ) on the mirrored geometry.
 *
 *   ΔP = P_from − P_to = ṁ|ṁ|/(2ρ)·(1/A_out² − 1/A_in²) + K ṁ|ṁ|/(2ρ A_ref²)
 *
 * with A_in/A_out the PHYSICAL inlet/outlet for the current flow direction.
 *
 * The reversible (Bernoulli) term is part of this component, so it exposes
 * no BranchComponent `areaOut`: the settings.momentumFlux acceleration term
 * sees a constant-area branch (A = max(A_in, A_out)) and adds only the
 * density-change acceleration, never a second area-change term.  The true
 * end areas are given to the kinetic-energy terms through `endAreas`.
 */
export class AreaChange implements BranchComponent {
  readonly areaIn: number;
  /** Declared outlet (`to`-end) area.  Deliberately not named `areaOut`:
   *  BranchComponent.areaOut marks a taper for the momentum-flux term. */
  readonly outletArea: number;
  readonly endAreas: { from: number; to: number };
  readonly elevationChange = 0;

  constructor(areaIn: number, areaOut: number) {
    this.areaIn = areaIn;
    this.outletArea = areaOut;
    this.endAreas = { from: areaIn, to: areaOut };
  }

  get area(): number {
    return Math.max(this.areaIn, this.outletArea);
  }

  pressureDrop(
    mdot: number,
    rho: number,
    _mu?: number,
    _t?: number,
    _T?: number,
    _fluid?: FluidModel,
    _pFrom?: number,
    _pTo?: number,
  ): number {
    const A_in = mdot >= 0 ? this.areaIn : this.outletArea;
    const A_out = mdot >= 0 ? this.outletArea : this.areaIn;

    if (A_out === A_in) return 0;

    const mm = mdot * Math.abs(mdot);
    // Reversible Bernoulli change, signed with the flow:
    // P_in − P_out = ρ/2·(v_out² − v_in²), and P_from − P_to = ±(P_in − P_out).
    const bernoulliDP =
      (mm / (2 * rho)) * (1 / (A_out * A_out) - 1 / (A_in * A_in));

    let lossDP: number;
    if (A_out > A_in) {
      // Sudden expansion: Borda–Carnot loss on inlet velocity
      const K = Math.pow(1 - A_in / A_out, 2);
      lossDP = (K * mm) / (2 * rho * A_in * A_in);
    } else {
      // Sudden contraction: loss on outlet velocity
      const K = 0.5 * Math.pow(1 - A_out / A_in, 0.75);
      lossDP = (K * mm) / (2 * rho * A_out * A_out);
    }

    return bernoulliDP + lossDP;
  }

  pressureDropDual(
    mdot: Dual,
    rho: number | Dual,
    _mu?: number | Dual,
    _t?: number,
    _T?: number,
    _fluid?: FluidModel,
    _pFrom?: number,
    _pTo?: number,
  ): Dual {
    const A_in = mdot.v >= 0 ? this.areaIn : this.outletArea;
    const A_out = mdot.v >= 0 ? this.outletArea : this.areaIn;

    if (A_out === A_in) return constant(0);

    const rhoD = toDual(rho);
    const mm = mul(mdot, abs(mdot));
    const bernoulliDP = div(
      mul(mm, constant(1 / (A_out * A_out) - 1 / (A_in * A_in))),
      mul(rhoD, 2),
    );

    let lossDP: Dual;
    if (A_out > A_in) {
      const K = Math.pow(1 - A_in / A_out, 2);
      lossDP = div(mul(constant(K), mm), mul(rhoD, 2 * A_in * A_in));
    } else {
      const K = 0.5 * Math.pow(1 - A_out / A_in, 0.75);
      lossDP = div(mul(constant(K), mm), mul(rhoD, 2 * A_out * A_out));
    }

    return add(bernoulliDP, lossDP);
  }
}
