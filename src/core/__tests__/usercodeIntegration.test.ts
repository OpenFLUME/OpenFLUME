import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../schema";
import { solveSteady, buildSolverContext } from "../solver";
import { solveTransient } from "../transient";
import { ExpressionError } from "../usercode/expression";
import { validateNetwork } from "../validate";

/**
 * Solver-integration tests for the declarative layer: user components
 * (dpTable / customResistance / userComponent via buildSolverContext) and
 * the registers + LogicRule lifecycle runtime (core/logicRuntime.ts).
 */

const K_CODE = `
defineComponent({
  metadata: { name: 'kRes', params: [{ name: 'K', default: 8, min: 0 }] },
  pressureDrop(args) {
    return args.params.K * args.mdot * Math.abs(args.mdot) / (2 * args.rho * args.area * args.area);
  },
});
`;

function makeSteadyConfig(
  overrides: Partial<NetworkConfig> = {},
): NetworkConfig {
  return {
    meta: { name: "test", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-9,
      maxIterations: 500,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "A",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 200000,
        temperature: 300,
      },
      {
        id: "B",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: 100000,
        temperature: 300,
      },
    ],
    branches: [],
    ...overrides,
  } as NetworkConfig;
}

function makeTransientConfig(
  overrides: Partial<NetworkConfig> = {},
): NetworkConfig {
  return {
    meta: { name: "test-transient", version: 2 },
    settings: {
      mode: "transient",
      dt: 0.01,
      endTime: 0.05,
      tolerance: 1e-9,
      maxIterations: 200,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "A",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 200000,
        temperature: 300,
      },
      {
        id: "M",
        type: "internal",
        x: 0.5,
        y: 0,
        pressure: 150000,
        temperature: 300,
        volume: 0.01,
      },
      {
        id: "B",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: 100000,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "r1",
        from: "A",
        to: "M",
        component: { type: "resistance", k: 8, area: 0.01 },
      },
      {
        id: "r2",
        from: "M",
        to: "B",
        component: { type: "resistance", k: 8, area: 0.01 },
      },
    ],
    ...overrides,
  } as NetworkConfig;
}

describe("buildSolverContext declarative components", () => {
  it("solves a full network with a defineComponent user component (matches built-in resistance)", () => {
    const userCfg = makeSteadyConfig({
      componentLibrary: { kRes: { code: K_CODE } },
      branches: [
        {
          id: "u1",
          from: "A",
          to: "B",
          component: {
            type: "userComponent",
            component: "kRes",
            params: { K: 8 },
            area: 0.01,
          },
        },
      ] as NetworkConfig["branches"],
    });
    const builtinCfg = makeSteadyConfig({
      branches: [
        {
          id: "r1",
          from: "A",
          to: "B",
          component: { type: "resistance", k: 8, area: 0.01 },
        },
      ] as NetworkConfig["branches"],
    });

    const userRes = solveSteady(userCfg);
    const builtinRes = solveSteady(builtinCfg);
    expect(userRes.converged).toBe(true);
    expect(builtinRes.converged).toBe(true);

    // Analytic: ΔP = K·ṁ²/(2ρA²) → ṁ = sqrt(2·998·0.01²·1e5/8)
    const expected = Math.sqrt((2 * 998 * 0.01 * 0.01 * 1e5) / 8);
    expect(userRes.branches.u1.mdot).toBeCloseTo(expected, 6);
    // The user component must land on the same solution as the built-in.
    expect(userRes.branches.u1.mdot).toBeCloseTo(
      builtinRes.branches.r1.mdot,
      6,
    );
  });

  it("solves a network with an inline-format user component", () => {
    const cfg = makeSteadyConfig({
      componentLibrary: {
        kInline: {
          format: "inline",
          code: "return args.params.K * args.mdot * Math.abs(args.mdot) / (2 * args.rho * args.area * args.area);",
        },
      },
      branches: [
        {
          id: "u1",
          from: "A",
          to: "B",
          component: {
            type: "userComponent",
            component: "kInline",
            params: { K: 8 },
            area: 0.01,
          },
        },
      ] as NetworkConfig["branches"],
    });
    const res = solveSteady(cfg);
    expect(res.converged).toBe(true);
    const expected = Math.sqrt((2 * 998 * 0.01 * 0.01 * 1e5) / 8);
    expect(res.branches.u1.mdot).toBeCloseTo(expected, 6);
  });

  it("solves networks with dpTable and customResistance branches", () => {
    const tableCfg = makeSteadyConfig({
      branches: [
        // Linear table through the origin: ΔP = 2000·ṁ → at ΔP = 1e5, ṁ = 50.
        {
          id: "t1",
          from: "A",
          to: "B",
          component: {
            type: "dpTable",
            points: [
              [0, 0],
              [50, 1e5],
            ],
            extrapolate: "linear",
          },
        },
      ] as NetworkConfig["branches"],
    });
    const tableRes = solveSteady(tableCfg);
    expect(tableRes.converged).toBe(true);
    expect(tableRes.branches.t1.mdot).toBeCloseTo(50, 6);

    const customCfg = makeSteadyConfig({
      branches: [
        {
          id: "c1",
          from: "A",
          to: "B",
          component: { type: "customResistance", k: 8, area: 0.01 },
        },
      ] as NetworkConfig["branches"],
    });
    const customRes = solveSteady(customCfg);
    expect(customRes.converged).toBe(true);
    const expected = Math.sqrt((2 * 998 * 0.01 * 0.01 * 1e5) / 8);
    expect(customRes.branches.c1.mdot).toBeCloseTo(expected, 6);
  });

  it("throws on an unknown component type instead of silently substituting a resistance", () => {
    const cfg = makeSteadyConfig({
      branches: [
        {
          id: "x1",
          from: "A",
          to: "B",
          component: { type: "banana", k: 1, area: 1 },
        },
      ] as unknown as NetworkConfig["branches"],
    });
    expect(() => buildSolverContext(cfg)).toThrow(
      /unknown component type "banana"/,
    );
  });

  it("throws on an unknown componentLibrary reference", () => {
    const cfg = makeSteadyConfig({
      branches: [
        {
          id: "u1",
          from: "A",
          to: "B",
          component: { type: "userComponent", component: "ghost" },
        },
      ] as NetworkConfig["branches"],
    });
    expect(() => buildSolverContext(cfg)).toThrow(
      /unknown componentLibrary entry "ghost"/,
    );
  });

  it("propagates user-code evaluation errors with the branch source id", () => {
    const cfg = makeSteadyConfig({
      componentLibrary: {
        bad: {
          code: "defineComponent({ metadata: { name: 'bad' }, pressureDrop(args) { return args.mdot / 0; } });",
        },
      },
      branches: [
        {
          id: "u1",
          from: "A",
          to: "B",
          component: { type: "userComponent", component: "bad", area: 0.01 },
        },
      ] as NetworkConfig["branches"],
    });
    expect(() => solveSteady(cfg)).toThrow(/branch u1 \(bad\)/);
  });
});

