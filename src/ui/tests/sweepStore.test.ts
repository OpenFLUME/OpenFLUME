/**
 * sweepStore.test.ts — lifecycle tests for the session-only sweep job store
 * (src/ui/sweep/store.ts) and the sequential runner (src/ui/sweep/runner.ts),
 * using an injected fake SolverWorkerClient factory.
 *
 * Canonical-model isolation is verified against the real zustand store
 * (same pattern as storeActions.test.ts).
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { NetworkConfig, SteadyResult } from "../../core";
import { useStore } from "../store";
import { configHash } from "../provenance";
import type {
  ProgressPayload,
  RunCallbacks,
  SolverWorkerClient,
} from "../workerClient";
import type { RangeSweepDefinition, SolveJob, SolveResult } from "../sweep";
import { createSweepStore, type StartJobResult } from "../sweep/store";
import { DIARY_VERSION } from "../convergenceDiary";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** Minimal valid steady network (passes validateNetwork). */
function baseConfig(): NetworkConfig {
  return {
    meta: { name: "SweepStore", version: 2 },
    settings: { mode: "steady", tolerance: 1e-8, maxIterations: 200 },
    fluid: { model: "incompressible", preset: "water" },
    nodes: [
      {
        id: "in",
        type: "boundary",
        x: 0,
        y: 0,
        pressure: 2e5,
        temperature: 300,
      },
      {
        id: "out",
        type: "boundary",
        x: 100,
        y: 0,
        pressure: 1e5,
        temperature: 300,
      },
    ],
    branches: [
      {
        id: "b1",
        from: "in",
        to: "out",
        component: { type: "valve", area: 1e-4, cd: 0.6, position: 0.5 },
      },
    ],
  };
}

const steadyAt = (p: number): SteadyResult => ({
  converged: true,
  iterations: 5,
  residual: 1e-9,
  nodes: {
    in: { pressure: p, temperature: 300, density: 1000 },
    out: { pressure: 1e5, temperature: 300, density: 1000 },
  },
  branches: { b1: { mdot: 0.5, velocity: 1, dP: 1000, reynolds: 9000 } },
});

const sweep3 = (): RangeSweepDefinition => ({
  target: { kind: "branch", id: "b1", field: "position" },
  start: 0.1,
  end: 0.9,
  count: 3,
  spacing: "linear",
});

