/**
 * Shared solver data structures.
 *
 * - `SolverContext` — everything immutable-per-solve (fluid models, network
 *   topology/indexing, conductors, resolved property curves) plus the few
 *   step-level shared states (correlation latches, controller overrides)
 *   whose lifecycle is documented on each field.  Built once by
 *   `buildSolverContext` (see ./context.ts) and threaded through every
 *   solver function.
 * - `StepState` — the complete mutable solution state at one point in time
 *   (node P/T/ρ/μ[/h/quality/phase/Y], branch mass flows, solid
 *   temperatures).  Steady solves converge one StepState in place;
 *   transient solves evolve it step by step.
 */
import type { NetworkConfig, ResolvedNetworkConfig } from "../schema";
import type { FluidModel } from "../fluids";
import type { BranchComponent } from "../components";
import type { FluidAssignment } from "../fluidAssignment";
import type { CompiledExpression } from "../usercode/expression";
import type { DarrHartwigSharedState, TtWfSharedState } from "../correlations";
import type { FluidFrontSharedState } from "../fluidFront";
import type { PiecewiseLinearProperty } from "../solidProperties";
import type { ResolvedClosureParams } from "../closureParams";
import type { CombustionModel } from "../combustion/model";

/** One reacting junction (JunctionConfig, core/schema.ts) resolved to
 *  solver indices at context build.  The kernel replaces the junction
 *  node's energy row with the thermochemical closure; the step driver
 *  Picard-lags the product continuum's ideal-gas params from `model`. */
export interface SolverJunctionEntry {
  id: string;
  /** Internal product node whose energy row carries the closure. */
  nodeId: string;
  /** Inlet branch indices per reactant role (per-role |ṁ| sums feed the
   *  model). */
  roleBranches: Map<string, number[]>;
  /** All inlet branch indices — these branches join unlike fluids, so the
   *  kernel keeps their momentum closure on the UPSTREAM (reactant) density
   *  only (no cross-fluid harmonic-mean friction density, no momentum-flux
   *  acceleration term across the injection face). */
  inletBranchIdx: Set<number>;
  model: CombustionModel;
  /** Combustion efficiency applied to the model's adiabatic T0. */
  efficiency: number;
  /** Named fluid (config.fluids key) of the product continuum, whose model
   *  instance is swapped in ctx.namedFluidModels between outer iterations. */
  productFluidName: string;
}

export interface ConductorEntry {
  id: string;
  from: string;
  to: string;
  type:
    | {
        kind: "conduction";
        k: import("../schema").SolidPropertySpec;
        area: number;
        length: number;
      }
    | {
        kind: "convection";
        h?: number;
        area: number;
        correlation?: {
          model:
            "dittusBoelter" | "miropolskii" | "darrHartwig" | "ttWf" | "custom";
          /** Required (positive) for the named models — validate.ts; optional
           *  for 'custom'. */
          diameter?: number;
          flowArea?: number;
          /** 'custom' only: user h expression (safe expression language). */
          expression?: string;
          /** 'custom' only: named numeric constants for the expression. */
          params?: Record<string, number>;
          axialPosition?: number;
          inletLiquidReynolds?: number;
          segmentLength?: number;
          frontEnergyFactor?: number;
          rewetHysteresisOffsetK?: number;
        };
      }
    | {
        kind: "radiation";
        emissivity: number;
        area: number;
        viewFactor: number;
      };
  /** Resolved T-dependent k curve (conduction only).  Undefined ⇔ constant k
   *  (the legacy path — `type.k` is then a number and arithmetic is unchanged). */
  kCurve?: PiecewiseLinearProperty;
  /** Resolved TIME-dependent k curve (conduction only, `{ timeTable }` spec —
   *  transient mode).  The conductance for a candidate step uses the constant
   *  value k(t_end) (backward Euler), so within a step the conductor follows
   *  the constant-k pathway exactly (no T-derivative contribution). */
  kTimeCurve?: PiecewiseLinearProperty;
}

