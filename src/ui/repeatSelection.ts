/**
 * repeatSelection — pure derivation of the repeat "unit" (member node ids +
 * seam branch) from the current UI selection.  Shared by the store's
 * repeatSelection action and by UI that needs to enable/disable a Repeat
 * button without duplicating the seam/exit derivation logic.  No React, no
 * zustand: everything here is a plain function of (config, selection).
 */
import type { NetworkConfig, RepeatMembers } from "../core";
import { analyzeRepeatUnit, previewNetworkParameters } from "../core";
import type { Selection } from "./types";
import { formatSig } from "./format";
import { segmentFormula } from "./formulaTokens";
import {
  CANVAS_GRID_SIZE,
  SOLID_NODE_SIZE,
  fluidNodeSize,
  snapPointToGrid,
} from "./canvasGeometry";

/** Created-entity counts returned by the repeat / split store actions. */
export interface RepeatCounts {
  nodes: number;
  solidNodes: number;
  branches: number;
  conductors: number;
}

/** What the current selection contributes to a repeat. */
export interface RepeatSelection {
  /** Member fluid + solid node ids. */
  members: RepeatMembers;
  /**
   * Selected branch ids.  `canvasSelection` carries node ids only, so a
   * branch can accompany nodes only through a `multi` panel selection —
   * that is how the user disambiguates the seam when several branches
   * enter the unit.
   */
  selectedBranches: string[];
}

/**
 * Derive the repeat unit from the selection.  Node members come from the
 * canvas selection, falling back to a single panel-selected node, then to a
 * `multi` selection's node items (which duplicateSelection ignores).  Branch
 * ids are collected alongside for seam disambiguation.
 */
export function repeatMembersFromSelection(
  config: NetworkConfig,
  selection: Selection,
  canvasSelection: string[],
): RepeatSelection {
  const nodeIdSet = new Set(config.nodes.map((n) => n.id));
  const solidIdSet = new Set((config.solidNodes ?? []).map((n) => n.id));
  const selectedBranches: string[] = [];
  if (selection.kind === "multi") {
    for (const item of selection.items) {
      if (item.kind === "branch") selectedBranches.push(item.id);
    }
  }
  const members: RepeatMembers = { nodes: [], solidNodes: [] };
  const fromCanvas = canvasSelection.filter(
    (id) => nodeIdSet.has(id) || solidIdSet.has(id),
  );
  if (fromCanvas.length > 0) {
    members.nodes = fromCanvas.filter((id) => nodeIdSet.has(id));
    members.solidNodes = fromCanvas.filter((id) => solidIdSet.has(id));
  } else if (selection.kind === "node" && nodeIdSet.has(selection.id)) {
    members.nodes = [selection.id];
  } else if (selection.kind === "solidNode" && solidIdSet.has(selection.id)) {
    members.solidNodes = [selection.id];
  } else if (selection.kind === "multi") {
    for (const item of selection.items) {
      if (item.kind === "node" && nodeIdSet.has(item.id)) {
        members.nodes.push(item.id);
      } else if (item.kind === "solidNode" && solidIdSet.has(item.id)) {
        members.solidNodes.push(item.id);
      }
    }
  }
  return { members, selectedBranches };
}

/** Button-state analysis for a would-be repeat of the current selection. */
export interface Repeatability {
  canRepeat: boolean;
  /** The resolved seam: a selected entry branch when exactly one is in the
   *  selection, else the derived single entry crossing. */
  seamBranch: string | null;
  /** Why a repeat is not possible (absent when `canRepeat`). */
  reason?: string;
  /** The derived unit (empty when the selection holds no nodes). */
  members: RepeatMembers;
}

/**
 * Run analyzeRepeatUnit against the current selection and fold the result
 * into a single canRepeat/seamBranch/reason triple, so a Repeat button can
 * be enabled/disabled and a dialog can pre-fill the seam without
 * re-implementing the derivation.
 */
