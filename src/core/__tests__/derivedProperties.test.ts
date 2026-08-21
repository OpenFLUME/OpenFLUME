/**
 * Reporting-only derived properties (solver/derivedProperties.ts) as they
 * reach the published result: the arithmetic, the honesty rule that an
 * unavailable quantity is omitted rather than defaulted, and the requirement
 * that a steady solve and a transient run publish the SAME set.
 */
import { describe, it, expect } from "vitest";
import { IdealGas } from "../fluids";
import { NetworkConfig } from "../schema";
import { solveSteady } from "../solver";
import { solveTransient } from "../transient";

function gasLine(overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  return {
    meta: { name: "derived-props", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-9,
      maxIterations: 500,
      relaxation: 0.9,
    },
    fluid: { model: "idealGas", preset: "air" },
    nodes: [
      {
        id: "A",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 4e5,
        temperature: 320,
      },
      {
        id: "B",
        type: "boundary",
        x: 1,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "p1",
        from: "A",
        to: "B",
        component: { type: "pipe", length: 2, diameter: 0.02, roughness: 1e-5 },
      },
    ],
    ...overrides,
  } as NetworkConfig;
}

describe("branch flow quantities", () => {
  it("are mutually consistent with mass flow, density and area", () => {
    const res = solveSteady(gasLine());
    const b = res.branches.p1;
    const rho = res.nodes.A.density;
    const area = Math.PI * 0.01 * 0.01;

    expect(b.velocity).toBeCloseTo(b.mdot / (rho * area), 9);
    expect(b.volumetricFlow!).toBeCloseTo(b.mdot / rho, 9);
    expect(b.massFlux!).toBeCloseTo(b.mdot / area, 6);
    expect(b.dynamicPressure!).toBeCloseTo(0.5 * rho * b.velocity ** 2, 6);
  });

  it("carry the sign of the flow, except for the magnitudes", () => {
    // Reverse the driving pressure: everything directional flips, the
    // magnitudes do not.
    const reversed = solveSteady(
      gasLine({
        nodes: [
          {
            id: "A",
            type: "boundary",
            x: 0,
            y: 0,
            pressure: 1e5,
            temperature: 300,
          },
          {
            id: "B",
            type: "boundary",
            x: 1,
            y: 0,
            pressure: 4e5,
            temperature: 320,
          },
        ],
      } as Partial<NetworkConfig>),
    );
    const b = reversed.branches.p1;
    expect(b.mdot).toBeLessThan(0);
    expect(b.velocity).toBeLessThan(0);
    expect(b.volumetricFlow!).toBeLessThan(0);
    expect(b.massFlux!).toBeLessThan(0);
    expect(b.dP).toBeLessThan(0);
    expect(b.dynamicPressure!).toBeGreaterThan(0);
    expect(b.reynolds).toBeGreaterThan(0);
    expect(b.mach!).toBeGreaterThan(0);
  });

  it("report Mach against the upstream sound speed for a gas", () => {
    const res = solveSteady(gasLine());
    const a = IdealGas.AIR.speedOfSound!(
      res.nodes.A.pressure,
      res.nodes.A.temperature,
    );
    expect(res.nodes.A.speedOfSound!).toBeCloseTo(a, 6);
    expect(res.branches.p1.mach!).toBeCloseTo(
      Math.abs(res.branches.p1.velocity) / a,
      9,
    );
  });

  it("omit Mach and sound speed for a fluid model that has neither", () => {
    const res = solveSteady(
      gasLine({ fluid: { model: "incompressible", preset: "water" } }),
    );
    expect(res.branches.p1.mach).toBeUndefined();
    expect(res.nodes.A.speedOfSound).toBeUndefined();
    // The quantities that do not depend on a sound speed are still there.
    expect(res.branches.p1.velocity).toBeGreaterThan(0);
    expect(res.branches.p1.massFlux).toBeDefined();
  });

  it("omit mass flux and dynamic pressure for a component with no flow area", () => {
    const res = solveSteady(
      gasLine({
        branches: [
          {
            id: "p1",
            from: "A",
            to: "B",
            component: { type: "resistance", k: 1e6 },
          },
        ],
      } as Partial<NetworkConfig>),
    );
    const b = res.branches.p1;
    expect(b.massFlux).toBeUndefined();
    expect(b.dynamicPressure).toBeUndefined();
    expect(b.volumetricFlow).toBeDefined();
  });
});

