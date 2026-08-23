/**
 * Branch (fluid-network edge) validation: id uniqueness, endpoint
 * reference/type checks (via core/topology.ts), same-fluid coupling, and
 * per-component-type parameter ranges (one `else if` arm per
 * core/components.ts component).
 */
import type { ResolvedNetworkConfig } from "../schema";
import type { TopologyModel } from "../topology";
import { isFluidNode } from "../topology";
import { resolveFluidSpec, resolvedFluidName } from "../fluidAssignment";
import { junctionInletBranchNodes } from "./junctions";

export interface BranchValidationResult {
  errors: string[];
  branchIds: Set<string>;
}

export function validateBranches(
  config: ResolvedNetworkConfig,
  topology: TopologyModel,
): BranchValidationResult {
  const errors: string[] = [];
  if (!config.branches || config.branches.length === 0) {
    errors.push("No branches defined");
  }

  // Reacting-junction inlet branches (branch id → junction node id) are the
  // ONE exception to the same-fluid rule below: a reactant stream may end at
  // an unlike-fluid junction node (validate/junctions.ts checks the rest).
  const junctionInlets = junctionInletBranchNodes(config);

  const branchIds = new Set<string>();
  for (const branch of config.branches ?? []) {
    if (branchIds.has(branch.id)) {
      errors.push(`Duplicate branch id: ${branch.id}`);
    }
    branchIds.add(branch.id);

    if (!isFluidNode(topology, branch.from)) {
      errors.push(
        `Branch ${branch.id} references missing node: ${branch.from}`,
      );
    }
    if (!isFluidNode(topology, branch.to)) {
      errors.push(`Branch ${branch.id} references missing node: ${branch.to}`);
    }
    if (branch.from === branch.to) {
      errors.push(`Branch ${branch.id} must connect two different fluid nodes`);
    }

    const fromNode = config.nodes.find((n) => n.id === branch.from);
    const toNode = config.nodes.find((n) => n.id === branch.to);
    if (fromNode && toNode) {
      const fromKey = resolvedFluidName(fromNode) ?? "";
      const toKey = resolvedFluidName(toNode) ?? "";
      const isJunctionInlet = junctionInlets.get(branch.id) === branch.to;
      if (fromKey !== toKey && !isJunctionInlet) {
        errors.push(
          `Branch ${branch.id} connects different fluids ("${fromKey || "default"}" and "${toKey || "default"}"); unlike fluids may only couple through a solid wall or a reacting-junction inlet`,
        );
      }
    }
    const branchFluidModel = fromNode
      ? resolveFluidSpec(config, fromNode).model
      : config.fluid.model;

    const comp = branch.component;
    if (
      comp.type !== "pipe" &&
      Boolean((comp as unknown as { inertia?: unknown }).inertia)
    ) {
      errors.push(
        `Branch ${branch.id}: inertia is only supported for pipe components`,
      );
    }
    if (
      branch.initialMdot !== undefined &&
      (typeof branch.initialMdot !== "number" ||
        !Number.isFinite(branch.initialMdot))
    ) {
      errors.push(`Branch ${branch.id} initialMdot must be a finite number`);
    }
    if (comp.type === "pipe") {
      if (comp.length <= 0)
        errors.push(`Pipe ${branch.id} length must be positive`);
      if (comp.diameter <= 0)
        errors.push(`Pipe ${branch.id} diameter must be positive`);
      if (comp.roughness < 0)
        errors.push(`Pipe ${branch.id} roughness must be non-negative`);
      if (
        comp.frictionFactor !== undefined &&
        (typeof comp.frictionFactor !== "number" ||
          !Number.isFinite(comp.frictionFactor) ||
          comp.frictionFactor < 0)
      )
        errors.push(
          `Pipe ${branch.id} frictionFactor must be a non-negative finite number`,
        );
      if (
        comp.diameterOut !== undefined &&
        (typeof comp.diameterOut !== "number" ||
          !Number.isFinite(comp.diameterOut) ||
          comp.diameterOut <= 0)
      )
        errors.push(
          `Pipe ${branch.id} diameterOut must be a positive finite number`,
        );
    } else if (comp.type === "orifice") {
      // The compressible/incompressible closure is picked automatically
      // from the branch's fluid model at solve time (components/orifice.ts,
      // solver/kernel.ts) — there is no separate declared type to validate
      // against a required fluid model.
      if (comp.area <= 0)
        errors.push(`Orifice ${branch.id} area must be positive`);
      if (comp.cd <= 0) errors.push(`Orifice ${branch.id} cd must be positive`);
    } else if (comp.type === "cavitatingVenturi") {
      if (comp.throatArea <= 0)
        errors.push(
          `Cavitating venturi ${branch.id} throatArea must be positive`,
        );
      if (comp.cd <= 0)
        errors.push(`Cavitating venturi ${branch.id} cd must be positive`);
      if (branchFluidModel !== "realFluid") {
        errors.push(
          `Cavitating venturi ${branch.id} requires realFluid fluid model with saturation support`,
        );
      }
    } else if (comp.type === "resistance") {
      if (comp.k < 0)
        errors.push(`Resistance ${branch.id} k must be non-negative`);
      if (comp.area <= 0)
        errors.push(`Resistance ${branch.id} area must be positive`);
    } else if (comp.type === "valve") {
      if (comp.area <= 0)
        errors.push(`Valve ${branch.id} area must be positive`);
      if (comp.cd <= 0) errors.push(`Valve ${branch.id} cd must be positive`);
      if (comp.position < 0 || comp.position > 1)
        errors.push(`Valve ${branch.id} position must be in [0,1]`);
      if (comp.positionSchedule && comp.positionSchedule.length > 1) {
        for (let i = 0; i < comp.positionSchedule.length - 1; i++) {
          if (comp.positionSchedule[i + 1][0] < comp.positionSchedule[i][0]) {
            errors.push(
              `Valve ${branch.id} positionSchedule times must be non-decreasing`,
            );
            break;
          }
        }
        for (const [, pos] of comp.positionSchedule) {
          if (pos < 0 || pos > 1) {
            errors.push(
              `Valve ${branch.id} positionSchedule values must be in [0,1]`,
            );
            break;
          }
        }
      }
    } else if (comp.type === "checkValve") {
      if (comp.area <= 0)
        errors.push(`Check valve ${branch.id} area must be positive`);
      if (comp.cd <= 0)
        errors.push(`Check valve ${branch.id} cd must be positive`);
    } else if (comp.type === "dynamicCheckValve") {
      if (comp.area <= 0)
        errors.push(`Dynamic check valve ${branch.id} area must be positive`);
      if (comp.cd <= 0)
        errors.push(`Dynamic check valve ${branch.id} cd must be positive`);
      if (comp.discArea !== undefined && comp.discArea <= 0)
        errors.push(
          `Dynamic check valve ${branch.id} discArea must be positive`,
        );
      if (!(comp.mass > 0))
        errors.push(`Dynamic check valve ${branch.id} mass must be positive`);
      if (!(comp.springRate > 0))
        errors.push(
          `Dynamic check valve ${branch.id} springRate must be positive`,
        );
      if (comp.preload < 0)
        errors.push(
          `Dynamic check valve ${branch.id} preload must be non-negative`,
        );
      if (comp.damping < 0)
        errors.push(
          `Dynamic check valve ${branch.id} damping must be non-negative`,
        );
      if (!(comp.stroke > 0))
        errors.push(`Dynamic check valve ${branch.id} stroke must be positive`);
      if (
        comp.initialPosition !== undefined &&
        (comp.initialPosition < 0 || comp.initialPosition > 1)
      )
        errors.push(
          `Dynamic check valve ${branch.id} initialPosition must be in [0,1]`,
        );
    } else if (comp.type === "reliefValve") {
      if (comp.area <= 0)
        errors.push(`Relief valve ${branch.id} area must be positive`);
      if (comp.cd <= 0)
        errors.push(`Relief valve ${branch.id} cd must be positive`);
      if (comp.crackPressure < 0)
        errors.push(
          `Relief valve ${branch.id} crackPressure must be non-negative`,
        );
      if (comp.fullOpenPressure <= comp.crackPressure)
        errors.push(
          `Relief valve ${branch.id} fullOpenPressure must exceed crackPressure`,
        );
    } else if (comp.type === "pump") {
      if (!Array.isArray(comp.curve) || comp.curve.length === 0) {
        errors.push(
          `Pump ${branch.id} curve must be a non-empty array of [flow, rise] points`,
        );
      } else {
        for (let i = 0; i < comp.curve.length - 1; i++) {
          if (comp.curve[i + 1][1] > comp.curve[i][1]) {
            errors.push(
              `Pump ${branch.id} curve must have monotonically decreasing rise`,
            );
            break;
          }
        }
        // Pump.interpolate assumes flow points sorted ascending (segment
        // scan + end-slope extrapolation are both wrong on unsorted input).
        for (let i = 0; i < comp.curve.length - 1; i++) {
          if (comp.curve[i + 1][0] <= comp.curve[i][0]) {
            errors.push(
              `Pump ${branch.id} curve flow points must be strictly increasing`,
            );
            break;
          }
        }
      }
    } else if (comp.type === "bend") {
      if (comp.diameter <= 0)
        errors.push(`Bend ${branch.id} diameter must be positive`);
      if (comp.angle <= 0 || comp.angle > 180)
        errors.push(`Bend ${branch.id} angle must be in (0,180]`);
      if (comp.rOverD < 0)
        errors.push(`Bend ${branch.id} rOverD must be non-negative`);
      if (comp.roughness !== undefined && comp.roughness < 0)
        errors.push(`Bend ${branch.id} roughness must be non-negative`);
    } else if (comp.type === "areaChange") {
      if (comp.areaIn <= 0)
        errors.push(`Area change ${branch.id} areaIn must be positive`);
      if (comp.areaOut <= 0)
        errors.push(`Area change ${branch.id} areaOut must be positive`);
    } else if (comp.type === "flowSource") {
      if (comp.massFlowSchedule && comp.massFlowSchedule.length > 1) {
        for (let i = 0; i < comp.massFlowSchedule.length - 1; i++) {
          if (comp.massFlowSchedule[i + 1][0] < comp.massFlowSchedule[i][0]) {
            errors.push(
              `Flow source ${branch.id} massFlowSchedule times must be non-decreasing`,
            );
            break;
          }
        }
      }
    } else if (comp.type === "regulator") {
      if (comp.maxCdA <= 0)
        errors.push(`Regulator ${branch.id} maxCdA must be positive`);
      if (comp.setPressure <= 0)
        errors.push(`Regulator ${branch.id} setPressure must be positive`);
    } else if (comp.type === "heatedPipe") {
      if (comp.length <= 0)
        errors.push(`Heated pipe ${branch.id} length must be positive`);
      if (comp.diameter <= 0)
        errors.push(`Heated pipe ${branch.id} diameter must be positive`);
      if (comp.roughness < 0)
        errors.push(`Heated pipe ${branch.id} roughness must be non-negative`);
      if (comp.ua < 0)
        errors.push(`Heated pipe ${branch.id} ua must be non-negative`);
    } else if (comp.type === "dpTable") {
      if (!Array.isArray(comp.points) || comp.points.length < 2) {
        errors.push(
          `DpTable ${branch.id} points must be an array of at least 2 [mdot, dP] points`,
        );
      } else {
        let bad = false;
        for (const [m, d] of comp.points) {
          if (!Number.isFinite(m) || !Number.isFinite(d)) {
            errors.push(`DpTable ${branch.id} points must be finite numbers`);
            bad = true;
            break;
          }
        }
        if (!bad) {
          for (let i = 0; i < comp.points.length - 1; i++) {
            if (comp.points[i + 1][0] <= comp.points[i][0]) {
              errors.push(
                `DpTable ${branch.id} point mdot values must be strictly increasing`,
              );
              break;
            }
          }
        }
      }
      if (
        comp.extrapolate !== undefined &&
        comp.extrapolate !== "clamp" &&
        comp.extrapolate !== "linear"
      ) {
        errors.push(
          `DpTable ${branch.id} extrapolate must be 'clamp' or 'linear'`,
        );
      }
    } else if (comp.type === "customResistance") {
      if (comp.area <= 0)
        errors.push(`Custom resistance ${branch.id} area must be positive`);
      if (typeof comp.k === "number") {
        if (!Number.isFinite(comp.k) || comp.k < 0) {
          errors.push(
            `Custom resistance ${branch.id} k must be a finite non-negative number`,
          );
        }
      } else if (
        comp.k &&
        typeof comp.k === "object" &&
        Array.isArray(comp.k.kTable)
      ) {
        const table = comp.k.kTable;
        if (table.length < 2) {
          errors.push(
            `Custom resistance ${branch.id} kTable must have at least 2 [Re, K] points`,
          );
        } else {
          for (const [re, kv] of table) {
            if (
              !Number.isFinite(re) ||
              re < 0 ||
              !Number.isFinite(kv) ||
              kv < 0
            ) {
              errors.push(
                `Custom resistance ${branch.id} kTable Re/K values must be finite and non-negative`,
              );
              break;
            }
          }
          for (let i = 0; i < table.length - 1; i++) {
            if (table[i + 1][0] <= table[i][0]) {
              errors.push(
                `Custom resistance ${branch.id} kTable Re values must be strictly increasing`,
              );
              break;
            }
          }
        }
        if (comp.diameter === undefined || !(comp.diameter > 0)) {
          errors.push(
            `Custom resistance ${branch.id} requires positive diameter when kTable is used (Re length scale)`,
          );
        }
      } else {
        errors.push(
          `Custom resistance ${branch.id} k must be a number or { kTable: [[Re, K], ...] }`,
        );
      }
      if (comp.diameter !== undefined && !(comp.diameter > 0)) {
        errors.push(
          `Custom resistance ${branch.id} diameter must be positive if provided`,
        );
      }
    } else if (comp.type === "userComponent") {
      if (typeof comp.component !== "string" || comp.component.length === 0) {
        errors.push(
          `User component ${branch.id} component (library name) must be a non-empty string`,
        );
      } else if (
        !config.componentLibrary ||
        !Object.hasOwn(config.componentLibrary, comp.component)
      ) {
        // Object.hasOwn (not `in`): prototype members such as "toString" or
        // "constructor" must not resolve as library entries.
        errors.push(
          `User component ${branch.id} references unknown componentLibrary entry: ${comp.component}`,
        );
      }
      if (comp.area !== undefined && !(comp.area > 0)) {
        errors.push(
          `User component ${branch.id} area must be positive if provided`,
        );
      }
      if (comp.params !== undefined) {
        for (const [key, value] of Object.entries(comp.params)) {
          if (typeof value !== "number" || !Number.isFinite(value)) {
            errors.push(
              `User component ${branch.id} param "${key}" must be a finite number`,
            );
          }
        }
      }
    } else {
      // Component type not in the known union — reject explicitly instead of
      // silently skipping all component checks.
      errors.push(
        `Branch ${branch.id} has unknown component type: ${JSON.stringify((comp as { type?: unknown }).type)}`,
      );
    }
  }

  return { errors, branchIds };
}
