import type { BranchComponent } from "./branchComponent";
import {
  DEFAULT_CLOSURE_PARAMS,
  type SwameeJainClosureParams,
} from "../closureParams";
import type { Dual } from "../dual";
import { constant, add, mul, div, abs, toDual } from "../dual";
import { darcyFrictionFactor, darcyFrictionFactorDual } from "./frictionFactor";

/** Bend: K-factor from Idelchik/Crane-style correlation plus arc friction.
 * K90 lookup (smooth pipe approximations):
 *   r/D = 1   → K90 = 0.24
 *   r/D = 1.5 → K90 = 0.19
 *   r/D = 2   → K90 = 0.17
 *   r/D = 4   → K90 = 0.16
 * Interpolated/extrapolated for other r/D.
 * K_bend = K90 * (angle/90)^0.85.
 * K_arc  = f * (L_arc / D) where L_arc = π D (r/D) (angle/180).
 * ΔP = (K_bend + K_arc) * ρ v² / 2.
 */
export class Bend implements BranchComponent {
  readonly diameter: number;
  readonly angle: number;
  readonly rOverD: number;
  readonly roughness: number;
  readonly elevationChange = 0;
  /** Swamee–Jain closure constants for the arc-friction term (default = published). */
  readonly frictionParams: SwameeJainClosureParams;

  static readonly K90_TABLE: Array<[number, number]> = [
    [1, 0.24],
    [1.5, 0.19],
    [2, 0.17],
    [4, 0.16],
    [6, 0.16],
  ];

  constructor(
    diameter: number,
    angle: number,
    rOverD: number,
    roughness = 0,
    frictionParams?: SwameeJainClosureParams,
  ) {
    this.diameter = diameter;
    this.angle = angle;
    this.rOverD = rOverD;
    this.roughness = roughness;
    this.frictionParams = frictionParams ?? DEFAULT_CLOSURE_PARAMS.swameeJain;
  }

  get area(): number {
    return (Math.PI / 4) * this.diameter * this.diameter;
  }

  private getK90(): number {
    const table = Bend.K90_TABLE;
    if (this.rOverD <= table[0][0]) return table[0][1];
    if (this.rOverD >= table[table.length - 1][0])
      return table[table.length - 1][1];
    for (let i = 0; i < table.length - 1; i++) {
      if (this.rOverD >= table[i][0] && this.rOverD <= table[i + 1][0]) {
        const dx = table[i + 1][0] - table[i][0];
        const frac = dx === 0 ? 0 : (this.rOverD - table[i][0]) / dx;
        return table[i][1] + frac * (table[i + 1][1] - table[i][1]);
      }
    }
    return table[table.length - 1][1];
  }

  private frictionFactor(Re: number): number {
    return darcyFrictionFactor(
      Re,
      this.roughness / this.diameter,
      this.frictionParams,
    );
  }

  pressureDrop(mdot: number, rho: number, mu: number): number {
    const A = this.area;
    const v = mdot / (rho * A);
    const Re = (rho * Math.abs(v) * this.diameter) / mu;
    const f = this.frictionFactor(Re);

    const K90 = this.getK90();
    const K_bend = K90 * Math.pow(this.angle / 90, 0.85);
    const L_arc = Math.PI * this.diameter * this.rOverD * (this.angle / 180);
    const K_arc = f * (L_arc / this.diameter);
    const K_total = K_bend + K_arc;

    return (K_total * mdot * Math.abs(mdot)) / (2 * rho * A * A);
  }

  pressureDropDual(mdot: Dual, rho: number | Dual, mu: number | Dual): Dual {
    const A = this.area;
    const rhoD = toDual(rho);
    const muD = toDual(mu);
    const v = div(mdot, mul(rhoD, A));
    const Re = div(mul(mul(rhoD, this.diameter), abs(v)), muD);

    const f = darcyFrictionFactorDual(
      Re,
      this.roughness / this.diameter,
      this.frictionParams,
    );

    const K90 = this.getK90();
    const K_bend = constant(K90 * Math.pow(this.angle / 90, 0.85));
    const K_arc = mul(
      f,
      constant(
        (Math.PI * this.diameter * this.rOverD * (this.angle / 180)) /
          this.diameter,
      ),
    );
    const K_total = add(K_bend, K_arc);

    return div(mul(K_total, mul(mdot, abs(mdot))), mul(rhoD, 2 * A * A));
  }
}
