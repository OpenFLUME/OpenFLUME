import type { BranchComponent } from "./branchComponent";
import type { Dual } from "../dual";
import { constant, add, sub, mul, div, abs, tanh, toDual } from "../dual";

/** Check valve: orifice-like forward; reverse flow blocked via a smooth huge linear resistance. */
export class CheckValve implements BranchComponent {
  readonly area: number;
  readonly cd: number;
  readonly elevationChange = 0;

  constructor(area: number, cd: number) {
    this.area = area;
    this.cd = cd;
  }

  pressureDrop(mdot: number, rho: number, _mu?: number, _t?: number): number {
    const CdA = this.cd * this.area;
    const C = 1 / (2 * rho * CdA * CdA);
    const eps = 1e-3;
    const R0 = 1e11;
    const s = 0.5 * (1 + Math.tanh(mdot / eps));
    const R = R0 * (1 - s);
    return C * mdot * Math.abs(mdot) + R * mdot;
  }

  pressureDropDual(
    mdot: Dual,
    rho: number | Dual,
    _mu?: number | Dual,
    _t?: number,
  ): Dual {
    const CdA = this.cd * this.area;
    const C = div(constant(1), mul(toDual(rho), 2 * CdA * CdA));
    const eps = 1e-3;
    const R0 = 1e11;
    const s = tanh(div(mdot, eps));
    const sScaled = mul(constant(0.5), add(constant(1), s));
    const R = mul(R0, sub(constant(1), sScaled));
    return add(mul(C, mul(mdot, abs(mdot))), mul(R, mdot));
  }
}
