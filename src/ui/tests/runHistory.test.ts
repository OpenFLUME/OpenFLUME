import { describe, it, expect } from "vitest";
import {
  makeRunRecord,
  summarizeResult,
  checkRunCompatibility,
  resampleSeries,
  sameTimeGrid,
  RUN_HISTORY_CAP,
} from "../runHistory";
import {
  createDiaryCollector,
  buildDiaryFromResult,
} from "../convergenceDiary";
import type { NetworkConfig, SteadyResult, TransientResult } from "../types";

const config = (mode: "steady" | "transient" = "steady"): NetworkConfig => ({
  meta: { name: "Hist", version: 2 },
  settings: { mode, tolerance: 1e-6, maxIterations: 100 },
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

const steady = (p: number): SteadyResult => ({
  converged: true,
  iterations: 7,
  residual: 1e-9,
  nodes: {
    in: { pressure: p, temperature: 300, density: 1000 },
    out: { pressure: 1e5, temperature: 300, density: 1000 },
  },
  branches: { b1: { mdot: 0.5, velocity: 1, dP: 1000, reynolds: 10000 } },
});

const transient = (end: number): TransientResult => ({
  converged: true,
  times: [0, end / 2, end],
  nodes: {
    in: {
      pressure: [p0(end), p0(end) - 5, p0(end) - 10],
      temperature: [300, 299, 298],
      density: [1000, 1000, 1000],
    },
    out: {
      pressure: [1e5, 1e5, 1e5],
      temperature: [300, 300, 300],
      density: [1000, 1000, 1000],
    },
  },
  branches: { b1: { mdot: [0.5, 0.4, 0.3] } },
});
const p0 = (end: number) => 2e5 - end;

describe("runHistory records", () => {
  it("makeRunRecord snapshots config, mode, hash, and summary", () => {
    const r = makeRunRecord(3, config("steady"), steady(2e5), 1700000000000);
    expect(r.name).toBe("Run 3");
    expect(r.mode).toBe("steady");
    expect(r.converged).toBe(true);
    expect(r.summary).toContain("converged");
    expect(r.summary).toContain("7 iter");
    expect(r.configHash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.id).toContain("run-");
  });

  it("summarizeResult distinguishes modes", () => {
    expect(summarizeResult(steady(1e5))).toContain("iter");
    expect(summarizeResult(transient(10))).toContain("3 steps");
  });

  it("compatibility: same mode + shared elements is compatible", () => {
    const a = makeRunRecord(1, config("steady"), steady(2e5));
    const b = makeRunRecord(2, config("steady"), steady(1.9e5));
    expect(checkRunCompatibility(a, b).ok).toBe(true);
  });

  it("compatibility: mode mismatch is rejected with a reason", () => {
    const a = makeRunRecord(1, config("steady"), steady(2e5));
    const b = makeRunRecord(2, config("transient"), transient(10));
    const c = checkRunCompatibility(a, b);
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/[Mm]ode/);
  });

  it("compatibility: disjoint element sets rejected; a run cannot be its own baseline", () => {
    const a = makeRunRecord(1, config("steady"), steady(2e5));
    expect(checkRunCompatibility(a, a).ok).toBe(false);
    const other = makeRunRecord(2, config("steady"), {
      ...steady(2e5),
      nodes: { x: { pressure: 1, temperature: 1, density: 1 } },
      branches: { z: { mdot: 1, velocity: 1, dP: 1, reynolds: 1 } },
    });
    expect(checkRunCompatibility(a, other).ok).toBe(false);
  });

  it("resampleSeries linearly interpolates and clamps at the ends", () => {
    const out = resampleSeries([0, 1, 2], [0, 10, 20], [0.5, 1.5, 3]);
    expect(out[0]).toBeCloseTo(5);
    expect(out[1]).toBeCloseTo(15);
    expect(out[2]).toBe(20); // clamped
    expect(resampleSeries([5], [42], [0, 5, 9])).toEqual([42, 42, 42]);
    expect(resampleSeries([], [], [1, 2])).toEqual([0, 0]);
  });

  it("sameTimeGrid compares elementwise", () => {
    expect(sameTimeGrid([0, 1], [0, 1])).toBe(true);
    expect(sameTimeGrid([0, 1], [0, 1.0000001])).toBe(false);
    expect(sameTimeGrid([0], [0, 1])).toBe(false);
  });

  it("cap constant is 10", () => {
    expect(RUN_HISTORY_CAP).toBe(10);
  });
});

describe("run records with convergence diaries", () => {
  it("makeRunRecord carries an optional diary; legacy records omit it", () => {
    const cfg = config("steady");
    const diary = buildDiaryFromResult(cfg, steady(2e5));
    const withDiary = makeRunRecord(1, cfg, steady(2e5), 1700000000000, diary);
    expect(withDiary.diary).toBe(diary); // stored as given (intake clone is pushRunRecord's job)
    expect(withDiary.diary?.summary.outcome).toBe("converged");

    const legacy = makeRunRecord(2, cfg, steady(2e5), 1700000000000);
    expect(legacy.diary).toBeUndefined();
    expect("diary" in legacy).toBe(false);
    // A record without a diary is still a fully valid record.
    expect(legacy.mode).toBe("steady");
    expect(legacy.summary).toContain("converged");
  });

  it("record mode/hash/summary are unaffected by the diary", () => {
    const cfg = config("transient");
    const c = createDiaryCollector(cfg);
    c.onProgress({ kind: "transient", step: 1, time: 5, endTime: 10, dt: 1 });
    const diary = c.finalizeFromResult(transient(10));
    const withDiary = makeRunRecord(1, cfg, transient(10), 1000, diary);
    const without = makeRunRecord(1, cfg, transient(10), 1000);
    expect(withDiary.id).toBe(without.id);
    expect(withDiary.configHash).toBe(without.configHash);
    expect(withDiary.summary).toBe(without.summary);
    expect(withDiary.mode).toBe("transient");
    // The diary's provenance hash matches the record's config hash label.
    expect(withDiary.diary?.provenance.configHash).toBe(withDiary.configHash);
  });

  it("compatibility checks ignore diaries entirely", () => {
    const cfg = config("steady");
    const a = makeRunRecord(
      1,
      cfg,
      steady(2e5),
      1000,
      buildDiaryFromResult(cfg, steady(2e5)),
    );
    const b = makeRunRecord(2, cfg, steady(1.9e5)); // legacy: no diary
    expect(checkRunCompatibility(a, b).ok).toBe(true);
  });
});
