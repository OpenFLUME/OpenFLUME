/**
 * ClosureParams — resolution semantics, structural exclusion of solver
 * numerics, bit-identity of the default path, and end-to-end plumbing.
 *
 * The load-bearing guarantees:
 *   1. `closureParams` unspecified  ≡  `closureParams` fully defaulted
 *      (bit-identical arithmetic — strict `toBe` / deep `toEqual` checks,
 *      never tolerances).
 *   2. Numerical-hack knobs (relaxation, floors, blend sharpness, trust
 *      region, thresholds, iteration caps, FD steps) are STRUCTURALLY
 *      unreachable: no fields exist, and the resolver drops unknown keys.
 *   3. Non-default parameters demonstrably REACH the physics (otherwise
 *      the calibration surface would be dead wiring).
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  DEFAULT_CLOSURE_PARAMS,
  resolveClosureParams,
  validateClosureParams,
} from "../closureParams";
import {
  darcyFrictionFactor,
  darcyFrictionFactorDual,
  Pipe,
  Bend,
  HeatedPipe,
} from "../components";
import {
  evaluateConvectionH,
  FALLBACK_H_FLOOR,
  H_RELAX,
  type CorrelationConductor,
  type CorrelationCtx,
  type CorrelationState,
} from "../correlations";
import { constant } from "../dual";
import { initRealFluids, realFluidsReady } from "../fluids/coolprop";
import { RealFluid } from "../fluids/realFluid";
import type { NetworkConfig } from "../schema";
import { validateNetwork } from "../validate";
import { solveTransient } from "../transient";
import { buildSolverContext } from "../solver";
import { getSolidMaterialTable } from "../solidProperties";

// ---------------------------------------------------------------------------
// Resolution & structural exclusion (no fluids needed)
// ---------------------------------------------------------------------------

describe("ClosureParams resolution", () => {
  it("undefined resolves to the published defaults", () => {
    expect(resolveClosureParams(undefined)).toEqual(DEFAULT_CLOSURE_PARAMS);
  });

  it("published defaults are pinned exactly (bit-identity anchor)", () => {
    expect(DEFAULT_CLOSURE_PARAMS).toEqual({
      dittusBoelter: {
        leadingCoefficient: 0.023,
        reynoldsExponent: 0.8,
        prandtlExponent: 0.4,
      },
      miropolskii: {
        leadingCoefficient: 0.023,
        reynoldsExponent: 0.8,
        prandtlExponent: 0.4,
        yCoefficient: 0.1,
        yDensityExponent: 0.4,
        yQualityExponent: 0.4,
      },
      swameeJain: {
        leadingCoefficient: 0.25,
        roughnessDivisor: 3.7,
        reynoldsCoefficient: 5.74,
        reynoldsExponent: 0.9,
      },
      solidCpScale: 1,
    });
  });

  it("partial overrides merge over defaults; untouched groups stay default", () => {
    const r = resolveClosureParams({
      miropolskii: { leadingCoefficient: 0.03 },
    });
    expect(r.miropolskii.leadingCoefficient).toBe(0.03);
    expect(r.miropolskii).toEqual({
      ...DEFAULT_CLOSURE_PARAMS.miropolskii,
      leadingCoefficient: 0.03,
    });
    expect(r.dittusBoelter).toEqual(DEFAULT_CLOSURE_PARAMS.dittusBoelter);
    expect(r.swameeJain).toEqual(DEFAULT_CLOSURE_PARAMS.swameeJain);
    expect(r.solidCpScale).toBe(1);
  });

  it("STRUCTURAL EXCLUSION: solver-numerics keys are dropped by the resolver", () => {
    // Smuggle every numerical-hack knob a calibration must never touch.
    const smuggled = {
      hRelax: 0.99,
      H_RELAX: 0.99,
      FALLBACK_H_FLOOR: 42,
      trustRegionDelta: 5,
      ptcDeltaTau: 1e6,
      zeroFlowThreshold: 1,
      blendSharpness: 1000,
      maxIterations: 1,
      fdStep: 1e-9,
      dittusBoelter: { laminarNusselt: 9.99, blendLoRe: 1 },
      swameeJain: { laminarCoefficient: 32 },
      miropolskii: { qualityClamp: 0.5 },
    };
    const r = resolveClosureParams(smuggled as never);
    // Deep-equals the defaults AND carries none of the smuggled keys:
    // each resolved group has EXACTLY the default group's keys.
    expect(r).toEqual(DEFAULT_CLOSURE_PARAMS);
    expect(Object.keys(r.dittusBoelter).sort()).toEqual(
      Object.keys(DEFAULT_CLOSURE_PARAMS.dittusBoelter).sort(),
    );
    expect(Object.keys(r.miropolskii).sort()).toEqual(
      Object.keys(DEFAULT_CLOSURE_PARAMS.miropolskii).sort(),
    );
    expect(Object.keys(r.swameeJain).sort()).toEqual(
      Object.keys(DEFAULT_CLOSURE_PARAMS.swameeJain).sort(),
    );
    expect("hRelax" in r).toBe(false);
    expect("FALLBACK_H_FLOOR" in r).toBe(false);
    // The numerics constants still live where they always lived (untouched):
    expect(H_RELAX).toBe(0.5);
    expect(FALLBACK_H_FLOOR).toBe(5);
  });

  it("explicit undefined values fall back to defaults", () => {
    const r = resolveClosureParams({
      swameeJain: { reynoldsExponent: undefined, reynoldsCoefficient: 6.0 },
    });
    expect(r.swameeJain.reynoldsExponent).toBe(0.9);
    expect(r.swameeJain.reynoldsCoefficient).toBe(6.0);
  });
});

describe("ClosureParams validation", () => {
  it("accepts defaults and sensible overrides", () => {
    expect(validateClosureParams({})).toEqual([]);
    expect(
      validateClosureParams({
        miropolskii: { leadingCoefficient: 0.03, yCoefficient: 0 },
        solidCpScale: 1.2,
      }),
    ).toEqual([]);
  });

  it("rejects non-positive / non-finite values", () => {
    const errs = validateClosureParams({
      dittusBoelter: { leadingCoefficient: -0.023 },
      miropolskii: { yCoefficient: -1 },
      swameeJain: { roughnessDivisor: NaN },
      solidCpScale: 0,
    });
    expect(errs.length).toBe(4);
    expect(errs.join(" ")).toMatch(/dittusBoelter\.leadingCoefficient/);
    expect(errs.join(" ")).toMatch(/miropolskii\.yCoefficient/);
    expect(errs.join(" ")).toMatch(/swameeJain\.roughnessDivisor/);
    expect(errs.join(" ")).toMatch(/solidCpScale/);
  });

  it("validateNetwork surfaces closureParams errors", () => {
    const cfg = minimalNetwork();
    cfg.closureParams = { solidCpScale: -1 };
    const errs = validateNetwork(cfg);
    expect(errs.some((e) => e.includes("closureParams.solidCpScale"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Friction bit-identity (no fluids needed)
// ---------------------------------------------------------------------------

describe("Swamee–Jain closure plumbing", () => {
  const RE_SWEEP = [
    1,
    10,
    100,
    1000,
    2299,
    2300,
    2301,
    3000,
    3999,
    4000,
    4001,
    1e4,
    1e5,
    1e6,
    1e7,
    1e8,
    Infinity,
  ];
  const EPS_D = [0, 1e-6, 1e-4, 1e-2];

  it("scalar path: explicit defaults are strictly identical to omitted", () => {
    for (const Re of RE_SWEEP) {
      for (const e of EPS_D) {
        expect(
          darcyFrictionFactor(Re, e, DEFAULT_CLOSURE_PARAMS.swameeJain),
        ).toBe(darcyFrictionFactor(Re, e));
      }
    }
  });

  it("dual path: value AND derivative strictly identical to omitted", () => {
    for (const Re of RE_SWEEP) {
      for (const e of EPS_D) {
        const a = darcyFrictionFactorDual(
          constant(Re),
          e,
          DEFAULT_CLOSURE_PARAMS.swameeJain,
        );
        const b = darcyFrictionFactorDual(constant(Re), e);
        expect(a.v).toBe(b.v);
        expect(a.d).toBe(b.d);
      }
    }
  });

  it("component level: Pipe/Bend with explicit defaults are strictly identical", () => {
    const sj = DEFAULT_CLOSURE_PARAMS.swameeJain;
    for (const mdot of [-5, -0.01, 0.01, 0.1, 1, 50]) {
      const p1 = new Pipe(10, 0.05, 1e-5);
      const p2 = new Pipe(10, 0.05, 1e-5, 0, sj);
      expect(p2.pressureDrop(mdot, 1000, 1e-3)).toBe(
        p1.pressureDrop(mdot, 1000, 1e-3),
      );
      const d1 = p1.pressureDropDual!(constant(mdot), 1000, 1e-3);
      const d2 = p2.pressureDropDual!(constant(mdot), 1000, 1e-3);
      expect(d2.v).toBe(d1.v);
      expect(d2.d).toBe(d1.d);

      const b1 = new Bend(0.05, 90, 2, 1e-5);
      const b2 = new Bend(0.05, 90, 2, 1e-5, sj);
      expect(b2.pressureDrop(mdot, 1000, 1e-3)).toBe(
        b1.pressureDrop(mdot, 1000, 1e-3),
      );
    }
  });

  it("non-default Swamee–Jain constants REACH the friction factor", () => {
    const Re = 1e5;
    const e = 1e-4;
    const base = darcyFrictionFactor(Re, e);
    const bumped = darcyFrictionFactor(Re, e, {
      ...DEFAULT_CLOSURE_PARAMS.swameeJain,
      reynoldsCoefficient: 2 * 5.74,
    });
    expect(bumped).toBeGreaterThan(base); // larger Re-term ⇒ larger f
  });
});

// ---------------------------------------------------------------------------
// Convection bit-identity + reachability (real fluids)
// ---------------------------------------------------------------------------

describe("Convection closure plumbing", () => {
  beforeAll(async () => {
    await initRealFluids();
    expect(realFluidsReady()).toBe(true);
  }, 30000);

  function waterCtx(
    closureParams?: typeof DEFAULT_CLOSURE_PARAMS,
  ): CorrelationCtx {
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
      ...(closureParams ? { closureParams } : {}),
    };
  }

  const DB_COND: CorrelationConductor = {
    id: "conv0",
    from: "A",
    to: "WALL",
    type: {
      kind: "convection",
      area: 1,
      correlation: { model: "dittusBoelter", diameter: 0.1 },
    },
  };

  it("Dittus–Boelter: explicit defaults strictly identical to omitted", () => {
    const fluid = new RealFluid("Water");
    const P = 1e5;
    const T = 300;
    for (const mdot of [0.5, 5, 50]) {
      const state: CorrelationState = {
        nodeP: new Map([["A", P]]),
        nodeT: new Map([["A", T]]),
        nodeH: new Map([["A", fluid.enthalpyPT(P, T)]]),
        mdots: [mdot],
      };
      expect(
        evaluateConvectionH(DB_COND, waterCtx(DEFAULT_CLOSURE_PARAMS), state),
      ).toBe(evaluateConvectionH(DB_COND, waterCtx(), state));
    }
  });

  it("Miropolskii (two-phase): explicit defaults strictly identical to omitted", () => {
    const fluid = new RealFluid("Nitrogen");
    const P = 5e5;
    const sat = fluid.saturationProperties(P);
    const hMix = 0.5 * (sat.hf + sat.hg); // quality 0.5 — two-phase
    const cond: CorrelationConductor = {
      id: "conv0",
      from: "A",
      to: "WALL",
      type: {
        kind: "convection",
        area: 1,
        correlation: { model: "miropolskii", diameter: 0.015875 },
      },
    };
    const ctx: CorrelationCtx = {
      fluid,
      isRealFluid: true,
      branches: [
        { id: "b1", from: "F0", to: "A" },
        { id: "b2", from: "A", to: "F2" },
      ],
      nBranch: 2,
      nodeMap: new Map([
        ["F0", { id: "F0", type: "boundary" }],
        ["A", { id: "A", type: "internal" }],
        ["F2", { id: "F2", type: "boundary" }],
        ["WALL", { id: "WALL", type: "boundary" }],
      ]),
    };
    const ctxDefaulted: CorrelationCtx = {
      ...ctx,
      closureParams: DEFAULT_CLOSURE_PARAMS,
    };
    for (const mdot of [0.02, 0.2, 2]) {
      const state: CorrelationState = {
        nodeP: new Map([["A", P]]),
        nodeT: new Map([["A", sat.Tsat]]),
        nodeH: new Map([["A", hMix]]),
        mdots: [mdot, mdot],
      };
      const hOmitted = evaluateConvectionH(cond, ctx, state);
      const hDefaulted = evaluateConvectionH(cond, ctxDefaulted, state);
      expect(hDefaulted).toBe(hOmitted);
      expect(hOmitted).toBeGreaterThan(FALLBACK_H_FLOOR); // not the floor: a real evaluation
    }
  });

  it("closure constants REACH the convection h (both models)", () => {
    const fluid = new RealFluid("Nitrogen");
    const P = 5e5;
    const sat = fluid.saturationProperties(P);
    const hMix = 0.5 * (sat.hf + sat.hg);
    const cond: CorrelationConductor = {
      id: "conv0",
      from: "A",
      to: "WALL",
      type: {
        kind: "convection",
        area: 1,
        correlation: { model: "miropolskii", diameter: 0.015875 },
      },
    };
    const baseCtx: CorrelationCtx = {
      fluid,
      isRealFluid: true,
      branches: [{ id: "b1", from: "F0", to: "A" }],
      nBranch: 1,
      nodeMap: new Map([
        ["F0", { id: "F0", type: "boundary" }],
        ["A", { id: "A", type: "internal" }],
        ["WALL", { id: "WALL", type: "boundary" }],
      ]),
      closureParams: DEFAULT_CLOSURE_PARAMS,
    };
    const state: CorrelationState = {
      nodeP: new Map([["A", P]]),
      nodeT: new Map([["A", sat.Tsat]]),
      nodeH: new Map([["A", hMix]]),
      mdots: [0.2],
    };
    const h0 = evaluateConvectionH(cond, baseCtx, state);
    const doubled = resolveClosureParams({
      miropolskii: { leadingCoefficient: 2 * 0.023 },
    });
    const h1 = evaluateConvectionH(
      cond,
      { ...baseCtx, closureParams: doubled },
      state,
    );
    // h is linear in the leading coefficient (no floor binding: h0 >> 5)
    expect(Math.abs(h1 / h0 - 2)).toBeLessThan(1e-12);

    // Y-coefficient zeroing must RAISE film-boiling h (Y ≤ 1 by construction)
    const noY = resolveClosureParams({ miropolskii: { yCoefficient: 0 } });
    const h2 = evaluateConvectionH(
      cond,
      { ...baseCtx, closureParams: noY },
      state,
    );
    expect(h2).toBeGreaterThan(h0);
  });

  it("HeatedPipe miropolskii branch honours the threaded closure params", () => {
    const fluid = new RealFluid("Nitrogen");
    const P = 5e5;
    const sat = fluid.saturationProperties(P);
    const hMix = 0.5 * (sat.hf + sat.hg);
    const mk = (closure?: typeof DEFAULT_CLOSURE_PARAMS) =>
      new HeatedPipe(10, 0.015875, 1.5e-6, 0, 50, 300, "miropolskii", closure);
    const q0 = mk().getBranchHeat(0.2, 90, 1000, fluid, P, hMix);
    const q1 = mk(DEFAULT_CLOSURE_PARAMS).getBranchHeat(
      0.2,
      90,
      1000,
      fluid,
      P,
      hMix,
    );
    expect(q1).toBe(q0);
    const q2 = mk(
      resolveClosureParams({ miropolskii: { leadingCoefficient: 2 * 0.023 } }),
    ).getBranchHeat(0.2, 90, 1000, fluid, P, hMix);
    expect(Math.abs(q2 / q0 - 2)).toBeLessThan(1e-12);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: transient bit-identity of defaults, cp-scale plumbing
// ---------------------------------------------------------------------------

/** Small two-phase chilldown network (N=2, 6 m) — converges in ~1 s. */
function minimalNetwork(): NetworkConfig {
  const N = 2;
  const L = 6;
  const P_in = 0.5169e6;
  const P_out = 101325;
  const T_init = 300;
  const D = 0.015875;
  const OD = 0.01905;
  const roughness = 1.5e-6;
  const rhoCu = 8960;
  const segL = L / N;
  const A_fluid = (Math.PI / 4) * D * D;
  const A_metal = (Math.PI / 4) * (OD * OD - D * D);
  const vol = A_fluid * segL;
  const mass_solid = rhoCu * A_metal * segL;
  const convArea = Math.PI * D * segL;

  return {
    meta: { name: "closureParams test network", version: 2 },
    settings: {
      mode: "transient",
      tolerance: 1e-5,
      maxIterations: 200,
      relaxation: 0.7,
      endTime: 20,
      dt: 10,
      timeStepping: "fixed",
    },
    fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
    nodes: [
      { id: "f0", type: "boundary", x: 0, y: 0, pressure: P_in, quality: 0 },
      {
        id: "f1",
        type: "internal",
        x: segL,
        y: 0,
        pressure: (P_in + P_out) / 2,
        temperature: T_init,
        volume: vol,
      },
      {
        id: "f2",
        type: "boundary",
        x: L,
        y: 0,
        pressure: P_out,
        temperature: T_init,
      },
    ],
    solidNodes: [0, 1, 2].map((i) => ({
      id: `s${i}`,
      type: "solid" as const,
      x: i * segL,
      y: 80,
      temperature: T_init,
      mass: mass_solid,
      cp: 385,
    })),
    conductors: [
      ...[0, 1, 2].map((i) => ({
        id: `conv${i}`,
        from: `f${i}`,
        to: `s${i}`,
        type: {
          kind: "convection" as const,
          area: convArea,
          correlation: {
            model: "miropolskii" as const,
            diameter: D,
            flowArea: A_fluid,
          },
        },
      })),
      ...[0, 1].map((i) => ({
        id: `cond${i}`,
        from: `s${i}`,
        to: `s${i + 1}`,
        type: {
          kind: "conduction" as const,
          k: 400,
          area: A_metal,
          length: segL,
        },
      })),
    ],
    branches: [0, 1].map((i) => ({
      id: `pipe${i}`,
      from: `f${i}`,
      to: `f${i + 1}`,
      component: {
        type: "pipe" as const,
        length: segL,
        diameter: D,
        roughness,
      },
    })),
  };
}

