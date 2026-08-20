/**
 * Analysis shell — SSR/pure tests.
 *
 * vitest runs in a node environment with no DOM renderer, so components are
 * rendered with renderToString and asserted on the markup (the same policy
 * as convergenceDiarySection.test.tsx); the view-model wording/tone logic
 * in analysisShell.ts is tested directly.  Interaction (toggle clicks,
 * select changes, open-then-focus) is e2e territory.
 */
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import AnalysisDisclosure from "../components/AnalysisDisclosure";
import AnalysisRunStrip, {
  type RunStripRunOption,
} from "../components/AnalysisRunStrip";
import {
  analysisDisclosureIds,
  runStripOutcomeText,
  runStripOutcomeTone,
  runStripTitle,
  runStripView,
  type RunStripState,
} from "../analysisShell";

/* ------------------------------------------------------------------ */
/* Pure view model                                                     */
/* ------------------------------------------------------------------ */

describe("analysisShell view model", () => {
  it("derives stable disclosure ids/testids from the instance id", () => {
    expect(analysisDisclosureIds("solver-diary")).toEqual({
      headerId: "solver-diary-header",
      contentId: "solver-diary-content",
      toggleTestId: "solver-diary-toggle",
      contentTestId: "solver-diary-content",
    });
  });

  it('falls back to "Latest run" for null/blank run names', () => {
    expect(runStripTitle(null)).toBe("Latest run");
    expect(runStripTitle(undefined)).toBe("Latest run");
    expect(runStripTitle("   ")).toBe("Latest run");
    expect(runStripTitle("Run 3")).toBe("Run 3");
  });

  it("maps every outcome to text and a pill tone", () => {
    expect(runStripOutcomeText("converged")).toBe("converged");
    expect(runStripOutcomeText("notConverged")).toBe("NOT converged");
    expect(runStripOutcomeText("running")).toBe("running");
    expect(runStripOutcomeText("cancelled")).toBe("cancelled");
    expect(runStripOutcomeText("error")).toBe("error");
    expect(runStripOutcomeTone("converged")).toBe("ok");
    expect(runStripOutcomeTone("notConverged")).toBe("warn");
    expect(runStripOutcomeTone("running")).toBe("info");
    expect(runStripOutcomeTone("cancelled")).toBe("muted");
    expect(runStripOutcomeTone("error")).toBe("danger");
  });

  it("composes a full status sentence with flags and baseline", () => {
    const vm = runStripView({
      runName: "Run 3",
      mode: "steady",
      outcome: "converged",
      outcomeDetail: "12 iter · res 3.2e-9",
      stale: true,
      partial: true,
      baselineName: "Run 1",
      runCount: 4,
      diaryEventCount: 12,
      diaryWarningCount: 2,
    });
    expect(vm.statusText).toBe(
      "Showing Run 3 · steady · converged (12 iter · res 3.2e-9) · stale — rerun before design use · partial data · compared against baseline Run 1.",
    );
    expect(vm.baselineText).toBe("Baseline: Run 1");
    expect(vm.runsBadge).toBe("4");
    expect(vm.diaryBadge).toBe("12");
    expect(vm.diaryBadgeWarn).toBe(true);
  });

  it("handles the zero-history idle state with no badges or outcome", () => {
    const vm = runStripView({});
    expect(vm.title).toBe("Latest run");
    expect(vm.modeText).toBeNull();
    expect(vm.outcomeText).toBeNull();
    expect(vm.outcomeTone).toBe("muted");
    expect(vm.runsBadge).toBeNull();
    expect(vm.diaryBadge).toBeNull();
    expect(vm.diaryBadgeWarn).toBe(false);
    expect(vm.baselineText).toBeNull();
    expect(vm.statusText).toBe("Showing Latest run.");
  });

  it('treats a zero-event diary as present (badge "0") and still flags warnings', () => {
    const vm = runStripView({ diaryEventCount: 0, diaryWarningCount: 3 });
    expect(vm.diaryBadge).toBe("0");
    // Warnings come from the diary summary — real evidence even when the
    // retention cap left zero retained events.
    expect(vm.diaryBadgeWarn).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* AnalysisDisclosure (SSR)                                            */
/* ------------------------------------------------------------------ */

const renderDisclosure = (
  over: Partial<Parameters<typeof AnalysisDisclosure>[0]> = {},
) =>
  renderToString(
    <AnalysisDisclosure
      id="run-details"
      title="Run details"
      open={false}
      onToggle={() => {}}
      {...over}
    >
      <p>Body text</p>
    </AnalysisDisclosure>,
  );

describe("AnalysisDisclosure (SSR)", () => {
  it("closed: renders the header button with ARIA wiring and no content", () => {
    const html = renderDisclosure();
    expect(html).toContain('data-testid="run-details"');
    expect(html).toContain('data-testid="run-details-toggle"');
    expect(html).toContain('id="run-details-header"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="run-details-content"');
    expect(html).toContain("Run details");
    // Content unmounted while closed (the aria-controls reference remains).
    expect(html).not.toContain('id="run-details-content"');
    expect(html).not.toContain('data-testid="run-details-content"');
    expect(html).not.toContain("Body text");
  });

  it("wraps the header button in an h2 (disclosures join the heading hierarchy)", () => {
    const html = renderDisclosure();
    expect(html).toMatch(
      /<h2 class="analysis-disclosure__heading"><button[^>]*aria-expanded="false"/,
    );
  });

  it("open: mounts the content as a labelled, focusable region", () => {
    const html = renderDisclosure({ open: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('id="run-details-content"');
    expect(html).toContain('data-testid="run-details-content"');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-labelledby="run-details-header"');
    // tabIndex -1: the open-then-focus convention's programmatic target.
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("Body text");
    expect(html).not.toContain('hidden=""');
  });

  it("keepMounted keeps the content mounted but hidden while closed", () => {
    const html = renderDisclosure({ keepMounted: true });
    expect(html).toContain('data-testid="run-details-content"');
    expect(html).toContain('hidden=""');
    expect(html).toContain("Body text");
  });

  it("renders optional badge and meta in the header", () => {
    const html = renderDisclosure({
      badge: <span className="pill pill--warn">2 warnings</span>,
      meta: "12 events",
    });
    expect(html).toContain("analysis-disclosure__badge");
    expect(html).toContain("2 warnings");
    expect(html).toContain("analysis-disclosure__meta");
    expect(html).toContain("12 events");
  });

  it("escapes markup in title/meta (React text only — no HTML injection)", () => {
    const html = renderDisclosure({ title: "<img src=x onerror=alert(1)>" });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

/* ------------------------------------------------------------------ */
/* AnalysisRunStrip (SSR)                                              */
/* ------------------------------------------------------------------ */

const RUNS: RunStripRunOption[] = [
  { id: "run-1", name: "Run 1", meta: "steady · converged" },
  { id: "run-2", name: "Run 2", meta: "steady · NOT converged" },
];

const renderStrip = (
  state: RunStripState = {},
  extra: Partial<Parameters<typeof AnalysisRunStrip>[0]> = {},
) => renderToString(<AnalysisRunStrip {...state} {...extra} />);

describe("AnalysisRunStrip (SSR)", () => {
  it('zero history, idle: "Latest run" only, no select/pills, null-state status text', () => {
    const html = renderStrip();
    expect(html).toContain('data-testid="run-strip"');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Current run"');
    expect(html).toContain('data-testid="run-strip-title"');
    expect(html).toContain("Latest run");
    expect(html).not.toContain("run-strip-select");
    expect(html).not.toContain("run-strip-outcome");
    expect(html).not.toContain("run-strip-stale");
    expect(html).toContain('role="status"');
    expect(html).toContain("Showing Latest run.");
  });

  it("live running run: mode + running outcome pill, latest-run title", () => {
    const html = renderStrip({
      mode: "transient",
      outcome: "running",
      outcomeDetail: "t = 42.00 s",
    });
    expect(html).toContain("Latest run");
    expect(html).toContain("transient");
    expect(html).toContain("pill pill--info");
    expect(html).toContain(">running</span>");
    expect(html).toContain("t = 42.00 s");
  });

  it("cancelled partial: outcome + partial pill announced as partial data", () => {
    const html = renderStrip({
      runName: "Run 2",
      mode: "steady",
      outcome: "cancelled",
      partial: true,
    });
    expect(html).toContain("pill pill--muted");
    expect(html).toContain(">cancelled</span>");
    expect(html).toContain('data-testid="run-strip-partial"');
    expect(html).toContain(">partial</span>");
    expect(html).toContain("partial data");
  });

  it("error state: danger tone pill", () => {
    const html = renderStrip({
      outcome: "error",
      outcomeDetail: "fluid lookup failed",
    });
    expect(html).toContain("pill pill--danger");
    expect(html).toContain(">error</span>");
    expect(html).toContain("fluid lookup failed");
  });

  it("stale converged record with baseline: warn pill + baseline pill", () => {
    const html = renderStrip({
      runName: "Run 3",
      mode: "steady",
      outcome: "converged",
      outcomeDetail: "12 iter · res 3.2e-9",
      stale: true,
      baselineName: "Run 1",
    });
    expect(html).toContain("pill pill--ok");
    expect(html).toContain('data-testid="run-strip-stale"');
    expect(html).toContain(">stale</span>");
    expect(html).toContain('data-testid="run-strip-baseline"');
    expect(html).toContain("Baseline: Run 1");
    expect(html).toContain("stale — rerun before design use");
  });

  it("renders the run switcher select with options and selection state", () => {
    const html = renderStrip(
      { runName: "Run 2", runCount: 2 },
      { runs: RUNS, selectedRunId: "run-2", onSelectRun: () => {} },
    );
    expect(html).toContain('data-testid="run-strip-select"');
    expect(html).toContain('aria-label="Switch displayed run"');
    expect(html).toContain("Latest run");
    expect(html).toContain(
      '<option value="run-1">Run 1 · steady · converged</option>',
    );
    // The selected option is marked in the SSR markup.
    expect(html).toContain(
      '<option value="run-2" selected="">Run 2 · steady · NOT converged</option>',
    );
  });

  it("falls back to the Latest run option when the selected id is unknown", () => {
    const html = renderStrip(
      {},
      { runs: RUNS, selectedRunId: "run-gone", onSelectRun: () => {} },
    );
    expect(html).toContain('<option value="" selected="">Latest run</option>');
  });

  it("renders action buttons with count badges when callbacks are provided", () => {
    const html = renderStrip(
      { runCount: 3, diaryEventCount: 12, diaryWarningCount: 1 },
      { onShowRuns: () => {}, onShowDiary: () => {}, onShowDetails: () => {} },
    );
    expect(html).toContain('data-testid="run-strip-runs"');
    expect(html).toContain('data-testid="run-strip-runs-badge">3</span>');
    expect(html).toContain('data-testid="run-strip-diary"');
    expect(html).toContain("run-strip__badge run-strip__badge--warn");
    expect(html).toContain('data-testid="run-strip-diary-badge">12</span>');
    expect(html).toContain('data-testid="run-strip-details"');
    expect(html).toContain(">Details</button>");
  });

  it("omits buttons/select entirely when callbacks are absent", () => {
    const html = renderStrip({ runCount: 3, diaryEventCount: 5 });
    expect(html).not.toContain('run-strip-runs"');
    expect(html).not.toContain('run-strip-diary"');
    expect(html).not.toContain('run-strip-details"');
    expect(html).not.toContain("run-strip-select");
  });
});
