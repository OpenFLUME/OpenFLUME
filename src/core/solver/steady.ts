/**
 * Steady-state driver: resolve the config, build the context and initial
 * state, run ONE solveStateStep to convergence (no dt ⇒ steady residuals),
 * and package the converged StepState into the public SteadyResult shape
 * (node thermodynamic state, per-branch flow quantities, conductor heat
 * rates and fluxes, logic-runtime fields).  The reporting-only quantities
 * themselves live in derivedProperties.ts, shared with the transient
 * recorder so both modes publish the same set.
 */
import type { JunctionSummary, NetworkConfig, SteadyResult } from "../schema";
import { resolveNetworkParameters } from "../paramBindings";
import { createLogicRuntime, logicResultFields } from "../logicRuntime";
import { FALLBACK_H_FLOOR } from "../correlations";
import {
  buildSolverContext,
  createInitialState,
  buildLogicScope,
} from "./context";
import { solveStateStep } from "./step";
import {
  branchDerivedProperties,
  conductorHeatFlux,
  definedOnly,
  nodeDerivedMap,
} from "./derivedProperties";
import { computeConductorHMap } from "./conductorH";
import { computeConductorHeatRate } from "./thermal";

/**
 * Solve a steady-state thermal-fluid network to convergence.
 *
 * Uses Picard iteration with an inner Newton–Raphson solver. Supports
 * hybrid analytic/finite-difference Jacobians, pseudo-transient-continuation
 * (PTC) for real fluids, trust-region or line-search globalization, and
 * optional coupled-honesty gating.
 *
 * @param config - Validated network configuration (call {@link validateNetwork} first)
 * @param options - Progress callback and abort signal
 * @returns Steady-state result with node pressures/temperatures, branch mass flows, and convergence diagnostics
 * @throws {Error} if config is structurally invalid (use {@link decodeNetworkConfig} + {@link validateNetwork} first),
 *   or if static parameter bindings (core/paramBindings.ts) fail to resolve
 */
