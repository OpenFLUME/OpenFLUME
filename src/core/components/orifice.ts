import type { BranchComponent } from "./branchComponent";
import type { Dual } from "../dual";
import { mul, div, abs, toDual } from "../dual";

/** Orifice: ΔP = mdot² / (2 ρ (Cd·A)²). */
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
}
