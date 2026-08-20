/**
 * workerClient.test.ts — lifecycle tests for createSolverWorkerClient with a
 * stubbed Worker global.
 *
 * Covers the idle-worker leak fix: the worker must be terminated and nulled
 * on done / error / onerror as well as on cancel, exactly one worker per
 * solve, callbacks preserved (manual-run behavior unchanged), and late
 * messages from a terminated/superseded worker ignored.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NetworkConfig, SteadyResult } from "../../core";
import { createSolverWorkerClient } from "../workerClient";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((err: { message?: string }) => void) | null = null;
  posted: unknown[] = [];
  terminateCalls = 0;

  constructor(
    public readonly url: unknown,
    public readonly options: unknown,
  ) {
    FakeWorker.instances.push(this);
  }

  postMessage(msg: unknown) {
    this.posted.push(msg);
  }

  terminate() {
    this.terminateCalls++;
  }

  /** Test helpers simulating worker → main-thread messages. */
  emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

const config: NetworkConfig = {
  meta: { name: "wc", version: 2 },
  settings: { mode: "steady", tolerance: 1e-8, maxIterations: 50 },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    { id: "a", type: "boundary", x: 0, y: 0, pressure: 2e5, temperature: 300 },
    {
      id: "b",
      type: "boundary",
      x: 100,
      y: 0,
      pressure: 1e5,
      temperature: 300,
    },
  ],
  branches: [
    {
      id: "o1",
      from: "a",
      to: "b",
      component: { type: "orifice", area: 1e-3, cd: 0.6 },
    },
  ],
};

const steady: SteadyResult = {
  converged: true,
  iterations: 4,
  residual: 1e-10,
  nodes: {
    a: { pressure: 2e5, temperature: 300, density: 1000 },
    b: { pressure: 1e5, temperature: 300, density: 1000 },
  },
  branches: { o1: { mdot: 0.4, velocity: 0.5, dP: 1e5, reynolds: 8000 } },
};

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSolverWorkerClient", () => {
  it("terminates and nulls the worker on done, keeping callbacks intact", async () => {
    const client = createSolverWorkerClient();
    const statuses: string[] = [];
    const done = vi.fn();
    const promise = client.run(config, "steady", {
      onStatusChange: (s) => statuses.push(s),
      onDone: done,
    });
    const worker = FakeWorker.instances[0];
    expect(worker.posted).toEqual([{ type: "run", config, mode: "steady" }]);
    expect(client.isRunning()).toBe(true);

    worker.emit({ type: "done", result: steady });
    await expect(promise).resolves.toBe(steady);

    expect(done).toHaveBeenCalledWith(steady);
    expect(statuses).toEqual(["running", "done"]);
    expect(worker.terminateCalls).toBe(1); // no idle worker left behind
    expect(client.isRunning()).toBe(false);
  });

  it("terminates the worker on an error message and rejects", async () => {
    const client = createSolverWorkerClient();
    const onError = vi.fn();
    const promise = client.run(config, "steady", { onError });
    const worker = FakeWorker.instances[0];

    worker.emit({ type: "error", message: "solver exploded" });
    await expect(promise).rejects.toThrow("solver exploded");

    expect(onError).toHaveBeenCalledWith("solver exploded");
    expect(worker.terminateCalls).toBe(1);
    expect(client.isRunning()).toBe(false);
  });

  it("terminates the worker on onerror (crash) and rejects", async () => {
    const client = createSolverWorkerClient();
    const onError = vi.fn();
    const promise = client.run(config, "steady", { onError });
    const worker = FakeWorker.instances[0];

    worker.onerror?.({ message: "uncaught in worker" });
    await expect(promise).rejects.toThrow("uncaught in worker");

    expect(onError).toHaveBeenCalledWith("uncaught in worker");
    expect(worker.terminateCalls).toBe(1);
    expect(client.isRunning()).toBe(false);
  });

  it("cancel terminates the worker and rejects with Cancelled", async () => {
    const client = createSolverWorkerClient();
    const statuses: string[] = [];
    const promise = client.run(config, "steady", {
      onStatusChange: (s) => statuses.push(s),
    });
    const worker = FakeWorker.instances[0];

    client.cancel();
    await expect(promise).rejects.toThrow("Cancelled");

    expect(worker.terminateCalls).toBe(1);
    expect(statuses).toEqual(["running", "cancelled"]);
    expect(client.isRunning()).toBe(false);
  });

  it("ignores late messages from a terminated (non-current) worker", async () => {
    const client = createSolverWorkerClient();
    const onDone = vi.fn();
    const statuses: string[] = [];
    const promise = client.run(config, "steady", {
      onDone,
      onStatusChange: (s) => statuses.push(s),
    });
    const worker = FakeWorker.instances[0];

    client.cancel();
    await expect(promise).rejects.toThrow("Cancelled");

    // A message queued just before terminate() must be inert.
    worker.emit({ type: "done", result: steady });
    expect(onDone).not.toHaveBeenCalled();
    expect(statuses).toEqual(["running", "cancelled"]);
  });

  it("spawns exactly one fresh worker per solve (one worker per run)", async () => {
    const client = createSolverWorkerClient();
    const first = client.run(config, "steady", {});
    FakeWorker.instances[0].emit({ type: "done", result: steady });
    await first;

    const second = client.run(config, "steady", {});
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[1]).not.toBe(FakeWorker.instances[0]);
    FakeWorker.instances[1].emit({ type: "done", result: steady });
    await second;
    expect(FakeWorker.instances.map((w) => w.terminateCalls)).toEqual([1, 1]);
  });

  it("still rejects a second concurrent run (unchanged manual behavior)", async () => {
    const client = createSolverWorkerClient();
    const first = client.run(config, "steady", {});
    await expect(client.run(config, "steady", {})).rejects.toThrow(
      "already running",
    );
    FakeWorker.instances[0].emit({ type: "done", result: steady });
    await first;
  });

  it("returns to idle when worker construction fails", async () => {
    class BrokenWorker {
      constructor() {
        throw new Error("worker unavailable");
      }
    }
    vi.stubGlobal("Worker", BrokenWorker);
    const client = createSolverWorkerClient();

    await expect(client.run(config, "steady", {})).rejects.toThrow(
      "worker unavailable",
    );
    expect(client.isRunning()).toBe(false);

    vi.stubGlobal("Worker", FakeWorker);
    const retry = client.run(config, "steady", {});
    FakeWorker.instances[0].emit({ type: "done", result: steady });
    await expect(retry).resolves.toBe(steady);
  });

  it("forwards progress and transient live results to callbacks", async () => {
    const client = createSolverWorkerClient();
    const onProgress = vi.fn();
    const onLiveResult = vi.fn();
    const promise = client.run(config, "steady", { onProgress, onLiveResult });
    const worker = FakeWorker.instances[0];

    const partial = { times: [0], nodes: {}, branches: {}, converged: true };
    worker.emit({
      type: "progress",
      payload: { kind: "transient", step: 1, time: 0.5, endTime: 1, partial },
    });
    expect(onProgress).toHaveBeenCalledWith({
      kind: "transient",
      step: 1,
      time: 0.5,
      endTime: 1,
      partial,
    });
    expect(onLiveResult).toHaveBeenCalledWith(partial);

    worker.emit({ type: "done", result: steady });
    await promise;
  });
});
