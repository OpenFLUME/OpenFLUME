/**
 * FluidModel interface and the built-in analytic (non-CoolProp) fluid models.
 *
 *   FluidModel            the interface every fluid — analytic or real —
 *                         implements: density/viscosity/cp/cv/enthalpy plus
 *                         the phase/saturation API and optional dual-number
 *                         variants for exact Jacobian derivatives.
 *   IncompressibleLiquid  constant ρ, μ, cp.
 *   IdealGas              PV = ρRT with constant μ, cp.
 *   ExpandableLiquid      ρ varies linearly with T (thermal expansion), else
 *                         like IncompressibleLiquid.
 *   MixtureFluidModel /   composition-dependent variant used only when
 *   IdealGasMixture       species are declared (see species.ts / chemistry).
 *   createFluidModel      factory dispatching on the schema's fluid.model.
 *
 * RealFluid (CoolProp-backed) lives in realFluid.ts; see fluidCatalogue.ts
 * for the supported-fluid list and coolprop.ts for the WASM bridge.
 */
import { RealFluid, type PHState, type PHDerivatives } from "./realFluid";
import type { Dual } from "../dual";
import { constant, div } from "../dual";

export interface FluidModel {
  density(P: number, T: number): number;
  viscosity(P: number, T: number): number;
  cp(P: number, T: number): number;
  cv(P: number, T: number): number;
  enthalpy(P: number, T: number): number;
  /** True specific internal energy (J/kg). Default: cv·T. */
  internalEnergy(P: number, T: number): number;
  /** Inverse: T from h(P,T). Default: h/cp. */
  temperatureFromEnthalpy(P: number, h: number): number;
  /** Inverse: T from u(P,T). Default: u/cv. */
  temperatureFromInternalEnergy(P: number, u: number): number;
  R?: number;
  gamma?: number;

  // ---- Dual-number variants (forward-mode AD) for exact Jacobian derivatives ----
  densityDual?(P: Dual | number, T: number): Dual;
  viscosityDual?(P: Dual | number, T: number): Dual;

  // ---- Phase / saturation API (no-op or trivial for legacy models) ----
  saturationTemperature(P: number): number;
  hSatLiquid(P: number): number;
  hSatVapor(P: number): number;
  rhoSatLiquid(P: number): number;
  rhoSatVapor(P: number): number;
  criticalPressure(): number;
  criticalTemperature(): number;
  statePH(P: number, h: number): PHState;
  enthalpyPT(P: number, T: number): number;
  enthalpyPQ(P: number, quality: number): number;
  internalEnergyPH(P: number, h: number): number;
  enthalpyFromInternalEnergy(P: number, u: number): number;
  /** Analytic partials of statePH at (P, h), used by the coupled-h Newton
   *  system's dual-number Jacobian.  Closed-form for the analytic models;
   *  CoolProp first_partial_deriv / saturation algebra for RealFluid.
   *  Optional so user-supplied models degrade to the FD Jacobian instead of
   *  breaking. */
  derivativesPH?(P: number, h: number): PHDerivatives;

  // ---- Reporting-only properties (never on the solver hot path) ----
  //
  // Optional because they are only defined for models that actually carry
  // the underlying physics.  A model that omits one simply does not publish
  // that channel (core/results/derivedProperties.ts) rather than reporting a
  // made-up number: absolute entropy needs a reference state that the
  // analytic models do not define, and sound speed / conductivity are not
  // part of the incompressible or constant-property closures.

  /** Absolute specific entropy s(P,T) [J/(kg·K)]. */
  entropy?(P: number, T: number): number;
  /** Isentropic speed of sound a(P,T) [m/s]. */
  speedOfSound?(P: number, T: number): number;
  /** Thermal conductivity k(P,T) [W/(m·K)]. */
  thermalConductivity?(P: number, T: number): number;
}

export class IncompressibleLiquid implements FluidModel {
  readonly rho: number;
  readonly mu: number;
  private readonly _cp: number;

  constructor(rho: number, mu: number, cp: number) {
    this.rho = rho;
    this.mu = mu;
    this._cp = cp;
  }

