/**
 * fluidFront.ts — transported cryogenic-front / liquid-availability state
 * (fluid-side), gating the TT-WF dry-side heat exchange.
 *
 * ============================================================================
 * WHAT THIS IS (model semantics)
 * ============================================================================
 * The pre-cooling ablation evidence (docs/fluid-front-transport.md)
 * measured that the shared early downstream pre-cooling defect at NBS-9264
 * fig02 is carried by an ADVECTED cold single-phase-vapor enthalpy tail, and
 * that the only ablations repairing the trace morphology are gates keyed on a
 * CONSERVATION-SPEED transport signal (C2 plug-flow displacement bound:
 * run RMSE 83.65 → 41.15 K, knees matched), while local gates keyed on
 * equilibrium quality / χ_l (C4b) or the wall latch / fWet (C3, A1/A2a) fail
 * or are degenerate.  This module implements the smallest general model of
 * that finding: a transported scalar
 *
 *     a_i ∈ [0,1]   — cryogenic front fraction of fluid node i
 *
 * the fraction of the node's fluid inventory that is ADVECTED
 * cryogenic-inlet fluid (fluid that entered through a flagged cryogenic
 * inlet boundary since t = 0).  It is deliberately NOT:
 *   - the equilibrium quality x_e(h) or the TT-WF liquid availability
 *     χ_l(h) (those are functions of the local enthalpy — the enthalpy tail
 *     is exactly the wrong signal, C4b);
 *   - the wall wetted fraction fWet / rewet latch (wall-side markers driven
 *     by wall cooling — the C3 wrong-signal control);
 *   - a vapor temperature.
 * a carries only the information "displaced cryogenic inlet fluid has
 * arrived here", advanced by the ACCEPTED mass fluxes alone.
 *
 * ============================================================================
 * TRANSPORT EQUATION (conservative, upwind, backward Euler)
 * ============================================================================
 * Per internal node i with (mixture) mass m_i = ρ_i·V_i:
 *
 *     d(m_i a_i)/dt = Σ_in mdot·a_up − Σ_out mdot·a_i
 *
 * discretized fully implicitly (backward Euler) with donor-cell upwinding on
 * the ACCEPTED end-of-step state:
 *
 *     (m_i^{n+1} a_i^{n+1} − m_i^n a_i^n)/dt
 *       = Σ_j∈in(i)  mdot_j^{n+1}·a_up(j)^{n+1}      (a_up = upwind node's a,
 *       − Σ_j∈out(i) |mdot_j^{n+1}|·a_i^{n+1}          or the boundary value)
 *
 * The unknowns a^{n+1} satisfy a linear M-matrix system (assembly below) that
 * is solved directly (dense Gaussian elimination with partial pivoting).
 * Properties (proofs in docs/fluid-front-transport.md):
 *   - CONSERVATION: summing the nodal equations telescopes internal fluxes
 *     exactly, so total tracer mass changes only through boundary in/outflow
 *     — including under flow reversal (upwinding follows the mdot sign).
 *   - BOUNDEDNESS: 0 ≤ a^n, a_bnd ≤ 1 ⇒ 0 ≤ a^{n+1} ≤ 1 in exact arithmetic
 *     whenever the nodal mass balance Σ_in − Σ_out = (m^{n+1} − m^n)/dt
 *     holds — i.e. at a CONVERGED accepted step of the solver.  No
 *     calibration-speed or smoothing knob exists anywhere: the front moves
 *     at the mass-conservation speed of the accepted flow, and the only
 *     numerical diffusion is the donor-cell/upwind + backward-Euler
 *     truncation of the DISCRETIZATION (first-order Godunov-type smearing
 *     over one cell per step — a fixed, documented discretization choice,
 *     not a tunable parameter).
 *   - A post-solve guard clamps roundoff-class excursions (|δ| ≤ 1e−12) and
 *     COUNTS any larger correction (diagnostics: boundsClampCount) — a
 *     non-conservative event that must be 0 in every nominal run.
 *
 * ============================================================================
 * LIFECYCLE (mirrors the TT-WF fWet/latch discipline exactly)
 * ============================================================================
 * The state lives in SolverContext.fluidFront (NOT in StepState) and is
 * mutated ONLY by updateFluidFrontStates (solver.ts), which transient.ts
 * calls together with updateConductorLatches:
 *   - dt omitted  ⇒ t = 0 initialization: a_i = 0 (warm-filled line), and
 *     the previous-accepted node masses m_i^n are seeded from the IC;
 *   - dt = accepted step size ⇒ ONE conservative commit at the accepted
 *     state (mdots, densities) per accepted step.
 * Newton/outer iterations, adaptive step-doubling trials, rejected steps,
 * and aborted runs never touch the state: trial solves only READ the frozen
 * accepted a (through the gate below), and their proposals die with the
 * discarded evaluation results.  Adaptive trials therefore need no cloning
 * of a — the commit point is after acceptance only.
 *
 * ============================================================================
 * THE HEAT-EXCHANGE GATE (TT-WF dry side only)
 * ============================================================================
 * For ttWf conductors with correlation.fluidFront: true, the DRY-side
 * film/SP flux of the area average is multiplied by the smooth gate
 *
 *     g(a) = smoothstep(a) = a²(3 − 2a)      (C1 on [0,1], g(0)=0, g(1)=1,
 *                                              zero slope at both ends)
 *
 *     q_bar' = (1 − fWet)·g(a)·q_Dry + fWet·q_Wet
 *
 * evaluated at the conductor's fluid node's ACCEPTED a (frozen mid-step).
 * The wet side (DB/NB/TB), the node's enthalpy/quality, and the TT-WF
 * front-evolution machinery are NOT touched: this is a closure for the
 * UNRESOLVED relation between the cold-vapor/front state and wall exchange
 * (the real gas column ahead of the front does not thermalize the wall —
 * see the diagnosis doc §1), not a change to the fluid's energy budget
 * structure: gating q changes WHAT energy is exchanged, and a carries the
 * arrival information.  A fully wetted conductor (fWet = 1) is unaffected.
 * A closed gate (g = 0 exactly, i.e. a = 0) returns h = 0 BEFORE the
 * fallback-h floor and under-relaxation — "closed" means zero heat
 * exchange, not ~5 W/m²K of floor leakage.  The gate has NO fitted
 * threshold: smoothstep's bounds are [0,1] by definition.
 *
 * Phase boundary: NO NBS fitting/tuning/evaluation is performed with this
 * state yet (docs/fluid-front-transport.md).
 */

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/** Roundoff guard for the post-solve bounds check (see module header). */
export const FLUID_FRONT_BOUNDS_TOL = 1e-12;

