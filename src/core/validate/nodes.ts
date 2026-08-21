/**
 * Fluid-node validation: groups, notes, id uniqueness, boundary-condition
 * completeness, and internal-node transient/gasCushion requirements.
 * Returns the id sets later sections need (solid-node id-collision checks,
 * branch/conductor/controller reference checks).
 */
import type { ResolvedNetworkConfig } from "../schema";
import { resolveFluidSpec } from "../fluidAssignment";

export interface NodeValidationResult {
  errors: string[];
  nodeIds: Set<string>;
  boundaryIds: Set<string>;
  groupIds: Set<string>;
}

export function validateNodes(
  config: ResolvedNetworkConfig,
): NodeValidationResult {
  const errors: string[] = [];
  const nodeIds = new Set<string>();
  const boundaryIds = new Set<string>();
  const groupIds = new Set<string>();
  for (const g of config.groups ?? []) {
    if (groupIds.has(g.id)) {
      errors.push(`Duplicate group id: ${g.id}`);
    }
    groupIds.add(g.id);
  }
  // Notes are annotations, not model elements: the only thing that can be
  // wrong with one is an id collision (which would break the canvas and the
  // text projection's line map) or a dangling subnetwork reference.
  const noteIds = new Set<string>();
  for (const note of config.notes ?? []) {
    if (noteIds.has(note.id)) {
      errors.push(`Duplicate note id: ${note.id}`);
    }
    noteIds.add(note.id);
    if (note.group !== undefined && !groupIds.has(note.group)) {
      errors.push(`Note ${note.id} references unknown group: ${note.group}`);
    }
  }
  for (const node of config.nodes) {
    if (nodeIds.has(node.id)) {
      errors.push(`Duplicate node id: ${node.id}`);
    }
    nodeIds.add(node.id);
    if (node.group !== undefined && !groupIds.has(node.group)) {
      errors.push(`Node ${node.id} references unknown group: ${node.group}`);
    }
    if (node.fluid !== undefined) {
      if (typeof node.fluid !== "string" || node.fluid.length === 0) {
        errors.push(
          `Node ${node.id}: fluid must be a non-empty name from the fluids map`,
        );
      } else if (!config.fluids?.[node.fluid]) {
        errors.push(`Node ${node.id} references unknown fluid "${node.fluid}"`);
      }
    }
    const nodeFluidModel = resolveFluidSpec(config, node).model;
    if (node.type === "boundary") {
      boundaryIds.add(node.id);
      if (node.pressure === undefined) {
        errors.push(`Boundary node ${node.id} missing pressure`);
      }
      if (node.temperature === undefined && node.quality === undefined) {
        errors.push(`Boundary node ${node.id} missing temperature or quality`);
      }
      if (node.temperature !== undefined && node.quality !== undefined) {
        errors.push(
          `Boundary node ${node.id}: temperature and quality are mutually exclusive`,
        );
      }
      if (node.quality !== undefined && nodeFluidModel !== "realFluid") {
        errors.push(
          `Boundary node ${node.id}: quality is only supported for realFluid`,
        );
      }
      if (node.pressureSchedule && node.pressureSchedule.length > 1) {
        for (let i = 0; i < node.pressureSchedule.length - 1; i++) {
          if (node.pressureSchedule[i + 1][0] < node.pressureSchedule[i][0]) {
            errors.push(
              `Boundary node ${node.id} pressureSchedule times must be non-decreasing`,
            );
            break;
          }
        }
      }
      if (node.temperatureSchedule && node.temperatureSchedule.length > 1) {
        for (let i = 0; i < node.temperatureSchedule.length - 1; i++) {
          if (
            node.temperatureSchedule[i + 1][0] < node.temperatureSchedule[i][0]
          ) {
            errors.push(
              `Boundary node ${node.id} temperatureSchedule times must be non-decreasing`,
            );
            break;
          }
        }
      }
      if (node.fluidFrontInlet !== undefined) {
        const v = node.fluidFrontInlet;
        if (!(
          typeof v === "number" &&
          Number.isFinite(v) &&
          v >= 0 &&
          v <= 1
        )) {
          errors.push(
            `Boundary node ${node.id} fluidFrontInlet must be in [0,1] (got ${v})`,
          );
        }
      }
    }
    if (node.type === "internal") {
      if (node.quality !== undefined && nodeFluidModel !== "realFluid") {
        errors.push(
          `Internal node ${node.id}: quality is only supported for realFluid`,
        );
      }
      if (node.temperature !== undefined && node.quality !== undefined) {
        errors.push(
          `Internal node ${node.id}: temperature and quality are mutually exclusive`,
        );
      }
      if (node.fluidFrontInlet !== undefined) {
        errors.push(
          `Internal node ${node.id}: fluidFrontInlet is only meaningful on boundary nodes (internal nodes carry the transported state)`,
        );
      }
      if (config.settings.mode === "transient") {
        if (node.volume === undefined || node.volume <= 0) {
          errors.push(
            `Internal node ${node.id} must have positive volume in transient mode`,
          );
        }
        if (node.pressure === undefined) {
          errors.push(
            `Internal node ${node.id} must have initial pressure in transient mode`,
          );
        }
        if (node.temperature === undefined && node.quality === undefined) {
          errors.push(
            `Internal node ${node.id} must have initial temperature or quality in transient mode`,
          );
        }
      }
      if (node.gasCushion) {
        if (config.settings.mode === "steady") {
          errors.push(
            `Node ${node.id}: gasCushion is only supported in transient mode`,
          );
        }
        if (
          nodeFluidModel !== "incompressible" &&
          nodeFluidModel !== "expandableLiquid"
        ) {
          errors.push(
            `Node ${node.id}: gasCushion requires incompressible or expandableLiquid fluid model`,
          );
        }
        if (node.gasCushion.initialGasVolume <= 0) {
          errors.push(
            `Node ${node.id}: gasCushion initialGasVolume must be positive`,
          );
        }
        if (
          node.volume !== undefined &&
          node.gasCushion.initialGasVolume >= node.volume
        ) {
          errors.push(
            `Node ${node.id}: gasCushion initialGasVolume must be less than node volume`,
          );
        }
      }
    }
  }

  return { errors, nodeIds, boundaryIds, groupIds };
}
