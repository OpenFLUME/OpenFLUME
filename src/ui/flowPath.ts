/**
 * flowPath.ts — flow paths through a solved network, and channel profiles
 * along them.
 *
 * The Results view's system profile answers "where is my pressure going?", which
 * needs the network read as a sequence rather than as a bag of values. That
 * sequence is not in the model: `type: "boundary"` marks a reservoir but never
 * says inlet or outlet, and a branch's declared `from → to` is only a sign
 * convention. Direction is a RESULT. So this module orients the graph from the
 * solved `mdot` signs and walks it downstream.
 *
 * Pure and defensive in the manner of channelContext.ts: every function reads
 * only the CAPTURED config/result snapshots it is handed, so a model edited
 * after the run never changes what a historical profile shows. Sampling goes
 * through channels.ts `resolveChannelAt`, so profiles cannot drift from the
 * canvas or the tables.
 *
 * Shapes it must handle (all present in the shipped examples): unbranched
 * chains, tees that split to several outlets, closed circulation loops with
 * only one boundary, and two uncoupled chains that share no fluid link (the
 * counterflow exchanger, where each side is its own path).
 */
import {
  branchAxialLength,
  buildAdjacency,
  cumulativeStations,
  hopsFrom,
  type Adjacency,
  type StationAxisKind,
} from "../core";
import type { NetworkConfig, SteadyResult, TransientResult } from "./types";
import { makeChannelId, resolveChannelAt, type ChannelField } from "./channels";

type Branch = NetworkConfig["branches"][number];
type FluidNode = NetworkConfig["nodes"][number];

/** Below this the flow is noise, not a direction. */
const FLOW_EPS = 1e-12;
/** Candidate paths offered to the picker. */
export const MAX_FLOW_PATHS = 12;
/** Guard against pathological graphs; no shipped model comes close. */
const MAX_PATH_STATIONS = 400;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface PathStation {
  nodeId: string;
  label: string;
  /** Coordinate on the path axis (metres, or station index). */
  station: number;
  boundary: boolean;
}

export interface PathSegment {
  branchId: string;
  label: string;
  /** Component type, for the P&ID glyph. */
  component: string;
  /** Upstream / downstream node ids IN FLOW ORDER. */
  from: string;
  to: string;
  /** True when flow runs against the branch's declared `from → to`. */
  reversed: boolean;
  fromStation: number;
  toStation: number;
  /** Mass flow magnitude in the flow direction (always ≥ 0). */
  mdot: number;
}

export type FlowPathKind = "through" | "circuit";

export interface FlowPath {
  /** Stable across re-solves of the same topology, so a selection survives. */
  id: string;
  label: string;
  /**
   *   - `through` — boundary to boundary, the usual inlet-to-outlet run.
   *   - `circuit` — a closed loop that never reaches a second boundary
   *                 (a pumped or capillary circulation loop).
   */
  kind: FlowPathKind;
  stations: PathStation[];
  segments: PathSegment[];
  /** Whether `station` coordinates are metres or a bare index. */
  axis: StationAxisKind;
  /** Coordinate of the last station. */
  total: number;
}

/* ------------------------------------------------------------------ */
/* Orientation                                                         */
/* ------------------------------------------------------------------ */

interface Flow {
  /** Upstream node under the solved flow direction. */
  from: string;
  /** Downstream node. */
  to: string;
  reversed: boolean;
  /** |mdot|; 0 when the branch carries no resolvable flow. */
  magnitude: number;
}

/**
 * Solved flow direction per branch. A negative `mdot` means the branch runs
 * against its declared sense, which is exactly the reverse-flow case the
 * profile must render the right way round. Branches with no resolvable or
 * negligible flow keep their declared sense at zero magnitude, so they can
 * still be walked (a dead leg is part of the geometry) but never win a
 * junction.
 */
