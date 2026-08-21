/**
 * Custom temperature equations (`{ expression, tRange }`) and time-varying
 * solid properties (`{ timeTable }`) — core support tests.
 *
 *  A. `{ expression }` (T-domain, solid cp and conductor k):
 *     sampling fidelity of the safe-expression → PiecewiseLinearProperty
 *     build, exact enthalpy/integral behaviour of the sampled cp curve,
 *     equivalence with the `{ table }` form in steady and transient solves,
 *     analytic-vs-FD Jacobian of an expression-derived k curve, and clean
 *     rejection of malformed / negative / nonfinite / non-convergent
 *     expressions and invalid tRange.
 *  B. `{ timeTable }` (time-domain, transient only):
 *     validation (shape + steady-mode rejection), per-candidate-step
 *     backward-Euler cadence (value frozen at the step END time), adaptive
 *     breakpoint alignment, rejected-step purity, solver-side defense, and
 *     text-projection round-trip.
 *
 * Cadence contract (see schema.ts / solver.ts comments): within a candidate
 * step [t, t+dt] the time-table value is the CONSTANT curve.value(t+dt) —
 * cp enters the storage term as m·cp(t_end)·ΔT/dt and k as the constant
 * conductance k(t_end)·A/L; both are frozen across the inner Newton, so the
 * exact per-step Jacobian is the constant-property one.  In adaptive mode
 * the accepted state is the step-doubling pair, i.e. TWO half-steps with
 * the values at t+dt/2 and t+dt respectively.
 */
import { describe, it, expect } from "vitest";
import type { NetworkConfig, SolidPropertySpec } from "../schema";
import {
  buildSolverContext,
  createInitialState,
  probeThermalSubsystem,
  solveSteady,
  type StepState,
} from "../solver";
import { solveTransient } from "../transient";
import { validateNetwork } from "../validate";
import { decodeNetworkConfig, ConfigDecodeError } from "../config";
import {
  PiecewiseLinearProperty,
  isExpressionSpec,
  isTimeTableSpec,
  resolveSolidProperty,
  resolveSolidTimeProperty,
  sampleExpressionProperty,
  solidPropertyShape,
  validateSolidPropertySpec,
} from "../solidProperties";
import { parseText, serializeText } from "../../substrate/textProjection";

