/**
 * AreaChange regressions.
 *
 * 1. Flow reversal: the reversible (Bernoulli) term must change sign with ṁ.
 *    It used to be ½ρ(v_out² − v_in²) regardless of direction, so a declared
 *    expansion carrying reverse flow (physically a contraction) and the same
 *    geometry declared the other way disagreed.  Declaring the geometry
 *    either way must give an antisymmetric ΔP.
 * 2. settings.momentumFlux: AreaChange already carries its reversible term,
 *    so the momentum-flux acceleration must not add a second one.  The
 *    component used to expose BranchComponent `area`/`areaOut`, which the
 *    momentum-flux code read as taper end areas — a declared contraction
 *    got a second acceleration term even for incompressible flow.  For
 *    constant density the flag must not change ΔP.
 */
import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../schema";
import { solveSteady } from "../solver";
import { validateNetwork } from "../validate";
import { AreaChange, kineticEndArea } from "../components";
import type { BranchComponent } from "../components";
import { variable } from "../dual";

const A_SMALL = 1e-3;
const A_LARGE = 2.5e-3;
const MDOT = 2;
const P_LO = 2e5;

/**
 * hi (boundary) → flowSource → mid → areaChange → lo (boundary).
 * `reversed` declares the area change lo → mid with its areas swapped:
 * the same physical geometry, carrying ṁ < 0.
 */
function network(
  areaIn: number,
  areaOut: number,
  reversed: boolean,
  momentumFlux?: boolean,
): NetworkConfig {
  return {
    meta: { name: "area-change reversal", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-10,
      maxIterations: 200,
      ...(momentumFlux === undefined ? {} : { momentumFlux }),
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "hi",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 5e5,
        temperature: 300,
      },
      {
        id: "mid",
        type: "internal",
        x: 1,
        y: 0,
        pressure: 3e5,
        temperature: 300,
        volume: 1e-3,
      },
      {
        id: "lo",
        type: "boundary",
        x: 2,
        y: 0,
        pressure: P_LO,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "src",
        from: "hi",
        to: "mid",
        component: { type: "flowSource", massFlow: MDOT },
      },
      reversed
        ? {
            id: "ac",
            from: "lo",
            to: "mid",
            component: { type: "areaChange", areaIn: areaOut, areaOut: areaIn },
          }
        : {
            id: "ac",
            from: "mid",
            to: "lo",
            component: { type: "areaChange", areaIn, areaOut },
          },
    ],
  };
}

const geometries: Array<[string, number, number]> = [
  ["expansion", A_SMALL, A_LARGE],
  ["contraction", A_LARGE, A_SMALL],
];

describe("AreaChange under flow reversal", () => {
  for (const [label, aIn, aOut] of geometries) {
    it(`${label}: component ΔP is antisymmetric under (ṁ, A_in, A_out) → (−ṁ, A_out, A_in)`, () => {
      const rho = 998;
      const fwd = new AreaChange(aIn, aOut);
      const rev = new AreaChange(aOut, aIn);
      for (const m of [1e-3, 0.3, MDOT, 7]) {
        const dpF = fwd.pressureDrop(m, rho);
        const dpR = rev.pressureDrop(-m, rho);
        expect(Math.abs(dpF + dpR)).toBeLessThan(1e-9 * Math.abs(dpF));
        // Dual path: same value and slope (ΔP is odd in ṁ, so d/dṁ is even).
        const dF = fwd.pressureDropDual(variable(m), rho);
        const dR = rev.pressureDropDual(variable(-m), rho);
        expect(dF.v).toBeCloseTo(dpF, 9);
        expect(dR.v).toBeCloseTo(dpR, 9);
        expect(Math.abs(dF.d - dR.d)).toBeLessThan(1e-9 * Math.abs(dF.d));
      }
    });

    it(`${label}: declared either way in a network gives the antisymmetric ΔP`, () => {
      const cfgF = network(aIn, aOut, false);
      const cfgR = network(aIn, aOut, true);
      expect(validateNetwork(cfgF)).toEqual([]);
      expect(validateNetwork(cfgR)).toEqual([]);
      const f = solveSteady(cfgF);
      const r = solveSteady(cfgR);
      expect(f.converged).toBe(true);
      expect(r.converged).toBe(true);
      expect(f.branches.ac.mdot).toBeCloseTo(MDOT, 9);
      expect(r.branches.ac.mdot).toBeCloseTo(-MDOT, 9);
      const dpF = f.nodes.mid.pressure - P_LO; // P_from − P_to, forward
      const dpR = P_LO - r.nodes.mid.pressure; // P_from − P_to, reversed
      expect(Math.abs(dpF)).toBeGreaterThan(10);
      expect(Math.abs(dpF + dpR)).toBeLessThan(1e-6 * Math.abs(dpF));
    });
  }

  it("expansion recovers pressure and contraction loses it, in either declaration", () => {
    const [exp, con] = geometries.map(([, aIn, aOut]) =>
      [false, true].map((rev) => solveSteady(network(aIn, aOut, rev))),
    );
    for (const r of exp) expect(r.nodes.mid.pressure).toBeLessThan(P_LO);
    for (const r of con) expect(r.nodes.mid.pressure).toBeGreaterThan(P_LO);
  });
});

describe("AreaChange with settings.momentumFlux", () => {
  for (const [label, aIn, aOut] of geometries) {
    for (const reversed of [false, true]) {
      it(`${label}${reversed ? " (declared reversed)" : ""}: incompressible ΔP is unchanged by momentumFlux`, () => {
        const off = solveSteady(network(aIn, aOut, reversed, false));
        const on = solveSteady(network(aIn, aOut, reversed, true));
        expect(off.converged).toBe(true);
        expect(on.converged).toBe(true);
        const dpOff = off.nodes.mid.pressure - P_LO;
        const dpOn = on.nodes.mid.pressure - P_LO;
        expect(Math.abs(dpOn - dpOff)).toBeLessThan(
          1e-9 * Math.abs(dpOff) + 1e-6,
        );
      });
    }
  }
});

describe("AreaChange endpoint areas", () => {
  it("exposes no taper areaOut, but gives kinetic-energy terms the true end areas", () => {
    const ac = new AreaChange(A_LARGE, A_SMALL);
    expect((ac as BranchComponent).areaOut).toBeUndefined();
    expect(ac.area).toBe(A_LARGE);
    expect(kineticEndArea(ac, "from")).toBe(A_LARGE);
    expect(kineticEndArea(ac, "to")).toBe(A_SMALL);
  });
});
