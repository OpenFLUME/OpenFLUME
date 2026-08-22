/**
 * Transonic second-law admissibility audit (settings.transonicAdmissibility).
 *
 * Applies to CENTRAL-scheme solves only (settings.momentumFluxScheme
 * "central"; steady.ts gates it).  The central momentum-flux
 * discretization (kernel.ts) is an exact integral balance, so besides the
 * physical root it admits discrete "expansion shock" roots: a branch
 * jumping from a subsonic donor endpoint to a supersonic downwind endpoint
 * away from an area minimum.  Mass, momentum and energy are satisfied
 * exactly (the Rankine–Hugoniot ambiguity), and with a poor warm start
 * Newton can converge onto one in a throat-clustered quasi-1-D nozzle.
 * (The default "upwind" scheme has no such roots by construction, and its
 * limited-upwind truncation legitimately drifts a few 0.01·R per
 * supersonic cell — auditing it would flag ordinary discretization error.)
 * What distinguishes an expansion-shock root is the SECOND LAW: the jump
 * destroys entropy.  Measured on the LOX/RP-1 thruster's nozzle grid,
 * the artifact's expansion leg destroys ≈ 0.11·R per branch while every
 * admissible branch sits within a few 0.001·R of its cooling allowance —
 * except the cell(s) straddling the physical sonic point, whose
 * first-order smearing shows up as an apparent defect of ≈ 0.035·R.
 *
 * This module therefore audits the CONVERGED state per ideal-gas branch.
 * Real-fluid branches are NOT audited: on the compressible (kineticEnergy)
 * path they default to the upwind scheme, which has no expansion-shock
 * roots to select against, and a central-scheme real-fluid entropy audit
 * would need s(P, h) from the EOS (a possible follow-up via
 * reportingPropertiesPH; single-phase only).  Per audited branch:
 *
 *     Δs = cp·ln(T_dwn/T_don) − R·ln(P_dwn/P_don)   [static endpoint states]
 *
 * must satisfy  Δs ≥ allowance − tol, where
 *
 *   - allowance = min(Q̇_in, 0)/(|ṁ|·T_dwn): heat EXTRACTED at the downwind
 *     node (conductors + heatInput) legitimately lowers entropy by δq/T
 *     (Clausius).  Heating is not demanded back — the node's heat is shared
 *     by all its branches, so demanding it per-branch would over-constrain
 *     multi-branch nodes.  Only the cooling credit is safe in both
 *     directions.
 *   - tol = TOL_BASE_R·R away from sonic crossings, TOL_NEAR_SONIC_R·R for
 *     branches touching the one-hop neighborhood of a static area minimum
 *     (the only place a physical sonic transition — and its smearing — can
 *     live; friction shifts the crossing at most into the adjacent cell).
 *
 * The audit never touches the residuals: it is ROOT SELECTION, not root
 * destruction.  steady.ts re-seeds a violating root (downwind node pulled
 * onto its donor's state — the subsonic side) and re-solves the SAME
 * unmodified system, keeping whichever converged root has the smaller
 * total entropy defect.  An admissible solve is therefore bit-identical
 * with the audit on or off, and a failed selection degrades to the
 * original root plus a warning instead of a convergence failure.
 */
import type { SolverContext, StepState } from "./types";
import { cloneStepState, heatInputOf } from "./types";
import { FlowSource } from "../components/flowSource";
import { Pump } from "../components/pump";
import { Regulator } from "../components/regulator";
import { computeConductorHMap } from "./conductorH";
import { computeConductorHeatRate } from "./thermal";

export interface AdmissibilityViolation {
  branchId: string;
  /** Upwind (donor) node of the converged flow direction. */
  donor: string;
  /** Downwind node — the endpoint the re-seed pulls back onto the donor. */
  downwind: string;
  /** Flow entropy change donor → downwind [J/(kg·K)]. */
  deltaS: number;
  /** Cooling allowance min(Q̇_in, 0)/(|ṁ|·T_dwn) [J/(kg·K)] (≤ 0). */
  allowance: number;
  /** Tolerance applied [J/(kg·K)] (> 0). */
  tolerance: number;
}

/** Entropy-defect tolerances in units of the gas constant R (the natural
 *  entropy scale of a shock: Δs/R is a pure function of Mach).  Measured
 *  anchors on the thruster grid: physical sonic-cell smear 0.035·R,
 *  shallowest observed artifact 0.108·R. */
const TOL_NEAR_SONIC_R = 0.05;
const TOL_BASE_R = 0.015;
const MDOT_FLOOR = 1e-9;

/** Total entropy defect beyond tolerance [J/(kg·K)] — the root-selection
 *  score (smaller is more admissible; 0 = fully admissible). */
export function violationScore(violations: AdmissibilityViolation[]): number {
  let s = 0;
  for (const v of violations) s += v.allowance - v.tolerance - v.deltaS;
  return s;
}

/** Nodes where a physical sonic transition can live: static area minima of
 *  the areal-branch graph plus their one-hop neighbors (friction shifts the
 *  crossing at most into the adjacent cell; the smeared cell straddles it). */
