import { describe, it, expect, beforeAll } from "vitest";
import type { NetworkConfig } from "../schema";
import { initRealFluids, realFluidsReady } from "../";
import { solveSteady } from "../solver";
import { solveTransient } from "../transient";

// Regression: a compressible orifice (one whose fluid supplies an isentropic
// exponent, so the solver uses the ṁ − ṁ_expected residual) must carry flow
// in either direction. The closure used to pick the upstream/downstream pair
// by sgn(ṁ); an orifice declared against the pressure gradient then had no
// root at ṁ < 0 and converged to ṁ ≈ 0.

beforeAll(async () => {
  await initRealFluids();
  expect(realFluidsReady()).toBe(true);
}, 30000);

type FluidSpec = NetworkConfig["fluid"];

function twoReservoirs(
  fluid: FluidSpec,
  T: number,
  reversed: boolean,
): NetworkConfig {
  const hi = "hi";
  const lo = "lo";
  return {
    meta: { name: "orifice-reverse", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-9,
      maxIterations: 300,
      relaxation: 1,
    },
    fluid,
    nodes: [
      { id: hi, type: "boundary", x: 0, y: 0, pressure: 2e5, temperature: T },
      {
        id: "mid",
        type: "internal",
        x: 1,
        y: 0,
        pressure: 1.5e5,
        temperature: T,
        volume: 1e-3,
      },
      { id: lo, type: "boundary", x: 2, y: 0, pressure: 1e5, temperature: T },
    ],
    branches: [
      {
        id: "o1",
        from: reversed ? "mid" : hi,
        to: reversed ? hi : "mid",
        component: { type: "orifice", area: 1e-5, cd: 0.6 },
      },
      {
        id: "o2",
        from: reversed ? lo : "mid",
        to: reversed ? "mid" : lo,
        component: { type: "orifice", area: 1e-5, cd: 0.6 },
      },
    ],
  };
}

const cases: Array<[string, FluidSpec, number]> = [
  ["ideal-gas air", { model: "idealGas", preset: "air" }, 300],
  [
    "real-fluid nitrogen",
    { model: "realFluid", params: { fluidName: "Nitrogen" } },
    300,
  ],
];

