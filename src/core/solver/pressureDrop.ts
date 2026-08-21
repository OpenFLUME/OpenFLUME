/**
 * Branch pressure-drop wrappers shared by every residual evaluation.
 *
 * Both wrappers add two things on top of the component's own
 * `pressureDrop` closure:
 *   1. the hydrostatic elevation term ρ·g·Δz, and
 *   2. a zero-flow linearisation — below ZERO_FLOW_THRESHOLD the friction
 *      part of dP is replaced by a straight line through the origin, so
 *      d(dP)/dṁ stays finite and the Jacobian is well-conditioned at ṁ ≈ 0.
 *
 * `componentPressureDropDual` is the dual-number mirror used by the hybrid
 * (analytic) Jacobian; it must stay term-for-term identical to the scalar
 * form so both Jacobian paths agree.
 */
import { DEFAULT_GRAVITY } from "../schema";
import type { BranchComponent } from "../components";
import type { FluidModel } from "../fluids";
import type { Dual } from "../dual";
import { constant, add, sub, mul, div, abs } from "../dual";

const ZERO_FLOW_THRESHOLD = 1e-7;

/** Standard-gravity magnitude [m/s²] — the schema default along −y. */
const STANDARD_GRAVITY = -DEFAULT_GRAVITY.z;

export function componentPressureDrop(
  mdot: number,
  rho: number,
  mu: number,
  comp: BranchComponent,
  t?: number,
  T?: number,
  fluid?: FluidModel,
  pFrom?: number,
  pTo?: number,
): number {
  const absM = Math.abs(mdot);
  const elevDP =
    (comp.elevationChange ?? 0) === 0
      ? 0
      : rho * STANDARD_GRAVITY * (comp.elevationChange ?? 0);
  if (absM <= ZERO_FLOW_THRESHOLD) {
    const dpThTotal = comp.pressureDrop(
      ZERO_FLOW_THRESHOLD,
      rho,
      mu,
      t,
      T,
      fluid,
      pFrom,
      pTo,
    );
    const dpThFriction = dpThTotal - elevDP;
    return (dpThFriction / ZERO_FLOW_THRESHOLD) * mdot + elevDP;
  }
  return comp.pressureDrop(mdot, rho, mu, t, T, fluid, pFrom, pTo);
}

export function componentPressureDropDual(
  mdot: Dual,
  rho: number | Dual,
  mu: number | Dual,
  comp: BranchComponent,
  t?: number,
  T?: number,
  fluid?: FluidModel,
  pFrom?: number,
  pTo?: number,
): Dual {
  if (!comp.pressureDropDual)
    throw new Error(
      `Component ${comp.constructor.name} does not support dual evaluation`,
    );
  const absM = abs(mdot);
  const elevConst = STANDARD_GRAVITY * (comp.elevationChange ?? 0);
  const elevDP =
    elevConst === 0
      ? constant(0)
      : typeof rho === "number"
        ? constant(rho * elevConst)
        : mul(rho, elevConst);
  if (absM.v <= ZERO_FLOW_THRESHOLD) {
    const dpThTotal = comp.pressureDropDual(
      constant(ZERO_FLOW_THRESHOLD),
      rho,
      mu,
      t,
      T,
      fluid,
      pFrom,
      pTo,
    );
    const dpThFriction = sub(dpThTotal, elevDP);
    return add(
      mul(div(dpThFriction, constant(ZERO_FLOW_THRESHOLD)), mdot),
      elevDP,
    );
  }
  return comp.pressureDropDual(mdot, rho, mu, t, T, fluid, pFrom, pTo);
}
