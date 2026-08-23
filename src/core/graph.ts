/**
 * graph.ts — undirected graph primitives over the network's link lists.
 *
 * A 1-D network is a graph, and several features need to walk it: physical
 * geometry derives axial stations along a pipe run (geometry.ts), and the Runs
 * view plots results along a flow path (ui/flowPath.ts). Both used to carry
 * their own adjacency and traversal code; this module is the one
 * implementation.
 *
 * Everything here is pure, allocation-light and defensive: links are plain
 * `{ id, from, to }` records, so callers keep their own payloads indexed by
 * link id rather than threading generics through the traversal. Node ids are
 * user text and are never parsed.
 */

/** A branch or conductor reduced to its endpoints. */
export interface GraphLink {
  id: string;
  from: string;
  to: string;
}

/** One traversable step out of a node. */
export interface Hop {
  /** Link crossed by this hop. */
  edgeId: string;
  /** Node on the far side. */
  other: string;
  /** True when the hop runs against the link's declared `from → to`. */
  reversed: boolean;
}

/** Node id → hops out of it, in link order. Self-loops are dropped. */
export type Adjacency = Map<string, Hop[]>;

function push(adj: Adjacency, from: string, hop: Hop): void {
  const list = adj.get(from);
  if (list) list.push(hop);
  else adj.set(from, [hop]);
}

/**
 * Undirected adjacency of the given links. A link is skipped when either
 * endpoint is missing or when both are the same node: a self-loop has no
 * far side to travel to, and admitting one would make degree counting lie.
 */
export function buildAdjacency(links: Iterable<GraphLink>): Adjacency {
  const adj: Adjacency = new Map();
  for (const link of links) {
    if (typeof link?.from !== "string" || typeof link.to !== "string") continue;
    if (link.from === link.to) continue;
    push(adj, link.from, {
      edgeId: link.id,
      other: link.to,
      reversed: false,
    });
    push(adj, link.to, { edgeId: link.id, other: link.from, reversed: true });
  }
  return adj;
}

/** Hops out of `id` (empty when the node carries none). */
export function hopsFrom(adj: Adjacency, id: string): readonly Hop[] {
  return adj.get(id) ?? [];
}

/** Number of link ends at `id`; parallel links each count. */
export function degreeOf(adj: Adjacency, id: string): number {
  return adj.get(id)?.length ?? 0;
}

/**
 * Node ids reachable from `start`, in breadth-first discovery order with
 * `start` first. Undefined when `start` has no links at all, which callers
 * read as "not part of this graph" rather than as a one-node component.
 */
export function connectedComponent(
  adj: Adjacency,
  start: string,
): string[] | undefined {
  if (!adj.has(start)) return undefined;
  const seen = new Set<string>([start]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const hop of hopsFrom(adj, queue[i]!)) {
      if (seen.has(hop.other)) continue;
      seen.add(hop.other);
      queue.push(hop.other);
    }
  }
  return queue;
}

/**
 * The two ends of `nodes` when they form ONE unbranched open path: every
 * degree in 1..2 and exactly two nodes of degree 1.
 *
 * Undefined for anything else — a junction (degree > 2), an isolated node, or
 * a closed cycle (every degree 2, so no ends exist).
 */
export function simplePathEndpoints(
  adj: Adjacency,
  nodes: readonly string[],
): [string, string] | undefined {
  const ends: string[] = [];
  for (const id of nodes) {
    const deg = degreeOf(adj, id);
    if (deg === 0 || deg > 2) return undefined;
    if (deg === 1) ends.push(id);
  }
  if (nodes.length >= 2 && ends.length === 2) return [ends[0]!, ends[1]!];
  return undefined;
}

/**
 * Walk an unbranched path from `origin` to `target`, returning the node ids
 * in order. At each step the only hop that does not go back where we came
 * from is taken, so this is only meaningful on a graph whose interior degrees
 * are 2. Undefined when the walk dead-ends or fails to arrive within the
 * graph's size (the guard that stops a cycle spinning forever).
 */
export function orderSimplePath(
  adj: Adjacency,
  origin: string,
  target: string,
): string[] | undefined {
  const ordered = [origin];
  let prev: string | undefined;
  let cur = origin;
  while (cur !== target) {
    const next = hopsFrom(adj, cur).find((hop) => hop.other !== prev);
    if (!next) return undefined;
    prev = cur;
    cur = next.other;
    ordered.push(cur);
    if (ordered.length > adj.size + 1) return undefined;
  }
  return ordered;
}

/** The hop from `a` to `b`, or undefined when they are not adjacent. */
export function hopBetween(
  adj: Adjacency,
  a: string,
  b: string,
): Hop | undefined {
  return hopsFrom(adj, a).find((hop) => hop.other === b);
}

/**
 * How a station axis was derived.
 *
 *   - `length`  — real cumulative distance, in metres.
 *   - `ordinal` — station index, because at least one step had no usable
 *                 length. Plots must say so on the axis rather than implying
 *                 a distance the model never supplied (an orifice, a valve
 *                 or a `flowSource` carries no length at all).
 */
export type StationAxisKind = "length" | "ordinal";

export interface StationAxis {
  /** One coordinate per node, ascending, starting at 0. */
  stations: number[];
  kind: StationAxisKind;
  /** Coordinate of the last station (total path length, or hop count). */
  total: number;
}

/**
 * Cumulative station coordinates for a path of `hopLengths.length + 1` nodes.
 *
 * Real distance is used only when EVERY hop has a finite, non-negative
 * length; one unknown hop degrades the whole axis to ordinal, because a
 * mixed axis would place its stations at coordinates that mean nothing. A
 * zero-length path (all hops 0, e.g. co-located stations) is also ordinal:
 * the distance is technically known but useless as an axis.
 */
export function cumulativeStations(
  hopLengths: readonly (number | undefined)[],
): StationAxis {
  const usable = hopLengths.every(
    (len) => typeof len === "number" && Number.isFinite(len) && len >= 0,
  );
  if (usable) {
    const stations = [0];
    let acc = 0;
    for (const len of hopLengths) {
      acc += len as number;
      stations.push(acc);
    }
    if (acc > 0) return { stations, kind: "length", total: acc };
  }
  const stations = hopLengths.map((_, i) => i);
  stations.push(hopLengths.length);
  return { stations, kind: "ordinal", total: hopLengths.length };
}
