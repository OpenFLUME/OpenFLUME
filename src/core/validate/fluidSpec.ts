/**
 * Fluid-model / catalogue checks: the default `config.fluid` plus every
 * named entry in `config.fluids` (see core/fluidAssignment.ts for how nodes
 * pick between them).
 */
import type { ResolvedNetworkConfig, FluidSpec } from "../schema";
import { FLUID_MODELS } from "../schema";
import { SUPPORTED_REAL_FLUIDS } from "../fluids/realFluid";
import {
  canonicalizeFluidName,
  fluidHasConductivityModel,
  fluidHasViscosityModel,
  getFluidCatalogueEntry,
  isCuratedRealFluid,
  FLUID_CATALOGUE_COUNT,
} from "../fluids/fluidCatalogue";

/** Catalogue / model checks for one FluidSpec. Omit `named` for the default. */
function validateFluidSpec(spec: FluidSpec, named?: string): string[] {
  const errors: string[] = [];
  const label =
    named === undefined ? "Default fluid" : `Named fluid "${named}"`;
  if (!(FLUID_MODELS as readonly string[]).includes(spec.model)) {
    errors.push(`${label} has unknown model ${JSON.stringify(spec.model)}`);
    return errors;
  }
  if (spec.model !== "realFluid") return errors;
  const fluidName = spec.params?.fluidName;
  if (!fluidName || typeof fluidName !== "string") {
    errors.push(
      named === undefined
        ? "Real fluid model requires fluid.params.fluidName"
        : `${label} requires params.fluidName`,
    );
    return errors;
  }
  const canonical = canonicalizeFluidName(fluidName);
  const subject =
    named === undefined
      ? `Real fluid "${canonical ?? fluidName}"`
      : `${label}: real fluid "${canonical ?? fluidName}"`;
  if (canonical === undefined) {
    errors.push(
      `${named === undefined ? `Real fluid "${fluidName}"` : `${label}: real fluid "${fluidName}"`} is not a CoolProp HEOS fluid. ` +
        `The generated catalogue lists ${FLUID_CATALOGUE_COUNT} fluids ` +
        `(favorites: ${SUPPORTED_REAL_FLUIDS.join(", ")}); registered aliases such as "N2" or "R718" are accepted.`,
    );
  } else if (
    !fluidHasViscosityModel(canonical) &&
    !isCuratedRealFluid(canonical)
  ) {
    const entry = getFluidCatalogueEntry(canonical);
    const condNote =
      entry && !fluidHasConductivityModel(canonical)
        ? " or thermal-conductivity"
        : "";
    errors.push(
      `${subject} has no viscosity${condNote} model in the shipped CoolProp HEOS build, ` +
        `so a solve would silently use zero transport (no friction / no convection). ` +
        `Pick a fluid with transport models in Settings (no-transport fluids are marked with ⚠).`,
    );
  }
  return errors;
}

/** Validate `config.fluid` and every entry of `config.fluids`. */
export function validateFluids(config: ResolvedNetworkConfig): string[] {
  const errors: string[] = [];
  errors.push(...validateFluidSpec(config.fluid));
  if (config.fluids) {
    for (const [name, spec] of Object.entries(config.fluids)) {
      if (name.length === 0) {
        errors.push("Named fluid keys must be non-empty");
        continue;
      }
      errors.push(...validateFluidSpec(spec, name));
      // Mixing EOS classes (e.g. an idealGas hot side with a realFluid
      // coolant) is allowed: the branch rule already guarantees unlike
      // fluids couple only through solid walls, and the solver dispatches
      // property access per node.
    }
  }
  return errors;
}
