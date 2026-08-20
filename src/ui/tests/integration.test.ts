import { describe, it, expect } from "vitest";
import { examples } from "../examples";
import { validateNetwork, solveSteady, solveTransient } from "../../core";
import type { NetworkConfig } from "../types";

describe("integration: solver + examples", () => {
  it("Three-pipe junction solves steady and converges", () => {
    const config = examples["Three-pipe junction"];
    const errs = validateNetwork(config);
    expect(errs).toEqual([]);

    const result = solveSteady(config);
    expect(result.converged).toBe(true);
    expect(result.iterations).toBeGreaterThan(0);
    expect(result.residual).toBeLessThan(config.settings.tolerance);

    // Positive flow from high-pressure inlet to lower-pressure outlets
    expect(result.branches["b1"].mdot).toBeGreaterThan(0);
    expect(result.branches["b2"].mdot).toBeGreaterThan(0);
    expect(result.branches["b3"].mdot).toBeGreaterThan(0);

    // Result shape sanity
    expect(Object.keys(result.nodes)).toEqual(
      expect.arrayContaining(["in", "j", "out1", "out2"]),
    );
    expect(Object.keys(result.branches)).toEqual(
      expect.arrayContaining(["b1", "b2", "b3"]),
    );
    expect(result.branches["b1"]).toHaveProperty("velocity");
    expect(result.branches["b1"]).toHaveProperty("dP");
    expect(result.branches["b1"]).toHaveProperty("reynolds");
  });

  it("Tank blowdown solves transient and converges", () => {
    const config = examples["Tank blowdown"];
    const errs = validateNetwork(config);
    expect(errs).toEqual([]);

    const result = solveTransient(config);
    expect(result.converged).toBe(true);
    expect(result.times.length).toBeGreaterThan(1);

    // Tank pressure monotonically decreases toward ambient
    const tankPressures = result.nodes["tank"].pressure;
    for (let i = 1; i < tankPressures.length; i++) {
      expect(tankPressures[i]).toBeLessThanOrEqual(tankPressures[i - 1] + 1e-6); // allow tiny numerical wiggle
    }
    const finalPressure = tankPressures[tankPressures.length - 1];
    expect(finalPressure).toBeLessThan(tankPressures[0]);
    expect(finalPressure).toBeGreaterThanOrEqual(101325);

    // Positive discharge flow from tank to ambient
    const mdots = result.branches["orifice"].mdot;
    expect(mdots[0]).toBeGreaterThan(0);
    // Flow should decrease as tank depressurizes
    expect(mdots[mdots.length - 1]).toBeLessThan(mdots[0]);
  });

  it("catches validation errors before solving", () => {
    const badConfig: NetworkConfig = {
      meta: { name: "bad", version: 2 },
      settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [{ id: "A", type: "boundary", x: 0, y: 0 }],
      branches: [],
    };
    const errs = validateNetwork(badConfig);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes("pressure"))).toBe(true);
  });

  it("steady result shape matches UI expectations", () => {
    const config = examples["Three-pipe junction"];
    const result = solveSteady(config);
    // UI ResultsPanel expects these keys
    expect(result).toHaveProperty("converged");
    expect(result).toHaveProperty("iterations");
    expect(result).toHaveProperty("residual");
    expect(result).toHaveProperty("nodes");
    expect(result).toHaveProperty("branches");
    expect(result.nodes["in"]).toHaveProperty("pressure");
    expect(result.nodes["in"]).toHaveProperty("temperature");
    expect(result.nodes["in"]).toHaveProperty("density");
    expect(result.branches["b1"]).toHaveProperty("mdot");
    expect(result.branches["b1"]).toHaveProperty("velocity");
    expect(result.branches["b1"]).toHaveProperty("dP");
    expect(result.branches["b1"]).toHaveProperty("reynolds");
  });

  it("transient result shape matches UI expectations", () => {
    const config = examples["Tank blowdown"];
    const result = solveTransient(config);
    // UI ResultsPanel expects these keys
    expect(result).toHaveProperty("converged");
    expect(result).toHaveProperty("times");
    expect(result).toHaveProperty("nodes");
    expect(result).toHaveProperty("branches");
    expect(result.times.length).toBeGreaterThan(0);
    expect(result.nodes["tank"]).toHaveProperty("pressure");
    expect(result.nodes["tank"]).toHaveProperty("temperature");
    expect(result.nodes["tank"]).toHaveProperty("density");
    expect(Array.isArray(result.nodes["tank"].pressure)).toBe(true);
    expect(result.branches["orifice"]).toHaveProperty("mdot");
    expect(Array.isArray(result.branches["orifice"].mdot)).toBe(true);
  });
});