describe("node thermodynamic state", () => {
  it("publishes the analytic model’s closures and omits what it cannot supply", () => {
    const res = solveSteady(gasLine());
    const n = res.nodes.A;
    expect(n.enthalpy!).toBeCloseTo(
      IdealGas.AIR.enthalpy(n.pressure, n.temperature),
      6,
    );
    expect(n.internalEnergy!).toBeCloseTo(
      IdealGas.AIR.internalEnergy(n.pressure, n.temperature),
      6,
    );
    expect(n.specificHeat!).toBeCloseTo(1005, 6);
    expect(n.viscosity!).toBeCloseTo(1.8e-5, 9);
    // The analytic ideal gas has no reference entropy and no conductivity model.
    expect(n.entropy).toBeUndefined();
    expect(n.thermalConductivity).toBeUndefined();
  });
});

describe("conductor heat flux", () => {
  it("is the heat rate divided by the transfer area", () => {
    const config: NetworkConfig = {
      meta: { name: "derived-props-thermal", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 2e5,
          temperature: 300,
        },
        {
          id: "B",
          type: "boundary",
          x: 1,
          y: 0,
          pressure: 1e5,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "p1",
          from: "A",
          to: "B",
          component: {
            type: "pipe",
            length: 1,
            diameter: 0.02,
            roughness: 1e-5,
          },
        },
      ],
      solidNodes: [{ id: "w", type: "solid", x: 0, y: 1, temperature: 500 }],
      conductors: [
        {
          id: "c1",
          from: "w",
          to: "A",
          type: { kind: "conduction", k: 15, area: 0.25, length: 0.01 },
        },
      ],
    } as NetworkConfig;
    const c = solveSteady(config).conductors!.c1;
    expect(c.heatFlux!).toBeCloseTo(c.heatRate / 0.25, 9);
  });
});

describe("steady and transient publish the same quantities", () => {
  it("records every steady branch/node quantity as an aligned transient series", () => {
    const steady = solveSteady(gasLine());
    const transient = solveTransient(
      gasLine({
        settings: {
          mode: "transient",
          tolerance: 1e-9,
          maxIterations: 500,
          relaxation: 0.9,
          timeStepping: "fixed",
          dt: 0.01,
          endTime: 0.05,
        },
      } as Partial<NetworkConfig>),
    );

    // The transient result may carry strictly more (gas volume and quality
    // have no steady meaning), but never less.
    const transientBranchKeys = Object.keys(transient.branches.p1);
    for (const field of Object.keys(steady.branches.p1)) {
      expect(transientBranchKeys, field).toContain(field);
    }
    const transientNodeKeys = Object.keys(transient.nodes.A);
    for (const field of Object.keys(steady.nodes.A)) {
      expect(transientNodeKeys, field).toContain(field);
    }

    // Every recorded series is sample-aligned with times.  `quality` is the
    // one exception: the recorder allocates it unconditionally and leaves it
    // empty for a non-real fluid, which the channel inventory then skips.
    const n = transient.times.length;
    const aligned = (table: object) => {
      for (const [field, series] of Object.entries(table)) {
        if (!Array.isArray(series)) continue;
        if (field === "quality" && series.length === 0) continue;
        expect(series, field).toHaveLength(n);
      }
    };
    aligned(transient.branches.p1);
    aligned(transient.nodes.A);
  });
});
