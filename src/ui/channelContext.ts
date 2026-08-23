/**
 * Channel context core — Stage 2: read-only focus context graph + CSV export.
 *
 * This module is the headless companion to ui/channels.ts (channel identity,
 * inventory and resolution).  It contains NO React and touches NO live store:
 * every function is pure and reads only the CAPTURED NetworkConfig / result
 * snapshots it is handed (e.g. a run-history record), so a model edited or
 * deleted after the run never changes historical output.
 *
 *   - buildContextGraph      — one-hop topology neighborhood of a selected
 *                              element (node / branch / solidNode / conductor
 *                              / group), as a plain render-agnostic graph.
 *                              Graph invariant: every edge endpoint resolves
 *                              to a node present in `nodes` — dangling
 *                              references are dropped, never rendered.
 *   - normalizeViewport /
 *     layoutContextGraph     — stable source-x/y → SVG-box mapping with
 *                              padding, uniform scale (relative geometry is
 *                              preserved), and centered degenerate cases
 *                              (single point / identical coordinates).
 *   - buildChannelsCsv       — deterministic CSV text for selected channel
 *                              descriptors with provenance comments taken
 *                              from the captured config/hash/settings.
 *   - channelsExportFilename — filesystem-safe export filename from the
 *                              captured model name + channel count, with an
 *                              optional `all` kind for the full-inventory
 *                              download (`…-all-channels-N.csv`).
 *
 * Unit conversion (mirrors channels.ts): values are RAW SI solver values unless
 * the caller explicitly supplies unit preferences; channels carrying a
 * `rawUnit` are NEVER converted because they have no convertible QuantityKind.
 * Headers/comments always state which regime applies.
 */

import type {
  NetworkConfig,
  Selection,
  SteadyResult,
  TransientResult,
} from "./types";
import type { UnitPreferences } from "./units";
import { getBaseUnit, getUnitDef } from "./units";
import { configHash, settingsSummary } from "./provenance";
import type { ChannelDescriptor, ChannelId } from "./channels";
import { resolveChannel } from "./channels";
import { csvCell, csvCommentValue } from "./csv";

/* ------------------------------------------------------------------ */
/* Shared defensive helpers (same posture as channels.ts)              */
/* ------------------------------------------------------------------ */

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object"
    ? (v as Record<string, unknown>)
    : undefined;
}

const ENTITY_KINDS = ["node", "branch", "solidNode", "conductor"] as const;
type EntityKind = (typeof ENTITY_KINDS)[number];

function isEntityKind(v: string): v is EntityKind {
  return (ENTITY_KINDS as readonly string[]).includes(v);
}

/** Selection input accepted by buildContextGraph: a UI Selection or a ChannelId. */
export type ContextSelection = Selection | ChannelId | null | undefined;

interface NormalizedSelection {
  kind: EntityKind | "group" | "none";
  id: string;
}

/** Accepts Selection ({kind, id}) and ChannelId ({entity, id}) shapes; never throws. */
function normalizeSelection(
  selection: ContextSelection,
): NormalizedSelection | null {
  const rec = asRecord(selection);
  if (!rec) return null;
  const rawKind =
    typeof rec.kind === "string"
      ? rec.kind
      : typeof rec.entity === "string"
        ? rec.entity
        : null;
  if (rawKind === null) return null;
  if (rawKind === "none") return { kind: "none", id: "" };
  if (typeof rec.id !== "string") return null;
  if (rawKind === "group") return { kind: "group", id: rec.id };
  if (isEntityKind(rawKind)) return { kind: rawKind, id: rec.id };
  return null;
}

/* ------------------------------------------------------------------ */
/* Read-only context graph                                             */
/* ------------------------------------------------------------------ */

/** A placeable network element (fluid node or solid node) in source coordinates. */
export interface ContextGraphNode {
  id: string;
  kind: "node" | "solidNode";
  /** Config label, falling back to the element id. */
  label: string;
  /** Source (config) coordinates — NOT pixels. */
  x: number;
  y: number;
  /** True when this node is the selected element itself. */
  focused: boolean;
  /** True when this node is included as one-hop context of the selection. */
  neighbor: boolean;
}

