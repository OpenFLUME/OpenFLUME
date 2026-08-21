/**
 * Physical-geometry helpers — canvas `x`/`y` are pixels and are never
 * consulted here.  Optional `position {x,y,z}` (metres, z-up) on fluid and
 * solid nodes can fill unset pipe `elevationChange` and convection
 * `axialPosition` / `segmentLength` when the connected pipe graph is a
 * unique simple path.  Explicit numbers and `{ expr }` bindings always win.
 */
import type {
  Conductor,
  NetworkConfig,
  PhysicalPosition,
  SolidNode,
} from "./schema";

type FluidNode = NetworkConfig["nodes"][number];
type Branch = NetworkConfig["branches"][number];
type PipeLike = Extract<Branch["component"], { type: "pipe" | "heatedPipe" }>;
type ResolvedPhysicalPosition = { x?: number; y?: number; z?: number };

const PIPE_TYPES = new Set(["pipe", "heatedPipe"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExpression(value: unknown): boolean {
  return isRecord(value) && typeof value.expr === "string";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Legacy top-level `z` still counts as elevation until decode migrates it. */
export function physicalPosition(
  node: { position?: PhysicalPosition; z?: number } | undefined,
): ResolvedPhysicalPosition | undefined {
  if (!node) return undefined;
  const x = finiteNumber(node.position?.x);
  const y = finiteNumber(node.position?.y);
  const z = finiteNumber(node.position?.z ?? node.z);
  if (x === undefined && y === undefined && z === undefined) return undefined;
  const out: ResolvedPhysicalPosition = {};
  if (x !== undefined) out.x = x;
  if (y !== undefined) out.y = y;
  if (z !== undefined) out.z = z;
  return out;
}

function euclidean(
  a: ResolvedPhysicalPosition,
  b: ResolvedPhysicalPosition,
): number {
  const dx = (a.x ?? 0) - (b.x ?? 0);
  const dy = (a.y ?? 0) - (b.y ?? 0);
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.hypot(dx, dy, dz);
}

interface Hop {
  other: string;
  branch: Branch;
}

function pipeGraph(config: NetworkConfig): Map<string, Hop[]> {
  const graph = new Map<string, Hop[]>();
  const add = (from: string, hop: Hop) => {
    const list = graph.get(from);
    if (list) list.push(hop);
    else graph.set(from, [hop]);
  };
  for (const branch of config.branches) {
    if (!PIPE_TYPES.has(branch.component.type)) continue;
    add(branch.from, { other: branch.to, branch });
    add(branch.to, { other: branch.from, branch });
  }
  return graph;
}

function componentOf(
  start: string,
  graph: Map<string, Hop[]>,
): string[] | undefined {
  if (!graph.has(start)) return undefined;
  const seen = new Set<string>([start]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const hop of graph.get(queue[i]) ?? []) {
      if (seen.has(hop.other)) continue;
      seen.add(hop.other);
      queue.push(hop.other);
    }
  }
  return queue;
}

function pathEndpoints(
  nodes: string[],
  graph: Map<string, Hop[]>,
): [string, string] | undefined {
  const deg1: string[] = [];
  for (const id of nodes) {
    const deg = graph.get(id)?.length ?? 0;
    if (deg === 0 || deg > 2) return undefined;
    if (deg === 1) deg1.push(id);
  }
  if (nodes.length >= 2 && deg1.length === 2) return [deg1[0]!, deg1[1]!];
  return undefined;
}

function pickOrigin(
  endpoints: [string, string],
  nodeOf: Map<string, FluidNode>,
): string | undefined {
  const boundaries = endpoints.filter(
    (id) => nodeOf.get(id)?.type === "boundary",
  );
  if (boundaries.length === 1) return boundaries[0];
  if (boundaries.length !== 2) return undefined;
  const withX = boundaries.filter(
    (id) => finiteNumber(physicalPosition(nodeOf.get(id))?.x) !== undefined,
  );
  if (withX.length === 1) return withX[0];
  if (withX.length === 2) {
    const x0 = physicalPosition(nodeOf.get(withX[0]!))!.x!;
    const x1 = physicalPosition(nodeOf.get(withX[1]!))!.x!;
    if (x0 !== x1) return x0 < x1 ? withX[0] : withX[1];
  }
  return undefined;
}

function orderedPath(
  origin: string,
  other: string,
  graph: Map<string, Hop[]>,
): string[] | undefined {
  const ordered = [origin];
  let prev: string | undefined;
  let cur = origin;
  while (cur !== other) {
    const hops = graph.get(cur) ?? [];
    const next = hops.find((h) => h.other !== prev);
    if (!next) return undefined;
    prev = cur;
    cur = next.other;
    ordered.push(cur);
    if (ordered.length > graph.size + 1) return undefined;
  }
  return ordered;
}

function hopLength(
  from: FluidNode | undefined,
  to: FluidNode | undefined,
  branch: Branch,
): number | undefined {
  const comp = branch.component as PipeLike;
  const stored = finiteNumber(comp.length);
  if (stored !== undefined && stored >= 0) return stored;
  if (isExpression(comp.length)) return undefined;
  const a = physicalPosition(from);
  const b = physicalPosition(to);
  if (!a || !b) return undefined;
  return euclidean(a, b);
}

interface PathStations {
  origin: string;
  stations: Map<string, number>;
  hops: Map<string, number>;
}

interface GeometryIndex {
  nodeOf: Map<string, FluidNode>;
  solidOf: Map<string, SolidNode>;
  fluidIds: Set<string>;
  graph: Map<string, Hop[]>;
  pathByFluid: Map<string, PathStations | null>;
}

function geometryIndex(config: NetworkConfig): GeometryIndex {
  return {
    nodeOf: new Map(config.nodes.map((node) => [node.id, node])),
    solidOf: new Map(
      (config.solidNodes ?? []).map((solid) => [solid.id, solid]),
    ),
    fluidIds: new Set(config.nodes.map((node) => node.id)),
    graph: pipeGraph(config),
    pathByFluid: new Map(),
  };
}

function pathStationsFor(
  fluidId: string,
  index: GeometryIndex,
): PathStations | undefined {
  const cached = index.pathByFluid.get(fluidId);
  if (cached !== undefined) return cached ?? undefined;

  const component = componentOf(fluidId, index.graph);
  if (!component) return undefined;
  const cache = (path: PathStations | null): PathStations | undefined => {
    for (const id of component) index.pathByFluid.set(id, path);
    return path ?? undefined;
  };
  const ends = pathEndpoints(component, index.graph);
  if (!ends) return cache(null);
  const origin = pickOrigin(ends, index.nodeOf);
  if (!origin) return cache(null);
  const other = ends[0] === origin ? ends[1] : ends[0];
  const ordered = orderedPath(origin, other, index.graph);
  if (!ordered) return cache(null);
  const stations = new Map<string, number>([[ordered[0]!, 0]]);
  const hops = new Map<string, number>();
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1]!;
    const b = ordered[i]!;
    const hop = (index.graph.get(a) ?? []).find(
      (candidate) => candidate.other === b,
    );
    if (!hop) return cache(null);
    const length = hopLength(
      index.nodeOf.get(a),
      index.nodeOf.get(b),
      hop.branch,
    );
    if (length === undefined) return cache(null);
    hops.set(`${a}|${b}`, length);
    hops.set(`${b}|${a}`, length);
    stations.set(b, stations.get(a)! + length);
  }
  return cache({ origin, stations, hops });
}

