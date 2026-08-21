import type { BranchComponent } from "./branchComponent";
import {
  DEFAULT_CLOSURE_PARAMS,
  type SwameeJainClosureParams,
} from "../closureParams";
import type { Dual } from "../dual";
import { constant, add, mul, div, abs, toDual } from "../dual";
import { DEFAULT_GRAVITY } from "../schema";
import { darcyFrictionFactor, darcyFrictionFactorDual } from "./frictionFactor";

/** Standard-gravity magnitude [m/s²] — the schema default along −z. */
const STANDARD_GRAVITY = -DEFAULT_GRAVITY.z;

/** Darcy–Weisbach pipe with Churchill/Swamee–Jain friction factor.
 *
 *  Optionally tapered (diameterOut ≠ diameter): the friction term is then
 *  evaluated at the mean diameter/area, and the exposed `areaOut` lets the
 *  momentum-flux and kinetic-energy terms account for the quasi-1-D area
 *  change along the branch (converging/diverging duct segments). */
export class Pipe implements BranchComponent {
  readonly length: number;
  readonly diameter: number;
  readonly roughness: number;
  readonly elevationChange: number;
  readonly area: number;
  /** Outlet diameter for tapered pipes; undefined = constant diameter. */
  readonly diameterOut?: number;
  /** Outlet flow area (BranchComponent.areaOut); undefined = constant area. */
  readonly areaOut?: number;
  /** Swamee–Jain closure constants (default = published values). */
  readonly frictionParams: SwameeJainClosureParams;
  /** Fixed Darcy friction factor override (bypasses the Re-based
   *  correlation when defined; 0 = frictionless). */
  readonly fixedFrictionFactor?: number;

  constructor(
    length: number,
    diameter: number,
    roughness: number,
    elevationChange = 0,
    frictionParams?: SwameeJainClosureParams,
    fixedFrictionFactor?: number,
    diameterOut?: number,
  ) {
    this.length = length;
    this.diameter = diameter;
    this.roughness = roughness;
    this.elevationChange = elevationChange;
    this.area = (Math.PI / 4) * diameter * diameter;
    this.frictionParams = frictionParams ?? DEFAULT_CLOSURE_PARAMS.swameeJain;
    this.fixedFrictionFactor = fixedFrictionFactor;
    if (diameterOut !== undefined && diameterOut !== diameter) {
      this.diameterOut = diameterOut;
      this.areaOut = (Math.PI / 4) * diameterOut * diameterOut;
    }
  }

  /** Mean diameter for the friction term (= diameter when not tapered). */
  private get frictionDiameter(): number {
    return this.diameterOut === undefined
      ? this.diameter
      : 0.5 * (this.diameter + this.diameterOut);
  }

  /** Mean flow area for the friction term (= area when not tapered). */
  private get frictionArea(): number {
    if (this.diameterOut === undefined) return this.area;
    const d = this.frictionDiameter;
    return (Math.PI / 4) * d * d;
  }

  pressureDrop(mdot: number, rho: number, mu: number, _t?: number): number {
    const A = this.frictionArea;
    const D = this.frictionDiameter;
    const v = mdot / (rho * A);
    const Re = (rho * Math.abs(v) * D) / mu;

    const f =
      this.fixedFrictionFactor ??
      darcyFrictionFactor(Re, this.roughness / D, this.frictionParams);

    const dP_friction = (f * (this.length / D) * (rho * v * Math.abs(v))) / 2;
    const dP_elevation = rho * STANDARD_GRAVITY * this.elevationChange;
    return dP_friction + dP_elevation;
  }

  pressureDropDual(
    mdot: Dual,
    rho: number | Dual,
    mu: number | Dual,
    _t?: number,
  ): Dual {
    const A = this.frictionArea;
    const D = this.frictionDiameter;
    // Propagate rho/mu duals (real-fluid analytic Jacobian: density and
    // viscosity carry analytic partials w.r.t. the seeded unknown).  Passing
    // plain numbers reproduces the legacy mdot-only derivative.
    const rhoD = toDual(rho);
    const muD = toDual(mu);
    const v = div(mdot, mul(rhoD, A));
    const Re = div(mul(mul(rhoD, D), abs(v)), muD);

    const f =
      this.fixedFrictionFactor !== undefined
        ? constant(this.fixedFrictionFactor)
        : darcyFrictionFactorDual(Re, this.roughness / D, this.frictionParams);

    const dP_friction = mul(
      f,
      mul(
        constant(this.length / D),
        div(mul(rhoD, mul(v, abs(v))), constant(2)),
      ),
    );
    const dP_elevation = mul(rhoD, STANDARD_GRAVITY * this.elevationChange);
    return add(dP_friction, dP_elevation);
  }
}
