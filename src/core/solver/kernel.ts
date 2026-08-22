/**
 * The Newton kernel: the nonlinear residual R(x) of one solve attempt and
 * its two Jacobian builders.
 *
 * Unknown vector x is laid out by the DofMap in ./dofMap.ts:
 *   internal-node pressures P [Pa], branch mass flows ṁ [kg/s], then a packed
 *   energy block holding each participating node's h [J/kg] (real-fluid
 *   extended system) or T [K] (coupled compressible system).  Column indices
 *   come from `dof`, never from block arithmetic, so a node whose energy is
 *   advanced by the segregated outer loop simply occupies no energy column.
 *
 * Residual rows follow the same layout:
 *   mass rows      — Σṁ into node − storage dρV/dt (transient),
 *   momentum rows  — P_from − P_to − dP(ṁ, …) − accel − inertia
 *                    (component closures: FlowSource/orifice/venturi/
 *                    regulator rows are ṁ − ṁ_expected instead),
 *   energy rows    — enthalpy flux + heat sources − d(m·u)/dt.
 *
 * Jacobian builders:
 *   numericalJacobian — column-by-column finite differences with dome-aware
 *     step heuristics (see fdJacobianColumn).
 *   hybridJacobian    — exact dual-number derivatives everywhere the
 *     residual is differentiable, with per-entry FD patches for the
 *     genuinely non-differentiable pieces.  For real fluids a per-build
 *     property cache reduces CoolProp calls from O(nodes × columns) to
 *     O(nodes).
 *
 * Both builders are exposed through `probeJacobians` so tests can compare
 * them entry by entry at an arbitrary state.
 */
import type { ConductorEntry, SolverContext, StepState } from "./types";
import { heatInputOf } from "./types";
import {
  safeStatePH,
  safeInternalEnergyPH,
  clampToValidPHFor,
} from "./safeProps";
import {
  componentPressureDrop,
  componentPressureDropDual,
} from "./pressureDrop";
import { computeConductorHMap } from "./conductorH";
import { createUniformDofMap } from "./dofMap";
import type { DofMap, EnergyKind } from "./dofMap";
import type { PHState } from "../fluids";
import { RealFluid, getSatProps } from "../fluids/realFluid";
import {
  Pipe,
  FlowSource,
  Regulator,
  OrificeCompressible,
  CavitatingVenturi,
} from "../components";
import { FALLBACK_H_FLOOR } from "../correlations";
import type { Dual } from "../dual";
import { constant, add, sub, mul, div, pow, neg, abs } from "../dual";
import type { SolverJunctionEntry } from "./types";
import {
  recordResidualEval,
  enterJacobian,
  leaveJacobian,
  perfEnabled,
} from "../perf";

/** Environment captured by the Newton kernel factory.  `conductorHMap` is
 *  rebound per outer Picard iteration (h-map under-relaxation), so it is read
 *  through the holder on every residual evaluation rather than captured once. */
export interface NewtonKernelEnv {
  ctx: SolverContext;
  state: StepState;
  dt?: number;
  t?: number;
  prevState?: StepState;
  useExtendedSystem: boolean;
  /** Coupled steady enthalpy system [P, ṁ, h] (settings.kineticEnergy):
   *  every internal node carries an h unknown regardless of EOS class,
   *  properties come from statePH, and the energy rows transport stagnation
   *  enthalpy h₀ = h + v²/2, solved SIMULTANEOUSLY with mass/momentum — the
   *  segregated energy Picard is unstable near choking (the ṁ → T0 →
   *  choking-margin → ṁ feedback has gain > 1, which no under-relaxation
   *  can stabilise), exactly why GFSSP solves its conservation equations
   *  simultaneously.  h is a complete state coordinate everywhere (T is
   *  degenerate in the two-phase dome), so this formulation needs no
   *  ideal-gas closed forms and no per-EOS dispatch.  Mutually exclusive
   *  with useExtendedSystem (real-fluid transient). */
  useCoupledH: boolean;
  /** Column layout of the unknown vector, including `nVar`. */
  dof: DofMap;
  conductorHMap: Map<string, number>;
}

/** Whether a solve uses the coupled steady enthalpy system [P, ṁ, h]
 *  (settings.kineticEnergy, steady only).  Unlike the retired
 *  compressible-T mode it replaced, there is no fluid-class gate: every
 *  FluidModel implements statePH, so any EOS — ideal gas, incompressible,
 *  CoolProp real fluid — rides the same formulation.  Species mixtures keep
 *  the segregated path (composition is not yet a coupled unknown);
 *  transient kineticEnergy solves keep the segregated
 *  frozen-stagnation-T closure. */
export function useCoupledHMode(
  ctx: SolverContext,
  dt: number | undefined,
): boolean {
  return ctx.kineticEnergy && !ctx.hasSpecies && dt === undefined;
}

export interface NewtonKernel {
  computeResidual(x: number[]): number[];
  fdJacobianColumn(x: number[], k: number, R0: number[], J: number[][]): void;
  /** `R0`, when supplied, must be `computeResidual(x)` — the builders use it
   *  instead of re-evaluating the base residual themselves. */
  numericalJacobian(x: number[], R0?: number[]): number[][];
  hybridJacobian(x: number[], R0?: number[]): number[][];
  /** Drop the memoized per-node stagnation temperatures of the compressible
   *  (settings.kineticEnergy) closure.  Must be called whenever the frozen
   *  state maps (nodeT/nodeRho/mdots) change — i.e. once per outer Picard
   *  iteration.  No-op for non-compressible solves. */
  invalidateStagTCache(): void;
}

/** The residual evaluator and the Jacobian builders for one Newton attempt.
 *  Extracted from solveStateStepAttempt so tests (and diagnostics) can build
 *  the same kernel at an arbitrary state and compare the two Jacobian paths
 *  entry by entry.  Behaviour is identical to the former closures: every
 *  function reads the same env fields the closures captured. */
