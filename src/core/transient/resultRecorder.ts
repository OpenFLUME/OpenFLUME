/**
 * Accumulates the per-step trajectory arrays (`TransientResult.nodes` /
 * `branches` / `solidNodes` / `conductors`) that both the fixed and adaptive
 * time-steppers build identically: `initTransientResults` seeds the arrays
 * from the t = 0 state, `recordTransientStep` appends one accepted step, and
 * `buildPartialTransientResult` slices everything down to a prefix for
 * `onProgress`/abort/logic-termination snapshots.
 *
 * Beyond the state variables, each step also records the reporting-only
 * quantities from solver/derivedProperties.ts — the same set the steady
 * packer publishes, so a transient run can plot enthalpy, entropy, velocity,
 * Mach number, heat flux and the rest exactly as a steady run reports them.
 *
 * Which of those a run carries is decided ONCE, from the t = 0 state: a
 * property the fluid model cannot supply has no array at all.  Arrays that do
 * exist stay aligned 1:1 with `times` for the whole run — a later step that
 * cannot evaluate a property pushes NaN rather than skipping, and the display
 * layer drops non-finite samples.
 */
import type {
  NetworkConfig,
  TransientResult,
  TtWfConductorHistory,
  FluidFrontNodeHistory,
} from "../schema";
import type { SolverContext, StepState } from "../solver";
import {
  branchDerivedProperties,
  computeConductorHMap,
  computeConductorHeatRate,
  conductorHeatFlux,
  nodeDerivedMap,
} from "../solver";
import { FALLBACK_H_FLOOR } from "../correlations";

export function gasVolume(
  node: NetworkConfig["nodes"][number],
  P: number,
): number | undefined {
  const gc = node.gasCushion;
  if (!gc) return undefined;
  const P0 = node.pressure ?? P;
  const n = gc.polytropicIndex;
  const Vg0 = gc.initialGasVolume;
  const C = P0 * Math.pow(Vg0, n);
  return Math.pow(C / P, 1 / n);
}

/** Reporting-only node property keys, in canonical publishing order. */
const NODE_PROPERTY_KEYS = [
  "enthalpy",
  "internalEnergy",
  "entropy",
  "viscosity",
  "specificHeat",
  "thermalConductivity",
  "speedOfSound",
] as const;

/** Reporting-only branch flow keys, in canonical publishing order. */
const BRANCH_FLOW_KEYS = [
  "velocity",
  "dP",
  "reynolds",
  "mach",
  "volumetricFlow",
  "massFlux",
  "dynamicPressure",
] as const;

/** Start a history array for each property the t = 0 state could supply. */
function seedHistories<K extends string>(
  keys: readonly K[],
  values: Partial<Record<K, number>>,
): Partial<Record<K, number[]>> {
  const out: Partial<Record<K, number[]>> = {};
  for (const key of keys) {
    const v = values[key];
    if (v !== undefined) out[key] = [v];
  }
  return out;
}

/** Append to the histories that exist, holding the 1:1 alignment with times. */
function appendHistories<K extends string>(
  keys: readonly K[],
  target: Partial<Record<K, number[]>>,
  values: Partial<Record<K, number>>,
): void {
  for (const key of keys) {
    const arr = target[key];
    if (arr) arr.push(values[key] ?? NaN);
  }
}

/** Copy the history arrays that exist, sliced to `[0, stepIndex]`. */
function sliceHistories<K extends string>(
  keys: readonly K[],
  source: Partial<Record<K, number[]>>,
  stepIndex: number,
): Partial<Record<K, number[]>> {
  const out: Partial<Record<K, number[]>> = {};
  for (const key of keys) {
    const arr = source[key];
    if (arr) out[key] = arr.slice(0, stepIndex + 1);
  }
  return out;
}

export interface TransientResultAccumulators {
  times: number[];
  nodeResults: TransientResult["nodes"];
  branchResults: TransientResult["branches"];
  solidResults: NonNullable<TransientResult["solidNodes"]>;
  conductorResults: NonNullable<TransientResult["conductors"]>;
}

