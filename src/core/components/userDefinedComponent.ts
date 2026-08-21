import type { BranchComponent } from "./branchComponent";
import type { FluidModel } from "../fluids";
import {
  UserCodeError,
  type UserComponentDefinition,
  type UserFluidAccessor,
} from "../usercode/sandbox";

/** Branch component backed by a compiled user-code definition
 *  (usercode/sandbox.ts).  Static `params` (metadata defaults merged with
 *  per-instance overrides) and the contextual `area` are frozen and passed
 *  through on every call.  Non-finite or non-number user outputs are wrapped
 *  in UserCodeError naming the source and phase.  Scalar-only: no dual
 *  support (the solver falls back to the FD Jacobian).
 *
 *  PURE CALLBACK CONTRACT: `definition.pressureDrop` / `definition.heat`
 *  MUST be pure, deterministic functions of their (frozen) args — same args
 *  in, same number out — and MUST NOT depend on hidden state (module-scope
 *  counters, Math.random, Date, ...).  The solver invokes these callbacks
 *  at interior operating points of its own choosing (Newton iterates, FD
 *  Jacobian perturbations, zero-flow linearization), so an impure callback
 *  silently breaks convergence and reproducibility.  Purity CANNOT be
 *  preflight-verified by the solver: any probe call would itself invoke
 *  operating-point-dependent user physics (and would perturb legitimately
 *  stateful closures), so the contract is documented here rather than
 *  checked.  What the solver DOES guarantee is closure ISOLATION: each
 *  branch gets a freshly compiled definition (core/componentFactory.ts), so
 *  state one branch's callbacks keep can never leak into another branch
 *  referencing the same library entry.
 */
export class UserDefinedComponent implements BranchComponent {
  readonly definition: UserComponentDefinition;
  readonly params: Readonly<Record<string, number>>;
  readonly area?: number;
  readonly elevationChange = 0;
  readonly sourceId: string;
  private fluidModel?: FluidModel;
  private fluidAccessor?: UserFluidAccessor;

  constructor(
    definition: UserComponentDefinition,
    options?: {
      params?: Record<string, number>;
      area?: number;
      sourceId?: string;
    },
  ) {
    this.definition = definition;
    this.sourceId = options?.sourceId ?? definition.metadata.name;
    const merged: Record<string, number> = {};
    for (const p of definition.metadata.params ?? []) {
      merged[p.name] = p.default;
    }
    for (const [key, value] of Object.entries(options?.params ?? {})) {
      merged[key] = value;
    }
    this.params = Object.freeze(merged);
    this.area = options?.area;
  }

  private userFluid(fluid?: FluidModel): UserFluidAccessor | undefined {
    if (!fluid) return undefined;
    if (this.fluidModel === fluid && this.fluidAccessor)
      return this.fluidAccessor;
    this.fluidModel = fluid;
    this.fluidAccessor = Object.freeze({
      density: (P: number, T: number) => fluid.density(P, T),
      viscosity: (P: number, T: number) => fluid.viscosity(P, T),
      cp: (P: number, T: number) => fluid.cp(P, T),
      cv: (P: number, T: number) => fluid.cv(P, T),
      enthalpy: (P: number, T: number) => fluid.enthalpy(P, T),
      internalEnergy: (P: number, T: number) => fluid.internalEnergy(P, T),
      temperatureFromEnthalpy: (P: number, h: number) =>
        fluid.temperatureFromEnthalpy(P, h),
      saturationTemperature: (P: number) => fluid.saturationTemperature(P),
      hSatLiquid: (P: number) => fluid.hSatLiquid(P),
      hSatVapor: (P: number) => fluid.hSatVapor(P),
      criticalPressure: () => fluid.criticalPressure(),
      criticalTemperature: () => fluid.criticalTemperature(),
    });
    return this.fluidAccessor;
  }

  pressureDrop(
    mdot: number,
    rho: number,
    mu: number,
    t?: number,
    T?: number,
    fluid?: FluidModel,
    pFrom?: number,
    pTo?: number,
  ): number {
    let dp: number;
    try {
      dp = this.definition.pressureDrop(
        Object.freeze({
          mdot,
          rho,
          mu,
          t: t ?? 0,
          T,
          pFrom,
          pTo,
          area: this.area,
          params: this.params,
          fluid: this.userFluid(fluid),
        }),
      );
    } catch (e) {
      if (e instanceof UserCodeError) throw e;
      throw new UserCodeError(
        this.sourceId,
        "evaluate",
        e instanceof Error ? e.message : String(e),
      );
    }
    if (typeof dp !== "number" || !Number.isFinite(dp)) {
      throw new UserCodeError(
        this.sourceId,
        "evaluate",
        `pressureDrop returned non-finite value (${String(dp)}) at mdot=${mdot}`,
      );
    }
    return dp;
  }

  getBranchHeat(
    mdot: number,
    Tup: number,
    cp: number,
    fluid?: FluidModel,
    P?: number,
    h?: number,
  ): number {
    if (!this.definition.heat) return 0;
    let q: number;
    try {
      q = this.definition.heat(
        Object.freeze({
          mdot,
          Tup,
          cp,
          P,
          h,
          area: this.area,
          params: this.params,
          fluid: this.userFluid(fluid),
        }),
      );
    } catch (e) {
      if (e instanceof UserCodeError) throw e;
      throw new UserCodeError(
        this.sourceId,
        "heat",
        e instanceof Error ? e.message : String(e),
      );
    }
    if (typeof q !== "number" || !Number.isFinite(q)) {
      throw new UserCodeError(
        this.sourceId,
        "heat",
        `heat returned non-finite value (${String(q)}) at mdot=${mdot}`,
      );
    }
    return q;
  }
}