export interface SolverContext {
  fluid: FluidModel;
  /**
   * Per-node/per-branch fluid lookup (core/fluidAssignment.ts).
   * Single-fluid networks resolve every id to `fluid` itself; multi-fluid
   * networks (config.fluids) resolve named continua per node, with branches
   * inheriting from their endpoints.  All property access in the kernels
   * goes through this, which is what lets EOS classes differ per node.
   */
  fluidAssignment: FluidAssignment;
  mixtureFluid?: import("../fluids").MixtureFluidModel;
  /** True when ANY fluid in the network (default or a named extra) is
   *  realFluid.  Gates the global numerics strategy — extended transient
   *  [P, ṁ, h] system, PTC, trust region — conservatively for the whole
   *  network; per-node property access and state publishing dispatch on
   *  `instanceof RealFluid` instead. */
  isRealFluid: boolean;
  hasSpecies: boolean;
  /** settings.momentumFlux: include ΔP_accel = (ṁ/A)²(1/ρ_dn − 1/ρ_up) in
   *  branch momentum rows (and the reported branch dP). */
  momentumFlux: boolean;
  /** settings.kineticEnergy: transport stagnation enthalpy h + V²/2
   *  (V = ṁ/(ρA) at the endpoint state) in the nodal energy balance —
   *  quasi-1-D compressible formulation together with momentumFlux.
   *  Any fluid model: steady solves use the coupled [P, ṁ, h] enthalpy
   *  system (kernel.ts useCoupledHMode); species networks keep the
   *  segregated stagnation-enthalpy update. */
  kineticEnergy: boolean;
  speciesNames: string[];
  reactions?: import("../schema").ArrheniusReaction[];
  nodeMap: Map<string, ResolvedNetworkConfig["nodes"][number]>;
  internalIds: string[];
  boundaryIds: string[];
  internalIndex: Map<string, number>;
  branches: Array<{
    id: string;
    from: string;
    to: string;
    component: BranchComponent;
    inertia?: boolean;
  }>;
  nInt: number;
  nBranch: number;
  // Thermal subsystem
  solidNodeMap: Map<string, NonNullable<NetworkConfig["solidNodes"]>[number]>;
  ambientIds: Set<string>;
  solidIds: string[];
  solidIndex: Map<string, number>;
  conductors: ConductorEntry[];
  nSolid: number;
  /** Resolved T-dependent cp curves per solid node (undefined per node ⇔
   *  constant cp — the legacy storage term is then used unchanged). */
  solidCpCurves: Map<string, PiecewiseLinearProperty>;
  /** Resolved TIME-dependent cp curves per solid node (`{ timeTable }` spec —
   *  transient mode).  A node's candidate-step storage term is the constant-cp
   *  form with cp = curve.value(t_end) (backward Euler), frozen across the
   *  step's Newton: exact per-step Jacobian via the constant-cp pathway. */
  solidCpTimeCurves: Map<string, PiecewiseLinearProperty>;
  /**
   * Resolved closure-correlation constants (physically-meaningful only —
   * solver numerics are structurally unreachable, see closureParams.ts).
   * Defaults are the published constants; the arithmetic is then
   * bit-identical to the pre-ClosureParams hardcoded behaviour.
   */
  closureParams: ResolvedClosureParams;
  /**
   * Retry-cascade tier that converged the most recent hard step (mutable
   * per-context, shared across the steps of a solve).  Hard dome-edge
   * steps cluster, so the step-control that just worked is tried first.
   */
  lastGoodCascadeTier?: number;
  /**
   * darrHartwig correlation step-level state (rewet-hysteresis latch +
   * immutable axial positions), keyed by conductor id.  The latch is FROZEN
   * within a time step (read-only for the h-map refreshes between outer
   * iterations — never inside Newton) and updated only at step acceptance
   * via updateConductorLatches (transient.ts).  Steady solves never update
   * it: the memoryless published regime map (SPEC §2.9) is used.  Always
   * allocated; empty maps when no darrHartwig conductor is configured.
   */
  darrHartwig: DarrHartwigSharedState;
  /**
   * ttWf correlation accepted-step state (wetted fraction + rewet latch per
   * conductor), plus immutable config geometry (axial positions) and wall
   * energy contexts (m′_wall, H_s).  SAME lifecycle discipline as
   * darrHartwig: FROZEN within a time step (read-only for the h-map
   * refreshes between outer iterations — never inside Newton) and advanced
   * only at step acceptance via updateConductorLatches (transient.ts) with
   * the ACCEPTED dt.  Trial half-steps of the adaptive step-doubling solver
   * and rejected steps never touch it (proposals live in the discarded
   * evaluation results only).  Always allocated; empty maps when no ttWf
   * conductor is configured.
   */
  ttWf: TtWfSharedState;
  /**
   * Pre-compiled 'custom' convection-correlation h expressions, keyed by
   * conductor id (core/usercode/expression.ts — the safe tree evaluator;
   * no eval/new Function).  Compiled ONCE here at context build and shared
   * BY REFERENCE into every CorrelationCtx — the h-map refresh path never
   * re-parses user source.  Empty when no custom conductor is configured.
   */
  customExpressions: Map<string, CompiledExpression>;
  /**
   * Fluid-front transport accepted-step state (cryogenic front fraction a
   * per internal fluid node; src/core/fluidFront.ts).  Present ONLY when at
   * least one ttWf conductor opts in via correlation.fluidFront — otherwise
   * undefined and every path is bit-identical to before this feature.
   * SAME lifecycle discipline as darrHartwig/ttWf: FROZEN within a time
   * step (the dry-side gate reads the accepted a — never inside Newton) and
   * advanced only at step acceptance via updateFluidFrontStates
   * (transient.ts), with the ACCEPTED dt.  Trial half-steps of the adaptive
   * step-doubling solver and rejected steps never touch it.
   */
  fluidFront?: FluidFrontSharedState;
  /**
   * Controller actuation overrides (core/controllerRuntime.ts), keyed by
   * node id.  Boundary pressure/temperature overrides are applied by
   * applyBoundaryConditions (transient.ts) AFTER the base schedules, so a
   * written override always wins; heatInput overrides are read by
   * heatInputOf at every energy-residual site.  Always allocated; empty
   * maps when no controller is configured (every path is then
   * bit-identical to a solve without controllers).
   */
  boundaryPressureOverride: Map<string, number>;
  boundaryTemperatureOverride: Map<string, number>;
  heatInputOverride: Map<string, number>;
  /**
   * Reacting junctions resolved to solver indices (config.junctions).
   * Always allocated; empty when none are configured — every path is then
   * bit-identical to a solve without junctions.
   */
  junctions: SolverJunctionEntry[];
  /**
   * The LIVE named-fluid model map backing fluidAssignment (multi-fluid
   * networks only).  The outer Picard loop swaps a junction's product-gas
   * IdealGas instance here between iterations (property lag) — the
   * assignment resolves names at lookup time, so kernels see the update on
   * their next property call without a context rebuild.
   */
  namedFluidModels?: Map<string, FluidModel>;
}

