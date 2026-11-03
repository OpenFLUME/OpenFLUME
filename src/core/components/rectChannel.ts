import type { BranchComponent } from "./branchComponent";
import {
  DEFAULT_CLOSURE_PARAMS,
  type SwameeJainClosureParams,
} from "../closureParams";
import type { Dual } from "../dual";
import { add, mul, div, abs, toDual } from "../dual";
import { DEFAULT_GRAVITY } from "../schema";
import {
  RE_LAMINAR,
  darcyFrictionFactor,
  darcyFrictionFactorDual,
} from "./frictionFactor";

/** Standard-gravity magnitude [m/s²] — the schema default along −z. */
const STANDARD_GRAVITY = -DEFAULT_GRAVITY.z;

/** Odd-term cap for the rectangular-duct series (terms fall as 1/n⁵; the
 *  loop stops far earlier once a term is below 1e-16 of the sum). */
const SERIES_MAX_TERMS = 200;

/**
 * Shape factor F(α) of fully developed laminar flow in a rectangular duct,
 * from the exact Fourier-series solution of the Poisson equation
 * (Boussinesq; White, *Viscous Fluid Flow*, eq. 3-48; Bruus,
 * *Theoretical Microfluidics*, eq. 3.56):
 *
 *   Q = a³ b ΔP / (12 μ L) · F,
 *   F = 1 − (192 a)/(π⁵ b) · Σ_{n odd} tanh(n π b / 2a) / n⁵,
 *
 * with a = min(w, h) and b = max(w, h).  F → 1 for parallel plates
 * (a/b → 0) and F ≈ 0.4217 for a square duct.  The series is summed to
 * machine precision, NOT truncated to its first term (the common
 * one-term approximation is 0.2 % off at α = 1).
 */
export function rectShapeFactor(width: number, height: number): number {
  const a = Math.min(width, height);
  const b = Math.max(width, height);
  let sum = 0;
  for (let k = 0; k < SERIES_MAX_TERMS; k++) {
    const n = 2 * k + 1;
    const term = Math.tanh((n * Math.PI * b) / (2 * a)) / Math.pow(n, 5);
    sum += term;
    if (term < 1e-16 * sum) break;
  }
  return 1 - ((192 * a) / (Math.pow(Math.PI, 5) * b)) * sum;
}

/** Hydraulic diameter D_h = 4A/P = 2wh/(w + h) [m]. */
export function rectHydraulicDiameter(width: number, height: number): number {
  return (2 * width * height) / (width + height);
}

/**
 * Laminar Poiseuille number Po = f_Darcy · Re_Dh of a rectangular duct,
 * derived from the exact series: Po = 24 D_h² / (a² F).
 * Limits: 96 (parallel plates), 56.91 (square).
 */
export function rectPoiseuilleNumber(width: number, height: number): number {
  const a = Math.min(width, height);
  const dh = rectHydraulicDiameter(width, height);
  return (24 * dh * dh) / (a * a * rectShapeFactor(width, height));
}

/**
 * Exact laminar hydraulic resistance R = ΔP/Q [Pa·s/m³] of a rectangular
 * channel: R = 12 μ L / (a³ b F).
 */
export function rectLaminarResistance(
  width: number,
  height: number,
  length: number,
  mu: number,
): number {
  const a = Math.min(width, height);
  const b = Math.max(width, height);
  return (12 * mu * length) / (a * a * a * b * rectShapeFactor(width, height));
}

/** Precomputed cross-section constants shared by RectChannel and
 *  CapillaryChannel. */
export interface RectSection {
  width: number;
  height: number;
  area: number;
  hydraulicDiameter: number;
  poiseuille: number;
}

export function rectSection(width: number, height: number): RectSection {
  return {
    width,
    height,
    area: width * height,
    hydraulicDiameter: rectHydraulicDiameter(width, height),
    poiseuille: rectPoiseuilleNumber(width, height),
  };
}

/**
 * Frictional pressure drop [Pa] of a liquid column of length `length` in a
 * rectangular section, signed with ṁ.
 *
 * Laminar (Re_Dh < RE_LAMINAR): the exact linear law
 *   ΔP = Po μ L V / (2 D_h²) = R_lam · Q,
 * evaluated directly — NOT through f = Po/Re, whose Re floor would make the
 * law spuriously quadratic at the very small Reynolds numbers routine in
 * microchannels (Re ≪ 1e-6 for slow capillary fronts).
 * Transitional/turbulent: f(Re) from darcyFrictionFactor with the duct's own
 * Po in the laminar limb (Swamee–Jain on D_h above RE_TURBULENT, the
 * standard hydraulic-diameter approximation for non-circular ducts).  The
 * two limbs agree in value at Re = RE_LAMINAR.
 */
