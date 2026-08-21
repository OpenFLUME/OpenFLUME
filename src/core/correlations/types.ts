/**
 * Shared convection-correlation data structures: the resolved correlation
 * config union, the conductor/context/state shapes the wrapper and
 * dispatcher functions operate on, and the two tuning constants
 * (FALLBACK_H_FLOOR, H_RELAX) every model path shares.
 */
import type { FluidModel } from "../fluids";
import type { FluidAssignment } from "../fluidAssignment";
import type { ResolvedClosureParams } from "../closureParams";
import type { FluidFrontSharedState } from "../fluidFront";
import type { TtWfState, TtWfWallContext } from "../ttWf";
import type { CompiledExpression } from "../usercode/expression";

/** Optional correlation fields shared by every model. */
interface ConvectionCorrelationBase {
  flowArea?: number;
  /**
   * darrHartwig only: axial coordinate z of this conductor's fluid node,
   * measured from the pipe inlet [m].  Drives the quench-front distance
   * L = z − z_qf of the IAF buoyancy term (SPEC §3.4).  Required by
   * validate.ts for darrHartwig; at runtime an absent value degrades to
   * z = 0 (L hits the 0.05 m front-distance floor and is COUNTED in
   * diagnostics — loud, never silently extrapolated).
   * (ttWf also requires it; see schema.ts.)
   */
  axialPosition?: number;
  /**
   * darrHartwig/ttWf: inlet liquid Reynolds Re_l,in for the actual-quality
   * closure K = 5.26e−5·Re_l,in + 0.11 [P1 Table 1].  One global value per
   * pipe (SPEC §1 FLAG).  If omitted, the local-G estimate G·D/μ_l,sat(P)
   * is used (uniform-ṁ pipe assumption — P1's own fitting model imposed a
   * uniform measured ṁ along the pipe).
   */
  inletLiquidReynolds?: number;
  /**
   * ttWf only: axial segment length Δz [m] of the subcell wetted-fraction
   * state (schema.ts has the full contract).  Phase 1: parsed/validated but
   * NOT yet used by the solver heat-transfer path.
   */
  segmentLength?: number;
  /** ttWf only: C_q, energy-limited front-speed factor, bounds [0.25, 4]. */
  frontEnergyFactor?: number;
  /** ttWf only: ΔT_h, rewet/dry hysteresis offset [K], bounds [0, 5]. */
  rewetHysteresisOffsetK?: number;
  /** ttWf only, opt-in: gate the dry side by the transported cryogenic
   *  front fraction (docs/fluid-front-transport.md). */
  fluidFront?: boolean;
}

/**
 * Convection correlation runtime config (RESOLVED numbers — formula
 * bindings are already substituted by core/paramBindings.ts).
 *
 *  - Named models (dittusBoelter/miropolskii/darrHartwig/ttWf): `diameter`
 *    is REQUIRED (validate.ts enforces positivity).
 *  - 'custom': user h expression (schema.ts documents the scope).
 *    `diameter`/`flowArea` are optional; `expression` is required by
 *    validate.ts.  The expression is compiled ONCE per solver context
 *    (buildSolverContext → SolverContext.customExpressions →
 *    CorrelationCtx.customExpressions) — never inside an iteration loop.
 */
export type ConvectionCorrelation =
  | (ConvectionCorrelationBase & {
      model: "dittusBoelter" | "miropolskii" | "darrHartwig" | "ttWf";
      diameter: number;
    })
  | (ConvectionCorrelationBase & {
      model: "custom";
      diameter?: number;
      expression?: string;
      params?: Record<string, number>;
    });

export interface CorrelationConductor {
  id: string;
  from: string;
  to: string;
  type: {
    kind: "convection";
    h?: number;
    area: number;
    correlation?: ConvectionCorrelation;
  };
}

/**
 * Shared step-level state for the darrHartwig model (SPEC §7.4).  The latch
 * map is FROZEN within a time step (read-only inside solves/Newton) and
 * updated only at step acceptance via updateDarrHartwigLatches — a latch
 * flipping mid-Newton would create exactly the limit-cycle nonsmoothness
 * documented in docs/solver-convergence.md.  axialPosition is
 * immutable per solve (config geometry).
 */
export interface DarrHartwigSharedState {
  latch: Map<string, { rewetLatched: boolean }>;
  axialPosition: Map<string, number>;
}