export function makeKernel(env: NewtonKernelEnv): NewtonKernel {
  const { ctx, state, dt, t, prevState, useExtendedSystem, useCoupledH, dof } =
    env;
  const { nodeMap, internalIds, internalIndex, branches, nInt, nBranch } = ctx;
  const nVar = dof.nVar;
  const fluidOf = (id: string) => ctx.fluidAssignment.node(id);
  const rfOf = (id: string) => ctx.fluidAssignment.node(id) as RealFluid;
  /** Enthalpy is the primary energy state: h columns exist (coupled) —
   *  real-fluid transient extended system or the coupled steady h-system. */
  const hPrimary = useExtendedSystem || useCoupledH;
  /** Node properties come from statePH(P, h) rather than (P, T), decided
   *  PER NODE: real-fluid nodes always (their h is authoritative even when
   *  segregated), and every node when the vector carries h columns (coupled
   *  h-system or extended transient — the column is fresher than any frozen
   *  T).  In a single-EOS network this is constant across nodes and matches
   *  the retired global `usePH` flag exactly; it only genuinely varies in a
   *  mixed-EOS network, where analytic nodes solved segregatedly must keep
   *  their frozen-T property path (their state.nodeH lags the T update).
   *
   *  Tabulated at build: the answer is a static property of the node
   *  (`hPrimary` is fixed for the attempt, and a node's EOS CLASS cannot
   *  change during a solve — the outer loop may swap a junction's product-gas
   *  model, but only ever for another IdealGas), while the query sits in the
   *  innermost residual loops. */
  const computeUsePH = (id: string): boolean =>
    hPrimary || fluidOf(id) instanceof RealFluid;
  const usePHByNode = new Map<string, boolean>();
  for (const id of nodeMap.keys()) usePHByNode.set(id, computeUsePH(id));
  const usePHFor = (id: string): boolean =>
    usePHByNode.get(id) ?? computeUsePH(id);
  /** Whether ANY node reads properties through statePH — gates building the
   *  per-Jacobian-build property cache. */
  const anyPH = ctx.isRealFluid || useCoupledH;
  /** Column holding this node's energy unknown, but only when that unknown is
   *  of `kind`.  `undefined` means the node's energy of that kind is not a
   *  Newton unknown here — it is frozen state or segregated. */
  const energyColOf = (nodeId: string, kind: EnergyKind): number | undefined =>
    dof.energyKind(nodeId) === kind ? dof.energyCol(nodeId) : undefined;

  // ── Compressible (settings.kineticEnergy) static-temperature closure ──────
  //
  // The segregated scheme freezes nodal temperature during the inner Newton
  // solve.  For a compressible duct that is fatal: with T frozen the momentum
  // subsystem behaves ISOTHERMALLY and chokes at M = 1/√γ ≈ 0.85, so the
  // subsonic solution at higher Mach (Fanno/Rayleigh flow approaches M = 1 at
  // the exit) does not exist for the frozen-T equations and Newton lands on a
  // spurious supersonic root instead.  Fix: freeze the STAGNATION temperature
  // T0 (which the outer energy update conserves/transports) and let the
  // static temperature respond to the iterate's P and ṁ through the exact
  // ideal-gas closure
  //     T_s = T0 − v²/(2cp),  v = ṁ/(ρA),  ρ = P/(R·T_s)
  //  ⇒  a·T_s² + T_s − T0 = 0,  a = (ṁR/(P·A))²/(2cp)
  //  ⇒  T_s = 2·T0 / (1 + √(1 + 4·a·T0))   (continuous-subsonic root).
  // The resulting momentum subsystem chokes at M = 1, as it must.  This is
  // the SEGREGATED (transient) closure only — steady kineticEnergy solves
  // take the coupled h-system (useCoupledH above), where static h is a
  // Newton unknown and ρ(P, h) carries the same Mach coupling exactly, for
  // every EOS.  Applies only to the analytic ideal-gas path (fluids
  // carrying R and γ); real fluid, species mixtures, and fluids without
  // R/γ keep the frozen static T.
  const compressibleKE =
    ctx.kineticEnergy && !ctx.isRealFluid && !ctx.hasSpecies && !useCoupledH;

  // ── Reacting junctions (config.junctions, coupled steady h-system only) ──
  //
  // A junction node's energy row is REPLACED by the thermochemical closure
  //     R = (h_node − η · h(T0(Pc, ṁ_roles))) / max(|h_target|, 1e4)
  // where Pc is the node's own pressure DOF and the per-role mass flows are
  // Σ|ṁ| over that role's inlet branches — all Newton unknowns, so the
  // divergent Pc → injector ΔP → ṁ → T0 → Pc loop of the retired outer
  // fixed-point driver lives entirely inside the Jacobian.  Normalisation
  // mirrors the degenerate-node h-pin convention (dimensionless, O(1)).
  //
  // Junction INLET branches join unlike fluids (reactant feed → product
  // node), so their momentum closure keeps the UPSTREAM (reactant) density
  // only: the cross-fluid harmonic-mean friction density and the
  // momentum-flux acceleration term would otherwise mix a liquid and a hot
  // gas across the injection face, where the density jump is combustion,
  // not duct acceleration — the injector component model already carries
  // the whole ΔP.
  const junctionByNode = new Map<string, SolverJunctionEntry>();
  const junctionInletBranches = new Set<number>();
  for (const jn of ctx.junctions) {
    junctionByNode.set(jn.nodeId, jn);
    for (const idx of jn.inletBranchIdx) junctionInletBranches.add(idx);
  }

  /** settings.momentumFluxScheme (schema.ts): donor-cell momentum advection
   *  (default) vs the legacy central endpoint form. */
  const upwindFlux = ctx.momentumFluxScheme === "upwind";
  /** Branches the upwind scheme applies to: areal, non-junction-inlet
   *  branches of a COMPRESSIBLE fluid — ideal gases (R and γ defined)
   *  always, real (PH) fluids when settings.kineticEnergy is on.  The
   *  expansion-shock twin roots the scheme exists to remove are a property
   *  of compressibility, not of any one EOS: whenever the momentum row's
   *  downwind density responds to the downwind state through a
   *  Mach-dependent closure, near M = 1 that response is double-valued (a
   *  subsonic and a supersonic density satisfy the same integral balance).
   *  For ideal gases the coupling is ρ = P/(R·T_s) with T_s from the
   *  static-state recovery (steady coupled-h: ρ(P, h) with static h a
   *  Newton unknown fluxed as h + v²/2; transient: staticTFromStag above).
   *  Real fluids carry the SAME coupling on the kineticEnergy path — their
   *  static h is the energy unknown and ρ(P, h) comes from statePH — so
   *  they can choke emergently and need the upwind faces just as much.
   *  Without kineticEnergy there is no Mach coupling (ρ has no velocity
   *  dependence), hence no twin roots, and real-fluid branches keep the
   *  central endpoint form bit-identically.  Liquids never have the
   *  nonlinearity, and species mixtures keep the segregated ρ(P, T, Y)
   *  path.  For everything excluded, the central form is the exact
   *  integral balance (e.g. it resolves area steps between adjacent
   *  branches within the branch that owns them) with no upwind truncation
   *  error. */
  //  Every input is fixed for the attempt, so the predicate is tabulated per
  //  branch once instead of re-deciding it inside each momentum row.
  const upwindEligibleTable = branches.map((bb, k): boolean => {
    if (bb.component.area === undefined) return false;
    if (junctionInletBranches.has(k)) return false;
    const f = ctx.fluidAssignment.branch(bb.id);
    if (f.R !== undefined && f.gamma !== undefined) return true;
    return ctx.kineticEnergy && f instanceof RealFluid;
  });
  const upwindEligible = (k: number): boolean => upwindEligibleTable[k];
  /** Static incidence for the upwind momentum-flux stencil: per node, the
   *  eligible branches that can advect momentum through it. */
  const arealIncident = (() => {
    const m = new Map<string, number[]>();
    branches.forEach((bb, k) => {
      if (!upwindEligible(k)) return;
      for (const n of [bb.from, bb.to]) {
        const list = m.get(n) ?? [];
        list.push(k);
        m.set(n, list);
      }
    });
    return m;
  })();

  // ── Junction per-role inlet mass flows: scalar/dual twin pair ────────────
  //
  // Both closures must sum the SAME branches in the SAME order, or the dual
  // path's derivative belongs to a different function than the scalar path's
  // value; keeping them adjacent is what makes that checkable.  The scalar
  // map is reused across evaluations (one per junction, allocated here):
  // CombustionModel.evaluate reads it synchronously and never retains it.
  const junctionRoleScratch = new Map<string, Map<string, number>>();
  for (const jn of ctx.junctions) {
    junctionRoleScratch.set(jn.nodeId, new Map<string, number>());
  }

  /** Per-role Σ|ṁ| of a junction's inlet branches at the iterate x. */
  function junctionMdotByRole(
    jn: SolverJunctionEntry,
    x: number[],
  ): Map<string, number> {
    const out = junctionRoleScratch.get(jn.nodeId)!;
    for (const [role, idxs] of jn.roleBranches) {
      let sum = 0;
      for (const idx of idxs) sum += Math.abs(x[nInt + idx]);
      out.set(role, sum);
    }
    return out;
  }

  /** Dual twin of `junctionMdotByRole` — same branches, same order, so the
   *  chained derivative matches the scalar value term for term. */
  function junctionMdotByRoleDual(
    jn: SolverJunctionEntry,
    branchMdot: Dual[],
  ): Map<string, Dual> {
    const out = new Map<string, Dual>();
    for (const [role, idxs] of jn.roleBranches) {
      let sum = constant(0);
      for (const idx of idxs) sum = add(sum, abs(branchMdot[idx]));
      out.set(role, sum);
    }
    return out;
  }

  function staticTFromStag(
    T0: number,
    P: number,
    mdot: number,
    A: number,
    R: number,
    gamma: number,
  ): number {
    const cp = (gamma * R) / (gamma - 1);
    const q = (mdot * R) / (P * A);
    const a = (q * q) / (2 * cp);
    return (2 * T0) / (1 + Math.sqrt(1 + 4 * a * T0));
  }

  function staticTFromStagDual(
    T0: number,
    P: Dual,
    mdot: Dual,
    A: number,
    R: number,
    gamma: number,
  ): Dual {
    const cp = (gamma * R) / (gamma - 1);
    const q = div(mul(mdot, constant(R)), mul(P, constant(A)));
    const a = div(mul(q, q), constant(2 * cp));
    const s = pow(add(constant(1), mul(constant(4 * T0), a)), constant(0.5));
    return div(constant(2 * T0), add(constant(1), s));
  }

  /** Frozen nodal stagnation temperature for the compressible closure:
   *  T0 = T + v²/(2cp) evaluated from the CURRENT outer state (T, ρ, ṁ),
   *  with v at this node's endpoint of its through-flow branch (outflow side
   *  preferred — same convention as the outer energy update's keOut).
   *  Memoized per outer iteration (the inputs are the frozen state maps,
   *  constant during one inner Newton solve); step.ts invalidates the memo
   *  at each outer via invalidateStagTCache. */
  let stagTCache: Map<string, number> | null = null;
  function nodeStagT(nodeId: string): number {
    if (stagTCache) {
      const cached = stagTCache.get(nodeId);
      if (cached !== undefined) return cached;
    } else {
      stagTCache = new Map();
    }
    const val = computeNodeStagT(nodeId);
    stagTCache.set(nodeId, val);
    return val;
  }
  function computeNodeStagT(nodeId: string): number {
    const T = state.nodeT.get(nodeId)!;
    const bf = fluidOf(nodeId);
    if (bf.R === undefined || bf.gamma === undefined) return T;
    const rho = state.nodeRho.get(nodeId)!;
    if (!(rho > 0)) return T;
    const cp = (bf.gamma * bf.R) / (bf.gamma - 1);
    const endpointArea = (j: number, outflow: boolean): number | undefined => {
      const b = branches[j];
      const comp = b.component;
      if (comp.area === undefined || !(comp.area > 0)) return undefined;
      const md = state.mdots[j];
      if (outflow) {
        if (b.from === nodeId && md > 0) return comp.area;
        if (b.to === nodeId && md < 0) return comp.areaOut ?? comp.area;
      } else {
        if (b.to === nodeId && md > 0) return comp.areaOut ?? comp.area;
        if (b.from === nodeId && md < 0) return comp.area;
      }
      return undefined;
    };
    for (const outflow of [true, false]) {
      for (let j = 0; j < nBranch; j++) {
        const A = endpointArea(j, outflow);
        if (A !== undefined) {
          const v = state.mdots[j] / (rho * A);
          return T + (v * v) / (2 * cp);
        }
      }
    }
    return T;
  }

  /** Nodal pressure at the iterate: the node's own column when it is
   *  internal, its frozen boundary value otherwise.  `internalIndex` answers
   *  both questions at once — a node has a pressure column exactly when it is
   *  internal — so this replaces a nodeMap lookup plus a string compare plus a
   *  second lookup with a single lookup at every branch endpoint. */
  const pressureAt = (id: string, intP: number[]): number => {
    const col = internalIndex.get(id);
    return col === undefined ? state.nodeP.get(id)! : intP[col];
  };

  function nodeHFromX(nodeId: string, x: number[]): number {
    const col = energyColOf(nodeId, "h");
    if (col !== undefined) return x[col];
    // No column (boundary node, or segregated energy): frozen state.  The
    // enthalpyPT fallback covers analytic nodes whose state map predates the
    // coupled h-system and carries no h entry.
    const h = state.nodeH?.get(nodeId);
    if (h !== undefined) return h;
    return fluidOf(nodeId).enthalpyPT(
      state.nodeP.get(nodeId)!,
      state.nodeT.get(nodeId)!,
    );
  }

  /** Per-internal-node energy-row scale for the coupled steady h-system [W],
   *  fixed per kernel build so the enthalpy-balance residual is dimensionless
   *  and the legacy raw-norm convergence bar (norm ≲ tol) stays meaningful:
   *  ~tol relative to the node's enthalpy throughput.  (The extended
   *  transient system keeps raw Watts instead: its convergence bars were
   *  tuned for that.) */
  // ── Static per-internal-node incidence for the nodal balances ────────────
  //
  // A nodal row only ever touches the branches and conductors attached to its
  // node, so the balances walk these lists rather than filtering the whole
  // network per node (see SolverContext.incidentBranches for why that matters
  // and for the branch-order contract that keeps the sums bit-identical).
  /** Branches attached to internal node i, ascending branch index. */
  const incidentOf: number[][] = [];
  /** Signed mass-row incidence: the (branch, sign) pairs that node i's Σṁ row
   *  sums.  A branch whose two endpoints are the SAME node contributes both
   *  its −1 and its +1 entry, in that order — exactly the order the
   *  full-branch scan visited them in. */
  const massIncidentIdx: number[][] = [];
  const massIncidentSign: number[][] = [];
  /** Attached branches carrying a getBranchHeat closure (usually none). */
  const branchHeatIncidentOf: number[][] = [];
  /** Convection conductors attached to internal node i, in `conductors`
   *  order. */
  const convectionIncidentOf: ConductorEntry[][] = [];
  for (let i = 0; i < nInt; i++) {
    const nodeId = internalIds[i];
    const incident = ctx.incidentBranches.get(nodeId) ?? [];
    incidentOf[i] = incident;
    const idx: number[] = [];
    const sign: number[] = [];
    for (const j of incident) {
      const b = branches[j];
      if (b.from === nodeId) {
        idx.push(j);
        sign.push(-1);
      }
      if (b.to === nodeId) {
        idx.push(j);
        sign.push(1);
      }
    }
    massIncidentIdx[i] = idx;
    massIncidentSign[i] = sign;
    branchHeatIncidentOf[i] = incident.filter(
      (j) => branches[j].component.getBranchHeat !== undefined,
    );
    convectionIncidentOf[i] = ctx.convectionConductors.get(nodeId) ?? [];
  }

  const hPowerRef: number[] = [];
  if (useCoupledH) {
    for (let i = 0; i < nInt; i++) {
      const nodeId = internalIds[i];
      let mRef = 0.1;
      for (const j of incidentOf[i]) {
        mRef = Math.max(mRef, Math.abs(state.mdots[j]));
      }
      const hRef =
        state.nodeH?.get(nodeId) ??
        fluidOf(nodeId).enthalpyPT(
          state.nodeP.get(nodeId)!,
          state.nodeT.get(nodeId)!,
        );
      hPowerRef[i] = Math.max(
        1,
        Math.abs(heatInputOf(ctx, nodeMap.get(nodeId)!)),
        mRef * Math.max(Math.abs(hRef), 1e4),
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Scalar residual
  // ────────────────────────────────────────────────────────────────────────
  function computeResidual(x: number[]): number[] {
    if (perfEnabled) recordResidualEval();
    const R = new Array(nVar).fill(0);
    const intP = new Array(nInt).fill(0);
    for (let i = 0; i < nInt; i++) intP[i] = x[i];
    const branchMdot = new Array(nBranch).fill(0);
    for (let j = 0; j < nBranch; j++) branchMdot[j] = x[nInt + j];

    for (let i = 0; i < nInt; i++) {
      const nodeId = internalIds[i];
      let sum = 0;
      const massIdx = massIncidentIdx[i];
      const massSign = massIncidentSign[i];
      for (let k = 0; k < massIdx.length; k++) {
        sum += massSign[k] * branchMdot[massIdx[k]];
      }
      if (dt !== undefined && prevState !== undefined) {
        const node = nodeMap.get(nodeId)!;
        const V = node.volume ?? 0;
        const gc = node.gasCushion;
        if (gc) {
          const Pcurr = intP[i];
          const Pprev = prevState.nodeP.get(nodeId)!;
          const Tcurr = state.nodeT.get(nodeId)!;
          let rhoCurr: number;
          if (ctx.hasSpecies && ctx.mixtureFluid && state.nodeY) {
            const Y = state.nodeY.get(nodeId)!;
            rhoCurr = ctx.mixtureFluid.densityMix(Pcurr, Tcurr, Y);
          } else {
            rhoCurr = fluidOf(nodeId).density(Pcurr, Tcurr);
          }
          const P0 = node.pressure ?? Pcurr;
          const n = gc.polytropicIndex;
          const Vg0 = gc.initialGasVolume;
          const C = P0 * Math.pow(Vg0, n);
          const Vg_curr = Math.pow(C / Pcurr, 1 / n);
          const Vg_prev = Math.pow(C / Pprev, 1 / n);
          const Vw_curr = V - Vg_curr;
          const Vw_prev = V - Vg_prev;
          R[i] = sum - (rhoCurr * (Vw_curr - Vw_prev)) / dt;
        } else {
          const Pcurr = intP[i];
          if (usePHFor(nodeId)) {
            const hcurr = nodeHFromX(nodeId, x);
            const phCurr = safeStatePH(
              fluidOf(nodeId),
              Pcurr,
              hcurr,
              `node ${nodeId} mass residual`,
            );
            const rhoCurr = phCurr.rho;
            const rhoPrev = prevState.nodeRho.get(nodeId)!;
            R[i] = sum - ((rhoCurr - rhoPrev) * V) / dt;
          } else {
            const Tcurr = state.nodeT.get(nodeId)!;
            let rhoCurr: number;
            if (ctx.hasSpecies && ctx.mixtureFluid && state.nodeY) {
              const Y = state.nodeY.get(nodeId)!;
              rhoCurr = ctx.mixtureFluid.densityMix(Pcurr, Tcurr, Y);
            } else {
              rhoCurr = fluidOf(nodeId).density(Pcurr, Tcurr);
            }
            const rhoPrev = prevState.nodeRho.get(nodeId)!;
            R[i] = sum - ((rhoCurr - rhoPrev) * V) / dt;
          }
        }
      } else {
        R[i] = sum;
      }
    }

    // Upwind momentum-flux face pass (settings.momentumFluxScheme "upwind"):
    // ONE exit-face velocity per areal branch, shared between its own
    // momentum row and the rows of the branches it feeds, so the flux
    // differences telescope exactly along a chain (staggered-grid
    // consistency — mixing reconstruction orders between the two faces of
    // a row biases the O(Δx) flux difference at O(1) relative error).
    // The exit-face density is MUSCL-limited: donor value plus half a
    // van Albada-limited slope.  Second-order on smooth profiles; at a
    // would-be expansion-shock jump the limiter clips the downwind slope
    // to the upstream one, so a row's sensitivity to its downwind density
    // stays bounded by grid-smooth increments and the spurious root cannot
    // balance.  The face value is clamped between the two node densities
    // (positivity + boundedness, no tunable constants).  Faces without an
    // upstream areal branch (chain entrances, plenums, junction nodes) use
    // the plain downwind density — the same central convention their own
    // row uses via the centralAccel fallback.
    let uFaceArr: number[] | undefined;
    let feedersArr: number[][] | undefined;
    if (ctx.momentumFlux && upwindFlux) {
      const nodePx = (id: string): number => pressureAt(id, intP);
      const rhoAtNode = (
        nodeId: string,
        Aend: number,
        mdotKE: number,
      ): number => {
        const P = nodePx(nodeId);
        if (usePHFor(nodeId)) {
          return safeStatePH(
            fluidOf(nodeId),
            P,
            nodeHFromX(nodeId, x),
            `node ${nodeId} momentum flux`,
          ).rho;
        }
        let T = state.nodeT.get(nodeId)!;
        if (ctx.hasSpecies && ctx.mixtureFluid && state.nodeY) {
          return ctx.mixtureFluid.densityMix(P, T, state.nodeY.get(nodeId)!);
        }
        const nf = fluidOf(nodeId);
        if (compressibleKE && nf.R !== undefined && nf.gamma !== undefined) {
          T = staticTFromStag(
            nodeStagT(nodeId),
            P,
            mdotKE,
            Aend,
            nf.R,
            nf.gamma,
          );
        }
        return nf.density(P, T);
      };
      uFaceArr = new Array(nBranch).fill(0);
      feedersArr = new Array(nBranch);
      const rhoDonArr = new Array(nBranch).fill(0);
      for (let j = 0; j < nBranch; j++) {
        feedersArr[j] = [];
        if (!upwindEligible(j)) continue;
        const b = branches[j];
        const mdotJ = branchMdot[j];
        const aIn = b.component.area!;
        const aOut = b.component.areaOut ?? aIn;
        const donor = mdotJ >= 0 ? b.from : b.to;
        rhoDonArr[j] = rhoAtNode(donor, mdotJ >= 0 ? aIn : aOut, mdotJ);
        for (const i of arealIncident.get(donor) ?? []) {
          if (i === j) continue;
          const mi = branchMdot[i];
          if (!(Math.abs(mi) > 0)) continue;
          const bi = branches[i];
          const flowsIn = mi >= 0 ? bi.to === donor : bi.from === donor;
          if (flowsIn) feedersArr[j].push(i);
        }
      }
      for (let j = 0; j < nBranch; j++) {
        if (!upwindEligible(j)) continue;
        const b = branches[j];
        const mdotJ = branchMdot[j];
        const aIn = b.component.area!;
        const aOut = b.component.areaOut ?? aIn;
        const dwn = mdotJ >= 0 ? b.to : b.from;
        const exitA = mdotJ >= 0 ? aOut : aIn;
        const rhoDwn = rhoAtNode(dwn, exitA, mdotJ);
        let rhoFace = rhoDwn;
        const feeders = feedersArr[j];
        if (feeders.length > 0) {
          const rhoDon = rhoDonArr[j];
          let sumM = 0;
          let sumMRho = 0;
          for (const i of feeders) {
            const am = Math.abs(branchMdot[i]);
            sumM += am;
            sumMRho += am * rhoDonArr[i];
          }
          const dUp = rhoDon - sumMRho / sumM;
          const dDn = rhoDwn - rhoDon;
          const phi =
            dUp * dDn > 0
              ? (dUp * dDn * (dUp + dDn)) / (dUp * dUp + dDn * dDn)
              : 0;
          const lo = Math.min(rhoDon, rhoDwn);
          const hi = Math.max(rhoDon, rhoDwn);
          rhoFace = Math.min(hi, Math.max(lo, rhoDon + 0.5 * phi));
        }
        uFaceArr[j] = Math.abs(mdotJ) / (rhoFace * exitA);
      }
    }

    for (let j = 0; j < nBranch; j++) {
      const b = branches[j];
      const mdot = branchMdot[j];
      const pFrom = pressureAt(b.from, intP);
      const pTo = pressureAt(b.to, intP);

      if (b.component instanceof FlowSource) {
        R[nInt + j] = mdot - b.component.getMdot(t);
        continue;
      }

      const upNode = mdot >= 0 ? b.from : b.to;
      const upP = pressureAt(upNode, intP);
      let rho: number;
      let mu: number;
      let upT: number;
      if (usePHFor(upNode)) {
        const upH = nodeHFromX(upNode, x);
        const phUp = safeStatePH(
          fluidOf(upNode),
          upP,
          upH,
          `branch ${b.id} upstream`,
        );
        rho = phUp.rho;
        mu = phUp.mu;
        upT = phUp.T;
        if (useCoupledH && ctx.kineticEnergy && !junctionInletBranches.has(j)) {
          // Friction ΔP ∝ ∫G²/ρ dx: the harmonic mean of the endpoint
          // densities integrates 1/ρ to second order, where the upstream
          // density alone underestimates friction in strongly accelerating
          // (near-choked) cells — same convention as the retired
          // compressible-T mode.  Junction inlet branches keep the pure
          // upstream (reactant) density — see the junction block above.
          const downNode = mdot >= 0 ? b.to : b.from;
          const downP = pressureAt(downNode, intP);
          const rhoDown = safeStatePH(
            fluidOf(downNode),
            downP,
            nodeHFromX(downNode, x),
            `branch ${b.id} downstream friction`,
          ).rho;
          if (rho > 0 && rhoDown > 0) rho = 2 / (1 / rho + 1 / rhoDown);
        }
      } else {
        upT = state.nodeT.get(upNode)!;
        if (ctx.hasSpecies && ctx.mixtureFluid && state.nodeY) {
          const Yup = state.nodeY.get(upNode)!;
          rho = ctx.mixtureFluid.densityMix(upP, upT, Yup);
          mu = ctx.mixtureFluid.viscosityMix(upP, upT, Yup);
        } else {
          const bf = fluidOf(upNode);
          const Aup =
            mdot >= 0
              ? b.component.area
              : (b.component.areaOut ?? b.component.area);
          const downNode = mdot >= 0 ? b.to : b.from;
          const df = fluidOf(downNode);
          const downP = pressureAt(downNode, intP);
          if (
            compressibleKE &&
            bf.R !== undefined &&
            bf.gamma !== undefined &&
            df.R !== undefined &&
            df.gamma !== undefined &&
            Aup !== undefined &&
            Aup > 0
          ) {
            upT = staticTFromStag(
              nodeStagT(upNode),
              upP,
              mdot,
              Aup,
              bf.R,
              bf.gamma,
            );
            const rhoUp = bf.density(upP, upT);
            // Same harmonic-mean friction density as the coupled mode.
            const Adown =
              mdot >= 0
                ? (b.component.areaOut ?? b.component.area!)
                : b.component.area!;
            const downT = staticTFromStag(
              nodeStagT(downNode),
              downP,
              mdot,
              Adown,
              df.R,
              df.gamma,
            );
            const rhoDown = df.density(downP, downT);
            rho = 2 / (1 / rhoUp + 1 / rhoDown);
            mu = bf.viscosity(upP, upT);
          } else {
            rho = bf.density(upP, upT);
            mu = bf.viscosity(upP, upT);
          }
        }
      }

      // For branches with elevation change, use average of upstream and downstream
      // density to better represent the local density along the pipe. This is
      // important for natural circulation with thermally expanding liquids.
      // (Junction inlet branches keep the upstream reactant density — the
      // endpoints hold unlike fluids.)
      if (
        (b.component.elevationChange ?? 0) !== 0 &&
        !junctionInletBranches.has(j)
      ) {
        const downNode = mdot >= 0 ? b.to : b.from;
        const downP = pressureAt(downNode, intP);
        if (usePHFor(downNode)) {
          const downH = nodeHFromX(downNode, x);
          const phDown = safeStatePH(
            fluidOf(downNode),
            downP,
            downH,
            `branch ${b.id} downstream`,
          );
          rho = 0.5 * (rho + phDown.rho);
        } else {
          const downT = state.nodeT.get(downNode)!;
          if (ctx.hasSpecies && ctx.mixtureFluid && state.nodeY) {
            const Ydown = state.nodeY.get(downNode)!;
            const rhoDown = ctx.mixtureFluid.densityMix(downP, downT, Ydown);
            rho = 0.5 * (rho + rhoDown);
          } else {
            const rhoDown = fluidOf(downNode).density(downP, downT);
            rho = 0.5 * (rho + rhoDown);
          }
        }
      }

      if (b.component instanceof OrificeCompressible) {
        const bf = fluidOf(upNode);
        if (bf.R === undefined || bf.gamma === undefined) {
          R[nInt + j] = mdot; // should not happen if validation is correct
        } else {
          const downP = mdot >= 0 ? pTo : pFrom;
          const expectedMdot = b.component.massFlow(
            upP,
            downP,
            upT,
            bf.R,
            bf.gamma,
          );
          R[nInt + j] = mdot - expectedMdot;
        }
        continue;
      }

      if (b.component instanceof CavitatingVenturi) {
        if (!(ctx.fluidAssignment.branch(b.id) instanceof RealFluid)) {
          R[nInt + j] = mdot; // should not happen if validation is correct
        } else {
          const downP = mdot >= 0 ? pTo : pFrom;
          const expectedMdot = b.component.massFlow(
            upP,
            downP,
            upT,
            ctx.fluidAssignment.branch(b.id),
          );
          R[nInt + j] = mdot - expectedMdot;
        }
        continue;
      }

      if (b.component instanceof Regulator) {
        const downP = mdot >= 0 ? pTo : pFrom;
        R[nInt + j] = b.component.residual(mdot, rho, upP, downP);
        continue;
      }

      const dP = componentPressureDrop(
        mdot,
        rho,
        mu,
        b.component,
        t,
        upT,
        ctx.fluidAssignment.branch(b.id),
        pFrom,
        pTo,
      );
      let inertiaTerm = 0;
      if (
        dt !== undefined &&
        prevState !== undefined &&
        b.inertia &&
        b.component instanceof Pipe
      ) {
        const L = b.component.length;
        const A = b.component.area;
        const mdotPrev = prevState.mdots[j];
        inertiaTerm = ((L / A) * (mdot - mdotPrev)) / dt;
      }
      // Momentum flux (settings.momentumFlux, settings.momentumFluxScheme):
      //   "upwind" (default) — donor-cell momentum advection, ΔP_accel =
      //     (ṁ_j·u_j − ṁ_j·ū_up)/Ā, u_j = |ṁ_j|/(ρ_don·A_exit) at the
      //     branch's own DONOR density, ū_up the mass-flow-weighted
      //     velocity of the branches feeding the donor node (each at ITS
      //     donor density and exit face).  No downwind density in the row
      //     ⇒ monotone in the downstream pressure ⇒ no discrete expansion-
      //     shock roots (see settings.momentumFluxScheme in schema.ts).
      //   "central" — legacy exact integral form (ṁ/Ā)(u_to − u_from) at
      //     the ENDPOINT states; bit-identical to pre-scheme builds.
      // Zero either way for constant-density constant-area flow and for
      // components without a flow area.
      let accelTerm = 0;
      const accelArea =
        ctx.momentumFlux && !junctionInletBranches.has(j)
          ? b.component.area
          : undefined;
      if (accelArea !== undefined && accelArea > 0) {
        const rhoAt = (nodeId: string, P: number, Aend: number): number => {
          if (usePHFor(nodeId)) {
            return safeStatePH(
              fluidOf(nodeId),
              P,
              nodeHFromX(nodeId, x),
              `branch ${b.id} momentum flux`,
            ).rho;
          }
          let T = state.nodeT.get(nodeId)!;
          if (ctx.hasSpecies && ctx.mixtureFluid && state.nodeY) {
            return ctx.mixtureFluid.densityMix(P, T, state.nodeY.get(nodeId)!);
          }
          const nf = fluidOf(nodeId);
          if (compressibleKE && nf.R !== undefined && nf.gamma !== undefined) {
            T = staticTFromStag(
              nodeStagT(nodeId),
              P,
              mdot,
              Aend,
              nf.R,
              nf.gamma,
            );
          }
          return nf.density(P, T);
        };
        const areaTo = b.component.areaOut;
        const aOut = areaTo ?? accelArea;
        /** Legacy central endpoint form — exact integral balance. */
        const centralAccel = (): number => {
          const rhoFrom = rhoAt(b.from, pFrom, accelArea);
          const rhoTo = rhoAt(b.to, pTo, aOut);
          if (areaTo === undefined || areaTo === accelArea) {
            // Constant-area branch — legacy expression, bit-identical.
            return (
              ((mdot * mdot) / (accelArea * accelArea)) *
              (1 / rhoTo - 1 / rhoFrom)
            );
          }
          const areaMean = 0.5 * (accelArea + areaTo);
          return (
            (mdot / areaMean) *
            (mdot / (rhoTo * areaTo) - mdot / (rhoFrom * accelArea))
          );
        };
        if (upwindFlux && feedersArr![j].length > 0) {
          // Shared-face momentum advection: own exit-face velocity minus
          // the mass-flow-weighted exit-face velocities of the feeding
          // branches (all from the face pass above).
          const uOwn = uFaceArr![j];
          let sumM = 0;
          let sumMU = 0;
          for (const i of feedersArr![j]) {
            const am = Math.abs(branchMdot[i]);
            sumM += am;
            sumMU += am * uFaceArr![i];
          }
          const uUp = sumMU / sumM;
          const areaMean =
            aOut !== accelArea ? 0.5 * (accelArea + aOut) : accelArea;
          accelTerm = (mdot * (uOwn - uUp)) / areaMean;
        } else {
          // Central scheme, or no upstream areal branch (plenum, boundary,
          // junction node) — there is no advected momentum to upwind
          // against and the central endpoint form is exact for the
          // within-branch acceleration, so single-branch networks and
          // chain entrances keep their full restriction.
          accelTerm = centralAccel();
        }
      }
      R[nInt + j] = pFrom - pTo - dP - accelTerm - inertiaTerm;
    }

    // Energy residual for the h-primary systems: the extended real-fluid
    // transient system and the coupled steady h-system (any EOS).  With
    // settings.kineticEnergy the fluxed quantity is the stagnation enthalpy
    // h₀ = h + v²/2, v = ṁ/(ρA) at the branch endpoint on the upwind node's
    // side — the same convention as the segregated kineticEnergyAt update
    // and the retired compressible-T rows.
    if (hPrimary) {
      /** v²/2 carried by branch j at the given endpoint and density; 0 when
       *  kineticEnergy is off or the component has no flow area. */
      const halfV2 = (
        j: number,
        end: "from" | "to",
        mdotBranch: number,
        rho: number,
      ): number => {
        if (!ctx.kineticEnergy) return 0;
        const comp = branches[j].component;
        const A = end === "to" ? (comp.areaOut ?? comp.area) : comp.area;
        if (A === undefined || !(A > 0) || !(rho > 0)) return 0;
        const v = mdotBranch / (rho * A);
        return 0.5 * v * v;
      };
      for (let i = 0; i < nInt; i++) {
        const nodeId = internalIds[i];
        const energyIdx = energyColOf(nodeId, "h");
        if (energyIdx === undefined) continue;
        const node = nodeMap.get(nodeId)!;
        const Pcurr = x[i];
        const hcurr = x[energyIdx];

        // Reacting junction: the node's energy row IS the thermochemical
        // closure (see the junction block at the top of makeKernel) — the
        // upwind-mixing balance below never applies (reactant enthalpies
        // must not mix linearly into the product enthalpy; the released
        // heat of reaction is inside T0).
        //
        // Normalization is FROZEN at the outer state (state.nodeH), never a
        // function of x: an x-dependent denominator makes the residual's true
        // derivative carry a −(h−h_t)·h_t'/h_t² term that the dual-number
        // path (which freezes the same constant) would omit — the two
        // Jacobians then disagree far from the solution, and the inner
        // Newton was observed to walk off spurious roots because of it.
        const jn = junctionByNode.get(nodeId);
        if (jn !== undefined) {
          const T0 = jn.model.evaluate(Pcurr, junctionMdotByRole(jn, x)).gas.T0;
          const hTarget = fluidOf(nodeId).enthalpyPT(Pcurr, jn.efficiency * T0);
          const hRef = Math.max(
            Math.abs(state.nodeH?.get(nodeId) ?? hTarget),
            1e4,
          );
          R[energyIdx] = (hcurr - hTarget) / hRef;
          continue;
        }

        const phCurr = safeStatePH(
          fluidOf(nodeId),
          Pcurr,
          hcurr,
          `node ${nodeId} energy`,
        );
        const Tcurr = phCurr.T;
        const rhoCurr = phCurr.rho;

        /** Kinetic term for an INFLOW: density at the upwind node's own
         *  (P, h).  Costs one extra flash per inflow, only when
         *  kineticEnergy is on. */
        const keInflow = (
          upId: string,
          j: number,
          end: "from" | "to",
          mdotBranch: number,
          hUp: number,
        ): number => {
          if (!ctx.kineticEnergy) return 0;
          const Pup = pressureAt(upId, x);
          const rhoUp = safeStatePH(
            fluidOf(upId),
            Pup,
            hUp,
            `node ${nodeId} stagnation`,
          ).rho;
          return halfV2(j, end, mdotBranch, rhoUp);
        };

        // Branch enthalpy flows.  `keOut` collects the per-branch kinetic
        // part of the outflow flux (the static part stays as sumOut·hcurr so
        // the kineticEnergy-off shape is bit-identical to the historical
        // extended-system row).  `hasEnergyCoupling` mirrors the retired
        // T-mode's degenerate-node guard: without an outflow or a conductor
        // the steady balance is independent of hcurr and the column would be
        // identically zero.
        let hSum = 0;
        let sumOut = 0;
        let keOut = 0;
        let hasEnergyCoupling = false;
        for (const j of incidentOf[i]) {
          const b = branches[j];
          const mdot = x[nInt + j];
          if (b.to === nodeId && mdot > 0) {
            const hUp = nodeHFromX(b.from, x);
            hSum += mdot * (hUp + keInflow(b.from, j, "from", mdot, hUp));
          } else if (b.from === nodeId && mdot < 0) {
            const hUp = nodeHFromX(b.to, x);
            hSum += -mdot * (hUp + keInflow(b.to, j, "to", mdot, hUp));
          } else if (b.from === nodeId && mdot > 0) {
            sumOut += mdot;
            keOut += mdot * halfV2(j, "from", mdot, rhoCurr);
            hasEnergyCoupling = true;
          } else if (b.to === nodeId && mdot < 0) {
            sumOut += -mdot;
            keOut += -mdot * halfV2(j, "to", mdot, rhoCurr);
            hasEnergyCoupling = true;
          }
        }

        // HeatedPipe branch heat
        for (const j of branchHeatIncidentOf[i]) {
          const b = branches[j];
          const mdot = x[nInt + j];
          const dnNode = mdot >= 0 ? b.to : b.from;
          if (dnNode !== nodeId) continue;
          const upNode = mdot >= 0 ? b.from : b.to;
          const Pup = pressureAt(upNode, x);
          const hUp = nodeHFromX(upNode, x);
          const phUp = safeStatePH(
            fluidOf(upNode),
            Pup,
            hUp,
            `node ${nodeId} branch heat`,
          );
          hSum += b.component.getBranchHeat!(
            mdot,
            phUp.T,
            phUp.cp ?? 0,
            ctx.fluidAssignment.branch(b.id),
            Pup,
            hUp,
          );
        }

        // Convection heat rate
        let Qconv = 0;
        for (const cond of convectionIncidentOf[i]) {
          // Always true (that is what the list holds) — kept to narrow the
          // conductor-type union for `h`/`area`.
          if (cond.type.kind !== "convection") continue;
          const otherId = cond.from === nodeId ? cond.to : cond.from;
          const hEff =
            env.conductorHMap.get(cond.id) ?? cond.type.h ?? FALLBACK_H_FLOOR;
          const G = hEff * cond.type.area;
          let T_other: number;
          if (internalIndex.has(otherId)) {
            const P_other = pressureAt(otherId, x);
            const h_other = nodeHFromX(otherId, x);
            const ph_other = safeStatePH(
              fluidOf(otherId),
              P_other,
              h_other,
              `node ${otherId} conv`,
            );
            T_other = ph_other.T;
          } else {
            T_other =
              state.solidT.get(otherId) ?? state.nodeT.get(otherId) ?? 300;
          }
          Qconv += G * (T_other - Tcurr);
          hasEnergyCoupling = true;
        }

        const Q = heatInputOf(ctx, node);

        let Renergy: number;
        if (dt !== undefined && prevState !== undefined) {
          const V_total = node.volume ?? 0;
          let V = V_total;
          let Vprev = V_total;
          if (node.gasCushion) {
            const gc = node.gasCushion;
            const P0 = node.pressure ?? Pcurr;
            const n = gc.polytropicIndex;
            const Vg0 = gc.initialGasVolume;
            const C = P0 * Math.pow(Vg0, n);
            const Vg_curr = Math.pow(C / Pcurr, 1 / n);
            const Pprev = prevState.nodeP.get(nodeId)!;
            const Vg_prev = Math.pow(C / Pprev, 1 / n);
            V = V_total - Vg_curr;
            Vprev = V_total - Vg_prev;
          }

          const mCurr = rhoCurr * V;
          const rhoPrev = prevState.nodeRho.get(nodeId)!;
          const mPrev = rhoPrev * Vprev;

          let uPrev = 0;
          if (prevState) {
            const Pprev = prevState.nodeP.get(nodeId)!;
            const hPrev = prevState.nodeH!.get(nodeId)!;
            uPrev = safeInternalEnergyPH(
              fluidOf(nodeId),
              Pprev,
              hPrev,
              `node ${nodeId} prev u`,
            );
          }
          const uCurr = safeInternalEnergyPH(
            fluidOf(nodeId),
            Pcurr,
            hcurr,
            `node ${nodeId} curr u`,
          );

          // Extended system: raw Watts so the h-equation has a natural
          // scale; normalising by powerRef (~5e4 W for the boiling pot)
          // shrinks the h-derivative to ~1e-5 and the Newton step becomes
          // uselessly small.
          Renergy =
            hSum -
            sumOut * hcurr -
            keOut +
            Q +
            Qconv -
            (mCurr * uCurr - mPrev * uPrev) / dt;
        } else {
          const bal = hSum - sumOut * hcurr - keOut + Q + Qconv;
          if (useCoupledH) {
            // Coupled steady h-system: dimensionless via the fixed per-node
            // throughput reference so the legacy raw-norm convergence bar
            // stays meaningful; degenerate nodes (no outflow, no conductor)
            // pin h to the frozen state so the column is never identically
            // zero — both conventions mirror the retired T-mode.
            if (hasEnergyCoupling) {
              Renergy = bal / hPowerRef[i];
            } else {
              const hPin =
                state.nodeH?.get(nodeId) ??
                fluidOf(nodeId).enthalpyPT(
                  state.nodeP.get(nodeId)!,
                  state.nodeT.get(nodeId)!,
                );
              Renergy = (hcurr - hPin) / Math.max(Math.abs(hPin), 1e4);
            }
          } else {
            Renergy = bal;
          }
        }
        R[energyIdx] = Renergy;
      }
    }

    return R;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Dual-number residual (exact derivatives for the hybrid Jacobian)
  // ────────────────────────────────────────────────────────────────────────

  /** Per-node, per-Jacobian-build property table entry: the statePH value and
   *  the analytic partials of derivativesPH at the build's base state, both
   *  obtained ONCE per node per build (single-phase: two HmassP flashes;
   *  in-dome: cached saturation algebra).  Every Jacobian column then chains
   *  its seed direction through this table — pure arithmetic, zero CoolProp
   *  calls — so property calls per Jacobian build are O(nodes), not
   *  O(nodes × columns). */
  interface DualPropEntry {
    P: number;
    h: number;
    st: PHState;
    der: import("../fluids/realFluid").PHDerivatives;
  }

  /** Result of the dual residual: the dual values plus the rows that contain
   *  genuinely non-differentiable pieces (components without pressureDropDual,
   *  HeatedPipe branch heat) and the columns those pieces depend on.  The
   *  hybrid Jacobian patches exactly those (row, column) entries with FD. */
  interface DualResidual {
    R: Dual[];
    fdRows: Map<number, Set<number>>;
  }

  /** Build the per-Jacobian-build property table for the real-fluid dual
   *  path: one safeStatePH + one derivativesPH per node (internal AND
   *  boundary — boundary nodes carry no derivative but their values feed the
   *  momentum/energy rows of adjacent branches).  Any property failure
   *  degrades the whole build to FD (same behaviour as a scalar-path
   *  property failure). */
  function buildDualPropCache(
    x: number[],
  ): Map<string, DualPropEntry> | "FD_FALLBACK" {
    const cache = new Map<string, DualPropEntry>();
    try {
      for (const id of nodeMap.keys()) {
        // Frozen-T nodes (analytic, solved segregatedly) never read the
        // cache; skipping them keeps their possibly-lagging state.nodeH out
        // of the build and makes an accidental read fail loudly.
        if (!usePHFor(id)) continue;
        const f = fluidOf(id);
        if (!f.derivativesPH) return "FD_FALLBACK";
        const P = internalIndex.has(id)
          ? x[internalIndex.get(id)!]
          : state.nodeP.get(id)!;
        const h = nodeHFromX(id, x);
        const [cP, cH] = clampToValidPHFor(f, P, h);
        const st = safeStatePH(f, cP, cH, `dual prop cache ${id}`);
        const der = f.derivativesPH(cP, cH);
        cache.set(id, { P: cP, h: cH, st, der });
      }
    } catch {
      return "FD_FALLBACK";
    }
    return cache;
  }

  /** u at the previous step, per internal node — constant for the whole
   *  attempt (prevState is fixed), so evaluate once lazily instead of once
   *  per residual evaluation as the scalar path does. */
  let uPrevByNode: Map<string, number> | undefined;
  function getUPrev(nodeId: string): number {
    if (uPrevByNode === undefined) {
      uPrevByNode = new Map<string, number>();
      for (const id of internalIds) {
        const Pprev = prevState!.nodeP.get(id)!;
        const hPrev = prevState!.nodeH!.get(id)!;
        uPrevByNode.set(
          id,
          safeInternalEnergyPH(fluidOf(id), Pprev, hPrev, `node ${id} prev u`),
        );
      }
    }
    return uPrevByNode.get(nodeId)!;
  }

  /** Wholesale, configuration-level reasons the dual path cannot run at all.
   *  None of them depend on the iterate, so they are decided ONCE per kernel
   *  rather than re-scanning every node on each of the n dual passes that make
   *  up a Jacobian build. */
  let dualUnsupported: boolean | undefined;
  function dualPathUnsupported(): boolean {
    if (dualUnsupported !== undefined) return dualUnsupported;
    dualUnsupported = true;
    if (ctx.hasSpecies) return dualUnsupported;
    // Gas-cushion nodes evaluate density from (P, T) — a PT flash with no
    // dual counterpart — keep the whole Jacobian on FD for that combo
    // (transient only: steady solves never touch the cushion storage).
    if (anyPH && dt !== undefined) {
      for (const id of internalIds) {
        if (nodeMap.get(id)!.gasCushion) return dualUnsupported;
      }
    }
    // Every node on the frozen-T property path needs the fluid duals; in a
    // single-EOS analytic network this is the historical whole-network check
    // on the one fluid, in a mixed network only the analytic nodes matter.
    for (const id of nodeMap.keys()) {
      if (usePHFor(id)) continue;
      const nf = fluidOf(id);
      if (!nf.densityDual || !nf.viscosityDual) return dualUnsupported;
    }
    dualUnsupported = false;
    return dualUnsupported;
  }

  /** Dual-number residual evaluator.  Covers non-real-fluid networks with
   *  dual-capable components AND real-fluid networks (via the per-build
   *  property cache — the blanket real-fluid FD fallback is gone).
   *  Returns `'FD_FALLBACK'` only for wholesale-unsupported configurations
   *  (species, missing fluid duals, real-fluid gas cushion, missing cache);
   *  component-level gaps are reported in `fdRows` for the per-column FD
   *  patch instead of degrading the whole matrix. */
  function computeResidualDual(
    x: Dual[],
    propCache?: Map<string, DualPropEntry>,
  ): DualResidual | "FD_FALLBACK" {
    if (dualPathUnsupported()) return "FD_FALLBACK";
    if (anyPH && !propCache) return "FD_FALLBACK";

    const fdRows = new Map<number, Set<number>>();
    const markFd = (row: number, cols: number[]) => {
      let s = fdRows.get(row);
      if (!s) {
        s = new Set<number>();
        fdRows.set(row, s);
      }
      for (const c of cols) s.add(c);
    };
    /** Variable-column indices an internal node's (P [, h/T]) occupies. */
    const colsForNode = (id: string, withH: boolean): number[] =>
      dof.colsForNode(id, withH);

    const nodePDual = (id: string): Dual => {
      const col = internalIndex.get(id);
      return col === undefined ? constant(state.nodeP.get(id)!) : x[col];
    };
    const nodeHDual = (id: string): Dual => {
      const col = energyColOf(id, "h");
      // Same frozen-state fallback (incl. h(P, T) for analytic nodes with no
      // map entry) as the scalar nodeHFromX.
      return col !== undefined
        ? x[col]
        : constant(
            state.nodeH?.get(id) ??
              fluidOf(id).enthalpyPT(
                state.nodeP.get(id)!,
                state.nodeT.get(id)!,
              ),
          );
    };
    /** Chain the cached per-build value + analytic partials along the seed:
     *  rho.d = drhodP_h·P.d + drhodh_P·h.d (and likewise T, cp).  Zero
     *  CoolProp calls.  μ follows the pinned frozen-μ convention of
     *  statePHDual (mu.d === 0; exact for NitrousOxide where mu ≡ 0). */
    const nodeStateDual = (
      id: string,
    ): { T: Dual; rho: Dual; mu: Dual; cp?: Dual } => {
      const e = propCache!.get(id)!;
      const Pd = nodePDual(id).d;
      const hd = nodeHDual(id).d;
      return {
        T: { v: e.st.T, d: e.der.dTdP_h * Pd + e.der.dTdh_P * hd },
        rho: { v: e.st.rho, d: e.der.drhodP_h * Pd + e.der.drhodh_P * hd },
        mu: { v: e.st.mu, d: 0 },
        cp:
          e.st.cp !== undefined
            ? {
                v: e.st.cp,
                d: (e.der.dcpdP_h ?? 0) * Pd + (e.der.dcpdh_P ?? 0) * hd,
              }
            : undefined,
      };
    };

    const R: Dual[] = new Array(nVar).fill(null).map(() => constant(0));
    const intP: Dual[] = new Array(nInt).fill(null);
    for (let i = 0; i < nInt; i++) intP[i] = x[i];
    const branchMdot: Dual[] = new Array(nBranch).fill(null);
    for (let j = 0; j < nBranch; j++) branchMdot[j] = x[nInt + j];

    // ---- Mass rows ----
    for (let i = 0; i < nInt; i++) {
      const nodeId = internalIds[i];
      let sum = constant(0);
      const massIdx = massIncidentIdx[i];
      const massSign = massIncidentSign[i];
      for (let k = 0; k < massIdx.length; k++) {
        const m = branchMdot[massIdx[k]];
        sum = massSign[k] < 0 ? sub(sum, m) : add(sum, m);
      }
      if (dt !== undefined && prevState !== undefined) {
        const node = nodeMap.get(nodeId)!;
        const V = node.volume ?? 0;
        const gc = node.gasCushion;
        if (usePHFor(nodeId)) {
          // gc + PH bailed at entry; rho from the per-build cache.
          const rhoCurr = nodeStateDual(nodeId).rho;
          const rhoPrev = prevState.nodeRho.get(nodeId)!;
          R[i] = sub(
            sum,
            div(
              mul(sub(rhoCurr, constant(rhoPrev)), constant(V)),
              constant(dt),
            ),
          );
        } else if (gc) {
          const PcurrDual = intP[i];
          const Pprev = prevState.nodeP.get(nodeId)!;
          const Tcurr = state.nodeT.get(nodeId)!;
          const rhoCurrDual = fluidOf(nodeId).densityDual!(PcurrDual, Tcurr);
          const P0 = node.pressure ?? PcurrDual.v;
          const n = gc.polytropicIndex;
          const Vg0 = gc.initialGasVolume;
          const C = P0 * Math.pow(Vg0, n);
          const Vg_currDual = pow(div(constant(C), PcurrDual), constant(1 / n));
          const Vg_prev = Math.pow(C / Pprev, 1 / n);
          const Vw_currDual = sub(constant(V), Vg_currDual);
          const Vw_prev = V - Vg_prev;
          R[i] = sub(
            sum,
            div(
              mul(rhoCurrDual, sub(Vw_currDual, constant(Vw_prev))),
              constant(dt),
            ),
          );
        } else {
          const PcurrDual = intP[i];
          const Tcurr = state.nodeT.get(nodeId)!;
          const rhoCurrDual = fluidOf(nodeId).densityDual!(PcurrDual, Tcurr);
          const rhoPrev = prevState.nodeRho.get(nodeId)!;
          R[i] = sub(
            sum,
            div(
              mul(sub(rhoCurrDual, constant(rhoPrev)), constant(V)),
              constant(dt),
            ),
          );
        }
      } else {
        R[i] = sum;
      }
    }

    // ---- Momentum rows ----
    // Upwind momentum-flux face pass, dual mirror of the scalar block: ONE
    // exit-face velocity per areal branch with a MUSCL-limited face
    // density.  Limiter and clamp branch on VALUES; the selected branch's
    // dual expression carries the exact one-sided derivative.  The
    // cross-branch dependencies (feeder ṁ, feeder donor states) flow
    // through the dual seeds exactly — no FD marking needed.
    let uFaceArrD: Dual[] | undefined;
    let feedersArrD: number[][] | undefined;
    if (ctx.momentumFlux && upwindFlux) {
      const rhoAtNodeDual = (
        nodeId: string,
        Aend: number,
        mdotKE: Dual,
      ): Dual => {
        if (usePHFor(nodeId)) return nodeStateDual(nodeId).rho;
        const nf = fluidOf(nodeId);
        const Pd = nodePDual(nodeId);
        if (compressibleKE && nf.R !== undefined && nf.gamma !== undefined) {
          const Ts = staticTFromStagDual(
            nodeStagT(nodeId),
            Pd,
            mdotKE,
            Aend,
            nf.R,
            nf.gamma,
          );
          return div(Pd, mul(constant(nf.R), Ts));
        }
        return nf.densityDual!(Pd, state.nodeT.get(nodeId)!);
      };
      uFaceArrD = new Array(nBranch).fill(null).map(() => constant(0));
      feedersArrD = new Array(nBranch);
      const rhoDonArrD: Dual[] = new Array(nBranch)
        .fill(null)
        .map(() => constant(0));
      for (let j = 0; j < nBranch; j++) {
        feedersArrD[j] = [];
        if (!upwindEligible(j)) continue;
        const b = branches[j];
        const mdotJ = branchMdot[j];
        const aIn = b.component.area!;
        const aOut = b.component.areaOut ?? aIn;
        const donor = mdotJ.v >= 0 ? b.from : b.to;
        rhoDonArrD[j] = rhoAtNodeDual(donor, mdotJ.v >= 0 ? aIn : aOut, mdotJ);
        for (const i of arealIncident.get(donor) ?? []) {
          if (i === j) continue;
          const mi = branchMdot[i];
          if (!(Math.abs(mi.v) > 0)) continue;
          const bi = branches[i];
          const flowsIn = mi.v >= 0 ? bi.to === donor : bi.from === donor;
          if (flowsIn) feedersArrD[j].push(i);
        }
      }
      for (let j = 0; j < nBranch; j++) {
        if (!upwindEligible(j)) continue;
        const b = branches[j];
        const mdotJ = branchMdot[j];
        const aIn = b.component.area!;
        const aOut = b.component.areaOut ?? aIn;
        const dwn = mdotJ.v >= 0 ? b.to : b.from;
        const exitA = mdotJ.v >= 0 ? aOut : aIn;
        const rhoDwn = rhoAtNodeDual(dwn, exitA, mdotJ);
        let rhoFace = rhoDwn;
        const feeders = feedersArrD[j];
        if (feeders.length > 0) {
          const rhoDon = rhoDonArrD[j];
          let sumM: Dual = constant(0);
          let sumMRho: Dual = constant(0);
          for (const i of feeders) {
            const mi = branchMdot[i];
            const am = mul(constant(mi.v >= 0 ? 1 : -1), mi);
            sumM = add(sumM, am);
            sumMRho = add(sumMRho, mul(am, rhoDonArrD[i]));
          }
          const dUp = sub(rhoDon, div(sumMRho, sumM));
          const dDn = sub(rhoDwn, rhoDon);
          const phi: Dual =
            dUp.v * dDn.v > 0
              ? div(
                  mul(mul(dUp, dDn), add(dUp, dDn)),
                  add(mul(dUp, dUp), mul(dDn, dDn)),
                )
              : constant(0);
          const unclamped = add(rhoDon, mul(constant(0.5), phi));
          const lo = rhoDon.v <= rhoDwn.v ? rhoDon : rhoDwn;
          const hi = rhoDon.v <= rhoDwn.v ? rhoDwn : rhoDon;
          rhoFace =
            unclamped.v < lo.v ? lo : unclamped.v > hi.v ? hi : unclamped;
        }
        const absMdotJ = mul(constant(mdotJ.v >= 0 ? 1 : -1), mdotJ);
        uFaceArrD[j] = div(absMdotJ, mul(rhoFace, constant(exitA)));
      }
    }

    for (let j = 0; j < nBranch; j++) {
      const b = branches[j];
      const mdot = branchMdot[j];
      const pFrom = nodePDual(b.from);
      const pTo = nodePDual(b.to);

      if (b.component instanceof FlowSource) {
        R[nInt + j] = sub(mdot, constant(b.component.getMdot(t)));
        continue;
      }

      const upNode = mdot.v >= 0 ? b.from : b.to;
      const upP = nodePDual(upNode);
      let rho: Dual;
      let mu: Dual;
      let upT: number;
      if (usePHFor(upNode)) {
        const upSt = nodeStateDual(upNode);
        rho = upSt.rho;
        mu = upSt.mu;
        upT = upSt.T.v;
        if (useCoupledH && ctx.kineticEnergy && !junctionInletBranches.has(j)) {
          // Harmonic-mean friction density (mirrors the scalar path;
          // junction inlets keep the upstream reactant density).
          const downNode = mdot.v >= 0 ? b.to : b.from;
          const rhoDown = nodeStateDual(downNode).rho;
          if (rho.v > 0 && rhoDown.v > 0) {
            rho = div(
              constant(2),
              add(div(constant(1), rho), div(constant(1), rhoDown)),
            );
          }
        }
      } else {
        upT = state.nodeT.get(upNode)!;
        const bf = fluidOf(upNode);
        const Aup =
          mdot.v >= 0
            ? b.component.area
            : (b.component.areaOut ?? b.component.area);
        const downNode = mdot.v >= 0 ? b.to : b.from;
        const df = fluidOf(downNode);
        if (
          compressibleKE &&
          bf.R !== undefined &&
          bf.gamma !== undefined &&
          df.R !== undefined &&
          df.gamma !== undefined &&
          Aup !== undefined &&
          Aup > 0
        ) {
          // Static T from the frozen stagnation temperature (dual in P, ṁ);
          // ρ = P/(R·T_s) exactly for the R-carrying (ideal-gas) fluids this
          // branch is gated to.  Friction density is the harmonic mean of
          // the endpoint static densities (mirrors the scalar path).
          const Ts = staticTFromStagDual(
            nodeStagT(upNode),
            upP,
            mdot,
            Aup,
            bf.R,
            bf.gamma,
          );
          upT = Ts.v;
          const rhoUp = div(upP, mul(constant(bf.R), Ts));
          const Adown =
            mdot.v >= 0
              ? (b.component.areaOut ?? b.component.area!)
              : b.component.area!;
          const downP = nodePDual(downNode);
          const TsDown = staticTFromStagDual(
            nodeStagT(downNode),
            downP,
            mdot,
            Adown,
            df.R,
            df.gamma,
          );
          const rhoDown = div(downP, mul(constant(df.R), TsDown));
          rho = div(
            constant(2),
            add(div(constant(1), rhoUp), div(constant(1), rhoDown)),
          );
          mu = fluidOf(upNode).viscosityDual!(upP, upT);
        } else {
          rho = fluidOf(upNode).densityDual!(upP, upT);
          mu = fluidOf(upNode).viscosityDual!(upP, upT);
        }
      }

      // Elevation change: average of upstream and downstream density (as scalar).
      if (
        (b.component.elevationChange ?? 0) !== 0 &&
        !junctionInletBranches.has(j)
      ) {
        const downNode = mdot.v >= 0 ? b.to : b.from;
        if (usePHFor(downNode)) {
          rho = mul(constant(0.5), add(rho, nodeStateDual(downNode).rho));
        } else {
          const downP = nodePDual(downNode);
          const downT = state.nodeT.get(downNode)!;
          const rhoDown = fluidOf(downNode).densityDual!(downP, downT);
          rho = mul(constant(0.5), add(rho, rhoDown));
        }
      }

      // Pipe inertia (dual-capable, shared by all rows below).
      let inertiaTerm = constant(0);
      if (
        dt !== undefined &&
        prevState !== undefined &&
        b.inertia &&
        b.component instanceof Pipe
      ) {
        const L = b.component.length;
        const A = b.component.area;
        const mdotPrev = prevState.mdots[j];
        inertiaTerm = mul(
          constant(L / A),
          div(sub(mdot, constant(mdotPrev)), constant(dt)),
        );
      }

      if (b.component instanceof OrificeCompressible) {
        const bf = fluidOf(upNode);
        if (bf.R === undefined || bf.gamma === undefined) {
          R[nInt + j] = mdot; // degenerate (matches scalar; invalid-config guard)
        } else {
          // Ideal-gas-only path (a RealFluid has no R/gamma): value-only
          // choked-flow closure, patch the touching columns with FD.
          const downP = mdot.v >= 0 ? pTo : pFrom;
          const expectedMdot = b.component.massFlow(
            upP.v,
            downP.v,
            upT,
            bf.R,
            bf.gamma,
          );
          R[nInt + j] = sub(mdot, constant(expectedMdot));
          // The closure reads the UPSTREAM temperature, so whenever the
          // endpoint's properties come from (P, h) the row depends on that
          // node's h column too — omitting it left ∂R/∂h at the dual value of
          // a constant (zero) with nothing to patch it, and the coupled
          // h-system then had no ṁ–h coupling for this component at all.
          markFd(nInt + j, [
            nInt + j,
            ...colsForNode(b.from, usePHFor(b.from)),
            ...colsForNode(b.to, usePHFor(b.to)),
          ]);
        }
        continue;
      }

      if (b.component instanceof CavitatingVenturi) {
        if (!(ctx.fluidAssignment.branch(b.id) instanceof RealFluid)) {
          R[nInt + j] = mdot; // degenerate (matches scalar; invalid-config guard)
        } else {
          // Cavitation closure calls saturationPressure + density (PT flashes):
          // value-only, patch the touching columns with FD.
          const downP = mdot.v >= 0 ? pTo : pFrom;
          const expectedMdot = b.component.massFlow(
            upP.v,
            downP.v,
            upT,
            ctx.fluidAssignment.branch(b.id),
          );
          R[nInt + j] = sub(mdot, constant(expectedMdot));
          markFd(nInt + j, [
            nInt + j,
            ...colsForNode(b.from, true),
            ...colsForNode(b.to, true),
          ]);
        }
        continue;
      }

      if (b.component instanceof Regulator) {
        const downP = mdot.v >= 0 ? pTo : pFrom;
        R[nInt + j] = constant(
          b.component.residual(mdot.v, rho.v, upP.v, downP.v),
        );
        markFd(nInt + j, [
          nInt + j,
          ...colsForNode(b.from, usePHFor(b.from)),
          ...colsForNode(b.to, usePHFor(b.to)),
        ]);
        continue;
      }

      // Momentum flux (settings.momentumFlux, settings.momentumFluxScheme),
      // dual mirror of the scalar block.  The upwind stencil's cross-branch
      // dependencies (feeding branches' ṁ and their donor-node states) flow
      // through the dual seeds exactly — no FD marking needed.
      let accelTerm: Dual = constant(0);
      const accelArea =
        ctx.momentumFlux && !junctionInletBranches.has(j)
          ? b.component.area
          : undefined;
      if (accelArea !== undefined && accelArea > 0) {
        const rhoDualAt = (nodeId: string, Aend: number): Dual => {
          if (usePHFor(nodeId)) return nodeStateDual(nodeId).rho;
          const nf = fluidOf(nodeId);
          const Pd = nodePDual(nodeId);
          if (compressibleKE && nf.R !== undefined && nf.gamma !== undefined) {
            const Ts = staticTFromStagDual(
              nodeStagT(nodeId),
              Pd,
              mdot,
              Aend,
              nf.R,
              nf.gamma,
            );
            return div(Pd, mul(constant(nf.R), Ts));
          }
          return nf.densityDual!(Pd, state.nodeT.get(nodeId)!);
        };
        const areaTo = b.component.areaOut;
        const aOut = areaTo ?? accelArea;
        /** Legacy central endpoint form — exact integral balance. */
        const centralAccelDual = (): Dual => {
          const rhoFrom = rhoDualAt(b.from, accelArea);
          const rhoTo = rhoDualAt(b.to, aOut);
          if (areaTo === undefined || areaTo === accelArea) {
            // Constant-area branch — legacy expression, bit-identical.
            return mul(
              div(mul(mdot, mdot), constant(accelArea * accelArea)),
              sub(div(constant(1), rhoTo), div(constant(1), rhoFrom)),
            );
          }
          const areaMean = 0.5 * (accelArea + areaTo);
          return mul(
            div(mdot, constant(areaMean)),
            sub(
              div(mdot, mul(rhoTo, constant(areaTo))),
              div(mdot, mul(rhoFrom, constant(accelArea))),
            ),
          );
        };
        if (upwindFlux && feedersArrD![j].length > 0) {
          // Shared-face momentum advection (see the scalar block).
          const uOwn = uFaceArrD![j];
          let sumM: Dual = constant(0);
          let sumMU: Dual = constant(0);
          for (const i of feedersArrD![j]) {
            const mi = branchMdot[i];
            const am = mul(constant(mi.v >= 0 ? 1 : -1), mi);
            sumM = add(sumM, am);
            sumMU = add(sumMU, mul(am, uFaceArrD![i]));
          }
          const uUp = div(sumMU, sumM);
          const areaMean =
            aOut !== accelArea ? 0.5 * (accelArea + aOut) : accelArea;
          accelTerm = div(mul(mdot, sub(uOwn, uUp)), constant(areaMean));
        } else {
          // Central scheme, or no upstream areal branch — central endpoint
          // form (exact within-branch acceleration); see the scalar block.
          accelTerm = centralAccelDual();
        }
      }

      if (!b.component.pressureDropDual) {
        // Pump / ReliefValve / unknown: scalar value, FD per column.
        const dP = componentPressureDrop(
          mdot.v,
          rho.v,
          mu.v,
          b.component,
          t,
          upT,
          ctx.fluidAssignment.branch(b.id),
          pFrom.v,
          pTo.v,
        );
        R[nInt + j] = constant(
          pFrom.v - pTo.v - dP - accelTerm.v - inertiaTerm.v,
        );
        markFd(nInt + j, [
          nInt + j,
          ...colsForNode(b.from, usePHFor(b.from)),
          ...colsForNode(b.to, usePHFor(b.to)),
        ]);
        continue;
      }

      const dP = componentPressureDropDual(
        mdot,
        rho,
        mu,
        b.component,
        t,
        upT,
        ctx.fluidAssignment.branch(b.id),
        pFrom.v,
        pTo.v,
      );
      R[nInt + j] = sub(sub(sub(sub(pFrom, pTo), dP), accelTerm), inertiaTerm);
    }

    // ---- Energy rows (h-primary: extended real-fluid transient and coupled
    // steady h-system) ----
    // Mirrors the scalar block exactly: d(m·u)/dt = Σ_in ṁ·h₀_up −
    // Σ_out ṁ·h₀_node + Q + Qconv, with internal-energy storage separated
    // from enthalpy flux and the stagnation term active under kineticEnergy.
    if (hPrimary) {
      /** Dual v²/2 for branch j at the given endpoint and density (dual so
       *  the Jacobian sees ∂(v²/2)/∂ṁ and, through ρ, ∂/∂P and ∂/∂h). */
      const halfV2Dual = (
        j: number,
        end: "from" | "to",
        mdotBranch: Dual,
        rho: Dual,
      ): Dual => {
        if (!ctx.kineticEnergy) return constant(0);
        const comp = branches[j].component;
        const A = end === "to" ? (comp.areaOut ?? comp.area) : comp.area;
        if (A === undefined || !(A > 0) || !(rho.v > 0)) return constant(0);
        const v = div(mdotBranch, mul(rho, constant(A)));
        return mul(constant(0.5), mul(v, v));
      };
      for (let i = 0; i < nInt; i++) {
        const nodeId = internalIds[i];
        const energyIdx = energyColOf(nodeId, "h");
        if (energyIdx === undefined) continue;
        const node = nodeMap.get(nodeId)!;
        const Pcurr = x[i];
        const hcurr = x[energyIdx];

        // Reacting junction: dual mirror of the scalar closure row.  T0
        // chains through the model's dual table interpolation (exact ∂/∂Pc
        // and ∂/∂ṁ — bilinear interpolation is plain arithmetic); the
        // enthalpy target h(T_eff) is linear in T for the validated
        // idealGas product fluid, so dh/dT = h/T reproduces the scalar
        // value bit-for-bit with the exact derivative.
        const jnDual = junctionByNode.get(nodeId);
        if (jnDual !== undefined) {
          const mdotByRole = junctionMdotByRoleDual(jnDual, branchMdot);
          const T0 = jnDual.model.chamberT0Dual(Pcurr, mdotByRole);
          const Teff = mul(constant(jnDual.efficiency), T0);
          const hTargetV = fluidOf(nodeId).enthalpyPT(Pcurr.v, Teff.v);
          const hTarget: Dual = {
            v: hTargetV,
            d: Teff.v !== 0 ? (hTargetV / Teff.v) * Teff.d : 0,
          };
          // Same FROZEN normalization as the scalar row (see its comment):
          // constant during the inner Newton, so value AND derivative match.
          const hRef = Math.max(
            Math.abs(state.nodeH?.get(nodeId) ?? hTargetV),
            1e4,
          );
          R[energyIdx] = div(sub(hcurr, hTarget), constant(hRef));
          // FD-patch this row's entries: the CEA table is only C0 at grid
          // lines and CLAMPED at its edges, so the dual bilerp's two-sided
          // slope disagrees with the scalar function's one-sided behaviour
          // exactly at those kinks (e.g. O/F pinned at the table edge by
          // equal default warm-start mdots).  The FD patch reproduces the
          // pure-FD builder bit-for-bit, so the default hybrid path steers
          // Newton identically to jacobian: "fd" through the closure.
          const jnCols = [energyIdx, i];
          for (const idxs of jnDual.roleBranches.values()) {
            for (const idx of idxs) jnCols.push(nInt + idx);
          }
          markFd(energyIdx, jnCols);
          continue;
        }

        const curr = nodeStateDual(nodeId);
        const Tcurr = curr.T;
        const rhoCurr = curr.rho;

        // Branch enthalpy flows (upwind, same value-based branch as scalar,
        // stagnation term when kineticEnergy — mirrors the scalar block)
        let hSum = constant(0);
        let sumOut = constant(0);
        let keOut = constant(0);
        let hasEnergyCoupling = false;
        for (const j of incidentOf[i]) {
          const b = branches[j];
          const mdot = branchMdot[j];
          if (b.to === nodeId && mdot.v > 0) {
            const h0 = add(
              nodeHDual(b.from),
              halfV2Dual(j, "from", mdot, nodeStateDual(b.from).rho),
            );
            hSum = add(hSum, mul(mdot, h0));
          } else if (b.from === nodeId && mdot.v < 0) {
            const h0 = add(
              nodeHDual(b.to),
              halfV2Dual(j, "to", mdot, nodeStateDual(b.to).rho),
            );
            hSum = add(hSum, mul(neg(mdot), h0));
          } else if (b.from === nodeId && mdot.v > 0) {
            sumOut = add(sumOut, mdot);
            keOut = add(keOut, mul(mdot, halfV2Dual(j, "from", mdot, rhoCurr)));
            hasEnergyCoupling = true;
          } else if (b.to === nodeId && mdot.v < 0) {
            sumOut = add(sumOut, neg(mdot));
            keOut = add(
              keOut,
              mul(neg(mdot), halfV2Dual(j, "to", mdot, rhoCurr)),
            );
            hasEnergyCoupling = true;
          }
        }

        // HeatedPipe branch heat: the closure (incl. Miropolskii film boiling)
        // is not dual-computable — add its VALUE (bitwise the scalar term) and
        // patch the columns it depends on with FD.
        for (const j of branchHeatIncidentOf[i]) {
          const b = branches[j];
          const mdot = branchMdot[j];
          const dnNode = mdot.v >= 0 ? b.to : b.from;
          if (dnNode !== nodeId) continue;
          const upNodeB = mdot.v >= 0 ? b.from : b.to;
          const upSt = nodeStateDual(upNodeB);
          const heat = b.component.getBranchHeat!(
            mdot.v,
            upSt.T.v,
            upSt.cp?.v ?? 0,
            ctx.fluidAssignment.branch(b.id),
            nodePDual(upNodeB).v,
            nodeHDual(upNodeB).v,
          );
          hSum = add(hSum, constant(heat));
          markFd(energyIdx, [nInt + j, ...colsForNode(upNodeB, true)]);
        }

        // Convection heat rate.  hEff comes from the per-outer-iteration map
        // and is frozen within a Jacobian build — exactly as the scalar FD
        // Jacobian treats it — so the dual derivative through it is exact.
        let Qconv = constant(0);
        for (const cond of convectionIncidentOf[i]) {
          // Always true (that is what the list holds) — kept to narrow the
          // conductor-type union for `h`/`area`.
          if (cond.type.kind !== "convection") continue;
          const otherId = cond.from === nodeId ? cond.to : cond.from;
          const hEff =
            env.conductorHMap.get(cond.id) ?? cond.type.h ?? FALLBACK_H_FLOOR;
          const G = hEff * cond.type.area;
          let Tother: Dual;
          if (internalIndex.has(otherId)) {
            Tother = nodeStateDual(otherId).T;
          } else {
            Tother = constant(
              state.solidT.get(otherId) ?? state.nodeT.get(otherId) ?? 300,
            );
          }
          Qconv = add(Qconv, mul(constant(G), sub(Tother, Tcurr)));
          hasEnergyCoupling = true;
        }

        const Q = heatInputOf(ctx, node);

        if (dt !== undefined && prevState !== undefined) {
          const V = node.volume ?? 0; // gasCushion bailed at entry
          const mCurr = mul(rhoCurr, constant(V));
          const rhoPrev = prevState.nodeRho.get(nodeId)!;
          const mPrev = rhoPrev * V;
          const uPrev = getUPrev(nodeId);
          // u ≡ h − P/ρ identically (the scalar path's own safeInternalEnergyPH
          // fallback uses this identity; in-dome it reproduces the HEM mixture
          // rule uf + x·(ug − uf) to machine precision).  Chaining the cached ρ
          // partials gives the exact ∂u/∂· with zero extra CoolProp calls.
          const uCurr = sub(hcurr, div(Pcurr, rhoCurr));
          const sources = add(
            add(sub(sub(hSum, mul(sumOut, hcurr)), keOut), constant(Q)),
            Qconv,
          );
          const storage = div(
            sub(mul(mCurr, uCurr), constant(mPrev * uPrev)),
            constant(dt),
          );
          R[energyIdx] = sub(sources, storage);
        } else {
          const bal = add(
            add(sub(sub(hSum, mul(sumOut, hcurr)), keOut), constant(Q)),
            Qconv,
          );
          if (useCoupledH) {
            // Mirrors the scalar block: dimensionless via hPowerRef, with the
            // degenerate-node h pin.
            if (hasEnergyCoupling) {
              R[energyIdx] = div(bal, constant(hPowerRef[i]));
            } else {
              const hPin =
                state.nodeH?.get(nodeId) ??
                fluidOf(nodeId).enthalpyPT(
                  state.nodeP.get(nodeId)!,
                  state.nodeT.get(nodeId)!,
                );
              R[energyIdx] = div(
                sub(hcurr, constant(hPin)),
                constant(Math.max(Math.abs(hPin), 1e4)),
              );
            }
          } else {
            R[energyIdx] = bal;
          }
        }
      }
    }

    return { R, fdRows };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Jacobian builders
  // ────────────────────────────────────────────────────────────────────────

  /** One finite-difference Jacobian column with the legacy step heuristics.
   *  Shared by numericalJacobian (pure-FD mode) and the real-fluid hybrid
   *  Jacobian (per-column fallback for non-differentiable pieces) so both
   *  produce identical numbers for FD columns.  Leaves the column zero when
   *  every perturbation attempt fails (direction ignored by the solver). */
  function fdJacobianColumn(
    x: number[],
    k: number,
    R0: number[],
    J: number[][],
  ): void {
    const n = x.length;
    // Consistent, scaled FD steps: avoid phase-flip overshoot near the dome
    // while keeping the step large enough to dominate property-call noise.
    let h: number;
    let stepDir = 1;
    if (dof.kindOf(k) === "h") {
      // h variables (J/kg): single-phase property changes are tiny for a 1000 J/kg
      // step, so CoolProp noise swamps the FD derivative.  Use 5 % of h for
      // single-phase to get a measurable change; keep 1000 J/kg for two-phase
      // so we do not jump across the dome boundary.
      const hVal = x[k];
      const hNodeId = dof.energyNodeOf(k)!;
      const Pnode = x[dof.pressureCol(hNodeId)!];
      const phCheck = safeStatePH(
        fluidOf(hNodeId),
        Pnode,
        hVal,
        `FD phase check`,
      );
      const isTwoPhase =
        phCheck.quality !== undefined &&
        phCheck.quality > 0 &&
        phCheck.quality < 1;
      if (isTwoPhase) {
        h = Math.max(Math.abs(hVal) * 1e-5, 100.0);
        // One-sided step away from the nearest saturation boundary to avoid
        // crossing the dome edge where dρ/dh jumps ~50×.
        const { hf, hg } = getSatProps(rfOf(hNodeId).fluidName, Pnode);
        const distLiquid = hVal - hf;
        const distVapor = hg - hVal;
        if (distVapor < h && distLiquid >= h) {
          stepDir = -1; // close to vapor edge, step backward
        } else if (distLiquid < h && distVapor >= h) {
          stepDir = 1; // close to liquid edge, step forward
        } else if (distVapor < distLiquid) {
          stepDir = -1; // closer to vapor edge, step backward
        }
        // Guard: if chosen direction would cross boundary, flip it
        if (stepDir === 1 && hVal + h > hg) stepDir = -1;
        if (stepDir === -1 && hVal - h < hf) stepDir = 1;
      } else {
        h = Math.max(Math.abs(hVal) * 0.01, 1000.0);
      }
    } else if (ctx.isRealFluid && dof.kindOf(k) === "P") {
      // Pressure variables (Pa): for the extended system use a larger step so
      // single-phase density changes are measurable; for segregated keep the
      // small step because two-phase dome crossing is the dominant concern.
      if (useExtendedSystem) {
        h = Math.max(Math.abs(x[k]) * 1e-4, 100.0);
      } else {
        h = Math.max(Math.abs(x[k]) * 1e-6, 1.0);
      }
    } else {
      // mdot and legacy variables
      h = Math.max(Math.abs(x[k]) * 1e-6, 1e-6);
    }
    const xPert = [...x];
    xPert[k] = x[k] + h * stepDir;
    let R1: number[] | undefined;
    let shrunk = false;
    try {
      R1 = computeResidual(xPert);
    } catch {
      // Try a much smaller perturbation for realFluid where density
      // derivatives can be discontinuous across the saturation boundary.
      const shrink =
        dof.kindOf(k) === "h"
          ? 0.1
          : ctx.isRealFluid && dof.kindOf(k) === "P"
            ? 0.1
            : 1e-4;
      xPert[k] = x[k] + h * shrink * stepDir;
      shrunk = true;
      try {
        R1 = computeResidual(xPert);
      } catch {
        // Skip this column; leave zeros (direction is ignored by solver)
        return;
      }
    }
    // Use central differences for real-fluid pressure columns (more accurate
    // near dome) — but only when the forward evaluation actually sits at +h.
    // After a shrink the two samples are h·shrink ahead and h behind, so the
    // 2h denominator matches neither; the forward fallback below divides by
    // the step that was really taken and stays first-order correct.
    if (ctx.isRealFluid && k < nInt && !shrunk) {
      const xMinus = [...x];
      xMinus[k] -= h;
      let Rminus: number[] | undefined;
      try {
        Rminus = computeResidual(xMinus);
      } catch {
        // fallback to forward difference
      }
      if (Rminus !== undefined && R1 !== undefined) {
        for (let i = 0; i < n; i++) {
          J[i][k] = (R1[i] - Rminus[i]) / (2 * h);
        }
        return;
      }
    }
    for (let i = 0; i < n; i++) {
      J[i][k] = (R1[i] - R0[i]) / (xPert[k] - x[k]);
    }
  }

  /** Finite-difference Jacobian builder (legacy, always works).  `R0` is the
   *  base residual at `x` when the caller already has it — the Newton loop
   *  always does, and re-deriving it here costs a full residual evaluation
   *  (plus, for real fluids, a round of property flashes). */
  function numericalJacobian(x: number[], R0?: number[]): number[][] {
    const track = perfEnabled;
    if (track) enterJacobian("fd");
    try {
      return numericalJacobianBody(x, R0);
    } finally {
      if (track) leaveJacobian();
    }
  }

  function numericalJacobianBody(x: number[], R0in?: number[]): number[][] {
    const n = x.length;
    const J: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    let R0: number[];
    if (R0in !== undefined) {
      R0 = R0in;
    } else {
      try {
        R0 = computeResidual(x);
      } catch {
        // If base residual fails, return zero Jacobian (solver will backtrack via outer loop)
        return J;
      }
    }
    for (let k = 0; k < n; k++) {
      fdJacobianColumn(x, k, R0, J);
    }
    return J;
  }

  /** Hybrid Jacobian: exact dual-number derivatives everywhere the residual
   *  is differentiable, with FD only for the (row, column) entries that touch
   *  genuinely non-differentiable pieces (components without pressureDropDual,
   *  HeatedPipe branch heat) — the whole matrix no longer degrades to FD.
   *
   *  For real fluid the base state is fixed within one build, so each node's
   *  statePH value + analytic partials are identical across all n columns:
   *  buildDualPropCache evaluates them ONCE per node (O(nodes) CoolProp calls
   *  per build) and every column chains its seed through the table in pure
   *  arithmetic — this is what turns the dual path from "exact but just as
   *  many property calls as FD" into the measured O(nodes)-calls speedup. */
  function hybridJacobian(x: number[], R0?: number[]): number[][] {
    const track = perfEnabled;
    if (track) enterJacobian("hybrid");
    try {
      return hybridJacobianBody(x, R0);
    } finally {
      if (track) leaveJacobian();
    }
  }

  function hybridJacobianBody(x: number[], R0in?: number[]): number[][] {
    const n = x.length;
    const J: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

    let propCache: Map<string, DualPropEntry> | undefined;
    if (anyPH) {
      const c = buildDualPropCache(x);
      if (c === "FD_FALLBACK") return numericalJacobian(x, R0in);
      propCache = c;
    }

    // One seed vector for the whole build: each pass sets exactly one
    // component's derivative to 1 and clears it once the column has been read
    // out.  The dual residual reads the seeds within the pass and never
    // retains them across passes, so reusing the objects saves n × nVar
    // allocations per build without changing a number.  The clear must come
    // AFTER the read-out: a degenerate row can BE its seed (`R[ṁ] = mdot`),
    // and clearing first would report a derivative of 0 for it.
    const xDual: Dual[] = x.map((v) => ({ v, d: 0 }));
    let fdRows: Map<number, Set<number>> | undefined;
    for (let k = 0; k < n; k++) {
      xDual[k].d = 1;
      const RDual = computeResidualDual(xDual, propCache);
      if (RDual === "FD_FALLBACK") {
        // Wholesale-unsupported configuration (species, missing fluid duals,
        // real-fluid gas cushion): legacy whole-matrix FD.
        xDual[k].d = 0;
        return numericalJacobian(x, R0in);
      }
      fdRows = RDual.fdRows;
      for (let i = 0; i < n; i++) {
        J[i][k] = RDual.R[i].d;
      }
      xDual[k].d = 0;
    }

    // Per-column FD patch for the non-differentiable pieces, via the shared
    // fdJacobianColumn so patched entries are identical to what the pure-FD
    // builder produces for them.
    if (fdRows && fdRows.size > 0) {
      const fdCols = new Set<number>();
      for (const cols of fdRows.values()) for (const c of cols) fdCols.add(c);
      let R0: number[] | undefined = R0in;
      if (R0 === undefined) {
        try {
          R0 = computeResidual(x);
        } catch {
          R0 = undefined;
        }
      }
      if (R0 !== undefined) {
        const Jfd: number[][] = Array.from({ length: n }, () =>
          new Array(n).fill(0),
        );
        for (const k of fdCols) {
          fdJacobianColumn(x, k, R0, Jfd);
          for (const [row, cols] of fdRows) {
            if (cols.has(k)) J[row][k] = Jfd[row][k];
          }
        }
      }
    }
    return J;
  }

  return {
    computeResidual,
    fdJacobianColumn,
    numericalJacobian,
    hybridJacobian,
    invalidateStagTCache: () => {
      stagTCache = null;
    },
  };
}

export interface JacobianProbeResult {
  x: number[];
  hybrid: number[][];
  fd: number[][];
  /** Base residual at x — lets a probe compute its own reference FD columns
   *  (re-probe at x ± h·e_k) to arbitrate hybrid-vs-fd disagreements at a
   *  chosen step size.  undefined if the base residual evaluation throws. */
  R0?: number[];
}

/** Test/diagnostics hook: build the Newton kernel for a (ctx, state) pair and
 *  evaluate BOTH Jacobian paths at the same point, for entry-by-entry
 *  comparison.  Not on the solver hot path; used by the Jacobian
 *  consistency tests.  `x` defaults to the state vector assembled from
 *  `state` (internal P, branch mdots, internal h for the extended system). */
export function probeJacobians(
  ctx: SolverContext,
  state: StepState,
  options: { dt?: number; t?: number; prevState?: StepState },
  xOverride?: number[],
): JacobianProbeResult {
  const useExtendedSystem = ctx.isRealFluid && options.dt !== undefined;
  const useCoupledH = useCoupledHMode(ctx, options.dt);
  const dof = createUniformDofMap(ctx, {
    useExtendedSystem,
    useCoupledH,
  });
  const nVar = dof.nVar;
  const env: NewtonKernelEnv = {
    ctx,
    state,
    dt: options.dt,
    t: options.t,
    prevState: options.prevState,
    useExtendedSystem,
    useCoupledH,
    dof,
    conductorHMap: computeConductorHMap(ctx, state, undefined, options.t),
  };
  const kernel = makeKernel(env);
  const x =
    xOverride ??
    (() => {
      const X = new Array(nVar).fill(0);
      for (const id of ctx.internalIds)
        X[dof.pressureCol(id)!] = state.nodeP.get(id)!;
      for (let j = 0; j < ctx.nBranch; j++) X[dof.mdotCol(j)] = state.mdots[j];
      for (const id of dof.energyNodes) {
        X[dof.energyCol(id)!] =
          dof.energyKind(id) === "h"
            ? (state.nodeH?.get(id) ??
              ctx.fluidAssignment
                .node(id)
                .enthalpyPT(state.nodeP.get(id)!, state.nodeT.get(id)!))
            : state.nodeT.get(id)!;
      }
      return X;
    })();
  let R0: number[] | undefined;
  try {
    R0 = kernel.computeResidual(x);
  } catch {
    R0 = undefined;
  }
  return {
    x,
    hybrid: kernel.hybridJacobian(x, R0),
    fd: kernel.numericalJacobian(x, R0),
    R0,
  };
}
