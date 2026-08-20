/**
 * Degree-of-freedom layout for the Newton unknown vector.
 *
 * The kernel and the step driver used to compute column indices inline from
 * block arithmetic (`x[nInt + nBranch + i]`), which hard-codes three
 * assumptions: that the energy block exists for every internal node or for
 * none, that it holds one single kind of variable, and that a column's kind
 * can be recovered by comparing its index against the block boundaries.  The
 * third assumption is the brittle one — adding the coupled compressible
 * [P, ṁ, T] mode gave the vector a third block that the scaling code, written
 * for [P, ṁ] and [P, ṁ, h], silently classified as mass flow.
 *
 * DofMap owns the layout instead.  Columns are still laid out as
 *
 *   [0 .. nInt)                 internal-node pressures P [Pa]
 *   [nInt .. nInt+nBranch)      branch mass flows ṁ [kg/s]
 *   [nInt+nBranch .. nVar)      energy unknowns, packed
 *
 * but the energy block is *packed*: only the nodes that actually carry an
 * energy unknown get a column, assigned in `internalIds` order.  When every
 * internal node carries one (the uniform modes) the packing reproduces the
 * historical layout exactly, so this is layout-compatible with the block
 * arithmetic it replaces.  When only some nodes carry one — a network mixing
 * an ideal-gas continuum with a segregated real-fluid continuum — the packing
 * skips the rest and nothing downstream needs to know.
 */
import type { SolverContext } from "./types";

/** What a column holds.  Drives per-variable scaling, step clamps and
 *  finite-difference step sizes, none of which are interchangeable between
 *  a pressure in Pa, a mass flow in kg/s and an enthalpy in J/kg. */
export type DofKind = "P" | "mdot" | "T" | "h";

/** Which energy unknown an internal node contributes to the coupled system.
 *  `"none"` means the node's energy is advanced by the segregated outer
 *  Picard loop instead, and it occupies no column. */
export type EnergyKind = "none" | "T" | "h";

export interface DofMap {
  readonly nVar: number;
  readonly nInt: number;
  readonly nBranch: number;
  /** Internal nodes carrying an energy column, in column order. */
  readonly energyNodes: readonly string[];
  /** True when at least one node carries an energy column. */
  readonly hasEnergyBlock: boolean;
  /** Column of an internal node's pressure; undefined for boundary nodes. */
  pressureCol(nodeId: string): number | undefined;
  /** Column of a branch's mass flow, by branch index. */
  mdotCol(branchIndex: number): number;
  /** Column of a node's energy unknown; undefined when the node is a
   *  boundary or its energy is segregated. */
  energyCol(nodeId: string): number | undefined;
  energyKind(nodeId: string): EnergyKind;
  kindOf(col: number): DofKind;
  /** Inverse of `energyCol`: the node owning an energy column, or undefined
   *  when the column is not in the energy block. */
  energyNodeOf(col: number): string | undefined;
  /** Columns an internal node occupies: `[P]`, or `[P, energy]` when
   *  `withEnergy` and the node carries an energy unknown.  Used to record
   *  which columns a non-differentiable residual row depends on. */
  colsForNode(nodeId: string, withEnergy: boolean): number[];
}

/**
 * Build the layout for one solve attempt.  `energyKindOf` decides, per
 * internal node, which energy unknown (if any) enters the coupled system;
 * the uniform modes pass a function that ignores its argument.
 */
export function createDofMap(
  ctx: SolverContext,
  energyKindOf: (nodeId: string) => EnergyKind,
): DofMap {
  const { internalIds, internalIndex, nInt, nBranch } = ctx;

  const energyNodes: string[] = [];
  const energyColByNode = new Map<string, number>();
  const kindByNode = new Map<string, EnergyKind>();
  const colKind: DofKind[] = new Array(nInt + nBranch);
  for (let i = 0; i < nInt; i++) colKind[i] = "P";
  for (let j = 0; j < nBranch; j++) colKind[nInt + j] = "mdot";

  for (const id of internalIds) {
    const kind = energyKindOf(id);
    kindByNode.set(id, kind);
    if (kind === "none") continue;
    energyColByNode.set(id, nInt + nBranch + energyNodes.length);
    energyNodes.push(id);
    colKind.push(kind);
  }

  const nVar = nInt + nBranch + energyNodes.length;

  return {
    nVar,
    nInt,
    nBranch,
    energyNodes,
    hasEnergyBlock: energyNodes.length > 0,
    pressureCol: (nodeId) => internalIndex.get(nodeId),
    mdotCol: (branchIndex) => nInt + branchIndex,
    energyCol: (nodeId) => energyColByNode.get(nodeId),
    energyKind: (nodeId) => kindByNode.get(nodeId) ?? "none",
    kindOf: (col) => colKind[col],
    energyNodeOf: (col) => energyNodes[col - nInt - nBranch],
    colsForNode: (nodeId, withEnergy) => {
      const p = internalIndex.get(nodeId);
      if (p === undefined) return [];
      if (!withEnergy) return [p];
      const e = energyColByNode.get(nodeId);
      return e === undefined ? [p] : [p, e];
    },
  };
}

/** Layout for the uniform modes, where either every internal node carries the
 *  same energy unknown or none does.  `useExtendedSystem` (real-fluid
 *  transient) and `useCoupledH` (coupled steady enthalpy system) give every
 *  node an `h` column; the modes are mutually exclusive. */
export function createUniformDofMap(
  ctx: SolverContext,
  opts: {
    useExtendedSystem: boolean;
    useCoupledH?: boolean;
  },
): DofMap {
  const kind: EnergyKind =
    opts.useExtendedSystem || opts.useCoupledH ? "h" : "none";
  return createDofMap(ctx, () => kind);
}
