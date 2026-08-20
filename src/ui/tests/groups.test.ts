import { describe, it, expect } from "vitest";
import { validateNetwork, solveSteady } from "../../core";
import type { NetworkConfig } from "../types";
import { cloneConfig } from "../utils";

describe("groups: schema validation", () => {
  it("flags duplicate group ids", () => {
    const config: NetworkConfig = {
      meta: { name: "g", version: 2 },
      settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 101325,
          temperature: 293,
        },
        {
          id: "B",
          type: "boundary",
          x: 100,
          y: 0,
          pressure: 100000,
          temperature: 293,
        },
      ],
      groups: [
        { id: "G1", label: "Dup", x: 0, y: 0 },
        { id: "G1", label: "Dup", x: 0, y: 0 },
      ],
      branches: [
        {
          id: "b1",
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
    };
    const errs = validateNetwork(config);
    expect(errs.some((e) => e.includes("Duplicate group id"))).toBe(true);
  });

  it("flags node referencing unknown group", () => {
    const config: NetworkConfig = {
      meta: { name: "g", version: 2 },
      settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 101325,
          temperature: 293,
          group: "missing",
        },
        {
          id: "B",
          type: "boundary",
          x: 100,
          y: 0,
          pressure: 100000,
          temperature: 293,
        },
      ],
      branches: [
        {
          id: "b1",
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
    };
    const errs = validateNetwork(config);
    expect(errs.some((e) => e.includes("unknown group"))).toBe(true);
  });

  it("valid config with groups passes", () => {
    const config: NetworkConfig = {
      meta: { name: "g", version: 2 },
      settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 101325,
          temperature: 293,
          group: "G1",
        },
        {
          id: "B",
          type: "boundary",
          x: 100,
          y: 0,
          pressure: 100000,
          temperature: 293,
          group: "G1",
        },
        {
          id: "C",
          type: "boundary",
          x: 200,
          y: 0,
          pressure: 100000,
          temperature: 293,
        },
      ],
      groups: [{ id: "G1", label: "Sub", x: 50, y: 50 }],
      branches: [
        {
          id: "b1",
          from: "A",
          to: "B",
          component: {
            type: "pipe",
            length: 1,
            diameter: 0.02,
            roughness: 1e-5,
          },
        },
        {
          id: "b2",
          from: "B",
          to: "C",
          component: {
            type: "pipe",
            length: 1,
            diameter: 0.02,
            roughness: 1e-5,
          },
        },
      ],
    };
    const errs = validateNetwork(config);
    expect(errs).toEqual([]);
  });
});

describe("groups: solver equivalence", () => {
  it("grouped network produces identical results to flat network", () => {
    const flatConfig: NetworkConfig = {
      meta: { name: "flat", version: 2 },
      settings: {
        mode: "steady",
        tolerance: 1e-6,
        maxIterations: 200,
        relaxation: 0.9,
      },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "in",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 200000,
          temperature: 293,
        },
        {
          id: "j",
          type: "internal",
          x: 100,
          y: 0,
          pressure: 150000,
          temperature: 293,
          volume: 0.1,
        },
        {
          id: "out",
          type: "boundary",
          x: 200,
          y: 0,
          pressure: 100000,
          temperature: 293,
        },
      ],
      branches: [
        {
          id: "b1",
          from: "in",
          to: "j",
          component: {
            type: "pipe",
            length: 1,
            diameter: 0.02,
            roughness: 1e-5,
          },
        },
        {
          id: "b2",
          from: "j",
          to: "out",
          component: {
            type: "pipe",
            length: 1,
            diameter: 0.02,
            roughness: 1e-5,
          },
        },
      ],
    };

    const groupedConfig = cloneConfig(flatConfig);
    groupedConfig.groups = [{ id: "G1", label: "Subgroup", x: 50, y: 50 }];
    groupedConfig.nodes[0].group = "G1";
    groupedConfig.nodes[1].group = "G1";

    const flatResult = solveSteady(flatConfig);
    const groupedResult = solveSteady(groupedConfig);

    expect(groupedResult.converged).toBe(true);
    expect(flatResult.converged).toBe(true);

    const flatNodeIds = Object.keys(flatResult.nodes).sort();
    const groupedNodeIds = Object.keys(groupedResult.nodes).sort();
    expect(groupedNodeIds).toEqual(flatNodeIds);

    for (const id of flatNodeIds) {
      expect(groupedResult.nodes[id].pressure).toBeCloseTo(
        flatResult.nodes[id].pressure,
        12,
      );
      expect(groupedResult.nodes[id].temperature).toBeCloseTo(
        flatResult.nodes[id].temperature,
        12,
      );
      expect(groupedResult.nodes[id].density).toBeCloseTo(
        flatResult.nodes[id].density,
        12,
      );
    }

    const flatBranchIds = Object.keys(flatResult.branches).sort();
    const groupedBranchIds = Object.keys(groupedResult.branches).sort();
    expect(groupedBranchIds).toEqual(flatBranchIds);

    for (const id of flatBranchIds) {
      expect(groupedResult.branches[id].mdot).toBeCloseTo(
        flatResult.branches[id].mdot,
        12,
      );
      expect(groupedResult.branches[id].velocity).toBeCloseTo(
        flatResult.branches[id].velocity,
        12,
      );
      expect(groupedResult.branches[id].dP).toBeCloseTo(
        flatResult.branches[id].dP,
        12,
      );
      expect(groupedResult.branches[id].reynolds).toBeCloseTo(
        flatResult.branches[id].reynolds,
        12,
      );
    }
  });
});

describe("groups: persistence round-trip", () => {
  it("save/load preserves groups and node memberships", () => {
    const config: NetworkConfig = {
      meta: { name: "persist", version: 2 },
      settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
      fluid: { model: "incompressible", preset: "water" },
      nodes: [
        {
          id: "A",
          type: "boundary",
          x: 0,
          y: 0,
          pressure: 101325,
          temperature: 293,
          group: "G1",
        },
        {
          id: "B",
          type: "boundary",
          x: 100,
          y: 0,
          pressure: 100000,
          temperature: 293,
        },
      ],
      groups: [{ id: "G1", label: "Sub", x: 50, y: 50 }],
      branches: [
        {
          id: "b1",
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
    };

    const json = JSON.stringify(config);
    const loaded = JSON.parse(json) as NetworkConfig;

    expect(loaded.groups).toHaveLength(1);
    expect(loaded.groups![0].id).toBe("G1");
    expect(loaded.groups![0].label).toBe("Sub");
    expect(loaded.nodes[0].group).toBe("G1");
    expect(loaded.nodes[1].group).toBeUndefined();
  });
});
