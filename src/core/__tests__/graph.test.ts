/**
 * graph.ts — adjacency, traversal and station-axis primitives.
 *
 * These back both the physical-geometry derivation (geometry.ts) and the Runs
 * view's flow-path profiles, so the cases that matter are the shapes real
 * models take: unbranched chains, junctions, closed loops, and paths whose
 * components carry no length at all.
 */
import { describe, it, expect } from "vitest";
import {
  buildAdjacency,
  connectedComponent,
  cumulativeStations,
  degreeOf,
  hopBetween,
  hopsFrom,
  orderSimplePath,
  simplePathEndpoints,
  type GraphLink,
} from "../graph";

/** a - b - c - d */
const CHAIN: GraphLink[] = [
  { id: "b1", from: "a", to: "b" },
  { id: "b2", from: "b", to: "c" },
  { id: "b3", from: "c", to: "d" },
];

/** in → j, then j splits to out1 / out2 */
const TEE: GraphLink[] = [
  { id: "b1", from: "in", to: "j" },
  { id: "b2", from: "j", to: "out1" },
  { id: "b3", from: "j", to: "out2" },
];

/** a - b - c - a */
const LOOP: GraphLink[] = [
  { id: "b1", from: "a", to: "b" },
  { id: "b2", from: "b", to: "c" },
  { id: "b3", from: "c", to: "a" },
];

describe("buildAdjacency", () => {
  it("records both directions with the traversal sense", () => {
    const adj = buildAdjacency(CHAIN);
    expect(hopsFrom(adj, "a")).toEqual([
      { edgeId: "b1", other: "b", reversed: false },
    ]);
    // Arriving at "b" from "a" runs with the link; leaving toward "a" is
    // against it.
    expect(hopsFrom(adj, "b")).toEqual([
      { edgeId: "b1", other: "a", reversed: true },
      { edgeId: "b2", other: "c", reversed: false },
    ]);
  });

  it("drops self-loops so degree counting stays honest", () => {
    const adj = buildAdjacency([
      { id: "b1", from: "a", to: "a" },
      { id: "b2", from: "a", to: "b" },
    ]);
    expect(degreeOf(adj, "a")).toBe(1);
    expect(hopsFrom(adj, "a").map((h) => h.other)).toEqual(["b"]);
  });

  it("counts parallel links separately", () => {
    const adj = buildAdjacency([
      { id: "b1", from: "a", to: "b" },
      { id: "b2", from: "a", to: "b" },
    ]);
    expect(degreeOf(adj, "a")).toBe(2);
    expect(degreeOf(adj, "b")).toBe(2);
  });

  it("ignores malformed links rather than throwing", () => {
    const adj = buildAdjacency([
      { id: "ok", from: "a", to: "b" },
      { id: "bad" } as unknown as GraphLink,
      null as unknown as GraphLink,
    ]);
    expect(adj.size).toBe(2);
  });
});

describe("connectedComponent", () => {
  it("returns the whole chain in breadth-first order from the start", () => {
    const adj = buildAdjacency(CHAIN);
    expect(connectedComponent(adj, "a")).toEqual(["a", "b", "c", "d"]);
    expect(connectedComponent(adj, "c")).toEqual(["c", "b", "d", "a"]);
  });

  it("separates two uncoupled chains (the counterflow-exchanger shape)", () => {
    const adj = buildAdjacency([
      { id: "h1", from: "hIn", to: "hOut" },
      { id: "c1", from: "cIn", to: "cOut" },
    ]);
    expect(connectedComponent(adj, "hIn")).toEqual(["hIn", "hOut"]);
    expect(connectedComponent(adj, "cIn")).toEqual(["cIn", "cOut"]);
  });

  it("terminates on a loop", () => {
    const adj = buildAdjacency(LOOP);
    expect(connectedComponent(adj, "a")?.sort()).toEqual(["a", "b", "c"]);
  });

  it("is undefined for a node with no links", () => {
    expect(connectedComponent(buildAdjacency(CHAIN), "orphan")).toBeUndefined();
  });
});

describe("simplePathEndpoints", () => {
  it("finds the two ends of an unbranched chain", () => {
    const adj = buildAdjacency(CHAIN);
    expect(simplePathEndpoints(adj, ["a", "b", "c", "d"])).toEqual(["a", "d"]);
  });

  it("rejects a junction", () => {
    const adj = buildAdjacency(TEE);
    expect(
      simplePathEndpoints(adj, ["in", "j", "out1", "out2"]),
    ).toBeUndefined();
  });

  it("rejects a closed loop, which has no ends", () => {
    const adj = buildAdjacency(LOOP);
    expect(simplePathEndpoints(adj, ["a", "b", "c"])).toBeUndefined();
  });
});

describe("orderSimplePath", () => {
  it("walks a chain from either end", () => {
    const adj = buildAdjacency(CHAIN);
    expect(orderSimplePath(adj, "a", "d")).toEqual(["a", "b", "c", "d"]);
    expect(orderSimplePath(adj, "d", "a")).toEqual(["d", "c", "b", "a"]);
  });

  it("gives up rather than spinning when the target is unreachable", () => {
    const adj = buildAdjacency(LOOP);
    expect(orderSimplePath(adj, "a", "elsewhere")).toBeUndefined();
  });

  it("returns the single node when origin and target coincide", () => {
    expect(orderSimplePath(buildAdjacency(CHAIN), "b", "b")).toEqual(["b"]);
  });
});

describe("hopBetween", () => {
  it("names the link joining two nodes, in either direction", () => {
    const adj = buildAdjacency(CHAIN);
    expect(hopBetween(adj, "b", "c")?.edgeId).toBe("b2");
    expect(hopBetween(adj, "c", "b")?.edgeId).toBe("b2");
    expect(hopBetween(adj, "a", "d")).toBeUndefined();
  });
});

describe("cumulativeStations", () => {
  it("accumulates real distance when every hop has a length", () => {
    const axis = cumulativeStations([2, 3, 5]);
    expect(axis.kind).toBe("length");
    expect(axis.stations).toEqual([0, 2, 5, 10]);
    expect(axis.total).toBe(10);
  });

  it("degrades the WHOLE axis to ordinal when one hop has no length", () => {
    // A pipe run interrupted by a valve: mixing metres with a gap would put
    // stations at coordinates that mean nothing.
    const axis = cumulativeStations([2, undefined, 5]);
    expect(axis.kind).toBe("ordinal");
    expect(axis.stations).toEqual([0, 1, 2, 3]);
    expect(axis.total).toBe(3);
  });

  it("is ordinal when no hop has a length at all", () => {
    const axis = cumulativeStations([undefined, undefined]);
    expect(axis.kind).toBe("ordinal");
    expect(axis.stations).toEqual([0, 1, 2]);
  });

  it("is ordinal when the known distance is zero", () => {
    const axis = cumulativeStations([0, 0]);
    expect(axis.kind).toBe("ordinal");
    expect(axis.stations).toEqual([0, 1, 2]);
  });

  it("rejects negative and non-finite lengths", () => {
    expect(cumulativeStations([1, -1]).kind).toBe("ordinal");
    expect(cumulativeStations([1, Number.NaN]).kind).toBe("ordinal");
    expect(cumulativeStations([1, Infinity]).kind).toBe("ordinal");
  });

  it("yields a single station for an empty path", () => {
    const axis = cumulativeStations([]);
    expect(axis.stations).toEqual([0]);
    expect(axis.total).toBe(0);
  });
});
