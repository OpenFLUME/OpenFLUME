import { describe, it, expect } from "vitest";
import {
  createDiaryCollector,
  buildDiaryFromResult,
  diaryToJson,
  diaryToText,
  sanitizeDiaryText,
  DIARY_VERSION,
  DIARY_EVENT_CAP,
  DIARY_MESSAGE_CAP,
  STALL_SAMPLE_THRESHOLD,
  STEP_RESIDUAL_SCALED_WARN,
  type DiaryEvent,
  type RunDiary,
} from "../convergenceDiary";
import { configHash, settingsSummary } from "../provenance";
import type { NetworkConfig, SteadyResult, TransientResult } from "../types";
// Compile-time + runtime compatibility check: the real worker ProgressPayload
// must be assignable to the diary's structural DiaryProgress view.
import type { ProgressPayload } from "../workerClient";

const config = (mode: "steady" | "transient" = "steady"): NetworkConfig => ({
  meta: { name: "Diary", version: 2 },
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

const adaptiveConfig = (): NetworkConfig => {
  const c = config("transient");
  c.settings.timeStepping = "adaptive";
  c.settings.adaptive = { dtMin: 1e-4, dtMax: 0.5, relTol: 1e-4 };
  return c;
};

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

const kinds = (d: RunDiary) => d.events.map((e) => e.kind);
const find = (d: RunDiary, kind: DiaryEvent["kind"]) =>
  d.events.find((e) => e.kind === kind);
const findAll = (d: RunDiary, kind: DiaryEvent["kind"]) =>
  d.events.filter((e) => e.kind === kind);

/** Drive a steady collector through a residual series (iterations 1..n). */
function feedSteady(
  c: ReturnType<typeof createDiaryCollector>,
  residuals: number[],
) {
  residuals.forEach((residual, i) =>
    c.onProgress({ kind: "steady", iteration: i + 1, residual }),
  );
}

/** Accounting invariant: every occurrence is retained, dropped, or coalesced. */
function expectAccounting(d: RunDiary) {
  const { emitted, dropped, coalesced, cap } = d.accounting;
  expect(emitted).toBe(d.events.length + dropped + coalesced);
  expect(d.events.length).toBeLessThanOrEqual(cap);
  // seq is gap-free and ordered over retained events.
  d.events.forEach((e, i) => expect(e.seq).toBe(i));
}

describe("steady progress milestones", () => {
  it("emits one residualDecade per newly entered decade, not per callback", () => {
    const c = createDiaryCollector(config("steady"));
    feedSteady(c, [
      5e-2, // baseline (decade 1e-2)
      4e-2,
      3e-2,
      2e-2, // same decade — silent
      8e-4, // jump across 1e-3 into decade 1e-4 — ONE event
      7e-4,
      6e-4, // silent
      2e-9, // jump across several decades — ONE event for decade reached
    ]);
    const d = c.finalizeFromResult(steadyResult());
    const decades = findAll(d, "residualDecade");
    expect(decades).toHaveLength(2);
    expect(decades[0].data).toMatchObject({ decade: -4, residual: 8e-4 });
    expect(decades[1].data).toMatchObject({ decade: -9, residual: 2e-9 });
    expect(decades[0].category).toBe("convergence");
    expect(decades[0].severity).toBe("info");
    expectAccounting(d);
  });

  it("is deterministic: identical progress streams yield identical diaries", () => {
    const residuals = [1e-1, 3e-2, 8e-3, 2e-4, 9e-6, 1e-9];
    const run = () => {
      const c = createDiaryCollector(config("steady"));
      feedSteady(c, residuals);
      return c.finalizeFromResult(
        steadyResult({ iterations: residuals.length, residual: 1e-9 }),
      );
    };
    expect(JSON.stringify(diaryToJson(run()))).toBe(
      JSON.stringify(diaryToJson(run())),
    );
  });

  it("emits no convergence events when the residual stays in one decade (few samples)", () => {
    const c = createDiaryCollector(config("steady"));
    feedSteady(c, [5e-3, 4e-3, 3e-3]);
    const d = c.finalizeFromResult(steadyResult());
    expect(findAll(d, "residualDecade")).toHaveLength(0);
    expect(findAll(d, "residualStall")).toHaveLength(0);
    expect(kinds(d)).toEqual(["runStart", "runFinish"]);
  });

  it("raises a coalesced stall warning after STALL_SAMPLE_THRESHOLD samples without 2x improvement", () => {
    const c = createDiaryCollector(config("steady"));
    // Flat residual: never a 2x improvement and no decade crossings, so the
    // stall occurrences at 10/20/30 samples are consecutive and coalesce.
    const residuals = Array.from(
      { length: STALL_SAMPLE_THRESHOLD * 3 + 1 },
      () => 5e-3,
    );
    feedSteady(c, residuals);
    const d = c.finalizeFromResult(
      steadyResult({
        converged: false,
        iterations: residuals.length,
        residual: 5e-3,
      }),
    );
    const stalls = findAll(d, "residualStall");
    expect(stalls).toHaveLength(1); // consecutive stalls coalesce
    expect(stalls[0].severity).toBe("warning");
    expect(stalls[0].count).toBe(3); // fired at 10, 20, 30 samples
    expect(stalls[0].message).toContain("progress samples");
    expect(stalls[0].at).toEqual({
      kind: "steady",
      iteration: residuals.length,
    });
    expect(d.summary.warningCount).toBe(2); // stall + NOT converged finish
    expectAccounting(d);
  });

  it("raises a rebound notice when residual jumps >= 10x above the running best", () => {
    const c = createDiaryCollector(config("steady"));
    feedSteady(c, [1e-2, 1e-4, 5e-3]); // best 1e-4, then 50x rebound
    const d = c.finalizeFromResult(steadyResult({ converged: false }));
    const rebound = find(d, "residualRebound");
    expect(rebound).toBeDefined();
    expect(rebound!.severity).toBe("notice");
    expect(rebound!.data).toMatchObject({ residual: 5e-3, bestResidual: 1e-4 });
  });

  it("records a warning on non-finite residuals without throwing", () => {
    const c = createDiaryCollector(config("steady"));
    c.onProgress({ kind: "steady", iteration: 1, residual: NaN });
    c.onProgress({ kind: "steady", iteration: 2, residual: NaN });
    c.onProgress({ kind: "steady", iteration: 3, residual: 1e-3 });
    const d = c.finalizeFromResult(steadyResult());
    const nf = find(d, "residualNonFinite");
    expect(nf).toBeDefined();
    expect(nf!.severity).toBe("warning");
    expect(nf!.count).toBe(2); // coalesced
    expect(JSON.stringify(diaryToJson(d))).not.toMatch(/NaN|Infinity/);
    expectAccounting(d);
  });
});

describe("steady final synthesis", () => {
  it("converged outcome with iterations/residual", () => {
    const c = createDiaryCollector(config("steady"));
    const d = c.finalizeFromResult(
      steadyResult({ iterations: 42, residual: 3.2e-9 }),
    );
    expect(d.summary.outcome).toBe("converged");
    expect(d.summary.iterations).toBe(42);
    expect(d.summary.residual).toBe(3.2e-9);
    expect(d.summary.digest).toContain("converged");
    expect(d.summary.digest).toContain("42 iter");
    expect(d.summary.digest).toContain("3.20e-9");
    const finish = find(d, "runFinish")!;
    expect(finish.severity).toBe("info");
    expect(finish.at).toEqual({ kind: "steady", iteration: 42 });
  });

  it("notConverged outcome is a warning", () => {
    const d = createDiaryCollector(config("steady")).finalizeFromResult(
      steadyResult({ converged: false, iterations: 100, residual: 4e-3 }),
    );
    expect(d.summary.outcome).toBe("notConverged");
    expect(find(d, "runFinish")!.severity).toBe("warning");
    expect(d.summary.warningCount).toBe(1);
    expect(d.summary.digest).toContain("NOT converged");
  });

  it("reports PTC activity: final deltaTau and shrink count", () => {
    const d = createDiaryCollector(config("steady")).finalizeFromResult(
      steadyResult({ ptcDeltaTau: [0.05, 0.025, 0.0125], ptcShrinks: 2 }),
    );
    expect(d.summary.ptcActive).toBe(true);
    expect(d.summary.ptcFinalDeltaTau).toBe(0.0125); // last element of the series
    expect(d.summary.ptcShrinks).toBe(2);
    expect(d.summary.digest).toContain("PTC");
    expect(d.summary.digest).toContain("2 shrinks");
    const d2 = createDiaryCollector(config("steady")).finalizeFromResult(
      steadyResult({ ptcDeltaTau: 0.05, ptcShrinks: 0 }),
    );
    expect(d2.summary.ptcFinalDeltaTau).toBe(0.05);
  });

  it("userTerminated takes precedence and carries the rule reason (sanitized)", () => {
    const d = createDiaryCollector(config("steady")).finalizeFromResult(
      steadyResult({
        converged: false,
        aborted: true,
        userTerminated: true,
        terminationReason: "tank\nempty\t",
      }),
    );
    expect(d.summary.outcome).toBe("userTerminated");
    const finish = find(d, "runFinish")!;
    expect(finish.severity).toBe("notice");
    expect(finish.message).toContain("tank empty");
    expect(finish.message).not.toMatch(/[\n\t]/);
    expect(finish.data!.terminationReason).toBe("tank empty");
  });

  it("aborted outcome", () => {
    const d = createDiaryCollector(config("steady")).finalizeFromResult(
      steadyResult({ converged: false, aborted: true }),
    );
    expect(d.summary.outcome).toBe("aborted");
    expect(find(d, "runFinish")!.severity).toBe("warning");
  });
});

describe("transient progress milestones", () => {
  it("emits exactly the quartile milestones, not every callback", () => {
    const c = createDiaryCollector(config("transient"));
    for (let step = 0; step <= 10; step++) {
      c.onProgress({
        kind: "transient",
        step,
        time: step * 10,
        endTime: 100,
        dt: 1,
      });
    }
    const d = c.finalizeFromResult(transientResult());
    const milestones = findAll(d, "progressMilestone");
    expect(milestones).toHaveLength(3);
    expect(milestones.map((m) => m.data!.fraction)).toEqual([0.25, 0.5, 0.75]);
    expect(milestones[0].message).toContain("25% of end time reached");
    // dt constant ⇒ no dtObservation noise.
    expect(findAll(d, "dtObservation")).toHaveLength(0);
    // 11 progress callbacks ⇒ 3 milestone events + start + finish only.
    expect(d.events).toHaveLength(5);
    expectAccounting(d);
  });

  it("falls back to step quartiles when no usable end time exists", () => {
    const c = createDiaryCollector({
      ...config("transient"),
      settings: { ...config("transient").settings, endTime: undefined },
    });
    for (let step = 0; step <= 8; step++) {
      c.onProgress({
        kind: "transient",
        step,
        totalSteps: 8,
        time: step,
        dt: 1,
      });
    }
    const d = c.finalizeFromResult(transientResult());
    const milestones = findAll(d, "progressMilestone");
    expect(milestones.map((m) => m.data!.fraction)).toEqual([0.25, 0.5, 0.75]);
    expect(milestones[0].message).toContain("of steps reached");
  });

  it("observes dt range and large changes only after dt actually varies (coalesced)", () => {
    const c = createDiaryCollector(config("transient"));
    const dts = [0.1, 0.1, 0.1, 0.2, 0.2, 0.9, 0.9, 0.05];
    dts.forEach((dt, i) =>
      c.onProgress({ kind: "transient", step: i, time: i, endTime: 1000, dt }),
    );
    const d = c.finalizeFromResult(transientResult());
    const obs = findAll(d, "dtObservation");
    expect(obs).toHaveLength(1); // one coalesced running observation
    expect(obs[0].data).toMatchObject({
      minDt: 0.05,
      maxDt: 0.9,
      largeChanges: 2,
    }); // 0.2→0.9 and 0.9→0.05
    expect(obs[0].message).toContain("large changes");
  });
});

describe("transient final synthesis", () => {
  it("reached end + converged", () => {
    const d = createDiaryCollector(config("transient")).finalizeFromResult(
      transientResult(),
    );
    expect(d.summary.outcome).toBe("converged");
    expect(d.summary.reachedEnd).toBe(true);
    expect(d.summary.steps).toBe(2);
    expect(d.summary.lastTime).toBe(100);
    expect(d.summary.digest).toContain("reached t=100s");
  });

  it("adaptive stats: rejected notice, dtMin + accuracyLimited warnings", () => {
    const d = createDiaryCollector(adaptiveConfig()).finalizeFromResult(
      transientResult({
        stats: {
          steps: 90,
          rejectedSteps: 10,
          minDt: 1e-4,
          maxDt: 0.5,
          dtAtMinCount: 3,
          accuracyLimited: true,
        },
      }),
    );
    expect(d.summary).toMatchObject({
      outcome: "converged",
      steps: 90,
      rejectedSteps: 10,
      minDt: 1e-4,
      maxDt: 0.5,
      dtAtMinCount: 3,
      accuracyLimited: true,
    });
    const rej = find(d, "rejectedSteps")!;
    expect(rej.severity).toBe("notice");
    expect(rej.category).toBe("stepControl");
    expect(rej.message).toContain("rejected 10 of 100");
    expect(find(d, "dtMinHits")!.severity).toBe("warning");
    expect(find(d, "dtMinHits")!.message).toContain("3 steps");
    expect(find(d, "accuracyLimited")!.severity).toBe("warning");
    expect(d.summary.warningCount).toBe(2);
    expect(d.summary.digest).toContain("2 warnings");
    expectAccounting(d);
  });

  it("fixed stepping: warns on meaningful high scaled step residuals only", () => {
    const d = createDiaryCollector(config("transient")).finalizeFromResult(
      transientResult({
        converged: false,
        stepResidualsScaled: [1e-5, 0.5, 1e-6, 0.02],
      }),
    );
    const warn = find(d, "stepResidualHigh")!;
    expect(warn.severity).toBe("warning");
    expect(warn.category).toBe("convergence");
    expect(warn.data).toMatchObject({
      count: 2,
      total: 4,
      max: 0.5,
      threshold: STEP_RESIDUAL_SCALED_WARN,
    });

    const clean = createDiaryCollector(config("transient")).finalizeFromResult(
      transientResult({ stepResidualsScaled: [1e-5, 1e-4] }),
    );
    expect(find(clean, "stepResidualHigh")).toBeUndefined();
  });

  it("stopped short when aborted before the end time", () => {
    const d = createDiaryCollector(config("transient")).finalizeFromResult(
      transientResult({ converged: false, aborted: true, times: [0, 10] }),
    );
    expect(d.summary.outcome).toBe("stoppedShort");
    expect(d.summary.reachedEnd).toBe(false);
    expect(d.summary.digest).toContain("stopped at t=10s of 100s");
  });

  it("stopped short when the trajectory simply does not reach the end time", () => {
    const d = createDiaryCollector(config("transient")).finalizeFromResult(
      transientResult({ times: [0, 10] }),
    );
    expect(d.summary.outcome).toBe("stoppedShort");
  });

  it("userTerminated takes precedence over stopped-short", () => {
    const d = createDiaryCollector(config("transient")).finalizeFromResult(
      transientResult({
        userTerminated: true,
        terminationReason: "level low",
        times: [0, 10],
      }),
    );
    expect(d.summary.outcome).toBe("userTerminated");
    expect(find(d, "runFinish")!.message).toContain("level low");
  });

  it("notConverged when the end is reached but steps failed", () => {
    const d = createDiaryCollector(config("transient")).finalizeFromResult(
      transientResult({ converged: false }),
    );
    expect(d.summary.outcome).toBe("notConverged");
    expect(d.summary.reachedEnd).toBe(true);
  });
});

describe("cancel/error partial finalization", () => {
  it("cancelled: partial diary from latest progress only", () => {
    const c = createDiaryCollector(config("steady"));
    feedSteady(c, [1e-2, 1e-3]);
    const d = c.finalizeCancelled();
    expect(d.summary.outcome).toBe("cancelled");
    expect(d.summary.partial).toBe(true);
    expect(d.summary.progressUpdates).toBe(2);
    const finish = find(d, "runFinish")!;
    expect(finish.severity).toBe("notice");
    expect(finish.message).toContain("partial diary");
    expect(finish.message).toContain("2 progress updates");
    expect(finish.at).toEqual({ kind: "steady", iteration: 2 }); // latest progress coordinate
    expectAccounting(d);
  });

  it("cancelled with no progress uses the origin coordinate and never throws", () => {
    const d = createDiaryCollector(config("transient")).finalizeCancelled();
    expect(d.summary.outcome).toBe("cancelled");
    expect(find(d, "runFinish")!.at).toEqual({
      kind: "transient",
      time: 0,
      step: 0,
    });
  });

  it("error: sanitized worker message, warning severity, partial", () => {
    const c = createDiaryCollector(config("transient"));
    c.onProgress({ kind: "transient", step: 3, time: 3, endTime: 100, dt: 1 });
    const d = c.finalizeError("solver blew up\nat row 7\x00");
    expect(d.summary.outcome).toBe("error");
    expect(d.summary.partial).toBe(true);
    const finish = find(d, "runFinish")!;
    expect(finish.severity).toBe("warning");
    expect(finish.message).toContain("solver blew up at row 7");
    expect(finish.message).not.toContain("\n");
    expect(finish.message).not.toContain("\x00");
    expect(finish.at).toEqual({ kind: "transient", time: 3, step: 3 });
  });

  it("first finalize wins; progress after finalize is ignored", () => {
    const c = createDiaryCollector(config("steady"));
    const d1 = c.finalizeCancelled();
    c.onProgress({ kind: "steady", iteration: 5, residual: 1 });
    const d2 = c.finalizeFromResult(steadyResult());
    expect(d2.summary.outcome).toBe("cancelled");
    expect(d2.accounting).toEqual(d1.accounting);
  });
});

describe("retention cap and drop policy", () => {
  it("caps events, keeps runStart/runFinish, and accounts every drop", () => {
    const c = createDiaryCollector(config("steady"), { cap: 10 });
    // Alternate decade drops and rebounds so events never coalesce.
    const residuals: number[] = [1e-1];
    for (let k = 0; k < 15; k++) residuals.push(1, Math.pow(10, -(k + 2)));
    feedSteady(c, residuals);
    const d = c.finalizeFromResult(steadyResult({ converged: false }));
    expect(d.events.length).toBe(10);
    expect(d.events[0].kind).toBe("runStart");
    expect(d.events[d.events.length - 1].kind).toBe("runFinish");
    expect(d.accounting.dropped).toBeGreaterThan(0);
    expectAccounting(d);
  });

  it("warnings survive while routine info milestones are evicted", () => {
    const c = createDiaryCollector(config("steady"), { cap: 6 });
    // Early stall warning (tier 2), then a flood of info-tier events.
    feedSteady(
      c,
      Array.from({ length: STALL_SAMPLE_THRESHOLD + 1 }, () => 1e-2),
    );
    const flood: number[] = [];
    for (let k = 0; k < 12; k++) flood.push(1, Math.pow(10, -(k + 2)));
    feedSteady(c, flood);
    const d = c.finalizeFromResult(steadyResult({ converged: false }));
    expect(d.events.length).toBe(6);
    expect(find(d, "residualStall")).toBeDefined(); // warning survived
    expect(d.events[0].kind).toBe("runStart");
    expectAccounting(d);
  });

  it("refuses a routine event when the buffer is full of higher-tier events", () => {
    const c = createDiaryCollector(config("steady"), { cap: 4 });
    // runStart (anchor) + stall warning (tier 2); finish (anchor) — with cap 4
    // there is room for only one info event ever, and later info is refused.
    feedSteady(
      c,
      Array.from({ length: STALL_SAMPLE_THRESHOLD + 1 }, () => 5e-3),
    );
    feedSteady(c, [1, 1e-9]); // rebound (notice) + decade (info)
    const d = c.finalizeFromResult(steadyResult({ converged: false }));
    expect(d.events.length).toBeLessThanOrEqual(4);
    expect(find(d, "residualStall")).toBeDefined();
    expect(d.events[0].kind).toBe("runStart");
    expect(d.events[d.events.length - 1].kind).toBe("runFinish");
    expectAccounting(d);
  });
});

describe("coalescing, accounting, message limits", () => {
  it("coalesces consecutive dt observations and counts occurrences", () => {
    const c = createDiaryCollector(config("transient"));
    const dts = [0.1, 0.2, 0.3, 0.4];
    dts.forEach((dt, i) =>
      c.onProgress({ kind: "transient", step: i, time: i, endTime: 1000, dt }),
    );
    const d = c.finalizeFromResult(transientResult());
    const obs = find(d, "dtObservation")!;
    expect(obs.count).toBe(3); // first change + 2 coalesced updates
    expect(d.accounting.coalesced).toBeGreaterThanOrEqual(2);
    expectAccounting(d);
  });

  it("caps long messages and strips control characters", () => {
    const long = "x".repeat(500);
    const s = sanitizeDiaryText(`a\nb\t${long}`);
    expect(s.length).toBeLessThanOrEqual(DIARY_MESSAGE_CAP);
    expect(s).not.toMatch(/[\n\t]/);
    expect(s.startsWith("a b")).toBe(true);

    const d = createDiaryCollector(config("steady")).finalizeError(
      `boom\n${"y".repeat(500)}`,
    );
    const finish = find(d, "runFinish")!;
    expect(finish.message.length).toBeLessThanOrEqual(DIARY_MESSAGE_CAP);
    expect(d.summary.digest.length).toBeLessThanOrEqual(DIARY_MESSAGE_CAP);
  });
});

describe("degenerate inputs", () => {
  it("steady result with NaN fields never emits NaN/Infinity and never throws", () => {
    const d = createDiaryCollector(config("steady")).finalizeFromResult(
      steadyResult({ iterations: NaN, residual: NaN }),
    );
    expect(d.summary.iterations).toBeUndefined();
    expect(d.summary.residual).toBeUndefined();
    const json = JSON.stringify(diaryToJson(d));
    expect(json).not.toMatch(/NaN|Infinity/);
    expect(find(d, "runFinish")!.message).not.toContain("NaN");
  });

  it("empty transient result: no NaN/Infinity, stopped-short outcome", () => {
    const d = createDiaryCollector(config("transient")).finalizeFromResult(
      transientResult({ converged: false, times: [], nodes: {}, branches: {} }),
    );
    expect(d.summary.outcome).toBe("stoppedShort");
    expect(d.summary.steps).toBe(0);
    expect(JSON.stringify(diaryToJson(d))).not.toMatch(/NaN|Infinity/);
  });

  it("degenerate stats (Infinity minDt) and non-finite step residuals are sanitized", () => {
    const d = createDiaryCollector(config("transient")).finalizeFromResult(
      transientResult({
        stats: {
          steps: 0,
          rejectedSteps: 0,
          minDt: Infinity,
          maxDt: -Infinity,
        },
        stepResidualsScaled: [NaN, Infinity],
      }),
    );
    expect(d.summary.minDt).toBeUndefined();
    expect(find(d, "stepResidualHigh")).toBeUndefined();
    expect(JSON.stringify(diaryToJson(d))).not.toMatch(/NaN|Infinity/);
  });

  it("ptcDeltaTau as an empty array does not throw", () => {
    const d = createDiaryCollector(config("steady")).finalizeFromResult(
      steadyResult({ ptcDeltaTau: [] }),
    );
    expect(d.summary.ptcActive).toBe(true);
    expect(d.summary.ptcFinalDeltaTau).toBeUndefined();
  });
});

describe("buildDiaryFromResult (offline / sweep evidence)", () => {
  it("synthesizes a final-evidence diary, acknowledging missing progress", () => {
    const d = buildDiaryFromResult(
      config("steady"),
      steadyResult({ iterations: 12, residual: 1e-8 }),
    );
    expect(kinds(d)).toEqual(["runStart", "finalEvidenceOnly", "runFinish"]);
    expect(find(d, "finalEvidenceOnly")!.severity).toBe("notice");
    expect(find(d, "finalEvidenceOnly")!.message).toContain("no live progress");
    expect(d.summary.outcome).toBe("converged");
    expect(d.summary.iterations).toBe(12);
    expectAccounting(d);
  });

  it("is deterministic and carries provenance (config hash, settings summary)", () => {
    const cfg = adaptiveConfig();
    const result = transientResult({
      stats: {
        steps: 5,
        rejectedSteps: 1,
        minDt: 1e-3,
        maxDt: 0.2,
        dtAtMinCount: 1,
        accuracyLimited: true,
      },
    });
    const a = buildDiaryFromResult(cfg, result);
    const b = buildDiaryFromResult(cfg, result);
    expect(JSON.stringify(diaryToJson(a))).toBe(JSON.stringify(diaryToJson(b)));
    expect(a.provenance.configHash).toBe(configHash(cfg));
    expect(a.provenance.settingsSummary).toBe(settingsSummary(cfg));
    expect(a.provenance.modelName).toBe("Diary");
    expect(find(a, "accuracyLimited")).toBeDefined();
  });

  it("attaches a caller-supplied SHA-256 when passed", () => {
    const d = buildDiaryFromResult(config("steady"), steadyResult(), {
      configSha256: "ab".repeat(32),
    });
    expect(d.provenance.configSha256).toBe("ab".repeat(32));
    expect(diaryToText(d)).toContain("sha256=");
  });
});

describe("formatting helpers", () => {
  it("diaryToJson exposes the structured payload with stable shape", () => {
    const c = createDiaryCollector(config("steady"));
    feedSteady(c, [1e-1, 1e-3]);
    const json = diaryToJson(c.finalizeFromResult(steadyResult()));
    expect(json.version).toBe(DIARY_VERSION);
    expect(json.mode).toBe("steady");
    expect(json.outcome).toBe("converged");
    expect(json.warningCount).toBe(0);
    expect(json.provenance.configHash).toMatch(/^[0-9a-f]{16}$/);
    expect(json.events.map((e) => e.kind)).toEqual([
      "runStart",
      "residualDecade",
      "runFinish",
    ]);
    expect(json.accounting.cap).toBe(DIARY_EVENT_CAP);
    // JSON-safe round trip.
    expect(() => JSON.parse(JSON.stringify(json))).not.toThrow();
  });

  it("diaryToText renders header, events, digest and accounting lines", () => {
    const c = createDiaryCollector(config("transient"));
    for (let step = 0; step <= 4; step++)
      c.onProgress({
        kind: "transient",
        step,
        time: step * 25,
        endTime: 100,
        dt: 1,
      });
    const text = diaryToText(c.finalizeFromResult(transientResult()));
    expect(text).toContain("convergence diary v1");
    expect(text).toContain("mode=transient");
    expect(text).toContain("outcome=converged");
    expect(text).toContain("model=Diary");
    expect(text).toContain("hash=");
    expect(text).toContain("25% of end time reached");
    expect(text).toContain("t=25s step 1");
    expect(text).toMatch(/digest: converged/);
    expect(text).toMatch(
      /events=\d+ emitted=\d+ dropped=0 coalesced=0 cap=200/,
    );
    // No wall-clock fields anywhere in either rendering: no ISO timestamps
    // and no timestamp/Date fields (note: 'progressUpdates' contains the
    // substring 'dates' — assert structurally, not with a naive regex).
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    const json = diaryToJson(
      buildDiaryFromResult(config("steady"), steadyResult()),
    );
    const raw = JSON.stringify(json);
    expect(raw).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(raw).not.toContain("timestamp");
    expect(
      json.events.every((e) => !("timestamp" in e) && !("date" in e)),
    ).toBe(true);
  });
});

describe("workerClient ProgressPayload compatibility", () => {
  it("accepts real ProgressPayload values (structural superset)", () => {
    const c = createDiaryCollector(config("transient"));
    // A real TransientProgress carries the full partial snapshot; the diary
    // reads only the scalar fields and ignores the rest.
    const payload: ProgressPayload = {
      kind: "transient",
      step: 5,
      totalSteps: 10,
      time: 50,
      endTime: 100,
      dt: 1,
      partial: transientResult({ times: [0, 50] }),
    };
    c.onProgress(payload); // compile-time assignability is the point
    const steady: ProgressPayload = {
      kind: "steady",
      iteration: 3,
      residual: 1e-4,
    };
    const c2 = createDiaryCollector(config("steady"));
    c2.onProgress(steady);
    const d = c2.finalizeFromResult(steadyResult());
    expect(d.summary.progressUpdates).toBe(1);
  });
});
