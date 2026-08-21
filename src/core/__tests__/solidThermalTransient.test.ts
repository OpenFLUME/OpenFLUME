/**
 * T-dependent solid properties — SOLVER-COUPLING tests.
 *
 *  A. Thermal-subsystem analytic Jacobian vs central FD (probeThermalSubsystem),
 *     following the analyticJacobian.test.ts pattern: enthalpy-form storage
 *     (−m·cp(T)/dt diagonal), T-dependent conduction (k(Tm) slope terms),
 *     radiation, convection, heatInput, clamp-region nodes — mixed with a
 *     legacy constant-cp/k node whose legacy exact form is pinned too.
 *  B. Lumped-mass cooling with constant heat extraction: backward-Euler with
 *     the enthalpy form TELESCOPES — m·(H(T_n) − H(T_0)) = −n·Q·dt exactly —
 *     asserted per-step, plus a smooth-crossing time checked against an
 *     INDEPENDENT in-test reference march built on the raw NIST fit (not the
 *     sampled table).
 *  C. Newton cooling (convection to a fixed-temperature reservoir) with cp(T):
 *     solver vs the same independent NIST-fit reference march; and the constant
 *     -cp twin against the exact closed-form BE recurrence.
 *  D. Golden constant-cp bit-identity: full traces + steady state pinned to
 *     values captured on the pre-feature code path (the legacy constant-cp
 *     path is kept separate and untouched — see docs/solid-properties-results.md).
 */
import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../schema";
import {
  buildSolverContext,
  createInitialState,
  probeThermalSubsystem,
  solveSteady,
  type StepState,
} from "../solver";
import { solveTransient } from "../transient";
import {
  resolveSolidProperty,
  getSolidMaterialTable,
  nistOfhcCopperCpFit,
  PiecewiseLinearProperty,
} from "../solidProperties";

const OFHC = { material: "ofhc-copper" } as const;

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
 * A. Thermal-subsystem Jacobian vs FD
 * ========================================================================== */

describe("thermal-subsystem Jacobian with T-dependent cp/k (analytic vs FD)", () => {
  const config: NetworkConfig = {
    meta: { name: "thermal Jacobian probe", version: 2 },
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
        cp: OFHC,
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
      // Clamp-region node: T > table max (300 K) — cp clamped, slope 0.
      {
        id: "sD",
        type: "solid",
        x: 3,
        y: 5,
        temperature: 350.99,
        mass: 2.5,
        cp: OFHC,
      },
      { id: "amb", type: "ambient", x: 4, y: 5, temperature: 77 },
    ],
    conductors: [
      {
        id: "cAB",
        from: "sA",
        to: "sB",
        type: { kind: "conduction", k: OFHC, area: 0.02, length: 0.3 },
      },
      {
        id: "cBC",
        from: "sB",
        to: "sC",
        type: { kind: "conduction", k: 150, area: 0.01, length: 0.2 },
      },
      // Clamp-region k: Tm = (251.13+350.99)/2 = 301.06 > 300 → k clamped, dk/dT = 0.
      {
        id: "cCD",
        from: "sC",
        to: "sD",
        type: { kind: "conduction", k: OFHC, area: 0.005, length: 0.4 },
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
        id: "rD",
        from: "sD",
        to: "amb",
        type: { kind: "radiation", emissivity: 0.9, area: 0.01, viewFactor: 1 },
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

  it("probe temperatures are ≥ 0.02 K from every cp/k knot (FD never straddles a knot)", () => {
    const knots = [
      ...getSolidMaterialTable("ofhc-copper", "cp").map(([T]) => T),
      ...getSolidMaterialTable("ofhc-copper", "k").map(([T]) => T),
      ...[4, 100, 300], // sB custom table
    ];
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
    const state = createInitialState(ctx, config);
    for (const id of ctx.solidIds) state.solidT.set(id, PROBE_T[id]);
    const prevState: StepState = createInitialState(ctx, config);
    for (const id of ctx.solidIds) prevState.solidT.set(id, PREV_T[id]);
    const opts = { dt: DT, prevState };

    const probe = probeThermalSubsystem(ctx, state, opts);
    const n = ctx.nSolid;
    expect(probe.ids).toEqual([...ctx.solidIds]);

    // Central FD of f via the Toverride path (state never mutated).
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
        const m = Math.abs(probe.J[i][k] - Jfd[i][k]) / tol;
        if (m > worst) {
          worst = m;
          worstEntry = `${probe.ids[i]} / ${probe.ids[k]}`;
        }
        expect(
          m,
          `J[${probe.ids[i]}][${probe.ids[k]}]: analytic=${probe.J[i][k]} fd=${Jfd[i][k]} (margin ${m.toFixed(2)})`,
        ).toBeLessThan(1);
      }
    }
    console.log(
      `[thermalJacobian] worst |Δ|/tol = ${worst.toExponential(2)} (${worstEntry})`,
    );

    // Legacy constant-cp node keeps its exact legacy diagonal: −m·cp/dt plus the
    // constant conductances of its two links (cBC: k=150; cCD: k clamped at the
    // 300 K end-knot value, slope 0 in the clamp region).
    const kAt300 = (
      resolveSolidProperty(OFHC, "k", "cCD") as PiecewiseLinearProperty
    ).value(300);
    const iC = ctx.solidIndex.get("sC")!;
    const expectedDiag =
      -(0.8 * 385) / DT - (150 * 0.01) / 0.2 - (kAt300 * 0.005) / 0.4;
    expect(probe.J[iC][iC]).toBeCloseTo(expectedDiag, 6);
  });
});