describe("End-to-end plumbing (realFluid transient)", () => {
  beforeAll(async () => {
    await initRealFluids();
    expect(realFluidsReady()).toBe(true);
  }, 30000);

  it("unspecified closureParams ≡ explicit defaults, bit-identical trajectories", () => {
    const a = solveTransient(minimalNetwork());
    const b = solveTransient({
      ...minimalNetwork(),
      closureParams: resolveClosureParams(undefined),
    });
    const c = solveTransient({ ...minimalNetwork(), closureParams: {} });
    expect(a.converged).toBe(true);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  }, 120000);

  it("solidCpScale on CONSTANT cp ≡ hand-scaled cp (and differs from default)", () => {
    const scaled = solveTransient({
      ...minimalNetwork(),
      closureParams: { solidCpScale: 2 },
    });
    const manual = minimalNetwork();
    for (const s of manual.solidNodes!) s.cp = 770; // = 385 × 2
    const manualRes = solveTransient(manual);
    expect(scaled).toEqual(manualRes);
    const base = solveTransient(minimalNetwork());
    // The parameter demonstrably reaches the physics:
    expect(scaled.solidNodes!["s1"].temperature).not.toEqual(
      base.solidNodes!["s1"].temperature,
    );
  }, 120000);

  it("solidCpScale on a MATERIAL cp curve ≡ explicit scaled table", () => {
    const mk = (
      cp: import("../schema").SolidPropertySpec,
      closure?: object,
    ): NetworkConfig => {
      const cfg = minimalNetwork();
      for (const s of cfg.solidNodes!) s.cp = cp;
      if (closure)
        cfg.closureParams = closure as NetworkConfig["closureParams"];
      return cfg;
    };
    const viaScale = solveTransient(
      mk({ material: "ofhc-copper" }, { solidCpScale: 1.1 }),
    );
    const scaledTable = getSolidMaterialTable("ofhc-copper", "cp").map(
      ([T, v]): [number, number] => [T, v * 1.1],
    );
    const viaTable = solveTransient(mk({ table: scaledTable }));
    expect(viaScale).toEqual(viaTable);
  }, 120000);

  it("buildSolverContext carries resolved params into the correlation context", () => {
    const ctx = buildSolverContext({
      ...minimalNetwork(),
      closureParams: { miropolskii: { leadingCoefficient: 0.03 } },
    });
    expect(ctx.closureParams.miropolskii.leadingCoefficient).toBe(0.03);
    expect(ctx.closureParams.dittusBoelter).toEqual(
      DEFAULT_CLOSURE_PARAMS.dittusBoelter,
    );
    const pipe = ctx.branches[0].component as Pipe;
    expect(pipe.frictionParams).toEqual(DEFAULT_CLOSURE_PARAMS.swameeJain);
  });
});