function fluidAndSolid(
  conductor: Conductor,
  index: GeometryIndex,
): { fluidId: string; solid?: SolidNode } | undefined {
  const aFluid = index.fluidIds.has(conductor.from);
  const bFluid = index.fluidIds.has(conductor.to);
  if (aFluid === bFluid) return undefined;
  const fluidId = aFluid ? conductor.from : conductor.to;
  const solidId = aFluid ? conductor.to : conductor.from;
  return { fluidId, solid: index.solidOf.get(solidId) };
}

function derivedConvectionGeometry(
  conductor: Conductor,
  index: GeometryIndex,
): { axialPosition?: number; segmentLength?: number } | undefined {
  const ends = fluidAndSolid(conductor, index);
  if (!ends) return undefined;
  const path = pathStationsFor(ends.fluidId, index);
  if (!path) return undefined;

  const originX = physicalPosition(index.nodeOf.get(path.origin))?.x;
  const solidX = physicalPosition(ends.solid)?.x;
  const axialPosition =
    finiteNumber(solidX) !== undefined && finiteNumber(originX) !== undefined
      ? solidX! - originX!
      : path.stations.get(ends.fluidId);

  const hops = index.graph.get(ends.fluidId) ?? [];
  const lengths = hops
    .map((h) => path.hops.get(`${ends.fluidId}|${h.other}`))
    .filter((v): v is number => v !== undefined);
  let segmentLength: number | undefined;
  if (
    lengths.length === 1 ||
    (lengths.length === 2 && lengths[0] === lengths[1])
  ) {
    segmentLength = lengths[0];
  } else if (lengths.length === 2) {
    const here = path.stations.get(ends.fluidId);
    if (here !== undefined) {
      const downstream = hops
        .map((h) => path.stations.get(h.other))
        .filter((s): s is number => s !== undefined && s > here);
      if (downstream.length === 1) segmentLength = downstream[0] - here;
    }
  }
  return { axialPosition, segmentLength };
}

