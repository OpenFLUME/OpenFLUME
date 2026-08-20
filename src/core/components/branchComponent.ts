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
