/**
 * Worker client wrapper.
 *
 * Handles a single module worker for solver offloading. Supports cancellation
 * via terminate + respawn (the worker's solve loop is synchronous, so a posted
 * 'cancel' message cannot be observed mid-solve without SharedArrayBuffer;
 * we avoid SAB to keep deployment simple).
 *
 * Usage:
 *   const client = createSolverWorkerClient();
 *   client.run(config, mode, {
 *     onStatusChange: (status) => store.setRunStatus(status),
 *     onProgress: (progress) => store.setProgress(progress),
 *     onLiveResult: (result) => store.setLiveResult(result),
 *     onDone: (result) => store.setResult(result),
 *     onError: (msg) => store.setValidationErrors([msg]),
 *   });
 *   // later:
 *   client.cancel();
 */

import type { NetworkConfig, SteadyResult, TransientResult } from "../core";

export type RunStatus =
  "idle" | "loadingFluids" | "running" | "done" | "error" | "cancelled";

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

export interface RunCallbacks {
  onStatusChange?: (status: RunStatus) => void;
  onProgress?: (progress: ProgressPayload) => void;
  onLiveResult?: (result: TransientResult | null) => void;
  onDone?: (result: SteadyResult | TransientResult) => void;
  onError?: (message: string) => void;
}

export interface SolverWorkerClient {
  run: (
    config: NetworkConfig,
    mode: "steady" | "transient",
    callbacks: RunCallbacks,
  ) => Promise<SteadyResult | TransientResult>;
  cancel: () => void;
  isRunning: () => boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function createSolverWorkerClient(): SolverWorkerClient {
  let worker: Worker | null = null;
  let currentResolve: ((value: SteadyResult | TransientResult) => void) | null =
    null;
  let currentReject: ((reason: Error) => void) | null = null;
  let currentCallbacks: RunCallbacks = {};
  let _running = false;

  function spawnWorker(): Worker {
    const w = new Worker(new URL("./solverWorker.ts", import.meta.url), {
      type: "module",
    });
    w.onmessage = (event: MessageEvent<unknown>) => {
      // Ignore late messages from a worker that is no longer current (it
      // was terminated/superseded — e.g. a message queued just before
      // cancel's terminate()).
      if (worker !== w) return;
      const msg = record(event.data);
      if (!msg || typeof msg.type !== "string") return;

      switch (msg.type) {
        case "ready":
          // No-op; worker is ready to receive messages.
          break;
        case "coolpropLoading":
          _running = true;
          currentCallbacks.onStatusChange?.("loadingFluids");
          break;
        case "progress": {
          const payload = msg.payload as ProgressPayload;
          if (
            !payload ||
            (payload.kind !== "steady" && payload.kind !== "transient")
          )
            break;
          currentCallbacks.onProgress?.(payload);
          if (payload.kind === "transient") {
            currentCallbacks.onLiveResult?.(payload.partial);
          }
          break;
        }
        case "done": {
          _running = false;
          const result = msg.result as SteadyResult | TransientResult;
          if (!result || typeof result !== "object") break;
          currentCallbacks.onStatusChange?.("done");
          currentCallbacks.onDone?.(result);
          currentResolve?.(result);
          cleanup();
          // One worker per solve: terminate on settle too, otherwise every
          // completed run leaks an idle worker.
          terminate();
          break;
        }
        case "error": {
          _running = false;
          const message = String(msg.message ?? "Unknown worker error");
          currentCallbacks.onStatusChange?.("error");
          currentCallbacks.onError?.(message);
          currentReject?.(new Error(message));
          cleanup();
          terminate();
          break;
        }
      }
    };
    w.onerror = (err) => {
      if (worker !== w) return;
      _running = false;
      const message = err.message ?? "Worker error";
      currentCallbacks.onStatusChange?.("error");
      currentCallbacks.onError?.(message);
      currentReject?.(new Error(message));
      cleanup();
      terminate();
    };
    return w;
  }

  function cleanup() {
    currentResolve = null;
    currentReject = null;
    currentCallbacks = {};
  }

  function terminate() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  return {
    isRunning: () => _running,

    run(config, mode, callbacks) {
      if (_running) {
        return Promise.reject(new Error("A simulation is already running"));
      }
      _running = true;
      currentCallbacks = callbacks;
      callbacks.onStatusChange?.("running");

      return new Promise((resolve, reject) => {
        currentResolve = resolve;
        currentReject = reject;
        try {
          worker = spawnWorker();
          worker.postMessage({ type: "run", config, mode });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          _running = false;
          callbacks.onStatusChange?.("error");
          callbacks.onError?.(message);
          terminate();
          cleanup();
          reject(new Error(message));
        }
      });
    },

    cancel() {
      if (!_running) return;
      _running = false;
      currentCallbacks.onStatusChange?.("cancelled");
      // Terminate + respawn is the only reliable way to stop a synchronous
      // compute loop in a worker when SharedArrayBuffer is unavailable.
      terminate();
      currentReject?.(new Error("Cancelled"));
      cleanup();
    },
  };
}

let globalClient: SolverWorkerClient | null = null;

export function getSolverWorkerClient(): SolverWorkerClient {
  if (!globalClient) {
    globalClient = createSolverWorkerClient();
  }
  return globalClient;
}