/** A branch or conductor edge; `from`/`to` always resolve to nodes of the graph. */
export interface ContextGraphEdge {
  id: string;
  kind: "branch" | "conductor";
  from: string;
  to: string;
  /** True when this edge is the selected element itself. */
  focused: boolean;
}

export interface ChannelContextGraph {
  /**
   * Stable display key of the focused element (`node:n1`, `branch:b1`,
   * `group:g1`, …; ids are user text so `kind:id` is for display, not
   * parsing).  Null when nothing in the captured config matches the
   * selection (unknown / result-only / unplaceable element, 'none').
   */
  focusedKey: string | null;
  /** Focused node(s) first, then one-hop neighbors in discovery order. */
  nodes: ContextGraphNode[];
  /** Branches then conductors, each in config order. */
  edges: ContextGraphEdge[];
}

interface PlacedElement {
  id: string;
  kind: "node" | "solidNode";
  label: string;
  x: number;
  y: number;
  group?: string;
}

interface EdgeElement {
  id: string;
  kind: "branch" | "conductor";
  from: string;
  to: string;
}

interface ConfigIndex {
  /** `${kind}:${id}` → placeable element (finite coordinates only). */
  points: Map<string, PlacedElement>;
  /** id → first placeable element; FLUID nodes take precedence on id collision. */
  byId: Map<string, PlacedElement>;
  branches: EdgeElement[];
  conductors: EdgeElement[];
}

/** Fresh empty graph (never shared, so callers may mutate the result). */
function emptyGraph(): ChannelContextGraph {
  return { focusedKey: null, nodes: [], edges: [] };
}

/** Pure read of the captured config; elements with non-finite x/y cannot be placed. */
function indexConfig(config: NetworkConfig | null | undefined): ConfigIndex {
  const points = new Map<string, PlacedElement>();
  const byId = new Map<string, PlacedElement>();
  const branches: EdgeElement[] = [];
  const conductors: EdgeElement[] = [];

  const addNode = (raw: unknown, kind: "node" | "solidNode"): void => {
    const rec = asRecord(raw);
    if (!rec) return;
    const { id, x, y } = rec;
    if (typeof id !== "string") return;
    if (typeof x !== "number" || !Number.isFinite(x)) return;
    if (typeof y !== "number" || !Number.isFinite(y)) return;
    if (points.has(`${kind}:${id}`)) return; // first wins on duplicate ids
    const label =
      typeof rec.label === "string" && rec.label.length > 0 ? rec.label : id;
    const el: PlacedElement = { id, kind, label, x, y };
    if (typeof rec.group === "string") el.group = rec.group;
    points.set(`${kind}:${id}`, el);
    if (!byId.has(id)) byId.set(id, el);
  };

  const addEdge = (
    raw: unknown,
    kind: "branch" | "conductor",
    seen: Set<string>,
  ): void => {
    const rec = asRecord(raw);
    if (!rec) return;
    const { id, from, to } = rec;
    if (
      typeof id !== "string" ||
      typeof from !== "string" ||
      typeof to !== "string"
    )
      return;
    if (seen.has(id)) return; // first wins on duplicate ids
    seen.add(id);
    (kind === "branch" ? branches : conductors).push({ id, kind, from, to });
  };

  if (Array.isArray(config?.nodes))
    for (const n of config.nodes) addNode(n, "node");
  if (Array.isArray(config?.solidNodes))
    for (const s of config.solidNodes) addNode(s, "solidNode");
  const seenBranch = new Set<string>();
  const seenConductor = new Set<string>();
  if (Array.isArray(config?.branches))
    for (const b of config.branches) addEdge(b, "branch", seenBranch);
  if (Array.isArray(config?.conductors))
    for (const c of config.conductors) addEdge(c, "conductor", seenConductor);
  return { points, byId, branches, conductors };
}

function toGraphNode(
  el: PlacedElement,
  focused: boolean,
  neighbor: boolean,
): ContextGraphNode {
  const node: ContextGraphNode = {
    id: el.id,
    kind: el.kind,
    label: el.label,
    x: el.x,
    y: el.y,
    focused,
    neighbor,
  };
  return node;
}

