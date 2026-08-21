/**
 * Pure network-topology endpoint rules — the SINGLE SOURCE OF TRUTH for
 * "what may connect to what":
 *
 *   - fluid branches connect two DIFFERENT fluid nodes;
 *   - conduction/radiation conductors connect two thermal (solid/ambient)
 *     nodes;
 *   - convection conductors connect exactly one fluid node and one thermal
 *     node;
 *   - self-links are never allowed.
 *
 * The module is deliberately free of UI and full-config dependencies: it
 * operates on a minimal TopologyModel (two id sets) so both core validation
 * (core/validate.ts) and the UI adapters (ui/connectionRules.ts) share one
 * implementation.  Error strings are user-facing and part of the UI
 * contract — ui/tests/connectionRules.test.ts pins them.
 */

/** Thermal-conductor kinds (mirrors Conductor['type']['kind'] in schema.ts). */
export type ConductorKind = "conduction" | "convection" | "radiation";

/** All conductor kinds, in UI display order. */
export const CONDUCTOR_KINDS: readonly ConductorKind[] = [
  "conduction",
  "convection",
  "radiation",
];

/**
 * Minimal model shape the rules need: the set of fluid-node ids and the set
 * of thermal-node (solid/ambient) ids.  The two namespaces are disjoint in
 * any valid network (validate.ts enforces id uniqueness across both).
 */
export interface TopologyModel {
  readonly fluidNodeIds: ReadonlySet<string>;
  readonly thermalNodeIds: ReadonlySet<string>;
}

/** Build a TopologyModel from any id iterables (arrays, Sets, …). */
export function createTopologyModel(
  fluidNodeIds: Iterable<string>,
  thermalNodeIds: Iterable<string>,
): TopologyModel {
  return {
    fluidNodeIds: new Set(fluidNodeIds),
    thermalNodeIds: new Set(thermalNodeIds),
  };
}

export type EndpointClass = "fluid" | "thermal" | "missing";

/** Classify an endpoint id against the model. */
export function classifyEndpoint(
  model: TopologyModel,
  id: string,
): EndpointClass {
  if (model.fluidNodeIds.has(id)) return "fluid";
  if (model.thermalNodeIds.has(id)) return "thermal";
  return "missing";
}

export function isFluidNode(model: TopologyModel, id: string): boolean {
  return model.fluidNodeIds.has(id);
}

export function isThermalNode(model: TopologyModel, id: string): boolean {
  return model.thermalNodeIds.has(id);
}

/** Null when a fluid branch may connect `from` → `to`; otherwise the reason. */
export function fluidBranchEndpointError(
  model: TopologyModel,
  from: string,
  to: string,
): string | null {
  if (from === to) return "A fluid branch requires two different fluid nodes";
  if (!isFluidNode(model, from) || !isFluidNode(model, to)) {
    return "Fluid branches can connect only fluid nodes";
  }
  return null;
}

/** Null when a conductor of `kind` may connect `from` → `to`; otherwise the reason. */
export function conductorEndpointError(
  model: TopologyModel,
  kind: ConductorKind,
  from: string,
  to: string,
): string | null {
  if (from === to) return "A thermal conductor requires two different nodes";
  const fromFluid = isFluidNode(model, from);
  const toFluid = isFluidNode(model, to);
  const fromThermal = isThermalNode(model, from);
  const toThermal = isThermalNode(model, to);
  if (kind === "convection") {
    if (!((fromFluid && toThermal) || (toFluid && fromThermal))) {
      return "Convection requires exactly one fluid node and one solid or ambient node";
    }
    return null;
  }
  if (!(fromThermal && toThermal)) {
    return `${kind === "conduction" ? "Conduction" : "Radiation"} requires two solid or ambient nodes`;
  }
  return null;
}

/**
 * Ids that may serve as the OTHER endpoint of a `kind` conductor started at
 * `oppositeId`.  Iteration order: fluid ids first, then thermal ids (the
 * historical UI ordering).
 */
export function compatibleConductorNodeIds(
  model: TopologyModel,
  kind: ConductorKind,
  oppositeId: string,
): Set<string> {
  const ids: string[] = [];
  for (const id of [...model.fluidNodeIds, ...model.thermalNodeIds]) {
    if (
      id !== oppositeId &&
      conductorEndpointError(model, kind, oppositeId, id) === null
    ) {
      ids.push(id);
    }
  }
  return new Set(ids);
}

/** Conductor kinds allowed between two endpoints (subset, in CONDUCTOR_KINDS order). */
export function compatibleConductorKinds(
  model: TopologyModel,
  from: string,
  to: string,
): Set<ConductorKind> {
  return new Set(
    CONDUCTOR_KINDS.filter(
      (kind) => conductorEndpointError(model, kind, from, to) === null,
    ),
  );
}

/** May a fluid branch be started (or its endpoint dropped) on `id`? */
export function canStartFluidBranch(model: TopologyModel, id: string): boolean {
  return isFluidNode(model, id);
}

/** May a `kind` conductor be started (or its endpoint dropped) on `id`? */
export function canStartConductor(
  model: TopologyModel,
  kind: ConductorKind,
  id: string,
): boolean {
  if (kind === "convection")
    return isFluidNode(model, id) || isThermalNode(model, id);
  return isThermalNode(model, id);
}
