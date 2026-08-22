/** Minimal Arrhenius chemistry model for node-local stiff ODE integration.
 *
 *  Reaction form:  k = A · T^b · exp(-Ea / (R·T))
 *  Stoichiometry declared as reactants / products maps (species name → coefficient).
 *  Optional per-reaction heatOfReaction (J/kg of mixture) for energy coupling.
 */

import type { ArrheniusReaction } from "./schema";
import { R_UNIVERSAL } from "./constants";

export type { ArrheniusReaction } from "./schema";

/** Compute species production rates ω_i (kg/m³/s) and temperature source
 *  for a minimal Arrhenius mechanism.
 *
 *  To keep units consistent with dy/dt = ω/ρ, we treat the rate law in
 *  pseudo-molar units scaled by a reference molecular weight W_ref ≈ 0.03 kg/mol.
 *  This is adequate for the scaffolding/demonstration scope.
 */
export function computeChemistryRates(
  Y: Record<string, number>,
  T: number,
  P: number,
  reactions: ArrheniusReaction[],
  speciesNames: string[],
  mixtureR: number, // J/kg/K
  cpMix: number, // J/kg/K
  R_universal = R_UNIVERSAL,
): { omega: Record<string, number>; dTdt: number } {
  const omega: Record<string, number> = {};
  for (const sp of speciesNames) omega[sp] = 0;

  let dTdt = 0;
  const rho = P / (mixtureR * T);

  for (const rxn of reactions) {
    const k =
      rxn.A * Math.pow(T, rxn.b) * Math.exp(-rxn.Ea / (R_universal * T));

    let rate = k; // s⁻¹ for first-order in mass-fraction space
    for (const [sp, coeff] of Object.entries(rxn.reactants)) {
      rate *= Math.pow(Y[sp] ?? 0, coeff);
    }

    // Mass production rates (kg/m³/s): omega_i = nu_i · rate · rho
    for (const sp of speciesNames) {
      const nuReact = rxn.reactants[sp] ?? 0;
      const nuProd = rxn.products[sp] ?? 0;
      const nu = nuProd - nuReact;
      omega[sp] += nu * rate * rho;
    }

    if (rxn.heatOfReaction !== undefined) {
      const firstReactant = Object.keys(rxn.reactants)[0];
      const progressRate = -omega[firstReactant]; // kg/m³/s consumed
      dTdt += (rxn.heatOfReaction * progressRate) / (rho * cpMix);
    }
  }

  return { omega, dTdt };
}

/** Build an ODE RHS dy/dt = f(t, y) for the node-local chemistry sub-step.
 *  State vector: [Y_1, ..., Y_Ns, T]  (last element is temperature).
 */
export function makeChemistryRHS(
  P: number,
  reactions: ArrheniusReaction[],
  speciesNames: string[],
  mixtureR: number,
  cpMix: number,
): (t: number, y: number[]) => number[] {
  return (_t: number, y: number[]) => {
    const Y: Record<string, number> = {};
    for (let i = 0; i < speciesNames.length; i++) {
      Y[speciesNames[i]] = Math.max(0, y[i]);
    }
    const T = y[speciesNames.length];
    const { omega, dTdt } = computeChemistryRates(
      Y,
      T,
      P,
      reactions,
      speciesNames,
      mixtureR,
      cpMix,
    );
    const rho = P / (mixtureR * T);
    const dy = new Array(speciesNames.length + 1).fill(0);
    for (let i = 0; i < speciesNames.length; i++) {
      dy[i] = omega[speciesNames[i]] / rho;
    }
    dy[speciesNames.length] = dTdt;
    return dy;
  };
}
