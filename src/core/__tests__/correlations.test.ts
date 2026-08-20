import { describe, it, expect, beforeAll } from "vitest";
import { NetworkConfig } from "../schema";
import { initRealFluids, realFluidsReady, RealFluid } from "../";
import { solveSteady } from "../solver";
import { solveTransient } from "../transient";
import { validateNetwork } from "../validate";
import { evaluateConvectionH } from "../correlations";
import type {
  CorrelationConductor,
  CorrelationCtx,
  CorrelationState,
} from "../correlations";

beforeAll(async () => {
  await initRealFluids();
  expect(realFluidsReady()).toBe(true);
}, 30000);

/* =============================================================================
 * 1. Thermal-conductivity spot check
 * ============================================================================= */
describe("Thermal conductivity (k) spot check", () => {
  it("N2 gas k ≈ 0.0259 W/mK at 300 K / 1 atm ±3%", () => {
    const fluid = new RealFluid("Nitrogen");
    const P = 101325;
    const T = 300;
    const h = fluid.enthalpyPT(P, T);
    const state = fluid.statePH(P, h);
    expect(state.k).toBeDefined();
    expect(Math.abs(state.k! - 0.0259) / 0.0259).toBeLessThan(0.03);
  });

  it("Water liquid k ≈ 0.61 W/mK at 300 K / 1 atm ±3%", () => {
    const fluid = new RealFluid("Water");
    const P = 101325;
    const T = 300;
    const h = fluid.enthalpyPT(P, T);
    const state = fluid.statePH(P, h);
    expect(state.k).toBeDefined();
    expect(Math.abs(state.k! - 0.61) / 0.61).toBeLessThan(0.03);
  });
});

/* =============================================================================
 * 2. Dittus–Boelter hand-calc
 * ============================================================================= */
describe("Dittus–Boelter correlation", () => {
  it("steady water pipe: reported h matches hand calc within 1%; Q consistent", () => {
    const fluid = new RealFluid("Water");
    const D = 0.03;
    const Aflow = (Math.PI / 4) * D * D;
    const mdot = 0.5;

    const config: NetworkConfig = {
      meta: { name: "db-test", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "realFluid", params: { fluidName: "Water" } },
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
          component: { type: "pipe", length: 2, diameter: D, roughness: 1e-5 },
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
            correlation: {
              model: "dittusBoelter",
              diameter: D,
              flowArea: Aflow,
            },
          },
        },
      ],
    };

    expect(validateNetwork(config)).toEqual([]);
    const res = solveSteady(config);
    expect(res.converged).toBe(true);

    const Pmid = res.nodes.mid.pressure;
    const Tmid = res.nodes.mid.temperature;
    const hNode = fluid.enthalpyPT(Pmid, Tmid);
    const ph = fluid.statePH(Pmid, hNode);
    const mu = ph.mu;
    const k = ph.k!;
    const cp = ph.cp!;

    const Gnode =
      (0.5 * (Math.abs(mdot) + Math.abs(res.branches.b2.mdot))) / Aflow;
    const Re = (Gnode * D) / mu;
    const Pr = (cp * mu) / k;
    const NuTurb = 0.023 * Math.pow(Re, 0.8) * Math.pow(Pr, 0.4);
    let Nu: number;
    if (Re < 2000) {
      Nu = 3.66;
    } else if (Re >= 4000) {
      Nu = NuTurb;
    } else {
      const t = (Re - 2000) / 2000;
      Nu = 3.66 * (1 - t) + NuTurb * t;
    }
    const hCalc = (Nu * k) / D;

    const hReported = res.conductors!.conv1.heatTransferCoeff!;
    expect(Math.abs(hReported - hCalc) / hCalc).toBeLessThan(0.01);

    const Qreported = res.conductors!.conv1.heatRate;
    const dT = res.nodes.mid.temperature - res.solidNodes!.wall.temperature;
    // Avoid division-by-zero: assert absolute difference is ~0
    expect(Math.abs(Qreported - hReported * 0.01 * dT)).toBeCloseTo(0, 9);
  }, 20000);
});

