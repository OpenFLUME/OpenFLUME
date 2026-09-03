/**
 * repeat.ts — pure config → config primitives that REPEAT a subgraph "unit"
 * (a set of member fluid/solid nodes plus the edges fully inside it) into a
 * chain of per-instance copies.  One primitive powers three commands:
 *
 *   Duplicate    — seamBranch: null.  Free-floating copies; every crossing
 *                  edge stays attached to the template only (mirrors the
 *                  store's duplicateSelection topology).
 *   Repeat-N     — seamBranch set.  The seam branch (the single branch
 *                  ENTERING the unit) is cloned and chained from instance
 *                  i-1's exit node to instance i, and every exit crossing
 *                  LEAVING FROM THE UNIT'S EXIT NODE is rewired to the last
 *                  instance's exit node.  An exit crossing leaving from any
 *                  OTHER member node (a side tap on the first segment, say)
 *                  describes instance 1 specifically and stays attached to
 *                  the template.
 *   Split-pipe-N — thin wrapper ({@link splitPipeBranch}) that inserts one
 *                  mid-node + seam pipe, then lets repeatUnit do everything
 *                  else.  There is deliberately NO second algorithm.
 *
 * Parameter handling composes two rules:
 *
 *   Rule 1 (ALWAYS — correctness): every cloned field that can hold a
 *   `{ expr }` formula (the BINDABLE_* allowlists of formulaFields.ts plus
 *   position axes, gasCushion, conduction k and convection correlation
 *   fields — the exact set paramBindings.collectBindings visits) gets its
 *   expression rewritten through rewriteExpressionIds with the instance's
 *   id map, so `pipe('seg1').volume` on the template becomes
 *   `pipe('seg2').volume` on instance 2.  Non-member references and
 *   `reg('…')` are untouched by construction.
 *
 *   Rule 2 (only when linkParams): every cloned field holding a plain
 *   finite number that sits in the BINDABLE_* allowlist for its entity is
 *   replaced by `{ expr: "<accessor>('<templateId>').<field>" }`, binding
 *   the copy to instance 1.  Canvas x/y, physical position.* and fields
 *   already holding `{ expr }` are skipped (Rule 1 owns the latter;
 *   offsets own position).
 *
 *   Rule 2 is structurally incapable of creating a parameter-binding
 *   CYCLE, and that invariant is load-bearing: it fires only when the
 *   clone's value is a plain finite number, which means the template field
 *   it binds to is a literal carrying NO binding edge of its own.  Every
 *   edge Rule 2 adds therefore points from a later instance BACK to a
 *   literal on instance 1, never sideways into another binding — the
 *   binding graph stays acyclic by construction.  Do not let Rule 2 fire
 *   on non-literal template fields.
 *
 * Everything here is pure and never throws: inputs are structuredClone'd,
 * never mutated, and all failures are returned as `{ ok: false, error }`.
 * Core must not import from src/ui, so the id allocators are implemented
 * locally: the default "instance" strategy (trailing-integer bump) and the
 * "firstFree" strategy, which replicates ui/utils.ts createId exactly.
 */

import type {
  Conductor,
  NetworkConfig,
  NumberOrExpression,
  PhysicalPosition,
  SolidNode,
} from "./schema";
import {
  BINDABLE_COMPONENT_FIELDS,
  BINDABLE_CONDUCTOR_FIELDS,
  BINDABLE_CORRELATION_FIELDS,
  BINDABLE_NODE_FIELDS,
  BINDABLE_POSITION_AXES,
  BINDABLE_SOLID_FIELDS,
} from "./formulaFields";
import { isParameterExpression } from "./paramBindings";
import { rewriteExpressionIds } from "./usercode/rewriteIds";
import { quoteFormulaId } from "./usercode/formulaTokens";

type FluidNode = NetworkConfig["nodes"][number];
type Branch = NetworkConfig["branches"][number];

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

/** The subgraph unit: member fluid nodes and solid nodes by id. */
export interface RepeatMembers {
  nodes: string[];
  solidNodes: string[];
}

export interface RepeatOptions {
  members: RepeatMembers;
  /**
   * Branch ENTERING the unit (`to` inside, `from` outside the member set);
   * cloned and chained per instance.  `null` produces free-floating copies
   * (Duplicate): no seam cloning, no exit rewiring, and crossing edges are
   * never cloned regardless of `crossingConductors`.
   */
  seamBranch: string | null;
  /** TOTAL instances including the original; 2 == one duplicate. */
  count: number;
  /** Bind cloned literal parameters to instance 1 (Rule 2). */
  linkParams: boolean;
  /**
   * Canvas-pixel offset applied per instance step (instance i: ×(i-1)).
   * Optional; defaults to `{ x: 0, y: 0 }` (copies land on the template).
   */
  canvasOffset?: { x: number; y: number };
  /** Physical-position offset [m] applied per instance step. */
  physicalOffset?: { x: number; y: number; z: number };
  /**
   * Conductors with exactly one endpoint inside the unit.
   *   "share" — clone per instance, remapping only the member endpoint, so
   *             every instance ties to the SAME external node (N tubes →
   *             one ambient).
   *   "drop"  — never clone them (today's duplicateSelection behaviour).
   * Ignored when `seamBranch` is null (Duplicate drops all crossings).
   */
  crossingConductors: "share" | "drop";
  /**
   * How ids for the copies are minted.
   *   "instance"  (default) — bump the id's trailing integer per instance
   *               (`n1` → `n2`), falling back to `<id>_<i>` when there is no
   *               trailing integer; collisions walk upward from the
   *               candidate.  Monotone with the chain's per-instance
   *               numbering — the right naming for Repeat and Split.
   *   "firstFree" — the legacy Duplicate naming: the leading [A-Za-z]+ run
   *               of the old id is the prefix ("N" when the id starts with
   *               a digit or symbol) and the first free integer is taken,
   *               checked against every existing id plus the ids already
   *               allocated by this operation (`j` → `j1`, `n12` → `n1`
   *               when `n1` is free).  Exactly the semantics of the store's
   *               pre-repeat `createId(prefixOf(id), existingIds)`.
   */
  idStrategy?: "instance" | "firstFree";
}