export function analyzeRepeatSelection(
  config: NetworkConfig,
  selection: Selection,
  canvasSelection: string[],
): Repeatability {
  const { members, selectedBranches } = repeatMembersFromSelection(
    config,
    selection,
    canvasSelection,
  );
  const no = (
    reason: string,
    seamBranch: string | null = null,
  ): Repeatability => ({ canRepeat: false, seamBranch, reason, members });
  if (members.nodes.length + members.solidNodes.length === 0) {
    return no("select the nodes of the unit to repeat");
  }
  const analysis = analyzeRepeatUnit(config, members);
  if (!analysis.ok) return no(analysis.error);
  // An explicitly selected entry branch disambiguates the seam.
  const explicit = selectedBranches.filter((id) =>
    analysis.entryCrossings.includes(id),
  );
  if (explicit.length > 1) {
    return no(
      `multiple selected branches enter the unit: ${explicit.join(", ")}`,
    );
  }
  const seamBranch = explicit.length === 1 ? explicit[0]! : analysis.seamBranch;
  if (seamBranch === null) {
    return no(analysis.seamError ?? "no seam branch could be derived");
  }
  if (analysis.exitNode === null) {
    return no(
      analysis.exitError ?? "cannot determine the unit's exit node",
      seamBranch,
    );
  }
  return { canRepeat: true, seamBranch, members };
}

/**
 * "1 node, 2 branches" fragment for the repeat/split screen-reader notices.
 * Fluid and solid nodes are announced separately (both can be created).
 */
export function formatRepeatCounts(counts: RepeatCounts): string {
  const parts: string[] = [];
  if (counts.nodes > 0)
    parts.push(`${counts.nodes} node${counts.nodes === 1 ? "" : "s"}`);
  if (counts.solidNodes > 0)
    parts.push(
      `${counts.solidNodes} solid node${counts.solidNodes === 1 ? "" : "s"}`,
    );
  if (counts.branches > 0)
    parts.push(`${counts.branches} branch${counts.branches === 1 ? "" : "es"}`);
  if (counts.conductors > 0)
    parts.push(
      `${counts.conductors} conductor${counts.conductors === 1 ? "" : "s"}`,
    );
  return parts.join(", ");
}

/**
 * Restore the legacy Duplicate label convention — "<label or id> copy" — on
 * the entities repeatUnit created, whose own label rule remaps member ids /
 * bumps trailing integers instead (right for Repeat-N, surprising for
 * Duplicate).  Mutates `after` (the fresh, not-yet-committed clone).
 *
 * The correspondence is positional and guaranteed by repeatUnit: with
 * count: 2 there is exactly one generated instance, whose created lists are
 * parallel to `members` and to the analysis's induced-branch/conductor
 * lists (Duplicate has no seam clone and drops crossings).
 */
export function applyDuplicateCopyLabels(
  before: NetworkConfig,
  after: NetworkConfig,
  members: RepeatMembers,
  analysis: { inducedBranches: string[]; inducedConductors: string[] },
  created: {
    nodes: string[];
    solidNodes: string[];
    branches: string[];
    conductors: string[];
  },
): void {
  const copyLabel = (orig: { id: string; label?: string }) =>
    `${orig.label || orig.id} copy`;
  const nodeById = new Map(after.nodes.map((n) => [n.id, n]));
  const solidById = new Map((after.solidNodes ?? []).map((s) => [s.id, s]));
  const branchById = new Map(after.branches.map((b) => [b.id, b]));
  const conductorById = new Map((after.conductors ?? []).map((c) => [c.id, c]));
  const origNode = new Map(before.nodes.map((n) => [n.id, n]));
  const origSolid = new Map((before.solidNodes ?? []).map((s) => [s.id, s]));
  const origBranch = new Map(before.branches.map((b) => [b.id, b]));
  const origConductor = new Map(
    (before.conductors ?? []).map((c) => [c.id, c]),
  );
  members.nodes.forEach((id, k) => {
    const clone = nodeById.get(created.nodes[k]!);
    const orig = origNode.get(id);
    if (clone && orig) clone.label = copyLabel(orig);
  });
  members.solidNodes.forEach((id, k) => {
    const clone = solidById.get(created.solidNodes[k]!);
    const orig = origSolid.get(id);
    if (clone && orig) clone.label = copyLabel(orig);
  });
  analysis.inducedBranches.forEach((id, k) => {
    const clone = branchById.get(created.branches[k]!);
    const orig = origBranch.get(id);
    if (clone && orig) clone.label = copyLabel(orig);
  });
  analysis.inducedConductors.forEach((id, k) => {
    const clone = conductorById.get(created.conductors[k]!);
    const orig = origConductor.get(id);
    if (clone && orig) clone.label = copyLabel(orig);
  });
}

