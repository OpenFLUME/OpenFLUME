/**
 * PID/register controller validation (core/controllerRuntime.ts): reference
 * / type / range checks and output-target collision detection. Transient
 * solves only in v1 — steady has no dt for the PID integral/derivative
 * terms.
 */
import type { ResolvedNetworkConfig } from "../schema";

export interface ControllerValidationIds {
  nodeIds: Set<string>;
  boundaryIds: Set<string>;
  branchIds: Set<string>;
  allNodeIds: Set<string>;
}

export function validateControllers(
  config: ResolvedNetworkConfig,
  ids: ControllerValidationIds,
): string[] {
  const errors: string[] = [];
  if (config.controllers === undefined) return errors;

  const { nodeIds, boundaryIds, branchIds, allNodeIds } = ids;

  if (config.controllers.length > 0 && config.settings?.mode !== "transient") {
    errors.push(
      'Controllers require settings.mode "transient" (steady solves do not support controllers)',
    );
  }
  const controllerIds = new Set<string>();
  const controllerTargets = new Map<string, string>();
  const branchById = new Map((config.branches ?? []).map((b) => [b.id, b]));
  const finiteNumber = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v);
  for (const ctrl of config.controllers) {
    if (controllerIds.has(ctrl.id)) {
      errors.push(`Duplicate controller id: ${ctrl.id}`);
    }
    controllerIds.add(ctrl.id);
    // Widen to string: runtime configs may carry types outside the union,
    // and narrowing `ctrl` itself would collapse it to `never` below.
    const ctrlType: string = ctrl.type;
    if (ctrlType !== "pid" && ctrlType !== "register") {
      errors.push(`Controller ${ctrl.id} type must be "pid" or "register"`);
    }
    const allowedOn = ctrl.type === "register" ? "stepStart" : "stepAccepted";
    if (ctrl.on !== undefined && ctrl.on !== allowedOn) {
      errors.push(
        `Controller ${ctrl.id} on must be '${allowedOn}' for type "${ctrl.type}"`,
      );
    }
    if (ctrl.type === "register") {
      if (typeof ctrl.register !== "string" || ctrl.register.length === 0) {
        errors.push(
          `Controller ${ctrl.id} register must be a non-empty string`,
        );
      }
    } else {
      // Sense reference + quantity.
      const sense = ctrl.sense;
      if (
        sense === undefined ||
        sense === null ||
        (sense.kind !== "node" && sense.kind !== "branch")
      ) {
        errors.push(
          `Controller ${ctrl.id} sense.kind must be 'node' or 'branch'`,
        );
      } else if (sense.kind === "node") {
        if (!nodeIds.has(sense.id)) {
          errors.push(
            `Controller ${ctrl.id} sense references missing node: ${sense.id}`,
          );
        }
        if (
          sense.quantity !== "pressure" &&
          sense.quantity !== "temperature" &&
          sense.quantity !== "density"
        ) {
          errors.push(
            `Controller ${ctrl.id} sense.quantity must be 'pressure', 'temperature' or 'density' for kind 'node'`,
          );
        }
      } else {
        if (!branchIds.has(sense.id)) {
          errors.push(
            `Controller ${ctrl.id} sense references missing branch: ${sense.id}`,
          );
        }
        if (sense.quantity !== "massFlow") {
          errors.push(
            `Controller ${ctrl.id} sense.quantity must be 'massFlow' for kind 'branch'`,
          );
        }
      }
      // Setpoint + gains.
      if (!finiteNumber(ctrl.setpoint)) {
        errors.push(`Controller ${ctrl.id} setpoint must be a finite number`);
      }
      for (const g of ["kp", "ki", "kd"] as const) {
        if (!finiteNumber(ctrl.gains?.[g])) {
          errors.push(
            `Controller ${ctrl.id} gains.${g} must be a finite number`,
          );
        }
      }
    }
    // Output target.
    const out = ctrl.output;
    if (out === undefined || out === null || typeof out.kind !== "string") {
      errors.push(`Controller ${ctrl.id} output.kind is required`);
    } else if (out.kind === "valvePosition") {
      const branch = branchById.get(out.id);
      if (!branch) {
        errors.push(
          `Controller ${ctrl.id} output references missing branch: ${out.id}`,
        );
      } else if (branch.component.type !== "valve") {
        errors.push(
          `Controller ${ctrl.id} output "${out.id}" must be a valve branch (got ${branch.component.type})`,
        );
      }
    } else if (out.kind === "flowRate") {
      const branch = branchById.get(out.id);
      if (!branch) {
        errors.push(
          `Controller ${ctrl.id} output references missing branch: ${out.id}`,
        );
      } else if (branch.component.type !== "flowSource") {
        errors.push(
          `Controller ${ctrl.id} output "${out.id}" must be a flowSource branch (got ${branch.component.type})`,
        );
      }
    } else if (
      out.kind === "boundaryPressure" ||
      out.kind === "boundaryTemperature"
    ) {
      if (!nodeIds.has(out.id)) {
        errors.push(
          `Controller ${ctrl.id} output references missing node: ${out.id}`,
        );
      } else if (!boundaryIds.has(out.id)) {
        errors.push(
          `Controller ${ctrl.id} output "${out.id}" must be a boundary node`,
        );
      }
    } else if (out.kind === "heatInput") {
      if (!allNodeIds.has(out.id)) {
        errors.push(
          `Controller ${ctrl.id} output references missing node: ${out.id}`,
        );
      } else {
        const fluidNode = config.nodes.find((node) => node.id === out.id);
        const solidNode = (config.solidNodes ?? []).find(
          (node) => node.id === out.id,
        );
        if (
          (fluidNode && fluidNode.type !== "internal") ||
          (solidNode && solidNode.type !== "solid")
        ) {
          errors.push(
            `Controller ${ctrl.id} heatInput output "${out.id}" must be an internal fluid node or finite-capacity solid node`,
          );
        }
      }
    } else {
      errors.push(
        `Controller ${ctrl.id} output.kind must be one of: valvePosition, flowRate, boundaryPressure, boundaryTemperature, heatInput`,
      );
    }
    if (out && typeof out.kind === "string" && typeof out.id === "string") {
      const targetKey = `${out.kind}:${out.id}`;
      const owner = controllerTargets.get(targetKey);
      if (owner)
        errors.push(
          `Controllers "${owner}" and "${ctrl.id}" both write output target "${targetKey}"`,
        );
      else controllerTargets.set(targetKey, ctrl.id);
    }
    // Optional ranges.
    if (ctrl.limits !== undefined) {
      if (!finiteNumber(ctrl.limits.min) || !finiteNumber(ctrl.limits.max)) {
        errors.push(
          `Controller ${ctrl.id} limits.min and limits.max must be finite numbers`,
        );
      } else if (ctrl.limits.min > ctrl.limits.max) {
        errors.push(`Controller ${ctrl.id} limits.min must be <= limits.max`);
      } else if (
        out?.kind === "valvePosition" &&
        (ctrl.limits.min < 0 || ctrl.limits.max > 1)
      ) {
        errors.push(
          `Controller ${ctrl.id} valvePosition limits must stay within [0,1]`,
        );
      } else if (
        (out?.kind === "boundaryPressure" ||
          out?.kind === "boundaryTemperature") &&
        ctrl.limits.min <= 0
      ) {
        errors.push(
          `Controller ${ctrl.id} ${out.kind} limits must remain positive`,
        );
      }
    }
    if (
      ctrl.type === "pid" &&
      ctrl.initialOutput !== undefined &&
      !finiteNumber(ctrl.initialOutput)
    ) {
      errors.push(
        `Controller ${ctrl.id} initialOutput must be a finite number`,
      );
    }
  }

  return errors;
}
