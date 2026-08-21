/**
 * settings.momentumFlux — the convective-acceleration (momentum-flux) term
 * in the branch momentum equation:
 *
 *     ΔP_accel = (ṁ/A)² · (1/ρ_downstream − 1/ρ_upstream)
 *
 * Checked against the closed-form solution of a single resistance between
 * two fixed boundary states:
 *
 *     ΔP = K·ṁ²/(2·ρ_up·A²) + (ṁ/A)²·(1/ρ_to − 1/ρ_from)
 *
 * so   ṁ = A·√( ΔP / (K/(2ρ_up) + 1/ρ_to − 1/ρ_from) ).
 *
 * The term must be identically zero for constant-density flow (flag on and
 * off agree bit-for-bit for incompressible water), and the default (flag
 * absent) must reproduce the historical friction-only momentum equation.
 */

import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../schema";
import { solveSteady } from "../solver";
import { validateNetwork } from "../validate";

const R_AIR = 287;
const P_FROM = 2.0e5;
const T_FROM = 300;
const P_TO = 1.0e5;
const T_TO = 900;
const K = 5;
const AREA = 1e-3;

function gasNetwork(momentumFlux: boolean | undefined): NetworkConfig {
  return {
    meta: { name: "momentum-flux gas run", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-10,
      maxIterations: 200,
      ...(momentumFlux === undefined ? {} : { momentumFlux }),
    },
    fluid: { model: "idealGas" },
    nodes: [
      {
        id: "cold",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: P_FROM,
        temperature: T_FROM,
      },
      {
        id: "hot",
        type: "boundary",
        x: 100,
        y: 0,
        pressure: P_TO,
        temperature: T_TO,
      },
    ],
    branches: [
      {
        id: "r",
        from: "cold",
        to: "hot",
        component: { type: "customResistance", k: K, area: AREA },
      },
    ],
  };
}

const rhoFrom = P_FROM / (R_AIR * T_FROM);
const rhoTo = P_TO / (R_AIR * T_TO);
const dP = P_FROM - P_TO;

describe("settings.momentumFlux", () => {
  it("reproduces the friction-only flow when off (and by default)", () => {
    const expected = AREA * Math.sqrt((2 * rhoFrom * dP) / K);
    for (const cfg of [gasNetwork(undefined), gasNetwork(false)]) {
      expect(validateNetwork(cfg)).toEqual([]);
      const r = solveSteady(cfg);
      expect(r.converged).toBe(true);
      expect(r.branches["r"].mdot / expected).toBeCloseTo(1, 6);
    }
  });

  it("adds (ṁ/A)²·(1/ρ_dn − 1/ρ_up) to the branch momentum balance", () => {
    const coeff = K / (2 * rhoFrom) + (1 / rhoTo - 1 / rhoFrom);
    const expected = AREA * Math.sqrt(dP / coeff);
    const cfg = gasNetwork(true);
    expect(validateNetwork(cfg)).toEqual([]);
    const r = solveSteady(cfg);
    expect(r.converged).toBe(true);
    expect(r.branches["r"].mdot / expected).toBeCloseTo(1, 6);
    // The reported branch dP mirrors the momentum row: it includes the
    // acceleration term, so it still telescopes to the node pressures.
    expect(r.branches["r"].dP / dP).toBeCloseTo(1, 6);
  });

  it("is a real restriction: expanding flow passes less for the same ΔP", () => {
    const off = solveSteady(gasNetwork(false));
    const on = solveSteady(gasNetwork(true));
    expect(on.branches["r"].mdot).toBeLessThan(off.branches["r"].mdot);
  });

  it("is identically zero for constant-density flow", () => {
    const water = (momentumFlux: boolean): NetworkConfig => ({
      meta: { name: "momentum-flux water run", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-10,
        maxIterations: 200,
        momentumFlux,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "a",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 3e5,
          temperature: 300,
        },
        {
          id: "b",
          type: "boundary",
          x: 100,
          y: 0,
          pressure: 1e5,
          temperature: 320,
        },
      ],
      branches: [
        {
          id: "r",
          from: "a",
          to: "b",
          component: { type: "customResistance", k: K, area: AREA },
        },
      ],
    });
    const off = solveSteady(water(false));
    const on = solveSteady(water(true));
    expect(on.branches["r"].mdot).toBe(off.branches["r"].mdot);
  });
});
