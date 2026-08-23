/**
 * sweep/store.ts — session-only exploration/sweep job store and lifecycle.
 *
 * A zustand store of parameter-sweep solve jobs, fully isolated from the
 * canonical model store (src/ui/store.ts):
 *
 *   - The ONLY read from the canonical store is the config snapshot taken
 *     at createJob() (createSweepJob structuredClones it — the editor's
 *     config is never mutated, frozen, or referenced).
 *   - No execution path touches useStore().config, modelText, undo/redo,
 *     dirty, result, or run history.  The single exception is
 *     promoteVariant(), the explicit user action that appends exactly one
 *     RunRecord (pushRunRecord) and selects it (selectRun) using the
 *     variant's immutable config + retained result.
 *   - Nothing here is persisted; jobs live for the session.
 *
 * Status vocabulary (existing SolveJobStatus/SweepVariantStatus types):
 *   job:     'pending' (ready) → 'running' → 'completed' | 'failed' | 'cancelled'
 *   variant: 'pending' → 'running' → 'completed' | 'failed' | 'cancelled'
 * A job whose run finished with ≥1 failed variant is 'failed' (counts in
 * job.result keep the nuance); 'completed' means every variant completed.
 *
 * Execution (see runner.ts): strictly sequential, concurrency 1, one worker
 * per variant solve, through the shared solver worker client by default.
 * A variant failure is recorded and later variants still run.
 *
 * Cancellation (cancelJob) is synchronous:
 *   - the in-flight variant and every pending variant become 'cancelled';
 *     'completed'/'failed' variants keep their results;
 *   - the job becomes 'cancelled' with finishedAt/durationMs set;
 *   - the active worker is terminated via client.cancel();
 *   - a generation guard makes any late settle from the terminated solve a
 *     no-op — a cancelled job/variant can never flip back to done.
 *
 * Convergence diaries: each variant solve gets one DiaryCollector created
 * from its immutable variant config at unit start, fed by the live progress
 * stream, and finalized on done (result diary), error (partial error diary),
 * or mid-flight cancel (partial cancelled diary).  Diaries attach to the
 * variant record under the same generation guard as the result — a late
 * settle/progress callback can never touch them.  Variants cancelled while
 * still pending never started, so they carry no diary.  Diary state lives
 * in the mutable per-run runtime (not in zustand render state) until
 * finalization.
 *
 * Rerun policy (rerunJob) — refused while the job is running (cancel first):
 *   - scope 'incomplete' (default): 'failed'/'cancelled'/'pending' variants
 *     reset to 'pending' (error/summary/result/timing/diary cleared);
 *     'completed' variants keep their results AND diaries;
 *   - scope 'all': every variant resets to 'pending';
 *   - the job returns to 'pending' with startedAt/finishedAt/durationMs/
 *     error/result/summary cleared (createdAt and the frozen base snapshot
 *     are kept);
 *   - execution reuses the frozen variant configs, re-materialized
 *     deterministically from the frozen base snapshot and hash-verified
 *     against the creation-time records (sweepSolveUnits).
 *
 * Gates: startJob refuses while a manual run/preparation is active in the
 * canonical store, while another sweep job is active, or when the job is
 * not 'pending' (a running job is rejected; a terminal job needs rerunJob
 * first).  The module-level isSweepRunning() lets Toolbar/UI block manual
 * Run while a sweep is active.
 *
 * Staleness: isStale(jobId) compares the job's frozen baseConfigHash with
 * the current canonical config hash — informational only, never blocking.
 */
import { create } from "zustand";
import { useStore } from "../store";
import { configHash } from "../provenance";
import type { ProgressPayload, SolverWorkerClient } from "../workerClient";
import { getSolverWorkerClient } from "../workerClient";
import type { RunRecord } from "../runHistory";
import type { RunDiary } from "../convergenceDiary";
import {
  buildDiaryFromResult,
  createDiaryCollector,
  type DiaryCollector,
} from "../convergenceDiary";
import { createSweepJob } from "./variants";
import { summarizeVariant } from "./summary";
import { runSolveQueue, sweepSolveUnits, type SolveUnit } from "./runner";
import type { SolveJob, SweepDefinition, SweepVariantRecord } from "./types";

export type SweepOpResult = { ok: true } | { ok: false; reason: string };