function elevationFromPositions(
  branch: Branch,
  nodeOf: Map<string, FluidNode>,
): number | undefined {
  if (!PIPE_TYPES.has(branch.component.type)) return undefined;
  const fromZ = finiteNumber(physicalPosition(nodeOf.get(branch.from))?.z);
  const toZ = finiteNumber(physicalPosition(nodeOf.get(branch.to))?.z);
  if (fromZ === undefined || toZ === undefined) return undefined;
  return toZ - fromZ;
}

/** Preview the path-derived axial station for one convection conductor. */
export function derivedAxialPosition(
  config: NetworkConfig,
  conductorId: string,
): number | undefined {
  const conductor = (config.conductors ?? []).find((c) => c.id === conductorId);
  if (!conductor || conductor.type.kind !== "convection") return undefined;
  return derivedConvectionGeometry(conductor, geometryIndex(config))
    ?.axialPosition;
}

/**
 * Fill unset elevationChange / axialPosition / segmentLength from physical
 * node positions when the pipe graph is a unique path.  Returns the input
 * unchanged (same reference) when nothing is derived.
 */
export function withDerivedGeometry(config: NetworkConfig): NetworkConfig {
  const index = geometryIndex(config);

  const elevByBranch = new Map<string, number>();
  for (const branch of config.branches) {
    if (!PIPE_TYPES.has(branch.component.type)) continue;
    const current: unknown = (branch.component as { elevationChange?: unknown })
      .elevationChange;
    if (isExpression(current) || finiteNumber(current) !== undefined) continue;
    const derived = elevationFromPositions(branch, index.nodeOf);
    if (derived === undefined) continue;
    elevByBranch.set(branch.id, derived);
  }

  const axialByCond = new Map<string, number>();
  const segByCond = new Map<string, number>();
  for (const conductor of config.conductors ?? []) {
    if (conductor.type.kind !== "convection" || !conductor.type.correlation)
      continue;
    const corr = conductor.type.correlation;
    const needsAxial = corr.axialPosition === undefined;
    const needsSegment =
      corr.model === "ttWf" && corr.segmentLength === undefined;
    if (!needsAxial && !needsSegment) continue;
    const derived = derivedConvectionGeometry(conductor, index);
    if (!derived) continue;
    if (needsAxial) {
      const z = derived.axialPosition;
      if (z !== undefined && z >= 0) axialByCond.set(conductor.id, z);
    }
    if (needsSegment) {
      const dz = derived.segmentLength;
      if (dz !== undefined && dz > 0) segByCond.set(conductor.id, dz);
    }
  }

  if (elevByBranch.size === 0 && axialByCond.size === 0 && segByCond.size === 0)
    return config;

  const next = structuredClone(config);
  for (const branch of next.branches) {
    const elev = elevByBranch.get(branch.id);
    if (elev === undefined) continue;
    (branch.component as PipeLike).elevationChange = elev;
  }
  for (const conductor of next.conductors ?? []) {
    if (conductor.type.kind !== "convection" || !conductor.type.correlation)
      continue;
    const axial = axialByCond.get(conductor.id);
    if (axial !== undefined) conductor.type.correlation.axialPosition = axial;
    const seg = segByCond.get(conductor.id);
    if (seg !== undefined) conductor.type.correlation.segmentLength = seg;
  }
  return next;
}
