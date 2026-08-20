/**
 * Solid/ambient node validation — shares the id namespace with fluid nodes
 * (checked against `nodeIds` from ./nodes.ts).
 */
import type { ResolvedNetworkConfig } from "../schema";
import { validateSolidPropertySpec, isTimeTableSpec } from "../solidProperties";

export interface SolidNodeValidationResult {
  errors: string[];
  solidNodeIds: Set<string>;
  ambientIds: Set<string>;
}

export function validateSolidNodes(
  config: ResolvedNetworkConfig,
  nodeIds: Set<string>,
  groupIds: Set<string>,
): SolidNodeValidationResult {
  const errors: string[] = [];
  const solidNodeIds = new Set<string>();
  const ambientIds = new Set<string>();
  for (const sNode of config.solidNodes ?? []) {
    if (nodeIds.has(sNode.id) || solidNodeIds.has(sNode.id)) {
      errors.push(`Duplicate node id: ${sNode.id}`);
    }
    solidNodeIds.add(sNode.id);
    if (sNode.group !== undefined && !groupIds.has(sNode.group)) {
      errors.push(
        `Solid node ${sNode.id} references unknown group: ${sNode.group}`,
      );
    }
    if (sNode.type === "ambient") {
      ambientIds.add(sNode.id);
      if (sNode.temperature === undefined) {
        errors.push(`Ambient node ${sNode.id} missing temperature`);
      }
      if (sNode.temperatureSchedule && sNode.temperatureSchedule.length > 1) {
        for (let i = 0; i < sNode.temperatureSchedule.length - 1; i++) {
          if (
            sNode.temperatureSchedule[i + 1][0] <
            sNode.temperatureSchedule[i][0]
          ) {
            errors.push(
              `Ambient node ${sNode.id} temperatureSchedule times must be non-decreasing`,
            );
            break;
          }
        }
      }
    }
    if (sNode.type === "solid") {
      if (config.settings.mode === "transient") {
        if (sNode.mass === undefined || sNode.mass <= 0) {
          errors.push(
            `Solid node ${sNode.id} must have positive mass in transient mode`,
          );
        }
        if (
          sNode.cp === undefined ||
          (typeof sNode.cp === "number" && sNode.cp <= 0)
        ) {
          errors.push(
            `Solid node ${sNode.id} must have positive cp in transient mode`,
          );
        } else if (typeof sNode.cp !== "number") {
          errors.push(
            ...validateSolidPropertySpec(
              sNode.cp,
              "cp",
              `Solid node ${sNode.id}`,
            ),
          );
        }
      } else if (sNode.cp !== undefined && typeof sNode.cp !== "number") {
        errors.push(
          ...validateSolidPropertySpec(
            sNode.cp,
            "cp",
            `Solid node ${sNode.id}`,
          ),
        );
      }
      // Time-varying cp has no steady meaning — reject it explicitly (never
      // silently evaluate at t = 0).
      if (config.settings.mode !== "transient" && isTimeTableSpec(sNode.cp)) {
        errors.push(
          `Solid node ${sNode.id}: cp timeTable is only supported in transient mode (a time-varying property has no steady-state meaning)`,
        );
      }
    }
  }

  return { errors, solidNodeIds, ambientIds };
}