/* =============================================================================
 * 2b. Custom model: a user-written Dittus–Boelter expression must agree with
 *     the built-in correlation on the same real-fluid state.
 * ============================================================================= */
describe("Custom correlation model (Dittus–Boelter equivalence)", () => {
  const DB_EXPR = "0.023 * (G * D / mu)^0.8 * (cp * mu / k)^0.4 * k / D";

  function waterCtx(): CorrelationCtx {
    return {
      fluid: new RealFluid("Water"),
      isRealFluid: true,
      branches: [{ id: "b1", from: "A", to: "B" }],
      nBranch: 1,
      nodeMap: new Map([
        ["A", { id: "A", type: "internal" }],
        ["B", { id: "B", type: "boundary" }],
        ["WALL", { id: "WALL", type: "boundary" }],
      ]),
    };
  }

  it("unit level: custom expression ≈ built-in dittusBoelter across flow rates", () => {
    const fluid = new RealFluid("Water");
    const P = 2e5;
    const T = 350;
    const D = 0.03;
    const Aflow = (Math.PI / 4) * D * D;
    const builtin: CorrelationConductor = {
      id: "conv0",
      from: "A",
      to: "WALL",
      type: {
        kind: "convection",
        area: 0.01,
        correlation: { model: "dittusBoelter", diameter: D, flowArea: Aflow },
      },
    };
    const custom: CorrelationConductor = {
      id: "conv0",
      from: "A",
      to: "WALL",
      type: {
        kind: "convection",
        area: 0.01,
        correlation: {
          model: "custom",
          expression: DB_EXPR,
          diameter: D,
          flowArea: Aflow,
        },
      },
    };
    const ctx = waterCtx();
    // Fully turbulent flow only: the built-in dittusBoelter blends to
    // laminar Nu = 3.66 below Re = 4000; the custom expression under test
    // is the pure TURBULENT form, so agreement is asserted where that form
    // is the active branch.
    for (const mdot of [0.5, 5, 50]) {
      const state: CorrelationState = {
        nodeP: new Map([["A", P]]),
        nodeT: new Map([["A", T]]),
        nodeH: new Map([["A", fluid.enthalpyPT(P, T)]]),
        mdots: [mdot],
      };
      const hBuiltin = evaluateConvectionH(builtin, ctx, state);
      const hCustom = evaluateConvectionH(custom, ctx, state);
      // Same property access + same arithmetic up to association order.
      expect(Math.abs(hCustom - hBuiltin) / hBuiltin).toBeLessThan(1e-9);
    }
  });

  it("solve level: reported h matches the built-in dittusBoelter solve closely", () => {
    const D = 0.03;
    const Aflow = (Math.PI / 4) * D * D;
    const mdot = 0.5;
    type Correlation = NonNullable<
      Extract<
        NonNullable<NetworkConfig["conductors"]>[number]["type"],
        { kind: "convection" }
      >["correlation"]
    >;

    const build = (correlation: Correlation): NetworkConfig => ({
      meta: { name: "db-custom-test", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "realFluid", params: { fluidName: "Water" } },
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
          component: { type: "pipe", length: 2, diameter: D, roughness: 1e-5 },
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
          type: { kind: "convection", area: 0.01, correlation },
        },
      ],
    });

    const resBuiltin = solveSteady(
      build({ model: "dittusBoelter", diameter: D, flowArea: Aflow }),
    );
    const customConfig = build({
      model: "custom",
      expression: DB_EXPR,
      diameter: D,
      flowArea: Aflow,
    });
    expect(validateNetwork(customConfig)).toEqual([]);
    const resCustom = solveSteady(customConfig);
    expect(resBuiltin.converged).toBe(true);
    expect(resCustom.converged).toBe(true);

    const hBuiltin = resBuiltin.conductors!.conv1.heatTransferCoeff!;
    const hCustom = resCustom.conductors!.conv1.heatTransferCoeff!;
    expect(Math.abs(hCustom - hBuiltin) / hBuiltin).toBeLessThan(1e-9);
    // Heat rates track the h values equally closely.
    const qBuiltin = resBuiltin.conductors!.conv1.heatRate;
    const qCustom = resCustom.conductors!.conv1.heatRate;
    expect(Math.abs(qCustom - qBuiltin) / Math.abs(qBuiltin)).toBeLessThan(
      1e-9,
    );
  }, 20000);
});

