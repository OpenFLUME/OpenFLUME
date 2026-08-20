import { describe, it, expect } from "vitest";
import { NetworkConfig } from "../schema";
import { solveSteady } from "../solver";
import { solveTransient } from "../transient";
import { validateNetwork } from "../validate";

function makeConfig(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    meta: { name: "test", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-9,
      maxIterations: 500,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [],
    branches: [],
    ...overrides,
  } as NetworkConfig;
}

/** Dummy fluid network to satisfy validation when only thermal physics is tested. */
function withDummyFluid(config: NetworkConfig): NetworkConfig {
  const hasFluidNodes = config.nodes && config.nodes.length > 0;
  if (hasFluidNodes) return config;
  return {
    ...config,
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
      ...(config.branches ?? []),
      {
        id: "dummy",
        from: "d1",
        to: "d2",
        component: { type: "flowSource", massFlow: 0 },
      },
    ],
  };
}

const SIGMA = 5.670374419e-8;

/* ============================================================================
 * 1. 1D conduction rod (GFSSP conduction demo analog)
 *    5 solid nodes in series between two ambient nodes (400 K, 300 K).
 *    Analytical: steady temperatures are linear; heat rate = kA/L_total * ΔT.
 * ============================================================================ */
describe("1D conduction rod", () => {
  it("steady temperatures linear within 1e-9; heat rate exact", () => {
    const k = 10;
    const A = 0.01;
    const L = 0.1; // per conductor
    const nSolids = 5;
    const nConductors = nSolids + 1; // including ambient-to-solid links
    const T_hot = 400;
    const T_cold = 300;

    const solidNodes = Array.from({ length: nSolids }, (_, i) => ({
      id: `s${i + 1}`,
      type: "solid" as const,
      x: i + 1,
      y: 0,
      temperature: 320,
    }));

    const ambientNodes = [
      { id: "a1", type: "ambient" as const, x: 0, y: 0, temperature: T_hot },
      {
        id: "a2",
        type: "ambient" as const,
        x: nSolids + 1,
        y: 0,
        temperature: T_cold,
      },
    ];

    const conductors = [];
    for (let i = 0; i < nConductors; i++) {
      const from = i === 0 ? "a1" : `s${i}`;
      const to = i === nConductors - 1 ? "a2" : `s${i + 1}`;
      conductors.push({
        id: `c${i + 1}`,
        from,
        to,
        type: { kind: "conduction" as const, k, area: A, length: L },
      });
    }

    const config = withDummyFluid(
      makeConfig({ solidNodes: [...ambientNodes, ...solidNodes], conductors }),
    );
    const res = solveSteady(config);
    expect(res.converged).toBe(true);

    const totalR = (nConductors * L) / (k * A);
    const expectedQ = (T_hot - T_cold) / totalR;
    expect(res.conductors!.c1.heatRate).toBeCloseTo(expectedQ, 9);

    for (let i = 0; i < nSolids; i++) {
      const expectedT = T_hot - ((i + 1) / (nSolids + 1)) * (T_hot - T_cold);
      expect(res.solidNodes![`s${i + 1}`].temperature).toBeCloseTo(
        expectedT,
        9,
      );
    }
  });
});

/* ============================================================================
 * 2. Series resistance network: conduction + convection in series
 *    Analytical total Q = ΔT / (R_cond + R_conv).
 * ============================================================================ */
