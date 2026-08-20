import type { BranchComponent } from "./branchComponent";
import { interpolateSchedule } from "./branchComponent";

/** Flow source: imposes a specified mass flow rate regardless of ΔP. */
export class FlowSource implements BranchComponent {
  readonly massFlow: number;
  readonly massFlowSchedule?: Array<[number, number]>;
  readonly area = 1;
  readonly elevationChange = 0;
  /**
   * Mutable actuation override (core/controllerRuntime.ts): when set it
   * WINS over the base `massFlow` and any `massFlowSchedule`.  Mutable by
   * design — controllers write it between steps without rebuilding the
   * solver context.
   */
  massFlowOverride?: number;

  constructor(massFlow: number, schedule?: Array<[number, number]>) {
    this.massFlow = massFlow;
    this.massFlowSchedule = schedule;
  }

  getMdot(t?: number): number {
    if (this.massFlowOverride !== undefined) {
      return this.massFlowOverride;
    }
    if (
      t !== undefined &&
      this.massFlowSchedule &&
      this.massFlowSchedule.length > 0
    ) {
      return interpolateSchedule(this.massFlowSchedule, t);
    }
    return this.massFlow;
  }

  pressureDrop(_mdot: number, _rho: number, _mu?: number, _t?: number): number {
    return 0;
  }
}
