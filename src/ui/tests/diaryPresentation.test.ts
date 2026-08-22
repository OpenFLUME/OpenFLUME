/**
 * diaryPresentation.test.ts — unit coverage for the pure diary presentation
 * and export helpers (labels, collapsed slicing, accounting lines, export
 * payloads and filenames).  DOM-free by design.
 */
import { describe, it, expect } from "vitest";
import {
  createDiaryCollector,
  buildDiaryFromResult,
  diaryToText,
  DIARY_VERSION,
  STALL_SAMPLE_THRESHOLD,
  type RunDiary,
} from "../convergenceDiary";
import {
  DIARY_COLLAPSED_COUNT,
  buildDiaryJsonExport,
  buildDiaryTextExport,
  diaryAccountingText,
  diaryCoordinateLabel,
  diaryExportFilename,
  diaryIndicator,
  diaryIndicatorText,
  diaryMetaText,
  diaryOutcomeText,
  diaryOutcomeTone,
  diarySeverityCounts,
  diaryTimelineSlice,
} from "../diaryPresentation";
import { configHash } from "../provenance";
import type { NetworkConfig, SteadyResult, TransientResult } from "../types";

const steadyConfig = (): NetworkConfig => ({
  meta: { name: "Diary UI", version: 2 },
  settings: { mode: "steady", tolerance: 1e-6, maxIterations: 100 },
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

const transientConfig = (): NetworkConfig => ({
  ...steadyConfig(),
  settings: {
    mode: "transient",
    tolerance: 1e-6,
    maxIterations: 100,
    dt: 1,
    endTime: 1000,
    timeStepping: "fixed" as const,
  },
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
  times: [0, 500, 1000],
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

/** Steady diary with N residual-decade events (N+2 events total). */
function decadeDiary(decades: number): RunDiary {
  const c = createDiaryCollector(steadyConfig());
  c.onProgress({ kind: "steady", iteration: 0, residual: 1 });
  for (let k = 1; k <= decades; k++) {
    c.onProgress({ kind: "steady", iteration: k, residual: Math.pow(10, -k) });
  }
  return c.finalizeFromResult(
    steadyResult({ iterations: decades, residual: Math.pow(10, -decades) }),
  );
}

describe("diaryCoordinateLabel", () => {
  it("steady coordinate", () => {
    expect(diaryCoordinateLabel({ kind: "steady", iteration: 7 })).toBe(
      "iter 7",
    );
  });
  it("transient coordinate", () => {
    expect(diaryCoordinateLabel({ kind: "transient", time: 25, step: 1 })).toBe(
      "t = 25s · step 1",
    );
    expect(
      diaryCoordinateLabel({ kind: "transient", time: 40000, step: 400 }),
    ).toBe("t = 40,000s · step 400");
    expect(
      diaryCoordinateLabel({ kind: "transient", time: 0.00005, step: 2 }),
    ).toBe("t = 5e-5s · step 2");
  });
});

describe("diaryTimelineSlice", () => {
  const diary = decadeDiary(12); // 14 events: runStart + 12 decades + runFinish
  it("collapsed shows the first N events and counts the hidden tail", () => {
    const slice = diaryTimelineSlice(diary.events, false);
    expect(slice.visible).toHaveLength(DIARY_COLLAPSED_COUNT);
    expect(slice.visible[0].kind).toBe("runStart");
    expect(slice.total).toBe(14);
    expect(slice.hiddenCount).toBe(14 - DIARY_COLLAPSED_COUNT);
  });
  it("expanded shows every event", () => {
    const slice = diaryTimelineSlice(diary.events, true);
    expect(slice.visible).toHaveLength(14);
    expect(slice.hiddenCount).toBe(0);
  });
  it("at exactly the limit nothing is hidden", () => {
    const five = decadeDiary(3); // 5 events
    const slice = diaryTimelineSlice(five.events, false);
    expect(slice.visible).toHaveLength(5);
    expect(slice.hiddenCount).toBe(0);
  });
  it("empty event list slices cleanly", () => {
    const slice = diaryTimelineSlice([], false);
    expect(slice.visible).toEqual([]);
    expect(slice.hiddenCount).toBe(0);
  });
});

describe("outcome/severity presentation", () => {
  it("diaryOutcomeText labels every outcome", () => {
    expect(diaryOutcomeText("converged")).toBe("converged");
    expect(diaryOutcomeText("notConverged")).toBe("NOT converged");
    expect(diaryOutcomeText("aborted")).toBe("aborted");
    expect(diaryOutcomeText("userTerminated")).toBe("user-terminated");
    expect(diaryOutcomeText("stoppedShort")).toBe("stopped short");
    expect(diaryOutcomeText("cancelled")).toBe("cancelled");
    expect(diaryOutcomeText("error")).toBe("error");
    expect(diaryOutcomeText("running")).toBe("running");
  });
  it("diaryOutcomeTone maps outcomes onto pill tones", () => {
    expect(diaryOutcomeTone("converged")).toBe("ok");
    expect(diaryOutcomeTone("running")).toBe("info");
    expect(diaryOutcomeTone("cancelled")).toBe("muted");
    expect(diaryOutcomeTone("userTerminated")).toBe("muted");
    expect(diaryOutcomeTone("error")).toBe("danger");
    expect(diaryOutcomeTone("notConverged")).toBe("warn");
    expect(diaryOutcomeTone("aborted")).toBe("warn");
    expect(diaryOutcomeTone("stoppedShort")).toBe("warn");
  });
  it("diarySeverityCounts buckets retained events", () => {
    const c = createDiaryCollector(steadyConfig());
    // Flat residual: one coalesced stall warning + NOT-converged finish.
    for (let i = 0; i <= STALL_SAMPLE_THRESHOLD; i++)
      c.onProgress({ kind: "steady", iteration: i, residual: 5e-3 });
    const d = c.finalizeFromResult(
      steadyResult({ converged: false, residual: 5e-3 }),
    );
    const counts = diarySeverityCounts(d);
    expect(counts.warning).toBe(2); // stall + runFinish
    expect(counts.info).toBe(1); // runStart
    expect(counts.notice).toBe(0);
    expect(d.summary.warningCount).toBe(2);
  });
});

describe("diaryMetaText / diaryAccountingText", () => {
  it("meta counts events, severities, and progress updates", () => {
    const c = createDiaryCollector(steadyConfig());
    c.onProgress({ kind: "steady", iteration: 1, residual: 1e-2 });
    c.onProgress({ kind: "steady", iteration: 2, residual: 1e-5 });
    const d = c.finalizeFromResult(steadyResult());
    expect(diaryMetaText(d)).toBe(
      "3 events · 0 warnings · 0 notices · 2 progress updates",
    );
  });
  it("meta omits the progress count for final-evidence diaries (0 updates)", () => {
    const d = buildDiaryFromResult(steadyConfig(), steadyResult());
    const meta = diaryMetaText(d);
    expect(meta).toContain("3 events"); // runStart + finalEvidenceOnly + runFinish
    expect(meta).toContain("1 notice");
    expect(meta).not.toContain("progress update");
  });
  it("singular forms", () => {
    const c = createDiaryCollector(steadyConfig());
    c.onProgress({ kind: "steady", iteration: 1, residual: 1e-3 });
    const d = c.finalizeCancelled();
    expect(diaryMetaText(d)).toBe(
      "2 events · 0 warnings · 1 notice · 1 progress update",
    );
  });
  it("accounting is null when nothing was dropped or coalesced", () => {
    const d = buildDiaryFromResult(steadyConfig(), steadyResult());
    expect(diaryAccountingText(d)).toBeNull();
  });
  it("accounting reports cap drops without inventing events", () => {
    const c = createDiaryCollector(steadyConfig(), { cap: 5 });
    c.onProgress({ kind: "steady", iteration: 0, residual: 1 });
    for (let k = 1; k <= 10; k++)
      c.onProgress({
        kind: "steady",
        iteration: k,
        residual: Math.pow(10, -k),
      });
    const d = c.finalizeFromResult(steadyResult({ converged: false }));
    const text = diaryAccountingText(d);
    expect(text).toContain("dropped by the retention cap (5)");
    expect(d.accounting.dropped).toBeGreaterThan(0);
  });
  it("accounting reports coalesced occurrences", () => {
    const c = createDiaryCollector(transientConfig());
    [0.1, 0.2, 0.3, 0.4].forEach((dt, i) =>
      c.onProgress({ kind: "transient", step: i, time: i, endTime: 1000, dt }),
    );
    const d = c.finalizeFromResult(transientResult());
    expect(d.accounting.coalesced).toBeGreaterThan(0);
    expect(diaryAccountingText(d)).toContain("folded into ×counts");
  });
});

describe("diaryIndicator", () => {
  it("reports event and warning counts plus the digest", () => {
    const d = buildDiaryFromResult(
      steadyConfig(),
      steadyResult({ converged: false }),
    );
    const ind = diaryIndicator(d);
    expect(ind.events).toBe(3);
    expect(ind.warnings).toBe(1);
    expect(ind.outcome).toBe("notConverged");
    expect(ind.partial).toBe(false);
    expect(ind.digest).toContain("NOT converged");
    expect(diaryIndicatorText(d)).toBe("3 events · 1 warning");
  });
  it("compact text without warnings; singular event", () => {
    const d = buildDiaryFromResult(steadyConfig(), steadyResult());
    expect(diaryIndicatorText(d)).toBe("3 events");
  });
});

describe("export payloads", () => {
  const diary = buildDiaryFromResult(
    steadyConfig(),
    steadyResult({ iterations: 12, residual: 1e-8 }),
  );

  it("JSON export carries the versioned payload with provenance", () => {
    const payload = buildDiaryJsonExport(diary, {
      runId: "run-abc-1",
      runName: "Run 1",
    });
    expect(payload.version).toBe(DIARY_VERSION);
    expect(payload.mode).toBe("steady");
    expect(payload.outcome).toBe("converged");
    expect(payload.provenance.configHash).toMatch(/^[0-9a-f]{16}$/);
    expect(payload.provenance.modelName).toBe("Diary UI");
    expect(payload.run).toEqual({ id: "run-abc-1", name: "Run 1" });
    expect(() => JSON.parse(JSON.stringify(payload))).not.toThrow();
    expect(JSON.stringify(payload)).not.toMatch(/NaN|Infinity/);
  });

  it("JSON export omits the run key without context (cancelled/error diary)", () => {
    const payload = buildDiaryJsonExport(
      createDiaryCollector(steadyConfig()).finalizeCancelled(),
    );
    expect(payload.outcome).toBe("cancelled");
    expect(payload.summary.partial).toBe(true);
    expect("run" in payload).toBe(false);
  });

  it("context strings are sanitized before entering the payload", () => {
    const payload = buildDiaryJsonExport(diary, {
      runName: "bad\nname\t\x00",
      runId: "id\n1",
    });
    expect(payload.run!.name).toBe("bad name");
    expect(payload.run!.id).toBe("id 1");
    const serialized = JSON.stringify(payload.run);
    expect(serialized).not.toContain("\n");
    expect(serialized).not.toContain("\t");
    expect(serialized).not.toContain("\x00");
  });

  it("text export equals diaryToText without context", () => {
    expect(buildDiaryTextExport(diary)).toBe(diaryToText(diary));
  });

  it("text export prepends a sanitized run context line", () => {
    const text = buildDiaryTextExport(diary, {
      runId: "run-abc-1",
      runName: "Run 1",
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("run=Run 1 (run-abc-1)");
    expect(lines[1]).toContain("convergence diary v1");
    expect(text).toContain(`hash=${configHash(steadyConfig())}`);
  });
});

describe("diaryExportFilename", () => {
  const diary = buildDiaryFromResult(steadyConfig(), steadyResult());
  const hash8 = diary.provenance.configHash.slice(0, 8);

  it("uses the run name as stem when available", () => {
    expect(diaryExportFilename(diary, "json", { runName: "Run 1" })).toBe(
      `Run_1-diary-${hash8}.json`,
    );
    expect(diaryExportFilename(diary, "txt", { runName: "Run 1" })).toBe(
      `Run_1-diary-${hash8}.txt`,
    );
  });
  it("falls back to the diary model name (cancelled/error diaries)", () => {
    expect(diaryExportFilename(diary, "json")).toBe(
      `Diary_UI-diary-${hash8}.json`,
    );
  });
  it("sanitizes hostile names into a safe stem", () => {
    const name = diaryExportFilename(diary, "json", {
      runName: "weird / run: <script>",
    });
    expect(name).toBe(`weird_run_script-diary-${hash8}.json`);
    expect(name).not.toMatch(/[/<>:]/);
  });
  it("falls back cleanly when both names are empty", () => {
    const noName = buildDiaryFromResult(
      { ...steadyConfig(), meta: { name: "", version: 2 } },
      steadyResult(),
    );
    const name = diaryExportFilename(noName, "txt", { runName: "   " });
    expect(name.startsWith("run-diary-")).toBe(true);
    expect(name.endsWith(".txt")).toBe(true);
  });
});
