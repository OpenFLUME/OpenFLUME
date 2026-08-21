/**
 * Species/chemistry validation: array-length consistency, reaction
 * stoichiometry, mass-fraction ranges, and the idealGas/single-fluid
 * restriction species transport is currently limited to.
 */
import type { ResolvedNetworkConfig } from "../schema";
import { networkHasNamedFluidAssignment } from "../fluidAssignment";

export function validateSpecies(config: ResolvedNetworkConfig): string[] {
  const errors: string[] = [];
  if (!config.species) return errors;

  const s = config.species;
  if (!s.names || s.names.length === 0) {
    errors.push("species.names must be a non-empty array");
  }
  if (!s.molecularWeights || s.molecularWeights.length === 0) {
    errors.push("species.molecularWeights must be a non-empty array");
  }
  if (
    s.names &&
    s.molecularWeights &&
    s.names.length !== s.molecularWeights.length
  ) {
    errors.push(
      "species.names and species.molecularWeights must have the same length",
    );
  }
  if (s.cp && s.names && s.cp.length !== s.names.length) {
    errors.push("species.cp must have the same length as species.names");
  }
  if (
    s.formationEnthalpy &&
    s.names &&
    s.formationEnthalpy.length !== s.names.length
  ) {
    errors.push(
      "species.formationEnthalpy must have the same length as species.names",
    );
  }
  if (s.viscosity && s.names && s.viscosity.length !== s.names.length) {
    errors.push("species.viscosity must have the same length as species.names");
  }
  for (const mw of s.molecularWeights ?? []) {
    if (mw <= 0) {
      errors.push("species.molecularWeights must be positive");
      break;
    }
  }
  const speciesSet = new Set(s.names ?? []);

  if (s.reactions) {
    for (let ri = 0; ri < s.reactions.length; ri++) {
      const rxn = s.reactions[ri];
      for (const sp of Object.keys({ ...rxn.reactants, ...rxn.products })) {
        if (!speciesSet.has(sp)) {
          errors.push(`Reaction ${ri} references unknown species "${sp}"`);
        }
      }
      for (const [side, map] of [
        ["reactant", rxn.reactants],
        ["product", rxn.products],
      ] as const) {
        for (const [sp, stoich] of Object.entries(map)) {
          if (stoich <= 0) {
            errors.push(
              `Reaction ${ri}: ${side} "${sp}" stoichiometry must be positive (got ${stoich})`,
            );
          }
        }
      }
      if (rxn.A < 0) errors.push(`Reaction ${ri}: A must be non-negative`);
    }
  }
  // Species transport is only supported for a single ideal-gas continuum.
  if (config.fluid.model !== "idealGas") {
    errors.push(
      "Species transport is only supported for idealGas fluid model in this release",
    );
  }
  if (networkHasNamedFluidAssignment(config)) {
    errors.push(
      "Species transport is not supported in multi-fluid networks (species is composition within one ideal gas)",
    );
  }
  for (const node of config.nodes) {
    if (node.massFractions) {
      let sum = 0;
      for (const [sp, y] of Object.entries(node.massFractions)) {
        if (!speciesSet.has(sp)) {
          errors.push(`Node ${node.id} references unknown species "${sp}"`);
        }
        if (y < 0 || y > 1) {
          errors.push(
            `Node ${node.id} mass fraction for "${sp}" must be in [0,1]`,
          );
        }
        sum += y;
      }
      if (Math.abs(sum - 1) > 1e-6) {
        errors.push(
          `Node ${node.id} mass fractions must sum to 1 (got ${sum})`,
        );
      }
    }
  }

  return errors;
}