/**
 * The dry-side gate g(a) = a²(3 − 2a) — the C1 smoothstep on [0,1]:
 * g(0) = 0 (no cryogenic inventory ⇒ no dry-side wall exchange), g(1) = 1
 * (full D-H dry-side map), zero slope at both ends (no kink into the h-map
 * as the front opens/closes the gate).  The input is clamped defensively;
 * the state itself is bounded by construction (module header).
 */
export function fluidFrontGate(a: number): number {
  const x = Math.min(1, Math.max(0, a));
  return x * x * (3 - 2 * x);
}

// ---------------------------------------------------------------------------
// Shared accepted-step state (owned by SolverContext; see module header)
// ---------------------------------------------------------------------------

/**
 * Accepted-step fluid-front state.  `a` and `prevMass` are mutated ONLY by
 * updateFluidFrontStates at step boundaries; everything else is immutable
 * per solve (config geometry).
 */
export interface FluidFrontSharedState {
  /** Accepted cryogenic front fraction a_i ∈ [0,1] per internal node id. */
  a: Map<string, number>;
  /**
   * Boundary input value a_bnd ∈ [0,1] per boundary node id (from the
   * node's `fluidFrontInlet` config field; absent ⇒ 0).  Used ONLY as the
   * upwind value of flow ENTERING the domain — an outflow through the
   * boundary carries the internal node's a (pure upwind, reversal-safe).
   */
  boundary: Map<string, number>;
  /** Ordered internal node ids (the transport unknowns). */
  nodeIds: string[];
  /**
   * Node fluid mass m_i = ρ_i·V_i [kg] at the PREVIOUS accepted state
   * (the a^n storage partner of the BE update).  Seeded from the IC at
   * t = 0 and re-recorded at every accepted-step commit.
   */
  prevMass: Map<string, number>;
}

// ---------------------------------------------------------------------------
// Conservative upwind backward-Euler advection (pure kernel)
// ---------------------------------------------------------------------------