  density(_P: number, _T: number): number {
    return this.rho;
  }

  densityDual(_P: Dual | number, _T: number): Dual {
    return constant(this.rho);
  }

  viscosity(_P: number, _T: number): number {
    return this.mu;
  }

  viscosityDual(_P: Dual | number, _T: number): Dual {
    return constant(this.mu);
  }

  cp(_P: number, _T: number): number {
    return this._cp;
  }

  cv(_P: number, _T: number): number {
    return this._cp;
  }

  enthalpy(_P: number, T: number): number {
    return this._cp * T;
  }

  internalEnergy(_P: number, T: number): number {
    return this._cp * T;
  }

  temperatureFromEnthalpy(_P: number, h: number): number {
    return h / this._cp;
  }

  temperatureFromInternalEnergy(_P: number, u: number): number {
    return u / this._cp;
  }

  saturationTemperature(_P: number): number {
    throw new Error("IncompressibleLiquid does not have a saturation curve");
  }

  hSatLiquid(_P: number): number {
    throw new Error("IncompressibleLiquid does not have a saturation curve");
  }

  hSatVapor(_P: number): number {
    throw new Error("IncompressibleLiquid does not have a saturation curve");
  }

  rhoSatLiquid(_P: number): number {
    return this.rho;
  }

  rhoSatVapor(_P: number): number {
    throw new Error("IncompressibleLiquid does not have a vapor phase");
  }

  criticalPressure(): number {
    return Infinity;
  }

  criticalTemperature(): number {
    return Infinity;
  }

  statePH(_P: number, h: number): PHState {
    const T = h / this._cp;
    return {
      T,
      rho: this.rho,
      quality: undefined,
      mu: this.mu,
      phase: "liquid",
    };
  }

  enthalpyPT(_P: number, T: number): number {
    return this._cp * T;
  }

  enthalpyPQ(_P: number, _quality: number): number {
    throw new Error(
      "IncompressibleLiquid does not support quality-based enthalpy",
    );
  }

  internalEnergyPH(_P: number, h: number): number {
    return h; // u = h for incompressible liquid (pv work negligible)
  }

  enthalpyFromInternalEnergy(_P: number, u: number): number {
    return u;
  }

  derivativesPH(_P: number, _h: number): PHDerivatives {
    return {
      drhodP_h: 0,
      drhodh_P: 0,
      dTdP_h: 0,
      dTdh_P: 1 / this._cp,
      dcpdP_h: 0,
      dcpdh_P: 0,
      phase: "liquid",
    };
  }

  static WATER = new IncompressibleLiquid(998, 1.0e-3, 4182);
}

export class IdealGas implements FluidModel {
  readonly R: number;
  readonly gamma: number;
  readonly mu: number;
  private readonly _cp: number;

  constructor(R: number, gamma: number, mu: number, cp: number) {
    this.R = R;
    this.gamma = gamma;
    this.mu = mu;
    this._cp = cp;
  }

  density(P: number, T: number): number {
    return P / (this.R * T);
  }

  densityDual(P: Dual | number, T: number): Dual {
    return div(P, constant(this.R * T));
  }

  viscosity(_P: number, _T: number): number {
    return this.mu;
  }

  viscosityDual(_P: Dual | number, _T: number): Dual {
    return constant(this.mu);
  }

  cp(_P: number, _T: number): number {
    return this._cp;
  }

  cv(_P: number, _T: number): number {
    return this._cp - this.R;
  }

  enthalpy(_P: number, T: number): number {
    return this._cp * T;
  }

  internalEnergy(_P: number, T: number): number {
    return (this._cp - this.R) * T;
  }

  temperatureFromEnthalpy(_P: number, h: number): number {
    return h / this._cp;
  }

  temperatureFromInternalEnergy(_P: number, u: number): number {
    return u / (this._cp - this.R);
  }

  saturationTemperature(_P: number): number {
    throw new Error("IdealGas does not have a saturation curve");
  }

  hSatLiquid(_P: number): number {
    throw new Error("IdealGas does not have a saturation curve");
  }

  hSatVapor(_P: number): number {
    throw new Error("IdealGas does not have a saturation curve");
  }