describe("logic runtime — steady lifecycle", () => {
  it("runs init + stepAccepted (per outer iteration) + converged + solveEnd", () => {
    let progressCalls = 0;
    const cfg = makeSteadyConfig({
      branches: [
        {
          id: "r1",
          from: "A",
          to: "B",
          component: { type: "resistance", k: 8, area: 0.01 },
        },
      ] as NetworkConfig["branches"],
      registers: {
        hits: 0,
        initialized: 0,
        sawConverged: 0,
        sawEnd: 0,
        lastMdot: 0,
      },
      logic: [
        { id: "init", on: "init", when: "1", set: { initialized: "1" } },
        // `on` omitted → defaults to stepAccepted.
        {
          id: "count",
          when: "1",
          set: { hits: "hits + 1", lastMdot: "branch('r1').mdot" },
        },
        {
          id: "conv",
          on: "converged",
          when: "residual < 1e-6",
          set: { sawConverged: "1" },
        },
        { id: "end", on: "solveEnd", when: "1", set: { sawEnd: "1" } },
      ],
    });
    const res = solveSteady(cfg, { onProgress: () => progressCalls++ });
    expect(res.converged).toBe(true);
    const regs = res.finalRegisters!;
    expect(regs).toBeDefined();
    expect(regs.initialized).toBe(1);
    expect(regs.hits).toBe(progressCalls);
    expect(progressCalls).toBeGreaterThan(0);
    expect(regs.sawConverged).toBe(1);
    expect(regs.sawEnd).toBe(1);
    // branch('r1').mdot read the current iterate at the last outer iteration.
    expect(regs.lastMdot).toBeCloseTo(res.branches.r1.mdot, 6);
    expect(res.userTerminated).toBeUndefined();
  });

  it("honors stop rules in steady solves (early aborted exit with termination fields)", () => {
    const cfg = makeSteadyConfig({
      branches: [
        {
          id: "r1",
          from: "A",
          to: "B",
          component: { type: "resistance", k: 8, area: 0.01 },
        },
      ] as NetworkConfig["branches"],
      logic: [
        // Fires at the first outer-iteration callback (iter starts at 0) —
        // the wrapped shouldAbort then ends the solve early.
        {
          id: "stopper",
          on: "stepAccepted",
          when: "iter >= 0",
          stop: true,
          reason: "enough iterations",
        },
      ],
    });
    const res = solveSteady(cfg);
    expect(res.userTerminated).toBe(true);
    expect(res.terminationReason).toBe("enough iterations");
    expect(res.aborted).toBe(true);
    expect(res.iterations).toBeLessThan(cfg.settings.maxIterations);
    expect(res.finalRegisters).toBeDefined();
  });

  it("fails loudly when a rule reads an unknown register or node", () => {
    const badReg = makeSteadyConfig({
      branches: [
        {
          id: "r1",
          from: "A",
          to: "B",
          component: { type: "resistance", k: 8, area: 0.01 },
        },
      ] as NetworkConfig["branches"],
      logic: [{ id: "bad", on: "init", when: "reg('nope') > 0" }],
    });
    expect(() => solveSteady(badReg)).toThrow(/Unknown register "nope"/);

    const badNode = makeSteadyConfig({
      branches: [
        {
          id: "r1",
          from: "A",
          to: "B",
          component: { type: "resistance", k: 8, area: 0.01 },
        },
      ] as NetworkConfig["branches"],
      logic: [{ id: "bad", on: "init", when: "node('ghost').P > 0" }],
    });
    expect(() => solveSteady(badNode)).toThrow(ExpressionError);
    expect(() => solveSteady(badNode)).toThrow(/Unknown node "ghost"/);
  });
});

