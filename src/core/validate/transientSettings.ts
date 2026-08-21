/**
 * `settings.mode === 'transient'` requirements: `dt`/`endTime` for fixed
 * stepping, or the `adaptive` block (dtMin/dtMax/relTol/dtInitial) plus
 * `endTime` for adaptive stepping.
 */
import type { ResolvedNetworkConfig } from "../schema";

export function validateTransientSettings(
  config: ResolvedNetworkConfig,
): string[] {
  const errors: string[] = [];
  if (config.settings.mode !== "transient") return errors;

  const isAdaptive = config.settings.timeStepping === "adaptive";
  if (isAdaptive) {
    const a = config.settings.adaptive;
    if (!a) {
      errors.push("Adaptive time stepping requires settings.adaptive block");
    } else {
      if (a.dtMin === undefined || a.dtMin <= 0) {
        errors.push("settings.adaptive.dtMin must be positive");
      }
      if (a.dtMax === undefined || a.dtMax <= 0) {
        errors.push("settings.adaptive.dtMax must be positive");
      }
      if (a.dtMin !== undefined && a.dtMax !== undefined) {
        if (a.dtMin >= a.dtMax) {
          errors.push("settings.adaptive.dtMin must be less than dtMax");
        }
      }
      if (a.relTol === undefined || a.relTol <= 0) {
        errors.push("settings.adaptive.relTol must be positive");
      }
      if (a.dtInitial !== undefined && a.dtInitial <= 0) {
        errors.push("settings.adaptive.dtInitial must be positive");
      }
    }
    if (config.settings.endTime === undefined) {
      errors.push("Transient mode requires settings.endTime");
    } else if (config.settings.endTime <= 0) {
      errors.push("settings.endTime must be positive");
    }
  } else {
    if (config.settings.dt === undefined) {
      errors.push("Transient mode requires settings.dt");
    } else if (config.settings.dt <= 0) {
      errors.push("settings.dt must be positive");
    }
    if (config.settings.endTime === undefined) {
      errors.push("Transient mode requires settings.endTime");
    } else if (config.settings.endTime <= 0) {
      errors.push("settings.endTime must be positive");
    }
  }

  return errors;
}
