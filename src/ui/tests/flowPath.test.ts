/**
 * flowPath.ts — flow-oriented path enumeration and profile sampling.
 *
 * Direction is a result, not a declaration, so these tests drive the module
 * with solved flows: forward, reversed, split at a tee, a closed circulation
 * loop, and two chains that share no fluid link. The shipped examples are
 * solved for real at the end so the module is pinned against actual model
 * shapes rather than only hand-built fixtures.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  listFlowPaths,
  defaultFlowPath,
  resolveFlowPath,
  samplePathField,
  pathBreakdown,
} from "../flowPath";
import { examples } from "../examples";
import { initRealFluids, solveSteady, validateNetwork } from "../../core";
import type { NetworkConfig, SteadyResult } from "../types";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const node = (
  id: string,
  type: "boundary" | "internal",
  extra: Record<string, unknown> = {},
) => ({
  id,
  type,
  x: 0,
  y: 0,
  pressure: 2e5,
  temperature: 300,
  ...extra,
});

const pipe = (id: string, from: string, to: string, length = 1) => ({
  id,
  from,
  to,
  component: { type: "pipe" as const, length, diameter: 0.02, roughness: 1e-5 },
});

const orifice = (id: string, from: string, to: string) => ({
  id,
  from,
  to,
  component: { type: "orifice" as const, area: 1e-4, cd: 0.6 },
});

function cfg(
  nodes: ReturnType<typeof node>[],
  branches: Array<ReturnType<typeof pipe> | ReturnType<typeof orifice>>,
): NetworkConfig {
  return {
    meta: { name: "fixture", version: 2 },
    settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
    fluid: { model: "incompressible", preset: "water" },
    nodes,
    branches,
  } as unknown as NetworkConfig;
}

/** Minimal steady result carrying only the flows and pressures a test needs. */
function steady(
  branchMdot: Record<string, number>,
  nodePressure: Record<string, number> = {},
  extraBranch: Record<string, Record<string, number>> = {},
): SteadyResult {
  return {
    converged: true,
    iterations: 3,
    residual: 1e-10,
    nodes: Object.fromEntries(
      Object.entries(nodePressure).map(([id, pressure]) => [
        id,
        { pressure, temperature: 300, density: 1000 },
      ]),
    ),
    branches: Object.fromEntries(
      Object.entries(branchMdot).map(([id, mdot]) => [
        id,
        {
          mdot,
          velocity: 1,
          dP: 1000,
          reynolds: 9000,
          ...(extraBranch[id] ?? {}),
        },
      ]),
    ),
  } as unknown as SteadyResult;
}

/* ------------------------------------------------------------------ */

describe("listFlowPaths: direction comes from the result", () => {
  const chain = cfg(
    [node("in", "boundary"), node("m", "internal"), node("out", "boundary")],
    [pipe("b1", "in", "m", 2), pipe("b2", "m", "out", 3)],
  );

  it("walks a chain inlet to outlet on positive flow", () => {
    const paths = listFlowPaths(chain, steady({ b1: 0.5, b2: 0.5 }));
    expect(paths).toHaveLength(1);
    expect(paths[0].kind).toBe("through");
    expect(paths[0].stations.map((s) => s.nodeId)).toEqual(["in", "m", "out"]);
    expect(paths[0].label).toBe("in → out");
  });

  it("walks the SAME chain the other way when the flow is negative", () => {
    // Both branches reversed: "out" is now the supply.
    const paths = listFlowPaths(chain, steady({ b1: -0.5, b2: -0.5 }));
    expect(paths).toHaveLength(1);
    expect(paths[0].stations.map((s) => s.nodeId)).toEqual(["out", "m", "in"]);
    expect(paths[0].segments.every((s) => s.reversed)).toBe(true);
  });

  it("reports mass flow as a magnitude in the flow direction", () => {
    const paths = listFlowPaths(chain, steady({ b1: -0.5, b2: -0.5 }));
    expect(paths[0].segments.map((s) => s.mdot)).toEqual([0.5, 0.5]);
  });

  it("is empty when there is no flow to orient by", () => {
    expect(listFlowPaths(chain, steady({ b1: 0, b2: 0 }))).toEqual([]);
    expect(listFlowPaths(chain, null)).toEqual([]);
  });

  it("never throws on garbage input", () => {
    expect(listFlowPaths(null, null)).toEqual([]);
    expect(listFlowPaths({} as unknown as NetworkConfig, steady({}))).toEqual(
      [],
    );
  });
});