describe("logic runtime — transient lifecycle", () => {
  it("fires init/stepAccepted/converged/solveEnd with register state and dt scope", () => {
    const cfg = makeTransientConfig({
      registers: { acc: 0, sawConverged: 0, sawEnd: 0, midP: 0 },
      logic: [
        { id: "init", on: "init", when: "1", set: { acc: "10" } },
        {
          id: "accum",
          when: "1",
          set: { acc: "acc + dt", midP: "node('M').P" },
        },
        { id: "conv", on: "converged", when: "1", set: { sawConverged: "1" } },
        { id: "end", on: "solveEnd", when: "1", set: { sawEnd: "1" } },
      ],
    });
    const res = solveTransient(cfg);
    expect(res.converged).toBe(true);
    expect(res.times).toEqual([0, 0.01, 0.02, 0.03, 0.04, 0.05]);
    const regs = res.finalRegisters!;
    // init set 10, then 5 accepted steps of dt = 0.01.
    expect(regs.acc).toBeCloseTo(10.05, 12);
    expect(regs.sawConverged).toBe(1);
    expect(regs.sawEnd).toBe(1);
    expect(regs.midP).toBeCloseTo(
      res.nodes.M.pressure[res.nodes.M.pressure.length - 1],
      6,
    );
    expect(res.userTerminated).toBeUndefined();
  });

  it("stop rule in a fixed transient returns the partial result with termination fields", () => {
    const cfg = makeTransientConfig({
      settings: {
        mode: "transient",
        dt: 0.01,
        endTime: 0.1,
        tolerance: 1e-9,
        maxIterations: 200,
        relaxation: 0.9,
      },
      registers: { steps: 0 },
      logic: [
        { id: "count", when: "1", set: { steps: "steps + 1" } },
        {
          id: "stopper",
          on: "stepAccepted",
          when: "t >= 0.029",
          stop: true,
          reason: "target reached",
        },
      ],
    });
    const res = solveTransient(cfg);
    expect(res.userTerminated).toBe(true);
    expect(res.terminationReason).toBe("target reached");
    // The accepted step that triggered the stop IS recorded: t = 0, …, 0.03.
    expect(res.times).toEqual([0, 0.01, 0.02, 0.03]);
    expect(res.finalRegisters!.steps).toBe(3);
    // Registered-series lengths stay aligned with times.
    expect(res.nodes.M.pressure.length).toBe(res.times.length);
    expect(res.branches.r1.mdot.length).toBe(res.times.length);
  });

  it("adaptive: stepRejected sees rolled-back registers; stepAccepted counts accepted steps only", () => {
    // Tight-tolerance blowdown (mirrors adaptive.test.ts) — forces rejections.
    const cfg: NetworkConfig = {
      meta: { name: "blowdown-logic", version: 2 },
      settings: {
        mode: "transient",
        timeStepping: "adaptive",
        adaptive: {
          dtMin: 0.001,
          dtMax: 0.05,
          relTol: 1e-10,
          absTolP: 1e-6,
          absTolT: 1e-6,
          safety: 0.9,
        },
        endTime: 0.02,
        tolerance: 1e-6,
        maxIterations: 200,
        relaxation: 0.9,
      },
      fluid: { model: "idealGas", preset: "air" },
      nodes: [
        {
          id: "tank",
          type: "internal",
          x: 0,
          y: 0,
          pressure: 1e6,
          temperature: 300,
          volume: 0.1,
        },
        {
          id: "out",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "o1",
          from: "tank",
          to: "out",
          component: { type: "orifice", area: 1e-4, cd: 0.6 },
        },
      ],
      registers: { starts: 0, rejects: 0, accepts: 0 },
      logic: [
        { id: "s", on: "stepStart", when: "1", set: { starts: "starts + 1" } },
        {
          id: "r",
          on: "stepRejected",
          when: "1",
          set: { rejects: "rejects + 1" },
        },
        {
          id: "a",
          on: "stepAccepted",
          when: "1",
          set: { accepts: "accepts + 1" },
        },
      ],
    };
    const res = solveTransient(cfg);
    expect(res.converged).toBe(true);
    expect(res.stats).toBeDefined();
    expect(res.stats!.rejectedSteps).toBeGreaterThan(0);
    const regs = res.finalRegisters!;
    // Steps forced through the dtMin error floor remain in the diagnostic
    // trajectory, but are not certified stepAccepted lifecycle events.
    expect(regs.accepts).toBe(res.stats!.steps);
    // Rollback discipline: stepStart writes of rejected and error-floor
    // candidates are rolled back. Only certified stepAccepted events retain
    // their speculative writes.
    expect(regs.starts).toBe(regs.accepts);
    // At least one stepRejected fired (the run did reject candidates).
    expect(regs.rejects).toBeGreaterThan(0);
    // Every error-estimate rejection either fired stepRejected or was
    // force-accepted at dtMin (counted by dtAtMinCount, no stepRejected).
    expect(
      regs.rejects + (res.stats!.dtAtMinCount ?? 0),
    ).toBeGreaterThanOrEqual(res.stats!.rejectedSteps);
    expect(res.userTerminated).toBeUndefined();
  });

  it("adaptive: stop rule in stepRejected ends the run at the last accepted state", () => {
    const cfg: NetworkConfig = {
      meta: { name: "blowdown-stop", version: 2 },
      settings: {
        mode: "transient",
        timeStepping: "adaptive",
        adaptive: {
          dtMin: 0.001,
          dtMax: 0.05,
          relTol: 1e-10,
          absTolP: 1e-6,
          absTolT: 1e-6,
          safety: 0.9,
        },
        endTime: 0.02,
        tolerance: 1e-6,
        maxIterations: 200,
        relaxation: 0.9,
      },
      fluid: { model: "idealGas", preset: "air" },
      nodes: [
        {
          id: "tank",
          type: "internal",
          x: 0,
          y: 0,
          pressure: 1e6,
          temperature: 300,
          volume: 0.1,
        },
        {
          id: "out",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "o1",
          from: "tank",
          to: "out",
          component: { type: "orifice", area: 1e-4, cd: 0.6 },
        },
      ],
      logic: [
        {
          id: "panic",
          on: "stepRejected",
          when: "1",
          stop: true,
          reason: "reject budget exceeded",
        },
      ],
    };
    const res = solveTransient(cfg);
    expect(res.userTerminated).toBe(true);
    expect(res.terminationReason).toBe("reject budget exceeded");
    // Stopped at the first rejection: no new step was recorded after it.
    expect(res.stats!.steps).toBe(res.times.length - 1);
    expect(res.times[res.times.length - 1]).toBeLessThan(0.02);
  });
});

describe("logic validation additions", () => {
  it("accepts stop/reason and rejects wrong types", () => {
    const good = makeSteadyConfig({
      branches: [
        {
          id: "r1",
          from: "A",
          to: "B",
          component: { type: "resistance", k: 8, area: 0.01 },
        },
      ] as NetworkConfig["branches"],
      logic: [{ id: "l1", when: "t > 1", stop: true, reason: "done" }],
    });
    expect(validateNetwork(good)).toEqual([]);

    const bad = makeSteadyConfig({
      branches: [
        {
          id: "r1",
          from: "A",
          to: "B",
          component: { type: "resistance", k: 8, area: 0.01 },
        },
      ] as NetworkConfig["branches"],
      logic: [{ id: "l1", when: "1", stop: 1, reason: 2 }],
    } as unknown as Partial<NetworkConfig>);
    const errs = validateNetwork(bad as NetworkConfig);
    expect(errs.some((e) => /stop must be a boolean/.test(e))).toBe(true);
    expect(errs.some((e) => /reason must be a string/.test(e))).toBe(true);
  });
});
