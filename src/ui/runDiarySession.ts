/**
 * runDiarySession.ts — pure orchestration of ONE manual run's convergence
 * diary across the worker callback lifecycle (Toolbar's startRun/cancelRun).
 *
 * Extracted from the Toolbar component so the diary lifecycle is testable
 * without mounting React.  It owns exactly two pieces of per-run state:
 *
 *   - the DiaryCollector fed by every onProgress payload, and
 *   - the cancel-request flag (Toolbar's cancelRequestedRef semantics).
 *
 * Finalization matrix (first-finalize-wins, enforced by the collector):
 *
 *   onDone       + no cancel request → completed diary from the result
 *   onDone       + cancel requested  → partial CANCELLED diary (a completion
 *                                      landing after cancel never fabricates
 *                                      a completed outcome)
 *   onError      + no cancel request → partial ERROR diary
 *   onError      + cancel requested  → partial CANCELLED diary
 *   run() reject + 'Cancelled' (or cancel requested) → partial CANCELLED diary
 *   run() reject + anything else     → partial ERROR diary
 *
 * Preflight validation/trust failures happen BEFORE a session is created,
 * so they never produce a diary.
 *
 * This module is pure: no React, no store, no worker protocol imports (the
 * progress view is the diary's own structural DiaryProgress).
 */
import type { NetworkConfig, SteadyResult, TransientResult } from "./types";
import type { DiaryExtras, DiaryProgress, RunDiary } from "./convergenceDiary";
import { createDiaryCollector } from "./convergenceDiary";

/** How a session finalized (or would finalize). */
export type RunDiaryFinalOutcome = "completed" | "cancelled" | "error";

export interface RunDiaryFinalization {
  outcome: RunDiaryFinalOutcome;
  diary: RunDiary;
}

export interface RunDiarySession {
  /** Mirror of Toolbar's cancelRequestedRef: true after requestCancel(). */
  readonly cancelRequested: boolean;
  /** Feed one worker progress payload (ignored after finalization). */
  onProgress: (progress: DiaryProgress) => void;
  /** Set the cancel guard (Toolbar's Cancel button → client.cancel()). */
  requestCancel: () => void;
  /** Worker onDone.  Cancel guard wins over the delivered result. */
  finalizeDone: (
    result: SteadyResult | TransientResult,
  ) => RunDiaryFinalization;
  /** Worker onError callback.  Cancel guard wins over the error. */
  finalizeWorkerError: (message: string) => RunDiaryFinalization;
  /** run() promise rejection (the catch block): 'Cancelled' rejections and
   *  the cancel guard finalize cancelled; anything else finalizes error. */
  finalizeRejection: (error: unknown) => RunDiaryFinalization;
  /** The finalized diary, or null when no finalize path has run yet. */
  diary: () => RunDiary | null;
}

function rejectionMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error)
    return String((error as { message: unknown }).message);
  return String(error);
}

export function createRunDiarySession(
  config: NetworkConfig,
  extras: DiaryExtras = {},
): RunDiarySession {
  const collector = createDiaryCollector(config, extras);
  let cancelRequested = false;
  let finalized: RunDiaryFinalization | null = null;

  /** First-finalize-wins: later finalize calls return the original diary. */
  function finalize(
    outcome: RunDiaryFinalOutcome,
    produce: () => RunDiary,
  ): RunDiaryFinalization {
    if (!finalized) finalized = { outcome, diary: produce() };
    return finalized;
  }

  return {
    get cancelRequested() {
      return cancelRequested;
    },

    onProgress(progress) {
      collector.onProgress(progress);
    },

    requestCancel() {
      cancelRequested = true;
    },

    finalizeDone(result) {
      if (cancelRequested)
        return finalize("cancelled", () => collector.finalizeCancelled());
      return finalize("completed", () => collector.finalizeFromResult(result));
    },

    finalizeWorkerError(message) {
      if (cancelRequested)
        return finalize("cancelled", () => collector.finalizeCancelled());
      return finalize("error", () => collector.finalizeError(message));
    },

    finalizeRejection(error) {
      const message = rejectionMessage(error);
      if (cancelRequested || message === "Cancelled") {
        return finalize("cancelled", () => collector.finalizeCancelled());
      }
      return finalize("error", () => collector.finalizeError(message));
    },

    diary() {
      return finalized ? finalized.diary : null;
    },
  };
}
