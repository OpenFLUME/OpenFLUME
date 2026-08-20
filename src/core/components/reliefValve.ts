import type { BranchComponent } from "./branchComponent";
import type { FluidModel } from "../fluids";
import { smoothstep } from "./frictionFactor";

/** Relief valve: closed below crackPressure, linear opening to fullOpenPressure,
 * plus smooth check-valve reverse blocking.
 * Effective CdA = Cd * A * smoothstep(crack, fullOpen, ΔP) with a floor for Jacobian. */
export class ReliefValve implements BranchComponent {
  readonly crackPressure: number;
  readonly fullOpenPressure: number;
  readonly area: number;
  readonly cd: number;
  readonly elevationChange = 0;

  constructor(
    crackPressure: number,
    fullOpenPressure: number,
    area: number,
    cd: number,
  ) {
    this.crackPressure = crackPressure;
    this.fullOpenPressure = fullOpenPressure;
    this.area = area;
    this.cd = cd;
  }

  pressureDrop(
    mdot: number,
    rho: number,
    _mu?: number,
    _t?: number,
    _T?: number,
    _fluid?: FluidModel,
    pFrom?: number,
    pTo?: number,
  ): number {
    const CdA_full = this.cd * this.area;

    let frac = 0;
    if (pFrom !== undefined && pTo !== undefined) {
      const dP = pFrom - pTo;
      frac = smoothstep(this.crackPressure, this.fullOpenPressure, dP);
    } else {
      // Fallback: use mdot sign as proxy (not called in normal solver path)
      frac = mdot >= 0 ? 1 : 0;
    }

    const CdAeff = Math.max(CdA_full * frac, 1e-12);

    // Check-valve reverse blocking
    const eps = 1e-3;
    const R0 = 1e11;
    const s = 0.5 * (1 + Math.tanh(mdot / eps));
    const R = R0 * (1 - s);

    return (mdot * Math.abs(mdot)) / (2 * rho * CdAeff * CdAeff) + R * mdot;
  }
}