function toGraphEdge(e: EdgeElement, focused: boolean): ContextGraphEdge {
  return { id: e.id, kind: e.kind, from: e.from, to: e.to, focused };
}

/**
 * One-hop focus context of a selection, read only from the captured config:
 *
 *   - node / solidNode selection → the element (focused) plus every incident
 *     branch/conductor whose OTHER endpoint is also placeable, and those
 *     opposite endpoints (neighbor).  Conductors bridge fluid and solid
 *     nodes, so a fluid node can pull in a solid neighbor and vice versa.
 *   - branch / conductor selection → the edge (focused) plus BOTH endpoints
 *     (neighbor); an edge with an unplaceable endpoint yields an empty graph.
 *   - group selection → all member nodes (focused) plus edges with BOTH
 *     endpoints in the group (no one-hop expansion: a group is a set).
 *   - 'none' / unknown / result-only ids / dangling references → empty graph.
 *
 * Never throws, never mutates the config.
 */
export function buildContextGraph(
  config: NetworkConfig | null | undefined,
  selection: ContextSelection,
): ChannelContextGraph {
  try {
    const sel = normalizeSelection(selection);
    if (!sel || sel.kind === "none") return emptyGraph();
    const index = indexConfig(config);

    if (sel.kind === "group") {
      const members: PlacedElement[] = [];
      for (const el of index.points.values())
        if (el.group === sel.id) members.push(el);
      if (members.length === 0) return emptyGraph();
      const memberIds = new Set(members.map((m) => m.id));
      const edges: ContextGraphEdge[] = [];
      for (const e of [...index.branches, ...index.conductors]) {
        if (!memberIds.has(e.from) || !memberIds.has(e.to)) continue;
        if (!index.byId.has(e.from) || !index.byId.has(e.to)) continue;
        edges.push(toGraphEdge(e, false));
      }
      return {
        focusedKey: `group:${sel.id}`,
        nodes: members.map((m) => toGraphNode(m, true, false)),
        edges,
      };
    }

    if (sel.kind === "branch" || sel.kind === "conductor") {
      const table = sel.kind === "branch" ? index.branches : index.conductors;
      const edge = table.find((e) => e.id === sel.id);
      if (!edge) return emptyGraph();
      const a = index.byId.get(edge.from);
      const b = index.byId.get(edge.to);
      // Invariant: an edge is only renderable with both endpoints present.
      if (!a || !b) return emptyGraph();
      const nodes: ContextGraphNode[] = [toGraphNode(a, false, true)];
      if (b !== a) nodes.push(toGraphNode(b, false, true));
      return {
        focusedKey: `${sel.kind}:${sel.id}`,
        nodes,
        edges: [toGraphEdge(edge, true)],
      };
    }

    // node | solidNode selection
    const focus = index.points.get(`${sel.kind}:${sel.id}`);
    if (!focus) return emptyGraph();
    const nodes = new Map<string, ContextGraphNode>();
    nodes.set(`${focus.kind}:${focus.id}`, toGraphNode(focus, true, false));
    const edges: ContextGraphEdge[] = [];
    for (const e of [...index.branches, ...index.conductors]) {
      if (e.from !== sel.id && e.to !== sel.id) continue;
      const otherId = e.from === sel.id ? e.to : e.from;
      const other = index.byId.get(otherId);
      if (!other) continue; // dangling reference — edge is not renderable
      const key = `${other.kind}:${other.id}`;
      if (!nodes.has(key)) nodes.set(key, toGraphNode(other, false, true));
      edges.push(toGraphEdge(e, false));
    }
    return {
      focusedKey: `${sel.kind}:${sel.id}`,
      nodes: Array.from(nodes.values()),
      edges,
    };
  } catch {
    return emptyGraph();
  }
}

/**
 * The WHOLE placeable network as a context graph, for the Results view's path
 * schematic: every node with finite coordinates, and every branch/conductor
 * whose endpoints both resolve. Same invariant as buildContextGraph (no
 * dangling edges), same shape, so `layoutContextGraph` positions either.
 *
 * `focused` / `neighbor` are left false: which elements matter here is decided
 * by the caller's flow path, not by a selection.
 */
