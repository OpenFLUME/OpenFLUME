/**
 * workerProtocol.ts — the wire contract between the main thread and the
 * solver worker, in one place so both sides compile against the same types.
 *
 * `solverWorker.ts` posts `WorkerToMainMessage` values and accepts
 * `MainToWorkerMessage`; `workerClient.ts` does the reverse. Structured clone
 * preserves the shapes, but a worker is a separate compilation target, so
 * the receiving side still narrows `event.data` at runtime through the
 * guards below — the union is a contract, not a proof.
 *
 * Cancellation is deliberately NOT a message: the solve loops are synchronous
 * and a posted message cannot be observed mid-solve without
 * SharedArrayBuffer, so the client terminates the worker and respawns.
 */
import type { NetworkConfig, SteadyResult, TransientResult } from "../core";

export type RunMode = "steady" | "transient";

export interface TransientProgress {
  kind: "transient";
  step: number;
  totalSteps?: number;
  time: number;
  endTime: number;
  dt?: number;
  partial: TransientResult;
}

export interface SteadyProgress {
  kind: "steady";
  iteration: number;
  residual: number;
}

export type ProgressPayload = TransientProgress | SteadyProgress;

export type MainToWorkerMessage = {
  type: "run";
  config: NetworkConfig;
  mode: RunMode;
};

export type WorkerToMainMessage =
  | { type: "ready" }
  | { type: "coolpropLoading" }
  | { type: "progress"; payload: ProgressPayload }
  | { type: "done"; result: SteadyResult | TransientResult }
  | { type: "error"; message: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** Runtime narrowing of a received `event.data` to the wire union. Messages
 *  with an unknown `type` or a malformed body are rejected (returns null)
 *  rather than half-trusted. */
export function parseWorkerToMainMessage(
  data: unknown,
): WorkerToMainMessage | null {
  const msg = record(data);
  if (!msg) return null;
  switch (msg.type) {
    case "ready":
    case "coolpropLoading":
      return { type: msg.type };
    case "progress": {
      const payload = record(msg.payload);
      // Structured clone preserves the shape the worker posted; the kind
      // tag is what a receiver can check without re-validating a result.
      if (payload?.kind === "steady" || payload?.kind === "transient")
        return {
          type: "progress",
          payload: payload as unknown as ProgressPayload,
        };
      return null;
    }
    case "done": {
      const result = record(msg.result);
      return result
        ? {
            type: "done",
            result: result as unknown as SteadyResult | TransientResult,
          }
        : null;
    }
    case "error":
      return {
        type: "error",
        message:
          typeof msg.message === "string"
            ? msg.message
            : "Unknown worker error",
      };
    default:
      return null;
  }
}