describe("listFlowPaths: stations", () => {
  it("accumulates pipe length into metre stations", () => {
    const chain = cfg(
      [node("in", "boundary"), node("m", "internal"), node("out", "boundary")],
      [pipe("b1", "in", "m", 2), pipe("b2", "m", "out", 3)],
    );
    const path = listFlowPaths(chain, steady({ b1: 1, b2: 1 }))[0];
    expect(path.axis).toBe("length");
    expect(path.stations.map((s) => s.station)).toEqual([0, 2, 5]);
    expect(path.total).toBe(5);
  });

  it("falls back to station index when a component has no length", () => {
    // An orifice between two pipes: there is no distance to accumulate.
    const mixed = cfg(
      [node("in", "boundary"), node("m", "internal"), node("out", "boundary")],
      [pipe("b1", "in", "m", 2), orifice("b2", "m", "out")],
    );
    const path = listFlowPaths(mixed, steady({ b1: 1, b2: 1 }))[0];
    expect(path.axis).toBe("ordinal");
    expect(path.stations.map((s) => s.station)).toEqual([0, 1, 2]);
  });

  it("marks which stations are boundaries", () => {
    const chain = cfg(
      [node("in", "boundary"), node("m", "internal"), node("out", "boundary")],
      [pipe("b1", "in", "m"), pipe("b2", "m", "out")],
    );
    const path = listFlowPaths(chain, steady({ b1: 1, b2: 1 }))[0];
    expect(path.stations.map((s) => s.boundary)).toEqual([true, false, true]);
  });
});

describe("listFlowPaths: branching and loops", () => {
  const tee = cfg(
    [
      node("in", "boundary"),
      node("j", "internal"),
      node("out1", "boundary"),
      node("out2", "boundary"),
    ],
    [pipe("b1", "in", "j"), pipe("b2", "j", "out1"), pipe("b3", "j", "out2")],
  );

  it("offers one path per outlet of a tee, biggest flow first", () => {
    // out2 takes the larger share, so its path leads.
    const paths = listFlowPaths(tee, steady({ b1: 1, b2: 0.4, b3: 0.6 }));
    expect(paths).toHaveLength(2);
    expect(paths.map((p) => p.label)).toEqual(["in → out2", "in → out1"]);
    expect(paths[0].stations.map((s) => s.nodeId)).toEqual(["in", "j", "out2"]);
  });

  it("does not walk into a leg whose flow comes back toward the junction", () => {
    // b3 reversed: out2 feeds the junction, so it is a source, not a sink.
    const paths = listFlowPaths(tee, steady({ b1: 1, b2: 1.6, b3: -0.6 }));
    expect(paths.map((p) => p.label).sort()).toEqual([
      "in → out1",
      "out2 → out1",
    ]);
  });

  it("finds the closed circuit of a loop with no second boundary", () => {
    const loop = cfg(
      [
        node("cc", "boundary"),
        node("a", "internal"),
        node("b", "internal"),
        node("c", "internal"),
      ],
      [
        pipe("b1", "cc", "a"),
        pipe("b2", "a", "b"),
        pipe("b3", "b", "c"),
        pipe("b4", "c", "cc"),
      ],
    );
    const paths = listFlowPaths(loop, steady({ b1: 1, b2: 1, b3: 1, b4: 1 }));
    expect(paths).toHaveLength(1);
    expect(paths[0].kind).toBe("circuit");
    expect(paths[0].label).toBe("Loop from cc");
    // The circuit closes back on its origin.
    const ids = paths[0].stations.map((s) => s.nodeId);
    expect(ids[0]).toBe(ids[ids.length - 1]);
  });

  it("starts from a draining internal node when no boundary supplies flow", () => {
    // A blowdown: the tank is internal (it has volume), and the only boundary
    // is the receiving atmosphere. Seeding from boundaries alone finds nothing.
    const blowdown = cfg(
      [node("tank", "internal"), node("ambient", "boundary")],
      [orifice("o", "tank", "ambient")],
    );
    const paths = listFlowPaths(blowdown, steady({ o: 0.8 }));
    expect(paths).toHaveLength(1);
    expect(paths[0].label).toBe("tank → ambient");
    expect(paths[0].kind).toBe("through");
  });

  it("prefers boundary terminals when the model has them", () => {
    // Interior nodes of a chain carry no net imbalance, so a proper inlet
    // boundary stays the only origin.
    const chain = cfg(
      [node("in", "boundary"), node("m", "internal"), node("out", "boundary")],
      [pipe("b1", "in", "m"), pipe("b2", "m", "out")],
    );
    const paths = listFlowPaths(chain, steady({ b1: 1, b2: 1 }));
    expect(paths.map((p) => p.label)).toEqual(["in → out"]);
  });

  it("keeps two uncoupled chains as separate paths", () => {
    const pair = cfg(
      [
        node("hIn", "boundary"),
        node("hOut", "boundary"),
        node("cIn", "boundary"),
        node("cOut", "boundary"),
      ],
      [pipe("h1", "hIn", "hOut"), pipe("c1", "cOut", "cIn")],
    );
    const paths = listFlowPaths(pair, steady({ h1: 2, c1: 1 }));
    expect(paths.map((p) => p.label)).toEqual(["hIn → hOut", "cOut → cIn"]);
  });

  it("respects the limit", () => {
    const paths = listFlowPaths(tee, steady({ b1: 1, b2: 0.4, b3: 0.6 }), {
      limit: 1,
    });
    expect(paths).toHaveLength(1);
  });
});