/* ============================================================================
 * B. Lumped-mass cooling, constant extraction — enthalpy telescoping
 * ========================================================================== */

/** Independent reference: enthalpy from the RAW NIST fit (not the sampled
 *  table), integrated by fine trapezoid on a log grid; inverted by bisection. */
function makeFitEnthalpy(): {
  H: (T: number) => number;
  Hinv: (h: number) => number;
} {
  const NPTS = 20001;
  const T0 = 4,
    T1 = 300;
  const grid: number[] = [];
  const Hg: number[] = [0];
  const u0 = Math.log(T0),
    u1 = Math.log(T1);
  for (let i = 0; i < NPTS; i++) {
    const u = u0 + ((u1 - u0) * i) / (NPTS - 1);
    grid.push(Math.exp(u));
  }
  for (let i = 1; i < NPTS; i++) {
    Hg.push(
      Hg[i - 1] +
        0.5 *
          (nistOfhcCopperCpFit(grid[i - 1]) + nistOfhcCopperCpFit(grid[i])) *
          (grid[i] - grid[i - 1]),
    );
  }
  const H = (T: number): number => {
    if (T <= T0) return nistOfhcCopperCpFit(T0) * (T - T0);
    if (T >= T1) return Hg[NPTS - 1] + nistOfhcCopperCpFit(T1) * (T - T1);
    let lo = 0,
      hi = NPTS - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (grid[m] <= T) lo = m;
      else hi = m;
    }
    const cpLo = nistOfhcCopperCpFit(grid[lo]);
    const cpT =
      cpLo +
      (nistOfhcCopperCpFit(grid[lo + 1]) - cpLo) *
        ((T - grid[lo]) / (grid[lo + 1] - grid[lo]));
    return Hg[lo] + 0.5 * (cpLo + cpT) * (T - grid[lo]);
  };
  const Hinv = (h: number): number => {
    let lo = T0,
      hi = T1;
    for (let it = 0; it < 80; it++) {
      const m = 0.5 * (lo + hi);
      if (H(m) < h) lo = m;
      else hi = m;
    }
    return 0.5 * (lo + hi);
  };
  return { H, Hinv };
}

describe("lumped-mass cooling with cp(T) — exact enthalpy telescoping", () => {
  const m = 2; // kg
  const Q = 400; // W extraction
  const DT = 5; // s
  const STEPS = 60;
  const config: NetworkConfig = {
    meta: { name: "lumped ofhc", version: 2 },
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
        cp: OFHC,
        heatInput: -Q,
      },
    ],
  };

  it("per-step enthalpy telescopes exactly: H(T_n) == H(T_0) − n·Q·dt/m", () => {
    const res = solveTransient(config);
    expect(res.converged).toBe(true);
    const curve = resolveSolidProperty(
      OFHC,
      "cp",
      "mass",
    ) as PiecewiseLinearProperty;
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
      `[telescoping] worst per-step H deviation: ${worst.toExponential(2)} (T_final=${trace[STEPS].toFixed(2)} K)`,
    );
    expect(worst).toBeLessThan(1e-8);
  });

  it("crossing time matches the independent NIST-fit reference march (≤0.5 %)", () => {
    const res = solveTransient(config);
    const trace = res.solidNodes!.mass.temperature;
    const times = res.times;
    // Smooth crossing of 200 K on the solver trace.
    const THRESH = 200;
    const idx = trace.findIndex((v) => v < THRESH);
    expect(idx).toBeGreaterThan(0);
    const tSolver =
      times[idx - 1] +
      ((times[idx] - times[idx - 1]) * (trace[idx - 1] - THRESH)) /
        (trace[idx - 1] - trace[idx]);
    // Reference: the same BE map Tn_ref = Hinv_fit(H_fit(300) − n·Q·dt/m), same interp.
    const { H, Hinv } = makeFitEnthalpy();
    const refTrace = Array.from({ length: STEPS + 1 }, (_, n) =>
      Hinv(H(300) - (n * Q * DT) / m),
    );
    const ridx = refTrace.findIndex((v) => v < THRESH);
    const tRef =
      times[ridx - 1] +
      ((times[ridx] - times[ridx - 1]) * (refTrace[ridx - 1] - THRESH)) /
        (refTrace[ridx - 1] - refTrace[ridx]);
    console.log(
      `[crossing 200 K] solver=${tSolver.toFixed(3)} s, NIST-fit reference=${tRef.toFixed(3)} s (${(((tSolver - tRef) / tRef) * 100).toFixed(3)} %)`,
    );
    expect(Math.abs(tSolver - tRef) / tRef).toBeLessThan(0.005);
  });

  it("constant-cp twin telescopes linearly (legacy form) and differs macroscopically", () => {
    const constCfg: NetworkConfig = {
      ...config,
      meta: { name: "lumped const", version: 2 },
      solidNodes: [
        {
          id: "mass",
          type: "solid",
          x: 0,
          y: 5,
          temperature: 300,
          mass: m,
          cp: 385,
          heatInput: -Q,
        },
      ],
    };
    const res = solveTransient(constCfg);
    const trace = res.solidNodes!.mass.temperature;
    for (const n of [1, 17, STEPS]) {
      expect(trace[n]).toBeCloseTo(300 - (n * Q * DT) / (m * 385), 8);
    }
    // Feature engaged: the OFHC node ends far COLDER than the constant-385 one.
    const resOfhc = solveTransient(config);
    const tConst = trace[STEPS];
    const tOfhc = resOfhc.solidNodes!.mass.temperature[STEPS];
    console.log(
      `[engagement] T_final: const385=${tConst.toFixed(2)} K, OFHC=${tOfhc.toFixed(2)} K`,
    );
    expect(tConst - tOfhc).toBeGreaterThan(5);
  });
});

