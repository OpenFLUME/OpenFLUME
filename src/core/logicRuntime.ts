/**
 * Runtime for the declarative user-logic layer (schema.ts `registers` and
 * `logic`): named numeric registers plus LogicRule expressions fired at the
 * solve lifecycle events (HookEvent).
 *
 * Expression scope (built on the usercode/expression.ts evaluator and its
 * builtins — min/max/abs/sqrt/exp/log/sin/cos/tanh/clamp/smoothstep/pi):
 *   t          — event time [s] (candidate end time at stepStart/
 *                stepRejected, accepted end time at stepAccepted, 0 at
 *                init / for steady solves, endTime at converged/solveEnd
 *                of a completed transient)
 *   dt         — step size [s] (transient step events only)
 *   iter       — solver iteration count (steady: outer iteration via the
 *                onProgress callback; transient stepAccepted: inner-Newton
 *                iteration count of the accepted step)
 *   residual   — solver residual at the event (same availability as iter)
 *   node(id)   — { P, T, rho } of a FLUID node (plus h, quality for
 *                realFluid); throws on an unknown id
 *   branch(id) — { mdot } of a branch; throws on an unknown id
 *   solid(id)  — { T } of a solid/ambient node; throws on an unknown id
 *   reg(name)  — current value of a register; throws on an unknown name
 * Registers are ALSO readable as bare identifiers (reg('x') ≡ x), but the
 * fixed scope names above take precedence — a register named e.g. `t` is
 * only reachable via reg('t').
 *
 * Semantics:
 *   - Rules are tied to `on` (default 'stepAccepted').  At an event, each
 *     matching rule's `when` is evaluated; if truthy, every `set` expression
 *     is evaluated against the PRE-assignment scope of that rule and the
 *     writes are then committed together (so `set: {a:'b', b:'a'}` swaps).
 *   - Writes by earlier rules at the same event ARE visible to later rules.
 *   - Assignment may create a register that was not declared in
 *     `registers` (declared registers are just initial values).
 *   - `stop: true` on a fired rule requests user termination: the runtime
 *     records userTerminated (+ terminationReason from `reason`) and the
 *     solver returns the current partial result at the next safe point.
 *   - ADAPTIVE TRANSIENT discipline: stepStart fires before each candidate
 *     solve; its register writes are SPECULATIVE.  If the candidate is
 *     rejected the registers are rolled back to the pre-candidate snapshot
 *     BEFORE stepRejected fires, so a rejected candidate leaves no
 *     persistent register trace.  stepAccepted fires only on the accepted
 *     persistent state.
 */

import type { HookEvent, LogicRule, NetworkConfig } from "./schema";
import {
  ExpressionError,
  compileExpression,
  type CompiledExpression,
  type ExprScope,
} from "./usercode/expression";

/** State accessors handed to the runtime by the solver at each event. */
export interface LogicStateScope {
  node(id: string): Record<string, number>;
  branch(id: string): Record<string, number>;
  solid(id: string): Record<string, number>;
}

/** Per-event numeric context (only defined members enter the scope). */
export interface LogicEventInfo {
  t: number;
  dt?: number;
  iter?: number;
  residual?: number;
}

interface CompiledRule {
  id: string;
  on: HookEvent;
  when: CompiledExpression;
  set: Array<[string, CompiledExpression]>;
  stop: boolean;
  reason?: string;
}