export interface FluidFrontAdvectionInput {
  /** Internal node ids, defining the unknown ordering. */
  nodeIds: string[];
  /** Network branches (endpoint ids only). */
  branches: Array<{ from: string; to: string }>;
  /** ACCEPTED end-of-step branch mass flow rates [kg/s] (sign: from → to). */
  mdots: number[];
  /** Node fluid mass m_i^{n+1} = ρ_i·V_i [kg] at the accepted state (0 ⇒
   *  a zero-storage node: the BE equation degenerates to the algebraic
   *  well-mixed pass-through Σ_in mdot·a_up = Σ_out mdot·a_i). */
  mass: Map<string, number>;
  /** Node fluid mass m_i^n [kg] at the previous accepted state. */
  prevMass: Map<string, number>;
  /** Accepted previous fractions a_i^n. */
  aPrev: Map<string, number>;
  /** Boundary input values a_bnd (missing boundary ⇒ 0). */
  boundary: Map<string, number>;
  /** Accepted step size dt > 0 [s]. */
  dt: number;
}

export interface FluidFrontAdvectionResult {
  /** Next accepted fractions a_i^{n+1} ∈ [0,1] per internal node id. */
  aNext: Map<string, number>;
  /**
   * Number of nodes whose solved value lay outside [0,1] by MORE than the
   * roundoff guard FLUID_FRONT_BOUNDS_TOL and was clamped — a
   * NON-conservative correction (must be 0 in every nominal run; counted
   * in diagnostics by the caller).
   */
  boundsClampCorrections: number;
}

/** Dense Gaussian elimination with partial pivoting (the M-matrix system is
 *  small — one unknown per internal node — and column diagonally dominant). */
function solveDenseSystem(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    let maxVal = Math.abs(M[i][i]);
    for (let k = i + 1; k < n; k++) {
      const v = Math.abs(M[k][i]);
      if (v > maxVal) {
        maxVal = v;
        maxRow = k;
      }
    }
    if (maxVal < 1e-300) {
      // Singular row guard: unreachable by construction (the assembly floors
      // the diagonal at 1 for isolated/zero-storage nodes); defensive only.
      M[i][i] = 1e-300;
    } else {
      [M[i], M[maxRow]] = [M[maxRow], M[i]];
    }
    for (let k = i + 1; k < n; k++) {
      const factor = M[k][i] / M[i][i];
      for (let j = i; j <= n; j++) {
        M[k][j] -= factor * M[i][j];
      }
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n];
    for (let j = i + 1; j < n; j++) {
      sum -= M[i][j] * x[j];
    }
    x[i] = sum / M[i][i];
  }
  return x;
}

/**
 * One ACCEPTED-step conservative advection of the front fraction:
 * solves the backward-Euler upwind system of the module header for
 * a^{n+1}.  PURE: maps in, new map out, no globals, no counters.
 *
 * Throws on non-finite or out-of-domain input (never silently repairs):
 * the solver wrapper catches, keeps the previous accepted state, and counts
 * an invalidInput event (same robustness pattern as the TT-WF commit).
 */
