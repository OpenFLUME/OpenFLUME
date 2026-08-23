/**
 * runHistory.ts — run records and baseline comparison.
 *
 * Every completed run appends an immutable RunRecord to a ring buffer (last
 * 10). A record snapshots the EXACT config that was solved plus its result,
 * labeled with a stable (non-crypto FNV) config hash and timestamp. Running
 * again never destroys prior records; editing the config marks the displayed
 * result stale but leaves history untouched.
 *
 * Any record can be pinned as the comparison baseline when it is compatible
 * with the currently displayed run: same solve mode and enough shared element
 * ids to make deltas/overlays meaningful.  Baselines may come from a
 * DIFFERENT variant — comparing variants is the point of having them.
 *
 * Records are scoped to the loaded model: every wholesale model replacement
 * clears the buffer, and each record remembers the variant that produced it.
 */
import type { NetworkConfig, SteadyResult, TransientResult } from "./types";
import { configHash } from "./provenance";
// Type-only import (erased at runtime — convergenceDiary imports
// isTransientResult from this module, so a runtime import would cycle).
import type { RunDiary } from "./convergenceDiary";

/** Ring-buffer capacity, applied PER VARIANT so a busy variant cannot
 *  evict another's history. */
export const RUN_HISTORY_CAP = 10;

export interface RunRecord {
  id: string;
  /** User-editable display name (default "Run N"). */
  name: string;
  /** Variant that produced the run; null for the Base network. */
  variantId: string | null;
  /** Epoch ms. */
  timestamp: number;
  mode: "steady" | "transient";
  /** FNV-1a/64 of the canonical config JSON (stable; NOT sha). */
  configHash: string;
  /** Immutable snapshot of the solved config. */
  config: NetworkConfig;
  result: SteadyResult | TransientResult;
  /**
   * Convergence diary captured alongside the run (live progress for manual
   * runs and sweep variants).  Optional: records created before diaries
   * existed (or from paths without a collector) simply omit it.  Treated as
   * immutable — pushRunRecord deep-clones it on intake so later caller-side
   * mutation can never alias into the record.
   */
  diary?: RunDiary;
  converged: boolean;
  /** One-line outcome, e.g. "converged · 12 iter · res 3.2e-9". */
  summary: string;
}

export function isTransientResult(
  r: SteadyResult | TransientResult,
): r is TransientResult {
  return "times" in r;
}

export function summarizeResult(
  result: SteadyResult | TransientResult,
): string {
  const head = result.converged ? "converged" : "NOT converged";
  if (isTransientResult(result)) {
    return `${head} · ${result.times.length} steps`;
  }
  return `${head} · ${result.iterations} iter · res ${result.residual.toExponential(2)}`;
}

export function makeRunRecord(
  seq: number,
  config: NetworkConfig,
  result: SteadyResult | TransientResult,
  now = Date.now(),
  diary?: RunDiary,
  variantId: string | null = null,
): RunRecord {
  return {
    id: `run-${now.toString(36)}-${seq}`,
    name: `Run ${seq}`,
    variantId,
    timestamp: now,
    mode: isTransientResult(result) ? "transient" : "steady",
    configHash: configHash(config),
    config,
    result,
    // Stored as given (like config/result): intake cloning is the caller's
    // job — pushRunRecord deep-clones before reaching here.
    ...(diary ? { diary } : {}),
    converged: result.converged,
    summary: summarizeResult(result),
  };
}

/** Element id sets of a result (steady or transient share the same shape). */
function resultIdSets(result: SteadyResult | TransientResult) {
  return {
    nodes: new Set(Object.keys(result.nodes)),
    branches: new Set(Object.keys(result.branches)),
    solidNodes: new Set(Object.keys(result.solidNodes ?? {})),
    conductors: new Set(Object.keys(result.conductors ?? {})),
  };
}

function sharedCount<T>(a: Set<T>, b: Set<T>): number {
  let n = 0;
  for (const v of a) if (b.has(v)) n++;
  return n;
}

export interface RunCompatibility {
  ok: boolean;
  reason?: string;
}

/**
 * Baseline compatibility: same mode AND a non-trivial shared element basis
 * (≥1 shared node AND ≥1 shared branch when both sides have branches; for
 * transient runs the time basis is reconciled by interpolation at overlay
 * time, so differing grids are still compatible).
 */
export function checkRunCompatibility(
  current: RunRecord,
  candidate: RunRecord,
): RunCompatibility {
  if (candidate.id === current.id)
    return { ok: false, reason: "A run cannot be its own baseline" };
  if (candidate.mode !== current.mode) {
    return {
      ok: false,
      reason: `Mode mismatch (${candidate.mode} vs ${current.mode})`,
    };
  }
  const a = resultIdSets(current.result);
  const b = resultIdSets(candidate.result);
  if (sharedCount(a.nodes, b.nodes) === 0)
    return { ok: false, reason: "No shared nodes" };
  if (
    a.branches.size > 0 &&
    b.branches.size > 0 &&
    sharedCount(a.branches, b.branches) === 0
  ) {
    return { ok: false, reason: "No shared branches" };
  }
  return { ok: true };
}

/**
 * Linear interpolation of (srcT, srcV) onto the dstT grid, clamped to the
 * end values outside the source range. Used to overlay a baseline run whose
 * accepted-step time grid differs from the current run's.
 */
export function resampleSeries(
  srcT: number[],
  srcV: number[],
  dstT: number[],
): number[] {
  const n = srcT.length;
  if (n === 0 || srcV.length === 0) return dstT.map(() => 0);
  if (n === 1) return dstT.map(() => srcV[0]);
  const out = new Array<number>(dstT.length);
  let j = 0;
  for (let i = 0; i < dstT.length; i++) {
    const t = dstT[i];
    if (t <= srcT[0]) {
      out[i] = srcV[0];
      continue;
    }
    if (t >= srcT[n - 1]) {
      out[i] = srcV[n - 1];
      continue;
    }
    while (j < n - 2 && srcT[j + 1] < t) j++;
    const t0 = srcT[j];
    const t1 = srcT[j + 1];
    const v0 = srcV[j];
    const v1 = srcV[j + 1];
    const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    out[i] = v0 + f * (v1 - v0);
  }
  return out;
}

/** True when two time grids are elementwise identical (skip resampling). */
export function sameTimeGrid(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