function dummyFluid(): Pick<NetworkConfig, "nodes" | "branches"> {
  return {
    nodes: [
      {
        id: "d1",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
      {
        id: "d2",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "dum",
        from: "d1",
        to: "d2",
        component: { type: "flowSource", massFlow: 0 },
      },
    ],
  };
}

/* ============================================================================
 * A. `{ expression, tRange }` — custom temperature equations
 * ========================================================================== */

describe("expression specs: sampling", () => {
  it("samples a nonlinear expression to ≤0.1 % relative interpolation error", () => {
    const curve = sampleExpressionProperty(
      { expression: "100 * sqrt(T / 100)", tRange: [50, 400] },
      "k",
      "test",
    );
    expect(curve).toBeInstanceOf(PiecewiseLinearProperty);
    expect(curve.knots.length).toBeGreaterThan(2); // nonlinear: real refinement
    let worst = 0;
    for (let i = 0; i <= 1000; i++) {
      const T = 50 + (350 * i) / 1000;
      const exact = 100 * Math.sqrt(T / 100);
      worst = Math.max(worst, Math.abs(curve.value(T) - exact) / exact);
    }
    console.log(
      `[expression sampling] sqrt worst rel deviation: ${(worst * 100).toFixed(4)} % (${curve.knots.length} knots)`,
    );
    expect(worst).toBeLessThan(0.002);
  });

  it("a linear expression samples to exactly the two endpoint knots (exact integral)", () => {
    const curve = sampleExpressionProperty(
      { expression: "300 + 0.5 * T", tRange: [100, 400] },
      "cp",
      "test",
    );
    expect(curve.knots).toEqual([
      [100, 350],
      [400, 500],
    ]);
    // ∫_100^250 (300 + 0.5·T) dT = 300·150 + 0.25·(250² − 100²) = 58125, exact.
    expect(curve.integral(250)).toBe(58125);
    expect(curve.slope(250)).toBe(0.5);
  });

  it("a constant-valued expression samples to a flat 2-knot curve", () => {
    const curve = sampleExpressionProperty(
      { expression: "385", tRange: [4, 600] },
      "cp",
      "test",
    );
    expect(curve.knots).toEqual([
      [4, 385],
      [600, 385],
    ]);
  });
});

describe("expression specs: validation", () => {
  it("accepts a well-formed expression spec", () => {
    expect(
      validateSolidPropertySpec(
        { expression: "100 * sqrt(T / 100)", tRange: [50, 400] },
        "k",
        "Conductor c1",
      ),
    ).toEqual([]);
  });

  it("rejects empty / unparseable / non-string expressions, naming the owner", () => {
    for (const spec of [
      { expression: "", tRange: [50, 400] },
      { expression: "   ", tRange: [50, 400] },
      { expression: "100 *", tRange: [50, 400] },
      { expression: 42, tRange: [50, 400] },
    ] as unknown as SolidPropertySpec[]) {
      const errs = validateSolidPropertySpec(spec, "k", "Conductor c1");
      expect(errs.length).toBeGreaterThan(0);
      expect(errs[0]).toContain("Conductor c1");
      expect(errs[0]).toContain("expression");
    }
  });

  it("rejects expressions that do not evaluate over tRange (unknown identifier)", () => {
    const errs = validateSolidPropertySpec(
      { expression: "T + bogus", tRange: [100, 200] },
      "cp",
      "Solid node s1",
    );
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("Solid node s1");
    expect(errs[0]).toMatch(/failed to evaluate.*bogus/);
  });

  it("rejects expressions that go negative or non-finite inside tRange", () => {
    // Crosses zero at T = 250: f(400) = 500 − 800 < 0.
    const neg = validateSolidPropertySpec(
      { expression: "500 - 2 * T", tRange: [100, 400] },
      "cp",
      "Solid node s1",
    );
    expect(neg.length).toBe(1);
    expect(neg[0]).toMatch(
      /Solid node s1: cp expression must be finite and positive/,
    );
    // sqrt of a negative at the top of the range → NaN sample.
    const nan = validateSolidPropertySpec(
      { expression: "sqrt(100 - T)", tRange: [50, 400] },
      "k",
      "Conductor c2",
    );
    expect(nan.length).toBe(1);
    expect(nan[0]).toMatch(
      /Conductor c2: k expression must be finite and positive/,
    );
    // Pole at the (dyadic) midpoint T = 150 → Infinity sample.
    const pole = validateSolidPropertySpec(
      { expression: "1 / ((T - 150)^2)", tRange: [100, 200] },
      "k",
      "Conductor c3",
    );
    expect(pole.length).toBe(1);
    expect(pole[0]).toMatch(
      /Conductor c3: k expression must be finite and positive/,
    );
  });

  it("rejects an expression that cannot be sampled within the knot cap", () => {
    // Oscillates with wavelength ~0.006 K on a 1 K range: > 2049 knots needed.
    const errs = validateSolidPropertySpec(
      { expression: "100 + 50 * sin(1000 * T)", tRange: [100, 101] },
      "cp",
      "Solid node s7",
    );
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(
      /Solid node s7: cp expression could not be sampled/,
    );
  });

  it("rejects missing / malformed / non-increasing / non-positive tRange", () => {
    const cases: Array<[unknown, RegExp]> = [
      [undefined, /requires tRange/],
      ["soon", /requires tRange/],
      [[100], /requires tRange/],
      [[400, 100], /increasing/],
      [[100, 100], /increasing/],
      [[-5, 100], /positive finite/],
      [[0, 100], /positive finite/],
      [[100, Number.NaN], /increasing|positive finite/],
    ];
    for (const [tRange, re] of cases) {
      const errs = validateSolidPropertySpec(
        { expression: "T", tRange } as unknown as SolidPropertySpec,
        "cp",
        "Solid node s1",
      );
      expect(errs.length, `tRange=${JSON.stringify(tRange)}`).toBeGreaterThan(
        0,
      );
      expect(errs[0]).toContain("Solid node s1");
      expect(errs[0]).toMatch(re);
    }
  });

  it("solver-side resolveSolidProperty throws the same owner-named errors", () => {
    expect(() =>
      resolveSolidProperty(
        { expression: "T + bogus", tRange: [1, 10] },
        "cp",
        "nodeX",
      ),
    ).toThrow(/nodeX.*bogus/);
    expect(() =>
      resolveSolidProperty(
        { expression: "500 - 2 * T", tRange: [100, 400] },
        "k",
        "condY",
      ),
    ).toThrow(/condY.*finite and positive/);
  });
});

describe("expression specs: shape dispatch", () => {
  it("classifies all five shapes with the canonical precedence", () => {
    expect(solidPropertyShape(385)).toBe("constant");
    expect(
      solidPropertyShape({
        table: [
          [1, 2],
          [2, 3],
        ],
      }),
    ).toBe("table");
    expect(solidPropertyShape({ material: "ofhc-copper" })).toBe("material");
    expect(solidPropertyShape({ expression: "T", tRange: [1, 10] })).toBe(
      "expression",
    );
    expect(
      solidPropertyShape({
        timeTable: [
          [0, 1],
          [1, 2],
        ],
      }),
    ).toBe("timeTable");
    expect(solidPropertyShape({} as never)).toBe("unknown");
    expect(solidPropertyShape(undefined)).toBe("unknown");
    // First-match precedence for pathological multi-key objects.
    expect(
      solidPropertyShape({
        table: [
          [1, 2],
          [2, 3],
        ],
        timeTable: [
          [0, 1],
          [1, 2],
        ],
      } as never),
    ).toBe("table");
    expect(isExpressionSpec({ expression: "T", tRange: [1, 10] })).toBe(true);
    expect(
      isExpressionSpec({
        timeTable: [
          [0, 1],
          [1, 2],
        ],
      }),
    ).toBe(false);
    expect(
      isTimeTableSpec({
        timeTable: [
          [0, 1],
          [1, 2],
        ],
      }),
    ).toBe(true);
    expect(
      isTimeTableSpec({
        table: [
          [1, 2],
          [2, 3],
        ],
      }),
    ).toBe(false);
  });

  it("resolveSolidProperty resolves expressions but REFUSES timeTable (time-domain trap)", () => {
    const c = resolveSolidProperty(
      { expression: "2 * T", tRange: [10, 100] },
      "k",
      "c1",
    );
    expect(c).toBeInstanceOf(PiecewiseLinearProperty);
    expect((c as PiecewiseLinearProperty).value(50)).toBe(100);
    expect(() =>
      resolveSolidProperty(
        {
          timeTable: [
            [0, 1],
            [1, 2],
          ],
        },
        "k",
        "c1",
      ),
    ).toThrow(/time-varying/);
  });

  it("resolveSolidTimeProperty returns undefined for every non-timeTable shape", () => {
    expect(resolveSolidTimeProperty(385, "cp", "x")).toBeUndefined();
    expect(
      resolveSolidTimeProperty(
        {
          table: [
            [1, 2],
            [2, 3],
          ],
        },
        "cp",
        "x",
      ),
    ).toBeUndefined();
    expect(
      resolveSolidTimeProperty({ material: "ofhc-copper" }, "cp", "x"),
    ).toBeUndefined();
    expect(
      resolveSolidTimeProperty({ expression: "T", tRange: [1, 10] }, "cp", "x"),
    ).toBeUndefined();
    const tc = resolveSolidTimeProperty(
      {
        timeTable: [
          [0, 100],
          [10, 300],
        ],
      },
      "cp",
      "x",
    );
    expect(tc).toBeInstanceOf(PiecewiseLinearProperty);
    expect(tc!.value(5)).toBe(200);
  });
});

/** Series-resistance steady layout: ambient 400 K → conduction → solid →
 *  convection → fluid boundary 300 K (thermal.test.ts §2 layout). */
function seriesConfig(k: SolidPropertySpec): NetworkConfig {
  return {
    meta: { name: "expr-series", version: 2 },
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
        type: { kind: "conduction", k, area: 0.01, length: 0.1 },
      },
      {
        id: "conv1",
        from: "s1",
        to: "f1",
        type: { kind: "convection", h: 100, area: 0.01 },
      },
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

describe("expression k in steady solves", () => {
  it("a linear expression is bit-identical to the equivalent table", () => {
    // The sampled knots ARE the table (both go through the identical
    // PiecewiseLinearProperty path) → the solves must agree bitwise.
    const knots = sampleExpressionProperty(
      { expression: "150 + 0.4 * T", tRange: [77, 400] },
      "k",
      "probe",
    ).knots;
    expect(knots.length).toBe(2); // linear → endpoints only
    const resExpr = solveSteady(
      seriesConfig({ expression: "150 + 0.4 * T", tRange: [77, 400] }),
    );
    const resTable = solveSteady(seriesConfig({ table: knots }));
    expect(resExpr.converged).toBe(true);
    expect(resTable.converged).toBe(true);
    expect(resExpr.solidNodes!.s1.temperature).toBe(
      resTable.solidNodes!.s1.temperature,
    );
    expect(resExpr.conductors!.cond1.heatRate).toBe(
      resTable.conductors!.cond1.heatRate,
    );
    expect(resExpr.conductors!.conv1.heatRate).toBe(
      resTable.conductors!.conv1.heatRate,
    );
  });

  it("a nonlinear expression matches a dense table of the same function (≤0.5 %)", () => {
    const f = (T: number): number => 150 + 0.004 * T * T;
    const denseTable: Array<[number, number]> = [];
    for (let i = 0; i <= 80; i++) {
      const T = 4 + (396 * i) / 80;
      denseTable.push([T, f(T)]);
    }
    const resExpr = solveSteady(
      seriesConfig({ expression: "150 + 0.004 * T * T", tRange: [4, 400] }),
    );
    const resTable = solveSteady(seriesConfig({ table: denseTable }));
    expect(resExpr.converged).toBe(true);
    expect(resTable.converged).toBe(true);
    const dQ = Math.abs(
      resExpr.conductors!.cond1.heatRate - resTable.conductors!.cond1.heatRate,
    );
    expect(dQ / Math.abs(resTable.conductors!.cond1.heatRate)).toBeLessThan(
      0.005,
    );
    console.log(
      `[expr vs dense table] Q expr=${resExpr.conductors!.cond1.heatRate.toFixed(6)} table=${resTable.conductors!.cond1.heatRate.toFixed(6)} ` +
        `T_s1 ${resExpr.solidNodes!.s1.temperature.toFixed(4)} vs ${resTable.solidNodes!.s1.temperature.toFixed(4)}`,
    );
  });

  it("a constant-valued expression matches the legacy constant within 1e-9", () => {
    const resExpr = solveSteady(
      seriesConfig({ expression: "10", tRange: [4, 600] }),
    );
    const resConst = solveSteady(seriesConfig(10));
    expect(resExpr.converged).toBe(true);
    expect(resConst.converged).toBe(true);
    // Different code path (curve vs constant) — same mathematics, so only
    // float-op-order rounding may separate them.
    expect(
      Math.abs(
        resExpr.solidNodes!.s1.temperature -
          resConst.solidNodes!.s1.temperature,
      ) / resConst.solidNodes!.s1.temperature,
    ).toBeLessThan(1e-9);
  });
});

describe("expression cp in transient solves (enthalpy/integral behaviour)", () => {
  const m = 2; // kg
  const Q = 400; // W extraction
  const DT = 5; // s
  const STEPS = 60;
  const config: NetworkConfig = {
    meta: { name: "lumped expr cp", version: 2 },
    settings: {
      mode: "transient",
      dt: DT,
      endTime: DT * STEPS,
      tolerance: 1e-9,
      maxIterations: 100,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    ...dummyFluid(),
    // cp(T) = 300 + 0.5·T on [100, 400]: sampled EXACTLY (linear → 2 knots),
    // so the analytic enthalpy inversion below is exact for the solved curve.
    solidNodes: [
      {
        id: "mass",
        type: "solid",
        x: 0,
        y: 5,
        temperature: 300,
        mass: m,
        cp: { expression: "300 + 0.5 * T", tRange: [100, 400] },
        heatInput: -Q,
      },
    ],
  };

  it("per-step enthalpy telescopes against the sampled curve", () => {
    const res = solveTransient(config);
    expect(res.converged).toBe(true);
    const curve = sampleExpressionProperty(
      { expression: "300 + 0.5 * T", tRange: [100, 400] },
      "cp",
      "mass",
    );
    const H0 = curve.integral(300);
    const trace = res.solidNodes!.mass.temperature;
    expect(trace.length).toBe(STEPS + 1);
    let worst = 0;
    for (let n = 1; n <= STEPS; n++) {
      const expected = H0 - (n * Q * DT) / m;
      const got = curve.integral(trace[n]);
      worst = Math.max(worst, Math.abs(got - expected) / Math.abs(expected));
    }
    console.log(
      `[expr telescoping] worst per-step H deviation: ${worst.toExponential(2)} (T_final=${trace[STEPS].toFixed(3)} K)`,
    );
    expect(worst).toBeLessThan(1e-7);
  });

  it("the trace matches the analytic quadratic enthalpy inversion", () => {
    // H(T) = ∫_100^T (300 + 0.5·T) dT = 300(T−100) + 0.25(T² − 100²)
    //      ⇒  T = 2·(−300 + √(122500 + H)).
    const res = solveTransient(config);
    const trace = res.solidNodes!.mass.temperature;
    let worst = 0;
    for (const n of [1, 7, 23, 47, STEPS]) {
      const Hn = 80000 - (n * Q * DT) / m; // H(300) = 80000 exactly
      const Tref = 2 * (-300 + Math.sqrt(122500 + Hn));
      worst = Math.max(worst, Math.abs(trace[n] - Tref));
    }
    console.log(
      `[expr analytic] worst |ΔT| vs quadratic inversion: ${worst.toExponential(2)} K`,
    );
    expect(worst).toBeLessThan(1e-4);
  });
});

/* --------------------------------------------------------------------------
 * A6. Thermal-subsystem Jacobian of an expression-derived k curve (FD guard)
 * ------------------------------------------------------------------------ */

describe("thermal-subsystem Jacobian with expression-derived curves (analytic vs FD)", () => {
  const EXPR_K: SolidPropertySpec = {
    expression: "150 + 0.004 * T * T",
    tRange: [4, 400],
  };
  const EXPR_CP_SQRT: SolidPropertySpec = {
    expression: "100 * sqrt(T / 100)",
    tRange: [50, 400],
  };
  const EXPR_CP_LIN: SolidPropertySpec = {
    expression: "200 + 0.5 * T",
    tRange: [50, 400],
  };
  const config: NetworkConfig = {
    meta: { name: "thermal Jacobian probe (expression)", version: 2 },
    settings: {
      mode: "transient",
      dt: 10,
      endTime: 10,
      tolerance: 1e-9,
      maxIterations: 100,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "wHot",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 1e5,
        temperature: 250,
      },
      {
        id: "w2",
        type: "boundary",
        x: 9,
        y: 0,
        pressure: 1e5,
        temperature: 250,
      },
    ],
    solidNodes: [
      {
        id: "sA",
        type: "solid",
        x: 0,
        y: 5,
        temperature: 83.37,
        mass: 1.5,
        cp: EXPR_CP_SQRT,
        heatInput: 30,
      },
      {
        id: "sB",
        type: "solid",
        x: 1,
        y: 5,
        temperature: 145.71,
        mass: 2.0,
        cp: {
          table: [
            [4, 12],
            [100, 260],
            [300, 400],
          ],
        },
      },
      {
        id: "sC",
        type: "solid",
        x: 2,
        y: 5,
        temperature: 251.13,
        mass: 0.8,
        cp: 385,
        heatInput: -500,
      },
      {
        id: "sD",
        type: "solid",
        x: 3,
        y: 5,
        temperature: 350.99,
        mass: 2.5,
        cp: EXPR_CP_LIN,
      },
      { id: "amb", type: "ambient", x: 4, y: 5, temperature: 77 },
    ],
    conductors: [
      {
        id: "cAB",
        from: "sA",
        to: "sB",
        type: { kind: "conduction", k: EXPR_K, area: 0.02, length: 0.3 },
      },
      {
        id: "cBC",
        from: "sB",
        to: "sC",
        type: { kind: "conduction", k: 150, area: 0.01, length: 0.2 },
      },
      {
        id: "cCD",
        from: "sC",
        to: "sD",
        type: { kind: "conduction", k: EXPR_K, area: 0.005, length: 0.4 },
      },
      {
        id: "rA",
        from: "sA",
        to: "amb",
        type: {
          kind: "radiation",
          emissivity: 0.3,
          area: 0.04,
          viewFactor: 0.7,
        },
      },
      {
        id: "cvB",
        from: "wHot",
        to: "sB",
        type: { kind: "convection", h: 120, area: 0.03 },
      },
    ],
    branches: [
      {
        id: "dum",
        from: "wHot",
        to: "w2",
        component: { type: "flowSource", massFlow: 0 },
      },
    ],
  };
  const PROBE_T: Record<string, number> = {
    sA: 83.37,
    sB: 145.71,
    sC: 251.13,
    sD: 350.99,
  };
  const PREV_T: Record<string, number> = {
    sA: 95.13,
    sB: 140.53,
    sC: 240.27,
    sD: 320.41,
  };
  const DT = 10;
  const FD_DELTA = 2e-3;

  it("probe temperatures are ≥ 0.02 K from every sampled knot (FD never straddles a knot)", () => {
    const ctx = buildSolverContext(config);
    const knots: number[] = [];
    for (const c of ctx.conductors)
      if (c.kCurve) knots.push(...c.kCurve.knots.map(([T]) => T));
    for (const [, curve] of ctx.solidCpCurves)
      knots.push(...curve.knots.map(([T]) => T));
    knots.push(4, 100, 300); // sB plain table
    const tmAB = (PROBE_T.sA + PROBE_T.sB) / 2;
    const tmCD = (PROBE_T.sC + PROBE_T.sD) / 2;
    for (const T of [...Object.values(PROBE_T), tmAB, tmCD]) {
      const d = Math.min(...knots.map((k) => Math.abs(k - T)));
      expect(
        d,
        `probe temperature ${T} too close to a knot (${d} K)`,
      ).toBeGreaterThan(0.02);
    }
  });

  it("analytic J matches central FD of the residual, entry by entry", () => {
    const ctx = buildSolverContext(config);
    // The expression specs must have resolved to curves at context build.
    expect(ctx.conductors.find((c) => c.id === "cAB")!.kCurve).toBeInstanceOf(
      PiecewiseLinearProperty,
    );
    expect(ctx.solidCpCurves.get("sA")).toBeInstanceOf(PiecewiseLinearProperty);
    expect(ctx.solidCpCurves.get("sD")).toBeInstanceOf(PiecewiseLinearProperty);

    const state = createInitialState(ctx, config);
    for (const id of ctx.solidIds) state.solidT.set(id, PROBE_T[id]);
    const prevState: StepState = createInitialState(ctx, config);
    for (const id of ctx.solidIds) prevState.solidT.set(id, PREV_T[id]);
    const opts = { dt: DT, prevState };

    const probe = probeThermalSubsystem(ctx, state, opts);
    const n = ctx.nSolid;

    const Jfd: number[][] = Array.from({ length: n }, () =>
      new Array(n).fill(0),
    );
    const T0 = ctx.solidIds.map((id) => PROBE_T[id]);
    for (let k = 0; k < n; k++) {
      const Tp = [...T0];
      Tp[k] += FD_DELTA;
      const Tm = [...T0];
      Tm[k] -= FD_DELTA;
      const fp = probeThermalSubsystem(ctx, state, opts, undefined, Tp).f;
      const fm = probeThermalSubsystem(ctx, state, opts, undefined, Tm).f;
      for (let i = 0; i < n; i++) Jfd[i][k] = (fp[i] - fm[i]) / (2 * FD_DELTA);
    }

    const rowScale = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < n; k++)
        rowScale[i] = Math.max(
          rowScale[i],
          Math.abs(probe.J[i][k]),
          Math.abs(Jfd[i][k]),
        );
    }
    let worst = 0;
    let worstEntry = "";
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < n; k++) {
        const tol = Math.max(
          1e-9 * rowScale[i],
          1e-5 * Math.max(Math.abs(probe.J[i][k]), Math.abs(Jfd[i][k])),
        );
        const mm = Math.abs(probe.J[i][k] - Jfd[i][k]) / tol;
        if (mm > worst) {
          worst = mm;
          worstEntry = `${probe.ids[i]} / ${probe.ids[k]}`;
        }
        expect(
          mm,
          `J[${probe.ids[i]}][${probe.ids[k]}]: analytic=${probe.J[i][k]} fd=${Jfd[i][k]} (margin ${mm.toFixed(2)})`,
        ).toBeLessThan(1);
      }
    }
    console.log(
      `[thermalJacobian expr] worst |Δ|/tol = ${worst.toExponential(2)} (${worstEntry})`,
    );
  });
});

