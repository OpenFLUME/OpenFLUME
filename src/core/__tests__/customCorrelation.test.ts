/**
 * Custom convection heat-transfer correlation (correlation.model: 'custom').
 *
 * A convection conductor may carry a user h expression in the SAFE
 * expression language (core/usercode/expression.ts — hand-written tokenizer
 * /Pratt parser/tree evaluator; no eval/new Function).  The expression is
 * compiled ONCE per solver context (buildSolverContext) and evaluated by
 * evaluateConvectionH (core/correlations.ts) on the standard correlation
 * cadence — h-map refresh at attempt start + each outer iteration, frozen
 * inside the inner Newton, floor-clamped/under-relaxed and reported
 * identically to the named models.
 *
 * Scope (SI): t, Tf, Tw, P, G, D, area, flowArea; rho, mu, k, cp, Pr, Re,
 * quality when the fluid model/state carries them (legacy models have no
 * k); param('name') / params.name; the expression builtins.
 *
 * This file is CoolProp-FREE (incompressible / hand-built contexts only) so
 * it runs in the fast suite; the real-fluid Dittus–Boelter agreement test
 * lives in correlations.test.ts (slow set).
 */
import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../schema";
import { solveSteady } from "../solver";
import { solveTransient } from "../transient";
import { validateNetwork } from "../validate";
import { decodeNetworkConfig, ConfigDecodeError } from "../config";
import {
  buildSolverContext,
  createInitialState,
  computeConductorHMap,
} from "../solver";
import {
  evaluateConvectionH,
  FALLBACK_H_FLOOR,
  H_RELAX,
} from "../correlations";
import type {
  CorrelationConductor,
  CorrelationCtx,
  CorrelationState,
} from "../correlations";
import { IncompressibleLiquid } from "../fluids";
import { getSolverDiagnostics, resetSolverDiagnostics } from "../diagnostics";
import { parseText, serializeText } from "../../substrate/textProjection";

/* ------------------------------------------------------------------ */
/* Shared fixtures                                                     */
/* ------------------------------------------------------------------ */

type ConductorType = NonNullable<NetworkConfig["conductors"]>[number]["type"];

/**
 * Series-resistance steady config: ambient 400 K → conduction → solid →
 * convection → fluid boundary 300 K (the thermal.test.ts §2 layout).
 * `convType` is the convection conductor's type payload.
 */