/* =============================================================================
 * 3. Miropolskii hand-calc
 * ============================================================================= */
describe("Miropolskii correlation", () => {
  const P = 101325;
  const D = 0.05;
  const Aflow = (Math.PI / 4) * D * D;
  const Aconv = 0.01;

  function buildConfig(mdot: number): NetworkConfig {
    return {
      meta: { name: "miro-test", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-8,
        maxIterations: 500,
        relaxation: 0.5,
      },
      fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
      nodes: [
        { id: "in", type: "boundary", x: 0, y: 0, pressure: P, quality: 0.5 },
        { id: "mid", type: "internal", x: 1, y: 0, pressure: P, quality: 0.5 },
        { id: "out", type: "boundary", x: 2, y: 0, pressure: P, quality: 0.5 },
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
          component: { type: "flowSource", massFlow: mdot },
        },
      ],
      solidNodes: [{ id: "wall", type: "solid", x: 1, y: 1, temperature: 100 }],
      conductors: [
        {
          id: "conv1",
          from: "mid",
          to: "wall",
          type: {
            kind: "convection",
            area: Aconv,
            correlation: { model: "miropolskii", diameter: D, flowArea: Aflow },
          },
        },
      ],
    };
  }

  function handCalcH(mdot: number, quality: number): number {
    const fluid = new RealFluid("Nitrogen");
    const sat = fluid.saturationProperties(P);
    const x = Math.max(0.01, Math.min(0.99, quality));
    const G = (0.5 * (Math.abs(mdot) + Math.abs(mdot))) / Aflow;
    const Re_g = (G * D) / sat.mug;
    const Pr_g = (sat.cpg * sat.mug) / sat.kg;
    const Y =
      1 - 0.1 * Math.pow(sat.rhof / sat.rhog - 1, 0.4) * Math.pow(1 - x, 0.4);
    const Nu =
      0.023 *
      Math.pow(Re_g * (x + (sat.rhog / sat.rhof) * (1 - x)), 0.8) *
      Math.pow(Pr_g, 0.4) *
      Y;
    return (Nu * sat.kg) / D;
  }

  it("two-phase node: reported h matches hand calc within 1%", () => {
    const mdot = 0.2;
    const config = buildConfig(mdot);
    expect(validateNetwork(config)).toEqual([]);
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    const q = res.nodes.mid.quality ?? 0;
    const hReported = res.conductors!.conv1.heatTransferCoeff!;
    const hCalc = handCalcH(mdot, q);
    expect(Math.abs(hReported - hCalc) / hCalc).toBeLessThan(0.01);
  }, 20000);

  it("h increases with mass flux", () => {
    const resLow = solveSteady(buildConfig(0.1));
    const resHigh = solveSteady(buildConfig(0.4));
    expect(resLow.converged).toBe(true);
    expect(resHigh.converged).toBe(true);
    const hLow = resLow.conductors!.conv1.heatTransferCoeff!;
    const hHigh = resHigh.conductors!.conv1.heatTransferCoeff!;
    expect(hHigh).toBeGreaterThan(hLow);
  }, 20000);
});

/* =============================================================================
 * 4. Single-phase fallback (miropolskii on single-phase node)
 * ============================================================================= */
