/**
 * Adaptive stepping's schedule "events": times an accepted step must land on
 * exactly, because a frozen per-step value (a schedule knot or a time-varying
 * property's slope) changes there. Collected once per solve, sorted, and
 * walked forward as `t` advances (see adaptiveStepping.ts).
 */
import type { ResolvedNetworkConfig } from "../schema";
import { isTimeTableSpec } from "../solidProperties";

export function collectScheduleBreakpoints(
  config: ResolvedNetworkConfig,
  endTime: number,
): number[] {
  const breakpoints = new Set<number>();
  breakpoints.add(endTime);
  for (const node of config.nodes) {
    if (node.pressureSchedule) {
      for (const [t] of node.pressureSchedule)
        if (t > 0 && t < endTime) breakpoints.add(t);
    }
    if (node.temperatureSchedule) {
      for (const [t] of node.temperatureSchedule)
        if (t > 0 && t < endTime) breakpoints.add(t);
    }
  }
  for (const sNode of config.solidNodes ?? []) {
    if (sNode.temperatureSchedule) {
      for (const [t] of sNode.temperatureSchedule)
        if (t > 0 && t < endTime) breakpoints.add(t);
    }
    // Time-varying cp knots are events: the frozen per-step value changes
    // slope there, so accepted steps must land exactly on them.
    if (isTimeTableSpec(sNode.cp)) {
      for (const [t] of sNode.cp.timeTable)
        if (t > 0 && t < endTime) breakpoints.add(t);
    }
  }
  for (const branch of config.branches) {
    const comp = branch.component;
    if (comp.type === "valve" && comp.positionSchedule) {
      for (const [t] of comp.positionSchedule)
        if (t > 0 && t < endTime) breakpoints.add(t);
    }
    if (comp.type === "flowSource" && comp.massFlowSchedule) {
      for (const [t] of comp.massFlowSchedule)
        if (t > 0 && t < endTime) breakpoints.add(t);
    }
  }
  for (const cond of config.conductors ?? []) {
    // Same event alignment for time-varying conduction k.
    if (cond.type.kind === "conduction" && isTimeTableSpec(cond.type.k)) {
      for (const [t] of cond.type.k.timeTable)
        if (t > 0 && t < endTime) breakpoints.add(t);
    }
  }
  return Array.from(breakpoints).sort((a, b) => a - b);
}
