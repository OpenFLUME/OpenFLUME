import { describe, expect, it } from "vitest";
import type { NetworkConfig } from "../types";
import {
  canStartConductor,
  canStartFluidBranch,
  compatibleConductorKinds,
  compatibleConductorNodeIds,
  conductorEndpointError,
  fluidBranchEndpointError,
} from "../connectionRules";
import {
  CONDUCTOR_KINDS,
  createTopologyModel,
  conductorEndpointError as coreConductorEndpointError,
  fluidBranchEndpointError as coreFluidBranchEndpointError,
} from "../../core/topology";

const config: NetworkConfig = {
  meta: { name: "connections", version: 2 },
  settings: { mode: "steady", tolerance: 1e-6, maxIterations: 20 },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    { id: "f1", type: "boundary", x: 0, y: 0, pressure: 2e5, temperature: 300 },
    {
      id: "f2",
      type: "boundary",
      x: 100,
      y: 0,
      pressure: 1e5,
      temperature: 300,
    },
  ],
  solidNodes: [
    { id: "s1", type: "solid", x: 0, y: 100, temperature: 300 },
    { id: "a1", type: "ambient", x: 100, y: 100, temperature: 290 },
  ],
  branches: [],
};

describe("UI endpoint connection rules", () => {
  it("allows fluid branches only between distinct fluid nodes", () => {
    expect(fluidBranchEndpointError(config, "f1", "f2")).toBeNull();
    expect(fluidBranchEndpointError(config, "f1", "s1")).toMatch(
      /only fluid nodes/,
    );
    expect(fluidBranchEndpointError(config, "s1", "a1")).toMatch(
      /only fluid nodes/,
    );
    expect(fluidBranchEndpointError(config, "f1", "f1")).toMatch(/different/);
    expect(canStartFluidBranch(config, "f1")).toBe(true);
    expect(canStartFluidBranch(config, "s1")).toBe(false);
  });

  it("allows conduction/radiation only between thermal nodes", () => {
    expect(conductorEndpointError(config, "conduction", "s1", "a1")).toBeNull();
    expect(conductorEndpointError(config, "radiation", "s1", "a1")).toBeNull();
    expect(conductorEndpointError(config, "conduction", "s1", "f1")).toMatch(
      /two solid or ambient/,
    );
    expect(canStartConductor(config, "conduction", "s1")).toBe(true);
    expect(canStartConductor(config, "conduction", "f1")).toBe(false);
  });

  it("allows convection only between one fluid and one thermal node", () => {
    expect(conductorEndpointError(config, "convection", "f1", "s1")).toBeNull();
    expect(conductorEndpointError(config, "convection", "a1", "f2")).toBeNull();
    expect(conductorEndpointError(config, "convection", "f1", "f2")).toMatch(
      /exactly one fluid/,
    );
    expect(conductorEndpointError(config, "convection", "s1", "a1")).toMatch(
      /exactly one fluid/,
    );
  });

  it("filters retarget and kind choices to compatible values", () => {
    expect(
      [...compatibleConductorNodeIds(config, "convection", "f1")].sort(),
    ).toEqual(["a1", "s1"]);
    expect([...compatibleConductorNodeIds(config, "conduction", "s1")]).toEqual(
      ["a1"],
    );
    expect([...compatibleConductorKinds(config, "f1", "s1")]).toEqual([
      "convection",
    ]);
    expect([...compatibleConductorKinds(config, "s1", "a1")]).toEqual([
      "conduction",
      "radiation",
    ]);
  });

  it("is a pure re-export of the core topology rules (single source of truth)", () => {
    // The UI adapter must agree with core/topology for the full matrix of
    // endpoint pairs (including unknown ids) and conductor kinds.
    const model = createTopologyModel(["f1", "f2"], ["s1", "a1"]);
    const ids = ["f1", "f2", "s1", "a1", "ghost"];
    for (const from of ids) {
      for (const to of ids) {
        expect(fluidBranchEndpointError(config, from, to)).toBe(
          coreFluidBranchEndpointError(model, from, to),
        );
        for (const kind of CONDUCTOR_KINDS) {
          expect(conductorEndpointError(config, kind, from, to)).toBe(
            coreConductorEndpointError(model, kind, from, to),
          );
        }
      }
    }
  });
});