describe("Miropolskii single-phase fallback", () => {
  it("falls back to DB-consistent h on a subcooled liquid node", () => {
    const fluid = new RealFluid("Water");
    const P = 2e5;
    const T = 350;
    const D = 0.03;
    const Aflow = (Math.PI / 4) * D * D;
    const mdot = 0.5;

    const config: NetworkConfig = {
      meta: { name: "miro-fallback", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "realFluid", params: { fluidName: "Water" } },
      nodes: [
        { id: "in", type: "boundary", x: 0, y: 0, pressure: P, temperature: T },
        {
          id: "mid",
          type: "internal",
          x: 1,
          y: 0,
          pressure: P,
          temperature: T,
        },
        {
          id: "out",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: 1e5,
          temperature: T,
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
          component: { type: "pipe", length: 2, diameter: D, roughness: 1e-5 },
        },
      ],
      solidNodes: [{ id: "wall", type: "solid", x: 1, y: 1, temperature: 400 }],
      conductors: [
        {
          id: "conv1",
          from: "mid",
          to: "wall",
          type: {
            kind: "convection",
            area: 0.01,
            correlation: { model: "miropolskii", diameter: D, flowArea: Aflow },
          },
        },
      ],
    };

    expect(validateNetwork(config)).toEqual([]);
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(res.nodes.mid.phase).toBe("liquid");

    const hReported = res.conductors!.conv1.heatTransferCoeff!;

    const Pmid = res.nodes.mid.pressure;
    const Tmid = res.nodes.mid.temperature;
    const hNode = fluid.enthalpyPT(Pmid, Tmid);
    const ph = fluid.statePH(Pmid, hNode);
    const mu = ph.mu;
    const k = ph.k!;
    const cp = ph.cp!;
    const Gnode =
      (0.5 * (Math.abs(mdot) + Math.abs(res.branches.b2.mdot))) / Aflow;
    const Re = (Gnode * D) / mu;
    const Pr = (cp * mu) / k;
    const NuTurb = 0.023 * Math.pow(Re, 0.8) * Math.pow(Pr, 0.4);
    let Nu: number;
    if (Re < 2000) {
      Nu = 3.66;
    } else if (Re >= 4000) {
      Nu = NuTurb;
    } else {
      const t = (Re - 2000) / 2000;
      Nu = 3.66 * (1 - t) + NuTurb * t;
    }
    const hCalc = (Nu * k) / D;

    expect(Math.abs(hReported - hCalc) / hCalc).toBeLessThan(0.01);
  }, 20000);
});

/* =============================================================================
 * 5. Regression: constant-h conductor must be bit-identical to pre-change
 * ============================================================================= */
describe("Constant-h regression", () => {
  it("produces identical results to 1e-12 relative", () => {
    const h = 100;
    const A = 0.01;
    const Tamb = 400;
    const Tfluid = 300;

    const config: NetworkConfig = {
      meta: { name: "regression", version: 2 },
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
          temperature: Tfluid,
        },
      ],
      solidNodes: [
        { id: "a1", type: "ambient", x: 0, y: 0, temperature: Tamb },
        { id: "s1", type: "solid", x: 1, y: 0, temperature: 350 },
      ],
      conductors: [
        {
          id: "cond1",
          from: "a1",
          to: "s1",
          type: { kind: "conduction", k: 10, area: A, length: 0.1 },
        },
        {
          id: "conv1",
          from: "s1",
          to: "f1",
          type: { kind: "convection", h, area: A },
        },
      ],
      branches: [
        {
          id: "dummy",
          from: "f1",
          to: "f1",
          component: { type: "flowSource", massFlow: 0 },
        },
      ],
    };

    const res = solveSteady(config);
    expect(res.converged).toBe(true);

    const Rcond = 0.1 / (10 * A);
    const Rconv = 1 / (h * A);
    const expectedQ = (Tamb - Tfluid) / (Rcond + Rconv);
    const actualQ = res.conductors!.conv1.heatRate;
    expect(Math.abs(actualQ - expectedQ) / expectedQ).toBeLessThan(1e-12);

    expect(res.conductors!.conv1.heatTransferCoeff).toBe(h);
  });
});