function orientBranches(
  branches: readonly Branch[],
  result: SteadyResult | TransientResult | null | undefined,
  timeIndex: number | null,
): Map<string, Flow> {
  const flows = new Map<string, Flow>();
  for (const branch of branches) {
    if (!branch || typeof branch.id !== "string") continue;
    const mdot = resolveChannelAt(
      result,
      makeChannelId("branch", branch.id, "mdot"),
      timeIndex,
    );
    const signed = typeof mdot === "number" ? mdot : 0;
    const reversed = signed < -FLOW_EPS;
    flows.set(branch.id, {
      from: reversed ? branch.to : branch.from,
      to: reversed ? branch.from : branch.to,
      reversed,
      magnitude: Math.abs(signed),
    });
  }
  return flows;
}

/** Net mass flow LEAVING `nodeId` (positive = a source of fluid). */
function netOutflow(
  nodeId: string,
  adj: Adjacency,
  flows: Map<string, Flow>,
): number {
  let net = 0;
  for (const hop of hopsFrom(adj, nodeId)) {
    const flow = flows.get(hop.edgeId);
    if (!flow) continue;
    net += flow.from === nodeId ? flow.magnitude : -flow.magnitude;
  }
  return net;
}

/* ------------------------------------------------------------------ */
/* Path enumeration                                                    */
/* ------------------------------------------------------------------ */

interface Walk {
  /** Node ids in flow order. */
  nodes: string[];
  /** Branch ids joining them, one fewer than `nodes` unless a circuit. */
  edges: string[];
}

/** Hops out of `nodeId` that flow downstream, strongest first. */
function downstream(
  nodeId: string,
  adj: Adjacency,
  flows: Map<string, Flow>,
): Array<{ edgeId: string; to: string; magnitude: number }> {
  const out: Array<{ edgeId: string; to: string; magnitude: number }> = [];
  for (const hop of hopsFrom(adj, nodeId)) {
    const flow = flows.get(hop.edgeId);
    if (!flow || flow.from !== nodeId) continue;
    out.push({ edgeId: hop.edgeId, to: flow.to, magnitude: flow.magnitude });
  }
  out.sort((a, b) => b.magnitude - a.magnitude);
  return out;
}

/**
 * Every downstream walk from `origin` that ends at a sink, strongest branch
 * first at each junction, capped. Depth-first over a flow-oriented graph:
 * the visited set makes a circulating loop terminate instead of spinning.
 */
function throughWalks(
  origin: string,
  sinks: Set<string>,
  adj: Adjacency,
  flows: Map<string, Flow>,
  limit: number,
): Walk[] {
  const found: Walk[] = [];
  const nodes: string[] = [origin];
  const edges: string[] = [];
  const onPath = new Set<string>([origin]);

  const visit = (nodeId: string): void => {
    if (found.length >= limit) return;
    if (nodes.length > MAX_PATH_STATIONS) return;
    for (const step of downstream(nodeId, adj, flows)) {
      if (onPath.has(step.to)) continue;
      nodes.push(step.to);
      edges.push(step.edgeId);
      onPath.add(step.to);
      if (sinks.has(step.to)) {
        found.push({ nodes: nodes.slice(), edges: edges.slice() });
      } else {
        visit(step.to);
      }
      onPath.delete(step.to);
      nodes.pop();
      edges.pop();
      if (found.length >= limit) return;
    }
  };

  visit(origin);
  return found;
}

/**
 * The dominant circulation loop: follow the strongest downstream branch from
 * `origin` until it returns to a node already on the walk, then keep the
 * closed part. This is the only way a pumped loop with no second boundary
 * gets a path at all.
 */
