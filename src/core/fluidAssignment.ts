/**
 * FluidAssignment answers "which fluid serves node/branch X".
 *
 * v1 (no `maps`) is SINGLE-FLUID-BACKED: the whole network shares the one
 * fluid built from config.fluid, so both lookups return that same instance
 * (identity — `assignment.branch(id) === ctx.fluid`).
 *
 * v2 (with `maps`) resolves per-node named fluids from config.fluids.
 * Branches inherit the fluid of their `from` node; validation requires the
 * `to` node to match, so the two ends never disagree.
 *
 * Unknown ids fail loudly (a lookup with an id outside the network is a
 * solver bug, not physics).
 */

import type { FluidModel } from "./fluids";
import type { FluidSpec, NetworkConfig } from "./schema";

export interface FluidAssignment {
  /** Fluid serving the given fluid node. */
  node(id: string): FluidModel;
  /** Fluid serving the given branch. */
  branch(id: string): FluidModel;
}

/** Optional per-node / per-branch maps for multi-fluid networks. */
export interface FluidAssignmentMaps {
  /** Named fluid models keyed by config.fluids name. */
  named: Map<string, FluidModel>;
  /** nodeId → named fluid key (absent → default). */
  nodeFluid: Map<string, string>;
  /** branchId → from-node id (used to resolve branch fluid). */
  branchFrom: Map<string, string>;
}

/**
 * Create a fluid assignment for a network.  `ids.nodes` / `ids.branches`
 * are the authoritative id sets (from the parsed config) and are used to
 * reject lookups with unknown ids.  Omit `maps` (or pass an empty named
 * map with no node refs) to keep the single-fluid identity behaviour.
 */
export function createFluidAssignment(
  fluid: FluidModel,
  ids: { nodes: Iterable<string>; branches: Iterable<string> },
  maps?: FluidAssignmentMaps,
): FluidAssignment {
  const nodeIds = new Set(ids.nodes);
  const branchIds = new Set(ids.branches);
  const named = maps?.named;
  const nodeFluid = maps?.nodeFluid;
  const branchFrom = maps?.branchFrom;

  const fluidForNode = (id: string): FluidModel => {
    const name = nodeFluid?.get(id);
    if (name && named?.has(name)) return named.get(name)!;
    return fluid;
  };

  return {
    node(id: string): FluidModel {
      if (!nodeIds.has(id))
        throw new Error(`FluidAssignment: unknown node "${id}"`);
      return fluidForNode(id);
    },
    branch(id: string): FluidModel {
      if (!branchIds.has(id))
        throw new Error(`FluidAssignment: unknown branch "${id}"`);
      const from = branchFrom?.get(id);
      if (from !== undefined) return fluidForNode(from);
      return fluid;
    },
  };
}

/** Named fluid key on a node, or undefined for the network default. */
export function resolvedFluidName(node: {
  fluid?: string;
}): string | undefined {
  const name = node.fluid;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * Fluid spec serving a node. Missing named refs fall back to the default
 * (validateNetwork reports the dangling name separately).
 */
export function resolveFluidSpec(
  config: Pick<NetworkConfig, "fluid" | "fluids">,
  node: { fluid?: string },
): FluidSpec {
  const name = resolvedFluidName(node);
  if (!name) return config.fluid;
  return config.fluids?.[name] ?? config.fluid;
}

/** Default plus every named extra, in map-iteration order. */
export function eachFluidSpec(
  config: Pick<NetworkConfig, "fluid" | "fluids">,
): Array<{ name: string | undefined; spec: FluidSpec }> {
  const out: Array<{ name: string | undefined; spec: FluidSpec }> = [
    { name: undefined, spec: config.fluid },
  ];
  if (config.fluids) {
    for (const [name, spec] of Object.entries(config.fluids)) {
      out.push({ name, spec });
    }
  }
  return out;
}

/** True when the config declares a named-fluids map or any node names a fluid. */
export function networkHasNamedFluidAssignment(
  config: Pick<NetworkConfig, "fluids" | "nodes">,
): boolean {
  if (config.fluids && Object.keys(config.fluids).length > 0) return true;
  return config.nodes.some((n) => resolvedFluidName(n) !== undefined);
}

/** True when the default or any named spec is a CoolProp real fluid. */
export function networkUsesRealFluid(
  config: Pick<NetworkConfig, "fluid" | "fluids">,
): boolean {
  if (config.fluid.model === "realFluid") return true;
  if (config.fluids) {
    for (const spec of Object.values(config.fluids)) {
      if (spec.model === "realFluid") return true;
    }
  }
  return false;
}
