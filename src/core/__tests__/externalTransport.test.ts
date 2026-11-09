/**
 * External-transport real fluids (fluid.params.transport = "external").
 *
 * R21 (Freon-21) has density, specific heat and enthalpy in CoolProp but no
 * viscosity or conductivity.  It is rejected by default.  A flowSource-driven
 * thermal network with a custom convection expression that carries its own
 * transport can opt in, and validation then protects the promise.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { validateNetwork } from "../validate";
import { solveSteady } from "../solver/steady";
import { initRealFluids } from "../fluids/coolprop";
import { RealFluid } from "../fluids/realFluid";
import type { NetworkConfig } from "../schema";

const P0 = 1.5e6;

type Branch = NetworkConfig["branches"][number];
type Conductor = NonNullable<NetworkConfig["conductors"]>[number];

function r21Tube(
  opts: {
    transport?: string | false;
    nSeg?: number;
    mdot?: number;
    expression?: string;
    h?: number;
    corr?: Extract<Conductor["type"], { kind: "convection" }>["correlation"];
    pipe?: boolean;
    fluidName?: string;
  } = {},
): NetworkConfig {
  const N = opts.nSeg ?? 4;
  const mdot = opts.mdot ?? 0.02;
  const A = 0.1;
  const transport = opts.transport === undefined ? "external" : opts.transport;
  const nodes: NetworkConfig["nodes"] = [
    {
      id: "in",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: P0,
      temperature: 300,
    },
  ];
  const branches: Branch[] = [];
  const conductors: Conductor[] = [];
  let prev = "in";
  for (let j = 1; j <= N; j++) {
    nodes.push({
      id: `f${j}`,
      type: "internal",
      x: j,
      y: 0,
      pressure: P0,
      temperature: 300,
      volume: 1e-6,
    });
    branches.push({
      id: `b${j}`,
      from: prev,
      to: `f${j}`,
      // The first branch imposes the flow.  The others are viscosity-free
      // resistances, which also fix the node pressures (a chain of
      // flowSources leaves them undetermined).
      component:
        opts.pipe && j === 2
          ? { type: "pipe", length: 1, diameter: 0.01, roughness: 1e-5 }
          : j === 1
            ? { type: "flowSource", massFlow: mdot }
            : { type: "resistance", k: 0.01, area: 1e-4 },
    });
    conductors.push({
      id: `c${j}`,
      from: `f${j}`,
      to: "wall",
      type:
        opts.corr !== undefined
          ? { kind: "convection", area: A / N, correlation: opts.corr }
          : opts.h !== undefined
            ? { kind: "convection", area: A / N, h: opts.h }
            : {
                kind: "convection",
                area: A / N,
                correlation: {
                  model: "custom",
                  diameter: 0.01,
                  expression: opts.expression ?? "params.h0",
                  params: { h0: 500 },
                },
              },
    });
    prev = `f${j}`;
  }
  nodes.push({
    id: "out",
    type: "boundary",
    x: N + 1,
    y: 0,
    pressure: P0,
    temperature: 300,
  });
  branches.push({
    id: "bo",
    from: prev,
    to: "out",
    component: { type: "resistance", k: 0.01, area: 1e-4 },
  });
  return {
    meta: { name: "r21 external transport", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-9,
      maxIterations: 300,
      relaxation: 0.9,
    },
    fluid: {
      model: "realFluid",
      params: {
        fluidName: opts.fluidName ?? "R21",
        ...(transport === false ? {} : { transport }),
      },
    },
    nodes,
    solidNodes: [
      { id: "wall", type: "ambient", x: 0, y: 100, temperature: 340 },
    ],
    conductors,
    branches,
  };
}

describe("external-transport fluids: validation", () => {
  it("still rejects R21 by default, and the message names the opt-in", () => {
    const errs = validateNetwork(r21Tube({ transport: false }));
    expect(
      errs.some((e) => e.includes('"R21"') && e.includes("no viscosity")),
    ).toBe(true);
    expect(errs.some((e) => e.includes('transport = "external"'))).toBe(true);
  });

  it("accepts R21 declared external in a flowSource network with a custom h", () => {
    expect(validateNetwork(r21Tube())).toEqual([]);
  });

  it("accepts a literal-h convection conductor on an external fluid", () => {
    expect(validateNetwork(r21Tube({ h: 500 }))).toEqual([]);
  });

  it("allows a user param that happens to be called mu", () => {
    const cfg = r21Tube({ expression: "params.mu * 0 + 500" });
    // params.mu is not declared, but the check is about built-in scope names.
    expect(
      validateNetwork(cfg).filter((e) => e.includes("custom h expression")),
    ).toEqual([]);
  });

  it("rejects pipe friction on an external fluid with a clear error", () => {
    const errs = validateNetwork(r21Tube({ pipe: true }));
    expect(
      errs.some(
        (e) =>
          e.includes("Branch b2") &&
          e.includes('"pipe"') &&
          e.includes("viscosity"),
      ),
    ).toBe(true);
  });

  it("rejects a built-in convection correlation on an external fluid", () => {
    const errs = validateNetwork(
      r21Tube({
        corr: { model: "dittusBoelter", diameter: 0.01 },
      }),
    );
    expect(
      errs.some((e) => e.includes("dittusBoelter") && e.includes("viscosity")),
    ).toBe(true);
  });

  it("rejects a custom expression that reads the absent built-in transport", () => {
    for (const expr of [
      "0.023 * (G * D / mu)^0.8 * k / D",
      "Re * 0 + 500",
      "Pr * 0 + 500",
      "k / D",
    ]) {
      const errs = validateNetwork(r21Tube({ expression: expr }));
      expect(
        errs.some((e) => e.includes("custom h expression reads")),
        expr,
      ).toBe(true);
    }
  });

  it("rejects an unknown transport declaration", () => {
    const errs = validateNetwork(r21Tube({ transport: "builtin" }));
    expect(errs.some((e) => e.includes("params.transport must be"))).toBe(true);
  });

  it("does not change the verdict on a fluid that has transport and no declaration", () => {
    const cfg = r21Tube({ transport: false, fluidName: "Water" });
    expect(validateNetwork(cfg).filter((e) => e.includes("viscosity"))).toEqual(
      [],
    );
  });
});

describe("external-transport fluids: solve", () => {
  beforeAll(async () => {
    await initRealFluids();
  }, 30000);

  it("solves an R21 wall-heated tube and converges to the marched exponential approach", () => {
    const solveN = (n: number) => {
      const cfg = r21Tube({ nSeg: n });
      expect(validateNetwork(cfg)).toEqual([]);
      const res = solveSteady(cfg);
      expect(res.converged).toBe(true);
      return res;
    };
    const r1 = solveN(50);
    const r2 = solveN(100);
    const T1 = r1.nodes.f50.temperature;
    const T2 = r2.nodes.f100.temperature;

    // Reference: dT/dA = h (Tw - T) / (mdot cp(T)), RK4 with the same EOS.
    const fluid = new RealFluid("R21");
    const mdot = 0.02;
    const h = 500;
    const A = 0.1;
    const Tw = 340;
    let T = 300;
    const n = 2000;
    const dA = A / n;
    const f = (t: number) => (h * (Tw - t)) / (mdot * fluid.cp(P0, t));
    for (let i = 0; i < n; i++) {
      const k1 = f(T);
      const k2 = f(T + 0.5 * dA * k1);
      const k3 = f(T + 0.5 * dA * k2);
      const k4 = f(T + dA * k3);
      T += (dA / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    }
    // The cell-outlet (implicit upwind) scheme is first order: the error
    // halves with the segment count and the Richardson value is within a few hundredths of a kelvin.
    const e1 = Math.abs(T1 - T);
    const e2 = Math.abs(T2 - T);
    expect(e2).toBeLessThan(0.6 * e1);
    expect(Math.abs(2 * T2 - T1 - T)).toBeLessThan(0.05);

    // Energy closure: heat from the wall equals the enthalpy rise.
    const Qwall = Object.values(r2.conductors ?? {}).reduce(
      (s, c) => s - c.heatRate,
      0,
    );
    const dH = mdot * (fluid.enthalpyPT(P0, T2) - fluid.enthalpyPT(P0, 300));
    expect(Math.abs(Qwall - dH) / dH).toBeLessThan(1e-3);
  }, 60000);
});
