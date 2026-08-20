/**
 * Hand-written query layer over the GENERATED CoolProp HEOS fluid catalogue
 * (./generated/fluidCatalogue.ts — regenerate with `npm run gen:fluid-catalogue`).
 *
 * Everything here is synchronous, side-effect free and WASM-free: parsing or
 * validating a config (including inside the solver web worker) never requires
 * the CoolProp module to be initialized.
 *
 * Canonicalization policy (deliberately conservative — no fuzzy matching):
 *  1. exact match on a canonical name           → that name
 *  2. exact match on a registered alias         → its canonical name,
 *     unless the alias collides with another entry's name or alias
 *     (ambiguous aliases are excluded from the index at module load)
 *  3. case-insensitive match on a canonical name or registered alias → the
 *     canonical name, ONLY when the lower-cased key is globally unique
 *  4. otherwise                                 → undefined
 * Both indexes are built once from the statically sorted catalogue, so the
 * result is deterministic for a given coolprop-wasm build.
 */
import {
  FLUID_CATALOGUE,
  FLUID_CATALOGUE_COUNT,
  type FluidCatalogueEntry,
  type FluidTransportFlag,
  type HeosFluidName,
} from "./generated/fluidCatalogue";

export { FLUID_CATALOGUE, FLUID_CATALOGUE_COUNT };
export type { FluidCatalogueEntry, FluidTransportFlag, HeosFluidName };

/** Canonical-name → entry. Insertion order is the (sorted) catalogue order. */
const BY_NAME: ReadonlyMap<string, FluidCatalogueEntry> = new Map(
  FLUID_CATALOGUE.map((e) => [e.name, e]),
);

function buildAliasIndex(): ReadonlyMap<string, HeosFluidName> {
  // Exact-match index over canonical names + aliases.  A key that would map
  // to two different canonical names is AMBIGUOUS and excluded entirely
  // (deterministic: the catalogue is statically sorted, so first/second
  // occurrences are stable; we drop rather than first-win so no lookup ever
  // silently resolves to the wrong fluid).
  const index = new Map<string, HeosFluidName>();
  const ambiguous = new Set<string>();
  for (const entry of FLUID_CATALOGUE) {
    for (const key of [entry.name, ...entry.aliases]) {
      if (ambiguous.has(key)) continue;
      const existing = index.get(key);
      if (existing === undefined) {
        index.set(key, entry.name as HeosFluidName);
      } else if (existing !== entry.name) {
        index.delete(key);
        ambiguous.add(key);
      }
    }
  }
  return index;
}

function buildCaseInsensitiveIndex(): ReadonlyMap<string, HeosFluidName> {
  // Lower-cased form of the exact index; lower-cased collisions across
  // different canonical names are excluded (same ambiguity policy).
  const index = new Map<string, HeosFluidName>();
  const ambiguous = new Set<string>();
  for (const [key, canonical] of ALIAS_INDEX) {
    const lower = key.toLowerCase();
    if (ambiguous.has(lower)) continue;
    const existing = index.get(lower);
    if (existing === undefined) {
      index.set(lower, canonical);
    } else if (existing !== canonical) {
      index.delete(lower);
      ambiguous.add(lower);
    }
  }
  return index;
}

const ALIAS_INDEX: ReadonlyMap<string, HeosFluidName> = buildAliasIndex();
const CASE_INSENSITIVE_INDEX: ReadonlyMap<string, HeosFluidName> =
  buildCaseInsensitiveIndex();

/**
 * Resolve a user/config-supplied fluid string to a canonical HEOS name, or
 * undefined when it is not (unambiguously) a catalogue fluid.  Trims leading
 * and trailing whitespace only — no other normalization.
 */
export function canonicalizeFluidName(
  input: string,
): HeosFluidName | undefined {
  const name = input.trim();
  if (name.length === 0) return undefined;
  const exact = ALIAS_INDEX.get(name);
  if (exact !== undefined) return exact;
  return CASE_INSENSITIVE_INDEX.get(name.toLowerCase());
}

/** True when `input` resolves (canonically or via alias) to a catalogue fluid. */
export function isCatalogueFluid(input: string): boolean {
  return canonicalizeFluidName(input) !== undefined;
}

/** Look up the catalogue entry for a CANONICAL name (no alias resolution). */
export function getFluidCatalogueEntry(
  name: string,
): FluidCatalogueEntry | undefined {
  return BY_NAME.get(name);
}

/**
 * True when the fluid has a confirmed viscosity model ('yes').  'no' and
 * 'unknown' both return false: validation treats unconfirmed transport as
 * absent so the solver never silently runs with zero viscosity.
 */
export function fluidHasViscosityModel(canonicalName: string): boolean {
  return BY_NAME.get(canonicalName)?.transport.viscosity === "yes";
}

/** True when the fluid has a confirmed thermal-conductivity model. */
export function fluidHasConductivityModel(canonicalName: string): boolean {
  return BY_NAME.get(canonicalName)?.transport.conductivity === "yes";
}

/**
 * Curated, solver-tested favorites — shown first in the UI picker and
 * grandfathered through the no-transport validation gate.  This is the
 * historical 9-fluid allowlist, kept as a backward-compatible export;
 * validation now accepts every canonical catalogue name (see validate.ts).
 *
 * NOTE: NitrousOxide is the one favorite WITHOUT a CoolProp transport model —
 * it is retained for backward compatibility (existing N2O networks solve in
 * the inviscid limit; see realFluid.ts) and is the only fluid for which the
 * no-viscosity validation error is waived.
 */
export const CURATED_REAL_FLUIDS = [
  "Nitrogen",
  "Oxygen",
  "Hydrogen",
  "ParaHydrogen",
  "Helium",
  "Methane",
  "CarbonDioxide",
  "Water",
  "NitrousOxide",
] as const satisfies readonly HeosFluidName[];

const CURATED_SET: ReadonlySet<string> = new Set(CURATED_REAL_FLUIDS);

export function isCuratedRealFluid(canonicalName: string): boolean {
  return CURATED_SET.has(canonicalName);
}
