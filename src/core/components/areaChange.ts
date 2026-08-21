import type { BranchComponent } from "./branchComponent";
import type { FluidModel } from "../fluids";
import type { Dual } from "../dual";
import { constant, add, sub, mul, div, abs, sqr, toDual } from "../dual";

/** Area change: sudden expansion or contraction.
 * Expansion (A_out > A_in): K = (1 − A_in/A_out)² on inlet velocity.
 * Contraction (A_out < A_in): K ≈ 0.5(1 − A_out/A_in)^0.75 on outlet velocity.
 * Direction-aware: reversed flow swaps inlet/outlet roles.
 * ΔP = K * ρ v_ref² / 2.
 */
export class AreaChange implements BranchComponent {
  readonly areaIn: number;
  readonly areaOut: number;
  readonly elevationChange = 0;

  constructor(areaIn: number, areaOut: number) {
    this.areaIn = areaIn;
    this.areaOut = areaOut;
  }

  get area(): number {
    return Math.max(this.areaIn, this.areaOut);
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
    let A_in: number;
    let A_out: number;
    if (mdot >= 0) {
      A_in = this.areaIn;
      A_out = this.areaOut;
    } else {
      A_in = this.areaOut;
      A_out = this.areaIn;
    }

    if (A_out === A_in) return 0;

    const v_in = mdot / (rho * A_in);
    const v_out = mdot / (rho * A_out);
    // Reversible Bernoulli pressure change: P_in − P_out = ρ/2·(v_out² − v_in²)
    const bernoulliDP = 0.5 * rho * (v_out * v_out - v_in * v_in);

    let lossDP: number;
    if (A_out > A_in) {
      // Sudden expansion: Borda–Carnot loss on inlet velocity
      const K = Math.pow(1 - A_in / A_out, 2);
      lossDP = (K * mdot * Math.abs(mdot)) / (2 * rho * A_in * A_in);
    } else {
      // Sudden contraction: loss on outlet velocity
      const K = 0.5 * Math.pow(1 - A_out / A_in, 0.75);
      lossDP = (K * mdot * Math.abs(mdot)) / (2 * rho * A_out * A_out);
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
    const A_in = mdot.v >= 0 ? this.areaIn : this.areaOut;
    const A_out = mdot.v >= 0 ? this.areaOut : this.areaIn;

    if (A_out === A_in) return constant(0);

    const rhoD = toDual(rho);
    const v_in = div(mdot, mul(rhoD, A_in));
    const v_out = div(mdot, mul(rhoD, A_out));
    const bernoulliDP = mul(mul(rhoD, 0.5), sub(sqr(v_out), sqr(v_in)));

    let lossDP: Dual;
    if (A_out > A_in) {
      const K = Math.pow(1 - A_in / A_out, 2);
      lossDP = div(
        mul(constant(K), mul(mdot, abs(mdot))),
        mul(rhoD, 2 * A_in * A_in),
      );
    } else {
      const K = 0.5 * Math.pow(1 - A_out / A_in, 0.75);
      lossDP = div(
        mul(constant(K), mul(mdot, abs(mdot))),
        mul(rhoD, 2 * A_out * A_out),
      );
    }

    return add(bernoulliDP, lossDP);
  }
}