function circuitWalk(
  origin: string,
  adj: Adjacency,
  flows: Map<string, Flow>,
): Walk | null {
  const nodes: string[] = [origin];
  const edges: string[] = [];
  const seen = new Map<string, number>([[origin, 0]]);
  let cur = origin;
  for (let guard = 0; guard < MAX_PATH_STATIONS; guard++) {
    const next = downstream(cur, adj, flows)[0];
    if (!next || next.magnitude <= FLOW_EPS) return null;
    const seenAt = seen.get(next.to);
    if (seenAt !== undefined) {
      // Closed: keep the cycle, dropping any tail that led into it.
      return {
        nodes: [...nodes.slice(seenAt), next.to],
        edges: edges.slice(seenAt),
      };
    }
    nodes.push(next.to);
    edges.push(next.edgeId);
    seen.set(next.to, nodes.length - 1);
    cur = next.to;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Materialization                                                     */
/* ------------------------------------------------------------------ */

function nodeLabel(node: FluidNode | undefined, id: string): string {
  const label = node?.label;
  return typeof label === "string" && label.length > 0 ? label : id;
}

function toFlowPath(
  walk: Walk,
  index: {
    nodeOf: Map<string, FluidNode>;
    branchOf: Map<string, Branch>;
    flows: Map<string, Flow>;
  },
  kind: FlowPathKind,
): FlowPath | null {
  if (walk.nodes.length < 2 || walk.edges.length < 1) return null;

  const hopLengths = walk.edges.map((edgeId, i) => {
    const branch = index.branchOf.get(edgeId);
    if (!branch) return undefined;
    return branchAxialLength(
      branch,
      index.nodeOf.get(walk.nodes[i]!),
      index.nodeOf.get(walk.nodes[i + 1]!),
    );
  });
  const axis = cumulativeStations(hopLengths);

  const stations: PathStation[] = walk.nodes.map((nodeId, i) => {
    const node = index.nodeOf.get(nodeId);
    return {
      nodeId,
      label: nodeLabel(node, nodeId),
      station: axis.stations[i] ?? i,
      boundary: node?.type === "boundary",
    };
  });

  const segments: PathSegment[] = [];
  for (let i = 0; i < walk.edges.length; i++) {
    const edgeId = walk.edges[i]!;
    const branch = index.branchOf.get(edgeId);
    const flow = index.flows.get(edgeId);
    if (!branch || !flow) return null;
    const label =
      typeof branch.label === "string" && branch.label.length > 0
        ? branch.label
        : branch.id;
    segments.push({
      branchId: edgeId,
      label,
      component: branch.component?.type ?? "resistance",
      from: walk.nodes[i]!,
      to: walk.nodes[i + 1]!,
      reversed: flow.reversed,
      fromStation: stations[i]!.station,
      toStation: stations[i + 1]!.station,
      mdot: flow.magnitude,
    });
  }

  const first = stations[0]!;
  const last = stations[stations.length - 1]!;
  return {
    id:
      kind === "circuit"
        ? `circuit:${first.nodeId}`
        : `through:${first.nodeId}>${last.nodeId}:${walk.edges.join(",")}`,
    label:
      kind === "circuit"
        ? `Loop from ${first.label}`
        : `${first.label} → ${last.label}`,
    kind,
    stations,
    segments,
    axis: axis.kind,
    total: axis.total,
  };
}

/**
 * Candidate flow paths through the solved network, best first.
 *
 * "Best" means carrying the most flow at its first segment, then shortest:
 * the default path should be the main run, not an incidental dead leg. Every
 * boundary with net outflow seeds a walk, so a tee contributes one path per
 * outlet and two uncoupled chains contribute their own paths independently.
 * When nothing reaches a second boundary the dominant circulation loop is
 * offered instead.
 *
 * Empty when the result carries no flow at all (an unconverged or absent
 * result), which callers show as "no path to profile" rather than inventing
 * a direction.
 */
export function listFlowPaths(
  config: NetworkConfig | null | undefined,
  result: SteadyResult | TransientResult | null | undefined,
  opts: { timeIndex?: number | null; limit?: number } = {},
): FlowPath[] {
  try {
    const branches = Array.isArray(config?.branches) ? config.branches : [];
    const nodes = Array.isArray(config?.nodes) ? config.nodes : [];
    if (branches.length === 0 || nodes.length === 0) return [];

    const limit = Math.max(1, opts.limit ?? MAX_FLOW_PATHS);
    const timeIndex = opts.timeIndex ?? null;
    const nodeOf = new Map(nodes.map((node) => [node.id, node]));
    const branchOf = new Map(branches.map((branch) => [branch.id, branch]));
    const adj = buildAdjacency(branches);
    const flows = orientBranches(branches, result, timeIndex);
    const index = { nodeOf, branchOf, flows };

    // Terminals are where mass enters and leaves the network. Boundaries are
    // the canonical answer, but they are not the only one: a blowdown's supply
    // is the INTERNAL tank node that is draining, and a model can legitimately
    // have no boundary on the supply side at all. So fall back to any node with
    // a net imbalance, and only as a fallback — otherwise a transient chain
    // whose nodes all accumulate slightly would seed a path from every one.
    const net = new Map<string, number>();
    for (const node of nodes) net.set(node.id, netOutflow(node.id, adj, flows));

    const pick = (want: "source" | "sink", boundaryOnly: boolean): string[] =>
      nodes
        .filter((n) => !boundaryOnly || n.type === "boundary")
        .filter((n) => {
          const value = net.get(n.id) ?? 0;
          return want === "source" ? value > FLOW_EPS : value < -FLOW_EPS;
        })
        .sort((a, b) => {
          const av = Math.abs(net.get(a.id) ?? 0);
          const bv = Math.abs(net.get(b.id) ?? 0);
          return bv - av;
        })
        .map((n) => n.id);

    let sources = pick("source", true);
    if (sources.length === 0) sources = pick("source", false);
    let sinkIds = pick("sink", true);
    if (sinkIds.length === 0) sinkIds = pick("sink", false);
    const sinks = new Set(sinkIds);

    const paths: FlowPath[] = [];
    const seen = new Set<string>();
    const add = (path: FlowPath | null): void => {
      if (!path || seen.has(path.id)) return;
      seen.add(path.id);
      paths.push(path);
    };

    for (const origin of sources) {
      for (const walk of throughWalks(origin, sinks, adj, flows, limit)) {
        add(toFlowPath(walk, index, "through"));
      }
    }

    if (paths.length === 0) {
      // No boundary-to-boundary run: fall back to the dominant circuit,
      // seeded from the strongest-flowing branch's upstream node.
      let best: Flow | null = null;
      for (const flow of flows.values())
        if (!best || flow.magnitude > best.magnitude) best = flow;
      if (best && best.magnitude > FLOW_EPS) {
        const walk = circuitWalk(best.from, adj, flows);
        if (walk) add(toFlowPath(walk, index, "circuit"));
      }
    }

    paths.sort((a, b) => {
      // Throughput, not the first segment: paths out of one inlet share their
      // opening run, so the leg taken at the junction is what distinguishes
      // them and the bottleneck is what the path actually carries.
      const flowA = pathThroughput(a);
      const flowB = pathThroughput(b);
      if (flowA !== flowB) return flowB - flowA;
      if (a.stations.length !== b.stations.length)
        return b.stations.length - a.stations.length;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return paths.slice(0, limit);
  } catch {
    return [];
  }
}

/** Mass flow the path carries end to end: its narrowest segment. */
export function pathThroughput(path: FlowPath): number {
  if (path.segments.length === 0) return 0;
  return path.segments.reduce(
    (min, segment) => Math.min(min, segment.mdot),
    Infinity,
  );
}

/** The path a freshly opened profile should show, or null when none exist. */
export function defaultFlowPath(paths: readonly FlowPath[]): FlowPath | null {
  return paths[0] ?? null;
}

/** Re-find a previously chosen path after a re-solve; falls back to the best. */
export function resolveFlowPath(
  paths: readonly FlowPath[],
  id: string | null,
): FlowPath | null {
  if (id) {
    const exact = paths.find((p) => p.id === id);
    if (exact) return exact;
  }
  return defaultFlowPath(paths);
}

/* ------------------------------------------------------------------ */
/* Sampling                                                            */
/* ------------------------------------------------------------------ */

export interface ProfileSeries {
  field: ChannelField;
  entity: "node" | "branch";
  /**
   * Values aligned to the path's stations.
   *
   * Node fields carry a value AT each station, so the series is a line whose
   * slope is the gradient between stations. Branch fields belong to the span
   * BETWEEN stations, so value i is the segment leaving station i and the
   * last entry repeats it — drawn stepped, which is what a per-component
   * quantity actually looks like along a path.
   */
  values: Array<number | null>;
  /** True when this series should be drawn as stairs rather than a line. */
  step: boolean;
  /** Element id per sample, so a click on the plot can select it. */
  ids: string[];
}

/**
 * Sample one channel field along a path. Node and solid fields resolve at
 * stations; branch and conductor fields resolve over segments. Returns null
 * when the field cannot apply to either (nothing is fabricated), and leaves
 * individual samples null where the result has no finite value.
 */
export function samplePathField(
  path: FlowPath | null | undefined,
  result: SteadyResult | TransientResult | null | undefined,
  field: ChannelField,
  opts: { timeIndex?: number | null } = {},
): ProfileSeries | null {
  if (!path) return null;
  const timeIndex = opts.timeIndex ?? null;

  // Which entity owns the field decides the shape of the series, so settle
  // that before resolving anything.
  if (makeChannelId("node", "probe", field)) {
    return {
      field,
      entity: "node",
      values: path.stations.map((station) =>
        resolveChannelAt(
          result,
          makeChannelId("node", station.nodeId, field),
          timeIndex,
        ),
      ),
      step: false,
      ids: path.stations.map((s) => s.nodeId),
    };
  }

  if (!makeChannelId("branch", "probe", field)) return null;
  const perSegment = path.segments.map((segment) =>
    resolveChannelAt(
      result,
      makeChannelId("branch", segment.branchId, field),
      timeIndex,
    ),
  );
  const last = perSegment[perSegment.length - 1] ?? null;
  return {
    field,
    entity: "branch",
    values: [...perSegment, last],
    step: true,
    ids: [
      ...path.segments.map((s) => s.branchId),
      path.segments[path.segments.length - 1]?.branchId ?? "",
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Breakdown                                                           */
/* ------------------------------------------------------------------ */

export interface BreakdownRow {
  branchId: string;
  label: string;
  component: string;
  /** Signed contribution in the flow direction (a loss is positive). */
  value: number;
  /** Share of the total absolute contribution, 0..1. */
  share: number;
  fromStation: number;
  toStation: number;
}

export interface PathBreakdown {
  field: ChannelField;
  rows: BreakdownRow[];
  /** Sum of the signed contributions. */
  total: number;
  /** Sum of the absolute contributions (the share denominator). */
  magnitude: number;
}

/**
 * Per-component contribution along the path, in path order.
 *
 * `dP` is reported in the FLOW direction: a branch traversed against its
 * declared sense has its sign flipped, so a loss reads positive everywhere on
 * the path and the numbers add up down the run instead of cancelling.
 */
export function pathBreakdown(
  path: FlowPath | null | undefined,
  result: SteadyResult | TransientResult | null | undefined,
  field: ChannelField = "dP",
  opts: { timeIndex?: number | null } = {},
): PathBreakdown | null {
  if (!path || path.segments.length === 0) return null;
  const timeIndex = opts.timeIndex ?? null;
  const rows: BreakdownRow[] = [];
  let total = 0;
  let magnitude = 0;

  for (const segment of path.segments) {
    const raw = resolveChannelAt(
      result,
      makeChannelId("branch", segment.branchId, field),
      timeIndex,
    );
    if (raw === null) continue;
    const value = segment.reversed ? -raw : raw;
    total += value;
    magnitude += Math.abs(value);
    rows.push({
      branchId: segment.branchId,
      label: segment.label,
      component: segment.component,
      value,
      share: 0,
      fromStation: segment.fromStation,
      toStation: segment.toStation,
    });
  }
  if (rows.length === 0) return null;
  for (const row of rows)
    row.share = magnitude > 0 ? Math.abs(row.value) / magnitude : 0;
  return { field, rows, total, magnitude };
}