/* ============================================================================
 * B. `{ timeTable }` — time-varying solid properties (transient only)
 * ========================================================================== */

describe("timeTable specs: validation", () => {
  it("accepts a well-formed time table", () => {
    expect(
      validateSolidPropertySpec(
        {
          timeTable: [
            [0, 100],
            [10, 300],
          ],
        },
        "cp",
        "Solid node s1",
      ),
    ).toEqual([]);
    expect(
      validateSolidPropertySpec(
        {
          timeTable: [
            [2.5, 100],
            [10, 300],
          ],
        },
        "k",
        "Conductor c1",
      ),
    ).toEqual([]);
  });

  it("rejects bad tables, naming the owner (x = time ≥ 0, strictly increasing; values > 0)", () => {
    const cases: Array<[Array<[number, number]>, RegExp]> = [
      [[[0, 100]], /at least 2/],
      [
        [
          [-1, 100],
          [10, 300],
        ],
        /non-negative finite seconds/,
      ],
      [
        [
          [10, 100],
          [0, 300],
        ],
        /strictly increasing/,
      ],
      [
        [
          [0, 100],
          [0, 300],
        ],
        /strictly increasing/,
      ],
      [
        [
          [0, -5],
          [10, 300],
        ],
        /positive finite/,
      ],
      [
        [
          [0, 100],
          [10, Number.NaN],
        ],
        /positive finite/,
      ],
    ];
    for (const [timeTable, re] of cases) {
      const errs = validateSolidPropertySpec(
        { timeTable },
        "cp",
        "Solid node s1",
      );
      expect(errs.length, JSON.stringify(timeTable)).toBeGreaterThan(0);
      expect(errs[0]).toContain("Solid node s1");
      expect(errs[0]).toMatch(re);
    }
  });

  it("resolveSolidTimeProperty throws the same owner-named errors (solver defense)", () => {
    expect(() =>
      resolveSolidTimeProperty({ timeTable: [[0, 100]] }, "cp", "nodeX"),
    ).toThrow(/at least 2/);
    expect(() =>
      resolveSolidTimeProperty(
        {
          timeTable: [
            [5, 100],
            [2, 300],
          ],
        },
        "k",
        "condY",
      ),
    ).toThrow(/condY.*strictly increasing/);
  });

  const base: NetworkConfig = {
    meta: { name: "tt-validate", version: 2 },
    settings: {
      mode: "transient",
      dt: 1,
      endTime: 2,
      tolerance: 1e-6,
      maxIterations: 50,
    },
    fluid: { model: "incompressible", preset: "water" },
    ...dummyFluid(),
    solidNodes: [
      {
        id: "s1",
        type: "solid",
        x: 0,
        y: 5,
        temperature: 300,
        mass: 1,
        cp: {
          timeTable: [
            [0, 100],
            [10, 300],
          ],
        },
      },
      { id: "amb", type: "ambient", x: 1, y: 5, temperature: 300 },
    ],
    conductors: [
      {
        id: "c1",
        from: "s1",
        to: "amb",
        type: {
          kind: "conduction",
          k: {
            timeTable: [
              [0, 10],
              [10, 20],
            ],
          },
          area: 0.01,
          length: 0.1,
        },
      },
    ],
  };

  it("transient mode accepts cp/k time tables", () => {
    expect(validateNetwork(base)).toEqual([]);
  });

  it("steady mode REJECTS cp and k time tables explicitly (never silently t = 0)", () => {
    const steady: NetworkConfig = {
      ...base,
      settings: {
        ...base.settings,
        mode: "steady",
        dt: undefined,
        endTime: undefined,
      },
    };
    const errs = validateNetwork(steady);
    expect(
      errs.some(
        (e) =>
          e.includes("Solid node s1") && /timeTable.*transient mode/.test(e),
      ),
    ).toBe(true);
    expect(
      errs.some(
        (e) =>
          e.includes("Conductor c1") && /timeTable.*transient mode/.test(e),
      ),
    ).toBe(true);
    console.log(
      "[steady rejection]",
      errs.filter((e) => e.includes("timeTable")).join(" | "),
    );
  });

  it("the solver defends itself: a time table without a solve time throws", () => {
    // probeThermalSubsystem with no `t` — the thermal assembly must refuse to
    // evaluate the time curves rather than silently use t = 0 (the cp
    // storage term fires first here).
    const ctx = buildSolverContext(base);
    const state = createInitialState(ctx, base);
    expect(() =>
      probeThermalSubsystem(ctx, state, { dt: 1, prevState: state }),
    ).toThrow(/timeTable requires a transient solve time/);
    // Steady solve bypassing validation, with ONLY a k time table (constant
    // cp): the conductance read throws, naming the conductor.
    const steady: NetworkConfig = {
      ...base,
      settings: {
        ...base.settings,
        mode: "steady",
        dt: undefined,
        endTime: undefined,
      },
      solidNodes: [
        {
          id: "s1",
          type: "solid",
          x: 0,
          y: 5,
          temperature: 300,
          mass: 1,
          cp: 100,
        },
        { id: "amb", type: "ambient", x: 1, y: 5, temperature: 300 },
      ],
    };
    expect(() => solveSteady(steady)).toThrow(
      /c1.*timeTable requires a transient solve time/,
    );
  });
});

