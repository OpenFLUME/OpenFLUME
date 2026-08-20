/**
 * Runtime for the declarative controller layer (schema.ts `controllers`):
 *   - PID controllers at stepAccepted (after each accepted step);
 *   - register-following controllers at stepStart (after logic stepStart
 *     rules, before the candidate solve).
 *
 * See schema.ts ControllerConfig and validate.ts for configuration rules.
 */

import type {
  ControllerConfig,
  ControllerOutputTarget,
  NetworkConfig,
} from "./schema";
import type { LogicRuntime } from "./logicRuntime";
import { FlowSource, Valve } from "./components";
import type { SolverContext, StepState } from "./solver";

type OutputKind = ControllerOutputTarget["kind"];

interface Actuator {
  readonly id: string;
  readonly outputKind: OutputKind;
  readonly limits?: { min: number; max: number };
  readonly actuate: (value: number) => void;
  output: number;
}

interface PidControllerState extends Actuator {
  readonly kind: "pid";
  readonly setpoint: number;
  readonly kp: number;
  readonly ki: number;
  readonly kd: number;
  readonly initialOutput?: number;
  readonly sense: (state: StepState) => number;
  integral: number;
  prevError?: number;
}

interface RegisterControllerState extends Actuator {
  readonly kind: "register";
  readonly register: string;
}

export class ControllerRuntime {
  private readonly pidControllers: PidControllerState[];
  private readonly registerControllers: RegisterControllerState[];

  constructor(config: Pick<NetworkConfig, "controllers">, ctx: SolverContext) {
    const pidControllers: PidControllerState[] = [];
    const registerControllers: RegisterControllerState[] = [];
    for (const c of config.controllers ?? []) {
      if (c.type === "register") {
        registerControllers.push(buildRegisterController(c, ctx));
      } else {
        pidControllers.push(buildPidController(c, ctx));
      }
    }
    this.pidControllers = pidControllers;
    this.registerControllers = registerControllers;

    const targetOwner = new Map<string, string>();
    for (const c of config.controllers ?? []) {
      const key = `${c.output.kind}:${c.output.id}`;
      const owner = targetOwner.get(key);
      if (owner !== undefined) {
        throw new Error(
          `Controllers "${owner}" and "${c.id}" both write output target "${key}" ` +
            `(duplicate actuation targets are not supported)`,
        );
      }
      targetOwner.set(key, c.id);
    }
  }

  /** t = 0: seed PID initialOutput values. Register actuators sync separately. */
  initialize(): void {
    for (const c of this.pidControllers) {
      if (c.initialOutput !== undefined) {
        c.output = sanitizeOutput(c, clamp(c, c.initialOutput));
        c.actuate(c.output);
      }
    }
  }

  /** t = 0: after logic init, copy register values to actuation targets. */
  syncRegisters(logic: LogicRuntime): void {
    for (const c of this.registerControllers) {
      this.executeRegister(c, logic);
    }
  }

  /** stepStart: apply register values before the candidate solve. */
  executeRegisters(logic: LogicRuntime): void {
    for (const c of this.registerControllers) {
      this.executeRegister(c, logic);
    }
  }

  /** stepAccepted: run PID controllers against the accepted step state. */
  executePid(state: StepState, dt: number): void {
    for (const c of this.pidControllers) {
      const value = c.sense(state);
      const error = c.setpoint - value;
      const derivative =
        c.prevError === undefined ? 0 : (error - c.prevError) / dt;
      c.prevError = error;

      const candidateIntegral = c.integral + error * dt;
      const raw = c.kp * error + c.ki * candidateIntegral + c.kd * derivative;
      let output = clamp(c, raw);
      if (c.limits && output !== raw) {
        const drivingDeeper =
          (raw > c.limits.max && error > 0) ||
          (raw < c.limits.min && error < 0);
        if (drivingDeeper) {
          if (c.ki !== 0) {
            c.integral = (output - c.kp * error - c.kd * derivative) / c.ki;
          }
        } else {
          c.integral = candidateIntegral;
        }
      } else {
        c.integral = candidateIntegral;
      }

      output = sanitizeOutput(c, output);
      c.output = output;
      c.actuate(output);
    }
  }

  /** @deprecated Use executePid — kept as alias for internal call sites during migration. */
  execute(state: StepState, dt: number): void {
    this.executePid(state, dt);
  }

  finalOutputs(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of [...this.pidControllers, ...this.registerControllers])
      out[c.id] = c.output;
    return out;
  }

  private executeRegister(
    c: RegisterControllerState,
    logic: LogicRuntime,
  ): void {
    const raw = logic.registerValue(c.register);
    if (raw === undefined) {
      throw new Error(`Controller ${c.id}: unknown register "${c.register}"`);
    }
    const output = sanitizeOutput(c, clamp(c, raw));
    c.output = output;
    c.actuate(output);
  }
}

