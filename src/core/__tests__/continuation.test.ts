import { describe, it, expect } from "vitest";
import { NetworkConfig } from "../schema";
import { solveSteady } from "../solver";
import { seedConfigFromResult, solveWithContinuation } from "../continuation";

describe("seedConfigFromResult", () => {
  it("seeds internal node P/T from a steady result", () => {
    const config: NetworkConfig = {
      meta: { name: "test", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 300_000,
          temperature: 300,
        },
        {
          id: "mid",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 200_000,
          temperature: 300,
        },
        {
          id: "out",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: 100_000,
          temperature: 300,
        },
      ],
      branches: [
        {
          id: "p1",
          from: "in",
          to: "mid",
          component: { type: "pipe", length: 2, diameter: 0.05, roughness: 0 },
        },
        {
          id: "p2",
          from: "mid",
          to: "out",
          component: { type: "pipe", length: 2, diameter: 0.05, roughness: 0 },
        },
      ],
    };
    const result = solveSteady(config);
    expect(result.converged).toBe(true);

    const seeded = seedConfigFromResult(config, result);
    expect(seeded.nodes.find((n) => n.id === "mid")!.pressure).toBe(
      result.nodes.mid.pressure,
    );
    expect(seeded.nodes.find((n) => n.id === "mid")!.temperature).toBe(
      result.nodes.mid.temperature,
    );
    // Boundary nodes should remain untouched
    expect(seeded.nodes.find((n) => n.id === "in")!.pressure).toBe(300_000);
    expect(seeded.nodes.find((n) => n.id === "out")!.pressure).toBe(100_000);
  });

  it("seeds two-phase quality from a steady result when present", () => {
    const config: NetworkConfig = {
      meta: { name: "test", version: 2 },
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
          pressure: 200_000,
          temperature: 300,
        },
        {
          id: "B",
          type: "internal",
          x: 1,
          y: 0,
          pressure: 150_000,
          temperature: 300,
          quality: 0.5,
        },
      ],
      branches: [
        {
          id: "p1",
          from: "A",
          to: "B",
          component: { type: "pipe", length: 1, diameter: 0.05, roughness: 0 },
        },
      ],
    };
    const result = solveSteady(config);
    // incompressible ignores quality, but seedConfigFromResult should still handle it
    const seeded = seedConfigFromResult(config, result);
    const b = seeded.nodes.find((n) => n.id === "B")!;
    // quality was present in input but should be overwritten/removed based on result
    // For incompressible result, quality is undefined, so it should be deleted
    expect((b as any).quality).toBeUndefined();
  });

  it("seeds solid-node temperatures from a steady result", () => {
    const config: NetworkConfig = {
      meta: { name: "test", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-9,
        maxIterations: 500,
        relaxation: 0.9,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 200_000,
          temperature: 300,
        },
        {
          id: "out",
          type: "boundary",
          x: 2,
          y: 0,
          pressure: 100_000,
          temperature: 300,
        },
      ],
      solidNodes: [
        {
          id: "wall",
          type: "solid",
          x: 1,
          y: 1,
          temperature: 350,
          mass: 1,
          cp: 500,
        },
      ],
      conductors: [
        {
          id: "c1",
          from: "wall",
          to: "in",
          type: { kind: "convection", h: 100, area: 0.1 },
        },
      ],
      branches: [
        {
          id: "p1",
          from: "in",
          to: "out",
          component: { type: "pipe", length: 1, diameter: 0.05, roughness: 0 },
        },
      ],
    };
    const result = solveSteady(config);
    expect(result.converged).toBe(true);
    const seeded = seedConfigFromResult(config, result);
    expect(seeded.solidNodes!.find((s) => s.id === "wall")!.temperature).toBe(
      result.solidNodes!.wall.temperature,
    );
  });
});

