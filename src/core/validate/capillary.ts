/**
 * Capillary-channel validation: per-branch parameter ranges, and the
 * network-level wetting rules that keep the initial condition physical
 * (core/capillary.ts documents the model).
 */
import type { ResolvedNetworkConfig } from "../schema";
import { initialNodeWetness } from "../capillary";
import {
  DEFAULT_STOP_VALVE_EXPANSION,
  DEFAULT_SURFACE_TENSION,
  rectBurstPressure,
} from "../components/capillaryChannel";

type CapillaryConfig = Extract<
  ResolvedNetworkConfig["branches"][number]["component"],
  { type: "capillaryChannel" }
>;

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Parameter-range errors of one capillaryChannel branch. */
export function capillaryChannelParamErrors(
  id: string,
  c: CapillaryConfig,
): string[] {
  const errors: string[] = [];
  const name = `Capillary channel ${id}`;
  for (const f of ["width", "height", "length"] as const) {
    if (!(finite(c[f]) && c[f] > 0))
      errors.push(`${name} ${f} must be positive`);
  }
  if (!(finite(c.contactAngle) && c.contactAngle >= 0 && c.contactAngle <= 180))
    errors.push(`${name} contactAngle must be in [0, 180] degrees`);
  for (const f of [
    "contactAngleTop",
    "contactAngleBottom",
    "contactAngleSides",
  ] as const) {
    const v = c[f];
    if (v !== undefined && !(finite(v) && v >= 0 && v <= 180))
      errors.push(`${name} ${f} must be in [0, 180] degrees`);
  }
  if (
    c.surfaceTension !== undefined &&
    !(finite(c.surfaceTension) && c.surfaceTension >= 0)
  )
    errors.push(`${name} surfaceTension must be a non-negative number (N/m)`);
  if (c.capillaryPressure !== undefined && !finite(c.capillaryPressure))
    errors.push(`${name} capillaryPressure must be a finite number (Pa)`);
  if (
    c.gasViscosity !== undefined &&
    !(finite(c.gasViscosity) && c.gasViscosity > 0)
  )
    errors.push(`${name} gasViscosity must be positive`);
  if (
    c.initialFill !== undefined &&
    !(finite(c.initialFill) && c.initialFill >= 0 && c.initialFill <= 1)
  )
    errors.push(`${name} initialFill must be in [0, 1]`);
  if (
    c.initialFillFrom !== undefined &&
    c.initialFillFrom !== "from" &&
    c.initialFillFrom !== "to"
  )
    errors.push(`${name} initialFillFrom must be "from" or "to"`);
  if (c.elevationChange !== undefined && !finite(c.elevationChange))
    errors.push(`${name} elevationChange must be a finite number`);
  const sv = c.stopValve;
  if (sv !== undefined) {
    if (typeof sv !== "object" || sv === null) {
      errors.push(`${name} stopValve must be an object`);
    } else {
      if (sv.end !== undefined && sv.end !== "from" && sv.end !== "to")
        errors.push(`${name} stopValve.end must be "from" or "to"`);
      if (
        sv.expansionAngle !== undefined &&
        !(
          finite(sv.expansionAngle) &&
          sv.expansionAngle >= 0 &&
          sv.expansionAngle <= 180
        )
      )
        errors.push(`${name} stopValve.expansionAngle must be in [0, 180]`);
      if (
        sv.burstPressure !== undefined &&
        !(finite(sv.burstPressure) && sv.burstPressure > 0)
      )
        errors.push(`${name} stopValve.burstPressure must be positive (Pa)`);
      if (sv.burstPressure === undefined && errors.length === 0) {
        const burst = rectBurstPressure(
          c.width,
          c.height,
          c.surfaceTension ?? DEFAULT_SURFACE_TENSION,
          c.contactAngleTop ?? c.contactAngle,
          c.contactAngleBottom ?? c.contactAngle,
          c.contactAngleSides ?? c.contactAngle,
          sv.expansionAngle ?? DEFAULT_STOP_VALVE_EXPANSION,
        );
        if (!(burst > 0)) {
          errors.push(
            `${name} stopValve cannot hold a meniscus: its geometric burst pressure is ${burst.toFixed(1)} Pa (the wetting top/bottom walls out-pull the expanding sidewalls); use less wettable walls, a shallower channel relative to its width, or set stopValve.burstPressure`,
          );
        }
      }
    }
  }
  return errors;
}

/**
 * Network-level capillary rules:
 *  - `initiallyWet` is a boolean;
 *  - a dry node may only be touched by capillaryChannel branches (every
 *    other component assumes liquid throughout);
 *  - the initial liquid column of each channel starts at a wet node, and
 *    no channel starts with gas enclosed between two wet ends.
 */
export function validateCapillaryNetwork(
  config: ResolvedNetworkConfig,
): string[] {
  const errors: string[] = [];
  for (const n of config.nodes) {
    if (n.initiallyWet !== undefined && typeof n.initiallyWet !== "boolean")
      errors.push(`Node ${n.id} initiallyWet must be true or false`);
  }
  const caps = config.branches.filter(
    (b) => b.component.type === "capillaryChannel",
  );
  if (caps.length === 0) return errors;

  const wet = initialNodeWetness(config);
  for (const b of config.branches) {
    if (b.component.type === "capillaryChannel") continue;
    for (const n of [b.from, b.to]) {
      if (wet.get(n) === false) {
        errors.push(
          `Node ${n} starts dry (initiallyWet: false) but branch ${b.id} (${b.component.type}) is not a capillaryChannel; only capillary channels can hold gas`,
        );
      }
    }
  }

  for (const b of caps) {
    const c = b.component as CapillaryConfig;
    const fill = c.initialFill ?? 0;
    if (!finite(fill)) continue; // reported by the parameter checks
    const fillEndNode =
      (c.initialFillFrom ?? "from") === "from" ? b.from : b.to;
    const otherNode = fillEndNode === b.from ? b.to : b.from;
    const fillEndWet = wet.get(fillEndNode) === true;
    const otherWet = wet.get(otherNode) === true;
    if (fill > 0 && !fillEndWet) {
      errors.push(
        `Capillary channel ${b.id} starts ${Math.round(fill * 100)}% filled from node ${fillEndNode}, which is dry; set initiallyWet: true on ${fillEndNode} or change initialFillFrom`,
      );
    } else if (fill > 0 && fill < 1 && otherWet) {
      errors.push(
        `Capillary channel ${b.id} starts partly filled with both end nodes wet, enclosing gas; make ${otherNode} dry or set initialFill to 0 or 1`,
      );
    } else if (fill === 0 && fillEndWet && otherWet) {
      errors.push(
        `Capillary channel ${b.id} starts empty between two wet nodes (${b.from}, ${b.to}), enclosing gas; set initialFill: 1 for a primed channel or make one end dry`,
      );
    }
  }
  return errors;
}
