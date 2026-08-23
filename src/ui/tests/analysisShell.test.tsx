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
import {
  analysisDisclosureIds,
  runStripOutcomeText,
  runStripOutcomeTone,
  runStripTitle,
  runStripView,
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