/* ============================================================================
 * C. Newton cooling with cp(T): convection to a fixed reservoir
 * ========================================================================== */

describe("Newton cooling (convection reservoir) with cp(T)", () => {
  const m = 2;
  const hA = 5; // W/K (h=50, A=0.1)
  const TINF = 77;
  const DT = 2;
  const STEPS = 200;
  const makeCfg = (
    cp: NetworkConfig["solidNodes"] extends Array<infer S> | undefined
      ? S extends { cp?: infer C }
        ? C
        : never
      : never,
  ): NetworkConfig => ({
    meta: { name: "newton cooling", version: 2 },
    settings: {
      mode: "transient",
      dt: DT,
      endTime: DT * STEPS,
      tolerance: 1e-9,
      maxIterations: 100,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "cold",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 1e5,
        temperature: TINF,
      },
      {
        id: "d2",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: 1e5,
        temperature: TINF,
      },
    ],
    branches: [
      {
        id: "dum",
        from: "cold",
        to: "d2",
        component: { type: "flowSource", massFlow: 0 },
      },
    ],
    solidNodes: [
      { id: "mass", type: "solid", x: 0, y: 5, temperature: 300, mass: m, cp },
    ],
    conductors: [
      {
        id: "cv",
        from: "cold",
        to: "mass",
        type: { kind: "convection", h: 50, area: 0.1 },
      },
    ],
  });

  function crossingTime(times: number[], trace: number[], thr: number): number {
    const idx = trace.findIndex((v) => v < thr);
    expect(idx).toBeGreaterThan(0);
    return (
      times[idx - 1] +
      ((times[idx] - times[idx - 1]) * (trace[idx - 1] - thr)) /
        (trace[idx - 1] - trace[idx])
    );
  }

  it("OFHC cp: solver matches the independent NIST-fit BE reference march (≤0.5 %)", () => {
    const res = solveTransient(makeCfg(OFHC));
    expect(res.converged).toBe(true);
    const trace = res.solidNodes!.mass.temperature;
    const tSolver = crossingTime(res.times, trace, 100);
    // Reference march: m·(H_fit(Tn) − H_fit(Tn−1)) = −hA·(Tn − T∞)·dt, bisection per step.
    const { H } = makeFitEnthalpy();
    const ref: number[] = [300];
    for (let n = 1; n <= STEPS; n++) {
      const Tprev = ref[n - 1];
      let lo = TINF,
        hi = Tprev;
      for (let it = 0; it < 80; it++) {
        const mid = 0.5 * (lo + hi);
        const r = m * (H(mid) - H(Tprev)) + hA * (mid - TINF) * DT;
        if (r < 0) lo = mid;
        else hi = mid;
      }
      ref.push(0.5 * (lo + hi));
    }
    const tRef = crossingTime(res.times, ref, 100);
    console.log(
      `[newton cooling 100 K] solver=${tSolver.toFixed(3)} s, fit-reference=${tRef.toFixed(3)} s (${(((tSolver - tRef) / tRef) * 100).toFixed(3)} %)`,
    );
    expect(Math.abs(tSolver - tRef) / tRef).toBeLessThan(0.005);
  });

  it("constant cp: solver matches the exact closed-form BE recurrence (≤1e-9 rel)", () => {
    const res = solveTransient(makeCfg(385));
    const trace = res.solidNodes!.mass.temperature;
    const a = (hA * DT) / (m * 385);
    for (const n of [1, 37, STEPS]) {
      // BE recurrence: Tn = (T_{n-1} + a·T∞)/(1 + a), exact in closed form by induction.
      let T = 300;
      for (let i = 0; i < n; i++) T = (T + a * TINF) / (1 + a);
      expect(Math.abs(trace[n] - T) / T).toBeLessThan(1e-9);
    }
  });
});

