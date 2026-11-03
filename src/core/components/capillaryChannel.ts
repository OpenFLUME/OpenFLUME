import type { BranchComponent } from "./branchComponent";
import {
  DEFAULT_CLOSURE_PARAMS,
  type SwameeJainClosureParams,
} from "../closureParams";
import type { Dual } from "../dual";
import { add, sub, mul, div, toDual } from "../dual";
import { DEFAULT_GRAVITY, type CapillaryChannelStatus } from "../schema";
import {
  rectFrictionDrop,
  rectFrictionDropDual,
  rectLaminarResistance,
  rectSection,
  type RectSection,
} from "./rectChannel";

/** Standard-gravity magnitude [m/s²] — the schema default along −z. */
export const CAPILLARY_GRAVITY = -DEFAULT_GRAVITY.z;

/** Default liquid–air surface tension [N/m] (water, ~22 °C). */
export const DEFAULT_SURFACE_TENSION = 0.072;
/** Default gas (air) dynamic viscosity [Pa·s] at ~20 °C. */
export const DEFAULT_GAS_VISCOSITY = 1.81e-5;
/** Default sidewall expansion angle [deg] of a stop (burst) valve: an
 *  abrupt widening. */
export const DEFAULT_STOP_VALVE_EXPANSION = 90;
/**
 * A pinned or trapped channel is modelled as closed: its resistance is this
 * multiple of the channel's own full-liquid laminar resistance.  The
 * resulting leak is ~1e-6 of the open-channel flow at the same ΔP, and it
 * never moves a meniscus (pinned fronts are not advanced).
 */
export const CLOSED_RESISTANCE_FACTOR = 1e6;

/**
 * Fill states (schema CapillaryChannelStatus):
 *  - dry          gas only (no liquid has reached either end)
 *  - filling      a meniscus is inside the channel (or at one of its ends)
 *                 and moves with the flow
 *  - full         liquid end to end; both end nodes wet
 *  - pinnedInlet  meniscus held at the wet entrance (hydrophobic entrance,
 *                 or a front that receded all the way back)
 *  - pinnedOutlet meniscus held at the exit by a stop (burst) valve
 *  - trapped      a gas plug is enclosed by liquid at both ends; the
 *                 channel is blocked (gas is incompressible in this model)
 */
export type { CapillaryChannelStatus };

/** Which end liquid entered from: +1 = `from`, −1 = `to`, 0 = none yet. */
export type FillSide = 1 | -1 | 0;

export interface CapillaryChannelOptions {
  width: number;
  height: number;
  length: number;
  elevationChange?: number;
  /** Advancing contact angle [deg] on every wall unless overridden below. */
  contactAngle: number;
  contactAngleTop?: number;
  contactAngleBottom?: number;
  /** Both sidewalls (the walls `width` apart). */
  contactAngleSides?: number;
  surfaceTension?: number;
  /** Override of the geometric capillary pressure [Pa] (e.g. a pillar-array
   *  capillary pump, paper or another non-rectangular wick). */
  capillaryPressure?: number;
  gasViscosity?: number;
  initialFill?: number;
  initialFillFrom?: "from" | "to";
  stopValve?: {
    end?: "from" | "to";
    expansionAngle?: number;
    burstPressure?: number;
  };
  frictionParams?: SwameeJainClosureParams;
}

const deg = (a: number) => (a * Math.PI) / 180;

/**
 * Young–Laplace capillary pressure [Pa] of a meniscus in a rectangular
 * channel (positive = the meniscus pulls liquid INTO the dry part):
 *
 *   P_cap = γ [ (cos θ_top + cos θ_bottom) / h + 2 cos θ_sides / w ].
 */
export function rectCapillaryPressure(
  width: number,
  height: number,
  surfaceTension: number,
  thetaTop: number,
  thetaBottom: number,
  thetaSides: number,
): number {
  return (
    surfaceTension *
    ((Math.cos(deg(thetaTop)) + Math.cos(deg(thetaBottom))) / height +
      (2 * Math.cos(deg(thetaSides))) / width)
  );
}

/**
 * Burst pressure [Pa] of a capillary stop valve: the channel's sidewalls
 * open out at `expansionAngle` β (90° = abrupt) into a wider chamber while
 * the top and bottom walls continue, the planar-chip geometry of
 * Cho, Kim, Kang & Kim, J. Colloid Interface Sci. 306 (2007) 379:
 *
 *   ΔP_burst = −γ [ (cos θ_top + cos θ_bottom)/h + 2 cos(θ_x) / w ],
 *   θ_x = min(θ_sides + β, 180°).
 *
 * A value ≤ 0 means the expansion does not stop the front.
 */