describe("solveWithContinuation", () => {
  it("trivial 1-step continuation matches direct solveSteady", () => {
    function buildConfig(P_out: number): NetworkConfig {
      return {
        meta: { name: "pipe", version: 2 },
        settings: {
          mode: "steady",
          tolerance: 1e-9,
          maxIterations: 500,
          relaxation: 0.9,
        },
        fluid: { model: "incompressible", preset: "water" },
        nodes: [
          {
            id: "in",
            type: "boundary",
            x: 0,
            y: 0,
            pressure: 300_000,
            temperature: 300,
          },
          {
            id: "mid",
            type: "internal",
            x: 1,
            y: 0,
            pressure: 250_000,
            temperature: 300,
          },
          {
            id: "out",
            type: "boundary",
            x: 2,
            y: 0,
            pressure: P_out,
            temperature: 300,
          },
        ],
        branches: [
          {
            id: "p1",
            from: "in",
            to: "mid",
            component: {
              type: "pipe",
              length: 2,
              diameter: 0.05,
              roughness: 0,
            },
          },
          {
            id: "p2",
            from: "mid",
            to: "out",
            component: {
              type: "pipe",
              length: 2,
              diameter: 0.05,
              roughness: 0,
            },
          },
        ],
      };
    }

    const cont = solveWithContinuation(buildConfig, {
      paramStart: 200_000,
      paramTarget: 150_000,
      initialStep: 50_000,
      maxSteps: 10,
    });

    expect(cont.finalResult?.converged).toBe(true);
    expect(cont.history.length).toBe(2);
    expect(cont.history[0].paramValue).toBe(200_000);
    expect(cont.history[0].converged).toBe(true);
    expect(cont.history[1].paramValue).toBe(150_000);
    expect(cont.history[1].converged).toBe(true);

    const direct = solveSteady(buildConfig(150_000));
    expect(direct.converged).toBe(true);
    expect(cont.finalResult!.nodes.mid.pressure).toBeCloseTo(
      direct.nodes.mid.pressure,
      6,
    );
  });

  it(
    "step adaptation: shrinks step when solver fails and eventually succeeds",
    { timeout: 30000 },
    () => {
      let lastConvergedParam = 200_000;

      function buildConfig(P_out: number): NetworkConfig {
        return {
          meta: { name: `pipe_${P_out}`, version: 2 },
          settings: {
            mode: "steady",
            tolerance: 1e-9,
            maxIterations: 10,
            relaxation: 0.9,
          },
          fluid: { model: "incompressible", preset: "water" },
          nodes: [
            {
              id: "in",
              type: "boundary",
              x: 0,
              y: 0,
              pressure: 300_000,
              temperature: 300,
            },
            {
              id: "mid",
              type: "internal",
              x: 1,
              y: 0,
              pressure: 250_000,
              temperature: 300,
            },
            {
              id: "out",
              type: "boundary",
              x: 2,
              y: 0,
              pressure: P_out,
              temperature: 300,
            },
          ],
          branches: [
            {
              id: "p1",
              from: "in",
              to: "mid",
              component: {
                type: "pipe",
                length: 2,
                diameter: 0.05,
                roughness: 0,
              },
            },
            {
              id: "p2",
              from: "mid",
              to: "out",
              component: {
                type: "pipe",
                length: 2,
                diameter: 0.05,
                roughness: 0,
              },
            },
          ],
        };
      }

      function customSolver(config: NetworkConfig) {
        const distance = Math.abs(
          parseFloat(config.meta.name.split("_")[1]) - lastConvergedParam,
        );
        const maxIter = distance < 5000 ? 10 : 4;
        const patched: NetworkConfig = JSON.parse(JSON.stringify(config));
        patched.settings.maxIterations = maxIter;
        const res = solveSteady(patched);
        if (res.converged) {
          lastConvergedParam = parseFloat(config.meta.name.split("_")[1]);
        }
        return res;
      }

      const result = solveWithContinuation(buildConfig, {
        paramStart: 200_000,
        paramTarget: 100_000,
        initialStep: 100_000,
        minStep: 10,
        maxStep: 100_000,
        shrinkFactor: 0.5,
        growFactor: 1.5,
        maxSteps: 200,
        solver: customSolver,
      });

      expect(result.finalResult?.converged).toBe(true);
      expect(Math.abs(lastConvergedParam - 100_000)).toBeLessThan(10);

      const failed = result.history.filter((h) => !h.converged);
      expect(failed.length).toBeGreaterThan(0);

      const last = result.history[result.history.length - 1];
      expect(last.converged).toBe(true);
      expect(Math.abs(last.paramValue - 100_000)).toBeLessThan(10);

      // Verify that there is at least one retry (shrunk step) before success.
      let sawShrink = false;
      for (let i = 1; i < result.history.length; i++) {
        if (!result.history[i].converged && result.history[i + 1]?.converged) {
          sawShrink = true;
        }
      }
      expect(sawShrink).toBe(true);
    },
  );
});