export function buildNetworkGraph(
  config: NetworkConfig | null | undefined,
): ChannelContextGraph {
  try {
    const index = indexConfig(config);
    const nodes: ContextGraphNode[] = [];
    for (const el of index.points.values())
      nodes.push(toGraphNode(el, false, false));
    const edges: ContextGraphEdge[] = [];
    for (const e of [...index.branches, ...index.conductors]) {
      if (!index.byId.has(e.from) || !index.byId.has(e.to)) continue;
      edges.push(toGraphEdge(e, false));
    }
    return { focusedKey: null, nodes, edges };
  } catch {
    return emptyGraph();
  }
}

/* ------------------------------------------------------------------ */
/* Normalized viewport / layout                                        */
/* ------------------------------------------------------------------ */

export interface ContextViewportOptions {
  /** Target SVG box width (px). Default 320. */
  width?: number;
  /** Target SVG box height (px). Default 240. */
  height?: number;
  /** Inner padding (px) kept free on every side. Default 24. */
  padding?: number;
}

export const DEFAULT_CONTEXT_VIEWPORT = {
  width: 320,
  height: 240,
  padding: 24,
} as const;

export interface NormalizedViewport {
  width: number;
  height: number;
  padding: number;
  /** Source-coordinate bounds of the finite input points (0 for empty input). */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Uniform source-unit → px scale factor (1 for degenerate inputs). */
  scale: number;
  /** Map a source coordinate into the SVG box. */
  project(x: number, y: number): { x: number; y: number };
}