/** Seed every accumulator array with the t = 0 state (times = [0]). */
export function initTransientResults(
  ctx: SolverContext,
  config: NetworkConfig,
  state: StepState,
): TransientResultAccumulators {
  const nodeProps = nodeDerivedMap(
    ctx,
    state,
    config.nodes.map((n) => n.id),
  );

  const nodeResults: TransientResult["nodes"] = {};
  for (const node of config.nodes) {
    nodeResults[node.id] = {
      pressure: [state.nodeP.get(node.id)!],
      temperature: [state.nodeT.get(node.id)!],
      density: [state.nodeRho.get(node.id)!],
      quality: ctx.isRealFluid ? [state.nodeQuality!.get(node.id)!] : [],
      ...seedHistories(NODE_PROPERTY_KEYS, nodeProps.get(node.id) ?? {}),
    };
    const vg = gasVolume(node, state.nodeP.get(node.id)!);
    if (vg !== undefined) {
      nodeResults[node.id].gasVolume = [vg];
    }
    if (ctx.isRealFluid) {
      nodeResults[node.id].phase = [state.nodePhase!.get(node.id)!];
    }
    if (ctx.hasSpecies && state.nodeY) {
      const Y = state.nodeY.get(node.id)!;
      const mf: Record<string, number[]> = {};
      for (const sp of Object.keys(Y)) mf[sp] = [Y[sp]];
      nodeResults[node.id].massFractions = mf;
    }
  }
  const branchResults: TransientResult["branches"] = {};
  for (let j = 0; j < ctx.nBranch; j++) {
    branchResults[ctx.branches[j].id] = {
      mdot: [state.mdots[j]],
      ...seedHistories(
        BRANCH_FLOW_KEYS,
        branchDerivedProperties(ctx, state, j, nodeProps, 0),
      ),
    };
  }
  const solidResults: TransientResult["solidNodes"] = {};
  for (const sNode of config.solidNodes ?? []) {
    solidResults[sNode.id] = { temperature: [state.solidT.get(sNode.id)!] };
  }
  const conductorResults: NonNullable<TransientResult["conductors"]> = {};
  const initialHMap = computeConductorHMap(ctx, state, undefined, 0);
  for (const cond of ctx.conductors) {
    const Tfrom =
      state.solidT.get(cond.from) ?? state.nodeT.get(cond.from) ?? 300;
    const Tto = state.solidT.get(cond.to) ?? state.nodeT.get(cond.to) ?? 300;
    const heatRate = computeConductorHeatRate(cond, Tfrom, Tto, initialHMap, 0);
    const entry: NonNullable<TransientResult["conductors"]>[string] = {
      heatRate: [heatRate],
    };
    if (cond.type.kind === "convection") {
      entry.heatTransferCoeff = [
        initialHMap.get(cond.id) ?? cond.type.h ?? FALLBACK_H_FLOOR,
      ];
    }
    const flux = conductorHeatFlux(cond, heatRate);
    if (flux !== undefined) entry.heatFlux = [flux];
    conductorResults[cond.id] = entry;
  }
  return {
    times: [0],
    nodeResults,
    branchResults,
    solidResults,
    conductorResults,
  };
}

/** Append one accepted step (at time `t`) to every accumulator array.
 *  `prevState`/`dt` are the pair the accepted step's momentum rows were
 *  solved against — they let the reported branch dP subtract the fluid-
 *  inertia term (branchDerivedProperties has the rationale). */
export function recordTransientStep(
  ctx: SolverContext,
  config: NetworkConfig,
  acc: TransientResultAccumulators,
  t: number,
  state: StepState,
  prevState?: StepState,
  dt?: number,
): void {
  const { nodeResults, branchResults, solidResults, conductorResults } = acc;
  acc.times.push(t);
  const nodeProps = nodeDerivedMap(
    ctx,
    state,
    config.nodes.map((n) => n.id),
  );
  for (const node of config.nodes) {
    nodeResults[node.id].pressure.push(state.nodeP.get(node.id)!);
    nodeResults[node.id].temperature.push(state.nodeT.get(node.id)!);
    nodeResults[node.id].density.push(state.nodeRho.get(node.id)!);
    appendHistories(
      NODE_PROPERTY_KEYS,
      nodeResults[node.id],
      nodeProps.get(node.id) ?? {},
    );
    const vg = gasVolume(node, state.nodeP.get(node.id)!);
    if (vg !== undefined) {
      nodeResults[node.id].gasVolume!.push(vg);
    }
    if (ctx.isRealFluid) {
      nodeResults[node.id].quality!.push(state.nodeQuality!.get(node.id)!);
      nodeResults[node.id].phase!.push(state.nodePhase!.get(node.id)!);
    }
    if (ctx.hasSpecies && state.nodeY) {
      const Y = state.nodeY.get(node.id)!;
      const mf = nodeResults[node.id].massFractions!;
      for (const sp of Object.keys(Y)) mf[sp].push(Y[sp]);
    }
  }
  for (let j = 0; j < ctx.nBranch; j++) {
    const entry = branchResults[ctx.branches[j].id];
    entry.mdot.push(state.mdots[j]);
    appendHistories(
      BRANCH_FLOW_KEYS,
      entry,
      branchDerivedProperties(ctx, state, j, nodeProps, t, { prevState, dt }),
    );
  }
  for (const sNode of config.solidNodes ?? []) {
    solidResults[sNode.id].temperature.push(state.solidT.get(sNode.id)!);
  }
  const stepHMap = computeConductorHMap(ctx, state, undefined, t);
  for (const cond of ctx.conductors) {
    const Tfrom =
      state.solidT.get(cond.from) ?? state.nodeT.get(cond.from) ?? 300;
    const Tto = state.solidT.get(cond.to) ?? state.nodeT.get(cond.to) ?? 300;
    const heatRate = computeConductorHeatRate(cond, Tfrom, Tto, stepHMap, t);
    conductorResults[cond.id].heatRate.push(heatRate);
    if (cond.type.kind === "convection") {
      conductorResults[cond.id].heatTransferCoeff!.push(
        stepHMap.get(cond.id) ?? cond.type.h ?? FALLBACK_H_FLOOR,
      );
    }
    if (conductorResults[cond.id].heatFlux) {
      conductorResults[cond.id].heatFlux!.push(
        conductorHeatFlux(cond, heatRate) ?? NaN,
      );
    }
  }
}

