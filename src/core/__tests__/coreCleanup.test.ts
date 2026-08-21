import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../schema";
import { buildSolverContext, createInitialState, solveSteady } from "../solver";
import type { SolverContext, StepState } from "../solver";
import { applyBoundaryConditions } from "../transient";
import { RealFluid } from "../fluids/realFluid";
import { ControllerRuntime } from "../controllerRuntime";
import { createFluidAssignment } from "../fluidAssignment";

/**
 * Tests for the bounded core cleanup:
 *  - componentFactory: per-branch user-definition closure isolation;
 *  - FluidAssignment identity + loud unknown-id failure;
 *  - non-real user branch heat receiving the branch fluid + upstream P;
 *  - atomic real-fluid boundary updates (transient.ts);
 *  - controllerRuntime anti-windup, runtime physical guards and duplicate
 *    target protection.
 */

const K_CODE = `
defineComponent({
  metadata: { name: 'kRes', params: [{ name: 'K', default: 8, min: 0 }] },
  pressureDrop(args) {
    return args.params.K * args.mdot * Math.abs(args.mdot) / (2 * args.rho * args.area * args.area);
  },
});
`;

function baseNodes(): NetworkConfig["nodes"] {
  return [
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
  ];
}

describe("componentFactory — per-branch closure isolation", () => {
  // The body keeps a mutable call counter; with a shared compiled
  // definition the two branches would advance the SAME counter.
  const COUNTER_CODE = `
let calls = 0;
defineComponent({
  metadata: { name: 'counted' },
  pressureDrop(args) { calls += 1; return calls * args.mdot; },
});
`;

  it("compiles a fresh definition per branch so closure state is isolated", () => {
    const cfg = {
      meta: { name: "iso", version: 2 },
      settings: { mode: "steady", tolerance: 1e-9, maxIterations: 100 },
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
      branches: [
        {
          id: "u1",
          from: "A",
          to: "B",
          component: { type: "userComponent", component: "counted" },
        },
        {
          id: "u2",
          from: "A",
          to: "B",
          component: { type: "userComponent", component: "counted" },
        },
      ],
      componentLibrary: { counted: { code: COUNTER_CODE } },
    } as unknown as NetworkConfig;

    const ctx = buildSolverContext(cfg);
    const u1 = ctx.branches.find((b) => b.id === "u1")!.component;
    const u2 = ctx.branches.find((b) => b.id === "u2")!.component;

    // First call on each branch: each sees its OWN first call.
    const a1 = u1.pressureDrop(0.1, 998, 1e-3);
    const b1 = u2.pressureDrop(0.1, 998, 1e-3);
    expect(a1).toBeCloseTo(0.1, 12); // calls=1 → 1*mdot
    expect(b1).toBeCloseTo(0.1, 12); // isolated: also calls=1 (shared would give 0.2)
    // Second call on u1 advances only u1's counter; u2 is unaffected.
    const a2 = u1.pressureDrop(0.1, 998, 1e-3);
    const b2 = u2.pressureDrop(0.1, 998, 1e-3);
    expect(a2).toBeCloseTo(0.2, 12);
    expect(b2).toBeCloseTo(0.2, 12); // u2's second call (shared would give 0.4)
  });

  it("pure definitions return identical results for identical args (documented contract)", () => {
    const cfg = {
      meta: { name: "pure", version: 2 },
      settings: { mode: "steady", tolerance: 1e-9, maxIterations: 100 },
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
      ],
      componentLibrary: { kRes: { code: K_CODE } },
    } as unknown as NetworkConfig;
    const ctx = buildSolverContext(cfg);
    const comp = ctx.branches[0].component;
    const d1 = comp.pressureDrop(0.5, 998, 1e-3);
    const d2 = comp.pressureDrop(0.5, 998, 1e-3);
    expect(d1).toBe(d2); // bitwise identical for a pure callback
  });

  it("still fails loudly on unknown library entries and unknown component types", () => {
    const mk = (component: unknown) =>
      ({
        meta: { name: "x", version: 2 },
        settings: { mode: "steady", tolerance: 1e-9, maxIterations: 100 },
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
        branches: [{ id: "u1", from: "A", to: "B", component }],
      }) as unknown as NetworkConfig;
    expect(() =>
      buildSolverContext(mk({ type: "userComponent", component: "ghost" })),
    ).toThrow(/unknown componentLibrary entry "ghost"/);
    expect(() => buildSolverContext(mk({ type: "banana" }))).toThrow(
      /unknown component type "banana"/,
    );
  });
});

