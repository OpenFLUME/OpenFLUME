/**
 * runController.ts — orchestration of manual solver runs.
 *
 * Extracted from the Toolbar component so any shell chrome (toolbar button,
 * command palette, bottom run strip, …) can start/cancel runs without owning
 * the worker/diary lifecycle.  All state flows through the Zustand store;
 * the only module-level state here is the in-flight run's diary session
 * (which carries the cancel guard AND the diary collector).
 *
 * Behavioral contract (unchanged from the Toolbar implementation):
 *  - a running sweep owns the shared solver client → manual runs are refused;
 *  - preflight embeds/trusts user components and validates BEFORE any diary
 *    session exists (preflight failures never produce a diary);
 *  - cancel finalizes a partial cancelled diary and never fabricates a
 *    completed RunRecord.
 */
import { flushSync } from "react-dom";
import { useStore } from "./store";
import { cloneConfig } from "./utils";
import { examples } from "./examples";
import { validateNetwork } from "../core";
import { getSolverWorkerClient } from "./workerClient";
import { createRunDiarySession, type RunDiarySession } from "./runDiarySession";
import { useSweepStore } from "./sweep/store";
import type { NetworkConfig } from "./types";
import {
  compareEmbeddedComponents,
  embedReferencedComponents,
  isComponentSourceTrusted,
  refreshComponentLibrary,
} from "./componentLibrary";

// Diary session of the in-flight/latest manual run.  Null outside a run (and
// during preflight, which by design never produces a diary).
let runSession: RunDiarySession | null = null;

// Component sources shipped with the bundled examples are implicitly trusted
// (the user got them from this app, not from an untrusted file).
let bundledComponentSources: Set<string> | null = null;
function getBundledComponentSources(): Set<string> {
  if (!bundledComponentSources) {
    bundledComponentSources = new Set(
      Object.values(examples).flatMap((example) =>
        Object.values(example.componentLibrary ?? {}).map(
          (entry) => entry.code,
        ),
      ),
    );
  }
  return bundledComponentSources;
}

/** Start a manual solver run. Safe to call from any UI surface. */
export async function startRun(): Promise<void> {
  // Race guard: a sweep owns the (shared) solver client; run affordances are
  // disabled while one runs, but re-check at the boundary so a stale click
  // or keyboard activation can never interleave a manual run with a sweep.
  if (useSweepStore.getState().isRunning()) return;
  const store = useStore.getState();
  if (!store.beginPreparation("run")) return;
  // New run: reset the diary session (cancel guard + collector) and clear
  // any stale diary left by a previous cancelled/errored/historical run.
  runSession = null;
  store.setResult(null);
  store.setResultDiary(null);
  store.setLiveResult(null);
  store.setValidationErrors([]);
  store.setRunProgress(null);
  store.setTimeIndex(null);

  let cloned: NetworkConfig;
  try {
    const library = await refreshComponentLibrary();
    cloned = cloneConfig(useStore.getState().config);
    const bundled = getBundledComponentSources();
    const untrustedEmbedded = (
      await compareEmbeddedComponents(
        cloned.componentLibrary,
        library.components,
      )
    ).filter((entry) => {
      const source = cloned.componentLibrary?.[entry.key]?.code;
      return (
        entry.status !== "match" &&
        !isComponentSourceTrusted(entry.embeddedHash) &&
        !(source && bundled.has(source))
      );
    });
    if (untrustedEmbedded.length > 0) {
      store.setValidationErrors([
        `Run blocked: embedded component code is not trusted (${untrustedEmbedded.map((entry) => entry.key).join(", ")}). ` +
          "Load the model file and approve its component code before running.",
      ]);
      store.setRunStatus("error");
      return;
    }
    const unavailable = embedReferencedComponents(cloned, library.components);
    if (unavailable.length > 0) {
      store.setValidationErrors(
        unavailable.map(
          (key) =>
            `User component "${key}" is not embedded and is unavailable from the local component library.`,
        ),
      );
      store.setRunStatus("error");
      return;
    }
    const errs = validateNetwork(cloned);
    if (errs.length > 0) {
      store.setValidationErrors(errs);
      store.setRunStatus("error");
      return;
    }
    store.setRunStatus("running");
  } catch (error) {
    store.setValidationErrors([
      error instanceof Error ? error.message : String(error),
    ]);
    store.setRunStatus("error");
    return;
  } finally {
    store.endPreparation("run");
  }

  flushSync(() => {}); // ensure cancel button is in the DOM before worker can finish

  // One diary collector per run, created only AFTER the validated immutable
  // config snapshot exists (preflight validation/trust failures above never
  // produce a diary).
  const session = createRunDiarySession(cloned);
  runSession = session;

  const client = getSolverWorkerClient();

  try {
    await client.run(cloned, cloned.settings.mode as "steady" | "transient", {
      onStatusChange: (status) => {
        store.setRunStatus(status);
      },
      onProgress: (progress) => {
        store.setRunProgress(progress);
        session.onProgress(progress);
      },
      onLiveResult: (partial) => {
        if (partial) store.setLiveResult(partial);
      },
      onDone: (res) => {
        const fin = session.finalizeDone(res);
        if (fin.outcome === "cancelled") {
          // Cancel guard was set: expose the partial cancelled diary with
          // the cancelled state; never fabricate a completed RunRecord.
          store.setRunStatus("cancelled");
          store.setResultDiary(fin.diary);
          return;
        }
        store.setResult(res);
        // Ring-buffer the completed run so re-runs never destroy history;
        // pushRunRecord also makes the run's diary the current one.
        store.pushRunRecord({ result: res, config: cloned, diary: fin.diary });
        store.setLiveResult(null);
      },
      onError: (msg) => {
        const fin = session.finalizeWorkerError(msg);
        if (fin.outcome === "cancelled") {
          store.setRunStatus("cancelled");
          store.setResultDiary(fin.diary);
          return;
        }
        // Worker error after execution began: expose the partial error
        // diary alongside the error state (no RunRecord).
        store.setResultDiary(fin.diary);
        store.setValidationErrors([msg]);
        store.setLiveResult(null);
      },
    });
  } catch (err: unknown) {
    const fin = session.finalizeRejection(err);
    store.setResultDiary(fin.diary);
    if (fin.outcome === "cancelled") {
      store.setRunStatus("cancelled");
    } else {
      store.setValidationErrors([
        err instanceof Error ? err.message : String(err),
      ]);
      store.setRunStatus("error");
    }
  }
}

/** Cancel the in-flight manual run (no-op when nothing is running). */
export function cancelRun(): void {
  runSession?.requestCancel();
  const client = getSolverWorkerClient();
  client.cancel();
}