  rhoSatLiquid(_P: number): number {
    throw new Error("IdealGas does not have a liquid phase");
  }

  rhoSatVapor(P: number): number {
    // For an ideal gas, the "vapor" density is just the ideal gas density at some reference T
    // This is meaningless for saturation, but return something consistent
    return this.density(P, 300); // arbitrary reference
  }

  criticalPressure(): number {
    return Infinity;
  }

  criticalTemperature(): number {
    return Infinity;
  }

  statePH(P: number, h: number): PHState {
    const T = h / this._cp;
    return {
      T,
      rho: this.density(P, T),
      quality: undefined,
      mu: this.mu,
      phase: "vapor",
    };
  }

  enthalpyPT(_P: number, T: number): number {
    return this._cp * T;
  }

  enthalpyPQ(_P: number, _quality: number): number {
    throw new Error("IdealGas does not support quality-based enthalpy");
  }

  internalEnergyPH(P: number, h: number): number {
    const T = h / this._cp;
    return this.internalEnergy(P, T);
  }

  enthalpyFromInternalEnergy(P: number, u: number): number {
    const T = u / (this._cp - this.R);
    return this.enthalpy(P, T);
  }

  derivativesPH(P: number, h: number): PHDerivatives {
    // T = h/cp, ρ = P/(R·T):
    //   ∂ρ/∂P|h = 1/(R·T)
    //   ∂ρ/∂h|P = −P/(R·T²)·(1/cp) = −ρ/(T·cp)
    const T = h / this._cp;
    const rho = P / (this.R * T);
    return {
      drhodP_h: 1 / (this.R * T),
      drhodh_P: -rho / (T * this._cp),
      dTdP_h: 0,
      dTdh_P: 1 / this._cp,
      dcpdP_h: 0,
      dcpdh_P: 0,
      phase: "vapor",
    };
  }

  speedOfSound(_P: number, T: number): number {
    return Math.sqrt(this.gamma * this.R * T);
  }

  static AIR = new IdealGas(287, 1.4, 1.8e-5, 1005);
}

/** Thermal-expansion liquid: density varies linearly with temperature. */
export class ExpandableLiquid implements FluidModel {
  readonly rho0: number;
  readonly beta: number;
  readonly T0: number;
  readonly mu: number;
  private readonly _cp: number;

  constructor(rho0: number, beta: number, T0: number, mu: number, cp: number) {
    this.rho0 = rho0;
    this.beta = beta;
    this.T0 = T0;
    this.mu = mu;
    this._cp = cp;
  }

  density(_P: number, T: number): number {
    return this.rho0 * (1 - this.beta * (T - this.T0));
  }

  densityDual(_P: Dual | number, T: number): Dual {
    // Density does not depend on P for ExpandableLiquid; only on T.
    // When used in a P-column derivative, T is constant, so derivative is 0.
    return constant(this.rho0 * (1 - this.beta * (T - this.T0)));
  }

  viscosity(_P: number, _T: number): number {
    return this.mu;
  }

  viscosityDual(_P: Dual | number, _T: number): Dual {
    return constant(this.mu);
  }

  cp(_P: number, _T: number): number {
    return this._cp;
  }

  cv(_P: number, _T: number): number {
    return this._cp;
  }

  enthalpy(_P: number, T: number): number {
    return this._cp * T;
  }

  internalEnergy(_P: number, T: number): number {
    return this._cp * T;
  }

  temperatureFromEnthalpy(_P: number, h: number): number {
    return h / this._cp;
  }

  temperatureFromInternalEnergy(_P: number, u: number): number {
    return u / this._cp;
  }

  saturationTemperature(_P: number): number {
    throw new Error("ExpandableLiquid does not have a saturation curve");
  }

  hSatLiquid(_P: number): number {
    throw new Error("ExpandableLiquid does not have a saturation curve");
  }

  hSatVapor(_P: number): number {
    throw new Error("ExpandableLiquid does not have a saturation curve");
  }

  rhoSatLiquid(_P: number): number {
    return this.rho0;
  }

  rhoSatVapor(_P: number): number {
    throw new Error("ExpandableLiquid does not have a vapor phase");
  }