describe("FluidAssignment", () => {
  function simpleCtx(): SolverContext {
    const cfg = {
      meta: { name: "fa", version: 2 },
      settings: { mode: "steady", tolerance: 1e-9, maxIterations: 100 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: baseNodes(),
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
    } as unknown as NetworkConfig;
    return buildSolverContext(cfg);
  }

  it("is single-fluid-backed: every lookup returns the context fluid itself", () => {
    const ctx = simpleCtx();
    expect(ctx.fluidAssignment.branch("r1")).toBe(ctx.fluid);
    expect(ctx.fluidAssignment.branch("r2")).toBe(ctx.fluid);
    expect(ctx.fluidAssignment.node("A")).toBe(ctx.fluid);
    expect(ctx.fluidAssignment.node("M")).toBe(ctx.fluid);
  });

  it("fails loudly on unknown ids", () => {
    const ctx = simpleCtx();
    expect(() => ctx.fluidAssignment.branch("ghost")).toThrow(
      /unknown branch "ghost"/,
    );
    expect(() => ctx.fluidAssignment.node("ghost")).toThrow(
      /unknown node "ghost"/,
    );
  });

  it("standalone factory rejects unknown ids too", () => {
    const fluid = createFluidAssignment({} as never, {
      nodes: ["n1"],
      branches: ["b1"],
    });
    expect(() => fluid.node("n2")).toThrow(/unknown node "n2"/);
    expect(() => fluid.branch("b2")).toThrow(/unknown branch "b2"/);
  });
});

describe("user branch heat — non-real fluid accessor", () => {
  it("passes the branch fluid and upstream pressure to the heat callback in a steady solve", () => {
    // A --u1--> M --r2--> B, incompressible water (h = cp*T).  The user heat
    // callback is GATED on the fluid accessor and upstream P: with the
    // pre-cleanup call sites (no fluid/P passed) it returns 0 and M stays
    // at 300 K; with the fix it returns mdot*cp*5 W, so the steady energy
    // balance gives T_M = 300 + 5 = 305 K exactly.
    const HEAT_CODE = `
defineComponent({
  metadata: { name: 'heatedRes', params: [{ name: 'K', default: 8 }] },
  pressureDrop(args) {
    return args.params.K * args.mdot * Math.abs(args.mdot) / (2 * args.rho * args.area * args.area);
  },
  heat(args) {
    if (!args.fluid || args.P === undefined) return 0;
    var rhoUp = args.fluid.density(args.P, args.Tup);
    return rhoUp > 0 ? args.mdot * args.cp * 5 : 0;
  },
});
`;
    const cfg = {
      meta: { name: "userheat", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: baseNodes(),
      branches: [
        {
          id: "u1",
          from: "A",
          to: "M",
          component: {
            type: "userComponent",
            component: "heatedRes",
            params: { K: 8 },
            area: 0.01,
          },
        },
        {
          id: "r2",
          from: "M",
          to: "B",
          component: { type: "resistance", k: 8, area: 0.01 },
        },
      ],
      componentLibrary: { heatedRes: { code: HEAT_CODE } },
    } as unknown as NetworkConfig;

    const res = solveSteady(cfg);
    expect(res.converged).toBe(true);
    expect(res.nodes.M.temperature).toBeCloseTo(305, 6);
  });
});

describe("applyBoundaryConditions — atomic real-fluid updates", () => {
  function realishState(): StepState {
    return {
      nodeP: new Map([["A", 1e5]]),
      nodeT: new Map([["A", 300]]),
      nodeRho: new Map([["A", 900]]),
      nodeMu: new Map([["A", 1e-4]]),
      nodeH: new Map([["A", 1000]]),
      nodeQuality: new Map([["A", undefined]]),
      nodePhase: new Map([["A", "liquid"]]),
      mdots: [],
      solidT: new Map(),
    };
  }

  const config = {
    nodes: [
      {
        id: "A",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 1e5,
        temperature: 300,
        pressureSchedule: [
          [0, 1e5],
          [1, 2e5],
        ],
      },
    ],
    solidNodes: [],
  } as unknown as NetworkConfig;

  /** Method stub carrying the RealFluid prototype — the boundary update
   *  dispatches per node via `instanceof RealFluid` (mixed-EOS networks),
   *  so a plain duck-typed object would take the analytic path. */
  function realFluidStub(methods: Record<string, unknown>): unknown {
    return Object.assign(Object.create(RealFluid.prototype), methods);
  }

  function ctxWithFluid(methods: Record<string, unknown>): SolverContext {
    const fluid = realFluidStub(methods);
    return {
      isRealFluid: true,
      fluid,
      fluidAssignment: {
        node: () => fluid,
        branch: () => fluid,
      },
      boundaryPressureOverride: new Map(),
      boundaryTemperatureOverride: new Map(),
    } as unknown as SolverContext;
  }

  it("commits the full P/T/h/rho/mu/quality/phase candidate together on success", () => {
    const fluid = {
      enthalpyPT: (_P: number, _T: number) => 4242,
      statePH: (_P: number, _h: number) => ({
        T: 280,
        rho: 901,
        quality: undefined,
        mu: 2e-4,
        phase: "liquid",
      }),
    };
    const state = realishState();
    applyBoundaryConditions(ctxWithFluid(fluid), config, state, 1);
    expect(state.nodeP.get("A")).toBe(2e5);
    expect(state.nodeT.get("A")).toBe(280);
    expect(state.nodeH!.get("A")).toBe(4242);
    expect(state.nodeRho.get("A")).toBe(901);
    expect(state.nodeMu.get("A")).toBe(2e-4);
    expect(state.nodePhase!.get("A")).toBe("liquid");
  });

  it("throws with context and leaves the previous state untouched on failure", () => {
    const fluid = {
      enthalpyPT: () => {
        throw new Error("boom");
      },
      statePH: () => {
        throw new Error("boom");
      },
    };
    const state = realishState();
    expect(() =>
      applyBoundaryConditions(ctxWithFluid(fluid), config, state, 1),
    ).toThrow(
      /real-fluid update failed for boundary node "A" at t=1 \(P=200000, T=300\): boom/,
    );
    // No mixed state: every map still holds the previous consistent values.
    expect(state.nodeP.get("A")).toBe(1e5);
    expect(state.nodeT.get("A")).toBe(300);
    expect(state.nodeH!.get("A")).toBe(1000);
    expect(state.nodeRho.get("A")).toBe(900);
    expect(state.nodeMu.get("A")).toBe(1e-4);
    expect(state.nodePhase!.get("A")).toBe("liquid");
  });

  it("uses boundary quality when pressure changes on a saturated boundary", () => {
    const qualityConfig = {
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 101325,
          quality: 0.25,
          pressureSchedule: [
            [0, 101325],
            [1, 150000],
          ],
        },
      ],
      solidNodes: [],
    } as unknown as NetworkConfig;
    const fluid = {
      enthalpyPQ: (P: number, quality: number) => P + quality * 1000,
      enthalpyPT: () => {
        throw new Error("PT path should not be used");
      },
      statePH: (_P: number, h: number) => ({
        T: 281,
        rho: 20,
        quality: 0.25,
        mu: 1e-5,
        phase: "twoPhase",
        h,
      }),
    };
    const state = realishState();
    applyBoundaryConditions(ctxWithFluid(fluid), qualityConfig, state, 1);
    const expectedH = fluid.enthalpyPQ(150000, 0.25);
    expect(state.nodeH!.get("A")).toBeCloseTo(expectedH, 6);
    expect(state.nodeQuality!.get("A")).toBeCloseTo(0.25, 6);
  });
});

