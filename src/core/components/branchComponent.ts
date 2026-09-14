import type { FluidModel } from "../fluids";
import type { Dual } from "../dual";

export interface BranchComponent {
  pressureDrop(
    mdot: number,
    rho: number,
    mu: number,
    t?: number,
    T?: number,
    fluid?: FluidModel,
    pFrom?: number,
    pTo?: number,
  ): number;
  /** Optional dual-number pressure-drop for exact Jacobian derivatives.
   *  `rho` and `mu` may be Dual when the derivative is taken w.r.t. pressure
   *  (e.g. density in an elevation-change branch). */
  pressureDropDual?(
    mdot: Dual,
    rho: number | Dual,
    mu: number | Dual,
    t?: number,
    T?: number,
    fluid?: FluidModel,
    pFrom?: number,
    pTo?: number,
  ): Dual;
  area?: number;
  /** Outlet flow area for tapered components (quasi-1-D area change along
   *  the branch, e.g. Pipe with diameterOut).  Undefined = constant area.
   *  Read by the momentum-flux and kinetic-energy terms so acceleration
   *  from area change is captured endpoint-consistently. */
  areaOut?: number;
  elevationChange?: number;
  getBranchHeat?(
    mdot: number,
    Tup: number,
    cp: number,
    fluid?: FluidModel,
    P?: number,
    h?: number,
  ): number;
  /**
   * Optional: advance branch-owned time-integrated state (e.g. a
   * spring-mass valve-position ODE — see DynamicCheckValve) by one
   * ACCEPTED transient step of size `dt`, using the mdot/pFrom/pTo of the
   * step just solved.  Called exactly once per accepted step, from
   * core/transient/statefulComponents.ts — NEVER during the Newton solve,
   * so pressureDrop/pressureDropDual stay pure functions of their
   * arguments for every trial iterate and FD perturbation (see the purity
   * contract on UserDefinedComponent, components/userDefinedComponent.ts).
   * Steady solves and the very first transient step never call this: a
   * stateful component's constructor must set a physically sane initial
   * state.
   */
  advanceState?(dt: number, mdot: number, pFrom: number, pTo: number): void;
  /**
   * Snapshot / restore of the time-integrated state, so a driver can
   * advance the component along a CANDIDATE trajectory and roll back when
   * the candidate is rejected (adaptive step doubling does exactly this).
   * Required together with `advanceState`; the snapshot is opaque to the
   * caller and must be a value copy, never an alias into the component.
   */
  snapshotState?(): unknown;
  restoreState?(snapshot: unknown): void;
  /**
   * The time-integrated state as O(1) dimensionless numbers (e.g. a valve's
   * fractional opening), same length and order on every call, for the
   * adaptive error norm. A component whose dynamics can drive the step size
   * — a poppet that slams shut inside a step — must expose them here, or
   * the error controller cannot see the motion it is failing to resolve.
   */
  dynamicState?(): number[];
}

export function interpolateSchedule(
  schedule: Array<[number, number]>,
  t: number,
): number {
  if (schedule.length === 0) return 0;
  if (t <= schedule[0][0]) return schedule[0][1];
  if (t >= schedule[schedule.length - 1][0])
    return schedule[schedule.length - 1][1];
  for (let i = 0; i < schedule.length - 1; i++) {
    if (t >= schedule[i][0] && t <= schedule[i + 1][0]) {
      const dt = schedule[i + 1][0] - schedule[i][0];
      if (dt === 0) return schedule[i][1];
      const frac = (t - schedule[i][0]) / dt;
      return schedule[i][1] + frac * (schedule[i + 1][1] - schedule[i][1]);
    }
  }
  return schedule[schedule.length - 1][1];
}
