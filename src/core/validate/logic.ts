/**
 * User-logic runtime shape checks (core/logicRuntime.ts): register initial
 * values must be finite numbers, and each LogicRule's `when`/`set` are
 * parse-checked (never executed) expressions.
 */
import type { ResolvedNetworkConfig } from "../schema";
import { checkExpression } from "./expressions";

const HOOK_EVENTS = new Set([
  "init",
  "stepStart",
  "stepAccepted",
  "stepRejected",
  "converged",
  "solveEnd",
]);

export function validateRegistersAndLogic(
  config: ResolvedNetworkConfig,
): string[] {
  const errors: string[] = [];

  if (config.registers !== undefined) {
    for (const [name, value] of Object.entries(config.registers)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`Register "${name}" must be a finite number`);
      }
    }
  }

  if (config.logic !== undefined) {
    const logicIds = new Set<string>();
    for (const rule of config.logic) {
      if (logicIds.has(rule.id)) {
        errors.push(`Duplicate logic rule id: ${rule.id}`);
      }
      logicIds.add(rule.id);
      if (rule.on !== undefined && !HOOK_EVENTS.has(rule.on)) {
        errors.push(
          `Logic rule ${rule.id} on must be one of: ${[...HOOK_EVENTS].join(", ")}`,
        );
      }
      if (rule.stop !== undefined && typeof rule.stop !== "boolean") {
        errors.push(`Logic rule ${rule.id} stop must be a boolean`);
      }
      if (rule.reason !== undefined && typeof rule.reason !== "string") {
        errors.push(`Logic rule ${rule.id} reason must be a string`);
      }
      const whenErr = checkExpression(rule.when, `Logic rule ${rule.id} when`);
      if (whenErr) errors.push(whenErr);
      for (const [reg, expr] of Object.entries(rule.set ?? {})) {
        const setErr = checkExpression(
          expr,
          `Logic rule ${rule.id} set "${reg}"`,
        );
        if (setErr) errors.push(setErr);
      }
    }
  }

  return errors;
}