/* ------------------------------------------------------------------ */
/* Repeat-dialog derivations (Phase 4a)                                */
/*                                                                     */
/* Pure helpers behind RepeatDialog: count validation, the derived     */
/* canvas/physical spacing defaults, the live summary text, and the    */
/* final argument object handed to the store's repeatSelection.        */
/* ------------------------------------------------------------------ */

/** Count-field bounds: TOTAL instances, original included (core semantics). */
export const REPEAT_COUNT_MIN = 2;
export const REPEAT_COUNT_MAX = 200;

export type RepeatCountParse =
  { ok: true; value: number } | { ok: false; error: string };

/**
 * Message wording for the shared count validator, so Repeat ("total
 * instances") and Split ("segments") reuse one parse with field-appropriate
 * copy.  `noun` is lower-case and capitalized at sentence starts;
 * `minDetail` is the clause appended to the minimum message.
 */
export interface CountWording {
  empty: string;
  noun: string;
  verb: string;
  minDetail: string;
}

const REPEAT_COUNT_WORDING: CountWording = {
  empty: "Enter the total number of instances.",
  noun: "total instances",
  verb: "Repeat",
  minDetail: " (the original plus one copy)",
};

/** The split section's count is the TOTAL segment count, original included. */
export const SPLIT_COUNT_WORDING: CountWording = {
  empty: "Enter the number of segments.",
  noun: "segments",
  verb: "Split",
  minDetail: "",
};

/** Validate a count field (a string, as typed) against the shared bounds. */
export function parseCount(
  raw: string,
  wording: CountWording,
): RepeatCountParse {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, error: wording.empty };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    const noun = wording.noun.charAt(0).toUpperCase() + wording.noun.slice(1);
    return {
      ok: false,
      error: `${noun} must be an integer (got "${trimmed}").`,
    };
  }
  if (value < REPEAT_COUNT_MIN) {
    return {
      ok: false,
      error: `${wording.verb} needs at least ${REPEAT_COUNT_MIN} ${wording.noun}${wording.minDetail}.`,
    };
  }
  if (value > REPEAT_COUNT_MAX) {
    return {
      ok: false,
      error: `${wording.verb} is limited to ${REPEAT_COUNT_MAX} ${wording.noun} (got ${value}).`,
    };
  }
  return { ok: true, value };
}

/** Validate the dialog's count field (a string, as typed). */
export function parseRepeatCount(raw: string): RepeatCountParse {
  return parseCount(raw, REPEAT_COUNT_WORDING);
}

/**
 * What ONE additional instance creates (the repeat creates count − 1 of
 * these).  Branches include the per-instance seam clone; conductors include
 * the crossing conductors cloned "share"-style, matching the store action's
 * `crossingConductors: "share"` call.  Null when the selection cannot
 * repeat (or the unit analysis fails) — the dialog then shows no summary.
 */
export function perInstanceRepeatCounts(
  config: NetworkConfig,
  repeatability: Repeatability,
): RepeatCounts | null {
  if (!repeatability.canRepeat) return null;
  const analysis = analyzeRepeatUnit(config, repeatability.members);
  if (!analysis.ok) return null;
  return {
    nodes: repeatability.members.nodes.length,
    solidNodes: repeatability.members.solidNodes.length,
    branches: analysis.inducedBranches.length + 1,
    conductors:
      analysis.inducedConductors.length + analysis.crossingConductors.length,
  };
}

/** Live summary line: "Creates 19 more instances: 19 nodes, 19 branches." */
export function repeatSummaryText(
  count: number,
  perInstance: RepeatCounts,
): string {
  const extra = Math.max(0, count - 1);
  const scaled: RepeatCounts = {
    nodes: perInstance.nodes * extra,
    solidNodes: perInstance.solidNodes * extra,
    branches: perInstance.branches * extra,
    conductors: perInstance.conductors * extra,
  };
  return `Creates ${extra} more instance${extra === 1 ? "" : "s"}: ${formatRepeatCounts(scaled)}.`;
}

export interface RepeatSpacingDefaults {
  canvasOffset: { x: number; y: number };
  physicalOffset: { x: number; y: number; z: number };
}

