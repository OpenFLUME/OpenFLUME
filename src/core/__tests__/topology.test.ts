import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../schema";
import { validateNetwork } from "../validate";
import {
  CONDUCTOR_KINDS,
  createTopologyModel,
  classifyEndpoint,
  isFluidNode,
  isThermalNode,
  fluidBranchEndpointError,
  conductorEndpointError,
  compatibleConductorNodeIds,
  compatibleConductorKinds,
  canStartFluidBranch,
  canStartConductor,
} from "../topology";
import type { ConductorKind } from "../topology";

const model = createTopologyModel(["f1", "f2"], ["s1", "a1"]);

describe("core topology endpoint classification", () => {
  it("classifies fluid, thermal, and missing endpoints", () => {
    expect(classifyEndpoint(model, "f1")).toBe("fluid");
    expect(classifyEndpoint(model, "s1")).toBe("thermal");
    expect(classifyEndpoint(model, "a1")).toBe("thermal");
    expect(classifyEndpoint(model, "ghost")).toBe("missing");
    expect(isFluidNode(model, "f2")).toBe(true);
    expect(isFluidNode(model, "s1")).toBe(false);
    expect(isThermalNode(model, "a1")).toBe(true);
    expect(isThermalNode(model, "f1")).toBe(false);
  });

  it("accepts arrays, Sets, or generators as id sources", () => {
    function* ids() {
      yield "g1";
    }
    const m = createTopologyModel(ids(), new Set(["t1"]));
    expect(isFluidNode(m, "g1")).toBe(true);
    expect(isThermalNode(m, "t1")).toBe(true);
  });
});

describe("core topology connection rules", () => {
  it("allows fluid branches only between two different fluid nodes", () => {
    expect(fluidBranchEndpointError(model, "f1", "f2")).toBeNull();
    expect(fluidBranchEndpointError(model, "f1", "f1")).toMatch(
      /different fluid nodes/,
    );
    expect(fluidBranchEndpointError(model, "f1", "s1")).toMatch(
      /only fluid nodes/,
    );
    expect(fluidBranchEndpointError(model, "ghost", "f1")).toMatch(
      /only fluid nodes/,
    );
    expect(canStartFluidBranch(model, "f1")).toBe(true);
    expect(canStartFluidBranch(model, "s1")).toBe(false);
  });

  it("applies the conductor endpoint matrix (conduction/convection/radiation)", () => {
    // conduction/radiation: thermal ↔ thermal
    for (const kind of ["conduction", "radiation"] as const) {
      expect(conductorEndpointError(model, kind, "s1", "a1")).toBeNull();
      expect(conductorEndpointError(model, kind, "s1", "f1")).toMatch(
        /two solid or ambient/,
      );
      expect(conductorEndpointError(model, kind, "f1", "f2")).toMatch(
        /two solid or ambient/,
      );
      expect(conductorEndpointError(model, kind, "s1", "s1")).toMatch(
        /two different nodes/,
      );
      expect(canStartConductor(model, kind, "s1")).toBe(true);
      expect(canStartConductor(model, kind, "f1")).toBe(false);
    }
    // convection: exactly one fluid + one thermal
    expect(conductorEndpointError(model, "convection", "f1", "s1")).toBeNull();
    expect(conductorEndpointError(model, "convection", "a1", "f2")).toBeNull();
    expect(conductorEndpointError(model, "convection", "f1", "f2")).toMatch(
      /exactly one fluid/,
    );
    expect(conductorEndpointError(model, "convection", "s1", "a1")).toMatch(
      /exactly one fluid/,
    );
    expect(canStartConductor(model, "convection", "f1")).toBe(true);
    expect(canStartConductor(model, "convection", "s1")).toBe(true);
  });

  it("lists compatible node ids (fluid ids first) and kinds", () => {
    expect([...compatibleConductorNodeIds(model, "convection", "f1")]).toEqual([
      "s1",
      "a1",
    ]);
    expect([...compatibleConductorNodeIds(model, "conduction", "s1")]).toEqual([
      "a1",
    ]);
    expect([...compatibleConductorKinds(model, "f1", "s1")]).toEqual([
      "convection",
    ]);
    expect([...compatibleConductorKinds(model, "s1", "a1")]).toEqual([
      "conduction",
      "radiation",
    ]);
    expect([...compatibleConductorKinds(model, "f1", "f2")]).toEqual([]);
    expect(CONDUCTOR_KINDS).toEqual(["conduction", "convection", "radiation"]);
  });
});

/**
 * Topology ↔ validate consistency: for every endpoint combination and
 * conductor kind, the pure topology rule allows the connection iff core
 * validation reports no structural endpoint error for it.
 */
describe("topology consistency with validateNetwork", () => {
  const base: NetworkConfig = {
    meta: { name: "topo", version: 2 },
    settings: { mode: "steady", tolerance: 1e-6, maxIterations: 20 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "f1",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 2e5,
        temperature: 300,
      },
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

  function conductorType(
    kind: ConductorKind,
  ): NonNullable<NetworkConfig["conductors"]>[number]["type"] {
    switch (kind) {
      case "conduction":
        return { kind, k: 10, area: 0.01, length: 0.1 };
      case "convection":
        return { kind, h: 100, area: 0.01 };
      case "radiation":
        return { kind, emissivity: 0.8, area: 0.01, viewFactor: 0.5 };
    }
  }

  const endpointIds = ["f1", "f2", "s1", "a1", "ghost"];
  const structuralConductorError =
    /Conductor c1 (references missing node|must connect two different nodes)|conduction endpoints must be|convection must have exactly one fluid endpoint|radiation endpoints must be/;

  it("conductor endpoint matrix matches validateNetwork structural errors", () => {
    for (const from of endpointIds) {
      for (const to of endpointIds) {
        for (const kind of CONDUCTOR_KINDS) {
          const topoError = conductorEndpointError(model, kind, from, to);
          const errors = validateNetwork({
            ...base,
            conductors: [{ id: "c1", from, to, type: conductorType(kind) }],
          });
          const structural = errors.filter((e) =>
            structuralConductorError.test(e),
          );
          if (topoError === null) {
            expect(
              structural,
              `${kind} ${from}→${to} should be allowed`,
            ).toEqual([]);
          } else {
            expect(
              structural.length,
              `${kind} ${from}→${to} should be rejected`,
            ).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  const structuralBranchError =
    /Branch b1 (references missing node|must connect two different fluid nodes)/;

  it("fluid-branch endpoint rule matches validateNetwork structural errors", () => {
    for (const from of endpointIds) {
      for (const to of endpointIds) {
        const topoError = fluidBranchEndpointError(model, from, to);
        const errors = validateNetwork({
          ...base,
          branches: [
            {
              id: "b1",
              from,
              to,
              component: { type: "orifice", area: 1e-3, cd: 0.6 },
            },
          ],
        });
        const structural = errors.filter((e) => structuralBranchError.test(e));
        if (topoError === null) {
          expect(structural, `branch ${from}→${to} should be allowed`).toEqual(
            [],
          );
        } else {
          expect(
            structural.length,
            `branch ${from}→${to} should be rejected`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });
});
