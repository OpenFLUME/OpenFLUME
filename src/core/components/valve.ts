import type { BranchComponent } from "./branchComponent";
import { interpolateSchedule } from "./branchComponent";
import type { Dual } from "../dual";
import { mul, div, abs, toDual } from "../dual";

/** Valve: effective CdA scales with position; position=0 uses a floor area so Jacobian stays non-singular. */
export class Valve implements BranchComponent {
  readonly area: number;
  readonly cd: number;
  readonly position: number;
  readonly positionSchedule?: Array<[number, number]>;
  readonly elevationChange = 0;
  /**
   * Mutable actuation override (core/controllerRuntime.ts): when set it
   * WINS over the base `position` and any `positionSchedule`.  Mutable by
   * design — controllers write it between steps without rebuilding the
   * solver context.
   */
  positionOverride?: number;

  constructor(
    area: number,
    cd: number,
    position: number,
    schedule?: Array<[number, number]>,
  ) {
    this.area = area;
    this.cd = cd;
    this.position = position;
    this.positionSchedule = schedule;
  }

  getPosition(t?: number): number {
    if (this.positionOverride !== undefined) {
      return this.positionOverride;
    }
    if (
      t !== undefined &&
      this.positionSchedule &&
      this.positionSchedule.length > 0
    ) {
      return interpolateSchedule(this.positionSchedule, t);
    }
    return this.position;
  }

  pressureDrop(mdot: number, rho: number, _mu?: number, t?: number): number {
    const pos = this.getPosition(t);
    const effArea = Math.max(this.cd * this.area * pos, 1e-9);
    return (mdot * Math.abs(mdot)) / (2 * rho * effArea * effArea);
  }

  pressureDropDual(
    mdot: Dual,
    rho: number | Dual,
    _mu?: number | Dual,
    t?: number,
  ): Dual {
    const pos = this.getPosition(t);
    const effArea = Math.max(this.cd * this.area * pos, 1e-9);
    return div(mul(mdot, abs(mdot)), mul(toDual(rho), 2 * effArea * effArea));
  }
}
