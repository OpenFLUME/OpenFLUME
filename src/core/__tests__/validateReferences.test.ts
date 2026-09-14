/**
 * validateReferences — the editor's own invariants, separable from solver
 * validation so a document boundary can accept unfinished models while
 * rejecting malformed ones.
 */
import { describe, it, expect } from "vitest";
import { validateReferences } from "../validate/references";
import type { NetworkConfig } from "../schema";

function wip(): NetworkConfig {
  return {
    meta: { name: "wip", version: 2 },
    settings: { mode: "transient", tolerance: 1e-6, maxIterations: 100 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      // Internal-only and no volume: the solver rejects this, the editor
      // must not.
      {
        id: "a",
        type: "internal",
        x: 0,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
      {
        id: "b",
        type: "internal",
        x: 1,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "p",
        from: "a",
        to: "b",
        component: { type: "pipe", length: 1, diameter: 0.05, roughness: 1e-5 },
      },
    ],
    solidNodes: [
      {
        id: "w",
        type: "solid",
        x: 0,
        y: 1,
        temperature: 300,
        mass: 1,
        cp: 500,
      },
    ],
    conductors: [
      {
        id: "c",
        from: "w",
        to: "a",
        type: { kind: "convection", h: 10, area: 1 },
      },
    ],
    groups: [{ id: "g", label: "G", x: 0, y: 0 }],
    notes: [{ id: "n", text: "x", x: 0, y: 0, group: "g" }],
  };
}

describe("validateReferences", () => {
  it("accepts an unfinished but well-formed model", () => {
    expect(validateReferences(wip())).toEqual([]);
  });

  it("reports dangling endpoints, groups and duplicate ids", () => {
    const c = wip();
    c.branches[0].to = "ghost";
    c.conductors![0].from = "nowhere";
    c.notes![0].group = "lost";
    c.nodes.push({ ...c.nodes[0] });
    const errors = validateReferences(c);
    expect(errors).toEqual(
      expect.arrayContaining([
        "Branch p references missing node: ghost",
        "Conductor c references missing node: nowhere",
        "Note n references missing group: lost",
        "Duplicate node id: a",
      ]),
    );
  });

  it("does not let a branch end on a solid node", () => {
    const c = wip();
    c.branches[0].to = "w";
    expect(validateReferences(c)).toEqual([
      "Branch p references missing node: w",
    ]);
  });
});
