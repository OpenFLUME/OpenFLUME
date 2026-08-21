/**
 * Solver Web Worker (module type).
 *
 * Protocol (typed messages via postMessage / onmessage):
 *   Main → Worker:
 *     { type: 'run', config: NetworkConfig, mode: 'steady' | 'transient' }
 *     { type: 'cancel' }
 *   Worker → Main:
 *     { type: 'ready' }
 *     { type: 'coolpropLoading' }
 *     { type: 'progress', payload: TransientProgress | SteadyProgress }
 *     { type: 'done', result: SteadyResult | TransientResult }
 *     { type: 'error', message: string }
 *
 * Cancellation:
 *   The solve loops are synchronous and run to completion in a single event-loop
 *   turn, so a posted 'cancel' message cannot be observed mid-solve by a simple
 *   flag. We do NOT use SharedArrayBuffer (requires crossOriginIsolated headers).
 *   Instead, the client wrapper terminates the worker and respawns a fresh one.
 *   This is the simplest robust choice and avoids header configuration.
 *
 * Progress throttling:
 *   We emit at most ~10 progress messages per second. For transient runs we
 *   send the full partial snapshot (sliced arrays). The structured-clone cost
 *   is acceptable at this rate: a 1000-step run with 10 nodes + 10 branches
 *   sends ~10 messages × ~30 kB each = ~300 kB total (measured by
 *   JSON.stringify on the payload). For larger networks the client may
 *   switch to delta-increment messages in the future.
 */

import type { NetworkConfig } from "../core";
import {
  decodeAndValidateNetwork,
  ConfigDecodeError,
  solveSteady,
  solveTransient,
  initRealFluids,
  networkUsesRealFluid,
} from "../core";

let _cancelled = false;

export interface PreparedWorkerRun {
  config: NetworkConfig;
  mode: "steady" | "transient";
}

/**
 * Decode + validate the payload of an incoming 'run' message.  Pure (touches
 * no worker globals) so it is unit-testable from the main-thread test
 * suite.  Returns a user-presentable error message instead of throwing:
 * ConfigDecodeError paths (malformed/unsupported-version configs) are
 * prefixed so they read distinctly from semantic validation errors.
 */
export function prepareWorkerRun(
  data: unknown,
): { ok: true; run: PreparedWorkerRun } | { ok: false; message: string } {
  if (typeof data !== "object" || data === null) {
    return { ok: false, message: "Malformed run message: expected an object" };
  }
  const { config: rawConfig, mode } = data as {
    config?: unknown;
    mode?: unknown;
  };
  let decoded;
  try {
    decoded = decodeAndValidateNetwork(rawConfig);
  } catch (err) {
    if (err instanceof ConfigDecodeError) {
      return { ok: false, message: `Invalid network config — ${err.message}` };
    }
    throw err;
  }
  if (decoded.errors.length > 0) {
    return { ok: false, message: decoded.errors.join("; ") };
  }
  if (mode !== undefined && mode !== decoded.config.settings.mode) {
    return {
      ok: false,
      message: `Run mode ${JSON.stringify(mode)} does not match config.settings.mode ${JSON.stringify(decoded.config.settings.mode)}`,
    };
  }
  return {
    ok: true,
    run: { config: decoded.config, mode: decoded.config.settings.mode },
  };
}

function installWorkerHandlers(): void {
  self.onmessage = async (event: MessageEvent<unknown>) => {
    const msg =
      typeof event.data === "object" && event.data !== null
        ? (event.data as Record<string, unknown>)
        : null;

    if (msg?.type === "cancel") {
      _cancelled = true;
      return;
    }

    if (msg?.type !== "run") return;

    const prepared = prepareWorkerRun(event.data);
    if (!prepared.ok) {
      self.postMessage({ type: "error", message: prepared.message });
      return;
    }
    const { config, mode } = prepared.run;
    _cancelled = false;

    try {
      if (networkUsesRealFluid(config)) {
        self.postMessage({ type: "coolpropLoading" });
        try {
          await initRealFluids();
        } catch (err) {
          self.postMessage({
            type: "error",
            message: `CoolProp init failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
      }

      if (mode === "transient") {
        let lastProgressTime = 0;
        let hasSentFirstProgress = false;
        const result = solveTransient(config, {
          onProgress: (p) => {
            const now = performance.now();
            if (hasSentFirstProgress && now - lastProgressTime < 100) return; // throttle to ~10/s
            hasSentFirstProgress = true;
            lastProgressTime = now;
            self.postMessage({
              type: "progress",
              payload: {
                kind: "transient",
                step: p.step,
                totalSteps: p.totalSteps,
                time: p.time,
                endTime: p.endTime ?? config.settings.endTime!,
                dt: p.dt,
                partial: p.partial,
              },
            });
          },
          shouldAbort: () => _cancelled,
        });
        self.postMessage({ type: "done", result });
      } else {
        let lastProgressTime = 0;
        let hasSentFirstProgress = false;
        const onProgress = (p: { iteration: number; residual: number }) => {
          const now = performance.now();
          if (hasSentFirstProgress && now - lastProgressTime < 100) return;
          hasSentFirstProgress = true;
          lastProgressTime = now;
          self.postMessage({
            type: "progress",
            payload: {
              kind: "steady",
              iteration: p.iteration,
              residual: p.residual,
            },
          });
        };
        const result = solveSteady(config, {
          onProgress,
          shouldAbort: () => _cancelled,
        });
        self.postMessage({ type: "done", result });
      }
    } catch (err: any) {
      self.postMessage({ type: "error", message: err?.message ?? String(err) });
    }
  };

  // Notify main thread that worker is ready
  self.postMessage({ type: "ready" });
}

// Install the handler only inside a real worker global scope, so this module
// stays importable from main-thread unit tests (for prepareWorkerRun).
if (typeof self !== "undefined") {
  installWorkerHandlers();
}