export function advectFluidFrontUpwindBE(
  input: FluidFrontAdvectionInput,
): FluidFrontAdvectionResult {
  const { nodeIds, branches, mdots, mass, prevMass, aPrev, boundary, dt } =
    input;
  const n = nodeIds.length;
  if (!Number.isFinite(dt) || dt <= 0)
    throw new Error(`fluidFront advection: dt must be finite > 0 (got ${dt})`);
  const index = new Map<string, number>();
  nodeIds.forEach((id, i) => index.set(id, i));
  const a0 = new Array(n).fill(0);
  const mNew = new Array(n).fill(0);
  const mOld = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const id = nodeIds[i];
    const ap = aPrev.get(id) ?? 0;
    const mn = mass.get(id) ?? 0;
    const mo = prevMass.get(id) ?? 0;
    if (
      !Number.isFinite(ap) ||
      ap < -FLUID_FRONT_BOUNDS_TOL ||
      ap > 1 + FLUID_FRONT_BOUNDS_TOL
    )
      throw new Error(
        `fluidFront advection: aPrev[${id}] must be in [0,1] (got ${ap})`,
      );
    if (!Number.isFinite(mn) || mn < 0)
      throw new Error(
        `fluidFront advection: mass[${id}] must be finite >= 0 (got ${mn})`,
      );
    if (!Number.isFinite(mo) || mo < 0)
      throw new Error(
        `fluidFront advection: prevMass[${id}] must be finite >= 0 (got ${mo})`,
      );
    a0[i] = ap;
    mNew[i] = mn;
    mOld[i] = mo;
  }
  for (let j = 0; j < branches.length; j++) {
    if (!Number.isFinite(mdots[j]))
      throw new Error(
        `fluidFront advection: mdots[${j}] must be finite (got ${mdots[j]})`,
      );
  }
  for (const [id, ab] of boundary) {
    if (
      !Number.isFinite(ab) ||
      ab < -FLUID_FRONT_BOUNDS_TOL ||
      ab > 1 + FLUID_FRONT_BOUNDS_TOL
    )
      throw new Error(
        `fluidFront advection: boundary[${id}] must be in [0,1] (got ${ab})`,
      );
  }

  // M-matrix assembly:
  //   A_ii = m_i/dt + Σ_out |mdot|            (> 0 whenever storage or outflow)
  //   A_ij = −(inflow rate from internal neighbor j)
  //   b_i  = (m_i^n/dt)·a_i^n + Σ_{boundary inflows} mdot·a_bnd
  const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    A[i][i] = mNew[i] / dt;
    b[i] = (mOld[i] / dt) * a0[i];
  }
  for (let j = 0; j < branches.length; j++) {
    const mdot = mdots[j];
    if (mdot === 0) continue;
    const { from, to } = branches[j];
    // Upwind decomposition: mdot > 0 carries `from`'s a to `to`;
    // mdot < 0 carries `to`'s a to `from` (reversal via upwinding).
    const up = mdot > 0 ? from : to;
    const dn = mdot > 0 ? to : from;
    const rate = Math.abs(mdot);
    // The link is an OUTFLOW from the upwind node and an INFLOW to the
    // downstream node.
    const iUp = index.get(up);
    if (iUp !== undefined) A[iUp][iUp] += rate; // outflow diagonal: −|mdot|·a_up
    const iDn = index.get(dn);
    if (iDn === undefined) continue; // boundary → boundary branch: no unknown
    if (iUp !== undefined) {
      A[iDn][iUp] -= rate; // inflow from an internal upwind neighbor
    } else {
      b[iDn] += rate * (boundary.get(up) ?? 0); // inflow from a boundary
    }
  }
  // Degenerate-row guard: a node with no storage and no through-flow
  // (isolated, or a zero-volume node at zero flow) keeps its accepted value.
  for (let i = 0; i < n; i++) {
    if (A[i][i] <= 0) {
      for (let j = 0; j < n; j++) A[i][j] = 0;
      A[i][i] = 1;
      b[i] = a0[i];
    }
  }

  const x = solveDenseSystem(A, b);

  // Bounds: by construction a^{n+1} ∈ [0,1] in exact arithmetic (module
  // header).  Guard only against roundoff; a larger excursion is a real
  // (counted, non-conservative) correction.
  let boundsClampCorrections = 0;
  const aNext = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    let v = x[i];
    if (v < 0 || v > 1) {
      const clamped = Math.min(1, Math.max(0, v));
      if (Math.abs(clamped - v) > FLUID_FRONT_BOUNDS_TOL)
        boundsClampCorrections++;
      v = clamped;
    }
    aNext.set(nodeIds[i], v);
  }
  return { aNext, boundsClampCorrections };
}

// ---------------------------------------------------------------------------
// Tracer-budget helpers (test/audit support — pure functions of the same
// conventions; the conservation tests integrate these over recorded series)
// ---------------------------------------------------------------------------

/**
 * Net tracer influx into the internal domain at one accepted state [kg/s of
 * tracer]: Σ over boundary-touching branches of ±mdot·a_up with the upwind
 * convention (inflow carries the boundary value, outflow carries the
 * internal node's a).  The per-step tracer conservation identity is
 *
 *   Σ_i (m_i a_i)^{n+1} − Σ_i (m_i a_i)^n = dt · boundaryTracerInflux^{n+1}
 *
 * exactly (internal fluxes telescope), so a right-rectangle integral of this
 * over a recorded run must equal the recorded tracer-inventory change.
 */
export function fluidFrontBoundaryInflux(
  branches: Array<{ from: string; to: string }>,
  mdots: number[],
  a: Map<string, number>,
  boundary: Map<string, number>,
  internalIds: Set<string>,
): number {
  let net = 0;
  for (let j = 0; j < branches.length; j++) {
    const mdot = mdots[j];
    if (mdot === 0) continue;
    const { from, to } = branches[j];
    const up = mdot > 0 ? from : to;
    const dn = mdot > 0 ? to : from;
    const dnInternal = internalIds.has(dn);
    const upInternal = internalIds.has(up);
    if (dnInternal && !upInternal) {
      net += Math.abs(mdot) * (boundary.get(up) ?? 0); // boundary → internal
    } else if (!dnInternal && upInternal) {
      net -= Math.abs(mdot) * (a.get(up) ?? 0); // internal → boundary
    }
  }
  return net;
}