function compileRuleExpressions(rule: LogicRule): CompiledRule {
  let when: CompiledExpression;
  try {
    when = compileExpression(rule.when);
  } catch (e) {
    throw new ExpressionError(
      "parse",
      `Logic rule "${rule.id}" when: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const set: Array<[string, CompiledExpression]> = [];
  for (const [name, src] of Object.entries(rule.set ?? {})) {
    try {
      set.push([name, compileExpression(src)]);
    } catch (e) {
      throw new ExpressionError(
        "parse",
        `Logic rule "${rule.id}" set "${name}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return {
    id: rule.id,
    on: rule.on ?? "stepAccepted",
    when,
    set,
    stop: rule.stop === true,
    reason: rule.reason,
  };
}

export class LogicRuntime {
  private registers: Map<string, number>;
  private readonly rules: CompiledRule[];
  userTerminated = false;
  terminationReason?: string;

  constructor(config: Pick<NetworkConfig, "registers" | "logic">) {
    this.registers = new Map(Object.entries(config.registers ?? {}));
    this.rules = (config.logic ?? []).map(compileRuleExpressions);
  }

  get size(): number {
    return this.registers.size;
  }

  /** Fire every rule bound to `event`, in declaration order. */
  fire(event: HookEvent, state: LogicStateScope, info: LogicEventInfo): void {
    for (const rule of this.rules) {
      if (rule.on !== event) continue;
      const scope = this.buildScope(state, info);
      let fired: boolean;
      try {
        fired = rule.when.evaluateBoolean(scope);
      } catch (e) {
        throw new ExpressionError(
          "evaluate",
          `Logic rule "${rule.id}" when (${event}): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (!fired) continue;
      // Evaluate all RHS against the pre-assignment scope, then commit.
      const writes: Array<[string, number]> = [];
      for (const [name, expr] of rule.set) {
        let value: number;
        try {
          value = expr.evaluateNumber(scope);
        } catch (e) {
          throw new ExpressionError(
            "evaluate",
            `Logic rule "${rule.id}" set "${name}" (${event}): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        if (!Number.isFinite(value)) {
          throw new ExpressionError(
            "evaluate",
            `Logic rule "${rule.id}" set "${name}" (${event}) produced a non-finite value`,
          );
        }
        writes.push([name, value]);
      }
      for (const [name, value] of writes) this.registers.set(name, value);
      if (rule.stop) {
        this.userTerminated = true;
        if (this.terminationReason === undefined) {
          this.terminationReason =
            rule.reason ?? `stop requested by logic rule "${rule.id}"`;
        }
      }
    }
  }

  /** Register snapshot for speculative-write rollback (adaptive rejects). */
  snapshot(): Map<string, number> {
    return new Map(this.registers);
  }

  restore(snap: Map<string, number>): void {
    this.registers = new Map(snap);
  }

  finalRegisters(): Record<string, number> {
    return Object.fromEntries(this.registers);
  }

  /** Current value of a named register (for register-following controllers). */
  registerValue(name: string): number | undefined {
    return this.registers.get(name);
  }

  private buildScope(state: LogicStateScope, info: LogicEventInfo): ExprScope {
    // Registers first: the fixed scope names (t, dt, node, …) win over a
    // colliding register name (still reachable via reg('name')).
    const scope: ExprScope = Object.fromEntries(this.registers);
    scope.t = info.t;
    if (info.dt !== undefined) scope.dt = info.dt;
    if (info.iter !== undefined) scope.iter = info.iter;
    if (info.residual !== undefined) scope.residual = info.residual;
    scope.node = state.node;
    scope.branch = state.branch;
    scope.solid = state.solid;
    scope.reg = (name: unknown): number => {
      if (typeof name !== "string") {
        throw new ExpressionError(
          "evaluate",
          "reg(name) requires a string register name",
        );
      }
      const v = this.registers.get(name);
      if (v === undefined) {
        throw new ExpressionError("evaluate", `Unknown register "${name}"`);
      }
      return v;
    };
    return scope;
  }
}

/**
 * Create the runtime for a solve, or undefined when the network configures
 * neither logic rules nor registers — every code path is then bit-identical
 * to a solve without this feature.
 */
export function createLogicRuntime(
  config: Pick<NetworkConfig, "registers" | "logic">,
): LogicRuntime | undefined {
  if ((config.logic?.length ?? 0) === 0 && config.registers === undefined)
    return undefined;
  return new LogicRuntime(config);
}

/** Optional result fields contributed by the runtime (schema.ts results). */
export function logicResultFields(rt: LogicRuntime | undefined): {
  userTerminated?: boolean;
  terminationReason?: string;
  finalRegisters?: Record<string, number>;
} {
  if (!rt) return {};
  return {
    ...(rt.userTerminated
      ? {
          userTerminated: true,
          ...(rt.terminationReason !== undefined
            ? { terminationReason: rt.terminationReason }
            : {}),
        }
      : {}),
    finalRegisters: rt.finalRegisters(),
  };
}