describe("compressible orifice declared against the flow", () => {
  for (const [label, fluid, T] of cases) {
    it(`${label}: reversed declaration gives the equal-and-opposite steady flow`, () => {
      const fwd = solveSteady(twoReservoirs(fluid, T, false));
      const rev = solveSteady(twoReservoirs(fluid, T, true));
      expect(fwd.converged).toBe(true);
      expect(rev.converged).toBe(true);

      const mFwd = fwd.branches.o1.mdot;
      expect(mFwd).toBeGreaterThan(1e-4);
      // Reversed declaration: same magnitude, opposite sign, on both branches.
      for (const id of ["o1", "o2"]) {
        expect(rev.branches[id].mdot).toBeLessThan(0);
        expect(
          Math.abs(rev.branches[id].mdot + fwd.branches[id].mdot) / mFwd,
        ).toBeLessThan(1e-6);
      }
      expect(
        Math.abs(rev.nodes.mid.pressure - fwd.nodes.mid.pressure) /
          fwd.nodes.mid.pressure,
      ).toBeLessThan(1e-6);
    });
  }

  it("dead-end gas orifice: zero flow at equal pressures, either declaration", () => {
    // A closed tank behind one orifice: the steady root is P_tank = P_out
    // with ṁ = 0.  The ṁ-signed closure used to accept ṁ = 0 at ANY tank
    // pressure below P_out (ṁ_exp = 0 against the gradient).
    for (const reversed of [false, true]) {
      const cfg: NetworkConfig = {
        meta: { name: "orifice-dead-end", version: 2 },
        settings: {
          mode: "steady",
          tolerance: 1e-9,
          maxIterations: 300,
          relaxation: 0.9,
        },
        fluid: { model: "idealGas", preset: "air" },
        nodes: [
          {
            id: "tank",
            type: "internal",
            x: 0,
            y: 0,
            pressure: 1.5e5,
            temperature: 300,
          },
          {
            id: "out",
            type: "boundary",
            x: 1,
            y: 0,
            pressure: 101325,
            temperature: 300,
          },
        ],
        branches: [
          {
            id: "o1",
            from: reversed ? "out" : "tank",
            to: reversed ? "tank" : "out",
            initialMdot: 0,
            component: { type: "orifice", area: 1e-4, cd: 0.6 },
          },
        ],
      };
      const r = solveSteady(cfg);
      expect(r.converged).toBe(true);
      expect(Math.abs(r.nodes.tank.pressure - 101325)).toBeLessThan(1e-3);
      expect(Math.abs(r.branches.o1.mdot)).toBeLessThan(1e-9);
    }
  });

  // Regression (e2e "Unit switching", the Tank blowdown example solved
  // steady): a closed tank behind one orifice from the DEFAULT flow guess
  // (0.1 kg/s, no initialMdot).  The steady Newton used to step the tank
  // straight to the 1 Pa pressure floor — the choked row linearises as
  // ṁ ∝ P_tank and the ṁ|ṁ| tangent of a reversing flow guess overshoots by
  // ~1 MPa — where the orifice chokes INTO the tank, no residual depends on
  // P_tank, and the singular step (and the PTC shift) pushed the pressure
  // against the net inflow: converged = false, ṁ = choked inflow.  Starts
  // cover choked outflow (5e5), unchoked either side (1.5e5, 9e4) and choked
  // inflow (3e4 < r*·P_out), for both declarations and both EOS families.
  for (const [label, fluid] of cases) {
    it(`${label}: steady dead-end orifice reaches P_tank = P_out, ṁ = 0 from any start`, () => {
      for (const reversed of [false, true]) {
        for (const p0 of [5e5, 1.5e5, 9e4, 3e4]) {
          const cfg: NetworkConfig = {
            meta: { name: "orifice-dead-end-start", version: 2 },
            settings: {
              mode: "steady",
              tolerance: 1e-6,
              maxIterations: 200,
              relaxation: 0.9,
            },
            fluid,
            nodes: [
              {
                id: "tank",
                type: "internal",
                x: 0,
                y: 0,
                pressure: p0,
                temperature: 300,
                volume: 0.1,
              },
              {
                id: "out",
                type: "boundary",
                x: 1,
                y: 0,
                pressure: 101325,
                temperature: 300,
              },
            ],
            branches: [
              {
                id: "o1",
                from: reversed ? "out" : "tank",
                to: reversed ? "tank" : "out",
                component: { type: "orifice", area: 1e-4, cd: 0.6 },
              },
            ],
          };
          const r = solveSteady(cfg);
          const where = `${reversed ? "reversed" : "forward"}, P0 = ${p0}`;
          expect(r.converged, where).toBe(true);
          expect(Math.abs(r.nodes.tank.pressure - 101325), where).toBeLessThan(
            1e-3,
          );
          expect(Math.abs(r.branches.o1.mdot), where).toBeLessThan(1e-9);
          // Stagnant tank: the steady balance does not set its temperature,
          // which must stay where the start left it — held T (ideal gas) or
          // held h (real fluid: T moves by the Joule–Thomson shift of the
          // pressure change, < 1 K here) — not collapse to h = 0 ⇒ T = 0 K.
          expect(Math.abs(r.nodes.tank.temperature - 300), where).toBeLessThan(
            2,
          );
        }
      }
    });
  }

  it("transient flow reversal through a gas orifice between two tanks", () => {
    // Two closed tanks joined by an orifice, the high-pressure tank at the
    // orifice's `to` end. Flow must run to → from (ṁ < 0) and the tanks
    // must equalize; with the orifice declared the other way the history
    // must be the exact mirror image.
    const build = (reversed: boolean): NetworkConfig => ({
      meta: { name: "orifice-reversal-transient", version: 2 },
      settings: {
        mode: "transient",
        dt: 0.05,
        endTime: 3,
        tolerance: 1e-9,
        maxIterations: 300,
        relaxation: 1,
      },
      fluid: { model: "idealGas", preset: "air" },
      nodes: [
        {
          id: "a",
          type: "internal",
          x: 0,
          y: 0,
          pressure: 1e5,
          temperature: 300,
          volume: 0.01,
        },
        {
          id: "b",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 3e5,
          temperature: 300,
          volume: 0.01,
        },
        {
          id: "amb",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "o1",
          from: reversed ? "b" : "a",
          to: reversed ? "a" : "b",
          component: { type: "orifice", area: 2e-5, cd: 0.6 },
        },
        {
          id: "v1",
          from: "a",
          to: "amb",
          component: { type: "valve", area: 1e-4, cd: 0.6, position: 0 },
        },
      ],
    });
    const fwd = solveTransient(build(false));
    const rev = solveTransient(build(true));
    expect(fwd.converged).toBe(true);
    expect(rev.converged).toBe(true);

    const mF = fwd.branches.o1.mdot;
    const mR = rev.branches.o1.mdot;
    // Declared a → b while b is at higher pressure: flow is negative.
    const peak = Math.max(...mF.slice(1).map((m) => -m));
    expect(peak).toBeGreaterThan(1e-3);
    for (let i = 1; i < mF.length; i++) {
      expect(mF[i]).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(mF[i] + mR[i]) / peak).toBeLessThan(1e-6);
    }
    // The tanks equalize toward the common pressure.
    const last = fwd.times.length - 1;
    const pa = fwd.nodes.a.pressure[last];
    const pb = fwd.nodes.b.pressure[last];
    expect(Math.abs(pa - pb) / pb).toBeLessThan(0.02);
    expect(pa).toBeGreaterThan(1.5e5);
  });

  it("transient sign change: a scheduled boundary drives the orifice flow forward then back", () => {
    // Tank ↔ boundary through one orifice. The boundary is above the tank
    // pressure first (fills the tank), then drops below it (drains the
    // tank): the orifice flow must change sign mid-run, and declaring the
    // orifice the other way must give the mirror-image history.
    const build = (reversed: boolean): NetworkConfig => ({
      meta: { name: "orifice-sign-change", version: 2 },
      settings: {
        mode: "transient",
        dt: 0.05,
        endTime: 4,
        tolerance: 1e-9,
        maxIterations: 300,
        relaxation: 1,
      },
      fluid: { model: "idealGas", preset: "air" },
      nodes: [
        {
          id: "src",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 3e5,
          temperature: 300,
          pressureSchedule: [
            [0, 3e5],
            [1, 3e5],
            [1.5, 1e5],
            [4, 1e5],
          ],
        },
        {
          id: "tank",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 2e5,
          temperature: 300,
          volume: 0.01,
        },
      ],
      branches: [
        {
          id: "o1",
          from: reversed ? "tank" : "src",
          to: reversed ? "src" : "tank",
          component: { type: "orifice", area: 2e-5, cd: 0.6 },
        },
      ],
    });
    const fwd = solveTransient(build(false));
    const rev = solveTransient(build(true));
    expect(fwd.converged).toBe(true);
    expect(rev.converged).toBe(true);
    const mF = fwd.branches.o1.mdot;
    const mR = rev.branches.o1.mdot;
    const peak = Math.max(...mF.slice(1).map(Math.abs));
    // Both directions occur in the forward-declared history …
    expect(Math.max(...mF.slice(1))).toBeGreaterThan(0.1 * peak);
    expect(Math.min(...mF.slice(1))).toBeLessThan(-0.1 * peak);
    // … and the reversed declaration mirrors it step by step.
    for (let i = 1; i < mF.length; i++) {
      expect(Math.abs(mF[i] + mR[i]) / peak).toBeLessThan(1e-6);
      expect(
        Math.abs(fwd.nodes.tank.pressure[i] - rev.nodes.tank.pressure[i]) /
          fwd.nodes.tank.pressure[i],
      ).toBeLessThan(1e-6);
    }
  });
});
