/**
 * repeatSelection — pure derivation of the repeat "unit" (member node ids +
 * seam branch) from the current UI selection.  Shared by the store's
 * repeatSelection action and by UI that needs to enable/disable a Repeat
 * button without duplicating the seam/exit derivation logic.  No React, no
 * zustand: everything here is a plain function of (config, selection).
 */
import type { NetworkConfig, RepeatMembers } from "../core";
import { analyzeRepeatUnit } from "../core";
import type { Selection } from "./types";

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
