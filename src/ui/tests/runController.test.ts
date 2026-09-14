/**
 * runController.test.ts — ownership of a manual run's result.
 *
 * A solve is asynchronous and nothing prevents the user from switching
 * variants or replacing the model while it runs. The controller must file
 * the completed run under what it STARTED from, and must never write a
 * finished run into a document that replaced the one it belonged to.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NetworkConfig, SteadyResult } from "../types";
import type { RunCallbacks, SolverWorkerClient } from "../workerClient";

// A hand-driven worker client: `run` parks until the test calls `finish`.
type Pending = { config: NetworkConfig; callbacks: RunCallbacks };
const pending: Pending[] = [];
const fakeClient: SolverWorkerClient = {
  run: (config, _mode, callbacks) =>
    new Promise((resolve) => {
      pending.push({
        config,
        callbacks: {
          ...callbacks,
          onDone: (res) => {
            callbacks.onDone?.(res);
            resolve(res);
          },
        },
      });
    }),
  cancel: () => {},
  isRunning: () => pending.length > 0,
};
vi.mock("../workerClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../workerClient")>()),
  getSolverWorkerClient: () => fakeClient,
}));
// flushSync is a React-DOM concern the controller uses only to paint the
// cancel button; irrelevant here.
vi.mock("react-dom", () => ({ flushSync: (fn: () => void) => fn() }));

import { useStore } from "../store";
import { startRun } from "../runController";

const cfg = (): NetworkConfig => ({
  meta: { name: "Owner", version: 2 },
  settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    { id: "A", type: "boundary", x: 0, y: 0, pressure: 2e5, temperature: 300 },
    {
      id: "B",
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
      from: "A",
      to: "B",
      component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
    },
  ],
});

const steady: SteadyResult = {
  converged: true,
  iterations: 3,
  residual: 1e-9,
  nodes: {
    A: { pressure: 2e5, temperature: 300, density: 1000 },
    B: { pressure: 1e5, temperature: 300, density: 1000 },
  },
  branches: { b1: { mdot: 0.5, velocity: 1, dP: 1e5, reynolds: 9000 } },
};

async function startAndPark(): Promise<Pending> {
  const run = startRun();
  // Preflight awaits the library fetch and validation before touching the
  // worker; spin until the fake client has been handed the run.
  for (let i = 0; i < 50 && pending.length === 0; i++) await Promise.resolve();
  expect(pending).toHaveLength(1);
  void run;
  return pending[0];
}

async function finish(p: Pending) {
  p.callbacks.onDone?.(steady);
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  pending.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ components: [] }),
    })),
  );
  useStore.setState({
    config: cfg(),
    baseConfig: cfg(),
    activeVariantId: null,
    result: null,
    resultConfig: null,
    resultDiary: null,
    runHistory: [],
    runSeq: 0,
    selectedRunId: null,
    baselineRunId: null,
    past: [],
    future: [],
    running: false,
    runStatus: "idle",
    preparingOperation: null,
    validationErrors: [],
  });
});

describe("manual run ownership", () => {
  it("files the run under the variant active at START after a mid-solve switch", async () => {
    const s = () => useStore.getState();
    const v = s().createVariant("Cold day");
    s().updateNode("A", { temperature: 250 });

    const run = await startAndPark();
    expect(run.config.nodes[0].temperature).toBe(250);

    // User switches back to Base while the worker is busy.
    s().setActiveVariant(null);
    await finish(run);

    expect(s().runHistory).toHaveLength(1);
    expect(s().runHistory[0].variantId).toBe(v);
    expect(s().runHistory[0].config.nodes[0].temperature).toBe(250);
    // Base is active, so V's result is not displayed against Base's network.
    expect(s().result).toBeNull();
    expect(s().selectedRunId).toBeNull();
  });

  it("displays and selects the run when its variant is still active", async () => {
    const s = () => useStore.getState();
    const v = s().createVariant("V");
    const run = await startAndPark();
    await finish(run);
    expect(s().runHistory[0].variantId).toBe(v);
    expect(s().result).toEqual(steady);
    expect(s().selectedRunId).toBe(s().runHistory[0].id);
  });

  it("drops a completion that belongs to a replaced document", async () => {
    const s = () => useStore.getState();
    const run = await startAndPark();
    s().newNetwork();
    await finish(run);
    expect(s().runHistory).toHaveLength(0);
    expect(s().result).toBeNull();
  });
});