/* =============================================================================
 * 6. Mini-chilldown sanity
 * ============================================================================= */
describe("Mini-chilldown sanity", () => {
  it("3-segment cold two-phase flow chills warm walls; h varies, no NaN", () => {
    const P = 101325;
    const mdot = 0.1;
    const endTime = 2.0;
    const dt = 0.01;

    // Vary diameter per segment so G and h vary along the line
    const segments = [
      { id: "n1", wall: "w1", D: 0.025 },
      { id: "n2", wall: "w2", D: 0.02 },
      { id: "n3", wall: "w3", D: 0.015 },
    ];

    const nodes: NetworkConfig["nodes"] = [
      { id: "in", type: "boundary", x: 0, y: 0, pressure: P, quality: 0.2 },
      ...segments.map((s) => ({
        id: s.id,
        type: "internal" as const,
        x: 0,
        y: 0,
        pressure: P,
        quality: 0.2,
        volume: 1e-4,
      })),
      { id: "out", type: "boundary", x: 0, y: 0, pressure: P, quality: 0.2 },
    ];

    const branches: NetworkConfig["branches"] = [
      {
        id: "b0",
        from: "in",
        to: "n1",
        component: { type: "flowSource", massFlow: mdot },
      },
      ...segments.map((s, i) => ({
        id: `b${i + 1}`,
        from: s.id,
        to: i === segments.length - 1 ? "out" : segments[i + 1].id,
        component: {
          type: "pipe" as const,
          length: 0.1,
          diameter: s.D,
          roughness: 1e-5,
        },
      })),
    ];

    const solidNodes: NetworkConfig["solidNodes"] = segments.map((s) => ({
      id: s.wall,
      type: "solid" as const,
      x: 0,
      y: 0,
      temperature: 300,
      mass: 0.05,
      cp: 800,
    }));

    const conductors: NetworkConfig["conductors"] = segments.map((s) => {
      const Aflow = (Math.PI / 4) * s.D * s.D;
      const Aconv = 0.005;
      return {
        id: `c${s.id.slice(1)}`,
        from: s.id,
        to: s.wall,
        type: {
          kind: "convection" as const,
          area: Aconv,
          correlation: {
            model: "miropolskii" as const,
            diameter: s.D,
            flowArea: Aflow,
          },
        },
      };
    });

    const config: NetworkConfig = {
      meta: { name: "chilldown", version: 2 },
      settings: {
        mode: "transient",
        dt,
        endTime,
        tolerance: 1e-6,
        maxIterations: 200,
        relaxation: 0.5,
      },
      fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
      nodes,
      branches,
      solidNodes,
      conductors,
    };

    expect(validateNetwork(config)).toEqual([]);
    const res = solveTransient(config);
    expect(res.converged).toBe(true);

    // No NaN in wall temperatures and walls cool monotonically
    for (const s of segments) {
      const temps = res.solidNodes![s.wall].temperature;
      expect(temps.some((t) => !isFinite(t))).toBe(false);
      for (let i = 1; i < temps.length; i++) {
        expect(temps[i]).toBeLessThanOrEqual(temps[i - 1] + 1e-6);
      }
    }

    // Effective h varies along the line at the final step
    const hValues = segments.map((s) =>
      res.conductors![`c${s.id.slice(1)}`].heatTransferCoeff!.at(-1)!,
    );
    const hMin = Math.min(...hValues);
    const hMax = Math.max(...hValues);
    const hRange = hMax - hMin;
    expect(hRange).toBeGreaterThan(0);
    console.log(
      `Mini-chilldown h range: ${hMin.toFixed(1)} – ${hMax.toFixed(1)} W/m²K (range ${hRange.toFixed(1)})`,
    );
  }, 20000);
});
