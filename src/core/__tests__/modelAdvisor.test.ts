/**
 * modelAdvisor — deterministic settings suggestions and readiness checks.
 *
 * These are UX-facing heuristics, so the tests pin BEHAVIOR (what is
 * suggested and why) rather than exact numbers where the numbers are
 * derived (dt from endTime, etc.).
 */
import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../schema";
import { suggestSolverSettings, assessModelReadiness } from "../modelAdvisor";

function baseConfig(): NetworkConfig {
  return {
    meta: { name: "advisor-test", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-6,
      maxIterations: 200,
      relaxation: 0.9,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "a",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 2e5,
        temperature: 300,
      },
      {
        id: "b",
        type: "boundary",
        x: 100,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "p1",
        from: "a",
        to: "b",
        component: {
          type: "pipe",
          length: 1,
          diameter: 0.02,
          roughness: 1e-5,
        },
      },
    ],
  };
}

describe("suggestSolverSettings", () => {
  it("suggests nothing for a plain steady liquid network", () => {
    const s = suggestSolverSettings(baseConfig());
    expect(s.patch).toEqual({});
    expect(s.rationale).toEqual([]);
  });

  it("suggests transient mode (with a reason) when schedules exist", () => {
    const cfg = baseConfig();
    cfg.nodes[0].pressureSchedule = [
      [0, 2e5],
      [10, 1.5e5],
    ];
    const s = suggestSolverSettings(cfg);
    expect(s.patch.mode).toBe("transient");
    // endTime matches the last scheduled point; dt derived from it.
    expect(s.patch.endTime).toBe(10);
    expect(s.patch.dt).toBeGreaterThan(0);
    expect(s.patch.dt!).toBeLessThanOrEqual(10);
    const modeReason = s.rationale.find((r) => r.field === "mode");
    expect(modeReason?.reason).toMatch(/schedule/i);
  });

  it("does not fight an explicit transient setup", () => {
    const cfg = baseConfig();
    cfg.nodes[0].pressureSchedule = [
      [0, 2e5],
      [10, 1.5e5],
    ];
    cfg.settings.mode = "transient";
    cfg.settings.dt = 0.05;
    cfg.settings.endTime = 20;
    const s = suggestSolverSettings(cfg);
    expect(s.patch.mode).toBeUndefined();
    expect(s.patch.dt).toBeUndefined();
    expect(s.patch.endTime).toBeUndefined();
  });

  it("suggests compressible duct physics for gas through an area change", () => {
    const cfg = baseConfig();
    cfg.fluid = { model: "idealGas", preset: "air" };
    cfg.branches.push({
      id: "ac1",
      from: "a",
      to: "b",
      component: { type: "areaChange", areaIn: 1e-3, areaOut: 5e-4 },
    });
    const s = suggestSolverSettings(cfg);
    expect(s.patch.momentumFlux).toBe(true);
    expect(s.patch.kineticEnergy).toBe(true);
  });

  it("does not suggest duct physics for an orifice (Y-factor closure is already compressible)", () => {
    const cfg = baseConfig();
    cfg.fluid = { model: "idealGas", preset: "air" };
    cfg.branches.push({
      id: "o1",
      from: "a",
      to: "b",
      component: { type: "orifice", area: 1e-4, cd: 0.6 },
    });
    const s = suggestSolverSettings(cfg);
    expect(s.patch.momentumFlux).toBeUndefined();
    expect(s.patch.kineticEnergy).toBeUndefined();
  });

  it("suggests extra under-relaxation for two-phase-prone setups", () => {
    const cfg = baseConfig();
    cfg.fluid = { model: "realFluid", params: { fluidName: "Nitrogen" } };
    cfg.nodes[0].quality = 0.5;
    cfg.nodes[0].temperature = undefined;
    const s = suggestSolverSettings(cfg);
    expect(s.patch.relaxation).toBe(0.7);
  });

  it("suggests adaptive stepping for stiff transients", () => {
    const cfg = baseConfig();
    cfg.settings.mode = "transient";
    cfg.settings.dt = 0.01;
    cfg.settings.endTime = 5;
    cfg.branches.push({
      id: "rv1",
      from: "a",
      to: "b",
      component: {
        type: "reliefValve",
        crackPressure: 1.5e5,
        fullOpenPressure: 1.8e5,
        area: 1e-4,
        cd: 0.8,
      },
    });
    const s = suggestSolverSettings(cfg);
    expect(s.patch.timeStepping).toBe("adaptive");
    expect(s.patch.adaptive).toBeDefined();
  });
});

describe("assessModelReadiness", () => {
  it("walks a complete steady model to all-ok", () => {
    const checks = assessModelReadiness(baseConfig());
    for (const c of checks) {
      expect(c.status, `${c.id}: ${c.detail}`).toBe("ok");
    }
  });

  it("flags an empty model as needing topology", () => {
    const cfg = baseConfig();
    cfg.nodes = [];
    cfg.branches = [];
    const checks = assessModelReadiness(cfg);
    expect(checks.find((c) => c.id === "topology")?.status).toBe("todo");
  });

  it("flags incomplete boundary conditions with click-to-fix targets", () => {
    const cfg = baseConfig();
    delete cfg.nodes[0].pressure;
    const checks = assessModelReadiness(cfg);
    const bnd = checks.find((c) => c.id === "boundaries");
    expect(bnd?.status).toBe("todo");
    expect(bnd?.targets).toEqual([{ kind: "node", id: "a" }]);
  });

  it("warns about orphan nodes", () => {
    const cfg = baseConfig();
    cfg.nodes.push({
      id: "orphan",
      type: "internal",
      x: 50,
      y: 50,
      pressure: 1e5,
      temperature: 300,
    });
    const checks = assessModelReadiness(cfg);
    const conn = checks.find((c) => c.id === "connectivity");
    expect(conn?.status).toBe("warning");
    expect(conn?.targets).toContainEqual({ kind: "node", id: "orphan" });
  });

  it("lists missing transient requirements", () => {
    const cfg = baseConfig();
    cfg.settings.mode = "transient"; // no dt / endTime, boundary-only nodes
    cfg.nodes.push({
      id: "mid",
      type: "internal",
      x: 50,
      y: 0,
      pressure: 1.5e5,
      temperature: 300,
      // no volume
    });
    cfg.branches.push({
      id: "p2",
      from: "a",
      to: "mid",
      component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
    });
    const checks = assessModelReadiness(cfg);
    const solve = checks.find((c) => c.id === "solve-settings");
    expect(solve?.status).toBe("todo");
    expect(solve?.detail).toMatch(/dt/);
    expect(solve?.detail).toMatch(/end time/);
    expect(solve?.detail).toMatch(/volumes/);
  });
});
