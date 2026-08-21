/**
 * ConvergenceDiarySection — SSR smoke tests (vitest runs in a node
 * environment with no DOM renderer, so we renderToString and assert on the
 * markup).  Interaction (Show all/fewer) and real downloads are covered by
 * e2e/diary.spec.ts; the slicing logic itself by diaryPresentation.test.ts.
 */
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import ConvergenceDiarySection from "../components/ConvergenceDiarySection";
import {
  createDiaryCollector,
  buildDiaryFromResult,
  STALL_SAMPLE_THRESHOLD,
  type RunDiary,
} from "../convergenceDiary";
import { DIARY_COLLAPSED_COUNT } from "../diaryPresentation";
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

const transientResult = (): TransientResult => ({
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
});

/** 14-event steady diary (runStart + 12 residual decades + runFinish). */
function bigDiary(): RunDiary {
  const c = createDiaryCollector(steadyConfig());
  c.onProgress({ kind: "steady", iteration: 0, residual: 1 });
  for (let k = 1; k <= 12; k++)
    c.onProgress({ kind: "steady", iteration: k, residual: Math.pow(10, -k) });
  return c.finalizeFromResult(
    steadyResult({ iterations: 12, residual: 1e-12 }),
  );
}

const render = (diary: RunDiary, ctx?: { runName?: string; runId?: string }) =>
  renderToString(
    <ConvergenceDiarySection
      diary={diary}
      runName={ctx?.runName ?? null}
      runId={ctx?.runId ?? null}
    />,
  );

describe("ConvergenceDiarySection (SSR)", () => {
  it("renders heading, outcome, digest, meta, and export buttons", () => {
    const html = render(
      buildDiaryFromResult(
        steadyConfig(),
        steadyResult({ iterations: 12, residual: 1e-8 }),
      ),
      {
        runName: "Run 1",
        runId: "run-1",
      },
    );
    expect(html).toContain('data-testid="solver-diary"');
    expect(html).toContain('aria-labelledby="solver-diary-title"');
    expect(html).toContain('aria-describedby="solver-diary-digest"');
    // h3: nested under the enclosing disclosure's h2 in the Analysis view.
    expect(html).toContain('<h3 id="solver-diary-title"');
    expect(html).toContain("Solver diary");
    expect(html).toContain('data-testid="solver-diary-outcome"');
    expect(html).toContain("converged");
    expect(html).toContain('data-testid="solver-diary-digest"');
    expect(html).toContain("12 iter");
    expect(html).toContain('data-testid="solver-diary-meta"');
    expect(html).toContain("3 events");
    expect(html).toContain("1 notice"); // the finalEvidenceOnly notice
    expect(html).toContain('data-testid="solver-diary-download-json"');
    expect(html).toContain("Download JSON");
    expect(html).toContain("Download text");
  });

  it("collapses the timeline to the first events with a Show-all toggle", () => {
    const html = render(bigDiary());
    const events = html.match(/data-testid="solver-diary-event"/g) ?? [];
    expect(events).toHaveLength(DIARY_COLLAPSED_COUNT);
    expect(html).toContain('data-testid="solver-diary-toggle"');
    expect(html).toContain("Show all 14 events");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="solver-diary-events"');
    expect(html).toContain("9 hidden");
  });

  it("omits the toggle when the diary fits the collapsed window", () => {
    const html = render(buildDiaryFromResult(steadyConfig(), steadyResult()));
    expect(html).not.toContain("solver-diary-toggle");
    const events = html.match(/data-testid="solver-diary-event"/g) ?? [];
    expect(events).toHaveLength(3);
  });

  it("renders coordinate, severity text (not color alone), and folded counts", () => {
    const cfg: NetworkConfig = {
      ...steadyConfig(),
      settings: {
        mode: "transient",
        tolerance: 1e-6,
        maxIterations: 100,
        dt: 1,
        endTime: 1000,
        timeStepping: "fixed",
      },
    };
    const c = createDiaryCollector(cfg);
    [0.1, 0.2, 0.3, 0.4].forEach((dt, i) =>
      c.onProgress({
        kind: "transient",
        step: i,
        time: i * 10,
        endTime: 1000,
        dt,
      }),
    );
    const html = render(c.finalizeFromResult(transientResult()));
    expect(html).toContain("t = 0s · step 0"); // runStart coordinate
    expect(html).toContain("solver-diary__sev--info");
    expect(html).toContain(">info</span>");
    // The dtObservation coalesces 3 occurrences into one folded entry.
    expect(html).toContain(">×3</span>");
    expect(html).toContain("folded into ×counts"); // accounting honesty
    expect(html).toContain('role="list"'); // ordered-list semantics kept
  });

  it("shows warning severity text and the hidden-count affordance", () => {
    const c = createDiaryCollector(steadyConfig());
    for (let i = 0; i <= STALL_SAMPLE_THRESHOLD * 2; i++)
      c.onProgress({ kind: "steady", iteration: i, residual: 5e-3 });
    const html = render(
      c.finalizeFromResult(steadyResult({ converged: false, residual: 5e-3 })),
    );
    expect(html).toContain("solver-diary__sev--warning");
    expect(html).toContain(">warning</span>");
    expect(html).toContain("NOT converged");
    expect(html).toContain("2 warnings"); // meta severity count (stall + finish)
  });

  it("renders the partial note for cancelled diaries", () => {
    const c = createDiaryCollector(steadyConfig());
    c.onProgress({ kind: "steady", iteration: 3, residual: 1e-3 });
    const html = render(c.finalizeCancelled());
    expect(html).toContain('data-testid="solver-diary-partial"');
    expect(html).toContain(
      "partial — evidence ends at the last progress update",
    );
    expect(html).toContain("cancelled");
    expect(html).toContain("iter 3");
  });

  it("renders an explicit empty state for a diary with no events", () => {
    const empty: RunDiary = {
      version: 1,
      mode: "steady",
      provenance: { modelName: "Empty", configHash: "00", settingsSummary: "" },
      events: [],
      summary: {
        outcome: "running",
        digest: "running",
        warningCount: 0,
        progressUpdates: 0,
      },
      accounting: { emitted: 0, dropped: 0, coalesced: 0, cap: 200 },
    };
    const html = render(empty);
    expect(html).toContain('data-testid="solver-diary-empty"');
    expect(html).toContain("No diary events were recorded.");
  });

  it("escapes markup in messages (React text only — no HTML injection)", () => {
    const c = createDiaryCollector(steadyConfig());
    const html = render(c.finalizeError("<img src=x onerror=alert(1)>"));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