/**
 * Effective heat input [W] of a fluid or solid node: the controller
 * override when one has been written, else the configured base value.
 * With no override written this is exactly `node.heatInput ?? 0`.
 */
export function heatInputOf(
  ctx: SolverContext,
  node: { id: string; heatInput?: number },
): number {
  return ctx.heatInputOverride.get(node.id) ?? node.heatInput ?? 0;
}

export interface StepState {
  nodeP: Map<string, number>;
  nodeT: Map<string, number>;
  nodeRho: Map<string, number>;
  nodeMu: Map<string, number>;
  nodeH?: Map<string, number>;
  nodeQuality?: Map<string, number | undefined>;
  nodePhase?: Map<string, string | undefined>;
  nodeY?: Map<string, Record<string, number>>;
  mdots: number[];
  solidT: Map<string, number>;
}

export function cloneStepState(state: StepState): StepState {
  return {
    nodeP: new Map(state.nodeP),
    nodeT: new Map(state.nodeT),
    nodeRho: new Map(state.nodeRho),
    nodeMu: new Map(state.nodeMu),
    nodeH: state.nodeH ? new Map(state.nodeH) : undefined,
    nodeQuality: state.nodeQuality ? new Map(state.nodeQuality) : undefined,
    nodePhase: state.nodePhase ? new Map(state.nodePhase) : undefined,
    nodeY: state.nodeY ? new Map(state.nodeY) : undefined,
    mdots: [...state.mdots],
    solidT: new Map(state.solidT),
  };
}

export function copyStepStateInto(dst: StepState, src: StepState): void {
  dst.nodeP = new Map(src.nodeP);
  dst.nodeT = new Map(src.nodeT);
  dst.nodeRho = new Map(src.nodeRho);
  dst.nodeMu = new Map(src.nodeMu);
  dst.nodeH = src.nodeH ? new Map(src.nodeH) : undefined;
  dst.nodeQuality = src.nodeQuality ? new Map(src.nodeQuality) : undefined;
  dst.nodePhase = src.nodePhase ? new Map(src.nodePhase) : undefined;
  dst.nodeY = src.nodeY ? new Map(src.nodeY) : undefined;
  dst.mdots = [...src.mdots];
  dst.solidT = new Map(src.solidT);
}
