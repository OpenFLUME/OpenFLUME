import type { BranchComponent } from "./branchComponent";

/** Compressible orifice for ideal gas with choking.
 * mdot = Cd·A·P_up·sqrt(γ/(R·T_up))·M(PR,γ)
 * where M is the standard isentropic mass-flux function.
 */
export class OrificeCompressible implements BranchComponent {
  readonly area: number;
  readonly cd: number;
  readonly elevationChange = 0;

  constructor(area: number, cd: number) {
    this.area = area;
    this.cd = cd;
  }

  massFlow(
    pUp: number,
    pDown: number,
    Tup: number,
    R: number,
    gamma: number,
  ): number {
    if (pUp <= 0 || Tup <= 0) return 0;
    const PR = pDown / pUp;
    if (PR >= 1) return 0;
    const CdA = this.cd * this.area;
    const base = (CdA * pUp) / Math.sqrt(R * Tup);
    const critPR = Math.pow(2 / (gamma + 1), gamma / (gamma - 1));

    if (PR <= critPR) {
      const chokedCoeff =
        Math.sqrt(gamma) *
        Math.pow(2 / (gamma + 1), (gamma + 1) / (2 * (gamma - 1)));
      return base * chokedCoeff;
    } else {
      const term =
        ((2 * gamma) / (gamma - 1)) *
        (Math.pow(PR, 2 / gamma) - Math.pow(PR, (gamma + 1) / gamma));
      if (term <= 0) return 0;
      return base * Math.sqrt(term);
    }
  }

  pressureDrop(_mdot: number, _rho: number, _mu?: number, _t?: number): number {
    return 0;
  }
}
