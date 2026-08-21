/**
 * Per-solve setup: build the immutable SolverContext from a NetworkConfig,
 * create the initial StepState, and expose the state to the user-logic
 * runtime.  Everything downstream of this module works with plain numbers
 * and pre-resolved models — no config parsing or parameter-binding
 * resolution happens on the solver hot path.
 */
import type { NetworkConfig, ResolvedNetworkConfig } from "../schema";
import { resolveNetworkParameters } from "../paramBindings";
import { createFluidModel, IdealGasMixture } from "../fluids";
import type { FluidModel } from "../fluids";
import { RealFluid } from "../fluids/realFluid";
import { buildBranchComponents } from "../componentFactory";
import { createFluidAssignment } from "../fluidAssignment";
import type { FluidAssignmentMaps } from "../fluidAssignment";
import {
  ExpressionError,
  compileExpression,
  type CompiledExpression,
} from "../usercode/expression";
import type { LogicStateScope } from "../logicRuntime";
import type { DarrHartwigSharedState, TtWfSharedState } from "../correlations";
import type { FluidFrontSharedState } from "../fluidFront";
import {
  resolveSolidProperty,
  resolveSolidTimeProperty,
  PiecewiseLinearProperty,
} from "../solidProperties";
import { resolveClosureParams } from "../closureParams";
import type { ConductorEntry, SolverContext, StepState } from "./types";

/**
 * Build the immutable per-solve context.  Static parameter bindings
 * (core/paramBindings.ts) are resolved here as defense in depth — the
 * context is built from the immutable resolved clone, so node volumes and
 * component/conductor geometry are plain numbers throughout the solver.
 * Callers that already resolved (solveSteady/solveTransient/validateNetwork)
 * hit the identity fast path.
 */
