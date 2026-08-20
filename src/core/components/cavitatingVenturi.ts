import type { BranchComponent } from "./branchComponent";
import type { FluidModel } from "../fluids";
import { RealFluid } from "../fluids/realFluid";

/** Cavitating venturi for real fluids.
 *  Implements the classic cavitating-venturi closure with a smooth
 *  transition between the choked (cavitating) and non-cavitating branches.
 *
 *  Choked branch (P_down <= Pv):
 *    mdot = Cd * A * sqrt(2 * rho * (P_up - Pv))
 *  Non-cavitating branch (P_down > Pv):
 *    mdot = Cd * A * sqrt(2 * rho * (P_up - P_down))
 *
 *  The two expressions are identical at P_down = Pv, so the raw switch is
 *  already C0 continuous.  A tanh-based blend on the cavitation number
 *    cavNumber = (P_up - P_down) / (P_up - Pv)
 *  with sharpness = 100 (default) smooths the slope discontinuity:
 *    w = 0.5 * (1 + tanh(sharpness * (cavNumber - 1)))
 *  so w -> 1 (choked) when P_down << Pv and w -> 0 (non-choked) when
 *  P_down >> Pv.  At the exact switch point the blended value equals both
 *  branches exactly, and the derivative is finite and continuous.
 */
export class CavitatingVenturi implements BranchComponent {
  readonly area: number;
  readonly cd: number;
  readonly recoveryFactor: number;
  readonly elevationChange = 0;

  constructor(throatArea: number, cd: number, recoveryFactor = 0.0) {
    this.area = throatArea;
    this.cd = cd;
    this.recoveryFactor = recoveryFactor;
  }

  massFlow(pUp: number, pDown: number, Tup: number, fluid: FluidModel): number {
    if (pUp <= 0 || Tup <= 0) return 0;
    if (!(fluid instanceof RealFluid)) return 0;

    const Pv = (fluid as RealFluid).saturationPressure(Tup);
    const rho = fluid.density(pUp, Tup);
    const dp = pUp - pDown;
    const dpCav = pUp - Pv;

    // No forward flow
    if (dp <= 0) return 0;

    // If upstream is already at or below vapor pressure, no cavitation
    // possible; fall back to standard incompressible orifice formula.
    if (dpCav <= 0) {
      return this.cd * this.area * Math.sqrt(2 * rho * dp);
    }

    const mdotChoked = this.cd * this.area * Math.sqrt(2 * rho * dpCav);
    const mdotUnchoked = this.cd * this.area * Math.sqrt(2 * rho * dp);

    // With recoveryFactor = 0.0 the diffuser recovers no pressure, so the
    // throat pressure equals the downstream pressure and choking only occurs
    // when pDown < Pv (legacy/simple-orifice behaviour).
    // With recoveryFactor > 0.0 the diffuser recovers a fraction of the
    // available head, so the critical downstream pressure at which the throat
    // first reaches Pv is raised above Pv.  recoveryFactor = 1.0 means the
    // diffuser recovers the full available head and the flow is always choked
    // whenever pUp > Pv.
    const pCrit = this.recoveryFactor * pUp + (1 - this.recoveryFactor) * Pv;
    const cavNumber = (pCrit - pDown) / Math.max(dpCav, 1e-12);

    // Smooth blend based on cavitation number
    const sharpness = 100;
    const blend = 0.5 * (1 + Math.tanh(sharpness * cavNumber));
    return (1 - blend) * mdotUnchoked + blend * mdotChoked;
  }

  pressureDrop(_mdot: number, _rho: number, _mu?: number, _t?: number): number {
    return 0;
  }
}