  criticalPressure(): number {
    return Infinity;
  }

  criticalTemperature(): number {
    return Infinity;
  }

  statePH(_P: number, h: number): PHState {
    const T = h / this._cp;
    return {
      T,
      rho: this.density(0, T),
      quality: undefined,
      mu: this.mu,
      phase: "liquid",
    };
  }

  enthalpyPT(_P: number, T: number): number {
    return this._cp * T;
  }

  enthalpyPQ(_P: number, _quality: number): number {
    throw new Error("ExpandableLiquid does not support quality-based enthalpy");
  }

  internalEnergyPH(_P: number, h: number): number {
    return h;
  }

  enthalpyFromInternalEnergy(_P: number, u: number): number {
    return u;
  }

  derivativesPH(_P: number, _h: number): PHDerivatives {
    // T = h/cp, ρ = ρ0·(1 − β·(T − T0)):  ∂ρ/∂h|P = −ρ0·β/cp.
    return {
      drhodP_h: 0,
      drhodh_P: (-this.rho0 * this.beta) / this._cp,
      dTdP_h: 0,
      dTdh_P: 1 / this._cp,
      dcpdP_h: 0,
      dcpdh_P: 0,
      phase: "liquid",
    };
  }

  static WATER_EXPANDABLE = new ExpandableLiquid(
    998,
    2.07e-4,
    293,
    1.0e-3,
    4182,
  );
}

/** Composition-dependent fluid-model interface.
 *  Coexists with the single-substance FluidModel; the solver uses this
 *  only when species are declared.
 */
export interface MixtureFluidModel {
  /** Mixture gas constant (J/kg/K) from mass fractions. */
  R_mix(Y: Record<string, number>): number;
  /** Mixture molecular weight (kg/mol) from mass fractions. */
  W_mix(Y: Record<string, number>): number;
  densityMix(P: number, T: number, Y: Record<string, number>): number;
  viscosityMix(P: number, T: number, Y: Record<string, number>): number;
  cpMix(P: number, T: number, Y: Record<string, number>): number;
  cvMix(P: number, T: number, Y: Record<string, number>): number;
  /** Mixture specific enthalpy (J/kg) at (P,T,Y). */
  enthalpyMix(P: number, T: number, Y: Record<string, number>): number;
  /** Mixture specific internal energy (J/kg) at (P,T,Y). */
  internalEnergyMix(P: number, T: number, Y: Record<string, number>): number;
  temperatureFromEnthalpyMix(
    P: number,
    h: number,
    Y: Record<string, number>,
  ): number;
  gammaMix(P: number, T: number, Y: Record<string, number>): number;
}

/** Ideal-gas mixture built from per-species properties.
 *  Mixture rules:
 *    W_mix = 1 / Σ (Y_i / W_i)
 *    R_mix = R_universal / W_mix
 *    ρ     = P / (R_mix·T)
 *    cp    = Σ Y_i·cp_i
 *    h     = Σ Y_i·(cp_i·T + h_form_i)   [formation enthalpy absorbed into reference]
 *    μ     = Σ Y_i·μ_i   (mass-weighted, adequate for dilute/scaffolding)
 */
export class IdealGasMixture implements MixtureFluidModel {
  readonly speciesNames: string[];
  readonly molecularWeights: number[]; // kg/mol
  readonly cp: number[]; // J/kg/K
  readonly formationEnthalpy: number[]; // J/kg
  readonly viscosity: number[]; // Pa·s
  readonly R_universal = 8.314462618; // J/mol/K

  constructor(
    names: string[],
    molecularWeights: number[],
    cp?: number[],
    formationEnthalpy?: number[],
    viscosity?: number[],
  ) {
    if (names.length !== molecularWeights.length) {
      throw new Error("names and molecularWeights must have the same length");
    }
    this.speciesNames = [...names];
    this.molecularWeights = [...molecularWeights];
    this.cp = cp ? [...cp] : new Array(names.length).fill(1005);
    this.formationEnthalpy = formationEnthalpy
      ? [...formationEnthalpy]
      : new Array(names.length).fill(0);
    this.viscosity = viscosity
      ? [...viscosity]
      : new Array(names.length).fill(1.8e-5);
  }