function nearSonicNodes(ctx: SolverContext): Set<string> {
  // Collect, per node, the incident areal-branch areas at the node and at
  // the far end.
  const incident = new Map<string, Array<{ atNode: number; far: number }>>();
  const neighbors = new Map<string, string[]>();
  for (const b of ctx.branches) {
    const area = b.component.area;
    if (area === undefined) continue;
    const areaOut = b.component.areaOut ?? area;
    for (const [n, atNode, far, other] of [
      [b.from, area, areaOut, b.to],
      [b.to, areaOut, area, b.from],
    ] as const) {
      const list = incident.get(n) ?? [];
      list.push({ atNode, far });
      incident.set(n, list);
      const nb = neighbors.get(n) ?? [];
      nb.push(other);
      neighbors.set(n, nb);
    }
  }
  const near = new Set<string>();
  for (const [n, list] of incident) {
    // Strict local minimum: no incident branch widens toward the node.
    if (list.length >= 2 && list.every((e) => e.atNode <= e.far)) {
      near.add(n);
      for (const nb of neighbors.get(n) ?? []) near.add(nb);
    }
  }
  return near;
}

/**
 * Audit every ideal-gas areal branch of a converged state against the
 * second law.  Returns the violating branches (empty ⇔ admissible root).
 */
export function auditSecondLaw(
  ctx: SolverContext,
  state: StepState,
): AdmissibilityViolation[] {
  const nearSonic = nearSonicNodes(ctx);
  const junctionInlets = new Set<number>();
  for (const jn of ctx.junctions) {
    for (const idxs of jn.roleBranches.values()) {
      for (const j of idxs) junctionInlets.add(j);
    }
  }

  // Heat into each fluid node [W] at the converged state (conductors are
  // signed from → to) plus any configured heatInput.
  const hMap = computeConductorHMap(ctx, state);
  const nodeQ = new Map<string, number>();
  const addQ = (n: string, q: number) => {
    if (!ctx.nodeMap.has(n)) return; // solid/ambient side
    nodeQ.set(n, (nodeQ.get(n) ?? 0) + q);
  };
  for (const cond of ctx.conductors) {
    const Tf = state.solidT.get(cond.from) ?? state.nodeT.get(cond.from);
    const Tt = state.solidT.get(cond.to) ?? state.nodeT.get(cond.to);
    if (Tf === undefined || Tt === undefined) continue;
    const Q = computeConductorHeatRate(cond, Tf, Tt, hMap);
    addQ(cond.from, -Q);
    addQ(cond.to, Q);
  }
  for (const node of ctx.nodeMap.values()) {
    const qIn = heatInputOf(ctx, node);
    if (qIn !== 0) addQ(node.id, qIn);
  }

  const violations: AdmissibilityViolation[] = [];
  for (let j = 0; j < ctx.nBranch; j++) {
    const b = ctx.branches[j];
    if (junctionInlets.has(j)) continue; // unlike fluids meet at the node
    if (b.component.area === undefined) continue;
    if (
      b.component instanceof Pump ||
      b.component instanceof Regulator ||
      b.component instanceof FlowSource
    ) {
      continue; // work input / enforced flow — not a passive entropy path
    }
    const fluid = ctx.fluidAssignment.branch(b.id);
    const R = fluid.R;
    const gamma = fluid.gamma;
    if (R === undefined || gamma === undefined) continue;

    const mdot = state.mdots[j];
    if (!(Math.abs(mdot) > MDOT_FLOOR)) continue;
    const donor = mdot >= 0 ? b.from : b.to;
    const dwn = mdot >= 0 ? b.to : b.from;
    // A boundary downwind node's prescribed state is a boundary-condition
    // mismatch question, not a root-selection one (and cannot be re-seeded).
    if (!ctx.internalIndex.has(dwn)) continue;
    const pDon = state.nodeP.get(donor);
    const pDwn = state.nodeP.get(dwn);
    const tDon = state.nodeT.get(donor);
    const tDwn = state.nodeT.get(dwn);
    if (
      pDon === undefined ||
      pDwn === undefined ||
      tDon === undefined ||
      tDwn === undefined ||
      !(pDon > 0) ||
      !(pDwn > 0) ||
      !(tDon > 0) ||
      !(tDwn > 0)
    ) {
      continue;
    }

    const cp = (gamma * R) / (gamma - 1);
    const deltaS = cp * Math.log(tDwn / tDon) - R * Math.log(pDwn / pDon);
    const allowance =
      Math.min(nodeQ.get(dwn) ?? 0, 0) / (Math.abs(mdot) * tDwn);
    const tolerance =
      (nearSonic.has(donor) || nearSonic.has(dwn)
        ? TOL_NEAR_SONIC_R
        : TOL_BASE_R) * R;
    if (deltaS < allowance - tolerance) {
      violations.push({
        branchId: b.id,
        donor,
        downwind: dwn,
        deltaS,
        allowance,
        tolerance,
      });
    }
  }
  return violations;
}

/**
 * Build a re-seeded warm start from an inadmissible converged root: each
 * violating branch's downwind node is pulled onto its donor's state (the
 * subsonic side of the jump), collapsing the entropy-violating crossing so
 * the re-solve starts inside the physical basin.  Boundary downwind nodes
 * keep their prescribed state.  Everything else (mdots included) carries
 * over unchanged.
 */
export function reseedInadmissible(
  ctx: SolverContext,
  state: StepState,
  violations: AdmissibilityViolation[],
): StepState {
  const seeded = cloneStepState(state);
  for (const v of violations) {
    if (!ctx.internalIndex.has(v.downwind)) continue;
    seeded.nodeP.set(v.downwind, state.nodeP.get(v.donor)!);
    seeded.nodeT.set(v.downwind, state.nodeT.get(v.donor)!);
    seeded.nodeRho.set(v.downwind, state.nodeRho.get(v.donor)!);
    seeded.nodeMu.set(v.downwind, state.nodeMu.get(v.donor)!);
    if (seeded.nodeH && state.nodeH) {
      const h = state.nodeH.get(v.donor);
      if (h !== undefined) seeded.nodeH.set(v.downwind, h);
    }
  }
  return seeded;
}
