import type { BranchComponent } from "./branchComponent";
import type { Dual } from "../dual";
import { mul, div, abs, toDual } from "../dual";

/**
 * Dynamic (spring-mass) check valve: the poppet position is a genuine
 * mechanical degree of freedom advanced by a linear spring-mass-damper ODE,
 * not an algebraic function of the instantaneous flow direction (contrast
 * with CheckValve, which is a smooth-but-instantaneous direction switch).
 *
 *   m x'' + c x' + k x = (pFrom - pTo) * discArea - preload,   x in [0, stroke]
 *
 * `preload` is the spring's closing force at x = 0 (sets the cracking
 * pressure ≈ preload / discArea, the ΔP at which the net force first turns
 * positive). `position = x / stroke` in [0, 1] then drives the same
 * effective-CdA orifice relation as Valve/CheckValve, with a floor so the
 * Jacobian never singularizes fully shut.
 *
 * The ODE is integrated by `advanceState` — semi-implicit (symplectic)
 * Euler with an inelastic hard stop at x = 0 and x = stroke — ONCE PER
 * ACCEPTED transient step, using the pressure differential of the step just
 * solved (core/transient/statefulComponents.ts). It is never touched during
 * the Newton solve itself: pressureDrop/pressureDropDual must stay pure
 * functions of their arguments at every trial iterate and FD perturbation
 * (see the purity contract on UserDefinedComponent), so `position` is a
 * frozen constant for the whole step — exactly the discipline Valve uses
 * for `positionOverride`. This is a one-step-lagged (explicit) coupling
 * between the mechanical and fluid states, standard for lumped valve-
 * dynamics models; it can occasionally show one step of reverse-flow
 * leakage right before the valve slams shut, which is physically the
 * "water hammer" precursor real check valves exhibit, not a modeling bug.
 *
 * Steady-state solves (and the very first transient step) never call
 * advanceState, so `position` simply holds `initialPosition` for the whole
 * solve — a fixed-position valve, exactly like Valve with a constant
 * position. Model a transient to see opening lag, slam-shut and chatter.
 */
export class DynamicCheckValve implements BranchComponent {
  readonly area: number;
  readonly cd: number;
  readonly discArea: number;
  readonly mass: number;
  readonly springRate: number;
  readonly preload: number;
  readonly damping: number;
  readonly stroke: number;
  readonly elevationChange = 0;

  /** Poppet travel [m]: 0 = seated/closed, `stroke` = fully open. Mutable —
   *  advanceState() integrates it once per accepted transient step. */
  x: number;
  /** Poppet velocity [m/s]. Mutable, same lifecycle as `x`. */
  v: number;

  constructor(
    area: number,
    cd: number,
    mass: number,
    springRate: number,
    preload: number,
    damping: number,
    stroke: number,
    discArea?: number,
    initialPosition = 0,
  ) {
    this.area = area;
    this.cd = cd;
    this.discArea = discArea ?? area;
    this.mass = mass;
    this.springRate = springRate;
    this.preload = preload;
    this.damping = damping;
    this.stroke = stroke;
    this.x = Math.min(stroke, Math.max(0, initialPosition * stroke));
    this.v = 0;
  }

  /** Fractional opening in [0, 1], read by pressureDrop. */
  get position(): number {
    return this.stroke > 0 ? this.x / this.stroke : 0;
  }

  pressureDrop(mdot: number, rho: number, _mu?: number, _t?: number): number {
    const effArea = Math.max(this.cd * this.area * this.position, 1e-9);
    return (mdot * Math.abs(mdot)) / (2 * rho * effArea * effArea);
  }

  pressureDropDual(
    mdot: Dual,
    rho: number | Dual,
    _mu?: number | Dual,
    _t?: number,
  ): Dual {
    const effArea = Math.max(this.cd * this.area * this.position, 1e-9);
    return div(mul(mdot, abs(mdot)), mul(toDual(rho), 2 * effArea * effArea));
  }

  /**
   * Advance the poppet ODE by one ACCEPTED transient step of size `dt`,
   * using the pressure differential of the step just solved. `mdot` is
   * accepted for signature symmetry with other stateful-component models
   * (e.g. a future flow-force term) but this simple model is driven purely
   * by the static pressure force on the disc.
   */
  advanceState(dt: number, _mdot: number, pFrom: number, pTo: number): void {
    const dP = pFrom - pTo;
    const Fnet =
      dP * this.discArea -
      this.preload -
      this.springRate * this.x -
      this.damping * this.v;
    let vNew = this.v + (Fnet / this.mass) * dt;
    let xNew = this.x + vNew * dt;
    if (xNew <= 0) {
      xNew = 0;
      if (vNew < 0) vNew = 0;
    } else if (xNew >= this.stroke) {
      xNew = this.stroke;
      if (vNew > 0) vNew = 0;
    }
    this.x = xNew;
    this.v = vNew;
  }
}
