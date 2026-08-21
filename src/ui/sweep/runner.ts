/**
 * sweep/runner.ts — generic sequential solve-queue executor.
 *
 * runSolveQueue executes an ordered list of immutable solve units through a
 * SolverWorkerClient factory, strictly one at a time (concurrency 1): the
 * next unit's client is only created after the previous unit's run promise
 * has settled.  One worker per solve — the client factory is invoked once
 * per unit and the workerClient itself spawns exactly one worker per run()
 * (terminated on done/error/cancel).
 *
 * The queue is deliberately job-kind agnostic: a parameter sweep supplies
 * units via sweepSolveUnits today; a future optimization job can reuse the
 * same queue/lifecycle with its own unit source.  All job-state ownership
 * stays with the caller through hooks.
 *
 * Race safety: hooks.isCurrent() is the caller's generation/cancellation
 * guard.  It is checked before each unit starts, inside every progress
 * callback, and immediately after each run settles — a late settle
 * (done/error) after cancellation or supersession is never applied.  When
 * isCurrent() flips false mid-flight the queue abandons the loop and
 * returns 'cancelled'; the caller is responsible for having already
 * finalized the job state (cancelJob does this synchronously).
 */
import type { NetworkConfig } from "../../core";
import type { ProgressPayload, SolverWorkerClient } from "../workerClient";
import { materializeSweepVariants } from "./variants";
import type { SolveJob, SolveResult } from "./types";

/** One unit of sequential solve work: an immutable config + its identity. */
export interface SolveUnit {
  /** 0-based variant index within the owning job. */
  index: number;
  /** Deep-frozen immutable config snapshot to solve. */
  config: NetworkConfig;
  /** FNV-1a/64 hash of `config`, matching the job's variant record. */
  configHash: string;
}

export interface SolveQueueHooks {
  /** Generation/cancellation guard, checked at every suspension point. */
  isCurrent: () => boolean;
  /** Hands the freshly created client to the caller so cancel() can reach
   *  the in-flight solve.  Called once per unit, just before it starts. */
  onClient?: (unit: SolveUnit, client: SolverWorkerClient) => void;
  onUnitStart?: (unit: SolveUnit) => void;
  onUnitProgress?: (unit: SolveUnit, progress: ProgressPayload) => void;
  onUnitDone?: (unit: SolveUnit, result: SolveResult) => void;
  onUnitError?: (unit: SolveUnit, message: string) => void;
}

export interface SolveQueueDeps {
  /** Factory for the worker client used by each unit's solve.  One client
   *  (hence one worker) per unit keeps solves independent and lets tests
   *  observe the exact call sequence. */
  createClient: () => SolverWorkerClient;
}

/** Solve mode declared by a unit's config (schema guarantees the union). */
function unitMode(config: NetworkConfig): "steady" | "transient" {
  return config.settings.mode === "transient" ? "transient" : "steady";
}

/**
 * Run `units` in order, awaiting each solve before starting the next.
 * Returns 'completed' when every unit settled (successfully or not — a unit
 * failure is reported through onUnitError and the queue CONTINUES), or
 * 'cancelled' when the guard went stale (cancellation/supersession), in
 * which case no further hooks fire.
 *
 * The run promise is the authoritative settle channel: onDone/onError
 * callbacks are not used for result delivery, so a client cannot
 * double-report a unit.
 */
export async function runSolveQueue(
  units: readonly SolveUnit[],
  hooks: SolveQueueHooks,
  deps: SolveQueueDeps,
): Promise<"completed" | "cancelled"> {
  for (const unit of units) {
    if (!hooks.isCurrent()) return "cancelled";
    const client = deps.createClient();
    hooks.onClient?.(unit, client);
    hooks.onUnitStart?.(unit);
    let result: SolveResult | undefined;
    let error: string | undefined;
    try {
      result = await client.run(unit.config, unitMode(unit.config), {
        onProgress: (progress) => {
          if (hooks.isCurrent()) hooks.onUnitProgress?.(unit, progress);
        },
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    // A cancellation/supersession that landed mid-flight has already been
    // finalized by the caller — drop this settle on the floor.
    if (!hooks.isCurrent()) return "cancelled";
    if (error !== undefined) hooks.onUnitError?.(unit, error);
    else hooks.onUnitDone?.(unit, result as SolveResult);
  }
  return hooks.isCurrent() ? "completed" : "cancelled";
}

/**
 * Deterministically re-materialize a sweep job's frozen variant configs
 * from its frozen base snapshot + definition, and verify each config hash
 * against the creation-time variant record.  Throws when the hashes drift
 * (they cannot unless the materialization pipeline changed underneath a
 * live job — an integrity failure worth refusing to solve over).
 */
export function sweepSolveUnits(job: SolveJob): SolveUnit[] {
  const variants = materializeSweepVariants(job.baseConfig, job.sweep);
  return variants.map((v) => {
    const record = job.variants[v.index];
    if (
      !record ||
      record.configHash !== v.configHash ||
      record.index !== v.index
    ) {
      throw new Error(
        `Sweep job ${job.id}: variant ${v.index} hash drifted since creation ` +
          `(${record?.configHash ?? "missing"} → ${v.configHash})`,
      );
    }
    return { index: v.index, config: v.config, configHash: v.configHash };
  });
}