export function rectBurstPressure(
  width: number,
  height: number,
  surfaceTension: number,
  thetaTop: number,
  thetaBottom: number,
  thetaSides: number,
  expansionAngle: number,
): number {
  const thetaStar = Math.min(thetaSides + expansionAngle, 180);
  return -rectCapillaryPressure(
    width,
    height,
    surfaceTension,
    thetaTop,
    thetaBottom,
    thetaStar,
  );
}

/**
 * Rectangular microchannel that can be partly filled with liquid, the rest
 * being gas — the building block of capillary-driven ("capillaric")
 * circuits: capillary filling, capillary pumps, stop/burst valves, trigger
 * valves and air-trap detection.
 *
 * The network fluid (incompressible) is the liquid.  Gas is treated as
 * incompressible and vented through dry nodes, so a single volumetric flow
 * Q = ṁ/ρ_liquid runs through every branch, liquid and gas alike: wherever
 * liquid advances, the same volume of gas is pushed ahead of it.  With a
 * meniscus at distance s from the wet end, the branch momentum balance is
 * (from → to)
 *
 *   P_from − P_to = R_liq(s) Q + R_gas(L − s) Q − side · P_cap + ρ g Δz s/L,
 *
 * where `side` = +1 when liquid entered from `from`, −1 from `to`.  R are
 * exact rectangular-duct resistances (liquid with the network viscosity,
 * including the turbulent blend; gas laminar with `gasViscosity`).
 *
 * The fill state (s, side, status) is NOT changed during a Newton solve:
 * the channel's pressure drop is a pure, linear-in-ṁ function of frozen
 * state.  CapillaryNetwork (core/capillary.ts) owns the time integration
 * and every topological event — fronts starting at newly wetted nodes,
 * stop-valve pinning and bursting, trigger-valve release and gas trapping —
 * once per accepted transient step.  Steady solves use the initial state
 * (a quasi-steady snapshot).
 */
export class CapillaryChannel implements BranchComponent {
  readonly width: number;
  readonly height: number;
  readonly length: number;
  readonly elevationChange: number;
  readonly area: number;
  readonly hydraulicDiameter: number;
  readonly defaultInitialMdot = 1e-9;
  /** Laminar law is linear (finite slope, intercept from capillarity or
   *  hydrostatics): evaluate exactly at microfluidic flows. */
  readonly exactNearZeroFlow = true;
  readonly surfaceTension: number;
  readonly gasViscosity: number;
  /** Capillary pressure [Pa] of a moving meniscus (positive = wicking). */
  readonly capillaryPressure: number;
  /** Stop valve, resolved: the node end it sits at and its burst pressure
   *  (> 0; a non-positive geometric value disables the valve). */
  readonly stopValve?: { end: "from" | "to"; burstPressure: number };
  readonly initialFill: number;
  readonly initialFillFrom: "from" | "to";
  private readonly section: RectSection;
  private readonly frictionParams: SwameeJainClosureParams;
  /** Gas resistance per unit length [Pa·s/m⁴]. */
  private readonly gasResistancePerLength: number;

  /** Liquid length [m], measured from the end liquid entered by. */
  fill = 0;
  side: FillSide = 0;
  status: CapillaryChannelStatus = "dry";

  constructor(o: CapillaryChannelOptions) {
    this.width = o.width;
    this.height = o.height;
    this.length = o.length;
    this.elevationChange = o.elevationChange ?? 0;
    this.section = rectSection(o.width, o.height);
    this.area = this.section.area;
    this.hydraulicDiameter = this.section.hydraulicDiameter;
    this.frictionParams = o.frictionParams ?? DEFAULT_CLOSURE_PARAMS.swameeJain;
    this.surfaceTension = o.surfaceTension ?? DEFAULT_SURFACE_TENSION;
    this.gasViscosity = o.gasViscosity ?? DEFAULT_GAS_VISCOSITY;
    const tTop = o.contactAngleTop ?? o.contactAngle;
    const tBottom = o.contactAngleBottom ?? o.contactAngle;
    const tSides = o.contactAngleSides ?? o.contactAngle;
    this.capillaryPressure =
      o.capillaryPressure ??
      rectCapillaryPressure(
        o.width,
        o.height,
        this.surfaceTension,
        tTop,
        tBottom,
        tSides,
      );
    if (o.stopValve) {
      const burst =
        o.stopValve.burstPressure ??
        rectBurstPressure(
          o.width,
          o.height,
          this.surfaceTension,
          tTop,
          tBottom,
          tSides,
          o.stopValve.expansionAngle ?? DEFAULT_STOP_VALVE_EXPANSION,
        );
      if (burst > 0) {
        this.stopValve = { end: o.stopValve.end ?? "to", burstPressure: burst };
      }
    }
    this.gasResistancePerLength = rectLaminarResistance(
      o.width,
      o.height,
      1,
      this.gasViscosity,
    );
    this.initialFill = o.initialFill ?? 0;
    this.initialFillFrom = o.initialFillFrom ?? "from";
  }