export type RepeatResult =
  | {
      ok: true;
      config: NetworkConfig;
      /** Every id created by the operation, grouped by kind. */
      created: {
        nodes: string[];
        solidNodes: string[];
        branches: string[];
        conductors: string[];
      };
      /**
       * Ids created for each GENERATED instance: `instances[0]` is
       * instance 2.  Per instance the order is fluid nodes, solid nodes,
       * branches (induced, then the seam clone), conductors (induced, then
       * shared crossing clones).
       */
      instances: string[][];
    }
  | { ok: false; error: string };

/**
 * Static analysis of a candidate unit — returned as data (never thrown) so
 * the UI can enable/disable a Repeat button without duplicating the seam /
 * exit-node derivation logic.  All id lists preserve config order.
 */
export type RepeatAnalysis =
  | {
      ok: true;
      /** Branches with BOTH endpoints in the member set. */
      inducedBranches: string[];
      /** Conductors with BOTH endpoints in the member set. */
      inducedConductors: string[];
      /** Branches entering the unit: `to` ∈ members, `from` ∉ members. */
      entryCrossings: string[];
      /** Branches leaving the unit: `from` ∈ members, `to` ∉ members. */
      exitCrossings: string[];
      /** Conductors with exactly ONE endpoint in the member set. */
      crossingConductors: string[];
      /** The unambiguous seam (exactly one entry crossing), else null. */
      seamBranch: string | null;
      /** Why no seam could be derived (null when `seamBranch` is set). */
      seamError: string | null;
      /** Derived exit node (where the next instance attaches from). */
      exitNode: string | null;
      /** Why no exit node could be derived (null when `exitNode` is set). */
      exitError: string | null;
    }
  | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* Id + label generation                                               */
/* ------------------------------------------------------------------ */

/**
 * Per-instance id: on a trailing integer k produce `prefix + (k+i-1)`
 * (`n1`→`n2`, `wall1`→`wall2`); otherwise `` `${baseId}_${i}` ``.  On any
 * collision with `taken` (all pre-existing ids plus everything already
 * allocated by this operation) fall back to a first-free-integer search
 * upward from the colliding candidate (`seg2` taken → `seg3`), the same
 * first-free spirit as ui/utils.ts createId but staying monotone with the
 * per-instance numbering.  The allocated id is added to `taken`.
 */