/** Gap left between tiled instances by the bbox fallback — two grid cells,
 *  the same 30 px the store's duplicate fallback uses. */
const TILE_GAP = 2 * CANVAS_GRID_SIZE;

/** Rendered width of the member-node bounding box (null when no members). */
function memberBoundsWidth(
  config: NetworkConfig,
  members: RepeatMembers,
): number | null {
  let minX = Infinity;
  let maxRight = -Infinity;
  for (const id of members.nodes) {
    const n = config.nodes.find((node) => node.id === id);
    if (!n) continue;
    minX = Math.min(minX, n.x);
    maxRight = Math.max(maxRight, n.x + fluidNodeSize(n.type));
  }
  for (const id of members.solidNodes) {
    const n = (config.solidNodes ?? []).find((node) => node.id === id);
    if (!n) continue;
    minX = Math.min(minX, n.x);
    maxRight = Math.max(maxRight, n.x + SOLID_NODE_SIZE);
  }
  return minX === Infinity ? null : maxRight - minX;
}

/**
 * Default per-instance canvas translation.  Preferred: the pitch that maps
 * the seam's external endpoint onto the unit's exit node, so every cloned
 * seam branch spans the same canvas distance as the original and the chain
 * reads as one continuous run — for a one-node unit the exit IS the seam's
 * target, so this reduces to the seam's own endpoint delta.  Fallback: the
 * member bounding box plus a gap.  Either way the offset is snapped to the
 * canvas grid (never snapped down into the bbox: the gap is two full grid
 * cells, larger than the worst-case half-cell rounding loss).
 */
function defaultCanvasOffset(
  config: NetworkConfig,
  repeatability: Repeatability,
): { x: number; y: number } {
  const seam = repeatability.seamBranch
    ? config.branches.find((b) => b.id === repeatability.seamBranch)
    : undefined;
  if (seam && repeatability.canRepeat) {
    const analysis = analyzeRepeatUnit(config, repeatability.members);
    const from = config.nodes.find((n) => n.id === seam.from);
    const exit =
      analysis.ok && analysis.exitNode
        ? config.nodes.find((n) => n.id === analysis.exitNode)
        : undefined;
    if (from && exit) {
      const pitch = { x: exit.x - from.x, y: exit.y - from.y };
      if (pitch.x !== 0 || pitch.y !== 0) {
        const snapped = snapPointToGrid(pitch);
        // A sub-grid pitch must not collapse to a zero offset (instances
        // would stack exactly in place); keep the exact delta then.
        return snapped.x === 0 && snapped.y === 0 ? pitch : snapped;
      }
    }
  }
  const width = memberBoundsWidth(config, repeatability.members);
  if (width !== null) return snapPointToGrid({ x: width + TILE_GAP, y: 0 });
  return { x: TILE_GAP, y: 0 };
}

/**
 * Default per-instance physical translation: the seam pipe's RESOLVED
 * length along +x (a `{ expr }` length is evaluated against the static
 * model scope rather than read as a literal) so a discretized pipe run
 * lands end-to-end in the hydrostatics/3D layout.  Zero when the seam is
 * not a pipe/heatedPipe or its length does not resolve to a finite number
 * (including a model whose other expressions fail to resolve).
 */
function defaultPhysicalOffset(
  config: NetworkConfig,
  seamBranch: string | null,
): { x: number; y: number; z: number } {
  const zero = { x: 0, y: 0, z: 0 };
  if (!seamBranch) return zero;
  const length = resolvedBranchLength(config, seamBranch);
  return length === null ? zero : { x: length, y: 0, z: 0 };
}

/** The dialog's initial canvas + physical spacing fields. */
export function deriveRepeatDefaults(
  config: NetworkConfig,
  repeatability: Repeatability,
): RepeatSpacingDefaults {
  return {
    canvasOffset: defaultCanvasOffset(config, repeatability),
    physicalOffset: defaultPhysicalOffset(config, repeatability.seamBranch),
  };
}

/** Raw field strings behind the Repeat dialog (inputs stay text while typing). */
export interface RepeatDraft {
  count: string;
  linkParams: boolean;
  canvasX: string;
  canvasY: string;
  physX: string;
  physY: string;
  physZ: string;
}