/** startJob returns promptly: ok:true carries a `finished` promise for the
 *  whole job (never rejects — the terminal job state carries the outcome). */
export type StartJobResult =
  { ok: true; finished: Promise<SolveJob> } | { ok: false; reason: string };

export type PromoteVariantResult =
  { ok: true; record: RunRecord } | { ok: false; reason: string };

export interface RerunOptions {
  /** 'incomplete' (default) keeps completed variants; 'all' resets every
   *  variant.  Both reuse the frozen variant configs. */
  scope?: "incomplete" | "all";
}

export interface SweepStoreDeps {
  /** Worker client factory — one client (one worker) per variant solve.
   *  Defaults to the shared singleton so sweep solves and the manual Run
   *  button can never run concurrently. */
  createClient?: () => SolverWorkerClient;
  /** Clock override for deterministic tests. */
  now?: () => number;
}

export interface SweepStoreState {
  /** All jobs this session, in creation order. */
  jobs: SolveJob[];
  /** The currently running job id (at most one sweep runs at a time). */
  activeJobId: string | null;
  /** Variant index currently solving within the active job. */
  activeVariantIndex: number | null;
  /** Latest solver progress payload of the in-flight variant (ephemeral). */
  activeProgress: ProgressPayload | null;

  /** Create a pending job from the CURRENT canonical config + a validated
   *  definition.  Throws SweepDefinitionError on structural problems — run
   *  validateSweepDefinition first for user-supplied input. */
  createJob: (
    definition: SweepDefinition,
    opts?: { id?: string; now?: number },
  ) => SolveJob;
  /** Begin sequential execution.  Returns promptly; refusal is explicit. */
  startJob: (id: string) => StartJobResult;
  /** Cancel a running job (no-op result for anything else).  Synchronous. */
  cancelJob: (id: string) => SweepOpResult;
  /** Reset a terminal (or pending) job for another run — see header. */
  rerunJob: (id: string, opts?: RerunOptions) => SweepOpResult;
  /** Remove a job from the session list.  Refused while the job is running
   *  (cancel first) — discarding never touches the canonical store. */
  discardJob: (id: string) => SweepOpResult;
  /** Append a completed variant to the canonical run history and select
   *  it.  The only bridge from the sweep store into the canonical store. */
  promoteVariant: (jobId: string, index: number) => PromoteVariantResult;

  getJob: (id: string) => SolveJob | undefined;
  /** True while any sweep job is running (block manual Run in the UI). */
  isRunning: () => boolean;
  /** baseHash vs current canonical config hash; null for unknown jobs. */
  isStale: (id: string) => boolean | null;
}

/** Mutable per-instance execution runtime — client handles, per-variant
 *  diary collectors, and the generation counter.  Kept OUTSIDE zustand
 *  state: not renderable data. */
interface ActiveRun {
  jobId: string;
  generation: number;
  /** Client of the in-flight variant solve (null between variants). */
  client: SolverWorkerClient | null;
  /** Live diary collector per variant index (created at unit start). */
  collectors: Map<number, DiaryCollector>;
}

function variantCounts(variants: readonly SweepVariantRecord[]) {
  const completed = variants.filter((v) => v.status === "completed").length;
  const failed = variants.filter((v) => v.status === "failed").length;
  const converged = variants.filter(
    (v) => v.status === "completed" && v.summary?.converged === true,
  ).length;
  return { completed, failed, converged, total: variants.length };
}

/** One-line job summary, e.g. "5/5 completed · 4 converged". */
function jobSummaryLine(variants: readonly SweepVariantRecord[]): string {
  const { completed, failed, converged, total } = variantCounts(variants);
  const parts = [`${completed}/${total} completed`];
  if (failed > 0) parts.push(`${failed} failed`);
  parts.push(`${converged} converged`);
  return parts.join(" · ");
}

let jobCounter = 0;