describe("Series resistance network", () => {
  it("total Q matches 1/(ΣR) hand calc within 0.1%", () => {
    const k = 10;
    const A = 0.01;
    const L = 0.1;
    const h = 100;
    const T_ambient = 400;
    const T_fluid = 300;

    const config = makeConfig({
      nodes: [
        {
          id: "f1",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 1e5,
          temperature: T_fluid,
        },
      ],
      solidNodes: [
        { id: "a1", type: "ambient", x: 0, y: 0, temperature: T_ambient },
        { id: "s1", type: "solid", x: 1, y: 0, temperature: 350 },
      ],
      conductors: [
        {
          id: "cond1",
          from: "a1",
          to: "s1",
          type: { kind: "conduction", k, area: A, length: L },
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
    });

    const res = solveSteady(config);
    expect(res.converged).toBe(true);

    const Rcond = L / (k * A);
    const Rconv = 1 / (h * A);
    const expectedQ = (T_ambient - T_fluid) / (Rcond + Rconv);
    const actualQ = res.conductors!.cond1.heatRate;
    expect(Math.abs(actualQ - expectedQ) / expectedQ).toBeLessThan(0.001);

    const expectedTs = T_ambient - expectedQ * Rcond;
    expect(res.solidNodes!.s1.temperature).toBeCloseTo(expectedTs, 6);
  });
});

/* ============================================================================
 * 3. Radiation equilibrium
 *    Solid node with heatInput Q radiating to ambient at 300 K.
 *    T_eq = (Q/(σεAF) + T_amb⁴)^0.25.
 * ============================================================================ */
describe("Radiation equilibrium", () => {
  it("matches analytical T_eq within 0.1%", () => {
    const Q = 1000;
    const eps = 0.8;
    const A = 0.01;
    const F = 1.0;
    const Tamb = 300;

    const config = withDummyFluid(
      makeConfig({
        solidNodes: [
          {
            id: "s1",
            type: "solid",
            x: 0,
            y: 0,
            temperature: 400,
            heatInput: Q,
          },
          { id: "a1", type: "ambient", x: 1, y: 0, temperature: Tamb },
        ],
        conductors: [
          {
            id: "r1",
            from: "s1",
            to: "a1",
            type: {
              kind: "radiation",
              emissivity: eps,
              area: A,
              viewFactor: F,
            },
          },
        ],
      }),
    );

    const res = solveSteady(config);
    expect(res.converged).toBe(true);

    const Teq = Math.pow(Q / (SIGMA * eps * A * F) + Math.pow(Tamb, 4), 0.25);
    expect(Math.abs(res.solidNodes!.s1.temperature - Teq) / Teq).toBeLessThan(
      0.001,
    );
  });

  it("radiation-conduction combined balances to < 1e-6·Q", () => {
    const Q = 2000;
    const k = 50;
    const A = 0.02;
    const L = 0.05;
    const eps = 0.6;
    const F = 1.0;
    const Tamb = 300;

    const config = withDummyFluid(
      makeConfig({
        solidNodes: [
          {
            id: "s1",
            type: "solid",
            x: 0,
            y: 0,
            temperature: 500,
            heatInput: Q,
          },
          { id: "s2", type: "solid", x: 1, y: 0, temperature: 400 },
          { id: "a1", type: "ambient", x: 2, y: 0, temperature: Tamb },
        ],
        conductors: [
          {
            id: "cond1",
            from: "s1",
            to: "s2",
            type: { kind: "conduction", k, area: A, length: L },
          },
          {
            id: "rad1",
            from: "s2",
            to: "a1",
            type: {
              kind: "radiation",
              emissivity: eps,
              area: A,
              viewFactor: F,
            },
          },
        ],
      }),
    );

    const res = solveSteady(config);
    expect(res.converged).toBe(true);

    // Net heat into s1 from conductors + heatInput should be ~0
    let qIntoS1 = Q;
    for (const c of config.conductors!) {
      const hr = res.conductors![c.id].heatRate;
      if (c.from === "s1") qIntoS1 -= hr;
      if (c.to === "s1") qIntoS1 += hr;
    }
    expect(Math.abs(qIntoS1)).toBeLessThan(1e-6 * Q);
  });
});

/* ============================================================================
 * 4. Lumped capacitance transient (classic Biot≪1 problem)
 *    T(t) = T∞ + (T0 − T∞)·exp(−hA·t/(m·cp)).
 * ============================================================================ */
describe("Lumped capacitance transient", () => {
  it("matches exponential within 1% at τ and 3τ; shows first-order convergence", () => {
    const m = 1;
    const cp = 500;
    const h = 10;
    const A = 1.0;
    const T0 = 400;
    const Tinf = 300;
    const tau = (m * cp) / (h * A);
    const endTime = 3 * tau;

    const analytical = (t: number) => Tinf + (T0 - Tinf) * Math.exp(-t / tau);

    const run = (dt: number) => {
      const config: NetworkConfig = {
        meta: { name: "test", version: 2 },
        settings: {
          mode: "transient",
          dt,
          endTime,
          tolerance: 1e-9,
          maxIterations: 200,
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
            temperature: Tinf,
          },
          {
            id: "f2",
            type: "boundary",
            x: 1,
            y: 0,
            pressure: 1e5,
            temperature: Tinf,
          },
        ],
        solidNodes: [
          { id: "s1", type: "solid", x: 1, y: 0, temperature: T0, mass: m, cp },
        ],
        conductors: [
          {
            id: "c1",
            from: "s1",
            to: "f1",
            type: { kind: "convection", h, area: A },
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
      return solveTransient(config);
    };

    const dt1 = tau / 50;
    const dt2 = tau / 100;
    const res1 = run(dt1);
    const res2 = run(dt2);

    const idxTau1 = Math.round(tau / dt1);
    const idx3Tau1 = Math.round((3 * tau) / dt1);
    const Ttau1 = res1.solidNodes!.s1.temperature[idxTau1];
    const T3tau1 = res1.solidNodes!.s1.temperature[idx3Tau1];

    expect(Math.abs(Ttau1 - analytical(tau)) / Tinf).toBeLessThan(0.01);
    expect(Math.abs(T3tau1 - analytical(3 * tau)) / Tinf).toBeLessThan(0.01);

    // Backward-Euler first-order convergence
    const idx3Tau2 = Math.round((3 * tau) / dt2);
    const err1 = Math.abs(T3tau1 - analytical(3 * tau));
    const err2 = Math.abs(
      res2.solidNodes!.s1.temperature[idx3Tau2] - analytical(3 * tau),
    );
    const ratio = err1 / err2;
    expect(ratio).toBeGreaterThanOrEqual(1.5);
    expect(ratio).toBeLessThanOrEqual(3.0);
  });
});

/* ============================================================================
 * 5. Conjugate pipe wall (GFSSP conjugate heat transfer analog)
 *    Water flows boundary→internal fluid node→boundary.
 *    Pipe wall = solid node heated by heatInput, convecting hA to fluid node.
 * ============================================================================ */
describe("Conjugate pipe wall", () => {
  it("steady outlet T rise and wall T match hand calc within 0.5%", () => {
    const cp = 4182;
    const Q = 5000;
    const mdot = 0.5;
    const h = 200;
    const Aconv = 0.05;
    const Tin = 300;

    const config = makeConfig({
      nodes: [
        {
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 1e5,
          temperature: Tin,
        },
        {
          id: "mid",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 1e5,
          temperature: Tin,
        },
        {
          id: "out",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: 1e5,
          temperature: Tin,
        },
      ],
      solidNodes: [
        {
          id: "wall",
          type: "solid",
          x: 1,
          y: 1,
          temperature: 350,
          heatInput: Q,
        },
      ],
      conductors: [
        {
          id: "conv1",
          from: "wall",
          to: "mid",
          type: { kind: "convection", h, area: Aconv },
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
          component: { type: "flowSource", massFlow: mdot },
        },
      ],
    });

    const res = solveSteady(config);
    expect(res.converged).toBe(true);

    const Tmid = res.nodes.mid.temperature;
    const expectedDT = Q / (mdot * cp);
    expect(Math.abs(Tmid - (Tin + expectedDT)) / expectedDT).toBeLessThan(
      0.005,
    );

    const Twall = res.solidNodes!.wall.temperature;
    const expectedTwall = Tmid + Q / (h * Aconv);
    expect(Math.abs(Twall - expectedTwall) / expectedTwall).toBeLessThan(0.005);

    // Global energy conservation: heatInput ≈ net enthalpy out
    const hOut = mdot * cp * Tmid;
    const hIn = mdot * cp * Tin;
    expect(Math.abs(hOut - hIn - Q) / Q).toBeLessThan(0.001);
  });
});

/* ============================================================================
 * 6. Counterflow heat exchanger vs ε-NTU
 *    Analytical counterflow ε-NTU with equal capacity rates:
 *    ε = NTU/(1+NTU).
 * ============================================================================ */
describe("Counterflow heat exchanger vs ε-NTU", () => {
  function buildHX(nSegments: number) {
    const Th_in = 400;
    const Tc_in = 300;
    const mdot = 0.2;
    const h = 500;
    const Aseg = 0.02;

    const nodes: NetworkConfig["nodes"] = [
      {
        id: "h_in",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 1e5,
        temperature: Th_in,
      },
      {
        id: "h_out",
        type: "boundary",
        x: nSegments + 1,
        y: 0,
        pressure: 1e5,
        temperature: Th_in,
      },
      {
        id: "c_in",
        type: "boundary",
        x: nSegments + 1,
        y: 1,
        pressure: 1e5,
        temperature: Tc_in,
      },
      {
        id: "c_out",
        type: "boundary",
        x: 0,
        y: 1,
        pressure: 1e5,
        temperature: Tc_in,
      },
    ];

    const solidNodes: NetworkConfig["solidNodes"] = [];
    const conductors: NetworkConfig["conductors"] = [];
    const branches: NetworkConfig["branches"] = [];

    for (let i = 1; i <= nSegments; i++) {
      nodes.push({
        id: `h${i}`,
        type: "internal",
        x: i,
        y: 0,
        pressure: 1e5,
        temperature: Th_in,
      });
      nodes.push({
        id: `c${i}`,
        type: "internal",
        x: i,
        y: 1,
        pressure: 1e5,
        temperature: Tc_in,
      });
      solidNodes.push({
        id: `w${i}`,
        type: "solid",
        x: i,
        y: 0.5,
        temperature: (Th_in + Tc_in) / 2,
      });

      conductors.push({
        id: `hw${i}`,
        from: `h${i}`,
        to: `w${i}`,
        type: { kind: "convection", h, area: Aseg },
      });
      conductors.push({
        id: `cw${i}`,
        from: `w${i}`,
        to: `c${i}`,
        type: { kind: "convection", h, area: Aseg },
      });
    }

    // Hot stream left→right
    for (let i = 0; i <= nSegments; i++) {
      const from = i === 0 ? "h_in" : `h${i}`;
      const to = i === nSegments ? "h_out" : `h${i + 1}`;
      branches.push({
        id: `hb${i + 1}`,
        from,
        to,
        component: { type: "flowSource", massFlow: mdot },
      });
    }
    // Cold stream right→left (counterflow)
    branches.push({
      id: "cb1",
      from: "c_in",
      to: `c${nSegments}`,
      component: { type: "flowSource", massFlow: mdot },
    });
    for (let i = nSegments; i >= 2; i--) {
      branches.push({
        id: `cb${nSegments - i + 2}`,
        from: `c${i}`,
        to: `c${i - 1}`,
        component: { type: "flowSource", massFlow: mdot },
      });
    }
    branches.push({
      id: `cb${nSegments + 1}`,
      from: "c1",
      to: "c_out",
      component: { type: "flowSource", massFlow: mdot },
    });

    return makeConfig({ nodes, solidNodes, conductors, branches });
  }

  it("duty within 5% of ε-NTU and increases toward analytical with segments", () => {
    const cp = 4182;
    const mdot = 0.2;
    const C = mdot * cp;
    const h = 500;
    const Aseg = 0.02;
    // Overall conductance per segment: 1/(1/(hA)+1/(hA)) = hA/2
    const UA_seg = (h * Aseg) / 2;

    for (const nSeg of [1, 3]) {
      const config = buildHX(nSeg);
      const res = solveSteady(config);
      expect(res.converged).toBe(true);

      // Actual hot outlet is the last internal node before h_out boundary
      const ThOutActual = res.nodes[`h${nSeg}`].temperature;
      const TcOutActual = res.nodes.c1.temperature;
      const dutyHot = C * (400 - ThOutActual);
      const dutyCold = C * (TcOutActual - 300);
      const duty = (dutyHot + dutyCold) / 2;

      const NTU = (nSeg * UA_seg) / C;
      const eps = NTU / (1 + NTU);
      const expectedDuty = eps * C * (400 - 300);

      expect(Math.abs(duty - expectedDuty) / expectedDuty).toBeLessThan(0.05);
    }

    // Duty should increase from 1→3 segments (grid convergence direction)
    const res1 = solveSteady(buildHX(1));
    const res3 = solveSteady(buildHX(3));
    const ThOut1 = res1.nodes.h1.temperature;
    const ThOut3 = res3.nodes.h3.temperature;
    const duty1 = C * (400 - ThOut1);
    const duty3 = C * (400 - ThOut3);
    expect(duty3).toBeGreaterThan(duty1);
  });
});

/* ============================================================================
 * 7. Transient solid + fluid coupling
 *    Step heat into wall → fluid outlet temperature responds with lag.
 * ============================================================================ */
describe("Transient solid + fluid coupling", () => {
  it("final values match steady within 1%, monotone approach, no NaN", () => {
    const Q = 3000;
    const mdot = 0.3;
    const h = 200;
    const Aconv = 0.03;
    const Tin = 300;
    const dt = 0.5;
    const endTime = 40;

    const configSteady = makeConfig({
      nodes: [
        {
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 1e5,
          temperature: Tin,
        },
        {
          id: "mid",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 1e5,
          temperature: Tin,
        },
        {
          id: "out",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: 1e5,
          temperature: Tin,
        },
      ],
      solidNodes: [
        {
          id: "wall",
          type: "solid",
          x: 1,
          y: 1,
          temperature: 340,
          heatInput: Q,
        },
      ],
      conductors: [
        {
          id: "conv1",
          from: "wall",
          to: "mid",
          type: { kind: "convection", h, area: Aconv },
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
          component: { type: "flowSource", massFlow: mdot },
        },
      ],
    });

    const steady = solveSteady(configSteady);
    expect(steady.converged).toBe(true);

    const configTransient: NetworkConfig = {
      ...configSteady,
      settings: {
        mode: "transient",
        dt,
        endTime,
        tolerance: 1e-8,
        maxIterations: 300,
        relaxation: 0.9,
      },
      nodes: configSteady.nodes.map((n) =>
        n.type === "internal"
          ? {
              ...n,
              volume: 0.01,
              pressure: n.pressure ?? 1e5,
              temperature: n.temperature ?? Tin,
            }
          : n,
      ),
      solidNodes: configSteady.solidNodes!.map((s) => ({
        ...s,
        mass: 0.05,
        cp: 800,
      })),
    };

    const res = solveTransient(configTransient);
    expect(res.converged).toBe(true);

    const wallTemps = res.solidNodes!.wall.temperature;
    const fluidTemps = res.nodes.mid.temperature;

    // No NaN
    for (const T of wallTemps) expect(Number.isNaN(T)).toBe(false);
    for (const T of fluidTemps) expect(Number.isNaN(T)).toBe(false);

    // Final values match steady
    const finalWall = wallTemps[wallTemps.length - 1];
    const finalFluid = fluidTemps[fluidTemps.length - 1];
    expect(
      Math.abs(finalWall - steady.solidNodes!.wall.temperature) /
        steady.solidNodes!.wall.temperature,
    ).toBeLessThan(0.01);
    expect(
      Math.abs(finalFluid - steady.nodes.mid.temperature) /
        steady.nodes.mid.temperature,
    ).toBeLessThan(0.01);

    // Monotone approach (non-oscillatory after initial transient)
    for (let i = 2; i < wallTemps.length; i++) {
      const diff1 = wallTemps[i - 1] - wallTemps[i - 2];
      const diff2 = wallTemps[i] - wallTemps[i - 1];
      if (Math.abs(diff1) < 0.01) break; // essentially settled
      expect(diff1 * diff2).toBeGreaterThanOrEqual(-1e-6); // same sign or zero
    }
  });
});

/* ============================================================================
 * 8. Validation error cases for thermal system
 * ============================================================================ */
describe("Thermal validation errors", () => {
  it("catches dangling conductor endpoint", () => {
    const config = withDummyFluid(
      makeConfig({
        solidNodes: [{ id: "s1", type: "solid", x: 0, y: 0, temperature: 300 }],
        conductors: [
          {
            id: "c1",
            from: "s1",
            to: "s2",
            type: { kind: "conduction", k: 10, area: 0.01, length: 0.1 },
          },
        ],
      }),
    );
    const errs = validateNetwork(config);
    expect(
      errs.some((e) => e.includes("missing node") && e.includes("s2")),
    ).toBe(true);
  });

  it("catches convection without fluid endpoint", () => {
    const config = withDummyFluid(
      makeConfig({
        solidNodes: [
          { id: "s1", type: "solid", x: 0, y: 0, temperature: 300 },
          { id: "s2", type: "solid", x: 1, y: 0, temperature: 300 },
        ],
        conductors: [
          {
            id: "c1",
            from: "s1",
            to: "s2",
            type: { kind: "convection", h: 100, area: 0.01 },
          },
        ],
      }),
    );
    const errs = validateNetwork(config);
    expect(
      errs.some((e) => e.includes("convection") && e.includes("fluid")),
    ).toBe(true);
  });

  it("catches radiation with fluid endpoint", () => {
    const config = withDummyFluid(
      makeConfig({
        nodes: [
          {
            id: "f1",
            type: "boundary",
            x: 0,
            y: 0,
            pressure: 1e5,
            temperature: 300,
          },
        ],
        solidNodes: [{ id: "s1", type: "solid", x: 1, y: 0, temperature: 300 }],
        conductors: [
          {
            id: "c1",
            from: "f1",
            to: "s1",
            type: {
              kind: "radiation",
              emissivity: 0.5,
              area: 0.01,
              viewFactor: 1,
            },
          },
        ],
      }),
    );
    const errs = validateNetwork(config);
    expect(
      errs.some((e) => e.includes("radiation") && e.includes("solid")),
    ).toBe(true);
  });

  it("catches missing mass/cp in transient for solid nodes", () => {
    const config: NetworkConfig = {
      meta: { name: "test", version: 2 },
      settings: {
        mode: "transient",
        dt: 0.1,
        endTime: 1,
        tolerance: 1e-6,
        maxIterations: 100,
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
      solidNodes: [{ id: "s1", type: "solid", x: 1, y: 0, temperature: 300 }],
      branches: [
        {
          id: "dummy",
          from: "f1",
          to: "f2",
          component: { type: "flowSource", massFlow: 0 },
        },
      ],
    };
    const errs = validateNetwork(config);
    expect(errs.some((e) => e.includes("mass"))).toBe(true);
    expect(errs.some((e) => e.includes("cp"))).toBe(true);
  });

  it("catches duplicate id across fluid and solid namespaces", () => {
    const config = withDummyFluid(
      makeConfig({
        nodes: [
          {
            id: "n1",
            type: "boundary",
            x: 0,
            y: 0,
            pressure: 1e5,
            temperature: 300,
          },
        ],
        solidNodes: [{ id: "n1", type: "solid", x: 1, y: 0, temperature: 300 }],
      }),
    );
    const errs = validateNetwork(config);
    expect(errs.some((e) => e.includes("Duplicate node id"))).toBe(true);
  });
});