  private _arrayFromY(Y: Record<string, number>): number[] {
    return this.speciesNames.map((n) => Y[n] ?? 0);
  }

  W_mix(Y: Record<string, number>): number {
    const y = this._arrayFromY(Y);
    let sum = 0;
    for (let i = 0; i < y.length; i++) {
      sum += y[i] / this.molecularWeights[i];
    }
    return 1 / Math.max(sum, 1e-30);
  }

  R_mix(Y: Record<string, number>): number {
    return this.R_universal / this.W_mix(Y);
  }

  densityMix(P: number, T: number, Y: Record<string, number>): number {
    return P / (this.R_mix(Y) * T);
  }

  viscosityMix(_P: number, _T: number, Y: Record<string, number>): number {
    const y = this._arrayFromY(Y);
    let mu = 0;
    for (let i = 0; i < y.length; i++) mu += y[i] * this.viscosity[i];
    return mu;
  }

  cpMix(_P: number, _T: number, Y: Record<string, number>): number {
    const y = this._arrayFromY(Y);
    let c = 0;
    for (let i = 0; i < y.length; i++) c += y[i] * this.cp[i];
    return c;
  }

  cvMix(P: number, T: number, Y: Record<string, number>): number {
    return this.cpMix(P, T, Y) - this.R_mix(Y);
  }

  enthalpyMix(_P: number, T: number, Y: Record<string, number>): number {
    const y = this._arrayFromY(Y);
    let h = 0;
    for (let i = 0; i < y.length; i++) {
      h += y[i] * (this.cp[i] * T + this.formationEnthalpy[i]);
    }
    return h;
  }

  internalEnergyMix(P: number, T: number, Y: Record<string, number>): number {
    return this.enthalpyMix(P, T, Y) - this.R_mix(Y) * T;
  }

  temperatureFromEnthalpyMix(
    _P: number,
    h: number,
    Y: Record<string, number>,
  ): number {
    const y = this._arrayFromY(Y);
    let cpMix = 0;
    let hFormMix = 0;
    for (let i = 0; i < y.length; i++) {
      cpMix += y[i] * this.cp[i];
      hFormMix += y[i] * this.formationEnthalpy[i];
    }
    if (cpMix <= 0) return 300;
    return (h - hFormMix) / cpMix;
  }

  gammaMix(P: number, T: number, Y: Record<string, number>): number {
    const cp = this.cpMix(P, T, Y);
    const cv = this.cvMix(P, T, Y);
    return cv > 0 ? cp / cv : 1.4;
  }
}

export function createFluidModel(
  model: "incompressible" | "idealGas" | "expandableLiquid" | "realFluid",
  preset?: "water" | "air" | "waterExpandable",
  params?: Record<string, number | string>,
): FluidModel {
  const p = params as Record<string, number> | undefined;
  if (model === "incompressible") {
    if (preset === "water") return IncompressibleLiquid.WATER;
    return new IncompressibleLiquid(
      p?.rho ?? 1000,
      p?.mu ?? 1e-3,
      p?.cp ?? 4182,
    );
  }
  if (model === "expandableLiquid") {
    if (preset === "waterExpandable") return ExpandableLiquid.WATER_EXPANDABLE;
    return new ExpandableLiquid(
      p?.rho0 ?? 998,
      p?.beta ?? 2.07e-4,
      p?.T0 ?? 293,
      p?.mu ?? 1e-3,
      p?.cp ?? 4182,
    );
  }
  if (model === "realFluid") {
    return new RealFluid(String(params?.fluidName ?? ""));
  }
  if (preset === "air") return IdealGas.AIR;
  return new IdealGas(
    p?.R ?? 287,
    p?.gamma ?? 1.4,
    p?.mu ?? 1.8e-5,
    p?.cp ?? 1005,
  );
}

// Re-export types for consumers
export type {
  FluidPhase,
  PHState,
  PHStateDual,
  PHDerivatives,
} from "./realFluid";
export { clampToValidPH, clampToValidPT } from "./realFluid";
