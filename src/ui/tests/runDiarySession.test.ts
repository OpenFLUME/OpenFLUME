/**
 * runDiarySession.test.ts — lifecycle orchestration of one manual run's
 * convergence diary (src/ui/runDiarySession.ts), covering the exact
 * cancel-guard semantics Toolbar wires to worker callbacks:
 * done / cancel / error / rejection and the races between them.
 */
import { describe, it, expect } from "vitest";
import { createRunDiarySession } from "../runDiarySession";
import type { NetworkConfig, SteadyResult, TransientResult } from "../types";
// Compile-time + runtime compatibility: real worker ProgressPayload values
// must flow through session.onProgress (structural superset check).
import type { ProgressPayload } from "../workerClient";

const config = (mode: "steady" | "transient" = "steady"): NetworkConfig => ({
  meta: { name: "Session", version: 2 },
  settings:
    mode === "transient"
      ? {
          mode,
          tolerance: 1e-6,
          maxIterations: 100,
          dt: 1,
          endTime: 100,
          timeStepping: "fixed" as const,
        }
      : { mode, tolerance: 1e-6, maxIterations: 100 },
  fluid: { model: "incompressible", preset: "water" },
  nodes: [
    { id: "in", type: "boundary", x: 0, y: 0, pressure: 2e5, temperature: 300 },
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
      component: { type: "pipe", length: 1, diameter: 0.02, roughness: 1e-5 },
    },
  ],
});

const steadyResult = (over: Partial<SteadyResult> = {}): SteadyResult => ({
  converged: true,
  iterations: 7,
  residual: 1e-9,
  nodes: {
    in: { pressure: 2e5, temperature: 300, density: 1000 },
    out: { pressure: 1e5, temperature: 300, density: 1000 },
  },
  branches: { b1: { mdot: 0.5, velocity: 1, dP: 1000, reynolds: 10000 } },
  ...over,
});

const transientResult = (
  over: Partial<TransientResult> = {},
): TransientResult => ({
  converged: true,
  times: [0, 50, 100],
  nodes: {
    in: {
      pressure: [2e5, 2e5, 2e5],
      temperature: [300, 300, 300],
      density: [1000, 1000, 1000],
    },
    out: {
      pressure: [1e5, 1e5, 1e5],
      temperature: [300, 300, 300],
      density: [1000, 1000, 1000],
    },
  },
  branches: { b1: { mdot: [0.5, 0.5, 0.5] } },
  ...over,
});

const steadyProgress = (
  iteration: number,
  residual: number,
): ProgressPayload => ({
  kind: "steady",
  iteration,
  residual,
});

describe("done path", () => {
  it("finalizes a completed diary from live progress + result", () => {
    const s = createRunDiarySession(config("steady"));
    expect(s.diary()).toBeNull(); // nothing finalized yet
    s.onProgress(steadyProgress(1, 1e-2));
    s.onProgress(steadyProgress(2, 1e-5));
    const fin = s.finalizeDone(steadyResult({ iterations: 2, residual: 1e-5 }));
    expect(fin.outcome).toBe("completed");
    expect(fin.diary.summary.outcome).toBe("converged");
    expect(fin.diary.summary.partial).toBeUndefined();
    expect(fin.diary.summary.progressUpdates).toBe(2);
    expect(fin.diary.events.map((e) => e.kind)).toEqual([
      "runStart",
      "residualDecade",
      "runFinish",
    ]);
    expect(s.diary()).toBe(fin.diary);
    // Provenance ties the diary to the exact immutable snapshot.
    expect(fin.diary.provenance.modelName).toBe("Session");
  });

  it("accepts real transient ProgressPayload values (partial snapshot ignored)", () => {
    const s = createRunDiarySession(config("transient"));
    const payload: ProgressPayload = {
      kind: "transient",
      step: 5,
      time: 50,
      endTime: 100,
      dt: 1,
      partial: transientResult({ times: [0, 50] }),
    };
    s.onProgress(payload);
    const fin = s.finalizeDone(transientResult());
    expect(fin.outcome).toBe("completed");
    expect(fin.diary.summary.progressUpdates).toBe(1);
    expect(fin.diary.summary.reachedEnd).toBe(true);
  });
});

