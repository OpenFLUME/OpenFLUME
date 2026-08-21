import type { BranchComponent } from "./branchComponent";

/** Regulator: holds downstream pressure at setPressure using a smooth min.
 * Residual form: P_down − softmin(P_set, P_up − ΔP_orifice(mdot, maxCdA)) = 0.
 * Softmin sharpness α = 100 (transition width ≈ 0.04 in pressure units).
 */
export class Regulator implements BranchComponent {
  readonly setPressure: number;
  readonly maxCdA: number;
  readonly area = 1;
  readonly elevationChange = 0;
  private readonly alpha: number;

  constructor(setPressure: number, maxCdA: number, alpha = 100) {
    this.setPressure = setPressure;
    this.maxCdA = maxCdA;
    this.alpha = alpha;
  }

  private softmin(a: number, b: number): number {
    const alpha = this.alpha;
    const m = Math.min(a, b);
    return (
      m -
      Math.log(Math.exp(-alpha * (a - m)) + Math.exp(-alpha * (b - m))) / alpha
    );
  }

  residual(mdot: number, rho: number, pUp: number, pDown: number): number {
    const dP_orifice =
      (mdot * Math.abs(mdot)) / (2 * rho * this.maxCdA * this.maxCdA);
    const targetP_down = this.softmin(this.setPressure, pUp - dP_orifice);
    return pDown - targetP_down;
  }

  pressureDrop(_mdot: number, _rho: number, _mu?: number, _t?: number): number {
    return 0;
  }
}