function clamp(c: Actuator, v: number): number {
  if (!c.limits) return v;
  return Math.min(c.limits.max, Math.max(c.limits.min, v));
}

function sanitizeOutput(c: Actuator, v: number): number {
  if (!Number.isFinite(v)) {
    throw new Error(`Controller ${c.id} produced a non-finite output`);
  }
  if (c.outputKind === "valvePosition") {
    return Math.min(1, Math.max(0, v));
  }
  if (c.outputKind === "boundaryPressure" && v <= 0) {
    throw new Error(
      `Controller ${c.id} produced a non-positive boundary pressure (${v} Pa)`,
    );
  }
  if (c.outputKind === "boundaryTemperature" && v <= 0) {
    throw new Error(
      `Controller ${c.id} produced a non-positive boundary temperature (${v} K)`,
    );
  }
  return v;
}

function buildActuate(
  c: ControllerConfig,
  ctx: SolverContext,
  out: ControllerOutputTarget,
): (value: number) => void {
  if (out.kind === "valvePosition" || out.kind === "flowRate") {
    const comp = ctx.branches.find((b) => b.id === out.id)?.component;
    if (out.kind === "valvePosition") {
      if (!(comp instanceof Valve)) {
        throw new Error(
          `Controller ${c.id}: output target "${out.id}" is not a valve branch`,
        );
      }
      return (v) => {
        comp.positionOverride = v;
      };
    }
    if (!(comp instanceof FlowSource)) {
      throw new Error(
        `Controller ${c.id}: output target "${out.id}" is not a flowSource branch`,
      );
    }
    return (v) => {
      comp.massFlowOverride = v;
    };
  }
  if (out.kind === "boundaryPressure") {
    return (v) => {
      ctx.boundaryPressureOverride.set(out.id, v);
    };
  }
  if (out.kind === "boundaryTemperature") {
    return (v) => {
      ctx.boundaryTemperatureOverride.set(out.id, v);
    };
  }
  return (v) => {
    ctx.heatInputOverride.set(out.id, v);
  };
}

function buildPidController(
  c: Extract<ControllerConfig, { type: "pid" }>,
  ctx: SolverContext,
): PidControllerState {
  let sense: (state: StepState) => number;
  if (c.sense.kind === "node") {
    const { id, quantity } = c.sense;
    if (!ctx.nodeMap.has(id)) {
      throw new Error(`Controller ${c.id}: unknown sense node "${id}"`);
    }
    sense = (state) => {
      const map =
        quantity === "pressure"
          ? state.nodeP
          : quantity === "temperature"
            ? state.nodeT
            : state.nodeRho;
      return map.get(id)!;
    };
  } else {
    const j = ctx.branches.findIndex((b) => b.id === c.sense.id);
    if (j < 0) {
      throw new Error(
        `Controller ${c.id}: unknown sense branch "${c.sense.id}"`,
      );
    }
    sense = (state) => state.mdots[j];
  }

  const out = c.output;
  const effectiveLimits =
    c.limits ?? (out.kind === "valvePosition" ? { min: 0, max: 1 } : undefined);
  return {
    kind: "pid",
    id: c.id,
    setpoint: c.setpoint,
    kp: c.gains.kp,
    ki: c.gains.ki,
    kd: c.gains.kd,
    limits: effectiveLimits,
    initialOutput: c.initialOutput,
    outputKind: out.kind,
    sense,
    actuate: buildActuate(c, ctx, out),
    integral: 0,
    output: 0,
  };
}

function buildRegisterController(
  c: Extract<ControllerConfig, { type: "register" }>,
  ctx: SolverContext,
): RegisterControllerState {
  const out = c.output;
  const effectiveLimits =
    c.limits ?? (out.kind === "valvePosition" ? { min: 0, max: 1 } : undefined);
  return {
    kind: "register",
    id: c.id,
    register: c.register,
    limits: effectiveLimits,
    outputKind: out.kind,
    actuate: buildActuate(c, ctx, out),
    output: 0,
  };
}

export function createControllerRuntime(
  config: Pick<NetworkConfig, "controllers">,
  ctx: SolverContext,
): ControllerRuntime | undefined {
  if ((config.controllers?.length ?? 0) === 0) return undefined;
  return new ControllerRuntime(config, ctx);
}

export function controllerResultFields(rt: ControllerRuntime | undefined): {
  finalControllerOutputs?: Record<string, number>;
} {
  if (!rt) return {};
  return { finalControllerOutputs: rt.finalOutputs() };
}