export function buildSolverContext(inputConfig: NetworkConfig): SolverContext {
  const resolution = resolveNetworkParameters(inputConfig);
  if (!resolution.ok) {
    throw new Error(
      `buildSolverContext: invalid parameter bindings:\n${resolution.errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
  const config = resolution.config;
  const fluid = createFluidModel(
    config.fluid.model,
    config.fluid.preset,
    config.fluid.params,
  );
  const closureParams = resolveClosureParams(config.closureParams);
  // "Any real fluid present": drives the GLOBAL numerics strategy (PTC,
  // trust region, retry cascade, convergence floors, the extended transient
  // system).  For every single-EOS network this equals the historical
  // "default fluid is realFluid" flag; in a mixed-EOS network the
  // conservative real-fluid strategy wins, while property access and state
  // publishing dispatch per node (instanceof RealFluid).
  const isRealFluid =
    config.fluid.model === "realFluid" ||
    Object.values(config.fluids ?? {}).some((s) => s.model === "realFluid");
  const hasSpecies = !!config.species && config.species.names.length > 0;
  const speciesNames = hasSpecies ? [...config.species!.names] : [];
  let mixtureFluid: import("../fluids").MixtureFluidModel | undefined;
  if (hasSpecies && config.fluid.model === "idealGas") {
    mixtureFluid = new IdealGasMixture(
      config.species!.names,
      config.species!.molecularWeights,
      config.species!.cp,
      config.species!.formationEnthalpy,
      config.species!.viscosity,
    );
  }
  const nodeMap = new Map<string, ResolvedNetworkConfig["nodes"][number]>();
  const internalIds: string[] = [];
  const boundaryIds: string[] = [];
  for (const node of config.nodes) {
    nodeMap.set(node.id, node);
    if (node.type === "internal") internalIds.push(node.id);
    else boundaryIds.push(node.id);
  }
  const internalIndex = new Map<string, number>();
  internalIds.forEach((id, i) => internalIndex.set(id, i));

  // Branch component instantiation + user-component library compilation
  // live in core/componentFactory.ts: referenced library entries are
  // preflighted centrally and each userComponent branch gets a FRESHLY
  // compiled definition (per-branch closure isolation).
  const branches = buildBranchComponents(config, closureParams);

  // Fluid assignment (core/fluidAssignment.ts): single-fluid-backed when no
  // named fluids are declared — every lookup returns `fluid` itself.
  const namedModels = new Map<string, FluidModel>();
  if (config.fluids) {
    for (const [name, spec] of Object.entries(config.fluids)) {
      namedModels.set(
        name,
        createFluidModel(spec.model, spec.preset, spec.params),
      );
    }
  }
  const nodeFluid = new Map<string, string>();
  for (const node of config.nodes) {
    if (node.fluid) nodeFluid.set(node.id, node.fluid);
  }
  const branchFrom = new Map<string, string>();
  for (const b of branches) branchFrom.set(b.id, b.from);
  const assignmentMaps: FluidAssignmentMaps | undefined =
    namedModels.size > 0 || nodeFluid.size > 0
      ? { named: namedModels, nodeFluid, branchFrom }
      : undefined;
  const fluidAssignment = createFluidAssignment(
    fluid,
    {
      nodes: nodeMap.keys(),
      branches: branches.map((b) => b.id),
    },
    assignmentMaps,
  );

  // Build thermal context
  const solidNodeMap = new Map<
    string,
    NonNullable<NetworkConfig["solidNodes"]>[number]
  >();
  const ambientIds = new Set<string>();
  const solidIds: string[] = [];
  for (const sNode of config.solidNodes ?? []) {
    solidNodeMap.set(sNode.id, sNode);
    if (sNode.type === "ambient") {
      ambientIds.add(sNode.id);
    } else {
      solidIds.push(sNode.id);
    }
  }
  const solidIndex = new Map<string, number>();
  solidIds.forEach((id, i) => solidIndex.set(id, i));

  const conductors: ConductorEntry[] = (config.conductors ?? []).map((c) => {
    const entry: ConductorEntry = {
      id: c.id,
      from: c.from,
      to: c.to,
      type: c.type,
    };
    if (c.type.kind === "conduction" && typeof c.type.k !== "number") {
      // `{ timeTable }` resolves to a TIME-domain curve (transient only —
      // validate.ts rejects it for steady); `{ expression }` and the other
      // shapes resolve to T-domain curves via the shared resolver.
      const kTime = resolveSolidTimeProperty(
        c.type.k,
        "k",
        `conductor ${c.id}`,
      );
      if (kTime) {
        entry.kTimeCurve = kTime;
      } else {
        const r = resolveSolidProperty(c.type.k, "k", `conductor ${c.id}`);
        if (typeof r !== "number") entry.kCurve = r;
      }
    }
    return entry;
  });

  // darrHartwig step-level state: immutable axial positions from config
  // (quench-front L bookkeeping, SPEC §3.4); the latch map starts EMPTY and
  // is populated/updated only at step boundaries by updateConductorLatches.
  const darrHartwig: DarrHartwigSharedState = {
    latch: new Map(),
    axialPosition: new Map(),
  };
  for (const c of config.conductors ?? []) {
    if (
      c.type.kind === "convection" &&
      c.type.correlation?.model === "darrHartwig"
    ) {
      darrHartwig.axialPosition.set(
        c.id,
        c.type.correlation.axialPosition ?? 0,
      );
    }
  }

  // 'custom' convection correlations: compile the h expression ONCE per
  // context (safe tree evaluator — no eval/new Function); the h-map refresh
  // path only ever re-EVALUATES the compiled form.  validate.ts rejects
  // empty/unparseable expressions; an expression that still fails to
  // compile here is simply absent from the cache and the runtime evaluates
  // it as the fallback h (evaluateCustomCorrelationH never throws).
  const customExpressions = new Map<string, CompiledExpression>();
  for (const c of config.conductors ?? []) {
    if (
      c.type.kind === "convection" &&
      c.type.correlation?.model === "custom"
    ) {
      const source = c.type.correlation.expression;
      if (typeof source === "string" && source.trim().length > 0) {
        try {
          customExpressions.set(c.id, compileExpression(source));
        } catch {
          // validated upstream; runtime falls back to the h floor
        }
      }
    }
  }

  const solidCpCurves = new Map<string, PiecewiseLinearProperty>();
  const solidCpTimeCurves = new Map<string, PiecewiseLinearProperty>();
  // Material-property nuisance multiplier (NOT a closure — see
  // closureParams.ts).  Applied once here to T-dependent curves (scaled
  // knots), and at the storage term for constant cp (assembleThermalSubsystem).
  // Scale 1 keeps the exact legacy arithmetic (guarded explicitly below).
  const cpScale = closureParams.solidCpScale;
  for (const sNode of config.solidNodes ?? []) {
    if (sNode.cp !== undefined && typeof sNode.cp !== "number") {
      // `{ timeTable }` → TIME-domain curve (transient only; validate.ts
      // rejects it for steady).  cpScale is baked into the knots here too, so
      // the per-step read `curve.value(t_end)` matches the constant-cp
      // pathway's scaled storage term.
      const cpTime = resolveSolidTimeProperty(
        sNode.cp,
        "cp",
        `solid node ${sNode.id}`,
      );
      if (cpTime) {
        solidCpTimeCurves.set(
          sNode.id,
          cpScale === 1
            ? cpTime
            : new PiecewiseLinearProperty(
                cpTime.knots.map(([t, v]): [number, number] => [
                  t,
                  v * cpScale,
                ]),
              ),
        );
        continue;
      }
      const r = resolveSolidProperty(sNode.cp, "cp", `solid node ${sNode.id}`);
      if (typeof r !== "number") {
        solidCpCurves.set(
          sNode.id,
          cpScale === 1
            ? r
            : new PiecewiseLinearProperty(
                r.knots.map(([T, v]): [number, number] => [T, v * cpScale]),
              ),
        );
      }
    }
  }

  // ttWf accepted-step state: immutable axial positions + wall energy
  // contexts from config (the wall node is the lumped wall of ONE axial
  // segment of length segmentLength, so m′_wall = m_wall/Δz; H_s(T) is the
  // exact enthalpy integral of the resolved — possibly cpScale-scaled — cp
  // curve, or cp·T for constant cp, consistent with the solver's own solid
  // storage term).  The state map starts EMPTY and is initialized at t = 0 /
  // committed per accepted step by updateConductorLatches.
  const ttWf: TtWfSharedState = {
    state: new Map(),
    axialPosition: new Map(),
    wall: new Map(),
    lastSnapshot: new Map(),
  };
  for (const c of config.conductors ?? []) {
    if (c.type.kind === "convection" && c.type.correlation?.model === "ttWf") {
      const corr = c.type.correlation;
      ttWf.axialPosition.set(c.id, corr.axialPosition ?? 0);
      const fluidNodeId = nodeMap.has(c.from) ? c.from : c.to;
      const wallNodeId = fluidNodeId === c.from ? c.to : c.from;
      const sNode = solidNodeMap.get(wallNodeId);
      const dz = corr.segmentLength;
      const m = sNode?.mass ?? 0;
      if (sNode && dz !== undefined && dz > 0 && m > 0) {
        const cpCurve = solidCpCurves.get(wallNodeId);
        if (cpCurve) {
          ttWf.wall.set(c.id, {
            massPerLength: m / dz,
            enthalpy: (T) => cpCurve.integral(T),
          });
        } else {
          const cpBase = typeof sNode.cp === "number" ? sNode.cp : 0;
          const cp = cpScale === 1 ? cpBase : cpBase * cpScale;
          if (cp > 0) {
            ttWf.wall.set(c.id, {
              massPerLength: m / dz,
              enthalpy: (T) => cp * T,
            });
          }
        }
      }
      // If no wall context could be built (validate.ts should have rejected
      // the config), the h-map/commit paths take the loud counted fallback.
    }
  }

  // Fluid-front transport state (src/core/fluidFront.ts): allocated ONLY
  // when at least one ttWf conductor opts in via correlation.fluidFront.
  // The state map starts EMPTY and is initialized at t = 0 / committed per
  // accepted step by updateFluidFrontStates.  Boundary values come from the
  // node-level fluidFrontInlet field (absent ⇒ 0 — a warm boundary).
  let fluidFront: FluidFrontSharedState | undefined;
  const frontEnabled = (config.conductors ?? []).some(
    (c) =>
      c.type.kind === "convection" &&
      c.type.correlation?.model === "ttWf" &&
      c.type.correlation?.fluidFront === true,
  );
  if (frontEnabled) {
    const boundary = new Map<string, number>();
    for (const node of config.nodes) {
      if (node.type === "boundary" && node.fluidFrontInlet !== undefined) {
        boundary.set(node.id, node.fluidFrontInlet);
      }
    }
    fluidFront = {
      a: new Map(),
      boundary,
      nodeIds: [...internalIds],
      prevMass: new Map(),
    };
  }

  return {
    fluid,
    fluidAssignment,
    mixtureFluid,
    isRealFluid,
    hasSpecies,
    momentumFlux: config.settings.momentumFlux === true,
    kineticEnergy: config.settings.kineticEnergy === true,
    speciesNames,
    reactions: config.species?.reactions,
    nodeMap,
    internalIds,
    boundaryIds,
    internalIndex,
    branches,
    nInt: internalIds.length,
    nBranch: branches.length,
    solidNodeMap,
    ambientIds,
    solidIds,
    solidIndex,
    conductors,
    nSolid: solidIds.length,
    solidCpCurves,
    solidCpTimeCurves,
    closureParams,
    darrHartwig,
    ttWf,
    fluidFront,
    customExpressions,
    boundaryPressureOverride: new Map(),
    boundaryTemperatureOverride: new Map(),
    heatInputOverride: new Map(),
  };
}

export function createInitialState(
  ctx: SolverContext,
  config: NetworkConfig,
): StepState {
  const nodeP = new Map<string, number>();
  const nodeT = new Map<string, number>();
  const nodeRho = new Map<string, number>();
  const nodeMu = new Map<string, number>();
  const nodeH = new Map<string, number>();
  const nodeQuality = new Map<string, number | undefined>();
  const nodePhase = new Map<string, string | undefined>();
  const nodeY = new Map<string, Record<string, number>>();
  for (const node of config.nodes) {
    const P = node.pressure ?? 1e5;
    const nodeFluid = ctx.fluidAssignment.node(node.id);
    if (nodeFluid instanceof RealFluid) {
      const fluid = nodeFluid;
      let h: number;
      let T: number;
      let rho: number;
      let mu: number;
      let quality: number | undefined;
      let phase: string | undefined;
      if (node.quality !== undefined) {
        h = fluid.enthalpyPQ(P, node.quality);
        const ph = fluid.statePH(P, h);
        T = ph.T;
        rho = ph.rho;
        mu = ph.mu;
        quality = ph.quality;
        phase = ph.phase;
      } else {
        T = node.temperature ?? 300;
        h = fluid.enthalpyPT(P, T);
        const ph = fluid.statePH(P, h);
        rho = ph.rho;
        mu = ph.mu;
        quality = ph.quality;
        phase = ph.phase;
      }
      nodeP.set(node.id, P);
      nodeT.set(node.id, T);
      nodeRho.set(node.id, rho);
      nodeMu.set(node.id, mu);
      nodeH.set(node.id, h);
      nodeQuality.set(node.id, quality);
      nodePhase.set(node.id, phase);
    } else {
      const T = node.temperature ?? 300;
      nodeP.set(node.id, P);
      nodeT.set(node.id, T);
      if (ctx.isRealFluid) {
        // Mixed-EOS network: the real-fluid machinery reads state.nodeH for
        // EVERY node, so analytic nodes carry h = h(P, T) too (exact — their
        // enthalpy is a function of T alone) with no quality/phase.
        nodeH.set(node.id, nodeFluid.enthalpyPT(P, T));
        nodeQuality.set(node.id, undefined);
        nodePhase.set(node.id, undefined);
      }
      if (ctx.hasSpecies && ctx.mixtureFluid) {
        const Y: Record<string, number> = {};
        let sum = 0;
        for (const sp of ctx.speciesNames) {
          const y =
            node.massFractions?.[sp] ??
            (ctx.speciesNames.indexOf(sp) === 0 ? 1 : 0);
          Y[sp] = y;
          sum += y;
        }
        if (sum > 0) {
          for (const sp of ctx.speciesNames) Y[sp] /= sum;
        } else if (ctx.speciesNames.length > 0) {
          Y[ctx.speciesNames[0]] = 1;
        }
        nodeY.set(node.id, Y);
        nodeRho.set(node.id, ctx.mixtureFluid.densityMix(P, T, Y));
        nodeMu.set(node.id, ctx.mixtureFluid.viscosityMix(P, T, Y));
      } else {
        nodeRho.set(node.id, ctx.fluidAssignment.node(node.id).density(P, T));
        nodeMu.set(node.id, ctx.fluidAssignment.node(node.id).viscosity(P, T));
      }
    }
  }
  const mdots = config.branches.map((b) => b.initialMdot ?? 0.1);
  const solidT = new Map<string, number>();
  for (const sNode of config.solidNodes ?? []) {
    solidT.set(sNode.id, sNode.temperature);
  }
  if (ctx.isRealFluid) {
    return {
      nodeP,
      nodeT,
      nodeRho,
      nodeMu,
      nodeH,
      nodeQuality,
      nodePhase,
      mdots,
      solidT,
      nodeY,
    };
  }
  return { nodeP, nodeT, nodeRho, nodeMu, mdots, solidT, nodeY };
}

/**
 * Build the node/branch/solid state accessors for the user-logic runtime
 * (core/logicRuntime.ts) over ONE StepState object.  The closures read the
 * maps they captured, so callers that REPLACE the state (adaptive transient
 * commits `state = s2`) must rebuild the scope for the new state object.
 * Unknown ids throw ExpressionError (loud failure, not a silent 0).
 */
export function buildLogicScope(
  ctx: SolverContext,
  state: StepState,
): LogicStateScope {
  const branchIndex = new Map<string, number>();
  ctx.branches.forEach((b, j) => branchIndex.set(b.id, j));
  return {
    node(id: string): Record<string, number> {
      const P = state.nodeP.get(id);
      if (P === undefined)
        throw new ExpressionError("evaluate", `Unknown node "${id}"`);
      const rec: Record<string, number> = {
        P,
        T: state.nodeT.get(id)!,
        rho: state.nodeRho.get(id)!,
      };
      const h = state.nodeH?.get(id);
      if (h !== undefined) rec.h = h;
      const q = state.nodeQuality?.get(id);
      if (q !== undefined) rec.quality = q;
      return rec;
    },
    branch(id: string): Record<string, number> {
      const j = branchIndex.get(id);
      if (j === undefined)
        throw new ExpressionError("evaluate", `Unknown branch "${id}"`);
      return { mdot: state.mdots[j] };
    },
    solid(id: string): Record<string, number> {
      const T = state.solidT.get(id);
      if (T === undefined)
        throw new ExpressionError("evaluate", `Unknown solid node "${id}"`);
      return { T };
    },
  };
}