describe("timeTable cp: per-step cadence (fixed stepping)", () => {
  const m = 2; // kg
  const Q = 1000; // W heating
  const DT = 1; // s
  const STEPS = 15;
  // cp(t) = 100 + 20·t for t ≤ 10 s, clamped to 300 after.
  const cpOf = (t: number): number => (t <= 10 ? 100 + 20 * t : 300);
  const config: NetworkConfig = {
    meta: { name: "cp timeTable", version: 2 },
    settings: {
      mode: "transient",
      dt: DT,
      endTime: DT * STEPS,
      tolerance: 1e-9,
      maxIterations: 100,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    ...dummyFluid(),
    solidNodes: [
      {
        id: "mass",
        type: "solid",
        x: 0,
        y: 5,
        temperature: 300,
        mass: m,
        cp: {
          timeTable: [
            [0, 100],
            [10, 300],
          ],
        },
        heatInput: Q,
      },
    ],
  };

  it("matches the independent backward-Euler recurrence with cp frozen at the step END time", () => {
    const res = solveTransient(config);
    expect(res.converged).toBe(true);
    const trace = res.solidNodes!.mass.temperature;
    expect(trace.length).toBe(STEPS + 1);
    // Reference: T_n = T_{n−1} + Q·dt / (m·cp(t_n)) — the value at the END of
    // the step (backward Euler).  In particular step 1 uses cp(1) = 120, NOT
    // cp(0) = 100 (forward-Euler would give 305.0).
    const ref = [300];
    for (let n = 1; n <= STEPS; n++) {
      ref.push(ref[n - 1] + (Q * DT) / (m * cpOf(n * DT)));
    }
    let worst = 0;
    for (let n = 1; n <= STEPS; n++)
      worst = Math.max(worst, Math.abs(trace[n] - ref[n]));
    console.log(
      `[cp(t) cadence] worst |ΔT| vs BE recurrence: ${worst.toExponential(2)} K; T_1=${trace[1].toFixed(6)} (expect 304.166667)`,
    );
    expect(worst).toBeLessThan(1e-6);
    expect(trace[1]).toBeCloseTo(300 + (Q * DT) / (m * 120), 6); // endpoint, not t=0
  });

  it("differs macroscopically from the constant-cp twin (feature engaged)", () => {
    const twin: NetworkConfig = {
      ...config,
      solidNodes: [
        {
          id: "mass",
          type: "solid",
          x: 0,
          y: 5,
          temperature: 300,
          mass: m,
          cp: 100,
          heatInput: Q,
        },
      ],
    };
    const resVar = solveTransient(config);
    const resConst = solveTransient(twin);
    const t10Var = resVar.solidNodes!.mass.temperature[10];
    const t10Const = resConst.solidNodes!.mass.temperature[10]; // 300 + 10·5 = 350
    expect(t10Const).toBeCloseTo(350, 8);
    expect(t10Const - t10Var).toBeGreaterThan(5);
  });
});

describe("timeTable k: per-step cadence (fixed stepping)", () => {
  // Two ambient reservoirs (400 K / 300 K) joined by a conduction link whose
  // k ramps 10 → 1010 W/m/K over 10 s (clamped after).  No thermal mass, so
  // the RECORDED heat rate is exactly k(t)·A/L·ΔT at each recorded time.
  const A = 0.02;
  const L = 0.5;
  const config: NetworkConfig = {
    meta: { name: "k timeTable", version: 2 },
    settings: {
      mode: "transient",
      dt: 1,
      endTime: 12,
      tolerance: 1e-9,
      maxIterations: 100,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    ...dummyFluid(),
    solidNodes: [
      { id: "hot", type: "ambient", x: 0, y: 5, temperature: 400 },
      { id: "cold", type: "ambient", x: 1, y: 5, temperature: 300 },
    ],
    conductors: [
      {
        id: "cd",
        from: "hot",
        to: "cold",
        type: {
          kind: "conduction",
          k: {
            timeTable: [
              [0, 10],
              [10, 1010],
            ],
          },
          area: A,
          length: L,
        },
      },
    ],
  };

  it("recorded heat rate equals k(t)·A/L·ΔT at every recorded time (incl. clamping)", () => {
    const res = solveTransient(config);
    expect(res.converged).toBe(true);
    const curve = resolveSolidTimeProperty(
      {
        timeTable: [
          [0, 10],
          [10, 1010],
        ],
      },
      "k",
      "cd",
    )!;
    const heat = res.conductors!.cd.heatRate;
    expect(heat.length).toBe(res.times.length);
    for (let i = 0; i < res.times.length; i++) {
      const kNow = curve.value(res.times[i]); // 10 + 100·t (t ≤ 10), 1010 after
      const expected = ((kNow * A) / L) * (400 - 300);
      expect(Math.abs(heat[i] - expected), `t=${res.times[i]}`).toBeLessThan(
        1e-9 * Math.abs(expected),
      );
    }
    // Exact spot values: t=0 → k=10 → Q=40; t=5 → k=510 → Q=2040; t=11/12 → clamped k=1010 → Q=4040.
    expect(heat[0]).toBe(40);
    expect(heat[5]).toBeCloseTo(2040, 9);
    expect(heat[11]).toBeCloseTo(4040, 9);
    expect(heat[12]).toBeCloseTo(4040, 9);
    // And the pre-feature behaviour for a constant-k twin stays bit-stable.
    const twin: NetworkConfig = {
      ...config,
      conductors: [
        {
          id: "cd",
          from: "hot",
          to: "cold",
          type: { kind: "conduction", k: 10, area: A, length: L },
        },
      ],
    };
    const resConst = solveTransient(twin);
    for (const h of resConst.conductors!.cd.heatRate) expect(h).toBe(40);
  });
});

describe("timeTable + adaptive stepping", () => {
  // cp(t): ramps 200 → 400 over [0, 0.7] s (slope break at 0.7), then flat.
  // The knot at t = 0.7 is an adaptive EVENT: accepted steps must land on it.
  const Q = 800; // W
  const m = 1; // kg
  const cpOf = (t: number): number => (t <= 0.7 ? 200 + (200 / 0.7) * t : 400);
  const config: NetworkConfig = {
    meta: { name: "cp timeTable adaptive", version: 2 },
    settings: {
      mode: "transient",
      timeStepping: "adaptive",
      // dtInitial = dtMax forces the first (oversized) trial to be REJECTED,
      // so the run exercises the reject path deterministically.
      adaptive: { dtMin: 1e-3, dtMax: 0.5, relTol: 1e-6, dtInitial: 0.5 },
      endTime: 1.4,
      tolerance: 1e-9,
      maxIterations: 100,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    ...dummyFluid(),
    solidNodes: [
      {
        id: "mass",
        type: "solid",
        x: 0,
        y: 5,
        temperature: 300,
        mass: m,
        cp: {
          timeTable: [
            [0, 200],
            [0.7, 400],
            [1.4, 400],
          ],
        },
        heatInput: Q,
      },
    ],
  };

  it("lands exactly on the time-table knot, never straddles it", () => {
    const res = solveTransient(config);
    expect(res.converged).toBe(true);
    expect(res.times).toContain(0.7);
    for (let i = 1; i < res.times.length; i++) {
      const t0 = res.times[i - 1];
      const t1 = res.times[i];
      expect(t0 < 0.7 && t1 > 0.7).toBe(false);
    }
  });

  it("rejected trials leave no trace: the accepted history is exactly the half-step BE map", () => {
    const res = solveTransient(config);
    expect(res.converged).toBe(true);
    expect(res.stats!.rejectedSteps).toBeGreaterThan(0); // the test is vacuous otherwise
    // The accepted step t → t+dt is the step-doubling pair: TWO half-steps,
    // cp frozen at t+dt/2 and t+dt respectively (each a linear-residual
    // Newton solve, exact to machine precision here).
    const trace = res.solidNodes!.mass.temperature;
    const ref = [300];
    for (let i = 1; i < res.times.length; i++) {
      const dt = res.times[i] - res.times[i - 1];
      const tMid = res.times[i - 1] + dt / 2;
      const tEnd = res.times[i];
      const tHalf = ref[i - 1] + (Q * (dt / 2)) / (m * cpOf(tMid));
      ref.push(tHalf + (Q * (dt / 2)) / (m * cpOf(tEnd)));
    }
    let worst = 0;
    for (let i = 1; i < res.times.length; i++)
      worst = Math.max(worst, Math.abs(trace[i] - ref[i]));
    console.log(
      `[adaptive cp(t)] steps=${res.stats!.steps} rejected=${res.stats!.rejectedSteps} worst |ΔT| vs half-step map: ${worst.toExponential(2)} K`,
    );
    expect(worst).toBeLessThan(1e-8);
  });
});

/* --------------------------------------------------------------------------
 * B5. Text projection round-trip
 * ------------------------------------------------------------------------ */

describe("text projection round-trip of the new spec shapes", () => {
  it("expression cp and timeTable k round-trip losslessly and stably", () => {
    const config: NetworkConfig = {
      meta: { name: "tt round trip", version: 2 },
      settings: {
        mode: "transient",
        dt: 0.5,
        endTime: 2,
        tolerance: 1e-6,
        maxIterations: 50,
        gravity: { x: 0, y: -9.80665, z: 0 },
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
          x: 100,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      solidNodes: [
        {
          id: "s1",
          type: "solid",
          x: 0,
          y: 80,
          temperature: 300,
          mass: 1.5,
          cp: { expression: "300 + 0.5 * T", tRange: [100, 400] },
        },
        { id: "amb", type: "ambient", x: 50, y: 80, temperature: 290 },
      ],
      conductors: [
        {
          id: "c1",
          from: "s1",
          to: "amb",
          type: {
            kind: "conduction",
            k: {
              timeTable: [
                [0, 10],
                [5, 20],
              ],
            },
            area: 0.01,
            length: 0.2,
          },
        },
      ],
      branches: [
        {
          id: "b1",
          from: "f1",
          to: "f2",
          component: { type: "flowSource", massFlow: 0 },
        },
      ],
    };
    const text = serializeText(config);
    const result = parseText(text);
    expect(result.errors).toEqual([]);
    expect(result.config).toStrictEqual(config);
    expect(serializeText(result.config!)).toBe(text);
  });

  it("timeTable cp also round-trips (with adaptive settings intact)", () => {
    const config: NetworkConfig = {
      meta: { name: "tt round trip 2", version: 2 },
      settings: {
        mode: "transient",
        timeStepping: "adaptive",
        adaptive: { dtMin: 0.001, dtMax: 0.5, relTol: 1e-3 },
        endTime: 2,
        tolerance: 1e-6,
        maxIterations: 50,
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
          x: 100,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      solidNodes: [
        {
          id: "s1",
          type: "solid",
          x: 0,
          y: 80,
          temperature: 300,
          mass: 1.5,
          cp: {
            timeTable: [
              [0, 100],
              [1.5, 300],
            ],
          },
        },
        { id: "amb", type: "ambient", x: 50, y: 80, temperature: 290 },
      ],
      conductors: [
        {
          id: "c1",
          from: "s1",
          to: "f1",
          type: { kind: "convection", h: 10, area: 0.01 },
        },
        {
          id: "c2",
          from: "s1",
          to: "amb",
          type: {
            kind: "conduction",
            k: { expression: "100 * sqrt(T / 100)", tRange: [50, 400] },
            area: 0.01,
            length: 1,
          },
        },
      ],
      branches: [
        {
          id: "b1",
          from: "f1",
          to: "f2",
          component: { type: "flowSource", massFlow: 0 },
        },
      ],
    };
    const text = serializeText(config);
    const result = parseText(text);
    expect(result.errors).toEqual([]);
    expect(result.config).toStrictEqual(config);
    expect(serializeText(result.config!)).toBe(text);
  });
});

/* --------------------------------------------------------------------------
 * B6. Decode boundary: malformed variants carry paths
 * ------------------------------------------------------------------------ */

describe("decode boundary for the new spec shapes", () => {
  const base = {
    meta: { name: "decode", version: 2 },
    settings: {
      mode: "transient",
      dt: 1,
      endTime: 2,
      tolerance: 1e-6,
      maxIterations: 50,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "a",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
      {
        id: "b",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "br",
        from: "a",
        to: "b",
        component: { type: "flowSource", massFlow: 0 },
      },
    ],
  };

  function expectDecodeError(input: unknown, path: RegExp): void {
    try {
      decodeNetworkConfig(input);
      expect.unreachable("expected ConfigDecodeError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigDecodeError);
      expect((err as ConfigDecodeError).path).toMatch(path);
    }
  }

  it("rejects malformed timeTable rows with the spec path", () => {
    expectDecodeError(
      {
        ...base,
        solidNodes: [
          {
            id: "w",
            type: "solid",
            x: 0,
            y: 0,
            temperature: 300,
            cp: { timeTable: [null, null] },
          },
        ],
      },
      /^solidNodes\[0\]\.cp\.timeTable\[0\]$/,
    );
    expectDecodeError(
      {
        ...base,
        solidNodes: [
          {
            id: "w",
            type: "solid",
            x: 0,
            y: 0,
            temperature: 300,
            mass: 1,
            cp: 500,
          },
          { id: "amb", type: "ambient", x: 1, y: 0, temperature: 300 },
        ],
        conductors: [
          {
            id: "c",
            from: "w",
            to: "amb",
            type: {
              kind: "conduction",
              k: { timeTable: [[0, 1], 5] },
              area: 0.01,
              length: 0.1,
            },
          },
        ],
      },
      /^conductors\[0\]\.type\.k\.timeTable\[1\]$/,
    );
  });

  it("rejects a malformed tRange with the spec path", () => {
    expectDecodeError(
      {
        ...base,
        solidNodes: [
          {
            id: "w",
            type: "solid",
            x: 0,
            y: 0,
            temperature: 300,
            cp: { expression: "T", tRange: "soon" },
          },
        ],
      },
      /^solidNodes\[0\]\.cp\.tRange$/,
    );
    expectDecodeError(
      {
        ...base,
        solidNodes: [
          {
            id: "w",
            type: "solid",
            x: 0,
            y: 0,
            temperature: 300,
            mass: 1,
            cp: 500,
          },
          { id: "amb", type: "ambient", x: 1, y: 0, temperature: 300 },
        ],
        conductors: [
          {
            id: "c",
            from: "w",
            to: "amb",
            type: {
              kind: "conduction",
              k: { expression: "T", tRange: [100] },
              area: 0.01,
              length: 0.1,
            },
          },
        ],
      },
      /^conductors\[0\]\.type\.k\.tRange$/,
    );
  });

  it("structurally-sound new variants decode and validate (round through the boundary)", () => {
    const decoded = decodeNetworkConfig({
      ...base,
      solidNodes: [
        {
          id: "w",
          type: "solid",
          x: 0,
          y: 0,
          temperature: 300,
          mass: 1,
          cp: { expression: "300 + 0.5 * T", tRange: [100, 400] },
        },
        { id: "amb", type: "ambient", x: 1, y: 0, temperature: 300 },
      ],
      conductors: [
        {
          id: "c",
          from: "w",
          to: "amb",
          type: {
            kind: "conduction",
            k: {
              timeTable: [
                [0, 10],
                [2, 20],
              ],
            },
            area: 0.01,
            length: 0.1,
          },
        },
      ],
    });
    expect(validateNetwork(decoded)).toEqual([]);
  });
});
