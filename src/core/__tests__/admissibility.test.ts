/**
 * Unit coverage for the transonic second-law admissibility audit
 * (src/core/solver/admissibility.ts) — previously exercised only indirectly
 * through central-scheme duct solves.  The audit is pure root INSPECTION
 * (state in, violations out), so it is tested directly on hand-crafted
 * converged states:
 *   - a friction-consistent state (entropy rises downstream) passes;
 *   - an expansion-shock-like state (entropy destroyed across a branch,
 *     Δs ≪ −tolerance) is flagged, with the correct donor/downwind pair;
 *   - boundary downwind nodes are never flagged (cannot be re-seeded);
 *   - reseedInadmissible pulls the violating downwind node onto its donor
 *     and leaves everything else untouched;
 *   - violationScore is 0 for an admissible set and positive otherwise.
 */

import { describe, it, expect } from "vitest";
import type { NetworkConfig } from "../schema";
import type { StepState } from "../solver/types";
import { buildSolverContext } from "../solver/context";
import {
  auditSecondLaw,
  reseedInadmissible,
  violationScore,
} from "../solver/admissibility";

const R_AIR = 287;
const GAMMA = 1.4;
const CP = (GAMMA * R_AIR) / (GAMMA - 1);

// A → M → B chain of areal resistances; M is the only internal (re-seedable)
// node, so only branch b1 (downwind M) is auditable.
const config: NetworkConfig = {
  meta: { name: "admissibility audit unit network", version: 2 },
  settings: {
    mode: "steady",
    tolerance: 1e-8,
    maxIterations: 100,
    momentumFlux: true,
    momentumFluxScheme: "central",
  },
  fluid: { model: "idealGas" },
  nodes: [
    {
      id: "A",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: 2e5,
      temperature: 300,
    },
    { id: "M", type: "internal", x: 50, y: 0 },
    {
      id: "B",
      type: "boundary",
      x: 100,
      y: 0,
      pressure: 1e5,
      temperature: 300,
    },
  ],
  branches: [
    {
      id: "b1",
      from: "A",
      to: "M",
      component: { type: "customResistance", k: 5, area: 1e-3 },
    },
    {
      id: "b2",
      from: "M",
      to: "B",
      component: { type: "customResistance", k: 5, area: 1e-3 },
    },
  ],
};

function makeState(pM: number, tM: number): StepState {
  const nodeP = new Map([
    ["A", 2e5],
    ["M", pM],
    ["B", 1e5],
  ]);
  const nodeT = new Map([
    ["A", 300],
    ["M", tM],
    ["B", 300],
  ]);
  const rho = (id: string) => nodeP.get(id)! / (R_AIR * nodeT.get(id)!);
  return {
    nodeP,
    nodeT,
    nodeRho: new Map(["A", "M", "B"].map((id) => [id, rho(id)])),
    nodeMu: new Map(["A", "M", "B"].map((id) => [id, 1.8e-5])),
    mdots: [0.1, 0.1],
    solidT: new Map(),
  };
}

describe("auditSecondLaw", () => {
  const ctx = buildSolverContext(config);

  it("passes a friction-consistent state (entropy rises downstream)", () => {
    // Constant T, pressure dropping with the flow: Δs = −R·ln(p_dwn/p_don) > 0.
    const state = makeState(1.5e5, 300);
    expect(auditSecondLaw(ctx, state)).toEqual([]);
    expect(violationScore([])).toBe(0);
  });

  it("flags an entropy-destroying jump onto the internal node", () => {
    // Same pressure, large temperature DROP across b1: Δs = cp·ln(240/300)
    // ≈ −224 J/(kg·K) — far beyond any tolerance band.
    const state = makeState(2e5, 240);
    const violations = auditSecondLaw(ctx, state);
    expect(violations).toHaveLength(1);
    const v = violations[0];
    expect(v.branchId).toBe("b1");
    expect(v.donor).toBe("A");
    expect(v.downwind).toBe("M");
    expect(v.deltaS).toBeCloseTo(CP * Math.log(240 / 300), 6);
    expect(v.allowance).toBe(0);
    expect(v.tolerance).toBeGreaterThan(0);
    expect(violationScore(violations)).toBeGreaterThan(0);
  });

  it("never flags a branch whose downwind node is a boundary", () => {
    // Entropy-destroying jump across b2 (M → B): B is a boundary, so the
    // audit must skip it (a prescribed state cannot be re-seeded).
    const state = makeState(1e5, 380); // b2: T 380 → 300 at equal P
    expect(
      auditSecondLaw(ctx, state).filter((v) => v.branchId === "b2"),
    ).toEqual([]);
  });

  it("reverses flow: donor/downwind follow the mdot sign", () => {
    const state = makeState(2e5, 240);
    state.mdots = [-0.1, -0.1]; // flow B → M → A
    // Reversed b1 has downwind A (boundary) → skipped.  Reversed b2 flows
    // B (300 K) → M (240 K) at equal-ish P: entropy destroyed onto the
    // internal node, so it must be flagged with the reversed roles.
    const violations = auditSecondLaw(ctx, state);
    expect(violations).toHaveLength(1);
    expect(violations[0].branchId).toBe("b2");
    expect(violations[0].donor).toBe("B");
    expect(violations[0].downwind).toBe("M");
  });

  it("reseedInadmissible pulls the downwind node onto its donor", () => {
    const state = makeState(2e5, 240);
    const violations = auditSecondLaw(ctx, state);
    const seeded = reseedInadmissible(ctx, state, violations);
    expect(seeded.nodeP.get("M")).toBe(state.nodeP.get("A"));
    expect(seeded.nodeT.get("M")).toBe(state.nodeT.get("A"));
    expect(seeded.nodeRho.get("M")).toBe(state.nodeRho.get("A"));
    // Untouched: boundary states, flows, and the original state object.
    expect(seeded.nodeP.get("B")).toBe(1e5);
    expect(seeded.mdots).toEqual(state.mdots);
    expect(state.nodeT.get("M")).toBe(240);
  });
});