function instanceId(baseId: string, i: number, taken: Set<string>): string {
  const m = /^(.*?)(\d+)$/.exec(baseId);
  const prefix = m ? m[1] : `${baseId}_`;
  let n = m ? Number.parseInt(m[2], 10) + i - 1 : i;
  let candidate = `${prefix}${n}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${prefix}${n}`;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Legacy-Duplicate id: the leading `[A-Za-z]+` run of `baseId` is the
 * prefix ("N" when the id starts with a digit or symbol — the old store's
 * `prefixOf`), then the first integer whose `${prefix}${n}` is free against
 * `taken` — an exact replica of the pre-repeat store's
 * `createId(prefixOf(id), existingIds)` (`j` → `j1`, `n12` → the first free
 * `n<k>`).  The instance number plays no role: the numbering is per-prefix,
 * not per-instance, so consecutive duplicates of the same template mint
 * `j1`, `j2`, … across operations exactly as repeated legacy duplicates
 * did.  The allocated id is added to `taken`.
 */
function firstFreeId(baseId: string, taken: Set<string>): string {
  const m = /^[A-Za-z]+/.exec(baseId);
  const prefix = m ? m[0] : "N";
  let n = 1;
  let candidate = `${prefix}${n}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${prefix}${n}`;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Per-instance label: when the label mentions template member ids, every
 * such id is remapped through the instance's id map ("Conv wall1-n1" →
 * "Conv wall2-n2"), matching how the shipped models name per-segment
 * conductors.  Ids are matched LONGEST FIRST and only at a token boundary
 * (never preceded/followed by [A-Za-z0-9_]), so `n1` cannot corrupt `n10`
 * and `wall1` cannot corrupt `wall10` or a longer word.  The boundaries are
 * matched WITHOUT a RegExp lookbehind: `(?<!…)` throws a SyntaxError on
 * Safari < 16.4 (in scope via Vite's default "modules" build target, which
 * includes Safari 14), and repeatUnit's catch would have surfaced that as a
 * silent `{ ok: false }`.  The left boundary is a captured start-or-
 * non-word character re-emitted by the replacer; the right side uses a
 * lookahead, which every targeted engine supports.  When NO member id
 * appears in the label, fall back to bumping a trailing integer
 * ("Segment 1" → "Segment 2"), else append ` ${i}`.  `undefined` labels
 * stay `undefined`.
 */
function instanceLabel(
  label: string | undefined,
  i: number,
  idMap: ReadonlyMap<string, string>,
): string | undefined {
  if (label === undefined) return undefined;
  let out = label;
  let matched = false;
  const idsByLengthDesc = [...idMap.keys()].sort((a, b) => b.length - a.length);
  for (const id of idsByLengthDesc) {
    // (^|[^A-Za-z0-9_]) instead of a lookbehind — see the doc block above.
    // The captured left-boundary character is re-emitted, so the replacer
    // is span-identical to the lookbehind form.
    const re = new RegExp(
      `(^|[^A-Za-z0-9_])${escapeRegExp(id)}(?![A-Za-z0-9_])`,
      "g",
    );
    const mapped = idMap.get(id)!;
    const next = out.replace(re, (_match, left: string) => left + mapped);
    if (next !== out) {
      matched = true;
      out = next;
    }
  }
  if (matched) return out;
  const m = /^(.*?)(\d+)$/.exec(label);
  if (m) return `${m[1]}${Number.parseInt(m[2], 10) + i - 1}`;
  return `${label} ${i}`;
}

/** Escape a literal id for use inside a RegExp source. */
function escapeRegExp(id: string): string {
  return id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ */
/* Parameter retargeting (Rule 1 + Rule 2)                             */
/* ------------------------------------------------------------------ */

/**
 * Apply the two parameter rules to one field of a cloned entity.
 *
 * Rule 1 (always): a `{ expr }` value gets its member references rewritten
 * through `idMap`.  Rule 2 (only when `linkExpr` is non-null): a plain
 * finite literal becomes `{ expr: linkExpr }`, binding the copy to the
 * template (instance 1).  `undefined`, non-finite and non-numeric values
 * (tables, schedules, strings such as a "derived" elevationChange marker)
 * pass through untouched.
 */
function retargetField(
  holder: Record<string, unknown>,
  field: string,
  idMap: ReadonlyMap<string, string>,
  linkExpr: string | null,
): void {
  const value = holder[field];
  if (value === undefined) return;
  if (isParameterExpression(value)) {
    holder[field] = { expr: rewriteExpressionIds(value.expr, idMap) };
    return;
  }
  if (
    linkExpr !== null &&
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    holder[field] = { expr: linkExpr };
  }
}

/**
 * Physical-position handling for a clone: Rule 1 on `{ expr }` axes, then
 * add `offset × (i-1)` — literals numerically, expressions by wrapping in
 * `(<rewritten>) + <delta>`.  A zero delta leaves the axis alone.
 */
function retargetPosition(
  position: PhysicalPosition,
  idMap: ReadonlyMap<string, string>,
  offset: { x: number; y: number; z: number } | undefined,
  i: number,
): void {
  for (const axis of BINDABLE_POSITION_AXES) {
    const value = position[axis];
    if (value === undefined) continue;
    const delta = offset ? offset[axis] * (i - 1) : 0;
    if (isParameterExpression(value)) {
      const rewritten = rewriteExpressionIds(value.expr, idMap);
      position[axis] =
        delta === 0
          ? { expr: rewritten }
          : { expr: `(${rewritten}) + ${delta}` };
    } else if (typeof value === "number" && delta !== 0) {
      position[axis] = value + delta;
    }
  }
}

/** Static-scope accessor for a branch component (paramBindings.ts). */
function branchAccessor(
  componentType: string,
): "pipe" | "heatedPipe" | "bend" | "branch" {
  if (componentType === "pipe") return "pipe";
  if (componentType === "heatedPipe") return "heatedPipe";
  if (componentType === "bend") return "bend";
  return "branch";
}

/* ------------------------------------------------------------------ */
/* Entity cloning                                                      */
/* ------------------------------------------------------------------ */

interface CloneContext {
  i: number;
  idMap: ReadonlyMap<string, string>;
  linkParams: boolean;
  canvasOffset: { x: number; y: number };
  physicalOffset?: { x: number; y: number; z: number };
}

function cloneFluidNode(
  node: FluidNode,
  newId: string,
  ctx: CloneContext,
): FluidNode {
  const clone = structuredClone(node);
  clone.id = newId;
  // Only assign a defined label: an explicit `label: undefined` own-property
  // would survive structuredClone where the store's JSON cloning never
  // produced one, breaking exact serialize→parse round-trip equality.
  const label = instanceLabel(node.label, ctx.i, ctx.idMap);
  if (label !== undefined) clone.label = label;
  clone.x = node.x + ctx.canvasOffset.x * (ctx.i - 1);
  clone.y = node.y + ctx.canvasOffset.y * (ctx.i - 1);
  if (clone.position) {
    retargetPosition(clone.position, ctx.idMap, ctx.physicalOffset, ctx.i);
  }
  const holder = clone as unknown as Record<string, unknown>;
  for (const field of BINDABLE_NODE_FIELDS) {
    retargetField(
      holder,
      field,
      ctx.idMap,
      ctx.linkParams ? `node(${quoteFormulaId(node.id)}).${field}` : null,
    );
  }
  // gasCushion fields can hold `{ expr }` (paramBindings visits them) but
  // are not in the static accessor scope — Rule 1 only, never Rule 2.
  if (clone.gasCushion) {
    const gc = clone.gasCushion as unknown as Record<string, unknown>;
    for (const field of ["initialGasVolume", "polytropicIndex"] as const) {
      retargetField(gc, field, ctx.idMap, null);
    }
  }
  return clone;
}

function cloneSolidNode(
  node: SolidNode,
  newId: string,
  ctx: CloneContext,
): SolidNode {
  const clone = structuredClone(node);
  clone.id = newId;
  const label = instanceLabel(node.label, ctx.i, ctx.idMap);
  if (label !== undefined) clone.label = label;
  clone.x = node.x + ctx.canvasOffset.x * (ctx.i - 1);
  clone.y = node.y + ctx.canvasOffset.y * (ctx.i - 1);
  if (clone.position) {
    retargetPosition(clone.position, ctx.idMap, ctx.physicalOffset, ctx.i);
  }
  const holder = clone as unknown as Record<string, unknown>;
  for (const field of BINDABLE_SOLID_FIELDS) {
    retargetField(
      holder,
      field,
      ctx.idMap,
      ctx.linkParams ? `solid(${quoteFormulaId(node.id)}).${field}` : null,
    );
  }
  return clone;
}

function cloneBranch(
  branch: Branch,
  newId: string,
  from: string,
  to: string,
  ctx: CloneContext,
): Branch {
  const clone = structuredClone(branch);
  clone.id = newId;
  const label = instanceLabel(branch.label, ctx.i, ctx.idMap);
  if (label !== undefined) clone.label = label;
  clone.from = from;
  clone.to = to;
  const accessor = branchAccessor(branch.component.type);
  const allowlist = BINDABLE_COMPONENT_FIELDS[branch.component.type] ?? [];
  const holder = clone.component as unknown as Record<string, unknown>;
  for (const field of allowlist) {
    retargetField(
      holder,
      field,
      ctx.idMap,
      ctx.linkParams
        ? `${accessor}(${quoteFormulaId(branch.id)}).${field}`
        : null,
    );
  }
  return clone;
}

function cloneConductor(
  conductor: Conductor,
  newId: string,
  from: string,
  to: string,
  ctx: CloneContext,
): Conductor {
  const clone = structuredClone(conductor);
  clone.id = newId;
  const label = instanceLabel(conductor.label, ctx.i, ctx.idMap);
  if (label !== undefined) clone.label = label;
  clone.from = from;
  clone.to = to;
  const type = clone.type as unknown as Record<string, unknown>;
  const allowlist = BINDABLE_CONDUCTOR_FIELDS[conductor.type.kind] ?? [];
  for (const field of allowlist) {
    retargetField(
      type,
      field,
      ctx.idMap,
      ctx.linkParams
        ? `conductor(${quoteFormulaId(conductor.id)}).${field}`
        : null,
    );
  }
  // Conduction k is a SolidPropertySpec OR a constant `{ expr }` formula —
  // only the formula form is a binding (Rule 1); it is not in the
  // BINDABLE_CONDUCTOR_FIELDS allowlist, so Rule 2 never links it.
  if (clone.type.kind === "conduction") {
    retargetField(type, "k", ctx.idMap, null);
  }
  if (clone.type.kind === "convection" && clone.type.correlation) {
    const correlation = clone.type.correlation as unknown as Record<
      string,
      unknown
    >;
    for (const field of BINDABLE_CORRELATION_FIELDS) {
      retargetField(
        correlation,
        field,
        ctx.idMap,
        ctx.linkParams
          ? `conductor(${quoteFormulaId(conductor.id)}).correlation.${field}`
          : null,
      );
    }
  }
  return clone;
}

/* ------------------------------------------------------------------ */
/* Analysis                                                            */
/* ------------------------------------------------------------------ */

interface FullAnalysis {
  memberNodes: FluidNode[];
  memberSolids: SolidNode[];
  inducedBranches: Branch[];
  inducedConductors: Conductor[];
  entryCrossings: Branch[];
  exitCrossings: Branch[];
  crossingConductors: Conductor[];
  seamBranch: string | null;
  seamError: string | null;
  exitNode: string | null;
  exitError: string | null;
}

function analyzeMembers(
  config: NetworkConfig,
  members: RepeatMembers,
): { ok: true; analysis: FullAnalysis } | { ok: false; error: string } {
  const nodeIds = Array.isArray(members?.nodes) ? members.nodes : [];
  const solidIds = Array.isArray(members?.solidNodes) ? members.solidNodes : [];
  if (nodeIds.length + solidIds.length === 0) {
    return { ok: false, error: "no member ids given — the unit is empty" };
  }
  const seen = new Set<string>();
  for (const id of [...nodeIds, ...solidIds]) {
    if (seen.has(id)) {
      return { ok: false, error: `duplicate member id '${id}'` };
    }
    seen.add(id);
  }
  const nodeById = new Map(config.nodes.map((n) => [n.id, n]));
  const solidById = new Map((config.solidNodes ?? []).map((s) => [s.id, s]));
  const unknownNodes = nodeIds.filter((id) => !nodeById.has(id));
  if (unknownNodes.length > 0) {
    return {
      ok: false,
      error: `unknown fluid node member id(s): ${unknownNodes.join(", ")}`,
    };
  }
  const unknownSolids = solidIds.filter((id) => !solidById.has(id));
  if (unknownSolids.length > 0) {
    return {
      ok: false,
      error: `unknown solid node member id(s): ${unknownSolids.join(", ")}`,
    };
  }
  const memberSet = new Set([...nodeIds, ...solidIds]);

  const inducedBranches: Branch[] = [];
  const entryCrossings: Branch[] = [];
  const exitCrossings: Branch[] = [];
  for (const b of config.branches) {
    const fromIn = memberSet.has(b.from);
    const toIn = memberSet.has(b.to);
    if (fromIn && toIn) inducedBranches.push(b);
    else if (toIn) entryCrossings.push(b);
    else if (fromIn) exitCrossings.push(b);
  }
  const inducedConductors: Conductor[] = [];
  const crossingConductors: Conductor[] = [];
  for (const c of config.conductors ?? []) {
    const fromIn = memberSet.has(c.from);
    const toIn = memberSet.has(c.to);
    if (fromIn && toIn) inducedConductors.push(c);
    else if (fromIn !== toIn) crossingConductors.push(c);
  }

  // Cross-namespace id collisions make the per-instance id map ambiguous:
  // ids are only unique PER KIND in a config (a node 'seg1' may sit next to
  // a pipe 'seg1' — validate/branches.ts vs validate/nodes.ts), but the id
  // map and rewriteExpressionIds key by PLAIN id across every accessor, so
  // one entry would silently overwrite the other and expressions would
  // retarget to the wrong entity.  Reject such units outright: they are
  // pathological, and renaming one entity is trivial.  (repeatUnit extends
  // the same guard to the seam branch and shared crossing conductors, which
  // also enter the map.)
  const kindsById = new Map<string, Set<string>>();
  const noteKind = (id: string, kind: string) => {
    const kinds = kindsById.get(id) ?? new Set<string>();
    kinds.add(kind);
    kindsById.set(id, kinds);
  };
  for (const id of nodeIds) noteKind(id, "fluid node");
  for (const id of solidIds) noteKind(id, "solid node");
  for (const b of inducedBranches) noteKind(b.id, "branch");
  for (const c of inducedConductors) noteKind(c.id, "conductor");
  for (const [id, kinds] of kindsById) {
    if (kinds.size > 1) {
      return {
        ok: false,
        error:
          `the unit's entities share the id '${id}' across namespaces (${[...kinds].join(" + ")}) — ` +
          "repeat rewrites formula references through one id map and needs ids unique across the unit's nodes, solid nodes, branches and conductors; rename one of them",
      };
    }
  }

  // Seam derivation: exactly one entry crossing is unambiguous.
  let seamBranch: string | null = null;
  let seamError: string | null = null;
  if (entryCrossings.length === 1) {
    seamBranch = entryCrossings[0]!.id;
  } else if (entryCrossings.length === 0) {
    seamError = "no branch enters the unit";
  } else {
    seamError = `multiple branches enter the unit: ${entryCrossings
      .map((b) => b.id)
      .join(", ")} — pass seamBranch explicitly`;
  }

  // Exit node: (1) every exit crossing leaves from the same node; else
  // (2) the unique fluid member with no outgoing induced branch (sink).
  let exitNode: string | null = null;
  let exitError: string | null = null;
  if (
    exitCrossings.length >= 1 &&
    exitCrossings.every((b) => b.from === exitCrossings[0]!.from)
  ) {
    exitNode = exitCrossings[0]!.from;
  } else {
    const sinks = nodeIds.filter((id) =>
      inducedBranches.every((b) => b.from !== id),
    );
    if (sinks.length === 1) {
      exitNode = sinks[0]!;
    } else if (sinks.length === 0) {
      exitError =
        "cannot determine the unit's exit node: no exit crossing and every " +
        "fluid member has an outgoing internal branch";
    } else {
      exitError = `cannot determine the unit's exit node: ambiguous candidates ${sinks.join(
        ", ",
      )}`;
    }
  }

  return {
    ok: true,
    analysis: {
      memberNodes: nodeIds.map((id) => nodeById.get(id)!),
      memberSolids: solidIds.map((id) => solidById.get(id)!),
      inducedBranches,
      inducedConductors,
      entryCrossings,
      exitCrossings,
      crossingConductors,
      seamBranch,
      seamError,
      exitNode,
      exitError,
    },
  };
}

/**
 * Analyze a candidate repeat unit without modifying anything.  Pure.
 */
export function analyzeRepeatUnit(
  config: NetworkConfig,
  members: RepeatMembers,
): RepeatAnalysis {
  try {
    const result = analyzeMembers(config, members);
    if (!result.ok) return { ok: false, error: result.error };
    const a = result.analysis;
    return {
      ok: true,
      inducedBranches: a.inducedBranches.map((b) => b.id),
      inducedConductors: a.inducedConductors.map((c) => c.id),
      entryCrossings: a.entryCrossings.map((b) => b.id),
      exitCrossings: a.exitCrossings.map((b) => b.id),
      crossingConductors: a.crossingConductors.map((c) => c.id),
      seamBranch: a.seamBranch,
      seamError: a.seamError,
      exitNode: a.exitNode,
      exitError: a.exitError,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ------------------------------------------------------------------ */
/* repeatUnit                                                          */
/* ------------------------------------------------------------------ */

/**
 * Repeat a subgraph unit into `count` total instances.  Pure: the input
 * config is cloned, never mutated.  Never throws.
 */
export function repeatUnit(
  config: NetworkConfig,
  opts: RepeatOptions,
): RepeatResult {
  try {
    return repeatUnitInner(config, opts);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function repeatUnitInner(
  config: NetworkConfig,
  opts: RepeatOptions,
): RepeatResult {
  const count = opts?.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
    return {
      ok: false,
      error: `count must be a positive integer (got ${String(count)})`,
    };
  }
  const analysisResult = analyzeMembers(config, opts.members);
  if (!analysisResult.ok) return { ok: false, error: analysisResult.error };
  const analysis = analysisResult.analysis;

  const emptyCreated = {
    nodes: [] as string[],
    solidNodes: [] as string[],
    branches: [] as string[],
    conductors: [] as string[],
  };

  // count === 1 is a strict no-op: the unit is validated but nothing is
  // cloned, chained or rewired (any exit rewiring would target instance 1,
  // i.e. be the identity), so seam/exit derivation is not required.
  if (count === 1) {
    return {
      ok: true,
      config: structuredClone(config),
      created: emptyCreated,
      instances: [],
    };
  }

  // Seam resolution.  An explicit seam must be one of the entry crossings;
  // seamBranch: null is Duplicate mode — no chaining, and every crossing
  // (branch and conductor) is left attached to the template only.
  const seamId = opts.seamBranch ?? null;
  let seam: Branch | undefined;
  let exitNode: string | undefined;
  if (seamId !== null) {
    seam = config.branches.find((b) => b.id === seamId);
    if (!seam || !analysis.entryCrossings.includes(seam)) {
      const entries =
        analysis.entryCrossings.length === 0
          ? "none — no branch enters the unit"
          : analysis.entryCrossings.map((b) => b.id).join(", ");
      return {
        ok: false,
        error: `seam branch '${seamId}' is not a branch entering the unit (entry crossings: ${entries})`,
      };
    }

    // A chained unit must not contain a BOUNDARY fluid node: Repeat/Split
    // clone the members per instance, and a cloned pressure/temperature
    // boundary in the middle of the chain silently re-imposes the boundary
    // condition on every segment.  Duplicate (seamBranch: null) is
    // unaffected — free-floating copies of a boundary are legitimate.
    const boundaryMembers = analysis.memberNodes.filter(
      (n) => n.type === "boundary",
    );
    if (boundaryMembers.length > 0) {
      return {
        ok: false,
        error: `cannot repeat a unit containing boundary node(s) ${boundaryMembers
          .map((n) => n.id)
          .join(
            ", ",
          )} — chaining would clone the boundary condition into every instance; use Duplicate (no seam) to copy them instead`,
      };
    }

    if (analysis.exitNode === null) {
      return {
        ok: false,
        error: analysis.exitError ?? "cannot determine the unit's exit node",
      };
    }
    exitNode = analysis.exitNode;

    // Reachability guard: instance i is fed from instance i−1's exit node
    // through the seam clone, so EVERY member fluid node must be reachable
    // from the seam's target along the unit's own (induced) branches —
    // otherwise its per-instance copies have no inflow at all (orphaned
    // zero-inflow nodes).  The exit node is itself a fluid member, so this
    // single check subsumes exit-node reachability.
    const reachable = new Set<string>([seam.to]);
    const stack = [seam.to];
    while (stack.length > 0) {
      const at = stack.pop()!;
      for (const b of analysis.inducedBranches) {
        if (b.from === at && !reachable.has(b.to)) {
          reachable.add(b.to);
          stack.push(b.to);
        }
      }
    }
    const orphaned = analysis.memberNodes.filter((n) => !reachable.has(n.id));
    if (orphaned.length > 0) {
      return {
        ok: false,
        error: `cannot repeat: member node(s) ${orphaned
          .map((n) => `'${n.id}'`)
          .join(
            ", ",
          )} are not reachable from the seam's target '${seam.to}' along branches inside the unit — their copies would have no inflow`,
      };
    }

    // The seam branch and (when shared) the crossing conductors also enter
    // the per-instance id map, so the cross-namespace uniqueness that
    // analyzeMembers enforced among the unit's own entities must extend to
    // them (see the collision guard there for why).
    const unitEntityIds = new Set<string>([
      ...analysis.memberNodes.map((n) => n.id),
      ...analysis.memberSolids.map((s) => s.id),
      ...analysis.inducedBranches.map((b) => b.id),
      ...analysis.inducedConductors.map((c) => c.id),
    ]);
    if (unitEntityIds.has(seam.id)) {
      return {
        ok: false,
        error:
          `the seam branch '${seam.id}' shares its id with another unit entity — ` +
          "repeat needs ids unique across the unit's nodes, solid nodes, branches and conductors; rename one of them",
      };
    }
    if (opts.crossingConductors === "share") {
      for (const c of analysis.crossingConductors) {
        if (unitEntityIds.has(c.id)) {
          return {
            ok: false,
            error:
              `the crossing conductor '${c.id}' shares its id with another unit entity — ` +
              "repeat needs ids unique across the unit's nodes, solid nodes, branches and conductors; rename one of them",
          };
        }
      }
    }
  }

  const cfg = structuredClone(config);
  const taken = new Set<string>([
    ...cfg.nodes.map((n) => n.id),
    ...(cfg.solidNodes ?? []).map((s) => s.id),
    ...cfg.branches.map((b) => b.id),
    ...(cfg.conductors ?? []).map((c) => c.id),
  ]);
  // The id pool above (nodes + solid nodes + branches + conductors, plus
  // everything allocated as the operation proceeds) is exactly the pool the
  // legacy duplicateSelection's createId checked against.
  //
  // Under "firstFree" (Duplicate's legacy naming), cloned edges take the
  // FIXED prefixes the pre-repeat store used — branches via
  // createId("b", …), conductors via createId("c", …) — NOT a prefix derived
  // from the source id (duplicating a pair joined by 'myPipe1' mints 'b7',
  // never 'myPipe2').  Node and solid ids keep the source id's own letter
  // prefix (prefixOf) exactly as the legacy code did.
  const strategy = opts.idStrategy ?? "instance";
  const allocateId = (
    kind: "node" | "branch" | "conductor",
    id: string,
    i: number,
  ): string => {
    if (strategy === "firstFree") {
      const base = kind === "branch" ? "b" : kind === "conductor" ? "c" : id;
      return firstFreeId(base, taken);
    }
    return instanceId(id, i, taken);
  };

  // Distinct literal from `emptyCreated` above: the count === 1 early return
  // hands its object out too, and the two results must never alias.
  const created = {
    nodes: [] as string[],
    solidNodes: [] as string[],
    branches: [] as string[],
    conductors: [] as string[],
  };
  const instances: string[][] = [];
  const shareCrossings =
    seam !== undefined && opts.crossingConductors === "share";
  let prevExitId = exitNode; // instance 1 is the template itself
  let lastIdMap: Map<string, string> | undefined;

  for (let i = 2; i <= count; i++) {
    // 1. Build the ENTIRE id map for instance i before cloning anything, so
    //    expression rewriting sees every new id of the instance.
    const idMap = new Map<string, string>();
    for (const n of analysis.memberNodes)
      idMap.set(n.id, allocateId("node", n.id, i));
    for (const s of analysis.memberSolids)
      idMap.set(s.id, allocateId("node", s.id, i));
    for (const b of analysis.inducedBranches)
      idMap.set(b.id, allocateId("branch", b.id, i));
    for (const c of analysis.inducedConductors)
      idMap.set(c.id, allocateId("conductor", c.id, i));
    if (seam) idMap.set(seam.id, allocateId("branch", seam.id, i));
    if (shareCrossings) {
      for (const c of analysis.crossingConductors) {
        idMap.set(c.id, allocateId("conductor", c.id, i));
      }
    }
    const ctx: CloneContext = {
      i,
      idMap,
      linkParams: opts.linkParams,
      canvasOffset: opts.canvasOffset ?? { x: 0, y: 0 },
      physicalOffset: opts.physicalOffset,
    };

    // 2–5. Clone members, induced edges, the seam, and shared crossings.
    const instanceIds: string[] = [];
    for (const n of analysis.memberNodes) {
      const clone = cloneFluidNode(n, idMap.get(n.id)!, ctx);
      cfg.nodes.push(clone);
      created.nodes.push(clone.id);
      instanceIds.push(clone.id);
    }
    for (const s of analysis.memberSolids) {
      const clone = cloneSolidNode(s, idMap.get(s.id)!, ctx);
      cfg.solidNodes ??= [];
      cfg.solidNodes.push(clone);
      created.solidNodes.push(clone.id);
      instanceIds.push(clone.id);
    }
    for (const b of analysis.inducedBranches) {
      const clone = cloneBranch(
        b,
        idMap.get(b.id)!,
        idMap.get(b.from)!,
        idMap.get(b.to)!,
        ctx,
      );
      cfg.branches.push(clone);
      created.branches.push(clone.id);
      instanceIds.push(clone.id);
    }
    if (seam) {
      const clone = cloneBranch(
        seam,
        idMap.get(seam.id)!,
        prevExitId!,
        idMap.get(seam.to)!,
        ctx,
      );
      cfg.branches.push(clone);
      created.branches.push(clone.id);
      instanceIds.push(clone.id);
    }
    for (const c of analysis.inducedConductors) {
      const clone = cloneConductor(
        c,
        idMap.get(c.id)!,
        idMap.get(c.from)!,
        idMap.get(c.to)!,
        ctx,
      );
      cfg.conductors ??= [];
      cfg.conductors.push(clone);
      created.conductors.push(clone.id);
      instanceIds.push(clone.id);
    }
    if (shareCrossings) {
      for (const c of analysis.crossingConductors) {
        const clone = cloneConductor(
          c,
          idMap.get(c.id)!,
          idMap.get(c.from) ?? c.from, // remap only the member endpoint
          idMap.get(c.to) ?? c.to,
          ctx,
        );
        cfg.conductors ??= [];
        cfg.conductors.push(clone);
        created.conductors.push(clone.id);
        instanceIds.push(clone.id);
      }
    }
    instances.push(instanceIds);
    if (exitNode !== undefined) prevExitId = idMap.get(exitNode)!;
    lastIdMap = idMap;
  }

  // Exit rewiring: exit crossings LEAVING FROM THE UNIT'S EXIT NODE now
  // leave from the LAST instance's exit node (series-chaining semantics —
  // the unit's outflow port moves to the end of the chain).  An exit
  // crossing leaving from any OTHER member node describes instance 1
  // specifically — a side tap on the first segment, say — and stays
  // attached to the template; rewiring it to the end of the chain would
  // silently move the tap.  Entry crossings other than the seam stay on
  // instance 1.
  if (seam && exitNode !== undefined && lastIdMap) {
    const finalExitId = lastIdMap.get(exitNode)!;
    for (const b of analysis.exitCrossings) {
      if (b.from !== exitNode) continue;
      const target = cfg.branches.find((x) => x.id === b.id);
      if (target) target.from = finalExitId;
    }
  }

  return { ok: true, config: cfg, created, instances };
}

/* ------------------------------------------------------------------ */
/* splitPipeBranch — a thin wrapper over repeatUnit                    */
/* ------------------------------------------------------------------ */

/**
 * Split a pipe/heatedPipe branch into `segments` series segments of equal
 * length, dividing the EXTENSIVE fields — length, elevationChange and a
 * heatedPipe's ua (U·A ∝ π·D·L, the wall heat-leak conductance) — so the
 * split preserves the total of each; copying ua verbatim would multiply the
 * model's total wall heat leak by `segments`.  The intensive fields
 * (diameter, roughness, wallTemperature) and the categorical boilingModel
 * are copied verbatim.  Inserts `segments-1` internal nodes.  Implemented
 * as: insert node `m1` one segment-step downstream of `from`, create a seam
 * pipe `from → m1` cloned from the branch at 1/segments length, rewire the
 * original branch to `m1 → to` at 1/segments length, then repeatUnit the
 * `{m1}` unit `segments-1` times so exit-crossing rewiring lands the
 * original branch on the last mid-node.  With `linkParams` the original
 * branch's bindable literals are bound to segment 1 as well (repeatUnit's
 * Rule 2 only reaches CLONES, and the original is never cloned), so every
 * segment except the first tracks segment 1 and "edit the first segment"
 * really does retune them all.
 *
 * Each inserted node binds its volume to its own upstream pipe
 * (`pipe('<seam>').volume` — matching the shipped examples, needed for
 * transient) and inherits its initial pressure/temperature from an
 * endpoint, preferring the internal one.  Total length is preserved.
 *
 * The new node id is the first free `m1`, `m2`, …; the seam pipe id is the
 * first free `${branchId}_seg1`, `_seg2`, ….  Never throws.
 */
export function splitPipeBranch(
  config: NetworkConfig,
  branchId: string,
  segments: number,
  opts?: { linkParams?: boolean },
): RepeatResult {
  try {
    return splitPipeInner(config, branchId, segments, opts);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function splitPipeInner(
  config: NetworkConfig,
  branchId: string,
  segments: number,
  opts?: { linkParams?: boolean },
): RepeatResult {
  if (
    typeof segments !== "number" ||
    !Number.isInteger(segments) ||
    segments < 2
  ) {
    return {
      ok: false,
      error: `segments must be an integer ≥ 2 (got ${String(segments)})`,
    };
  }
  const cfg = structuredClone(config);
  const branch = cfg.branches.find((b) => b.id === branchId);
  if (!branch) {
    return { ok: false, error: `unknown branch '${branchId}'` };
  }
  if (
    branch.component.type !== "pipe" &&
    branch.component.type !== "heatedPipe"
  ) {
    return {
      ok: false,
      error: `only pipe and heatedPipe branches can be split ('${branchId}' is a ${branch.component.type})`,
    };
  }
  const from = cfg.nodes.find((n) => n.id === branch.from);
  const to = cfg.nodes.find((n) => n.id === branch.to);
  if (!from || !to) {
    return {
      ok: false,
      error: `branch '${branchId}' has dangling endpoint(s)`,
    };
  }
  const component = branch.component; // narrowed: pipe | heatedPipe

  const taken = new Set<string>([
    ...cfg.nodes.map((n) => n.id),
    ...(cfg.solidNodes ?? []).map((s) => s.id),
    ...cfg.branches.map((b) => b.id),
    ...(cfg.conductors ?? []).map((c) => c.id),
  ]);
  let k = 1;
  while (taken.has(`m${k}`)) k += 1;
  const midId = `m${k}`;
  taken.add(midId);
  let j = 1;
  while (taken.has(`${branchId}_seg${j}`)) j += 1;
  const seamId = `${branchId}_seg${j}`;
  taken.add(seamId);

  // Halve-style division that preserves formula lengths/elevations:
  // `{ expr: L }` becomes `{ expr: "(L) / <segments>" }`.
  const divide = (
    value: NumberOrExpression | undefined,
  ): NumberOrExpression | undefined => {
    if (value === undefined) return undefined;
    if (isParameterExpression(value)) {
      return { expr: `(${value.expr}) / ${segments}` };
    }
    return typeof value === "number" ? value / segments : value;
  };
  const origLength = component.length;
  const origElevation = component.elevationChange;
  // ua is EXTENSIVE (U·A ∝ π·D·L): it must divide exactly like length, or a
  // split would multiply the model's total wall heat leak by `segments`.
  const origUa = component.type === "heatedPipe" ? component.ua : undefined;
  const dividedLength = divide(origLength);
  const dividedElevation = divide(origElevation);
  const dividedUa = divide(origUa);

  // Mid-node placement: canvas and physical positions step (to-from)/segments
  // per instance.  Axes defined numerically on BOTH endpoints interpolate;
  // an axis defined on only one endpoint (or as an expression) is held
  // constant from that endpoint.
  const stepX = (to.x - from.x) / segments;
  const stepY = (to.y - from.y) / segments;
  const midPosition: PhysicalPosition = {};
  const physicalDelta = { x: 0, y: 0, z: 0 };
  let anyPosition = false;
  for (const axis of BINDABLE_POSITION_AXES) {
    const a = from.position?.[axis];
    const b = to.position?.[axis];
    const aNum = typeof a === "number" && Number.isFinite(a) ? a : undefined;
    const bNum = typeof b === "number" && Number.isFinite(b) ? b : undefined;
    if (aNum !== undefined && bNum !== undefined) {
      midPosition[axis] = aNum + (bNum - aNum) / segments;
      physicalDelta[axis] = (bNum - aNum) / segments;
      anyPosition = true;
    } else if (a !== undefined) {
      midPosition[axis] = a;
      anyPosition = true;
    } else if (b !== undefined) {
      midPosition[axis] = b;
      anyPosition = true;
    }
  }

  // Initial conditions come from the internal endpoint when there is one.
  const icSource =
    from.type === "internal" ? from : to.type === "internal" ? to : from;
  const midNode: FluidNode = {
    id: midId,
    type: "internal",
    x: from.x + stepX,
    y: from.y + stepY,
    ...(anyPosition ? { position: midPosition } : {}),
    ...(icSource.pressure !== undefined ? { pressure: icSource.pressure } : {}),
    ...(icSource.temperature !== undefined
      ? { temperature: icSource.temperature }
      : {}),
    volume: { expr: `${component.type}(${quoteFormulaId(seamId)}).volume` },
  };

  // Seam pipe: a 1/segments clone of the branch covering from → m1.  The
  // original branch keeps its id and becomes the LAST segment (m1 → to).
  const seam = structuredClone(branch);
  seam.id = seamId;
  seam.to = midId;
  (seam.component as { length?: NumberOrExpression }).length = dividedLength;
  if (origElevation !== undefined) {
    (
      seam.component as { elevationChange?: NumberOrExpression }
    ).elevationChange = dividedElevation;
  }
  if (origUa !== undefined) {
    (seam.component as { ua?: NumberOrExpression }).ua = dividedUa;
  }
  branch.from = midId;
  component.length = dividedLength as typeof component.length;
  if (origElevation !== undefined) {
    component.elevationChange =
      dividedElevation as typeof component.elevationChange;
  }
  if (origUa !== undefined && component.type === "heatedPipe") {
    component.ua = dividedUa as NumberOrExpression;
  }
  // Rule 2 for the LAST segment too: the original branch keeps its id and
  // is never cloned, so repeatUnit's linking never reaches it — with
  // linkParams it would stay a literal island and editing segment 1 would
  // leave the final segment (and the resolved totals) behind.  Bind its
  // bindable literals to segment 1 exactly like the clones.  Fields holding
  // `{ expr }` keep their divided expression (Rule 1's territory), matching
  // Rule 2's "literals only" scope.  The empty id map makes Rule 1 a no-op
  // here; nothing on this branch references the instance's new ids.
  if (opts?.linkParams) {
    const accessor = branchAccessor(component.type);
    const noRewrites = new Map<string, string>();
    const holder = component as unknown as Record<string, unknown>;
    for (const field of BINDABLE_COMPONENT_FIELDS[component.type] ?? []) {
      retargetField(
        holder,
        field,
        noRewrites,
        `${accessor}(${quoteFormulaId(seamId)}).${field}`,
      );
    }
  }
  cfg.nodes.push(midNode);
  cfg.branches.push(seam);

  const repeated = repeatUnit(cfg, {
    members: { nodes: [midId], solidNodes: [] },
    seamBranch: seamId,
    count: segments - 1,
    linkParams: opts?.linkParams ?? false,
    canvasOffset: { x: stepX, y: stepY },
    physicalOffset: anyPosition ? physicalDelta : undefined,
    crossingConductors: "share",
  });
  if (!repeated.ok) return repeated;
  return {
    ok: true,
    config: repeated.config,
    created: {
      nodes: [midId, ...repeated.created.nodes],
      solidNodes: repeated.created.solidNodes,
      branches: [seamId, ...repeated.created.branches],
      conductors: repeated.created.conductors,
    },
    instances: repeated.instances,
  };
}
