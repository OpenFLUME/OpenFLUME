import type { BranchComponent } from "./branchComponent";
import type { Dual } from "../dual";
import { constant, mul, div, abs, toDual } from "../dual";

/** Generic K-factor resistance: ΔP = K·mdot·|mdot| / (2 ρ A²). */
export class FlowResistance implements BranchComponent {
  readonly k: number;
  readonly area: number;
  readonly elevationChange = 0;

  constructor(k: number, area: number) {
    this.k = k;
    this.area = area;
  }

  pressureDrop(mdot: number, rho: number, _mu?: number, _t?: number): number {
    return (this.k * mdot * Math.abs(mdot)) / (2 * rho * this.area * this.area);
  }

  pressureDropDual(
    mdot: Dual,
    rho: number | Dual,
    _mu?: number | Dual,
    _t?: number,
  ): Dual {
    return div(
      mul(constant(this.k), mul(mdot, abs(mdot))),
      mul(toDual(rho), 2 * this.area * this.area),
    );
  }
}
