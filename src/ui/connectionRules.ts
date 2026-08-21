/**
 * Thin UI adapter over the pure topology rules in core/topology.ts — the
 * single source of truth for "what may connect to what" (fluid branches,
 * the conduction/convection/radiation endpoint matrix, self-links).  These
 * wrappers take the full NetworkConfig for call-site convenience; the API
 * and the user-facing error strings are unchanged.
 */
import type { NetworkConfig, ConductorKind, TopologyModel } from "../core";
import {
  createTopologyModel,
  fluidBranchEndpointError as topologyFluidBranchEndpointError,
  conductorEndpointError as topologyConductorEndpointError,
  compatibleConductorNodeIds as topologyCompatibleConductorNodeIds,
  compatibleConductorKinds as topologyCompatibleConductorKinds,
  canStartFluidBranch as topologyCanStartFluidBranch,
  canStartConductor as topologyCanStartConductor,
} from "../core";

export type { ConductorKind } from "../core";

function topologyOf(config: NetworkConfig): TopologyModel {
  return createTopologyModel(
    config.nodes.map((node) => node.id),
    (config.solidNodes ?? []).map((node) => node.id),
  );
}

export function fluidBranchEndpointError(
  config: NetworkConfig,
  from: string,
  to: string,
): string | null {
  return topologyFluidBranchEndpointError(topologyOf(config), from, to);
}

export function conductorEndpointError(
  config: NetworkConfig,
  kind: ConductorKind,
  from: string,
  to: string,
): string | null {
  return topologyConductorEndpointError(topologyOf(config), kind, from, to);
}

export function compatibleConductorNodeIds(
  config: NetworkConfig,
  kind: ConductorKind,
  oppositeId: string,
): Set<string> {
  return topologyCompatibleConductorNodeIds(
    topologyOf(config),
    kind,
    oppositeId,
  );
}

export function compatibleConductorKinds(
  config: NetworkConfig,
  from: string,
  to: string,
): Set<ConductorKind> {
  return topologyCompatibleConductorKinds(topologyOf(config), from, to);
}

export function canStartFluidBranch(
  config: NetworkConfig,
  id: string,
): boolean {
  return topologyCanStartFluidBranch(topologyOf(config), id);
}

export function canStartConductor(
  config: NetworkConfig,
  kind: ConductorKind,
  id: string,
): boolean {
  return topologyCanStartConductor(topologyOf(config), kind, id);
}