describe("cancel path (cancelRequestedRef semantics)", () => {
  it("a completion landing after the cancel request yields a partial cancelled diary", () => {
    const s = createRunDiarySession(config("steady"));
    s.onProgress(steadyProgress(1, 1e-2));
    s.onProgress(steadyProgress(2, 1e-3));
    s.requestCancel();
    const fin = s.finalizeDone(steadyResult());
    expect(fin.outcome).toBe("cancelled");
    expect(fin.diary.summary.outcome).toBe("cancelled");
    expect(fin.diary.summary.partial).toBe(true);
    expect(fin.diary.summary.progressUpdates).toBe(2);
    // Evidence ends at the last progress coordinate — the delivered result
    // is never synthesized into the diary.
    expect(fin.diary.events.at(-1)!.at).toEqual({
      kind: "steady",
      iteration: 2,
    });
    expect(fin.diary.summary.iterations).toBeUndefined();
  });

  it("a worker error landing after the cancel request is also cancelled", () => {
    const s = createRunDiarySession(config("steady"));
    s.onProgress(steadyProgress(1, 1e-2));
    s.requestCancel();
    const fin = s.finalizeWorkerError("solver exploded");
    expect(fin.outcome).toBe("cancelled");
    expect(fin.diary.summary.outcome).toBe("cancelled");
    expect(fin.diary.events.at(-1)!.message).not.toContain("solver exploded");
  });

  it("a 'Cancelled' rejection finalizes cancelled even without an explicit request", () => {
    const s = createRunDiarySession(config("transient"));
    s.onProgress({ kind: "transient", step: 3, time: 30, endTime: 100, dt: 1 });
    const fin = s.finalizeRejection(new Error("Cancelled"));
    expect(fin.outcome).toBe("cancelled");
    expect(fin.diary.summary.outcome).toBe("cancelled");
    expect(fin.diary.summary.partial).toBe(true);
    expect(fin.diary.events.at(-1)!.at).toEqual({
      kind: "transient",
      time: 30,
      step: 3,
    });
  });

  it("a rejection after the cancel request is cancelled whatever its message", () => {
    const s = createRunDiarySession(config("steady"));
    s.requestCancel();
    const fin = s.finalizeRejection(new Error("stray late failure"));
    expect(fin.outcome).toBe("cancelled");
  });

  it("cancel with zero progress still produces a partial diary", () => {
    const s = createRunDiarySession(config("steady"));
    s.requestCancel();
    const fin = s.finalizeRejection(new Error("Cancelled"));
    expect(fin.diary.summary.progressUpdates).toBe(0);
    expect(fin.diary.events.at(-1)!.message).toContain("0 progress updates");
  });
});

describe("error path", () => {
  it("worker error after execution began: partial error diary carrying the sanitized message", () => {
    const s = createRunDiarySession(config("steady"));
    s.onProgress(steadyProgress(1, 1e-2));
    const fin = s.finalizeWorkerError("solver exploded\nat row 7");
    expect(fin.outcome).toBe("error");
    expect(fin.diary.summary.outcome).toBe("error");
    expect(fin.diary.summary.partial).toBe(true);
    expect(fin.diary.events.at(-1)!.message).toContain(
      "solver exploded at row 7",
    );
  });

  it("a non-Cancelled rejection finalizes an error diary with the message", () => {
    const s = createRunDiarySession(config("steady"));
    const fin = s.finalizeRejection(new Error("worker crashed"));
    expect(fin.outcome).toBe("error");
    expect(fin.diary.events.at(-1)!.message).toContain("worker crashed");
  });

  it("non-Error rejections are stringified into the diary detail", () => {
    const s = createRunDiarySession(config("steady"));
    expect(
      s.finalizeRejection("plain string").diary.events.at(-1)!.message,
    ).toContain("plain string");
    const s2 = createRunDiarySession(config("steady"));
    expect(
      s2.finalizeRejection({ message: "object message" }).diary.events.at(-1)!
        .message,
    ).toContain("object message");
  });
});

describe("races: first-finalize-wins", () => {
  it("done wins over a later rejection; every finalize returns the SAME diary", () => {
    const s = createRunDiarySession(config("steady"));
    s.onProgress(steadyProgress(1, 1e-3));
    const done = s.finalizeDone(steadyResult());
    const late = s.finalizeRejection(new Error("Cancelled"));
    expect(late.outcome).toBe("completed");
    expect(late.diary).toBe(done.diary);
    // Progress after finalization is inert.
    s.onProgress(steadyProgress(2, 1e-9));
    expect(s.diary()!.summary.progressUpdates).toBe(1);
  });

  it("cancelled wins over every later settle (done, error, rejection)", () => {
    const s = createRunDiarySession(config("steady"));
    s.onProgress(steadyProgress(1, 1e-2));
    s.requestCancel();
    const cancelled = s.finalizeRejection(new Error("Cancelled"));
    const lateDone = s.finalizeDone(steadyResult());
    const lateError = s.finalizeWorkerError("boom");
    expect(lateDone.outcome).toBe("cancelled");
    expect(lateError.outcome).toBe("cancelled");
    expect(lateDone.diary).toBe(cancelled.diary);
    expect(lateError.diary).toBe(cancelled.diary);
    // The diary keeps exactly one runFinish (the cancelled one).
    expect(
      cancelled.diary.events.filter((e) => e.kind === "runFinish"),
    ).toHaveLength(1);
  });

  it("worker error wins over the follow-up promise rejection (same message)", () => {
    const s = createRunDiarySession(config("steady"));
    const err = s.finalizeWorkerError("solver exploded");
    const rej = s.finalizeRejection(new Error("solver exploded"));
    expect(rej.outcome).toBe("error");
    expect(rej.diary).toBe(err.diary);
  });

  it("requestCancel after finalization does not rewrite a completed diary", () => {
    const s = createRunDiarySession(config("steady"));
    const done = s.finalizeDone(steadyResult());
    s.requestCancel();
    const late = s.finalizeRejection(new Error("Cancelled"));
    expect(late.outcome).toBe("completed");
    expect(late.diary).toBe(done.diary);
  });
});