describe("defaultFlowPath / resolveFlowPath", () => {
  const tee = cfg(
    [
      node("in", "boundary"),
      node("j", "internal"),
      node("out1", "boundary"),
      node("out2", "boundary"),
    ],
    [pipe("b1", "in", "j"), pipe("b2", "j", "out1"), pipe("b3", "j", "out2")],
  );
  const paths = listFlowPaths(tee, steady({ b1: 1, b2: 0.4, b3: 0.6 }));

  it("defaults to the dominant path", () => {
    expect(defaultFlowPath(paths)?.label).toBe("in → out2");
  });

  it("re-finds a chosen path by id", () => {
    const second = paths[1];
    expect(resolveFlowPath(paths, second.id)?.label).toBe(second.label);
  });

  it("falls back to the default when the chosen path is gone", () => {
    expect(resolveFlowPath(paths, "through:stale")?.label).toBe("in → out2");
    expect(resolveFlowPath([], "anything")).toBeNull();
  });
});

describe("samplePathField", () => {
  const chain = cfg(
    [node("in", "boundary"), node("m", "internal"), node("out", "boundary")],
    [pipe("b1", "in", "m", 2), pipe("b2", "m", "out", 3)],
  );
  const result = steady(
    { b1: 0.5, b2: 0.5 },
    { in: 3e5, m: 2e5, out: 1e5 },
    { b1: { mdot: 0.5 }, b2: { mdot: 0.5 } },
  );
  const path = listFlowPaths(chain, result)[0];

  it("samples a node field at every station, as a line", () => {
    const series = samplePathField(path, result, "pressure");
    expect(series).toMatchObject({ entity: "node", step: false });
    expect(series!.values).toEqual([3e5, 2e5, 1e5]);
    expect(series!.ids).toEqual(["in", "m", "out"]);
  });

  it("samples a branch field per segment, stepped, repeating the last", () => {
    const series = samplePathField(path, result, "mdot");
    expect(series).toMatchObject({ entity: "branch", step: true });
    // Two segments, three stations: the final value carries the last segment.
    expect(series!.values).toEqual([0.5, 0.5, 0.5]);
    expect(series!.ids).toEqual(["b1", "b2", "b2"]);
  });

  it("leaves a sample null where the result has no value", () => {
    const partial = steady({ b1: 0.5, b2: 0.5 }, { in: 3e5, out: 1e5 });
    const series = samplePathField(path, partial, "pressure");
    expect(series!.values).toEqual([3e5, null, 1e5]);
  });

  it("returns null for a field no entity on the path can carry", () => {
    expect(samplePathField(path, result, "heatRate")).toBeNull();
    expect(samplePathField(null, result, "pressure")).toBeNull();
  });
});