describe("ControllerRuntime — anti-windup, runtime guards, duplicate targets", () => {
  function valveCtx(): SolverContext {
    const cfg = {
      meta: { name: "ctrl", version: 2 },
      settings: {
        mode: "transient",
        dt: 0.01,
        endTime: 0.1,
        tolerance: 1e-9,
        maxIterations: 100,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: baseNodes(),
      branches: [
        {
          id: "v1",
          from: "A",
          to: "M",
          component: { type: "valve", area: 0.01, cd: 0.6, position: 0.5 },
        },
        {
          id: "r2",
          from: "M",
          to: "B",
          component: { type: "resistance", k: 8, area: 0.01 },
        },
      ],
    } as unknown as NetworkConfig;
    return buildSolverContext(cfg);
  }

  function stateFor(ctx: SolverContext): StepState {
    // Minimal synthetic accepted-step state (the runtime only reads the
    // sensed quantity).
    return {
      nodeP: new Map([
        ["A", 2e5],
        ["M", 1.5e5],
        ["B", 1e5],
      ]),
      nodeT: new Map([
        ["A", 300],
        ["M", 300],
        ["B", 300],
      ]),
      nodeRho: new Map([
        ["A", 998],
        ["M", 998],
        ["B", 998],
      ]),
      nodeMu: new Map([
        ["A", 1e-3],
        ["M", 1e-3],
        ["B", 1e-3],
      ]),
      mdots: new Array(ctx.nBranch).fill(0),
      solidT: new Map(),
    };
  }

  it("conditional integration: no windup while saturated, immediate recovery on error reversal", () => {
    const ctx = valveCtx();
    const j = ctx.branches.findIndex((b) => b.id === "v1");
    const rt = new ControllerRuntime(
      {
        controllers: [
          {
            id: "c",
            type: "pid",
            sense: { kind: "branch", id: "v1", quantity: "massFlow" },
            setpoint: 10,
            gains: { kp: 0, ki: 1, kd: 0 },
            output: { kind: "valvePosition", id: "v1" },
            limits: { min: 0.1, max: 1 },
          },
        ],
      },
      ctx,
    );
    const state = stateFor(ctx);

    // Deep saturation: error = +10 for five executions.  Plain integration
    // would accumulate I = 50; conditional integration pins the integral so
    // the output sits exactly ON the limit.
    state.mdots[j] = 0;
    for (let k = 0; k < 5; k++) rt.execute(state, 1);
    expect(rt.finalOutputs().c).toBe(1);

    // Error reverses to −0.5: with wound-up integral (I = 50) the output
    // would stay pinned at the max for ~100 executions; with anti-windup it
    // leaves saturation in ONE execution.
    state.mdots[j] = 10.5;
    rt.execute(state, 1);
    expect(rt.finalOutputs().c).toBeCloseTo(0.5, 12);
  });

  it("clamps a valve position output to the physical [0, 1] range even without configured limits", () => {
    const ctx = valveCtx();
    const j = ctx.branches.findIndex((b) => b.id === "v1");
    const rt = new ControllerRuntime(
      {
        controllers: [
          {
            id: "c",
            type: "pid",
            sense: { kind: "branch", id: "v1", quantity: "massFlow" },
            setpoint: 10,
            gains: { kp: 1, ki: 0, kd: 0 },
            output: { kind: "valvePosition", id: "v1" },
          },
        ],
      },
      ctx,
    );
    const state = stateFor(ctx);
    state.mdots[j] = 0; // error = +10 → raw output 10
    rt.execute(state, 1);
    expect(rt.finalOutputs().c).toBe(1);
    const valve = ctx.branches[j].component as { positionOverride?: number };
    expect(valve.positionOverride).toBe(1);

    state.mdots[j] = 20; // error = −10 → raw output −10 → clamped to 0
    rt.execute(state, 1);
    expect(rt.finalOutputs().c).toBe(0);
  });

  it("rejects a non-positive boundary pressure output at runtime", () => {
    const ctx = valveCtx();
    const rt = new ControllerRuntime(
      {
        controllers: [
          {
            id: "c",
            type: "pid",
            sense: { kind: "node", id: "M", quantity: "pressure" },
            setpoint: 100000, // sense reads 1.5e5 → error = −5e4
            gains: { kp: 1, ki: 0, kd: 0 },
            output: { kind: "boundaryPressure", id: "A" },
          },
        ],
      },
      ctx,
    );
    expect(() => rt.execute(stateFor(ctx), 1)).toThrow(
      /non-positive boundary pressure/,
    );
    // The invalid output must NOT have been written to the override map.
    expect(ctx.boundaryPressureOverride.has("A")).toBe(false);
  });

  it("throws on a non-finite output", () => {
    const ctx = valveCtx();
    const j = ctx.branches.findIndex((b) => b.id === "v1");
    const rt = new ControllerRuntime(
      {
        controllers: [
          {
            id: "c",
            type: "pid",
            sense: { kind: "branch", id: "v1", quantity: "massFlow" },
            setpoint: 10,
            gains: { kp: 1, ki: 0, kd: 0 },
            output: { kind: "valvePosition", id: "v1" },
          },
        ],
      },
      ctx,
    );
    const state = stateFor(ctx);
    state.mdots[j] = NaN;
    expect(() => rt.execute(state, 1)).toThrow(/non-finite output/);
  });

  it("rejects duplicate actuation targets at construction, naming both controllers", () => {
    const ctx = valveCtx();
    const ctrl = (id: string) => ({
      id,
      type: "pid" as const,
      sense: { kind: "node" as const, id: "M", quantity: "pressure" as const },
      setpoint: 1e5,
      gains: { kp: 1, ki: 0, kd: 0 },
      output: { kind: "valvePosition" as const, id: "v1" },
    });
    expect(
      () =>
        new ControllerRuntime({ controllers: [ctrl("c1"), ctrl("c2")] }, ctx),
    ).toThrow(
      /Controllers "c1" and "c2" both write output target "valvePosition:v1"/,
    );
  });
});

describe("createInitialState sanity for controller tests", () => {
  it("builds a state usable with ControllerRuntime (guards the test helper above)", () => {
    const cfg = {
      meta: { name: "x", version: 2 },
      settings: {
        mode: "transient",
        dt: 0.01,
        endTime: 0.02,
        tolerance: 1e-9,
        maxIterations: 100,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: baseNodes(),
      branches: [
        {
          id: "v1",
          from: "A",
          to: "M",
          component: { type: "valve", area: 0.01, cd: 0.6, position: 0.5 },
        },
        {
          id: "r2",
          from: "M",
          to: "B",
          component: { type: "resistance", k: 8, area: 0.01 },
        },
      ],
    } as unknown as NetworkConfig;
    const ctx = buildSolverContext(cfg);
    const state = createInitialState(ctx, cfg);
    expect(state.mdots.length).toBe(2);
  });
});