/**
 * Slice the trajectory down to `[0, stepIndex]` for `onProgress` snapshots,
 * abort/logic-termination early returns, and the final result.
 */
export function buildPartialTransientResult(
  stepIndex: number,
  times: number[],
  nodeResults: TransientResult["nodes"],
  branchResults: TransientResult["branches"],
  solidResults: TransientResult["solidNodes"],
  conductorResults: TransientResult["conductors"],
  ttWfResults: Record<string, TtWfConductorHistory> | undefined,
  fluidFrontResults: Record<string, FluidFrontNodeHistory> | undefined,
  converged: boolean,
  aborted?: boolean,
): TransientResult {
  const partialNodes: TransientResult["nodes"] = {};
  for (const id of Object.keys(nodeResults)) {
    partialNodes[id] = {
      pressure: nodeResults[id].pressure.slice(0, stepIndex + 1),
      temperature: nodeResults[id].temperature.slice(0, stepIndex + 1),
      density: nodeResults[id].density.slice(0, stepIndex + 1),
      quality: nodeResults[id].quality
        ? nodeResults[id].quality!.slice(0, stepIndex + 1)
        : [],
      ...sliceHistories(NODE_PROPERTY_KEYS, nodeResults[id], stepIndex),
    };
    if (nodeResults[id].gasVolume) {
      partialNodes[id].gasVolume = nodeResults[id].gasVolume!.slice(
        0,
        stepIndex + 1,
      );
    }
    if (nodeResults[id].phase) {
      partialNodes[id].phase = nodeResults[id].phase!.slice(0, stepIndex + 1);
    }
    if (nodeResults[id].massFractions) {
      const mf = nodeResults[id].massFractions!;
      const sliced: Record<string, number[]> = {};
      for (const sp of Object.keys(mf)) {
        sliced[sp] = mf[sp].slice(0, stepIndex + 1);
      }
      partialNodes[id].massFractions = sliced;
    }
  }
  const partialBranches: TransientResult["branches"] = {};
  for (const id of Object.keys(branchResults)) {
    partialBranches[id] = {
      mdot: branchResults[id].mdot.slice(0, stepIndex + 1),
      ...sliceHistories(BRANCH_FLOW_KEYS, branchResults[id], stepIndex),
    };
  }
  const partialSolid: TransientResult["solidNodes"] = solidResults
    ? {}
    : undefined;
  if (solidResults && partialSolid) {
    for (const id of Object.keys(solidResults)) {
      partialSolid[id] = {
        temperature: solidResults[id].temperature.slice(0, stepIndex + 1),
      };
    }
  }
  const partialConductors: TransientResult["conductors"] = conductorResults
    ? {}
    : undefined;
  if (conductorResults && partialConductors) {
    for (const id of Object.keys(conductorResults)) {
      const entry: NonNullable<TransientResult["conductors"]>[string] = {
        heatRate: conductorResults[id].heatRate.slice(0, stepIndex + 1),
      };
      if (conductorResults[id].heatTransferCoeff) {
        entry.heatTransferCoeff = conductorResults[id].heatTransferCoeff!.slice(
          0,
          stepIndex + 1,
        );
      }
      if (conductorResults[id].heatFlux) {
        entry.heatFlux = conductorResults[id].heatFlux!.slice(0, stepIndex + 1);
      }
      partialConductors[id] = entry;
    }
  }
  const partialTtWf: TransientResult["ttWf"] = ttWfResults ? {} : undefined;
  if (ttWfResults && partialTtWf) {
    for (const id of Object.keys(ttWfResults)) {
      partialTtWf[id] = {
        fWet: ttWfResults[id].fWet.slice(0, stepIndex + 1),
        rewetLatched: ttWfResults[id].rewetLatched.slice(0, stepIndex + 1),
        regime: ttWfResults[id].regime.slice(0, stepIndex + 1),
      };
    }
  }
  const partialFluidFront: TransientResult["fluidFront"] = fluidFrontResults
    ? {}
    : undefined;
  if (fluidFrontResults && partialFluidFront) {
    for (const id of Object.keys(fluidFrontResults)) {
      partialFluidFront[id] = {
        fraction: fluidFrontResults[id].fraction.slice(0, stepIndex + 1),
      };
    }
  }
  return {
    converged,
    times: times.slice(0, stepIndex + 1),
    nodes: partialNodes,
    branches: partialBranches,
    solidNodes: partialSolid,
    conductors: partialConductors,
    ttWf: partialTtWf,
    fluidFront: partialFluidFront,
    aborted,
  };
}