export function rectFrictionDrop(
  s: RectSection,
  length: number,
  roughness: number,
  sj: SwameeJainClosureParams,
  mdot: number,
  rho: number,
  mu: number,
): number {
  if (length <= 0) return 0;
  const D = s.hydraulicDiameter;
  const v = mdot / (rho * s.area);
  const Re = (rho * Math.abs(v) * D) / mu;
  if (Re < RE_LAMINAR) {
    return (s.poiseuille * mu * length * v) / (2 * D * D);
  }
  const f = darcyFrictionFactor(Re, roughness / D, sj, s.poiseuille);
  return (f * (length / D) * (rho * v * Math.abs(v))) / 2;
}

/** Dual-number twin of rectFrictionDrop (identical branching on the primal). */
export function rectFrictionDropDual(
  s: RectSection,
  length: number,
  roughness: number,
  sj: SwameeJainClosureParams,
  mdot: Dual,
  rho: number | Dual,
  mu: number | Dual,
): Dual {
  if (length <= 0) return { v: 0, d: 0 };
  const D = s.hydraulicDiameter;
  const rhoD = toDual(rho);
  const muD = toDual(mu);
  const v = div(mdot, mul(rhoD, s.area));
  const Re = div(mul(mul(rhoD, D), abs(v)), muD);
  if (Re.v < RE_LAMINAR) {
    return div(mul(mul(muD, v), s.poiseuille * length), 2 * D * D);
  }
  const f = darcyFrictionFactorDual(Re, roughness / D, sj, s.poiseuille);
  return mul(f, div(mul(rhoD, mul(v, abs(v))), (2 * D) / length));
}

/**
 * Straight rectangular channel — the standard cross-section of soft-
 * lithography (PDMS), etched-glass and milled microfluidic chips.
 *
 * Fully developed flow with the exact laminar resistance (see
 * rectShapeFactor), a smooth blend to Swamee–Jain on D_h for Re > 2300, and
 * an optional hydrostatic term ρ g Δz.  Entrance-length effects are not
 * modelled: the developing length L_e ≈ 0.06 Re D_h is a vanishing fraction
 * of the channel at the Re ≲ 10 typical of microfluidics.
 */
export class RectChannel implements BranchComponent {
  readonly width: number;
  readonly height: number;
  readonly length: number;
  readonly roughness: number;
  readonly elevationChange: number;
  readonly area: number;
  readonly hydraulicDiameter: number;
  /** Laminar f·Re for this aspect ratio. */
  readonly poiseuille: number;
  /** Laminar flow guess: the network default (0.1 kg/s) sits at
   *  Re ~ 1e9 in a microchannel, far from the linear regime. */
  readonly defaultInitialMdot = 1e-9;
  /** Laminar law is linear (finite slope, intercept from capillarity or
   *  hydrostatics): evaluate exactly at microfluidic flows. */
  readonly exactNearZeroFlow = true;
  readonly frictionParams: SwameeJainClosureParams;
  private readonly section: RectSection;

  constructor(
    width: number,
    height: number,
    length: number,
    roughness = 0,
    elevationChange = 0,
    frictionParams?: SwameeJainClosureParams,
  ) {
    this.width = width;
    this.height = height;
    this.length = length;
    this.roughness = roughness;
    this.elevationChange = elevationChange;
    this.section = rectSection(width, height);
    this.area = this.section.area;
    this.hydraulicDiameter = this.section.hydraulicDiameter;
    this.poiseuille = this.section.poiseuille;
    this.frictionParams = frictionParams ?? DEFAULT_CLOSURE_PARAMS.swameeJain;
  }

  /** Exact laminar resistance ΔP/Q [Pa·s/m³] at viscosity μ. */
  laminarResistance(mu: number): number {
    return rectLaminarResistance(this.width, this.height, this.length, mu);
  }

  pressureDrop(mdot: number, rho: number, mu: number): number {
    return (
      rectFrictionDrop(
        this.section,
        this.length,
        this.roughness,
        this.frictionParams,
        mdot,
        rho,
        mu,
      ) +
      rho * STANDARD_GRAVITY * this.elevationChange
    );
  }

  pressureDropDual(mdot: Dual, rho: number | Dual, mu: number | Dual): Dual {
    return add(
      rectFrictionDropDual(
        this.section,
        this.length,
        this.roughness,
        this.frictionParams,
        mdot,
        rho,
        mu,
      ),
      mul(toDual(rho), STANDARD_GRAVITY * this.elevationChange),
    );
  }
}