export function solveSteady(
  inputConfig: NetworkConfig,
  options?: {
    onProgress?: (p: { iteration: number; residual: number }) => void;
    shouldAbort?: () => boolean;
  },
): SteadyResult {
  // Defense in depth (validateNetwork already resolves bindings): replace
  // any formula-bound fields with their static numbers and solve the
  // immutable resolved clone, so bindings can never feed back into the
  // Newton/Jacobian state.
  const resolution = resolveNetworkParameters(inputConfig);
  if (!resolution.ok) {
    throw new Error(
      `solveSteady: invalid parameter bindings:\n${resolution.errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
  const config = resolution.config;
  const ctx = buildSolverContext(config);
  const state = createInitialState(ctx, config);
  const relax = config.settings.relaxation ?? 1.0;

  // User-logic runtime (registers + LogicRule lifecycle, core/logicRuntime.ts).
  // Undefined unless the network configures registers/logic — the solve is
  // then bit-identical to one without this feature.  Steady lifecycle:
  //   init          — once at the initial state (t = 0) before iterating;
  //   stepAccepted  — once per OUTER iteration via the wrapped onProgress
  //                   (solveStateStep calls it after each outer state update,
  //                   so `state` below IS the current iterate; scope: iter +
  //                   residual, no dt — steady has no time);
  //   converged     — once after the loop when the solve converged;
  //   solveEnd      — once at the end on every exit path.
  // A rule with stop: true sets userTerminated, which the wrapped
  // shouldAbort turns into an early (aborted) exit — steady results then
  // carry userTerminated/terminationReason alongside aborted: true.
  const logic = createLogicRuntime(config);
  if (logic) {
    logic.fire("init", buildLogicScope(ctx, state), { t: 0 });
  }
  const wrappedProgress =
    logic !== undefined
      ? (p: { iteration: number; residual: number }) => {
          logic.fire("stepAccepted", buildLogicScope(ctx, state), {
            t: 0,
            iter: p.iteration,
            residual: p.residual,
          });
          options?.onProgress?.(p);
        }
      : options?.onProgress;
  const wrappedAbort =
    logic !== undefined
      ? () => (options?.shouldAbort?.() ?? false) || logic.userTerminated
      : options?.shouldAbort;

  const res = solveStateStep(ctx, state, {
    tol: config.settings.tolerance,
    maxIterations: config.settings.maxIterations,
    relaxation: relax,
    onProgress: wrappedProgress,
    shouldAbort: wrappedAbort,
    steadySolver: config.settings.steadySolver ?? "ptc",
    globalization: config.settings.globalization ?? "trustRegion",
    jacobian: config.settings.jacobian ?? "hybrid",
  });

  if (logic) {
    if (res.converged) {
      logic.fire("converged", buildLogicScope(ctx, res.state), {
        t: 0,
        iter: res.iterations,
        residual: res.residual,
      });
    }
    logic.fire("solveEnd", buildLogicScope(ctx, res.state), {
      t: 0,
      iter: res.iterations,
      residual: res.residual,
    });
  }

  const resultNodes: SteadyResult["nodes"] = {};
  const resultBranches: SteadyResult["branches"] = {};

  const nodeProps = nodeDerivedMap(
    ctx,
    res.state,
    config.nodes.map((n) => n.id),
  );

  for (const node of config.nodes) {
    const resultNode: SteadyResult["nodes"][string] = {
      pressure: res.state.nodeP.get(node.id)!,
      temperature: res.state.nodeT.get(node.id)!,
      density: res.state.nodeRho.get(node.id)!,
      ...definedOnly(nodeProps.get(node.id)),
    };
    if (ctx.isRealFluid) {
      resultNode.quality = res.state.nodeQuality!.get(node.id);
      resultNode.phase = res.state.nodePhase!.get(node.id);
    }
    if (ctx.hasSpecies && res.state.nodeY) {
      const Y = res.state.nodeY.get(node.id);
      if (Y) resultNode.massFractions = { ...Y };
    }
    resultNodes[node.id] = resultNode;
  }

  for (let j = 0; j < ctx.nBranch; j++) {
    const b = ctx.branches[j];
    resultBranches[b.id] = {
      mdot: res.state.mdots[j],
      ...branchDerivedProperties(ctx, res.state, j, nodeProps),
    };
  }

  const resultSolidNodes: SteadyResult["solidNodes"] = {};
  for (const sNode of config.solidNodes ?? []) {
    resultSolidNodes[sNode.id] = {
      temperature: res.state.solidT.get(sNode.id)!,
    };
  }

  // Per-junction reporting summary (reacting junctions, core/schema.ts
  // JunctionConfig): the model re-evaluated once at the converged state.
  // Reporting only — the coupling itself lives in the kernel's closure rows.
  let resultJunctions: Record<string, JunctionSummary> | undefined;
  if (ctx.junctions.length > 0) {
    resultJunctions = {};
    for (const jn of ctx.junctions) {
      const mdotByRole: Record<string, number> = {};
      let mdotTotal = 0;
      const mdotMap = new Map<string, number>();
      for (const [role, idxs] of jn.roleBranches) {
        let sum = 0;
        for (const j of idxs) sum += Math.abs(res.state.mdots[j]);
        mdotByRole[role] = sum;
        mdotMap.set(role, sum);
        mdotTotal += sum;
      }
      const pc = res.state.nodeP.get(jn.nodeId)!;
      const evaluation = jn.model.evaluate(pc, mdotMap);
      const summary: JunctionSummary = {
        pc,
        productTemperature: res.state.nodeT.get(jn.nodeId)!,
        mdotByRole,
        mdotTotal,
        gas: evaluation.gas,
        clampedPc: evaluation.clampedPc,
        clampedOf: evaluation.clampedOf,
      };
      if (evaluation.of !== undefined) summary.of = evaluation.of;
      resultJunctions[jn.id] = summary;
    }
  }

  const finalHMap = computeConductorHMap(ctx, res.state);
  const resultConductors: NonNullable<SteadyResult["conductors"]> = {};
  for (const cond of ctx.conductors) {
    const Tfrom =
      res.state.solidT.get(cond.from) ?? res.state.nodeT.get(cond.from) ?? 300;
    const Tto =
      res.state.solidT.get(cond.to) ?? res.state.nodeT.get(cond.to) ?? 300;
    const heatRate = computeConductorHeatRate(cond, Tfrom, Tto, finalHMap);
    const entry: NonNullable<SteadyResult["conductors"]>[string] = { heatRate };
    if (cond.type.kind === "convection") {
      entry.heatTransferCoeff =
        finalHMap.get(cond.id) ?? cond.type.h ?? FALLBACK_H_FLOOR;
    }
    const flux = conductorHeatFlux(cond, heatRate);
    if (flux !== undefined) entry.heatFlux = flux;
    resultConductors[cond.id] = entry;
  }

  return {
    converged: res.converged,
    iterations: res.iterations,
    residual: res.residual,
    ...(resultJunctions !== undefined ? { junctions: resultJunctions } : {}),
    nodes: resultNodes,
    branches: resultBranches,
    solidNodes: resultSolidNodes,
    conductors: resultConductors,
    aborted: res.aborted,
    ptcDeltaTau: res.ptcDeltaTau,
    ptcShrinks: res.ptcShrinks,
    ...logicResultFields(logic),
  };
}