/** Area-dominant regime label of the TT-WF two-side flux map (dryRegime is
 *  'FB'|'SP', wetRegime 'DB'|'NB'|'TB'|'FB' in ttWf.ts). */
export type TtWfRegimeLabel = "DB" | "NB" | "TB" | "FB" | "SP";

/** Per-conductor accepted-step snapshot for transient-result recording
 *  (one entry per recorded time, aligned 1:1 with TransientResult.times). */
export interface TtWfStepSnapshot {
  fWet: number;
  rewetLatched: boolean;
  /** Label of the area-dominant side at the COMMITTED fWet (≥ 0.5 ⇒ wet). */
  regime: TtWfRegimeLabel;
}

/**
 * Shared step-level state for the ttWf model — the SAME lifecycle discipline
 * as DarrHartwigSharedState (docs/solver-convergence.md is the standing
 * warning): `state` (accepted fWet/rewet latch per conductor id) is FROZEN
 * within a time step — read-only inside solves/Newton/rejected adaptive
 * trials — and advanced ONLY by updateTtWfStates at step acceptance (or t = 0
 * initialization).  axialPosition and wall are immutable per solve (config
 * geometry / wall material).  lastSnapshot is diagnostics-only bookkeeping
 * (the previous committed snapshot, reused if a commit evaluation fails).
 */
export interface TtWfSharedState {
  state: Map<string, TtWfState>;
  axialPosition: Map<string, number>;
  wall: Map<string, TtWfWallContext>;
  lastSnapshot: Map<string, TtWfStepSnapshot>;
}

export interface CorrelationCtx {
  fluid: FluidModel;
  /**
   * Per-node fluid lookup. When omitted, evaluations use `fluid` (single-fluid
   * tests that build a CorrelationCtx by hand stay bit-identical).
   */
  fluidAssignment?: FluidAssignment;
  /** True when ANY fluid in the network is realFluid (mirrors
   *  SolverContext.isRealFluid).  A cheap bail-out only — correlation
   *  evaluation dispatches per conductor on `instanceof RealFluid` for the
   *  resolved fluid, so mixed-EOS networks skip analytic nodes cleanly. */
  isRealFluid: boolean;
  branches: Array<{ id: string; from: string; to: string }>;
  nBranch: number;
  nodeMap: Map<string, { id: string; type: "internal" | "boundary" }>;
  /**
   * Resolved closure constants (from NetworkConfig.closureParams via the
   * solver context).  Undefined ⇒ the published defaults — bit-identical
   * to the pre-ClosureParams hardcoded behaviour.
   */
  closureParams?: ResolvedClosureParams;
  /** Present iff the network contains at least one darrHartwig conductor. */
  darrHartwig?: DarrHartwigSharedState;
  /** Present iff the network contains at least one ttWf conductor. */
  ttWf?: TtWfSharedState;
  /**
   * Present iff at least one ttWf conductor opts into the fluid-front
   * model (correlation.fluidFront: true).  Holds the ACCEPTED cryogenic
   * front fraction a per internal node — read-only here (frozen mid-step);
   * mutated only by updateFluidFrontStates at accepted step boundaries.
   */
  fluidFront?: FluidFrontSharedState;
  /**
   * Pre-compiled 'custom'-model h expressions, keyed by conductor id.
   * Compiled ONCE in buildSolverContext and shared BY REFERENCE (same
   * discipline as the darrHartwig/ttWf step-level stores): the h-map
   * refresh path never re-parses user source.  Direct callers that build a
   * CorrelationCtx by hand may omit it — the custom branch then compiles on
   * first use and memoizes into the map when one is present.
   */
  customExpressions?: Map<string, CompiledExpression>;
}

export interface CorrelationState {
  nodeP: Map<string, number>;
  nodeT: Map<string, number>;
  nodeH?: Map<string, number>;
  nodeQuality?: Map<string, number | undefined>;
  nodePhase?: Map<string, string | undefined>;
  nodeMu?: Map<string, number>;
  mdots: number[];
  /**
   * Wall (solid-node) temperatures, keyed by solid node id.  Required by
   * the darrHartwig model (its regime map is driven by T_wall); models that
   * do not need it behave exactly as before whether or not it is present.
   */
  solidT?: Map<string, number>;
}

/** Minimum fallback h when correlation is active and no explicit h is supplied. */
export const FALLBACK_H_FLOOR = 5; // W/m²K

/** Under-relaxation factor for h across outer iterations (documented safety). */
export const H_RELAX = 0.5;