/* ============================================================================
 * D. Golden constant-cp bit-identity (values captured pre-feature, f751bf3 path;
 *    proven bit-identical by the 10-case trajectory diff — docs §M1)
 * ========================================================================== */

describe("golden constant-cp bit-identity", () => {
  const config: NetworkConfig = {
    meta: { name: "golden thermal", version: 2 },
    settings: {
      mode: "transient",
      dt: 0.5,
      endTime: 5,
      tolerance: 1e-9,
      maxIterations: 100,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "w1",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
      {
        id: "w2",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    solidNodes: [
      {
        id: "gA",
        type: "solid",
        x: 0,
        y: 5,
        temperature: 320,
        mass: 1.5,
        cp: 385,
        heatInput: 25,
      },
      {
        id: "gB",
        type: "solid",
        x: 1,
        y: 5,
        temperature: 280,
        mass: 0.8,
        cp: 200,
      },
      { id: "amb", type: "ambient", x: 2, y: 5, temperature: 77 },
    ],
    conductors: [
      {
        id: "cd",
        from: "gA",
        to: "gB",
        type: { kind: "conduction", k: 123.4, area: 0.02, length: 0.3 },
      },
      {
        id: "cv",
        from: "w1",
        to: "gA",
        type: { kind: "convection", h: 55, area: 0.05 },
      },
      {
        id: "rd",
        from: "gB",
        to: "amb",
        type: {
          kind: "radiation",
          emissivity: 0.3,
          area: 0.04,
          viewFactor: 0.7,
        },
      },
    ],
    branches: [
      {
        id: "dum",
        from: "w1",
        to: "w2",
        component: { type: "flowSource", massFlow: 0 },
      },
    ],
  };

  it("transient traces identical to the pre-feature solver (all timesteps)", () => {
    const res = solveTransient(config);
    expect(res.converged).toBe(true);
    const gA = [
      320, 319.6990034034584, 319.40757061762343, 319.12539217017655,
      318.85216860557387, 318.58761016129154, 318.33143645450923,
      318.08337617889595, 317.8431668111741, 317.6105543271476,
      317.38529292688963,
    ];
    const gB = [
      280, 280.98602005912846, 281.9398986029289, 282.8626760032627,
      283.7553590288973, 284.6189219275957, 285.45430747351134,
      286.26242798099554, 287.04416628589007, 287.8003766953427,
      288.53188590715104,
    ];
    expect(res.solidNodes!.gA.temperature).toEqual(gA);
    expect(res.solidNodes!.gB.temperature).toEqual(gB);
    const cdHeat = [
      329.06666666666666, 318.47880964602086, 308.23404844088697,
      298.32127833314445, 288.72975345079243, 279.4490752025378,
      270.469181083676, 261.780333841394, 253.3731109880034, 245.23839465098158,
      237.36736174904954,
    ];
    const rdHeat = [
      2.9109331174906226, 2.9523907249148738, 2.9929144247457895,
      3.0325102263217296, 3.0711852477272674, 3.1089476190487244,
      3.1458063906624165, 3.1817714464419997, 3.216853421757848,
      3.251063626130428, 3.284413970391067,
    ];
    expect(res.conductors!.cd.heatRate).toEqual(cdHeat);
    expect(res.conductors!.rd.heatRate).toEqual(rdHeat);
  });

  it("steady state identical to the pre-feature solver", () => {
    const res = solveSteady({
      ...config,
      settings: {
        ...config.settings,
        mode: "steady",
        dt: undefined,
        endTime: undefined,
      },
    });
    expect(res.converged).toBe(true);
    expect(res.solidNodes!.gA.temperature).toBe(307.5575452147347);
    expect(res.solidNodes!.gB.temperature).toBe(307.04497422695357);
    expect(res.conductors!.cd.heatRate).toBe(4.216750659479561);
    expect(res.conductors!.cv.heatRate).toBe(-20.78324934052047);
    expect(res.conductors!.rd.heatRate).toBe(4.216750659479511);
  });
});
