/**
 * sweep/summary.ts — pure per-variant result summarization.
 *
 * summarizeVariant reduces a real SteadyResult / TransientResult to the
 * compact VariantSummary the sweep UI and job records display: convergence
 * and abort flags, steady iteration/residual, transient step stats and
 * end-reached, pressure/temperature envelopes across nodes (and times),
 * and the peak absolute branch mass flow.
 *
 * Empty results omit envelope/peak fields (never
 * NaN/Infinity) when the result carries no data for them.
 */
import type { SteadyResult, TransientResult } from "../../core";
import { isTransientResult } from "../runHistory";
import type { ValueEnvelope, VariantSummary } from "./types";

/** Extend a running envelope with one finite value. */
function extend(env: { min: number; max: number }, v: number): void {
  if (v < env.min) env.min = v;
  if (v > env.max) env.max = v;
}

function envelopeOf(values: Iterable<number>): ValueEnvelope | undefined {
  let env: { min: number; max: number } | undefined;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (!env) env = { min: v, max: v };
    else extend(env, v);
  }
  return env;
}

function peakAbs(values: Iterable<number>): number | undefined {
  let peak: number | undefined;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    const a = Math.abs(v);
    if (peak === undefined || a > peak) peak = a;
  }
  return peak;
}

function* steadyPressures(result: SteadyResult): Iterable<number> {
  for (const n of Object.values(result.nodes)) yield n.pressure;
}

function* steadyTemperatures(result: SteadyResult): Iterable<number> {
  for (const n of Object.values(result.nodes)) yield n.temperature;
}

function* steadyMdots(result: SteadyResult): Iterable<number> {
  for (const b of Object.values(result.branches)) yield b.mdot;
}

function* transientPressures(result: TransientResult): Iterable<number> {
  for (const n of Object.values(result.nodes)) yield* n.pressure;
}

function* transientTemperatures(result: TransientResult): Iterable<number> {
  for (const n of Object.values(result.nodes)) yield* n.temperature;
}

function* transientMdots(result: TransientResult): Iterable<number> {
  for (const b of Object.values(result.branches)) yield* b.mdot;
}

/** Relative tolerance for the end-reached time comparison (the final
 *  adaptive step lands exactly on endTime by construction, but be lenient
 *  against hand-built results and float accumulation). */
const END_TIME_REL_TOL = 1e-9;

/**
 * Summarize one variant's solve result.  Pure; never mutates the result.
 *
 * `options.endTime` (the config's settings.endTime) makes `reachedEnd`
 * exact: the last recorded time is compared against it.  Without it,
 * `reachedEnd` is inferred as "not aborted, not user-terminated, non-empty
 * trajectory".
 */
export function summarizeVariant(
  result: SteadyResult | TransientResult,
  options?: { endTime?: number },
): VariantSummary {
  const aborted = result.aborted === true;
  const userTerminated = result.userTerminated === true;

  if (!isTransientResult(result)) {
    return {
      mode: "steady",
      converged: result.converged,
      aborted,
      userTerminated,
      iterations: result.iterations,
      residual: result.residual,
      pressure: envelopeOf(steadyPressures(result)),
      temperature: envelopeOf(steadyTemperatures(result)),
      peakAbsMassFlow: peakAbs(steadyMdots(result)),
    };
  }

  const times = result.times;
  const lastTime = times.length > 0 ? times[times.length - 1] : undefined;
  const stats = result.stats;
  const steps = stats?.steps ?? (times.length > 0 ? times.length - 1 : 0);
  let reachedEnd: boolean;
  if (options?.endTime !== undefined) {
    const tol = END_TIME_REL_TOL * Math.max(1, Math.abs(options.endTime));
    reachedEnd = lastTime !== undefined && lastTime >= options.endTime - tol;
  } else {
    reachedEnd = !aborted && !userTerminated && times.length > 0;
  }

  return {
    mode: "transient",
    converged: result.converged,
    aborted,
    userTerminated,
    steps,
    ...(stats
      ? {
          rejectedSteps: stats.rejectedSteps,
          minDt: stats.minDt,
          maxDt: stats.maxDt,
        }
      : {}),
    ...(lastTime !== undefined ? { endTime: lastTime } : {}),
    reachedEnd,
    pressure: envelopeOf(transientPressures(result)),
    temperature: envelopeOf(transientTemperatures(result)),
    peakAbsMassFlow: peakAbs(transientMdots(result)),
  };
}
