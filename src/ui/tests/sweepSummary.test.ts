import { describe, it, expect } from "vitest";
import type { SteadyResult, TransientResult } from "../types";
import { summarizeVariant } from "../sweep";

function steadyResult(overrides: Partial<SteadyResult> = {}): SteadyResult {
  return {
    converged: true,
    iterations: 9,
    residual: 3.2e-9,
    nodes: {
      in: { pressure: 2e5, temperature: 300, density: 1000 },
      mid: { pressure: 1.4e5, temperature: 320, density: 990 },
      out: { pressure: 1e5, temperature: 280, density: 995 },
    },
    branches: {
      b1: { mdot: 0.5, velocity: 1, dP: 6e4, reynolds: 1e4 },
      b2: { mdot: -1.25, velocity: -2.4, dP: -1e3, reynolds: 2e4 },
    },
    ...overrides,
  };
}

function transientResult(
  overrides: Partial<TransientResult> = {},
): TransientResult {
  return {
    converged: true,
    times: [0, 0.5, 1],
    nodes: {
      in: {
        pressure: [2e5, 1.9e5, 1.8e5],
        temperature: [300, 295, 290],
        density: [1000, 1000, 1000],
      },
      out: {
        pressure: [1e5, 1e5, 1e5],
        temperature: [280, 282, 284],
        density: [995, 995, 995],
      },
    },
    branches: {
      b1: { mdot: [0.5, -0.75, 0.25] },
    },
    ...overrides,
  };
}

describe("summarizeVariant — steady", () => {
  it("captures convergence, iterations/residual, envelopes, and peak |mdot|", () => {
    const s = summarizeVariant(steadyResult());
    expect(s).toMatchObject({
      mode: "steady",
      converged: true,
      aborted: false,
      userTerminated: false,
      iterations: 9,
      residual: 3.2e-9,
      pressure: { min: 1e5, max: 2e5 },
      temperature: { min: 280, max: 320 },
      peakAbsMassFlow: 1.25, // negative mdot counted by magnitude
    });
  });

  it("surfaces aborted / user-terminated flags", () => {
    const s = summarizeVariant(
      steadyResult({ converged: false, aborted: true }),
    );
    expect(s.converged).toBe(false);
    expect(s.aborted).toBe(true);
    const u = summarizeVariant(
      steadyResult({ converged: false, aborted: true, userTerminated: true }),
    );
    expect(u.userTerminated).toBe(true);
  });

  it("returns undefined envelopes (never NaN/Infinity) for empty results", () => {
    const s = summarizeVariant(steadyResult({ nodes: {}, branches: {} }));
    expect(s.pressure).toBeUndefined();
    expect(s.temperature).toBeUndefined();
    expect(s.peakAbsMassFlow).toBeUndefined();
    expect(JSON.stringify(s)).not.toMatch(/Infinity|NaN/);
  });
});

describe("summarizeVariant — transient", () => {
  it("derives step stats from the time grid when stats are absent (fixed stepping)", () => {
    const s = summarizeVariant(transientResult());
    expect(s).toMatchObject({
      mode: "transient",
      converged: true,
      steps: 2, // times recorded at t=0 plus one entry per accepted step
      endTime: 1,
      reachedEnd: true,
      pressure: { min: 1e5, max: 2e5 },
      temperature: { min: 280, max: 300 },
      peakAbsMassFlow: 0.75,
    });
    expect(s.rejectedSteps).toBeUndefined();
    expect(s.minDt).toBeUndefined();
  });

  it("prefers TransientResult.stats for step stats (adaptive stepping)", () => {
    const s = summarizeVariant(
      transientResult({
        stats: { steps: 17, rejectedSteps: 3, minDt: 0.01, maxDt: 0.5 },
      }),
    );
    expect(s.steps).toBe(17);
    expect(s.rejectedSteps).toBe(3);
    expect(s.minDt).toBe(0.01);
    expect(s.maxDt).toBe(0.5);
  });

  it("checks end-reached against the expected end time when provided", () => {
    expect(summarizeVariant(transientResult(), { endTime: 1 }).reachedEnd).toBe(
      true,
    );
    expect(summarizeVariant(transientResult(), { endTime: 2 }).reachedEnd).toBe(
      false,
    );
    // Aborted partial trajectory: flagged even without the end-time hint.
    const partial = transientResult({
      aborted: true,
      converged: false,
      times: [0, 0.5],
    });
    expect(summarizeVariant(partial).reachedEnd).toBe(false);
    expect(summarizeVariant(partial, { endTime: 1 }).reachedEnd).toBe(false);
    // User-terminated at the end time: reachedEnd reflects the time check.
    const stopped = transientResult({ userTerminated: true });
    expect(summarizeVariant(stopped, { endTime: 1 }).reachedEnd).toBe(true);
    expect(summarizeVariant(stopped).reachedEnd).toBe(false);
  });

  it("handles empty trajectories and empty series without NaN/Infinity", () => {
    const empty = transientResult({ times: [], nodes: {}, branches: {} });
    const s = summarizeVariant(empty);
    expect(s.steps).toBe(0);
    expect(s.endTime).toBeUndefined();
    expect(s.reachedEnd).toBe(false);
    expect(s.pressure).toBeUndefined();
    expect(s.temperature).toBeUndefined();
    expect(s.peakAbsMassFlow).toBeUndefined();

    const sparse = transientResult({
      nodes: { n: { pressure: [], temperature: [], density: [] } },
      branches: { b: { mdot: [] } },
    });
    const s2 = summarizeVariant(sparse);
    expect(s2.pressure).toBeUndefined();
    expect(s2.peakAbsMassFlow).toBeUndefined();
    expect(JSON.stringify(s2)).not.toMatch(/Infinity|NaN/);
  });

  it("ignores non-finite samples inside envelopes", () => {
    const s = summarizeVariant(
      steadyResult({
        nodes: {
          a: { pressure: 1e5, temperature: 300, density: 1 },
          b: {
            pressure: Number.NaN,
            temperature: Number.POSITIVE_INFINITY,
            density: 1,
          },
        },
      }),
    );
    expect(s.pressure).toEqual({ min: 1e5, max: 1e5 });
    expect(s.temperature).toEqual({ min: 300, max: 300 });
  });
});