function sanePositive(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Stable, pure source-x/y → SVG-box normalization: uniform scale (relative
 * geometry and aspect are preserved), centered on the axis with slack, with
 * `padding` kept free on every side.  Degenerate inputs never divide by
 * zero: a single point or identical coordinates are placed at the box
 * center with scale 1, and an empty/non-finite point set projects onto the
 * center.  Non-finite points are ignored.  Deterministic: same inputs →
 * same viewport.
 */
export function normalizeViewport(
  points: ReadonlyArray<{ x: number; y: number }>,
  opts: ContextViewportOptions = {},
): NormalizedViewport {
  const width = sanePositive(opts.width, DEFAULT_CONTEXT_VIEWPORT.width);
  const height = sanePositive(opts.height, DEFAULT_CONTEXT_VIEWPORT.height);
  let padding =
    typeof opts.padding === "number" &&
    Number.isFinite(opts.padding) &&
    opts.padding >= 0
      ? opts.padding
      : DEFAULT_CONTEXT_VIEWPORT.padding;
  // Keep at least 1 px of drawable span so padding never swallows the box.
  padding = Math.min(padding, (Math.min(width, height) - 1) / 2);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (const p of points) {
    if (!p || typeof p.x !== "number" || !Number.isFinite(p.x)) continue;
    if (typeof p.y !== "number" || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    count++;
  }
  if (count === 0) {
    minX = maxX = minY = maxY = 0;
  }
  const availW = Math.max(1, width - 2 * padding);
  const availH = Math.max(1, height - 2 * padding);
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const scale =
    spanX > 0 && spanY > 0
      ? Math.min(availW / spanX, availH / spanY)
      : spanX > 0
        ? availW / spanX
        : spanY > 0
          ? availH / spanY
          : 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    width,
    height,
    padding,
    minX,
    minY,
    maxX,
    maxY,
    scale,
    project: (x, y) => ({
      x: width / 2 + (x - cx) * scale,
      y: height / 2 + (y - cy) * scale,
    }),
  };
}

export interface LayoutedContextNode extends ContextGraphNode {
  /** Pixel coordinates inside the SVG box. */
  cx: number;
  cy: number;
}

export interface LayoutedContextGraph {
  focusedKey: string | null;
  /** SVG viewBox string, e.g. "0 0 320 240". */
  viewBox: string;
  width: number;
  height: number;
  /** Same order as the input graph's nodes. */
  nodes: LayoutedContextNode[];
  /** Same edge objects as the input graph (endpoints addressed by node id). */
  edges: ContextGraphEdge[];
}

/**
 * Position a context graph in an SVG box via normalizeViewport.  Pure: the
 * input graph (and the config it came from) is never mutated, node order is
 * preserved, and an empty/garbage graph yields an empty layout.
 */
export function layoutContextGraph(
  graph: ChannelContextGraph | null | undefined,
  opts: ContextViewportOptions = {},
): LayoutedContextGraph {
  try {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    const vp = normalizeViewport(nodes, opts);
    return {
      focusedKey:
        typeof graph?.focusedKey === "string" ? graph.focusedKey : null,
      viewBox: `0 0 ${vp.width} ${vp.height}`,
      width: vp.width,
      height: vp.height,
      nodes: nodes.map((n) => {
        const p = vp.project(n.x, n.y);
        return { ...n, cx: p.x, cy: p.y };
      }),
      edges: edges.slice(),
    };
  } catch {
    const vp = normalizeViewport([], opts);
    return {
      focusedKey: null,
      viewBox: `0 0 ${vp.width} ${vp.height}`,
      width: vp.width,
      height: vp.height,
      nodes: [],
      edges: [],
    };
  }
}

/* ------------------------------------------------------------------ */
/* CSV export                                                          */
/* ------------------------------------------------------------------ */

export interface ChannelCsvOptions {
  /** CAPTURED config snapshot (e.g. RunRecord.config) — the provenance source. */
  config: NetworkConfig;
  /** CAPTURED result the channels resolve against. */
  result: SteadyResult | TransientResult | null | undefined;
  /** Selected descriptors (from listChannels); input order is preserved. */
  channels: readonly ChannelDescriptor[];
  /**
   * Hash captured at run time (e.g. RunRecord.configHash).  When omitted the
   * FNV-1a hash of the supplied config is computed.  Supplying the captured
   * hash keeps provenance correct even if the config object was since reused.
   */
  configHash?: string;
  /** ISO timestamp override (defaults to now) — inject for deterministic output. */
  generatedAt?: string;
  /**
   * Optional unit preferences.  Absent ⇒ values are written as RAW SI solver
   * values with SI base-unit symbols (and the comments say so).  Channels
   * with a `rawUnit` are never converted.
   */
  units?: Partial<UnitPreferences>;
}

const csvTextCell = csvCell;
const commentSafe = csvCommentValue;

/**
 * Shortest round-trip formatting at 12 significant digits: exact for raw SI
 * solver values and trims IEEE conversion noise (300 K → '26.85', not
 * '26.850000000000023').  Non-finite values never reach the output.
 */
function csvNumber(v: number): string {
  if (!Number.isFinite(v)) return "";
  if (Object.is(v, -0)) return "0";
  return String(parseFloat(v.toPrecision(12)));
}

function sameNumberGrid(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Ascending union of every channel's (already non-finite-filtered) time grid.
 * Channels of one run share sample instants exactly, so plain numeric
 * identity is the right key: a channel that dropped a NaN sample simply
 * contributes no value at that instant rather than a shifted grid.
 */
function unionTimeGrid(grids: readonly (readonly number[])[]): number[] {
  const all = new Set<number>();
  for (const g of grids) for (const t of g) all.add(t);
  return [...all].sort((a, b) => a - b);
}

interface EffectiveUnit {
  symbol: string;
  convert: (v: number) => number;
}

/** Unit for one channel: rawUnit is never converted; otherwise pref or SI base. */
function effectiveUnit(
  d: ChannelDescriptor,
  units: Partial<UnitPreferences> | undefined,
): EffectiveUnit {
  if (typeof d.rawUnit === "string" && d.rawUnit.length > 0) {
    return { symbol: d.rawUnit, convert: (v) => v };
  }
  const pref = units?.[d.quantity];
  const id = typeof pref === "string" ? pref : getBaseUnit(d.quantity);
  const def = getUnitDef(d.quantity, id);
  return { symbol: def.symbol, convert: (v) => def.fromSI(v) };
}

const LONG_HEADER =
  "channel_key,entity_kind,entity_id,field,quantity,unit,time,value";
/** Steady sets have no time dimension — no empty column is written for one. */
const LONG_STEADY_HEADER =
  "channel_key,entity_kind,entity_id,field,quantity,unit,value";

/**
 * Deterministic CSV text for the selected channels resolved against the
 * captured result:
 *
 *   - WIDE format (`time (<unit>),<label> (<unit>)…`) whenever every
 *     resolved channel is a time series — mixed quantities and units
 *     included, since the unit rides in each column header.  Rows follow the
 *     ascending UNION of the channels' time grids, and a channel with no
 *     finite sample at an instant leaves that cell blank, so the file opens
 *     as a plottable table instead of one stacked value column.
 *   - LONG format (one row per channel/sample) only where no time column can
 *     be shared: a steady set (scalars, no time column at all) or the
 *     defensive scalar/series mix.
 *   - Provenance comments come from the CAPTURED config (and the optionally
 *     supplied captured hash), never from any live state.
 *   - Labels/ids/free text pass an Excel formula-injection guard and
 *     RFC-4180 quoting; only finite values are written (resolution already
 *     drops non-finite samples; unresolvable channels are reported in
 *     `# skipped=<key>` comments); channel order follows the input.
 *
 * Never throws; returns '' only when the inputs are fundamentally unusable.
 */
export function buildChannelsCsv(opts: ChannelCsvOptions): string {
  try {
    const config = opts.config;
    const result = opts.result;
    const input = Array.isArray(opts.channels) ? opts.channels : [];

    // Dedupe by channel key (first wins), then resolve against the result.
    const seen = new Set<string>();
    const resolved: Array<{
      d: ChannelDescriptor;
      data: NonNullable<ReturnType<typeof resolveChannel>>;
      unit: EffectiveUnit;
    }> = [];
    const skipped: string[] = [];
    for (const d of input) {
      if (!d || typeof d.key !== "string") continue;
      if (seen.has(d.key)) continue;
      seen.add(d.key);
      const data = resolveChannel(result, d.channel);
      if (!data) {
        skipped.push(d.key);
        continue;
      }
      resolved.push({ d, data, unit: effectiveUnit(d, opts.units) });
    }

    const seriesCount = resolved.filter((r) => r.data.kind === "series").length;
    const wide = resolved.length > 0 && seriesCount === resolved.length;
    // A steady set carries no time at all; a scalar/series mix (and the
    // resolved-nothing case) keeps the long format's per-row time cell.
    const steadyLong = !wide && resolved.length > 0 && seriesCount === 0;
    const homogeneous =
      wide &&
      new Set(resolved.map((r) => r.d.quantity)).size === 1 &&
      new Set(resolved.map((r) => r.unit.symbol)).size === 1;
    const times = wide
      ? unionTimeGrid(
          resolved.map((r) => (r.data as { times: number[] }).times),
        )
      : [];
    const ragged =
      wide &&
      !resolved.every((r) =>
        sameNumberGrid((r.data as { times: number[] }).times, times),
      );

    const timePref = opts.units?.time;
    const timeDef = getUnitDef(
      "time",
      typeof timePref === "string" ? timePref : getBaseUnit("time"),
    );
    const timeUnit: EffectiveUnit = {
      symbol: timeDef.symbol,
      convert: (v) => timeDef.fromSI(v),
    };

    const converted =
      opts.units !== undefined && Object.keys(opts.units).length > 0;
    const lines: string[] = [];
    const metaName = asRecord(config?.meta)?.name;
    lines.push(
      `# model=${commentSafe(typeof metaName === "string" ? metaName : "")}`,
    );
    lines.push(
      `# generated=${commentSafe(typeof opts.generatedAt === "string" ? opts.generatedAt : new Date().toISOString())}`,
    );
    const mode = config?.settings?.mode;
    lines.push(
      `# mode=${mode === "steady" || mode === "transient" ? mode : "unknown"}`,
    );
    if (asRecord(config?.settings))
      lines.push(`# settings=${commentSafe(settingsSummary(config))}`);
    lines.push(
      `# config_hash=${typeof opts.configHash === "string" ? opts.configHash : configHash(config)}`,
    );
    lines.push(
      converted
        ? "# units=converted from SI per supplied unit preferences"
        : "# units=SI (raw solver values, no conversion applied)",
    );
    const rawCount = resolved.filter(
      (r) => typeof r.d.rawUnit === "string",
    ).length;
    if (rawCount > 0) {
      lines.push(
        `# raw_units=${rawCount} channel(s) carry raw SI units (rawUnit) and are never converted`,
      );
    }
    lines.push(`# format=${wide ? "wide" : "long"}`);
    if (wide) {
      if (homogeneous) {
        lines.push(`# quantity=${resolved[0].d.quantity}`);
        lines.push(`# unit=${resolved[0].unit.symbol}`);
      }
      lines.push(`# time_unit=${timeUnit.symbol}`);
      if (ragged) {
        lines.push(
          "# gaps=blank cell = no finite sample for that channel at that time",
        );
      }
    }
    for (const key of skipped) lines.push(`# skipped=${key}`);

    const rows: string[] = [];
    if (wide) {
      // Units ride in the column headers, so channels of different
      // quantities share one time axis without losing their identity.
      rows.push(
        [
          csvTextCell(`time (${timeUnit.symbol})`),
          ...resolved.map((r) =>
            csvTextCell(`${r.d.label} (${r.unit.symbol})`),
          ),
        ].join(","),
      );
      const byTime = resolved.map((r) => {
        const { times: ts, values } = r.data as {
          times: number[];
          values: number[];
        };
        const m = new Map<number, number>();
        for (let i = 0; i < ts.length; i++) m.set(ts[i], values[i]);
        return m;
      });
      for (const t of times) {
        const cells = [csvNumber(timeUnit.convert(t))];
        for (let c = 0; c < resolved.length; c++) {
          const v = byTime[c].get(t);
          cells.push(
            v === undefined ? "" : csvNumber(resolved[c].unit.convert(v)),
          );
        }
        rows.push(cells.join(","));
      }
    } else {
      rows.push(steadyLong ? LONG_STEADY_HEADER : LONG_HEADER);
      for (const r of resolved) {
        const head = [
          csvTextCell(r.d.key),
          csvTextCell(r.d.channel.entity),
          csvTextCell(r.d.channel.id),
          csvTextCell(String(r.d.channel.field)),
          csvTextCell(r.d.quantity),
          csvTextCell(r.unit.symbol),
        ].join(",");
        if (r.data.kind === "scalar") {
          const value = csvNumber(r.unit.convert(r.data.value));
          rows.push(steadyLong ? `${head},${value}` : `${head},,${value}`);
        } else {
          for (let i = 0; i < r.data.times.length; i++) {
            rows.push(
              `${head},${csvNumber(timeUnit.convert(r.data.times[i]))},${csvNumber(r.unit.convert(r.data.values[i]))}`,
            );
          }
        }
      }
    }
    return [...lines, ...rows].join("\n") + "\n";
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* Export filename                                                     */
/* ------------------------------------------------------------------ */

/** Filesystem-safe name fragment: keeps [A-Za-z0-9._-], '-'-runs collapsed, ≤ 48 chars. */
function sanitizeFilenamePart(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "");
  return cleaned.length > 48
    ? cleaned.slice(0, 48).replace(/[.-]+$/, "")
    : cleaned;
}

/** `view` = displayed channel set; `all` = full result inventory. */
export type ChannelsExportKind = "view" | "all";

/**
 * Safe export filename from the CAPTURED model name and the channel count,
 * e.g. `ctx-fixture-channels-3.csv` (view) or `ctx-fixture-all-channels-12.csv`
 * (`kind: 'all'`).  Unsafe characters become '-', empty / all-unsafe names
 * fall back to `network`, and the count is floored and clamped at ≥ 0.
 * Pure and deterministic.
 */
export function channelsExportFilename(
  config: NetworkConfig | null | undefined,
  channelCount: number,
  kind: ChannelsExportKind = "view",
): string {
  const raw = asRecord(config?.meta)?.name;
  const base =
    sanitizeFilenamePart(typeof raw === "string" ? raw : "") || "network";
  const n =
    typeof channelCount === "number" && Number.isFinite(channelCount)
      ? Math.max(0, Math.floor(channelCount))
      : 0;
  const suffix = kind === "all" ? "all-channels" : "channels";
  return `${base}-${suffix}-${n}.csv`;
}
