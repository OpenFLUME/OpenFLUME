/**
 * Continuation (homotopy) solver.
 *
 * Wraps solveSteady/solveTransient to march a scalar build parameter from an
 * easy starting case toward a harder target, re-seeding each config's
 * initial conditions from the previous converged result (seedConfigFromResult)
 * and adaptively growing/shrinking the step on success/failure. Useful for
 * networks that only converge from a good initial guess (e.g. ramping a
 * boundary pressure or a valve position from a benign value to the real one).
 */
import type { NetworkConfig, SteadyResult, TransientResult } from "./schema";
import { solveSteady } from "./solver";
import { solveTransient } from "./transient";

export type ContinuationSolve = "steady" | "transient";

export interface ContinuationOptions {
  paramStart: number;
  paramTarget: number;
  initialStep?: number;
  minStep?: number;
  maxStep?: number;
  growFactor?: number;
  shrinkFactor?: number;
  maxSteps?: number;
  solve?: ContinuationSolve;
  onProgress?: (p: {
    step: number;
    paramValue: number;
    converged: boolean;
    residual?: number;
  }) => void;
  shouldAbort?: () => boolean;
  /** Optional custom solver for testing or advanced use. */
  solver?: (config: NetworkConfig) => SteadyResult | TransientResult;
}

export interface ContinuationHistoryEntry {
  paramValue: number;
  converged: boolean;
  iterations?: number;
  residual?: number;
  result?: SteadyResult | TransientResult;
}

export interface ContinuationResult {
  converged: boolean;
  finalResult: SteadyResult | TransientResult | null;
  history: ContinuationHistoryEntry[];
}

/**
 * Return a new NetworkConfig whose internal-node initial conditions (pressure,
 * temperature, quality if two-phase) and solid-node temperatures are seeded
 * from the final state of a solved result.  The input config is not mutated.
 */
export function seedConfigFromResult(
  config: NetworkConfig,
  result: SteadyResult | TransientResult,
): NetworkConfig {
  const seeded = JSON.parse(JSON.stringify(config)) as NetworkConfig;
  const isTransient =
    "times" in result &&
    Array.isArray((result as TransientResult).times) &&
    (result as TransientResult).times.length > 0;
  const finalIdx = isTransient
    ? (result as TransientResult).times.length - 1
    : -1;

  for (const node of seeded.nodes) {
    if (node.type !== "internal") continue;
    const rNode = result.nodes[node.id];
    if (!rNode) continue;
    if (isTransient) {
      node.pressure = (rNode.pressure as number[])[finalIdx];
      node.temperature = (rNode.temperature as number[])[finalIdx];
      const qArr = rNode.quality as number[] | undefined;
      if (Array.isArray(qArr) && qArr.length > 0) {
        const q = qArr[finalIdx];
        if (q !== undefined && q !== null) {
          node.quality = q;
        } else {
          delete node.quality;
        }
      } else {
        delete node.quality;
      }
    } else {
      node.pressure = rNode.pressure as number;
      node.temperature = rNode.temperature as number;
      if (rNode.quality !== undefined && rNode.quality !== null) {
        node.quality = rNode.quality as number;
      } else {
        delete node.quality;
      }
    }
  }

  if (seeded.solidNodes) {
    for (const sNode of seeded.solidNodes) {
      const rSolid = result.solidNodes?.[sNode.id];
      if (!rSolid) continue;
      if (isTransient) {
        sNode.temperature = (rSolid.temperature as number[])[finalIdx];
      } else {
        sNode.temperature = rSolid.temperature as number;
      }
    }
  }

  return seeded;
}

/**
 * Continuation / homotopy solver.
 *
 * Solves an easy nearby case, seeds the next case from its converged state,
 * and adaptively steps a scalar parameter toward the target.
 */
export function solveWithContinuation(
  buildConfig: (paramValue: number) => NetworkConfig,
  options: ContinuationOptions,
): ContinuationResult {
  const {
    paramStart,
    paramTarget,
    initialStep,
    minStep,
    maxStep,
    growFactor = 2.0,
    shrinkFactor = 0.5,
    maxSteps = 100,
    solve = "steady",
    onProgress,
    shouldAbort,
    solver,
  } = options;

  const span = Math.abs(paramTarget - paramStart);
  const step0 = initialStep ?? (span > 0 ? span / 10 : 1);
  const minS = minStep ?? (span > 0 ? span * 1e-6 : 1e-12);
  const maxS = maxStep ?? span;

  const dir = Math.sign(paramTarget - paramStart);
  let currentParam = paramStart;
  let step = step0;
  const history: ContinuationHistoryEntry[] = [];
  const tolerance = 1e-12 * Math.max(1, Math.abs(paramTarget));

  const defaultSolver = solve === "transient" ? solveTransient : solveSteady;
  const doSolve = solver ?? defaultSolver;

  /** Steady solves carry scalar iteration/residual stats; transient results
   *  record per-step residual series instead (see TransientResult).  The
   *  null case is the attemptSolve catch path (a thrown solve). */
  function solveStats(result: SteadyResult | TransientResult | null): {
    iterations: number | undefined;
    residual: number | undefined;
  } {
    if (result && "iterations" in result) {
      return { iterations: result.iterations, residual: result.residual };
    }
    return { iterations: undefined, residual: undefined };
  }

  function attemptSolve(config: NetworkConfig): {
    result: SteadyResult | TransientResult | null;
    converged: boolean;
  } {
    try {
      const result = doSolve(config);
      return { result, converged: result.converged === true };
    } catch {
      return { result: null, converged: false };
    }
  }

  // Solve the easy start point
  const startConfig = buildConfig(currentParam);
  let { result: currentResult, converged: startConverged } =
    attemptSolve(startConfig);
  history.push({
    paramValue: currentParam,
    converged: startConverged,
    ...solveStats(currentResult),
    result: currentResult ?? undefined,
  });
  if (onProgress) {
    onProgress({
      step: 0,
      paramValue: currentParam,
      converged: startConverged,
      residual: solveStats(currentResult).residual,
    });
  }
  if (!startConverged || !currentResult) {
    return { converged: false, finalResult: currentResult, history };
  }

  for (let stepCount = 0; stepCount < maxSteps; stepCount++) {
    if (shouldAbort && shouldAbort()) {
      break;
    }

    let nextParam = currentParam + dir * step;
    if (dir > 0) {
      nextParam = Math.min(nextParam, paramTarget);
    } else {
      nextParam = Math.max(nextParam, paramTarget);
    }

    if (Math.abs(nextParam - currentParam) < tolerance) {
      break;
    }

    let nextConfig = buildConfig(nextParam);
    nextConfig = seedConfigFromResult(nextConfig, currentResult);
    const { result: nextResult, converged: nextConverged } =
      attemptSolve(nextConfig);
    history.push({
      paramValue: nextParam,
      converged: nextConverged,
      ...solveStats(nextResult),
      result: nextResult ?? undefined,
    });
    if (onProgress) {
      onProgress({
        step: stepCount + 1,
        paramValue: nextParam,
        converged: nextConverged,
        residual: solveStats(nextResult).residual,
      });
    }

    if (nextConverged && nextResult) {
      currentParam = nextParam;
      currentResult = nextResult;
      if (Math.abs(currentParam - paramTarget) <= tolerance) {
        break;
      }
      step = Math.min(step * growFactor, maxS);
      continue;
    } else {
      step *= shrinkFactor;
      if (step < minS) {
        break;
      }
    }
  }

  const targetConverged =
    Math.abs(currentParam - paramTarget) <= tolerance && startConverged;
  return { converged: targetConverged, finalResult: currentResult, history };
}
