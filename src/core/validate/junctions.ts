/**
 * Reacting-junction validation (core/schema.ts JunctionConfig): reference /
 * type / fluid checks for the junction energy closure the Newton kernel
 * installs (core/solver/kernel.ts).  The closure replaces a coupled-h
 * energy row, which requires settings.kineticEnergy — steady always solves
 * that coupled system, and transient does too for the junction's product
 * fluid (idealGas is required below), so both modes are supported (see
 * docs/combustion.md).  A transient junction's energy closure stays
 * algebraic/quasi-steady even though the row is now reached every implicit
 * step — see the comment at the junction block in core/solver/kernel.ts.
 */
import type { ResolvedNetworkConfig } from "../schema";
import { resolveFluidSpec, resolvedFluidName } from "../fluidAssignment";
import { listCombustionPropellants } from "../combustion/combustionGas";

export interface JunctionValidationIds {
  nodeIds: Set<string>;
  boundaryIds: Set<string>;
  branchIds: Set<string>;
}

const KNOWN_PROPELLANTS = new Set<string>(listCombustionPropellants());

/** Roles each model type requires at least one inlet branch for. */
const REQUIRED_ROLES: Record<string, readonly string[]> = {
  ceaTable: ["oxidizer", "fuel"],
};

export function validateJunctions(
  config: ResolvedNetworkConfig,
  ids: JunctionValidationIds,
): string[] {
  const errors: string[] = [];
  if (config.junctions === undefined || config.junctions.length === 0) {
    return errors;
  }

  const { nodeIds, boundaryIds, branchIds } = ids;

  if (config.settings?.kineticEnergy !== true) {
    errors.push(
      "Junctions require settings.kineticEnergy (the junction closure replaces a coupled-enthalpy energy row, which exists only in that system)",
    );
  }
  if (config.species && config.species.names.length > 0) {
    errors.push(
      "Junctions cannot be combined with species transport (species networks use the segregated energy path, which carries no junction closure row)",
    );
  }

  const branchById = new Map((config.branches ?? []).map((b) => [b.id, b]));
  const nodeById = new Map(config.nodes.map((n) => [n.id, n]));
  const finiteNumber = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v);

  const junctionIds = new Set<string>();
  const junctionNodes = new Map<string, string>();
  const claimedInletBranches = new Map<string, string>();

  for (const junction of config.junctions) {
    if (junctionIds.has(junction.id)) {
      errors.push(`Duplicate junction id: ${junction.id}`);
    }
    junctionIds.add(junction.id);
    const jid = junction.id;

    // -- Junction node: existence, kind, product fluid ------------------
    const node = nodeById.get(junction.node);
    if (!nodeIds.has(junction.node)) {
      errors.push(`Junction ${jid} references missing node: ${junction.node}`);
    } else if (boundaryIds.has(junction.node)) {
      errors.push(`Junction ${jid} node "${junction.node}" must be internal`);
    } else {
      const owner = junctionNodes.get(junction.node);
      if (owner) {
        errors.push(
          `Junctions "${owner}" and "${jid}" both claim node "${junction.node}" (one junction per node)`,
        );
      } else {
        junctionNodes.set(junction.node, jid);
      }
    }

    if (
      typeof junction.productFluid !== "string" ||
      junction.productFluid.length === 0
    ) {
      errors.push(`Junction ${jid} productFluid must be a non-empty string`);
    } else if (!config.fluids?.[junction.productFluid]) {
      errors.push(
        `Junction ${jid} productFluid references unknown fluid "${junction.productFluid}" (must be a named entry in fluids — the solver swaps its params between outer iterations)`,
      );
    } else if (config.fluids[junction.productFluid].model !== "idealGas") {
      errors.push(
        `Junction ${jid} productFluid "${junction.productFluid}" model must be "idealGas" (got "${config.fluids[junction.productFluid].model}")`,
      );
    }
    if (node) {
      const nodeFluidName = resolvedFluidName(node);
      if (nodeFluidName !== junction.productFluid) {
        errors.push(
          `Junction ${jid} node "${node.id}" fluid ("${nodeFluidName ?? "<default>"}") must match productFluid ("${junction.productFluid}")`,
        );
      }
      const model = resolveFluidSpec(config, node).model;
      if (model !== "idealGas") {
        errors.push(
          `Junction ${jid} node "${node.id}" fluid model must be "idealGas" (got "${model}")`,
        );
      }
    }

    // -- Inlets: existence, orientation, uniqueness ----------------------
    if (!Array.isArray(junction.inlets) || junction.inlets.length === 0) {
      errors.push(`Junction ${jid} must declare at least one inlet`);
    }
    const rolesSeen = new Set<string>();
    for (const inlet of junction.inlets ?? []) {
      if (typeof inlet.role !== "string" || inlet.role.length === 0) {
        errors.push(`Junction ${jid} inlet role must be a non-empty string`);
      } else {
        rolesSeen.add(inlet.role);
      }
      if (!branchIds.has(inlet.branch)) {
        errors.push(
          `Junction ${jid} inlet references missing branch: ${inlet.branch}`,
        );
        continue;
      }
      const owner = claimedInletBranches.get(inlet.branch);
      if (owner) {
        errors.push(
          `Branch "${inlet.branch}" is claimed as an inlet by junctions "${owner}" and "${jid}" (or twice by the same junction)`,
        );
      } else {
        claimedInletBranches.set(inlet.branch, jid);
      }
      const branch = branchById.get(inlet.branch)!;
      if (branch.to !== junction.node) {
        errors.push(
          `Junction ${jid} inlet branch "${inlet.branch}" must END at the junction node "${junction.node}" (its "to" endpoint is "${branch.to}")`,
        );
      }
    }

    // -- Model: type, propellants, roles, efficiency ---------------------
    const modelType = junction.model?.type;
    const requiredRoles = REQUIRED_ROLES[modelType as string];
    if (requiredRoles === undefined) {
      errors.push(
        `Junction ${jid} model.type must be "ceaTable" (got ${JSON.stringify(modelType)})`,
      );
    } else {
      for (const role of requiredRoles) {
        if (!rolesSeen.has(role)) {
          errors.push(
            `Junction ${jid} model "${modelType}" requires an inlet with role "${role}"`,
          );
        }
      }
      for (const role of rolesSeen) {
        if (!requiredRoles.includes(role)) {
          errors.push(
            `Junction ${jid} inlet role "${role}" is not consumed by model "${modelType}" (expected: ${requiredRoles.join(", ")})`,
          );
        }
      }
    }
    if (
      typeof junction.model?.propellants !== "string" ||
      !KNOWN_PROPELLANTS.has(junction.model.propellants)
    ) {
      errors.push(
        `Junction ${jid} model.propellants must be one of: ${[...KNOWN_PROPELLANTS].join(", ")} (got ${JSON.stringify(junction.model?.propellants)})`,
      );
    }
    const eff = junction.model?.efficiency;
    if (eff !== undefined && (!finiteNumber(eff) || eff <= 0 || eff > 1)) {
      errors.push(
        `Junction ${jid} model.efficiency must be a finite number in (0, 1]`,
      );
    }

    // -- Outflow path: the mass balance Σṁ = 0 needs a product stream ----
    if (nodeIds.has(junction.node)) {
      const inletBranchIds = new Set(
        (junction.inlets ?? []).map((i) => i.branch),
      );
      const hasOutflowBranch = (config.branches ?? []).some(
        (b) =>
          !inletBranchIds.has(b.id) &&
          (b.from === junction.node || b.to === junction.node),
      );
      if (!hasOutflowBranch) {
        errors.push(
          `Junction ${jid} node "${junction.node}" has no product-stream branch (every attached branch is a declared inlet — the mass balance cannot close)`,
        );
      }
    }
  }

  return errors;
}

/**
 * Map of inlet-branch id → junction node id, for the unlike-fluid exception
 * in validate/branches.ts: a branch may connect two unlike fluids iff it is
 * a declared junction inlet ending at that junction's node.
 */
export function junctionInletBranchNodes(
  config: Pick<ResolvedNetworkConfig, "junctions">,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const junction of config.junctions ?? []) {
    for (const inlet of junction.inlets ?? []) {
      out.set(inlet.branch, junction.node);
    }
  }
  return out;
}