describe("pathBreakdown", () => {
  it("reports each component's loss in path order", () => {
    const chain = cfg(
      [node("in", "boundary"), node("m", "internal"), node("out", "boundary")],
      [pipe("b1", "in", "m"), pipe("b2", "m", "out")],
    );
    const result = steady(
      { b1: 1, b2: 1 },
      {},
      { b1: { dP: 3000 }, b2: { dP: 1000 } },
    );
    const path = listFlowPaths(chain, result)[0];
    const breakdown = pathBreakdown(path, result, "dP");
    expect(breakdown!.rows.map((r) => r.branchId)).toEqual(["b1", "b2"]);
    expect(breakdown!.total).toBe(4000);
    expect(breakdown!.rows.map((r) => r.share)).toEqual([0.75, 0.25]);
  });

  it("flips the sign of a branch traversed against its declared sense", () => {
    // Flow runs out → in, so b1's declared-direction dP is a rise for us.
    const chain = cfg(
      [node("in", "boundary"), node("out", "boundary")],
      [pipe("b1", "in", "out")],
    );
    const result = steady({ b1: -1 }, {}, { b1: { dP: -2000 } });
    const path = listFlowPaths(chain, result)[0];
    expect(pathBreakdown(path, result, "dP")!.total).toBe(2000);
  });

  it("is null when no segment carries the field", () => {
    const chain = cfg(
      [node("in", "boundary"), node("out", "boundary")],
      [pipe("b1", "in", "out")],
    );
    const result = steady({ b1: 1 });
    const path = listFlowPaths(chain, result)[0];
    expect(pathBreakdown(path, result, "mach")).toBeNull();
    expect(pathBreakdown(null, result, "dP")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Real shipped models                                                 */
/* ------------------------------------------------------------------ */

describe("shipped example topologies", () => {
  // The radiator panel is a real-fluid model.
  beforeAll(async () => {
    await initRealFluids();
  });

  const solve = (
    name: string,
  ): { config: NetworkConfig; res: SteadyResult } => {
    const config = examples[name] as NetworkConfig;
    expect(validateNetwork(config)).toEqual([]);
    return { config, res: solveSteady(config) };
  };

  it("profiles the three-pipe junction: one path per outlet", () => {
    const { config, res } = solve("Three-pipe junction");
    const paths = listFlowPaths(config, res);
    expect(paths).toHaveLength(2);
    for (const path of paths) {
      expect(path.stations[0].nodeId).toBe("in");
      expect(path.stations).toHaveLength(3);
      expect(path.axis).toBe("length");
    }
    // Pressure falls monotonically from the inlet along each path.
    for (const path of paths) {
      const series = samplePathField(path, res, "pressure")!;
      const values = series.values as number[];
      expect(values[0]).toBeGreaterThan(values[1]);
      expect(values[1]).toBeGreaterThan(values[2]);
    }
  });

  it("profiles the orifice hand-calc across a length-less component", () => {
    const { config, res } = solve("Sanity: orifice hand-calc");
    const paths = listFlowPaths(config, res);
    expect(paths).toHaveLength(1);
    expect(paths[0].segments[0].component).toBe("orifice");
    // The plate is zero-length, but the example places its taps 0.1 m apart,
    // so the axis is a real distance derived from the node positions.
    expect(paths[0].axis).toBe("length");
    expect(paths[0].total).toBeCloseTo(0.1, 12);
  });

  it("profiles the water distribution network despite its return loop", () => {
    const { config, res } = solve("Water distribution network");
    const paths = listFlowPaths(config, res);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      // A walk never repeats a station except to close a circuit.
      const ids = path.stations.map((s) => s.nodeId);
      const unique = new Set(ids);
      expect(unique.size).toBeGreaterThanOrEqual(ids.length - 1);
      expect(path.segments.length).toBe(path.stations.length - 1);
    }
  });

  it("profiles the counterflow exchanger as separate hot and cold runs", () => {
    const { config, res } = solve("Water-water counterflow heat exchanger");
    const paths = listFlowPaths(config, res);
    expect(paths.length).toBeGreaterThanOrEqual(2);
    // No path mixes the two streams: they share no fluid branch.
    for (const path of paths) {
      const sides = new Set(
        path.stations.map((s) => (s.nodeId.startsWith("h") ? "hot" : "cold")),
      );
      expect(sides.size).toBe(1);
    }
  });

  it("profiles the spacecraft radiator's closed ammonia loop", () => {
    const { config, res } = solve(
      "Spacecraft radiator panel (ammonia loop heat pipe)",
    );
    const paths = listFlowPaths(config, res);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0].stations.length).toBeGreaterThan(3);
  });

  it("breaks the conjugate heated pipe down by component", () => {
    const { config, res } = solve(
      "Heated pipe with radiating wall (conjugate HT)",
    );
    const path = listFlowPaths(config, res)[0];
    const breakdown = pathBreakdown(path, res, "dP")!;
    expect(breakdown.rows.length).toBe(path.segments.length);
    // Shares are a partition of the total magnitude.
    const sum = breakdown.rows.reduce((acc, r) => acc + r.share, 0);
    expect(sum).toBeCloseTo(1, 10);
  });
});