export function createSweepStore(deps: SweepStoreDeps = {}) {
  const createClient = deps.createClient ?? getSolverWorkerClient;
  const now = deps.now ?? (() => Date.now());
  const runtime: { generation: number; active: ActiveRun | null } = {
    generation: 0,
    active: null,
  };

  return create<SweepStoreState>((set, get) => {
    const getJob = (id: string) => get().jobs.find((j) => j.id === id);

    const patchJob = (id: string, patch: (job: SolveJob) => SolveJob) => {
      set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? patch(j) : j)) }));
    };

    const patchVariant = (
      id: string,
      index: number,
      patch: (v: SweepVariantRecord) => SweepVariantRecord,
    ) => {
      patchJob(id, (j) => ({
        ...j,
        variants: j.variants.map((v) => (v.index === index ? patch(v) : v)),
      }));
    };

    /** progress.completed counts successfully completed variants. */
    const recomputeProgress = (job: SolveJob): SolveJob => ({
      ...job,
      progress: {
        completed: variantCounts(job.variants).completed,
        total: job.variants.length,
      },
    });

    /** Terminal finalize for a queue that ran to completion (not cancelled). */
    const finalizeFinished = (job: SolveJob): SolveJob => {
      const finishedAt = now();
      const { completed, failed, total } = variantCounts(job.variants);
      return {
        ...job,
        status: failed > 0 ? "failed" : "completed",
        finishedAt,
        durationMs: finishedAt - (job.startedAt ?? finishedAt),
        ...(failed > 0
          ? { error: `${failed} of ${total} variants failed` }
          : { error: undefined }),
        result: {
          total,
          completed,
          failed,
          converged: variantCounts(job.variants).converged,
        },
        summary: jobSummaryLine(job.variants),
      };
    };

    /** Terminal finalize for cancellation: running/pending variants become
     *  'cancelled'; completed/failed variants keep their outcomes.  The
     *  in-flight variant (if any) receives its partial cancelled diary;
     *  pending variants never started and carry no diary. */
    const finalizeCancelled = (
      job: SolveJob,
      cancelledDiary?: { index: number; diary: RunDiary },
    ): SolveJob => {
      const finishedAt = now();
      const variants = job.variants.map((v): SweepVariantRecord => {
        if (v.status !== "running" && v.status !== "pending") return v;
        return {
          ...v,
          status: "cancelled",
          durationMs:
            v.startedAt !== undefined ? finishedAt - v.startedAt : undefined,
          ...(cancelledDiary && v.index === cancelledDiary.index
            ? { diary: cancelledDiary.diary }
            : {}),
        };
      });
      const { completed, failed, converged, total } = variantCounts(variants);
      return {
        ...job,
        variants,
        status: "cancelled",
        finishedAt,
        durationMs: finishedAt - (job.startedAt ?? finishedAt),
        progress: { completed, total },
        result: { total, completed, failed, converged },
        summary: jobSummaryLine(variants),
      };
    };

    const clearActive = () =>
      set({
        activeJobId: null,
        activeVariantIndex: null,
        activeProgress: null,
      });

    /** Sequential execution driver.  Every state write is guarded by
     *  isCurrent() so stale continuations (post-cancel, post-supersede)
     *  can never touch the job again. */
    const executeJob = async (
      jobId: string,
      generation: number,
    ): Promise<SolveJob> => {
      const isCurrent = () =>
        runtime.active?.jobId === jobId &&
        runtime.active.generation === generation;
      const jobAtStart = getJob(jobId);
      if (!jobAtStart) {
        runtime.active = null;
        clearActive();
        throw new Error(`Sweep job ${jobId} disappeared before execution`);
      }

      let units: SolveUnit[];
      try {
        units = sweepSolveUnits(jobAtStart);
      } catch (err) {
        if (isCurrent()) {
          runtime.active = null;
          const finishedAt = now();
          patchJob(jobId, (j) => ({
            ...j,
            status: "failed",
            finishedAt,
            durationMs: finishedAt - (j.startedAt ?? finishedAt),
            error: err instanceof Error ? err.message : String(err),
          }));
          clearActive();
        }
        return getJob(jobId) ?? jobAtStart;
      }

      // Only variants still pending run; completed results (kept by
      // rerunJob 'incomplete') are reused, not re-solved.
      const pending = units.filter((u) =>
        jobAtStart.variants.some(
          (v) => v.index === u.index && v.status === "pending",
        ),
      );

      await runSolveQueue(
        pending,
        {
          isCurrent,
          onClient: (_unit, client) => {
            if (isCurrent() && runtime.active) runtime.active.client = client;
          },
          onUnitStart: (unit) => {
            // One diary collector per variant run, from the immutable variant
            // config; fed by live progress until done/error/cancel finalizes.
            if (isCurrent() && runtime.active) {
              runtime.active.collectors.set(
                unit.index,
                createDiaryCollector(unit.config),
              );
            }
            patchVariant(jobId, unit.index, (v) => ({
              ...v,
              status: "running",
              startedAt: now(),
              diary: undefined,
            }));
            set({ activeVariantIndex: unit.index, activeProgress: null });
          },
          onUnitProgress: (unit, progress) => {
            // Feed the variant's collector (the runner already guards this
            // hook with isCurrent — a late callback never reaches here).
            runtime.active?.collectors.get(unit.index)?.onProgress(progress);
            set({ activeProgress: progress });
          },
          onUnitDone: (unit, result) => {
            const doneAt = now();
            // Finalize the live diary; fall back to a final-evidence
            // diary if the collector is somehow missing (never fabricated
            // progress milestones in that case).
            const diary =
              runtime.active?.collectors
                .get(unit.index)
                ?.finalizeFromResult(result) ??
              buildDiaryFromResult(unit.config, result);
            patchVariant(jobId, unit.index, (v) => ({
              ...v,
              status: "completed",
              result,
              diary,
              summary: summarizeVariant(result, {
                endTime:
                  unit.config.settings.mode === "transient"
                    ? unit.config.settings.endTime
                    : undefined,
              }),
              durationMs:
                v.startedAt !== undefined ? doneAt - v.startedAt : undefined,
              error: undefined,
            }));
            patchJob(jobId, recomputeProgress);
            set({ activeProgress: null });
          },
          onUnitError: (unit, message) => {
            const doneAt = now();
            const diary = runtime.active?.collectors
              .get(unit.index)
              ?.finalizeError(message);
            patchVariant(jobId, unit.index, (v) => ({
              ...v,
              status: "failed",
              error: message,
              result: undefined,
              summary: undefined,
              ...(diary ? { diary } : {}),
              durationMs:
                v.startedAt !== undefined ? doneAt - v.startedAt : undefined,
            }));
            set({ activeProgress: null });
          },
        },
        { createClient },
      );

      // Cancelled/superseded mid-flight: cancelJob already finalized.
      if (!isCurrent()) return getJob(jobId) ?? jobAtStart;

      runtime.active = null;
      patchJob(jobId, finalizeFinished);
      clearActive();
      return getJob(jobId) ?? jobAtStart;
    };

    return {
      jobs: [],
      activeJobId: null,
      activeVariantIndex: null,
      activeProgress: null,

      createJob: (definition, opts) => {
        const id = opts?.id ?? `sweep-${now().toString(36)}-${++jobCounter}`;
        if (getJob(id)) throw new Error(`Duplicate sweep job id ${id}`);
        // createSweepJob deep-freezes a structuredClone — the canonical
        // config is only read, never mutated or frozen.
        const job = createSweepJob({
          id,
          baseConfig: useStore.getState().config,
          definition,
          now: opts?.now ?? now(),
        });
        set((s) => ({ jobs: [...s.jobs, job] }));
        return job;
      },

      startJob: (id) => {
        const job = getJob(id);
        if (!job) return { ok: false, reason: `Unknown sweep job ${id}` };
        if (job.status === "running")
          return { ok: false, reason: `Sweep job ${id} is already running` };
        if (job.status !== "pending") {
          return {
            ok: false,
            reason: `Sweep job ${id} is ${job.status} — call rerunJob first`,
          };
        }
        if (get().activeJobId !== null)
          return { ok: false, reason: "Another sweep job is already running" };
        const canonical = useStore.getState();
        if (canonical.running || canonical.preparingOperation !== null) {
          return { ok: false, reason: "A manual run/preparation is active" };
        }

        const generation = ++runtime.generation;
        runtime.active = {
          jobId: id,
          generation,
          client: null,
          collectors: new Map(),
        };
        patchJob(id, (j) => ({
          ...j,
          status: "running",
          startedAt: now(),
          finishedAt: undefined,
          durationMs: undefined,
          error: undefined,
        }));
        set({
          activeJobId: id,
          activeVariantIndex: null,
          activeProgress: null,
        });

        return { ok: true, finished: executeJob(id, generation) };
      },

      cancelJob: (id) => {
        const job = getJob(id);
        if (!job || job.status !== "running")
          return { ok: false, reason: `Sweep job ${id} is not running` };
        // Invalidate every in-flight callback/continuation BEFORE touching
        // the worker, so no late settle can flip cancelled back to done.
        runtime.generation++;
        const active = runtime.active;
        runtime.active = null;
        // Finalize the in-flight variant's live diary as a partial cancelled
        // diary (first-finalize-wins; a pending variant never started and
        // gets no diary).  Concurrency 1 ⇒ at most one 'running' variant.
        const runningIndex = job.variants.find(
          (v) => v.status === "running",
        )?.index;
        const cancelledDiary =
          runningIndex !== undefined
            ? active?.collectors.get(runningIndex)?.finalizeCancelled()
            : undefined;
        patchJob(id, (j) =>
          finalizeCancelled(
            j,
            runningIndex !== undefined && cancelledDiary
              ? { index: runningIndex, diary: cancelledDiary }
              : undefined,
          ),
        );
        clearActive();
        try {
          active?.client?.cancel();
        } catch {
          // A misbehaving client must not undo the cancelled state.
        }
        return { ok: true };
      },

      rerunJob: (id, opts) => {
        const job = getJob(id);
        if (!job) return { ok: false, reason: `Unknown sweep job ${id}` };
        if (job.status === "running")
          return {
            ok: false,
            reason: "Cancel the running job before rerunning",
          };
        const scope = opts?.scope ?? "incomplete";
        patchJob(id, (j) => {
          const variants = j.variants.map((v): SweepVariantRecord => {
            if (scope === "incomplete" && v.status === "completed") return v;
            return {
              index: v.index,
              value: v.value,
              ...(v.valueLabel !== undefined
                ? { valueLabel: v.valueLabel }
                : {}),
              configHash: v.configHash,
              status: "pending",
            };
          });
          const { completed, total } = variantCounts(variants);
          return {
            ...j,
            variants,
            status: "pending",
            startedAt: undefined,
            finishedAt: undefined,
            durationMs: undefined,
            error: undefined,
            result: undefined,
            summary: undefined,
            progress: { completed, total },
          };
        });
        return { ok: true };
      },

      discardJob: (id) => {
        const job = getJob(id);
        if (!job) return { ok: false, reason: `Unknown sweep job ${id}` };
        if (job.status === "running" || get().activeJobId === id) {
          return {
            ok: false,
            reason: "Cancel the running job before discarding it",
          };
        }
        set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
        return { ok: true };
      },

      promoteVariant: (jobId, index) => {
        const job = getJob(jobId);
        if (!job) return { ok: false, reason: `Unknown sweep job ${jobId}` };
        const record = job.variants.find((v) => v.index === index);
        if (!record)
          return { ok: false, reason: `Job ${jobId} has no variant ${index}` };
        if (record.status !== "completed" || !record.result) {
          return {
            ok: false,
            reason: `Variant ${index} has no completed result to promote`,
          };
        }
        // Re-materialize the variant's immutable config from the frozen
        // base snapshot; sweepSolveUnits hash-verifies it against the
        // creation-time record.
        let unit: SolveUnit;
        try {
          unit = sweepSolveUnits(job).find((u) => u.index === index)!;
        } catch (err) {
          return {
            ok: false,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
        // Promote graduates an interesting sweep point into a first-class,
        // SAVED simulation variant: the swept field becomes the variant's
        // patch, and the run is filed under it. That is what makes a sweep
        // result survive the session and become comparable like any other
        // variant.
        const label = `${job.targetLabel} = ${record.valueLabel ?? record.value}`;
        const canonical = useStore.getState();
        const variantId = canonical.createVariantFrom(label, unit.config);
        useStore.getState().pushRunRecord({
          result: record.result,
          config: unit.config,
          ...(record.diary ? { diary: record.diary } : {}),
        });
        // pushRunRecord selects the new record; selectRun additionally
        // displays its result and recomputes staleness.
        const pushed = useStore.getState().runHistory.at(-1)!;
        useStore.getState().selectRun(pushed.id);
        useStore.getState().renameRun(pushed.id, label);
        void variantId;
        return { ok: true, record: useStore.getState().runHistory.at(-1)! };
      },

      getJob,
      isRunning: () => get().activeJobId !== null,
      isStale: (id) => {
        const job = getJob(id);
        if (!job) return null;
        return job.baseConfigHash !== configHash(useStore.getState().config);
      },
    };
  });
}

/** App-wide singleton sweep store. */
export const useSweepStore = createSweepStore();
