/**
 * DofMap: column layout of the Newton unknown vector.
 *
 * The layout-compatibility tests matter most — the map replaced hand-written
 * block arithmetic throughout the kernel and step driver, so for the uniform
 * modes it must reproduce the historical `nInt + nBranch + i` indexing exactly
 * or every solve changes silently.
 */
import { describe, it, expect } from "vitest";
import { createDofMap, createUniformDofMap } from "../solver/dofMap";
import type { EnergyKind } from "../solver/dofMap";
import type { SolverContext } from "../solver/types";

/** Minimal stand-in: DofMap reads only the node/branch counts and ordering. */
function ctxOf(internalIds: string[], nBranch: number): SolverContext {
  const internalIndex = new Map<string, number>();
  internalIds.forEach((id, i) => internalIndex.set(id, i));
  return {
    internalIds,
    internalIndex,
    nInt: internalIds.length,
    nBranch,
  } as unknown as SolverContext;
}

const NODES = ["a", "b", "c"];

describe("DofMap — uniform modes reproduce the historical block layout", () => {
  it("lays out [P, mdot] with no energy block when neither mode is active", () => {
    const ctx = ctxOf(NODES, 4);
    const dof = createUniformDofMap(ctx, {
      useExtendedSystem: false,
      useCoupledH: false,
    });
    expect(dof.nVar).toBe(3 + 4);
    expect(dof.hasEnergyBlock).toBe(false);
    NODES.forEach((id, i) => expect(dof.pressureCol(id)).toBe(i));
    for (let j = 0; j < 4; j++) expect(dof.mdotCol(j)).toBe(3 + j);
    for (const id of NODES) {
      expect(dof.energyCol(id)).toBeUndefined();
      expect(dof.energyKind(id)).toBe("none");
      expect(dof.colsForNode(id, true)).toEqual([dof.pressureCol(id)]);
    }
  });

  it.each([
    ["useExtendedSystem", { useExtendedSystem: true }, "h"],
    ["useCoupledH", { useExtendedSystem: false, useCoupledH: true }, "h"],
  ])(
    "packs the energy block at nInt+nBranch+i for %s",
    (_label, opts, kind) => {
      const ctx = ctxOf(NODES, 4);
      const dof = createUniformDofMap(ctx, opts as never);
      expect(dof.nVar).toBe(3 + 4 + 3);
      NODES.forEach((id, i) => {
        expect(dof.energyCol(id)).toBe(3 + 4 + i);
        expect(dof.energyKind(id)).toBe(kind);
        expect(dof.kindOf(dof.energyCol(id)!)).toBe(kind);
        expect(dof.colsForNode(id, true)).toEqual([i, 3 + 4 + i]);
        expect(dof.colsForNode(id, false)).toEqual([i]);
      });
    },
  );

  it("tags every column with the quantity it holds", () => {
    const dof = createUniformDofMap(ctxOf(NODES, 2), {
      useExtendedSystem: true,
    });
    const kinds = Array.from({ length: dof.nVar }, (_, k) => dof.kindOf(k));
    expect(kinds).toEqual(["P", "P", "P", "mdot", "mdot", "h", "h", "h"]);
  });

  it("returns no columns for a boundary node", () => {
    const dof = createUniformDofMap(ctxOf(NODES, 1), {
      useExtendedSystem: true,
    });
    expect(dof.pressureCol("boundary")).toBeUndefined();
    expect(dof.energyCol("boundary")).toBeUndefined();
    expect(dof.colsForNode("boundary", true)).toEqual([]);
  });
});

describe("DofMap — heterogeneous energy block", () => {
  // The mixed-EOS case: an ideal-gas continuum carrying coupled T unknowns
  // beside a real-fluid continuum whose enthalpy is advanced segregatedly.
  const mixed: Record<string, EnergyKind> = { a: "T", b: "none", c: "T" };

  it("packs only participating nodes, skipping the segregated ones", () => {
    const dof = createDofMap(ctxOf(NODES, 2), (id) => mixed[id]);
    expect(dof.nVar).toBe(3 + 2 + 2);
    expect(dof.energyNodes).toEqual(["a", "c"]);
    expect(dof.energyCol("a")).toBe(5);
    expect(dof.energyCol("b")).toBeUndefined();
    expect(dof.energyCol("c")).toBe(6);
    // The skipped node keeps its pressure column and contributes no gap.
    expect(dof.pressureCol("b")).toBe(1);
    expect(dof.colsForNode("b", true)).toEqual([1]);
  });

  it("keeps kindOf and energyNodeOf consistent across a packed block", () => {
    const dof = createDofMap(ctxOf(NODES, 2), (id) => mixed[id]);
    expect(dof.kindOf(5)).toBe("T");
    expect(dof.kindOf(6)).toBe("T");
    expect(dof.energyNodeOf(5)).toBe("a");
    expect(dof.energyNodeOf(6)).toBe("c");
    for (const id of dof.energyNodes) {
      expect(dof.energyNodeOf(dof.energyCol(id)!)).toBe(id);
    }
    expect(dof.energyNodeOf(0)).toBeUndefined();
  });

  it("supports T and h unknowns coexisting in one vector", () => {
    const dof = createDofMap(ctxOf(NODES, 1), (id) =>
      id === "a" ? "T" : id === "b" ? "none" : "h",
    );
    expect(dof.nVar).toBe(3 + 1 + 2);
    expect(dof.kindOf(dof.energyCol("a")!)).toBe("T");
    expect(dof.kindOf(dof.energyCol("c")!)).toBe("h");
  });
});