  /** Liquid volume fraction in [0, 1]. */
  get fillFraction(): number {
    return this.length > 0 ? this.fill / this.length : 0;
  }

  /** True while the channel is blocked (pinned meniscus or trapped gas). */
  get closed(): boolean {
    return (
      this.status === "pinnedInlet" ||
      this.status === "pinnedOutlet" ||
      this.status === "trapped"
    );
  }

  /** Burst pressure at node end `end`, or undefined when no valve is there. */
  burstPressureAt(end: "from" | "to"): number | undefined {
    return this.stopValve?.end === end
      ? this.stopValve.burstPressure
      : undefined;
  }

  /** Full-liquid laminar resistance [Pa·s/m³] at liquid viscosity μ. */
  liquidResistance(mu: number): number {
    return rectLaminarResistance(this.width, this.height, this.length, mu);
  }

  /** Full-gas laminar resistance [Pa·s/m³]. */
  gasResistance(): number {
    return this.gasResistancePerLength * this.length;
  }

  private closedResistance(mu: number): number {
    return CLOSED_RESISTANCE_FACTOR * this.liquidResistance(mu);
  }

  pressureDrop(mdot: number, rho: number, mu: number): number {
    const Q = mdot / rho;
    const g = rho * CAPILLARY_GRAVITY * this.elevationChange;
    switch (this.status) {
      case "pinnedInlet":
      case "pinnedOutlet":
      case "trapped":
        return this.closedResistance(mu) * Q;
      case "dry":
        return this.gasResistancePerLength * this.length * Q;
      case "full":
        return (
          rectFrictionDrop(
            this.section,
            this.length,
            0,
            this.frictionParams,
            mdot,
            rho,
            mu,
          ) + g
        );
      case "filling": {
        const s = this.fill;
        return (
          rectFrictionDrop(
            this.section,
            s,
            0,
            this.frictionParams,
            mdot,
            rho,
            mu,
          ) +
          this.gasResistancePerLength * (this.length - s) * Q -
          this.side * this.capillaryPressure +
          (g * s) / this.length
        );
      }
    }
  }

  pressureDropDual(mdot: Dual, rho: number | Dual, mu: number | Dual): Dual {
    const rhoD = toDual(rho);
    const Q = div(mdot, rhoD);
    const g = mul(rhoD, CAPILLARY_GRAVITY * this.elevationChange);
    switch (this.status) {
      case "pinnedInlet":
      case "pinnedOutlet":
      case "trapped":
        return mul(
          mul(Q, toDual(mu)),
          this.closedResistance(1), // linear in μ
        );
      case "dry":
        return mul(Q, this.gasResistancePerLength * this.length);
      case "full":
        return add(
          rectFrictionDropDual(
            this.section,
            this.length,
            0,
            this.frictionParams,
            mdot,
            rho,
            mu,
          ),
          g,
        );
      case "filling": {
        const s = this.fill;
        return add(
          sub(
            add(
              rectFrictionDropDual(
                this.section,
                s,
                0,
                this.frictionParams,
                mdot,
                rho,
                mu,
              ),
              mul(Q, this.gasResistancePerLength * (this.length - s)),
            ),
            this.side * this.capillaryPressure,
          ),
          mul(g, s / this.length),
        );
      }
    }
  }

  snapshotState(): {
    fill: number;
    side: FillSide;
    status: CapillaryChannelStatus;
  } {
    return { fill: this.fill, side: this.side, status: this.status };
  }

  restoreState(snapshot: unknown): void {
    const s = snapshot as ReturnType<CapillaryChannel["snapshotState"]>;
    this.fill = s.fill;
    this.side = s.side;
    this.status = s.status;
  }
}