function seriesConfig(convType: ConductorType): NetworkConfig {
  return {
    meta: { name: "custom-series", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-9,
      maxIterations: 500,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "f1",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
      {
        id: "f2",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    solidNodes: [
      { id: "a1", type: "ambient", x: 0, y: 0, temperature: 400 },
      { id: "s1", type: "solid", x: 1, y: 0, temperature: 350 },
    ],
    conductors: [
      {
        id: "cond1",
        from: "a1",
        to: "s1",
        type: { kind: "conduction", k: 10, area: 0.01, length: 0.1 },
      },
      { id: "conv1", from: "s1", to: "f1", type: convType },
    ],
    branches: [
      {
        id: "dummy",
        from: "f1",
        to: "f2",
        component: { type: "flowSource", massFlow: 0 },
      },
    ],
  };
}

/** Flow config: boundary → flowSource → internal → pipe → boundary. */
function flowConfig(
  correlation: Record<string, unknown>,
  mdot = 0.25,
): NetworkConfig {
  return {
    meta: { name: "custom-flow", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-9,
      maxIterations: 500,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "in",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 2e5,
        temperature: 350,
      },
      {
        id: "mid",
        type: "internal",
        x: 1,
        y: 0,
        pressure: 2e5,
        temperature: 350,
      },
      {
        id: "out",
        type: "boundary",
        x: 2,
        y: 0,
        pressure: 1e5,
        temperature: 350,
      },
    ],
    branches: [
      {
        id: "b1",
        from: "in",
        to: "mid",
        component: { type: "flowSource", massFlow: mdot },
      },
      {
        id: "b2",
        from: "mid",
        to: "out",
        component: { type: "pipe", length: 2, diameter: 0.03, roughness: 1e-5 },
      },
    ],
    solidNodes: [
      {
        id: "wall",
        type: "solid",
        x: 1,
        y: 1,
        temperature: 400,
        heatInput: 5000,
      },
    ],
    conductors: [
      {
        id: "conv1",
        from: "mid",
        to: "wall",
        type: {
          kind: "convection",
          area: 0.01,
          correlation: correlation as never,
        },
      },
    ],
  };
}

/** Hand-built minimal correlation context (incompressible water). */
function handCtx(
  customExpressions?: CorrelationCtx["customExpressions"],
): CorrelationCtx {
  return {
    fluid: IncompressibleLiquid.WATER,
    isRealFluid: false,
    branches: [{ id: "b1", from: "A", to: "B" }],
    nBranch: 1,
    nodeMap: new Map([
      ["A", { id: "A", type: "internal" }],
      ["B", { id: "B", type: "boundary" }],
      ["WALL", { id: "WALL", type: "boundary" }],
    ]),
    ...(customExpressions ? { customExpressions } : {}),
  };
}

function handState(mdot = 5): CorrelationState {
  return {
    nodeP: new Map([["A", 2e5]]),
    nodeT: new Map([["A", 350]]),
    mdots: [mdot],
    solidT: new Map([["WALL", 400]]),
  };
}

function customCond(
  correlation: Record<string, unknown>,
  h?: number,
): CorrelationConductor {
  return {
    id: "conv0",
    from: "A",
    to: "WALL",
    type: {
      kind: "convection",
      ...(h !== undefined ? { h } : {}),
      area: 0.02,
      correlation: correlation as never,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 1. Literal-h equivalence                                            */
/* ------------------------------------------------------------------ */

describe("custom correlation: literal equivalence", () => {
  it("{expression: '100'} reproduces literal h = 100 heat transfer exactly", () => {
    const custom = seriesConfig({
      kind: "convection",
      area: 0.01,
      correlation: { model: "custom", expression: "100" },
    });
    const literal = seriesConfig({ kind: "convection", h: 100, area: 0.01 });

    expect(validateNetwork(custom)).toEqual([]);
    const resCustom = solveSteady(custom);
    const resLiteral = solveSteady(literal);
    expect(resCustom.converged).toBe(true);
    expect(resLiteral.converged).toBe(true);

    // Bit-identical heat rate and solid temperature (h is exactly 100 at
    // every refresh: the floor never binds and prevH relaxation of equal
    // values is a fixed point).
    expect(resCustom.conductors!.conv1.heatRate).toBe(
      resLiteral.conductors!.conv1.heatRate,
    );
    expect(resCustom.solidNodes!.s1.temperature).toBe(
      resLiteral.solidNodes!.s1.temperature,
    );
    expect(resCustom.conductors!.conv1.heatTransferCoeff).toBe(100);

    // Hand-check the analytic series-resistance value too.
    const Rcond = 0.1 / (10 * 0.01);
    const Rconv = 1 / (100 * 0.01);
    expect(resCustom.conductors!.conv1.heatRate).toBeCloseTo(
      (400 - 300) / (Rcond + Rconv),
      9,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 2. Generic geometry scope on an incompressible fluid                */
/* ------------------------------------------------------------------ */

describe("custom correlation: generic scope on incompressible fluid", () => {
  it("validates WITHOUT realFluid and evaluates G/D/flowArea/params", () => {
    const D = 0.008;
    const flowArea = 5.0e-5;
    const mdot = 0.25;
    const config = flowConfig({
      model: "custom",
      expression: "param('base') + params.slope * G * D",
      diameter: D,
      flowArea,
      params: { base: 50, slope: 0.002 },
    });

    // No realFluid requirement for custom (generic expression).
    expect(validateNetwork(config)).toEqual([]);
    const res = solveSteady(config);
    expect(res.converged).toBe(true);

    // G = ½·(|ṁ_b1| + |ṁ_b2|) / flowArea = 0.25 / 5e-5 = 5000 kg/m²·s.
    const G =
      (0.5 * (Math.abs(mdot) + Math.abs(res.branches.b2.mdot))) / flowArea;
    const expected = 50 + 0.002 * G * D;
    expect(res.conductors!.conv1.heatTransferCoeff!).toBeCloseTo(expected, 9);
  });

  it("exposes Tf/Tw/P/t/area/flowArea and the expression builtins", () => {
    const ctx = handCtx();
    const state = handState();
    const cond = customCond({
      model: "custom",
      expression:
        "0 * Tf + 0 * Tw + 0 * P + 0 * t + 0 * area + 0 * flowArea + min(9, 12) + sqrt(16) + 0 * pi",
      flowArea: 2e-4,
    });
    // 9 + 4 = 13; zero-weighted scope reads still must RESOLVE.
    expect(evaluateConvectionH(cond, ctx, state)).toBe(13);
  });

  it("Tw comes from the solid endpoint and Tf/P from the fluid node state", () => {
    const ctx = handCtx();
    const state = handState();
    const cond = customCond({
      model: "custom",
      expression: "0.1 * (Tw - Tf) + 1e-4 * P",
    });
    // 0.1 * (400 − 350) + 1e-4 * 2e5 = 5 + 20 = 25
    expect(evaluateConvectionH(cond, ctx, state)).toBeCloseTo(25, 12);
  });

  it("rho/mu/cp are available on incompressible; k/Pr/quality are absent and fail over safely", () => {
    const ctx = handCtx();
    const state = handState();
    const rhoCond = customCond({
      model: "custom",
      expression: "0 * rho + 0 * mu + 0 * cp + 7",
    });
    expect(evaluateConvectionH(rhoCond, ctx, state)).toBe(7);

    // k is not carried by legacy models (same limitation as dittusBoelter):
    // the expression FAILS to evaluate and falls back — never crashes.
    resetSolverDiagnostics();
    const kCond = customCond({ model: "custom", expression: "k * 1000" });
    expect(evaluateConvectionH(kCond, ctx, state)).toBe(FALLBACK_H_FLOOR);
    const prCond = customCond({ model: "custom", expression: "Pr" });
    expect(evaluateConvectionH(prCond, ctx, state)).toBe(FALLBACK_H_FLOOR);
    const qCond = customCond({ model: "custom", expression: "quality" });
    expect(evaluateConvectionH(qCond, ctx, state)).toBe(FALLBACK_H_FLOOR);
    // A failure returns the floor VALUE directly — not via the floor clamp.
    expect(getSolverDiagnostics().hFloorClampCount).toBe(0);
  });

  it("Re uses G·D/mu when G, D and mu are available", () => {
    const ctx = handCtx();
    const state = handState(5); // G = 0.5·5 / 2e-4 = 12500
    const cond = customCond({
      model: "custom",
      expression: "Re * 0 + 0 * G + 11",
      diameter: 0.01,
      flowArea: 2e-4,
    });
    expect(evaluateConvectionH(cond, ctx, state)).toBe(11);
    const reCond = customCond({
      model: "custom",
      expression: "Re * 1e-4",
      diameter: 0.01,
      flowArea: 2e-4,
    });
    // G = 12500, D = 0.01, mu = 1e-3 → Re = 125000
    expect(evaluateConvectionH(reCond, ctx, state)).toBeCloseTo(12.5, 12);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Validation                                                       */
/* ------------------------------------------------------------------ */

describe("custom correlation: validation", () => {
  const base = seriesConfig({
    kind: "convection",
    area: 0.01,
    correlation: { model: "custom", expression: "100" },
  });

  function withCorrelation(
    correlation: Record<string, unknown>,
  ): NetworkConfig {
    const cfg = structuredClone(base);
    (cfg.conductors![1].type as { correlation: unknown }).correlation =
      correlation;
    return cfg;
  }

  it("accepts a minimal custom correlation (expression only) on incompressible", () => {
    expect(validateNetwork(base)).toEqual([]);
  });

  it("requires a non-empty, parseable expression", () => {
    for (const correlation of [
      { model: "custom" },
      { model: "custom", expression: "" },
      { model: "custom", expression: "   " },
      { model: "custom", expression: "0.023 *" },
      { model: "custom", expression: 42 },
    ]) {
      const errs = validateNetwork(withCorrelation(correlation as never));
      expect(errs.length).toBeGreaterThan(0);
      expect(errs.join(" ")).toMatch(
        /Conductor conv1 custom correlation expression/,
      );
    }
  });

  it("rejects non-positive diameter/flowArea when supplied", () => {
    expect(
      validateNetwork(
        withCorrelation({ model: "custom", expression: "100", diameter: 0 }),
      ).join(" "),
    ).toMatch(/Conductor conv1 correlation diameter must be positive/);
    expect(
      validateNetwork(
        withCorrelation({ model: "custom", expression: "100", flowArea: -1 }),
      ).join(" "),
    ).toMatch(/Conductor conv1 correlation flowArea must be positive/);
  });

  it("rejects non-finite / non-object params with field-specific errors", () => {
    expect(
      validateNetwork(
        withCorrelation({
          model: "custom",
          expression: "100",
          params: { a: Number.NaN },
        }),
      ).join(" "),
    ).toMatch(
      /Conductor conv1 custom correlation param "a" must be a finite number/,
    );
    expect(
      validateNetwork(
        withCorrelation({ model: "custom", expression: "100", params: [1, 2] }),
      ).join(" "),
    ).toMatch(/Conductor conv1 custom correlation params must be an object/);
    // The decode boundary rejects non-object params structurally.
    const decoded = structuredClone(base);
    (
      decoded.conductors![1].type as { correlation: Record<string, unknown> }
    ).correlation.params = [1, 2];
    expect(() => decodeNetworkConfig(decoded)).toThrow(ConfigDecodeError);
    try {
      decodeNetworkConfig(decoded);
    } catch (e) {
      expect((e as ConfigDecodeError).path).toBe(
        "conductors[1].type.correlation.params",
      );
    }
  });

  it("keeps the named models’ requirements unchanged", () => {
    // dittusBoelter still requires realFluid …
    const db = withCorrelation({ model: "dittusBoelter", diameter: 0.05 });
    expect(validateNetwork(db).join(" ")).toMatch(
      /Conductor conv1 correlation requires realFluid fluid model/,
    );
    // … and a positive diameter (now also when absent).
    const dbNoD = seriesConfig({
      kind: "convection",
      area: 0.01,
      h: 10,
      correlation: { model: "dittusBoelter" } as never,
    });
    dbNoD.fluid = { model: "realFluid", params: { fluidName: "Water" } };
    expect(validateNetwork(dbNoD).join(" ")).toMatch(
      /Conductor conv1 correlation diameter must be positive/,
    );
    // expression/params are rejected on named models.
    const dbExpr = withCorrelation({
      model: "dittusBoelter",
      diameter: 0.05,
      expression: "100",
    });
    expect(validateNetwork(dbExpr).join(" ")).toMatch(
      /expression is only supported for the custom model/,
    );
    const dbParams = withCorrelation({
      model: "dittusBoelter",
      diameter: 0.05,
      params: { a: 1 },
    });
    expect(validateNetwork(dbParams).join(" ")).toMatch(
      /params are only supported for the custom model/,
    );
  });

  it("still requires a positive literal h floor when h is supplied", () => {
    const cfg = withCorrelation({ model: "custom", expression: "100" });
    (cfg.conductors![1].type as { h?: number }).h = -3;
    expect(validateNetwork(cfg).join(" ")).toMatch(
      /Conductor conv1 h \(fallback floor\) must be positive if provided/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 4. Runtime safety: failures, non-finite, non-positive               */
/* ------------------------------------------------------------------ */

describe("custom correlation: runtime safety", () => {
  it("unknown identifier / bad param fall back without crashing the solve", () => {
    // Unknown identifiers parse fine (no static inference) but fail at
    // evaluation → the literal-h fallback floor applies (h: 42 here).
    const config = flowConfig({
      model: "custom",
      expression: "bogusIdentifier * 2",
    });
    (config.conductors![0].type as { h?: number }).h = 42;
    expect(validateNetwork(config)).toEqual([]);
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(res.conductors!.conv1.heatTransferCoeff).toBe(42);

    // Unknown param name.
    const ctx = handCtx();
    const badParam = customCond({
      model: "custom",
      expression: "param('nope')",
      params: { a: 1 },
    });
    expect(evaluateConvectionH(badParam, ctx, handState())).toBe(
      FALLBACK_H_FLOOR,
    );
    // Non-string param argument.
    const badArg = customCond({
      model: "custom",
      expression: "param(3)",
      params: { a: 1 },
    });
    expect(evaluateConvectionH(badArg, ctx, handState())).toBe(
      FALLBACK_H_FLOOR,
    );
  });

  it("non-finite results (1/0, log(0)) fall back; negative/zero hit the floor clamp + counter", () => {
    const ctx = handCtx();
    const state = handState();
    resetSolverDiagnostics();

    const inf = customCond({ model: "custom", expression: "1/0" });
    expect(evaluateConvectionH(inf, ctx, state)).toBe(FALLBACK_H_FLOOR);
    const negInf = customCond({ model: "custom", expression: "log(0)" });
    expect(evaluateConvectionH(negInf, ctx, state)).toBe(FALLBACK_H_FLOOR);
    const nan = customCond({ model: "custom", expression: "sqrt(-1)" });
    expect(evaluateConvectionH(nan, ctx, state)).toBe(FALLBACK_H_FLOOR);
    // Failovers substitute the floor value directly — no clamp counted.
    expect(getSolverDiagnostics().hFloorClampCount).toBe(0);

    // Finite but non-positive / below-floor: the SHARED floor clamp binds
    // and is counted — identical to a named correlation returning a low h.
    const neg = customCond({ model: "custom", expression: "-50" });
    expect(evaluateConvectionH(neg, ctx, state)).toBe(FALLBACK_H_FLOOR);
    const zero = customCond({ model: "custom", expression: "0" });
    expect(evaluateConvectionH(zero, ctx, state)).toBe(FALLBACK_H_FLOOR);
    const low = customCond({ model: "custom", expression: "1" }, 100);
    expect(evaluateConvectionH(low, ctx, state)).toBe(100); // literal-h floor wins
    expect(getSolverDiagnostics().hFloorClampCount).toBe(3);
    resetSolverDiagnostics();
  });

  it("a solve with a failing expression converges at the fallback h", () => {
    const config = seriesConfig({
      kind: "convection",
      h: 25,
      area: 0.01,
      correlation: { model: "custom", expression: "sqrt(-1)" },
    });
    expect(validateNetwork(config)).toEqual([]);
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(res.conductors!.conv1.heatTransferCoeff).toBe(25);
    const Rcond = 0.1 / (10 * 0.01);
    const Rconv = 1 / (25 * 0.01);
    expect(res.conductors!.conv1.heatRate).toBeCloseTo(
      (400 - 300) / (Rcond + Rconv),
      9,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 5. Cadence / under-relaxation / compile-cache                       */
/* ------------------------------------------------------------------ */

describe("custom correlation: cadence, under-relaxation, compilation", () => {
  it("under-relaxes with H_RELAX exactly like the named models", () => {
    const ctx = handCtx();
    const state = handState();
    const cond = customCond({ model: "custom", expression: "100" });
    expect(evaluateConvectionH(cond, ctx, state)).toBe(100); // no prevH
    expect(evaluateConvectionH(cond, ctx, state, 50)).toBe(
      50 + H_RELAX * (100 - 50),
    );
    // Non-finite prevH is ignored (same guard as the named path).
    expect(evaluateConvectionH(cond, ctx, state, Number.NaN)).toBe(100);
  });

  it("exposes t (default 0) threaded from the h-map refresh", () => {
    const ctx = handCtx();
    const state = handState();
    const cond = customCond({ model: "custom", expression: "100 + t" });
    expect(evaluateConvectionH(cond, ctx, state)).toBe(100);
    expect(evaluateConvectionH(cond, ctx, state, undefined, 2.5)).toBe(102.5);
  });

  it("buildSolverContext compiles each custom expression exactly once and reuses it", () => {
    const config = flowConfig({ model: "custom", expression: "100 + G * 0" });
    const ctx = buildSolverContext(config);
    expect(ctx.customExpressions.size).toBe(1);
    const compiled = ctx.customExpressions.get("conv1");
    expect(compiled).toBeDefined();
    const state = createInitialState(ctx, config);
    computeConductorHMap(ctx, state);
    computeConductorHMap(ctx, state);
    // Same compiled object across refreshes — no recompilation in the loop.
    expect(ctx.customExpressions.get("conv1")).toBe(compiled);
  });

  it("transient: recorded h tracks the step time t (reporting path is unrelaxed)", () => {
    const config: NetworkConfig = {
      meta: { name: "custom-transient", version: 2 },
      settings: {
        mode: "transient",
        dt: 0.1,
        endTime: 0.3,
        tolerance: 1e-8,
        maxIterations: 200,
        relaxation: 0.9,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 2e5,
          temperature: 350,
        },
        {
          id: "mid",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 2e5,
          temperature: 350,
          volume: 1e-3,
        },
        {
          id: "out",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: 1e5,
          temperature: 350,
        },
      ],
      branches: [
        {
          id: "b1",
          from: "in",
          to: "mid",
          component: { type: "flowSource", massFlow: 0.1 },
        },
        {
          id: "b2",
          from: "mid",
          to: "out",
          component: {
            type: "pipe",
            length: 1,
            diameter: 0.03,
            roughness: 1e-5,
          },
        },
      ],
      solidNodes: [
        {
          id: "wall",
          type: "solid",
          x: 1,
          y: 1,
          temperature: 400,
          mass: 0.5,
          cp: 500,
        },
      ],
      conductors: [
        {
          id: "conv1",
          from: "mid",
          to: "wall",
          type: {
            kind: "convection",
            area: 0.01,
            correlation: { model: "custom", expression: "100 + t" },
          },
        },
      ],
    };
    expect(validateNetwork(config)).toEqual([]);
    const res = solveTransient(config);
    expect(res.converged).toBe(true);
    const h = res.conductors!.conv1.heatTransferCoeff!;
    expect(h.length).toBe(res.times.length);
    for (let i = 0; i < res.times.length; i++) {
      expect(h[i]).toBeCloseTo(100 + res.times[i], 9);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 6. Text projection round-trip                                       */
/* ------------------------------------------------------------------ */

describe("custom correlation: text projection", () => {
  it("round-trips expression/params losslessly", () => {
    const config = flowConfig({
      model: "custom",
      expression:
        "0.023 * (G * D / mu)^0.8 * (cp * mu / k)^0.4 * k / D * param('multiplier')",
      diameter: 0.008,
      flowArea: 5.0e-5,
      params: { multiplier: 1 },
    });
    const text = serializeText(config);
    const result = parseText(text);
    expect(result.errors).toEqual([]);
    expect(result.config).toStrictEqual(config);
    // And the serialized line is stable (re-serializing the parse is identical).
    expect(serializeText(result.config!)).toBe(text);
  });
});