/** Await the whole-job promise of a successful startJob. */
async function finished(started: StartJobResult): Promise<SolveJob> {
  if (!started.ok) throw new Error(`startJob refused: ${started.reason}`);
  return started.finished;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/* ------------------------------------------------------------------ */
/* Fake SolverWorkerClient                                             */
/* ------------------------------------------------------------------ */

type FakeBehavior =
  | { kind: "resolve"; result: SolveResult }
  | { kind: "reject"; message: string }
  /** Test settles the run by hand via the recorded FakeRun. */
  | { kind: "manual" }
  /** cancel() does NOT settle — the test resolves AFTER cancelling, to
   *  prove a late completion can never flip cancelled back to done. */
  | { kind: "lateResolve"; result: SolveResult };

interface FakeRun {
  config: NetworkConfig;
  mode: "steady" | "transient";
  callbacks: RunCallbacks;
  settled: boolean;
  resolve: (r: SolveResult) => void;
  reject: (e: Error) => void;
}

class FakeClient implements SolverWorkerClient {
  runs: FakeRun[] = [];
  cancelCalls = 0;
  private _running = false;

  constructor(private readonly behavior: FakeBehavior) {}

  isRunning() {
    return this._running;
  }

  run(
    config: NetworkConfig,
    mode: "steady" | "transient",
    callbacks: RunCallbacks,
  ): Promise<SolveResult> {
    if (this._running)
      return Promise.reject(new Error("A simulation is already running"));
    this._running = true;
    const behavior = this.behavior;
    return new Promise<SolveResult>((resolvePromise, rejectPromise) => {
      const rec: FakeRun = {
        config,
        mode,
        callbacks,
        settled: false,
        resolve: (r) => {
          if (rec.settled) return;
          rec.settled = true;
          this._running = false;
          resolvePromise(r);
        },
        reject: (e) => {
          if (rec.settled) return;
          rec.settled = true;
          this._running = false;
          rejectPromise(e);
        },
      };
      this.runs.push(rec);
      // Auto-settling behaviors resolve on a microtask, so startJob always
      // returns before any variant settles (as with the real worker).
      if (behavior.kind === "resolve")
        queueMicrotask(() => rec.resolve(behavior.result));
      if (behavior.kind === "reject")
        queueMicrotask(() => rec.reject(new Error(behavior.message)));
    });
  }

  cancel() {
    this.cancelCalls++;
    // Mimic the real client: cancel terminates the in-flight run, which
    // rejects its promise with 'Cancelled' — except in the lateResolve
    // scenario where the (misbehaving) client resolves afterwards anyway.
    if (this.behavior.kind !== "lateResolve") {
      const active = this.runs.find((r) => !r.settled);
      active?.reject(new Error("Cancelled"));
    }
    this._running = false;
  }
}

interface FakeFactory {
  createClient: () => SolverWorkerClient;
  clients: FakeClient[];
  /** Concurrency proof: highest number of simultaneously unsettled runs. */
  maxConcurrent: number;
}

function makeFactory(behaviors: FakeBehavior[]): FakeFactory {
  const clients: FakeClient[] = [];
  let i = 0;
  let active = 0;
  let maxConcurrent = 0;
  return {
    clients,
    get maxConcurrent() {
      return maxConcurrent;
    },
    createClient: () => {
      const behavior = behaviors[Math.min(i++, behaviors.length - 1)];
      const client = new FakeClient(behavior);
      const origRun = client.run.bind(client);
      client.run = (config, mode, callbacks) => {
        active++;
        maxConcurrent = Math.max(maxConcurrent, active);
        return origRun(config, mode, callbacks).finally(() => {
          active--;
        });
      };
      clients.push(client);
      return client;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Store setup                                                         */
/* ------------------------------------------------------------------ */

function resetCanonicalStore() {
  useStore.setState({
    config: baseConfig(),
    selection: { kind: "none" },
    result: null,
    resultConfig: null,
    resultDiary: null,
    runHistory: [],
    runSeq: 0,
    selectedRunId: null,
    baselineRunId: null,
    past: [],
    future: [],
    dirty: false,
    resultStale: false,
    preparingOperation: null,
    running: false,
    runStatus: "idle",
  });
}

/** Feed steady progress payloads into a fake run's recorded callbacks. */
function feedProgress(run: FakeRun, residuals: number[]) {
  residuals.forEach((residual, i) => {
    run.callbacks.onProgress?.({ kind: "steady", iteration: i + 1, residual });
  });
}

function makeStore(factory: FakeFactory, now?: () => number) {
  return createSweepStore({
    createClient: factory.createClient,
    ...(now ? { now } : {}),
  });
}

beforeEach(resetCanonicalStore);

/* ------------------------------------------------------------------ */
/* Creation / immutable snapshots                                      */
/* ------------------------------------------------------------------ */

describe("createJob", () => {
  it("creates a pending job with a frozen base snapshot and materialized variant records", () => {
    const store = makeStore(makeFactory([]));
    const job = store.getState().createJob(sweep3(), { id: "j1", now: 1000 });

    expect(job.status).toBe("pending");
    expect(job.kind).toBe("parameterSweep");
    expect(job.createdAt).toBe(1000);
    expect(job.progress).toEqual({ completed: 0, total: 3 });
    expect(job.variants.map((v) => v.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(job.variants.map((v) => v.value)).toEqual([0.1, 0.5, 0.9]);

    // Frozen immutable base snapshot + matching hash.
    expect(Object.isFrozen(job.baseConfig)).toBe(true);
    expect(job.baseConfigHash).toBe(configHash(useStore.getState().config));
    // The canonical config itself is neither frozen nor mutated.
    const canonical = useStore.getState().config;
    expect(Object.isFrozen(canonical)).toBe(false);
    expect(canonical.branches[0].component).toMatchObject({ position: 0.5 });

    expect(store.getState().jobs).toHaveLength(1);
    expect(store.getState().getJob("j1")?.id).toBe("j1");
  });

  it("throws on a structurally invalid definition and stores nothing", () => {
    const store = makeStore(makeFactory([]));
    expect(() =>
      store.getState().createJob({ ...sweep3(), count: 0 }, { id: "bad" }),
    ).toThrow(/count/);
    expect(store.getState().jobs).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* Sequential execution                                                */
/* ------------------------------------------------------------------ */

describe("startJob execution", () => {
  it("runs variants strictly sequentially (concurrency 1) with one client per solve", async () => {
    const order: string[] = [];
    const factory = makeFactory([
      { kind: "resolve", result: steadyAt(190e3) },
      { kind: "resolve", result: steadyAt(160e3) },
      { kind: "resolve", result: steadyAt(130e3) },
    ]);
    const store = makeStore(factory, () => 1000);
    store.getState().createJob(sweep3(), { id: "j1" });

    // Track per-variant status transitions through store subscriptions.
    // NOTE: read jobs from the raw states — the getJob ACTION always sees
    // the latest state, so it cannot diff current vs previous.
    store.subscribe((s, prev) => {
      const a = s.jobs.find((j) => j.id === "j1");
      const b = prev.jobs.find((j) => j.id === "j1");
      if (!a || !b) return;
      for (const v of a.variants) {
        const before = b.variants[v.index]?.status;
        if (before !== v.status) order.push(`v${v.index}:${v.status}`);
      }
    });

    const job = await finished(store.getState().startJob("j1"));

    expect(job.status).toBe("completed");
    expect(factory.clients).toHaveLength(3); // one client (worker) per solve
    expect(factory.maxConcurrent).toBe(1);
    // Strictly ordered lifecycle: each variant starts only after the prior completed.
    expect(order).toEqual([
      "v0:running",
      "v0:completed",
      "v1:running",
      "v1:completed",
      "v2:running",
      "v2:completed",
    ]);
    // Each solve received that variant's own config hash and mode.
    for (const c of factory.clients) {
      expect(c.runs).toHaveLength(1);
      expect(c.runs[0].mode).toBe("steady");
    }
    expect(factory.clients.map((c) => configHash(c.runs[0].config))).toEqual(
      job.variants.map((v) => v.configHash),
    );
    // Job-level rollup.
    expect(job.progress).toEqual({ completed: 3, total: 3 });
    expect(job.result).toEqual({
      total: 3,
      completed: 3,
      failed: 0,
      converged: 3,
    });
    expect(job.summary).toBe("3/3 completed · 3 converged");
    // Deterministic injected clock.
    expect(job.startedAt).toBe(1000);
    expect(job.finishedAt).toBe(1000);
    expect(job.durationMs).toBe(0);
    for (const v of job.variants) {
      expect(v.status).toBe("completed");
      expect(v.summary?.converged).toBe(true);
      expect(v.result).toBeDefined();
      expect(v.startedAt).toBe(1000);
      expect(v.durationMs).toBe(0);
    }
    // Store-level active pointers cleared.
    const s = store.getState();
    expect(s.activeJobId).toBeNull();
    expect(s.activeVariantIndex).toBeNull();
    expect(s.isRunning()).toBe(false);
  });

  it("exposes per-variant progress and status while running", async () => {
    const factory = makeFactory([
      { kind: "manual" },
      { kind: "resolve", result: steadyAt(150e3) },
    ]);
    const store = makeStore(factory);
    store.getState().createJob({ ...sweep3(), count: 2 }, { id: "j1" });

    const started = store.getState().startJob("j1");
    expect(started.ok).toBe(true);
    await flush();

    expect(store.getState().activeJobId).toBe("j1");
    expect(store.getState().activeVariantIndex).toBe(0);
    expect(store.getState().getJob("j1")?.variants[0].status).toBe("running");
    expect(store.getState().getJob("j1")?.variants[1].status).toBe("pending");
    expect(store.getState().isRunning()).toBe(true);

    const progress: ProgressPayload = {
      kind: "steady",
      iteration: 3,
      residual: 1e-7,
    };
    factory.clients[0].runs[0].callbacks.onProgress?.(progress);
    expect(store.getState().activeProgress).toEqual(progress);

    factory.clients[0].runs[0].resolve(steadyAt(180e3));
    const job = await finished(started);
    expect(job.status).toBe("completed");
    expect(store.getState().activeProgress).toBeNull();
    expect(store.getState().getJob("j1")?.progress).toEqual({
      completed: 2,
      total: 2,
    });
  });

  it("records a variant failure and continues with later variants", async () => {
    const factory = makeFactory([
      { kind: "resolve", result: steadyAt(190e3) },
      { kind: "reject", message: "solver exploded" },
      { kind: "resolve", result: steadyAt(130e3) },
    ]);
    const store = makeStore(factory);
    store.getState().createJob(sweep3(), { id: "j1" });

    const job = await finished(store.getState().startJob("j1"));

    expect(job.status).toBe("failed");
    expect(job.error).toBe("1 of 3 variants failed");
    expect(job.variants.map((v) => v.status)).toEqual([
      "completed",
      "failed",
      "completed",
    ]);
    expect(job.variants[1].error).toBe("solver exploded");
    expect(job.variants[1].result).toBeUndefined();
    expect(job.result).toEqual({
      total: 3,
      completed: 2,
      failed: 1,
      converged: 2,
    });
    expect(job.summary).toBe("2/3 completed · 1 failed · 2 converged");
    expect(job.progress).toEqual({ completed: 2, total: 3 });
    expect(factory.clients).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ */
/* Convergence diaries                                                 */
/* ------------------------------------------------------------------ */

describe("variant convergence diaries", () => {
  it("completed variants get a live-progress diary tied to the variant config", async () => {
    const factory = makeFactory([
      { kind: "manual" },
      { kind: "resolve", result: steadyAt(160e3) },
      { kind: "resolve", result: steadyAt(130e3) },
    ]);
    const store = makeStore(factory);
    store.getState().createJob(sweep3(), { id: "j1" });

    const started = store.getState().startJob("j1");
    await flush();
    // Live progress for variant 0: a residual-decade crossing is observable.
    feedProgress(factory.clients[0].runs[0], [1e-2, 1e-5]);
    factory.clients[0].runs[0].resolve(steadyAt(190e3));

    const job = await finished(started);
    expect(job.status).toBe("completed");
    const [v0, v1, v2] = job.variants;
    for (const v of job.variants) {
      expect(v.diary).toBeDefined();
      expect(v.diary!.version).toBe(DIARY_VERSION);
      expect(v.diary!.mode).toBe("steady");
      expect(v.diary!.summary.outcome).toBe("converged");
      expect(v.diary!.summary.partial).toBeUndefined();
      // Provenance matches the variant record's config hash label.
      expect(v.diary!.provenance.configHash).toBe(v.configHash);
      expect(v.diary!.events[0].kind).toBe("runStart");
      expect(v.diary!.events.at(-1)!.kind).toBe("runFinish");
    }
    // Variant 0 saw live progress (milestone consumed); auto-settled
    // variants 1/2 saw none — honest accounting, nothing fabricated.
    expect(v0.diary!.summary.progressUpdates).toBe(2);
    expect(v0.diary!.events.some((e) => e.kind === "residualDecade")).toBe(
      true,
    );
    expect(v1.diary!.summary.progressUpdates).toBe(0);
    expect(v2.diary!.summary.progressUpdates).toBe(0);
    expect(v1.diary!.events.some((e) => e.kind === "finalEvidenceOnly")).toBe(
      false,
    );
  });

  it("a failed variant gets a partial error diary carrying the sanitized message", async () => {
    const factory = makeFactory([
      { kind: "manual" },
      { kind: "resolve", result: steadyAt(160e3) },
    ]);
    const store = makeStore(factory);
    store.getState().createJob({ ...sweep3(), count: 2 }, { id: "j1" });

    const started = store.getState().startJob("j1");
    await flush();
    feedProgress(factory.clients[0].runs[0], [1e-2, 1e-3]);
    factory.clients[0].runs[0].reject(new Error("solver exploded\nat row 7"));

    const job = await finished(started);
    const v0 = job.variants[0];
    expect(v0.status).toBe("failed");
    expect(v0.diary).toBeDefined();
    expect(v0.diary!.summary.outcome).toBe("error");
    expect(v0.diary!.summary.partial).toBe(true);
    expect(v0.diary!.summary.progressUpdates).toBe(2);
    const finish = v0.diary!.events.at(-1)!;
    expect(finish.kind).toBe("runFinish");
    expect(finish.severity).toBe("warning");
    expect(finish.message).toContain("solver exploded at row 7");
    expect(finish.message).not.toMatch(/\n/);
    // Evidence ends at the last progress coordinate.
    expect(finish.at).toEqual({ kind: "steady", iteration: 2 });
    // Variant 1's own diary is the normal completed one (failure is isolated).
    expect(job.variants[1].diary!.summary.outcome).toBe("converged");
  });

  it("cancel mid-flight: the running variant gets a partial cancelled diary; pending variants get none", async () => {
    const factory = makeFactory([
      { kind: "resolve", result: steadyAt(190e3) },
      { kind: "manual" },
    ]);
    const store = makeStore(factory);
    store.getState().createJob(sweep3(), { id: "j1" });

    const started = store.getState().startJob("j1");
    await flush(); // variant 0 completed, variant 1 in-flight
    feedProgress(factory.clients[1].runs[0], [1e-2, 1e-3, 1e-4]);

    store.getState().cancelJob("j1");
    const job = store.getState().getJob("j1")!;
    expect(job.variants.map((v) => v.status)).toEqual([
      "completed",
      "cancelled",
      "cancelled",
    ]);

    // Completed variant keeps its result diary.
    expect(job.variants[0].diary!.summary.outcome).toBe("converged");
    // The in-flight variant's diary is partial-cancelled at the last progress.
    const d1 = job.variants[1].diary!;
    expect(d1.summary.outcome).toBe("cancelled");
    expect(d1.summary.partial).toBe(true);
    expect(d1.summary.progressUpdates).toBe(3);
    expect(d1.events.at(-1)!.at).toEqual({ kind: "steady", iteration: 3 });
    // Pending variant never started: no evidence, no diary.
    expect(job.variants[2].diary).toBeUndefined();

    const done = await finished(started);
    expect(done.status).toBe("cancelled");
  });

  it("late callbacks after cancel are ignored: the cancelled diary never flips", async () => {
    const factory = makeFactory([
      { kind: "lateResolve", result: steadyAt(190e3) },
    ]);
    const store = makeStore(factory);
    store.getState().createJob({ ...sweep3(), count: 1 }, { id: "j1" });

    const started = store.getState().startJob("j1");
    await flush();
    feedProgress(factory.clients[0].runs[0], [1e-2]);
    store.getState().cancelJob("j1");

    const cancelledDiary = store.getState().getJob("j1")!.variants[0].diary;
    expect(cancelledDiary!.summary.outcome).toBe("cancelled");

    // Late progress AND a late completion from the misbehaving client.
    factory.clients[0].runs[0].callbacks.onProgress?.({
      kind: "steady",
      iteration: 99,
      residual: 1e-12,
    });
    factory.clients[0].runs[0].resolve(steadyAt(190e3));
    const job = await finished(started);
    await flush();

    const v = job.variants[0];
    expect(v.status).toBe("cancelled");
    expect(v.diary).toBe(cancelledDiary); // reference-identical: never touched
    expect(v.diary!.summary.progressUpdates).toBe(1); // late progress not consumed
    expect(v.diary!.summary.outcome).toBe("cancelled");
  });

  it("rerun resets diaries for reset variants and retains completed ones", async () => {
    const factory = makeFactory([
      { kind: "resolve", result: steadyAt(190e3) },
      { kind: "reject", message: "boom" },
      { kind: "resolve", result: steadyAt(130e3) },
      { kind: "resolve", result: steadyAt(160e3) },
    ]);
    const store = makeStore(factory);
    store.getState().createJob(sweep3(), { id: "j1" });
    await finished(store.getState().startJob("j1"));

    const before = store.getState().getJob("j1")!;
    const retainedDiary0 = before.variants[0].diary;
    const retainedDiary2 = before.variants[2].diary;
    expect(retainedDiary0).toBeDefined();
    expect(retainedDiary2).toBeDefined();
    expect(before.variants[1].diary!.summary.outcome).toBe("error");

    expect(store.getState().rerunJob("j1")).toEqual({ ok: true });
    const reset = store.getState().getJob("j1")!;
    expect(reset.variants[0].diary).toBe(retainedDiary0); // retained, untouched
    expect(reset.variants[2].diary).toBe(retainedDiary2);
    expect(reset.variants[1].diary).toBeUndefined(); // cleared with the reset

    // Rerunning re-solves only the reset variant and attaches a FRESH diary.
    const done = await finished(store.getState().startJob("j1"));
    expect(done.variants[1].status).toBe("completed");
    expect(done.variants[1].diary).toBeDefined();
    expect(done.variants[1].diary!.summary.outcome).toBe("converged");
    expect(done.variants[0].diary).toBe(retainedDiary0); // still the original
  });

  it("rerun scope 'all' clears every diary", async () => {
    const factory = makeFactory([
      { kind: "resolve", result: steadyAt(190e3) },
      { kind: "resolve", result: steadyAt(160e3) },
    ]);
    const store = makeStore(factory);
    store.getState().createJob({ ...sweep3(), count: 2 }, { id: "j1" });
    await finished(store.getState().startJob("j1"));
    expect(
      store
        .getState()
        .getJob("j1")!
        .variants.every((v) => v.diary !== undefined),
    ).toBe(true);

    store.getState().rerunJob("j1", { scope: "all" });
    expect(
      store
        .getState()
        .getJob("j1")!
        .variants.every((v) => v.diary === undefined),
    ).toBe(true);
  });

  it("promoteVariant threads the exact variant diary into the run record and current diary", async () => {
    const factory = makeFactory([
      { kind: "manual" },
      { kind: "resolve", result: steadyAt(160e3) },
    ]);
    const store = makeStore(factory);
    store.getState().createJob({ ...sweep3(), count: 2 }, { id: "j1" });

    const started = store.getState().startJob("j1");
    await flush();
    feedProgress(factory.clients[0].runs[0], [1e-2, 1e-6]);
    factory.clients[0].runs[0].resolve(steadyAt(190e3));
    await finished(started);

    const variantDiary = store.getState().getJob("j1")!.variants[0].diary!;
    expect(variantDiary.summary.progressUpdates).toBe(2);

    const promoted = store.getState().promoteVariant("j1", 0);
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;

    // The record carries the variant diary's exact content (intake-cloned by
    // pushRunRecord — mutating the variant record afterwards cannot alias).
    expect(promoted.record.diary).toBeDefined();
    expect(promoted.record.diary).not.toBe(variantDiary);
    expect(JSON.stringify(promoted.record.diary)).toBe(
      JSON.stringify(variantDiary),
    );
    // And it is the current displayed diary (pushRunRecord + selectRun).
    expect(useStore.getState().resultDiary).toBe(promoted.record.diary);

    // Alias guard: tampering with the sweep-side diary leaves the record's intact.
    variantDiary.summary.outcome = "error";
    expect(promoted.record.diary!.summary.outcome).toBe("converged");
    expect(useStore.getState().resultDiary!.summary.outcome).toBe("converged");
  });
});

/* ------------------------------------------------------------------ */
/* Cancellation                                                        */
/* ------------------------------------------------------------------ */

describe("cancelJob", () => {
  it("cancels during a variant: terminates the client, marks active+pending cancelled, retains completed", async () => {
    const factory = makeFactory([
      { kind: "resolve", result: steadyAt(190e3) },
      { kind: "manual" },
    ]);
    const store = makeStore(factory);
    store.getState().createJob(sweep3(), { id: "j1" });

    const started = store.getState().startJob("j1");
    await flush(); // variant 0 settled, variant 1 in-flight (manual)
    expect(store.getState().getJob("j1")?.variants[0].status).toBe("completed");
    expect(store.getState().activeVariantIndex).toBe(1);

    expect(store.getState().cancelJob("j1")).toEqual({ ok: true });
    const job = store.getState().getJob("j1")!;
    expect(job.status).toBe("cancelled");
    expect(job.variants.map((v) => v.status)).toEqual([
      "completed",
      "cancelled",
      "cancelled",
    ]);
    expect(job.variants[0].result).toBeDefined(); // completed results retained
    expect(job.finishedAt).toBeTypeOf("number");
    expect(factory.clients[1].cancelCalls).toBe(1); // active worker terminated
    expect(store.getState().activeJobId).toBeNull();

    const done = await finished(started);
    expect(done.status).toBe("cancelled");
  });

  it("cancels between variants: completed variant kept, remaining cancelled, no further solves", async () => {
    const factory = makeFactory([
      { kind: "resolve", result: steadyAt(190e3) },
      { kind: "resolve", result: steadyAt(160e3) },
      { kind: "resolve", result: steadyAt(130e3) },
    ]);
    const store = makeStore(factory);
    store.getState().createJob(sweep3(), { id: "j1" });

    // Cancel the moment variant 0 lands 'completed' — before variant 1 starts.
    const unsub = store.subscribe((s) => {
      const job = s.getJob("j1");
      if (job?.status === "running" && job.variants[0].status === "completed") {
        unsub();
        s.cancelJob("j1");
      }
    });

    const job = await finished(store.getState().startJob("j1"));

    expect(job.status).toBe("cancelled");
    expect(job.variants.map((v) => v.status)).toEqual([
      "completed",
      "cancelled",
      "cancelled",
    ]);
    expect(job.variants[0].summary).toBeDefined();
    expect(factory.clients).toHaveLength(1); // variant 1 never started
  });

  it("race: a late completion after cancel can never flip the job back to done", async () => {
    const factory = makeFactory([
      { kind: "lateResolve", result: steadyAt(190e3) },
    ]);
    const store = makeStore(factory);
    store.getState().createJob({ ...sweep3(), count: 1 }, { id: "j1" });

    const started = store.getState().startJob("j1");
    await flush();
    expect(store.getState().getJob("j1")?.variants[0].status).toBe("running");

    store.getState().cancelJob("j1");
    expect(store.getState().getJob("j1")?.status).toBe("cancelled");

    // The misbehaving client resolves AFTER the cancel settled.
    factory.clients[0].runs[0].resolve(steadyAt(190e3));
    const job = await finished(started);
    await flush();

    expect(job.status).toBe("cancelled");
    expect(job.variants[0].status).toBe("cancelled");
    expect(job.variants[0].result).toBeUndefined();
    expect(store.getState().getJob("j1")?.status).toBe("cancelled");
  });

  it("is a no-op result for jobs that are not running", () => {
    const store = makeStore(makeFactory([]));
    store.getState().createJob(sweep3(), { id: "j1" });
    expect(store.getState().cancelJob("j1").ok).toBe(false);
    expect(store.getState().cancelJob("ghost").ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Rerun policy                                                        */
/* ------------------------------------------------------------------ */

describe("rerunJob", () => {
  it("scope 'incomplete' (default) keeps completed variants and resets failed/cancelled", async () => {
    const factory = makeFactory([
      { kind: "resolve", result: steadyAt(190e3) },
      { kind: "reject", message: "boom" },
      { kind: "resolve", result: steadyAt(130e3) },
      { kind: "resolve", result: steadyAt(160e3) },
    ]);
    const store = makeStore(factory);
    store.getState().createJob(sweep3(), { id: "j1" });
    await finished(store.getState().startJob("j1"));

    expect(store.getState().rerunJob("j1")).toEqual({ ok: true });
    const job = store.getState().getJob("j1")!;
    expect(job.status).toBe("pending");
    expect(job.variants.map((v) => v.status)).toEqual([
      "completed",
      "pending",
      "completed",
    ]);
    expect(job.variants[0].result).toBeDefined(); // retained
    expect(job.variants[1].result).toBeUndefined(); // cleared
    expect(job.variants[1].error).toBeUndefined();
    expect(job.progress).toEqual({ completed: 2, total: 3 });
    expect(job.startedAt).toBeUndefined();
    expect(job.finishedAt).toBeUndefined();
    expect(job.result).toBeUndefined();
    expect(job.summary).toBeUndefined();

    // Rerun solves ONLY the reset variant, reusing the frozen config.
    const done = await finished(store.getState().startJob("j1"));
    expect(factory.clients).toHaveLength(4); // exactly one new solve
    expect(configHash(factory.clients[3].runs[0].config)).toBe(
      done.variants[1].configHash,
    );
    expect(done.status).toBe("completed");
    expect(done.result).toEqual({
      total: 3,
      completed: 3,
      failed: 0,
      converged: 3,
    });
  });

  it("scope 'all' resets every variant", async () => {
    const factory = makeFactory([
      { kind: "resolve", result: steadyAt(190e3) },
      { kind: "resolve", result: steadyAt(160e3) },
      { kind: "resolve", result: steadyAt(130e3) },
    ]);
    const store = makeStore(factory);
    store.getState().createJob(sweep3(), { id: "j1" });
    await finished(store.getState().startJob("j1"));

    expect(store.getState().rerunJob("j1", { scope: "all" })).toEqual({
      ok: true,
    });
    const job = store.getState().getJob("j1")!;
    expect(job.variants.map((v) => v.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(job.variants.every((v) => v.result === undefined)).toBe(true);
    expect(job.progress).toEqual({ completed: 0, total: 3 });

    await finished(store.getState().startJob("j1"));
    expect(factory.clients).toHaveLength(6); // all three re-solved
  });

  it("is refused while the job is running", async () => {
    const factory = makeFactory([{ kind: "manual" }]);
    const store = makeStore(factory);
    store.getState().createJob({ ...sweep3(), count: 1 }, { id: "j1" });
    store.getState().startJob("j1");
    await flush();
    expect(store.getState().rerunJob("j1").ok).toBe(false);
    store.getState().cancelJob("j1");
  });
});

/* ------------------------------------------------------------------ */
/* Discard                                                             */
/* ------------------------------------------------------------------ */

describe("discardJob", () => {
  it("removes a pending job; the discarded job can no longer start", () => {
    const store = makeStore(makeFactory([]));
    store.getState().createJob(sweep3(), { id: "j1" });
    expect(store.getState().discardJob("j1")).toEqual({ ok: true });
    expect(store.getState().jobs).toHaveLength(0);
    expect(store.getState().getJob("j1")).toBeUndefined();
    expect(store.getState().startJob("j1").ok).toBe(false);
  });

  it("refuses unknown ids and running jobs; allows terminal jobs", async () => {
    const factory = makeFactory([{ kind: "manual" }]);
    const store = makeStore(factory);
    store.getState().createJob({ ...sweep3(), count: 1 }, { id: "j1" });
    expect(store.getState().discardJob("ghost").ok).toBe(false);

    store.getState().startJob("j1");
    await flush();
    expect(store.getState().discardJob("j1").ok).toBe(false);
    store.getState().cancelJob("j1");

    expect(store.getState().discardJob("j1")).toEqual({ ok: true });
    expect(store.getState().jobs).toHaveLength(0);
  });

  it("never touches the canonical store", async () => {
    const before = useStore.getState();
    const store = makeStore(
      makeFactory([{ kind: "resolve", result: steadyAt(190e3) }]),
    );
    store.getState().createJob({ ...sweep3(), count: 1 }, { id: "j1" });
    await finished(store.getState().startJob("j1"));
    store.getState().discardJob("j1");
    const after = useStore.getState();
    expect(after.config).toBe(before.config);
    expect(after.modelText).toBe(before.modelText);
    expect(after.runHistory).toHaveLength(before.runHistory.length);
    expect(after.dirty).toBe(before.dirty);
  });
});

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

describe("start gates", () => {
  it("refuses to start while a manual run or preparation is active", () => {
    const store = makeStore(
      makeFactory([{ kind: "resolve", result: steadyAt(1) }]),
    );
    store.getState().createJob(sweep3(), { id: "j1" });

    useStore.setState({ running: true, runStatus: "running" });
    const refusedRunning = store.getState().startJob("j1");
    expect(refusedRunning.ok).toBe(false);
    if (!refusedRunning.ok)
      expect(refusedRunning.reason).toMatch(/manual run/i);
    useStore.setState({ running: false, runStatus: "idle" });

    expect(useStore.getState().beginPreparation("run")).toBe(true);
    const refusedPrep = store.getState().startJob("j1");
    expect(refusedPrep.ok).toBe(false);
    useStore.getState().endPreparation("run");

    expect(store.getState().startJob("j1").ok).toBe(true);
  });

  it("allows only one active sweep job and rejects starting the same job twice", async () => {
    const factory = makeFactory([
      { kind: "manual" },
      { kind: "resolve", result: steadyAt(1) },
    ]);
    const store = makeStore(factory);
    store.getState().createJob(sweep3(), { id: "j1" });
    store.getState().createJob(sweep3(), { id: "j2" });

    const first = store.getState().startJob("j1");
    expect(first.ok).toBe(true);
    await flush();

    const again = store.getState().startJob("j1");
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toMatch(/already running/);

    const second = store.getState().startJob("j2");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/another sweep job/i);
    expect(store.getState().isRunning()).toBe(true);

    store.getState().cancelJob("j1");
    expect(store.getState().isRunning()).toBe(false);
    expect(store.getState().startJob("j2").ok).toBe(true);
    await flush();
  });

  it("refuses to start a terminal job without rerunJob", async () => {
    const factory = makeFactory([{ kind: "resolve", result: steadyAt(1) }]);
    const store = makeStore(factory);
    store.getState().createJob({ ...sweep3(), count: 1 }, { id: "j1" });
    await finished(store.getState().startJob("j1"));

    const second = store.getState().startJob("j1");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/rerunJob/);
  });
});

/* ------------------------------------------------------------------ */
/* Canonical model isolation                                           */
/* ------------------------------------------------------------------ */

describe("canonical model isolation", () => {
  function canonicalSnapshot() {
    const s = useStore.getState();
    return {
      config: s.config,
      modelText: s.modelText,
      dirty: s.dirty,
      pastLen: s.past.length,
      futureLen: s.future.length,
      result: s.result,
      resultDiary: s.resultDiary,
      historyLen: s.runHistory.length,
      selectedRunId: s.selectedRunId,
    };
  }

  it("a completed sweep never touches the canonical model, text, history, or results", async () => {
    const before = canonicalSnapshot();
    const factory = makeFactory([
      { kind: "resolve", result: steadyAt(190e3) },
      { kind: "resolve", result: steadyAt(160e3) },
      { kind: "resolve", result: steadyAt(130e3) },
    ]);
    const store = makeStore(factory);
    store.getState().createJob(sweep3(), { id: "j1" });
    await finished(store.getState().startJob("j1"));

    const after = canonicalSnapshot();
    expect(after.config).toBe(before.config); // same reference, untouched
    expect(after.modelText).toBe(before.modelText);
    expect(after.dirty).toBe(before.dirty);
    expect(after.pastLen).toBe(before.pastLen);
    expect(after.futureLen).toBe(before.futureLen);
    expect(after.result).toBe(before.result);
    expect(after.resultDiary).toBe(before.resultDiary); // diaries live on variants, not here
    expect(after.historyLen).toBe(before.historyLen);
    expect(after.selectedRunId).toBe(before.selectedRunId);
    // Variant configs were only READ by the collectors: still frozen snapshots,
    // and the canonical config hash is unchanged.
    const job = store.getState().getJob("j1")!;
    expect(job.variants.every((v) => v.diary !== undefined)).toBe(true);
    expect(configHash(useStore.getState().config)).toBe(job.baseConfigHash);
  });

  it("a cancelled sweep never touches the canonical store either", async () => {
    const before = canonicalSnapshot();
    const factory = makeFactory([{ kind: "manual" }]);
    const store = makeStore(factory);
    store.getState().createJob({ ...sweep3(), count: 1 }, { id: "j1" });
    store.getState().startJob("j1");
    await flush();
    store.getState().cancelJob("j1");
    await flush();

    const after = canonicalSnapshot();
    expect(after.config).toBe(before.config);
    expect(after.modelText).toBe(before.modelText);
    expect(after.historyLen).toBe(before.historyLen);
    expect(after.result).toBe(before.result);
    expect(after.resultDiary).toBe(before.resultDiary);
    expect(after.dirty).toBe(before.dirty);
  });
});

/* ------------------------------------------------------------------ */
/* Staleness                                                           */
/* ------------------------------------------------------------------ */

describe("staleness", () => {
  it("flips when the canonical model is edited after job creation", () => {
    const store = makeStore(makeFactory([]));
    store.getState().createJob(sweep3(), { id: "j1" });
    expect(store.getState().isStale("j1")).toBe(false);
    useStore.getState().updateNode("in", { pressure: 150000 });
    expect(store.getState().isStale("j1")).toBe(true);
    expect(store.getState().isStale("ghost")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Promotion                                                           */
/* ------------------------------------------------------------------ */

describe("promoteVariant", () => {
  it("appends and selects exactly one RunRecord with the variant snapshot", async () => {
    const factory = makeFactory([
      { kind: "resolve", result: steadyAt(190e3) },
      { kind: "resolve", result: steadyAt(160e3) },
      { kind: "resolve", result: steadyAt(130e3) },
    ]);
    const store = makeStore(factory);
    store.getState().createJob(sweep3(), { id: "j1" });
    await finished(store.getState().startJob("j1"));

    const beforeHistory = useStore.getState().runHistory.length;
    const beforeConfig = useStore.getState().config;
    const beforeText = useStore.getState().modelText;

    // Promote variant 0 (position 0.1 ≠ the live config's 0.5, so the
    // promoted run is stale vs the editor).
    const promoted = store.getState().promoteVariant("j1", 0);
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;
    const record = promoted.record;

    // Exactly one record appended and selected.
    const s = useStore.getState();
    expect(s.runHistory).toHaveLength(beforeHistory + 1);
    expect(s.runHistory.at(-1)?.id).toBe(record.id);
    expect(s.selectedRunId).toBe(record.id);
    // The record carries the variant's immutable config + result.
    expect(record.configHash).toBe(
      store.getState().getJob("j1")!.variants[0].configHash,
    );
    expect(record.config.branches[0].component).toMatchObject({
      position: 0.1,
    });
    expect(record.config).not.toBe(beforeConfig);
    expect((record.result as SteadyResult).nodes["in"].pressure).toBe(190e3);
    expect(record.name).toBe("Valve b1 · position = 0.1");
    // The displayed result was selected and is stale vs the live config
    // (the variant config differs from the editor's).
    expect(s.result).toBe(record.result);
    expect(s.resultConfig).toBe(record.config);
    expect(s.resultStale).toBe(true);
    // Canonical model itself untouched.
    expect(s.config).toBe(beforeConfig);
    expect(s.modelText).toBe(beforeText);
    expect(s.dirty).toBe(false);
    expect(s.past).toHaveLength(0);
  });

  it("refuses variants without a completed result and unknown jobs/variants", async () => {
    const factory = makeFactory([{ kind: "reject", message: "nope" }]);
    const store = makeStore(factory);
    store.getState().createJob({ ...sweep3(), count: 1 }, { id: "j1" });
    await finished(store.getState().startJob("j1"));

    expect(store.getState().promoteVariant("j1", 0).ok).toBe(false);
    expect(store.getState().promoteVariant("j1", 7).ok).toBe(false);
    expect(store.getState().promoteVariant("ghost", 0).ok).toBe(false);
    expect(useStore.getState().runHistory).toHaveLength(0);
  });
});