/** Parsed, typed arguments for the store's repeatSelection action. */
export interface RepeatArgs {
  count: number;
  linkParams: boolean;
  canvasOffset: { x: number; y: number };
  physicalOffset: { x: number; y: number; z: number };
}

export type RepeatArgsBuild =
  { ok: true; args: RepeatArgs } | { ok: false; error: string };

/** A spacing field: blank is `blank` (physical fields treat blank as 0),
 *  otherwise a finite number is required. */
function parseSpacingField(raw: string, blank: number | null): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return blank;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Fold the dialog's raw fields into repeatSelection arguments.  The confirm
 * button is enabled exactly when this returns ok (and the selection can
 * repeat), so the store action never sees an invalid draft.
 */
export function buildRepeatArgs(draft: RepeatDraft): RepeatArgsBuild {
  const count = parseRepeatCount(draft.count);
  if (!count.ok) return count;
  const canvasX = parseSpacingField(draft.canvasX, null);
  const canvasY = parseSpacingField(draft.canvasY, null);
  if (canvasX === null || canvasY === null) {
    return {
      ok: false,
      error: "Canvas spacing needs a finite number for both x and y.",
    };
  }
  const physX = parseSpacingField(draft.physX, 0);
  const physY = parseSpacingField(draft.physY, 0);
  const physZ = parseSpacingField(draft.physZ, 0);
  if (physX === null || physY === null || physZ === null) {
    return {
      ok: false,
      error: "Physical spacing fields need numbers (or blank for 0).",
    };
  }
  return {
    ok: true,
    args: {
      count: count.value,
      linkParams: draft.linkParams,
      canvasOffset: { x: canvasX, y: canvasY },
      physicalOffset: { x: physX, y: physY, z: physZ },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Split-pipe section derivations (Phase 4b)                           */
/*                                                                     */
/* Pure helpers behind the property panel's inline "Split into N       */
/* segments" section: eligibility, the RESOLVED branch length behind   */
/* the live summary, the summary text itself, and the final argument   */
/* object handed to the store's splitBranch.                           */
/* ------------------------------------------------------------------ */

/**
 * Split eligibility by component type — mirrors the gate in core
 * splitPipeBranch so the panel shows the section exactly when the store
 * action could accept it.
 */
export function isSplittableComponentType(type: string): boolean {
  return type === "pipe" || type === "heatedPipe";
}

/** Validate the split section's segment-count field (a string, as typed). */
export function parseSplitCount(raw: string): RepeatCountParse {
  return parseCount(raw, SPLIT_COUNT_WORDING);
}

/**
 * The branch's RESOLVED length: an `{ expr }` length is evaluated against
 * the static model scope (the same previewNetworkParameters route the
 * repeat dialog's physical-offset default uses), never read as a raw
 * literal.  Null when the branch is not a pipe/heatedPipe or the length
 * does not resolve to a finite positive number (a broken expression, or an
 * unrelated binding elsewhere failing the model-wide resolution) — callers
 * degrade gracefully rather than show a NaN.
 */
export function resolvedBranchLength(
  config: NetworkConfig,
  branchId: string,
): number | null {
  const branch = config.branches.find((b) => b.id === branchId);
  if (!branch || !isSplittableComponentType(branch.component.type)) {
    return null;
  }
  const resolution = previewNetworkParameters(config);
  if (!resolution.ok) return null;
  const resolved = resolution.config.branches.find((b) => b.id === branchId);
  if (
    !resolved ||
    (resolved.component.type !== "pipe" &&
      resolved.component.type !== "heatedPipe")
  ) {
    return null;
  }
  const length = resolved.component.length;
  return Number.isFinite(length) && length > 0 ? length : null;
}

/**
 * Live summary for the split section: "Creates 9 new nodes and 9 new pipes;
 * each segment 0.305 m."  A split into N segments inserts N−1 internal
 * nodes and N−1 seam pipes (the original branch survives as the last
 * segment).  The per-segment clause is omitted when `totalLength` is null —
 * the length could not be resolved — so the text never carries a NaN.
 */
export function splitSummaryText(
  segments: number,
  totalLength: number | null,
): string {
  const extra = Math.max(0, segments - 1);
  const nodes = `${extra} new node${extra === 1 ? "" : "s"}`;
  const pipes = `${extra} new pipe${extra === 1 ? "" : "s"}`;
  const perSegment =
    totalLength !== null && Number.isFinite(totalLength) && segments > 0
      ? `; each segment ${formatSig(totalLength / segments)} m`
      : "";
  return `Creates ${nodes} and ${pipes}${perSegment}.`;
}

/** Raw fields behind the split section (the input stays text while typing). */
export interface SplitDraft {
  segments: string;
  linkParams: boolean;
}

/** Parsed, typed arguments for the store's splitBranch action. */
export interface SplitArgs {
  segments: number;
  linkParams: boolean;
}

export type SplitArgsBuild =
  { ok: true; args: SplitArgs } | { ok: false; error: string };

/**
 * Fold the section's raw fields into splitBranch arguments.  The apply
 * button is enabled exactly when this returns ok, so the store action never
 * sees an invalid draft (same contract as buildRepeatArgs).
 */
export function buildSplitArgs(draft: SplitDraft): SplitArgsBuild {
  const segments = parseSplitCount(draft.segments);
  if (!segments.ok) return segments;
  return {
    ok: true,
    args: { segments: segments.value, linkParams: draft.linkParams },
  };
}

/* ------------------------------------------------------------------ */
/* Uncloned-record detection (the "not copied" warnings)               */
/*                                                                     */
/* repeatUnit clones nodes, solid nodes, branches and conductors ONLY:  */
/* controllers, junctions and logic rules are top-level records keyed   */
/* by id and are never cloned or retargeted (user manual §3.13).  A     */
/* repeat of a unit one of them references therefore produces           */
/* UNCONTROLLED copies (and a copied reacting-junction node is a plain  */
/* internal node).  These helpers detect that situation so the Repeat   */
/* dialog and the split section can warn exactly when it applies,       */
/* rather than carrying a permanent scary notice.                       */
/* ------------------------------------------------------------------ */

/** One top-level record that references the unit but is never cloned. */
export interface UnclonedReference {
  /** Which kind of top-level record holds the reference. */
  source: "controller" | "junction" | "logic rule";
  /** Id of the controller / junction / logic rule. */
  id: string;
  /** The unit entity ids it references, deduplicated in encounter order. */
  targets: string[];
}

/**
 * The ids a repeat would clone: member fluid + solid nodes, the unit's
 * induced branches/conductors, the shared crossing conductors, and the seam
 * branch itself.  Empty id lists (and no seam) when the selection cannot
 * repeat — the dialog then shows the reason instead of a warning.
 */
export function repeatUnitReferenceIds(
  config: NetworkConfig,
  repeatability: Repeatability,
): { nodes: string[]; branches: string[]; conductors: string[] } {
  const none = { nodes: [], branches: [], conductors: [] };
  if (!repeatability.canRepeat) return none;
  const analysis = analyzeRepeatUnit(config, repeatability.members);
  if (!analysis.ok) return none;
  return {
    nodes: [
      ...repeatability.members.nodes,
      ...repeatability.members.solidNodes,
    ],
    branches: [
      ...analysis.inducedBranches,
      ...(repeatability.seamBranch ? [repeatability.seamBranch] : []),
    ],
    conductors: [...analysis.inducedConductors, ...analysis.crossingConductors],
  };
}

/**
 * Find the controllers, junctions and logic rules that reference any of the
 * given unit ids — the records repeatUnit will NOT clone (docs §3.13).
 * `nodes` covers fluid AND solid node ids (a controller's heatInput output
 * may target either); `branches` the unit's branch ids; `conductors` its
 * conductor ids (reachable only from logic-rule expressions).
 *
 * Controllers and junctions reference entities by typed id fields.  Logic
 * rules carry expression STRINGS, which are scanned with the tolerant
 * formula segmenter (ui/formulaTokens): only syntactically complete
 * accessor references match, `reg('…')` register reads never do, and a
 * malformed expression simply yields no reference.  Pure; never throws.
 */
export function unclonedUnitReferences(
  config: NetworkConfig,
  unit: {
    nodes: readonly string[];
    branches: readonly string[];
    conductors?: readonly string[];
  },
): UnclonedReference[] {
  const nodeIds = new Set(unit.nodes);
  const branchIds = new Set(unit.branches);
  const conductorIds = new Set(unit.conductors ?? []);
  const refs: UnclonedReference[] = [];
  const push = (
    source: UnclonedReference["source"],
    id: string,
    targets: string[],
  ) => {
    if (targets.length > 0) refs.push({ source, id, targets });
  };

  for (const ctrl of config.controllers ?? []) {
    const targets: string[] = [];
    const note = (id: string, isNode: boolean) => {
      if ((isNode ? nodeIds : branchIds).has(id) && !targets.includes(id)) {
        targets.push(id);
      }
    };
    // A PID senses a node quantity or a branch mass flow…
    if (ctrl.type === "pid") note(ctrl.sense.id, ctrl.sense.kind === "node");
    // …and either kind actuates a valve/flowSource branch (valvePosition,
    // flowRate) or a fluid/solid node (boundaryPressure,
    // boundaryTemperature, heatInput).
    const out = ctrl.output;
    note(out.id, out.kind !== "valvePosition" && out.kind !== "flowRate");
    push("controller", ctrl.id, targets);
  }

  for (const junction of config.junctions ?? []) {
    const targets: string[] = [];
    if (nodeIds.has(junction.node)) targets.push(junction.node);
    for (const inlet of junction.inlets) {
      if (branchIds.has(inlet.branch) && !targets.includes(inlet.branch)) {
        targets.push(inlet.branch);
      }
    }
    push("junction", junction.id, targets);
  }

  for (const rule of config.logic ?? []) {
    const targets: string[] = [];
    const scan = (source: string) => {
      for (const seg of segmentFormula(source)) {
        if (seg.type !== "chip" || seg.chip.accessor === "reg") continue;
        const { accessor, id } = seg.chip;
        const inUnit =
          accessor === "conductor"
            ? conductorIds.has(id)
            : accessor === "node" || accessor === "solid"
              ? nodeIds.has(id)
              : branchIds.has(id);
        if (inUnit && !targets.includes(id)) targets.push(id);
      }
    };
    scan(rule.when);
    for (const value of Object.values(rule.set ?? {})) scan(value);
    push("logic rule", rule.id, targets);
  }

  return refs;
}

/** `label ?? id` of an entity, for warning text that names what is hit. */
function entityDisplayName(config: NetworkConfig, id: string): string {
  const found =
    config.nodes.find((n) => n.id === id) ??
    (config.solidNodes ?? []).find((s) => s.id === id) ??
    config.branches.find((b) => b.id === id) ??
    (config.conductors ?? []).find((c) => c.id === id);
  return found?.label ?? id;
}

/**
 * The Repeat dialog's warning sentences, one per referencing record —
 * e.g. "Controller pid1 references Segment 1 and will not be copied — the
 * new instances will be uncontrolled."  Empty when nothing applies.
 */
export function repeatUnclonedWarnings(
  config: NetworkConfig,
  repeatability: Repeatability,
): string[] {
  const refs = unclonedUnitReferences(
    config,
    repeatUnitReferenceIds(config, repeatability),
  );
  return refs.map((ref) => {
    const targets = ref.targets
      .map((id) => entityDisplayName(config, id))
      .join(", ");
    if (ref.source === "controller") {
      return `Controller ${ref.id} references ${targets} and will not be copied — the new instances will be uncontrolled.`;
    }
    if (ref.source === "junction") {
      return `Junction ${ref.id} references ${targets} and will not be copied — the copies will be plain internal nodes.`;
    }
    return `Logic rule ${ref.id} references ${targets} and will not be copied — it keeps referencing the original instance only.`;
  });
}

/**
 * The split section's warning sentences.  A split branch KEEPS its id (it
 * becomes the last segment), so a referencing record does not break — but
 * it then sees only that one segment, not the new ones upstream of it.
 */
export function splitUnclonedWarnings(
  config: NetworkConfig,
  branchId: string,
): string[] {
  const refs = unclonedUnitReferences(config, {
    nodes: [],
    branches: [branchId],
  });
  return refs.map((ref) => {
    const kind =
      ref.source === "controller"
        ? `Controller ${ref.id}`
        : ref.source === "junction"
          ? `Junction ${ref.id}`
          : `Logic rule ${ref.id}`;
    return `${kind} references this branch — after the split it sees only the last segment (which keeps the id); the new segments are not covered.`;
  });
}
