/**
 * Exact limit-cycle short-circuit of the transient outer loop
 * (solver/outerCycle.ts, wired in solver/step.ts).
 *
 * A custom h correlation that switches branch discontinuously (here on the
 * node density, like a fitted film-boiling / liquid-convection map) drives
 * the coupled outer iteration of a quenching wall into a periodic orbit:
 * every inner Newton certifies, the state never settles, and before the
 * short-circuit every such step ground through maxOuter = 1000 outers.
 *
 * Pinned here WITHOUT timing (counts only, so not load-flaky):
 *   • the short-circuit fires on this network, skipping replayed outers;
 *   • the full TransientResult — every history, the per-step residual and
 *     Newton-iteration series and the converged flag — is bit-identical to
 *     the run with the short-circuit switched off.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { initRealFluids } from "../fluids/coolprop";
import { solveTransient } from "../transient";
import { getPerfSnapshot, setPerfEnabled } from "../perf";
import {
  OuterCycleDetector,
  OuterSnapshotBuilder,
  setOuterCycleShortCircuitEnabled,
  snapshotsEqual,
} from "../solver/outerCycle";
import type { NetworkConfig } from "../schema";

/** Horizontal LN₂ transfer line, N segments, cold walls, discontinuous
 *  custom h (vapour Nusselt below ρ = 100 kg/m³, a two-level boiling map
 *  above it). Shaped like the 7 m chilldown line that exposed the grind. */
function cyclingLine(N: number): NetworkConfig {
  const L = 7;
  const D = 0.0102;
  const segL = L / N;
  const flowArea = (Math.PI / 4) * D * D;
  const nodes: NetworkConfig["nodes"] = [
    {
      id: "f0",
      type: "boundary",
      x: 0,
      y: 0,
      pressure: 373000,
      temperature: 88.4,
    },
  ];
  for (let i = 1; i <= N + 1; i++) {
    const end = i === 1 || i === N + 1;
    nodes.push({
      id: `f${i}`,
      type: "internal",
      x: 100 * i,
      y: 0,
      position: { x: (i - 1) * segL, y: 0, z: 0 },
      pressure: 373000 - (i - 1) * 900,
      temperature: 285,
      volume: flowArea * segL * (end ? 0.5 : 1),
    });
  }
  nodes.push({
    id: `f${N + 2}`,
    type: "boundary",
    x: 100 * (N + 2),
    y: 0,
    pressure: 373000 - N * 900,
    temperature: 300,
  });
  const branches: NetworkConfig["branches"] = [
    {
      id: "in",
      from: "f0",
      to: "f1",
      component: { type: "flowSource", massFlow: 0.0045 },
    },
  ];
  for (let i = 1; i <= N; i++) {
    branches.push({
      id: `pipe${i}`,
      from: `f${i}`,
      to: `f${i + 1}`,
      component: { type: "pipe", length: segL, diameter: D, roughness: 1.5e-6 },
    });
  }
  branches.push({
    id: "out",
    from: `f${N + 1}`,
    to: `f${N + 2}`,
    component: { type: "pipe", length: 0.05, diameter: D, roughness: 1.5e-6 },
  });
  const solidNodes: NonNullable<NetworkConfig["solidNodes"]> = [];
  const conductors: NonNullable<NetworkConfig["conductors"]> = [];
  for (let i = 0; i <= N; i++) {
    const end = i === 0 || i === N;
    const area = Math.PI * D * segL * (end ? 0.5 : 1);
    solidNodes.push({
      id: `s${i}`,
      type: "solid",
      x: 100 * (i + 1),
      y: 80,
      temperature: 100,
      mass: 0.25 * (end ? 0.5 : 1),
      cp: { material: "stainless-steel-304" },
    });
    conductors.push({
      id: `conv${i}`,
      from: `f${i + 1}`,
      to: `s${i}`,
      type: {
        kind: "convection",
        area,
        correlation: {
          model: "custom",
          expression: "rho < 100 ? 3.66*k/D : (Tw - Tf > 30 ? 200 : 4000)",
          diameter: D,
          flowArea,
        },
      },
    });
  }
  return {
    meta: { name: "outer-cycle line", version: 2 },
    settings: {
      mode: "transient",
      tolerance: 1e-5,
      maxIterations: 200,
      relaxation: 0.7,
      endTime: 2,
      dt: 0.25,
      timeStepping: "fixed",
      momentumFlux: true,
      kineticEnergy: true,
    },
    fluid: { model: "realFluid", params: { fluidName: "Nitrogen" } },
    nodes,
    branches,
    solidNodes,
    conductors,
  } as NetworkConfig;
}

beforeAll(async () => {
  await initRealFluids();
});

afterEach(() => {
  setOuterCycleShortCircuitEnabled(true);
  setPerfEnabled(false);
});

describe("outer-loop exact limit-cycle short-circuit", () => {
  it("snapshots compare bit-exactly (sign of zero, key order, shape)", () => {
    const snap = (vals: number[], keys: string[]) => {
      const b = new OuterSnapshotBuilder().array(vals);
      b.map("m", new Map(keys.map((k, i) => [k, i])));
      return b.build();
    };
    expect(snapshotsEqual(snap([1, 2], ["a"]), snap([1, 2], ["a"]))).toBe(true);
    expect(snapshotsEqual(snap([0], ["a"]), snap([-0], ["a"]))).toBe(false);
    expect(
      snapshotsEqual(snap([1, 2], ["a", "b"]), snap([1, 2], ["b", "a"])),
    ).toBe(false);
    expect(snapshotsEqual(snap([1, 2], []), snap([1, 2, 3], []))).toBe(false);
    expect(snapshotsEqual(snap([NaN], []), snap([NaN], []))).toBe(true);

    const det = new OuterCycleDetector();
    expect(det.record(0, snap([1], []))).toBeUndefined();
    expect(det.record(1, snap([2], []))).toBeUndefined();
    expect(det.record(2, snap([1 + Number.EPSILON], []))).toBeUndefined();
    expect(det.record(3, snap([2], []))).toBe(1);
  });

  it("fires on a periodic outer orbit and leaves the result bit-identical", () => {
    const cfg = cyclingLine(3);

    setOuterCycleShortCircuitEnabled(false);
    setPerfEnabled(true, { trackUniqueKeys: false });
    const full = solveTransient(structuredClone(cfg));
    const fullResiduals = getPerfSnapshot().residualCalls;

    setOuterCycleShortCircuitEnabled(true);
    setPerfEnabled(true, { trackUniqueKeys: false });
    const fast = solveTransient(structuredClone(cfg));
    const perf = getPerfSnapshot();

    // The orbit is hit and replayed outers are skipped …
    expect(perf.outerCycleShortCircuits).toBeGreaterThan(0);
    expect(perf.outerItersSkipped).toBeGreaterThan(0);
    expect(perf.residualCalls).toBeLessThan(fullResiduals);
    // … with nothing in the result changed, down to the last bit (the
    // per-step Newton-iteration counts include the replayed outers).
    expect(fast).toEqual(full);
    expect(fast.stepNewtonIterations).toEqual(full.stepNewtonIterations);
  }, 120_000);
});
