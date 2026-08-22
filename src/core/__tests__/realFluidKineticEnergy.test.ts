/**
 * settings.kineticEnergy with the realFluid model — unlocked by the coupled
 * steady h-system (any EOS rides the same [P, ṁ, h] formulation, so the old
 * "analytic fluid models only" validation gate is gone).
 *
 * The physics bar: in an adiabatic accelerating duct the STAGNATION enthalpy
 * h₀ = h + v²/2 is transported unchanged while the static temperature falls —
 * the same invariant the ideal-gas duct tests assert via T₀, but measured
 * here with CoolProp nitrogen properties.  The velocity convention matches
 * the solver's energy rows: v = ṁ/(ρA) with the node's own state and the
 * area of the branch carrying the flux at that node's end.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { NetworkConfig } from "../schema";
import { initRealFluids, realFluidsReady, RealFluid } from "../";
import { solveSteady } from "../solver";
import { solveTransient } from "../transient";
import { validateNetwork } from "../validate";

beforeAll(async () => {
  await initRealFluids();
  expect(realFluidsReady()).toBe(true);
}, 30000);

const areaOf = (d: number) => (Math.PI * d * d) / 4;
const D1 = 0.08;
const D2 = 0.05;
const D3 = 0.035;

/** Converging three-segment nitrogen duct: 5 bar 300 K vapor accelerating
 *  toward a 4 bar exit.  Exit Mach ≈ 0.5 — strongly compressible, safely
 *  subsonic and far from the dome (Tsat(5 bar) ≈ 94 K). */
function convergingDuct(): NetworkConfig {
  return {
    meta: { name: "n2 accelerating duct", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-6,
      maxIterations: 300,
      kineticEnergy: true,
      momentumFlux: true,
    },
    fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
    nodes: [
      {
        id: "in",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 5e5,
        temperature: 300,
      },
      {
        id: "n1",
        type: "internal",
        x: 2,
        y: 0,
        pressure: 4.9e5,
        temperature: 300,
      },
      {
        id: "n2",
        type: "internal",
        x: 4,
        y: 0,
        pressure: 4.6e5,
        temperature: 300,
      },
      {
        id: "out",
        type: "boundary",
        x: 6,
        y: 0,
        pressure: 4.0e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "p1",
        from: "in",
        to: "n1",
        initialMdot: 0.8,
        component: { type: "pipe", length: 2, diameter: D1, roughness: 1e-5 },
      },
      {
        id: "p2",
        from: "n1",
        to: "n2",
        initialMdot: 0.8,
        component: { type: "pipe", length: 2, diameter: D2, roughness: 1e-5 },
      },
      {
        id: "p3",
        from: "n2",
        to: "out",
        initialMdot: 0.8,
        component: { type: "pipe", length: 2, diameter: D3, roughness: 1e-5 },
      },
    ],
  };
}

describe("real-fluid kineticEnergy — adiabatic accelerating N2 duct (steady)", () => {
  it("validates and converges through the coupled h-system", () => {
    const config = convergingDuct();
    expect(validateNetwork(config)).toEqual([]);
    const res = solveSteady(config);
    expect(res.converged).toBe(true);
    expect(res.branches["p2"].mdot).toBeGreaterThan(0.3);
  });

  it("transports stagnation enthalpy and cools the static state", () => {
    const config = convergingDuct();
    const res = solveSteady(config);
    expect(res.converged).toBe(true);

    const rf = new RealFluid("Nitrogen");
    const mdot = res.branches["p2"].mdot;
    const h = (id: string) =>
      rf.enthalpyPT(res.nodes[id].pressure, res.nodes[id].temperature);
    // Stagnation enthalpy at each node, with the DOWNSTREAM branch's area
    // carrying the outflow flux (the energy rows' convention).
    const h0 = (id: string, Adown: number) => {
      const rho = res.nodes[id].density;
      const v = mdot / (rho * Adown);
      return h(id) + 0.5 * v * v;
    };
    const I0 = h0("in", areaOf(D1));
    const I1 = h0("n1", areaOf(D2));
    const I2 = h0("n2", areaOf(D3));

    // The kinetic term at n2 is ~15 kJ/kg; conservation must hold to a small
    // fraction of that.
    const keScale = I2 - h("n2");
    expect(keScale).toBeGreaterThan(5e3);
    expect(Math.abs(I1 - I0)).toBeLessThan(200);
    expect(Math.abs(I2 - I1)).toBeLessThan(200);

    // Static temperature falls monotonically as the gas trades enthalpy for
    // kinetic energy (adiabatic, no heat input anywhere).
    const Tin = res.nodes["in"].temperature;
    const T1 = res.nodes["n1"].temperature;
    const T2 = res.nodes["n2"].temperature;
    expect(T1).toBeLessThan(Tin);
    expect(T2).toBeLessThan(T1);
    // ≥ 6 K of measurable static cooling.  (Was ≥ 8 K under the central
    // momentum faces; the default limited-upwind faces — real-fluid
    // branches are upwind-eligible under kineticEnergy — converge to a
    // slightly lower mass flow on this coarse 3-segment duct.)
    expect(T2).toBeLessThan(294);
  });

  it("transient extended system also transports stagnation enthalpy", () => {
    // Same duct with storage volumes, marched to its steady state: the
    // extended [P, ṁ, h] rows carry the same h₀ flux under kineticEnergy,
    // so the settled state must show the same invariant.
    const config = convergingDuct();
    config.settings = {
      ...config.settings,
      mode: "transient",
      dt: 0.02,
      endTime: 0.4,
      maxIterations: 200,
      relaxation: 0.5,
    };
    for (const n of config.nodes) {
      if (n.type === "internal") n.volume = 2e-3;
    }
    expect(validateNetwork(config)).toEqual([]);
    const res = solveTransient(config);
    expect(res.converged).toBe(true);

    const last = <T>(xs: T[]): T => xs[xs.length - 1];
    const rf = new RealFluid("Nitrogen");
    const mdot = last(res.branches["p2"].mdot);
    const state = (id: string) => ({
      P: last(res.nodes[id].pressure),
      T: last(res.nodes[id].temperature),
    });
    const h0 = (id: string, Adown: number) => {
      const { P, T } = state(id);
      const rho = rf.density(P, T);
      const v = mdot / (rho * Adown);
      return rf.enthalpyPT(P, T) + 0.5 * v * v;
    };
    const I1 = h0("n1", areaOf(D2));
    const I2 = h0("n2", areaOf(D3));
    // Measured settled imbalance is < 1 J/kg (the march settles in ~0.1 s);
    // 200 J/kg leaves margin while staying ≪ the ~11 kJ/kg kinetic term.
    expect(Math.abs(I2 - I1)).toBeLessThan(200);
    expect(state("n2").T).toBeLessThan(state("n1").T);
  });
});
