/**
 * entitySummary — the facts the outline's hover card shows.
 *
 * These pin WHAT identifies each element kind (type, endpoints, defining
 * parameters) rather than exact formatting, plus the two behaviors that are
 * easy to regress: formula-bound fields showing their expression instead of
 * a blank, and solved values appearing only when a result is supplied.
 */
import { describe, it, expect } from "vitest";
import { summarizeEntity } from "../entitySummary";
import type { NetworkConfig, SteadyResult } from "../types";

function config(): NetworkConfig {
  return {
    meta: { name: "summary", version: 2 },
    settings: {
      mode: "steady",
      tolerance: 1e-6,
      maxIterations: 200,
    },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "in",
        type: "boundary",
        x: 0,
        y: 0,
        label: "Inlet",
        pressure: 2e5,
        temperature: 300,
      },
      {
        id: "mid",
        type: "internal",
        x: 50,
        y: 0,
        pressure: 1.5e5,
        temperature: 300,
        volume: 0.01,
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
          diameter: 0.03,
          roughness: 1e-5,
        },
      },
    ],
    solidNodes: [
      {
        id: "w1",
        type: "solid",
        x: 0,
        y: 60,
        temperature: 350,
        mass: 1,
        cp: 500,
      },
    ],
    conductors: [
      {
        id: "c1",
        from: "w1",
        to: "mid",
        type: { kind: "convection", h: 1000, area: 0.1 },
      },
    ],
  };
}

const rowValue = (
  rows: { label: string; value: string }[],
  label: string,
): string | undefined => rows.find((r) => r.label === label)?.value;

describe("summarizeEntity", () => {
  it("identifies a boundary node with its state", () => {
    const s = summarizeEntity({ config: config(), kind: "node", id: "in" })!;
    expect(s.title).toBe("in");
    expect(s.subtitle).toBe("Boundary node");
    expect(s.glyph).toEqual({ entity: "node", type: "boundary" });
    expect(rowValue(s.rows, "Label")).toBe("Inlet");
    expect(rowValue(s.rows, "Pressure")).toContain("200");
    expect(s.results).toEqual([]);
  });

  it("identifies a branch by component, endpoints, and defining parameters", () => {
    const s = summarizeEntity({ config: config(), kind: "branch", id: "p1" })!;
    expect(s.subtitle).toBe("Pipe");
    expect(rowValue(s.rows, "From → to")).toBe("in → mid");
    expect(rowValue(s.rows, "Length")).toBeDefined();
    expect(rowValue(s.rows, "Diameter")).toBeDefined();
    expect(rowValue(s.rows, "Roughness")).toBeDefined();
  });

  it("shows a formula binding as its expression", () => {
    const cfg = config();
    cfg.branches[0].component = {
      type: "pipe",
      length: { expr: "pipe('p1').diameter * 10" },
      diameter: 0.03,
      roughness: 1e-5,
    };
    const s = summarizeEntity({ config: cfg, kind: "branch", id: "p1" })!;
    expect(rowValue(s.rows, "Length")).toBe("= pipe('p1').diameter * 10");
  });

  it("identifies solid nodes and conductors", () => {
    const solid = summarizeEntity({
      config: config(),
      kind: "solidNode",
      id: "w1",
    })!;
    expect(solid.subtitle).toBe("Solid node");
    expect(rowValue(solid.rows, "Mass")).toBe("1 kg");

    const cond = summarizeEntity({
      config: config(),
      kind: "conductor",
      id: "c1",
    })!;
    expect(cond.subtitle).toBe("Convection tie");
    expect(rowValue(cond.rows, "Between")).toBe("w1 ↔ mid");
    // formatSig groups thousands.
    expect(rowValue(cond.rows, "h")).toBe("1,000");
  });

  it("appends solved values when a result is supplied", () => {
    const result: SteadyResult = {
      converged: true,
      iterations: 4,
      residual: 1e-9,
      nodes: {
        in: { pressure: 2e5, temperature: 300, density: 998 },
        mid: { pressure: 1.5e5, temperature: 300, density: 998 },
      },
      branches: { p1: { massFlow: 1.25, velocity: 1.7, pressureDrop: 5e4 } },
    } as unknown as SteadyResult;

    const withResult = summarizeEntity({
      config: config(),
      result,
      kind: "branch",
      id: "p1",
    })!;
    expect(withResult.results.length).toBeGreaterThan(0);

    const withoutResult = summarizeEntity({
      config: config(),
      kind: "branch",
      id: "p1",
    })!;
    expect(withoutResult.results).toEqual([]);
  });

  it("returns null for an unknown id", () => {
    expect(
      summarizeEntity({ config: config(), kind: "node", id: "nope" }),
    ).toBeNull();
  });
});
