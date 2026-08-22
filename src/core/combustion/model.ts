/**
 * Thermochemistry closure of a reacting junction (JunctionConfig.model,
 * core/schema.ts): given the junction (chamber) pressure and the per-role
 * reactant mass flows, produce the adiabatic product-gas state.
 *
 * The interface is deliberately stream-generic — roles are strings, mass
 * flows arrive as a per-role map — so future engine types (jet burners,
 * afterburners, ramjets) can add models without touching the solver.  The
 * one v1 implementation is the NASA CEA chamber-equilibrium table
 * (`ceaTable`), which maps roles {oxidizer, fuel} to the tabulated
 * (Pc, O/F) axes via O/F = ṁ_ox/ṁ_fuel.
 *
 * KNOWN v1 LIMITATION (interface slot reserved): reactant inlet ENTHALPY is
 * not yet an input.  The committed CEA tables assume standard-state
 * propellant injection, which is the rocket convention; air-breathing
 * burners need product state as a function of the (widely varying) air
 * inlet enthalpy, i.e. a table dimension and an extra argument here.
 *
 * Solver contract (core/solver/kernel.ts):
 *   - `evaluate` is called on the scalar residual path and by the outer
 *     Picard property-lag update (core/solver/step.ts) — it must be cheap
 *     (table interpolation, no allocation-heavy work) and total (floor/clamp
 *     mid-iteration garbage rather than throw).
 *   - `chamberT0Dual` is the dual-number mirror of `evaluate(...).gas.T0`
 *     for the hybrid Jacobian: same primal value, derivatives chained from
 *     the seeded pressure/mass-flow duals.
 */
import type { Dual } from "../dual";
import { constant, div, abs, max } from "../dual";
import type { JunctionModelConfig } from "../schema";
import {
  lookupCombustionGas,
  lookupChamberT0Dual,
  type CombustionGasState,
} from "./combustionGas";

export interface CombustionProductEvaluation {
  /** Adiabatic product state: T0, mw, R, gamma, cp, mu, cstar. */
  readonly gas: CombustionGasState;
  /** True when the requested pressure fell outside the model's tabulated
   *  range and was clamped to the nearest edge. */
  readonly clampedPc: boolean;
  /** True when the requested mixture ratio fell outside the tabulated
   *  range and was clamped to the nearest edge. */
  readonly clampedOf: boolean;
  /** Oxidizer/fuel mass ratio actually used — reporting convenience for
   *  models with those roles; undefined otherwise. */
  readonly of?: number;
}

export interface CombustionModel {
  /** Roles the junction's inlets must cover (≥ 1 inlet branch each). */
  readonly requiredRoles: readonly string[];
  /** Adiabatic product state at (pressure, per-role inlet mass flows).
   *  Mass flows are already summed per role and non-negative. */
  evaluate(
    pPa: number,
    mdotByRole: ReadonlyMap<string, number>,
  ): CombustionProductEvaluation;
  /** Adiabatic chamber temperature T0 [K], derivatives chained from the
   *  seeded (pressure, mass-flow) duals.  Primal value must equal
   *  `evaluate(...).gas.T0` at the same arguments. */
  chamberT0Dual(pPa: Dual, mdotByRole: ReadonlyMap<string, Dual>): Dual;
}

/** Floors keeping the lookup well-posed for a mid-iteration, not-yet-
 *  physical iterate; they never affect a converged result. */
const PC_FLOOR_PA = 1;
const MDOT_FLOOR_KG_S = 1e-12;
const OF_FLOOR = 1e-6;

export function createCombustionModel(
  config: JunctionModelConfig,
): CombustionModel {
  // The schema union has one member; keep the dispatch explicit so a new
  // model type fails loudly here rather than silently acting like CEA.
  if (config.type !== "ceaTable") {
    throw new Error(
      `createCombustionModel: unknown model type "${(config as { type: string }).type}"`,
    );
  }
  const propellants = config.propellants;
  return {
    requiredRoles: ["oxidizer", "fuel"],
    evaluate(pPa, mdotByRole) {
      const mdotOx = mdotByRole.get("oxidizer") ?? 0;
      const mdotFuel = mdotByRole.get("fuel") ?? 0;
      const of = Math.max(
        mdotOx / Math.max(mdotFuel, MDOT_FLOOR_KG_S),
        OF_FLOOR,
      );
      const pcSafe = Math.max(pPa, PC_FLOOR_PA);
      const { state, clampedPc, clampedOf } = lookupCombustionGas(
        propellants,
        pcSafe,
        of,
      );
      return { gas: state, clampedPc, clampedOf, of };
    },
    chamberT0Dual(pPa, mdotByRole) {
      const mdotOx = mdotByRole.get("oxidizer") ?? constant(0);
      const mdotFuel = mdotByRole.get("fuel") ?? constant(0);
      // Same floors as the scalar path (dual max: derivative 0 while the
      // floor is active — the derivative of the clamped function).
      const of = max(
        div(abs(mdotOx), max(abs(mdotFuel), constant(MDOT_FLOOR_KG_S))),
        constant(OF_FLOOR),
      );
      const pcSafe = max(pPa, constant(PC_FLOOR_PA));
      return lookupChamberT0Dual(propellants, pcSafe, of);
    },
  };
}
