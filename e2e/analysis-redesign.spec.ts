/**
 * e2e/analysis-redesign.spec.ts — the redesigned Analysis workspace:
 *
 *   1. Fast steady run: the ChannelExplorer opens aggregate-first (the
 *      default node-pressure preset renders the full-width value list);
 *      Runs / Diary / Details / Result tables are closed disclosures opened
 *      via the sticky run strip (or their header); Custom channels mode
 *      drives the scalar + on-demand context diagram, and Show on Diagram
 *      returns to the canvas with the element selected.
 *   2. Two historical runs: the strip selector switches the displayed run
 *      and its captured context (stale flag follows); the Runs disclosure
 *      still supports rename / pin-baseline / delete.
 *   3. Fast transient run: the default aggregate preset charts every node
 *      pressure full-width; the view dropdown switches quantity (temperatures,
 *      mass flow) with full-network series + labels; there is NO time bar
 *      (slider/stepper/Final) — hovering the chart reads values at any time
 *      via its tooltip; Final-state tables stay behind their disclosure.
 *      The legacy "Full-network charts" disclosure is gone.
 *   4. Exploring channels and inspecting time (hover/click on the chart)
 *      never mutates the model, the autosave, or the dirty flag.
 */
import { test, expect, Page } from "@playwright/test";
import * as fs from "fs";
import { openAnalysisSection } from "./analysis";

async function captureTextDownload(
  page: Page,
  trigger: () => Promise<void>,
): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    trigger(),
  ]);
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("Download path is null");
  return fs.readFileSync(downloadPath, "utf-8");
}

function attachConsoleWatcher(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    errors.push(err.message);
  });
  return {
    assertNoErrors() {
      expect(errors).toEqual([]);
    },
  };
}

/** Select a run-strip option whose text starts with the run name. */
async function selectStripRun(page: Page, name: string) {
  const select = page.locator('[data-testid="run-strip-select"]');
  const option = select.locator("option", { hasText: name }).first();
  const value = await option.getAttribute("value");
  expect(value, `run-strip option for ${name}`).not.toBeNull();
  await select.selectOption(value!);
}

const readAutosave = (page: Page) =>
  page.evaluate(() => localStorage.getItem("fluids-network-config-v1"));

test.describe("Analysis redesign", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Reset units to SI defaults so nothing view-related leaks between tests.
    await page.evaluate(() => {
      localStorage.removeItem("fluids-network-units-v1");
    });
    await page.reload();
  });

  test("1. Steady run: explorer first (aggregate default), disclosures closed, strip jumps, Custom pick, Show on Diagram", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Pre-run empty state: concise — the strip alone, one hint line, and no
    // disclosures (no history yet).
    await page.locator('[data-testid="results-tab"]').click();
    await expect(page.locator('[data-testid="run-strip"]')).toBeVisible();
    await expect(page.locator('[data-testid="run-strip-title"]')).toHaveText(
      "Latest run",
    );
    await expect(page.locator('[data-testid="results-view"]')).toContainText(
      "Run a simulation to see results",
    );
    await expect(page.locator('[data-testid="runs-toggle"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="diary-toggle"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="channel-explorer"]')).toHaveCount(
      0,
    );

    // Fast steady run.
    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    await page.waitForTimeout(300);
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
      { timeout: 15000 },
    );

    // Loading the example reset the tab to Model (loadExample always does,
    // independent of Run); Run itself no longer auto-switches, so come back.
    await page.locator('[data-testid="results-tab"]').click();

    // The strip answers "what am I looking at?": title, mode, outcome pill,
    // plus an accessible status sentence.
    await expect(page.locator('[data-testid="run-strip-title"]')).toHaveText(
      "Run 1",
    );
    await expect(page.locator('[data-testid="run-strip-mode"]')).toHaveText(
      "steady",
    );
    await expect(page.locator('[data-testid="run-strip-outcome"]')).toHaveText(
      "converged",
    );
    await expect(
      page.locator('[data-testid="run-strip-status"]'),
    ).toContainText("Showing Run 1 · steady · converged");

    // Channel explorer is visible FIRST, aggregate-first: the default
    // node-pressure preset renders the steady value list; the Custom-only
    // scalar/context stay unmounted until the view switches.
    await expect(
      page.locator('[data-testid="channel-explorer"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="channel-explorer-view"]'),
    ).toHaveValue("node-pressure");
    await expect(
      page.locator('[data-testid="channel-explorer-bars"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="channel-explorer-scalar"]'),
    ).toHaveCount(0);
    // All secondary sections are closed disclosures with nothing mounted
    // inside; the legacy Full-network charts disclosure is gone entirely.
    for (const key of ["summary", "final", "diary", "runs"] as const) {
      await expect(
        page.locator(`[data-testid="${key}-toggle"]`),
      ).toHaveAttribute("aria-expanded", "false");
    }
    await expect(page.locator('[data-testid="channels-toggle"]')).toHaveCount(
      0,
    );
    await expect(
      page.locator('[data-testid="steady-branches-table"]'),
    ).toHaveCount(0);
    await expect(page.locator('[data-testid="solver-diary"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="run-history"]')).toHaveCount(0);

    // Strip buttons open + focus their sections (diary focuses the diary
    // itself, not just the disclosure region).
    await page.locator('[data-testid="run-strip-details"]').click();
    await expect(
      page.locator('[data-testid="summary-toggle"]'),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[data-testid="summary-content"]')).toBeFocused();

    await page.locator('[data-testid="run-strip-diary"]').click();
    await expect(page.locator('[data-testid="diary-toggle"]')).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.locator('[data-testid="solver-diary"]')).toBeFocused();
    await expect(
      page.locator('[data-testid="solver-diary-outcome"]'),
    ).toHaveText("converged");

    await page.locator('[data-testid="run-strip-runs"]').click();
    await expect(page.locator('[data-testid="runs-toggle"]')).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.locator('[data-testid="run-history-item"]')).toHaveCount(
      1,
    );

    // Result tables open via their disclosure header (no strip button).
    await page.locator('[data-testid="final-toggle"]').click();
    await expect(
      page.locator('[data-testid="steady-branches-table"]'),
    ).toBeVisible();

    // Custom channels mode: channel selection updates the focused scalar.
    // Default primary: first inventory channel (Inlet pressure).
    await page
      .locator('[data-testid="channel-explorer-view"]')
      .selectOption({ label: "Custom channels" });
    await expect(
      page.locator('[data-testid="channel-explorer-custom"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="channel-explorer-primary-label"]'),
    ).toHaveText("Inlet · Pressure");
    const inletScalar = await page
      .locator('[data-testid="channel-explorer-scalar-value"]')
      .textContent();
    await page
      .locator('[data-testid^="channel-item-"]', {
        hasText: "Pipe 1 · Mass flow",
      })
      .click();
    await expect(
      page.locator('[data-testid="channel-explorer-primary-label"]'),
    ).toHaveText("Pipe 1 · Mass flow");
    const pipeScalar = await page
      .locator('[data-testid="channel-explorer-scalar-value"]')
      .textContent();
    expect(pipeScalar).not.toBe(inletScalar);

    // Diagram context is on demand: the SVG stays hidden inside its closed
    // details until the analyst asks for it, then re-centres on the picked
    // element (SVG title + accessible summary).
    await expect(
      page.locator('[data-testid="channel-explorer-context"]'),
    ).toBeHidden();
    await page
      .locator('[data-testid="channel-explorer-context-details"] summary')
      .click();
    const contextSvg = page.locator('[data-testid="channel-explorer-context"]');
    await expect(contextSvg).toBeVisible();
    await expect(contextSvg.locator("title")).toHaveText(
      "Topology context around Pipe 1",
    );
    await expect(contextSvg).toHaveAttribute("aria-label", /branch "b1"/);

    // Show on Diagram returns to the canvas with the branch selected.
    await page
      .locator('[data-testid="channel-explorer-show-on-diagram"]')
      .click();
    await expect(page.locator('[data-testid="editor-tab"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Branch: b1",
    );

    // Narrow width: the strip wraps, the explorer stacks, and nothing
    // overflows the results view horizontally.
    await page.locator('[data-testid="results-tab"]').click();

    // Sticky strip: with a short viewport the results view scrolls and the
    // strip stays pinned to the scrollport top.
    await page.setViewportSize({ width: 900, height: 420 });
    const resultsView = page.locator('[data-testid="results-view"]');
    await resultsView.evaluate((el: HTMLElement) => {
      el.scrollTop = el.scrollHeight;
    });
    const stripBox = await page
      .locator('[data-testid="run-strip"]')
      .boundingBox();
    const viewBox = await resultsView.boundingBox();
    expect(stripBox).not.toBeNull();
    expect(stripBox!.y).toBeLessThanOrEqual(viewBox!.y + 2);
    await resultsView.evaluate((el: HTMLElement) => {
      el.scrollTop = 0;
    });

    await page.setViewportSize({ width: 700, height: 600 });
    await expect(page.locator('[data-testid="run-strip"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="channel-explorer"]'),
    ).toBeVisible();
    const overflow = await page
      .locator('[data-testid="results-view"]')
      .evaluate((el: HTMLElement) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1280, height: 720 });

    consoleWatcher.assertNoErrors();
  });

  test("2. Two runs: strip selector switches run + captured context; Runs disclosure rename/pin/delete", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    await page.waitForTimeout(300);
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
      { timeout: 15000 },
    );

    // Edit the inlet pressure between runs so the two results differ.
    await page.locator('[data-testid="editor-tab"]').click();
    await page.locator('[data-testid="node-in"]').click();
    const pressureInput = page.locator('label:has-text("Pressure") + input');
    await pressureInput.fill("250000");
    await pressureInput.blur();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
      { timeout: 15000 },
    );

    // The strip shows the newest run and offers every historical run.
    await page.locator('[data-testid="results-tab"]').click();
    await expect(page.locator('[data-testid="run-strip-title"]')).toHaveText(
      "Run 2",
    );
    await expect(
      page.locator('[data-testid="channel-explorer-run-context"]'),
    ).toHaveText("Run 2");

    // Custom mode: the focused scalar tracks the displayed (captured) run.
    await page
      .locator('[data-testid="channel-explorer-view"]')
      .selectOption({ label: "Custom channels" });
    const run2Scalar = await page
      .locator('[data-testid="channel-explorer-scalar-value"]')
      .textContent();

    // Switch to Run 1 from the strip select: title, explorer context, and
    // the captured scalar follow; the displayed run is now stale (its config
    // differs from the live model).
    await selectStripRun(page, "Run 1");
    await expect(page.locator('[data-testid="run-strip-title"]')).toHaveText(
      "Run 1",
    );
    await expect(
      page.locator('[data-testid="channel-explorer-run-context"]'),
    ).toHaveText("Run 1");
    const run1Scalar = await page
      .locator('[data-testid="channel-explorer-scalar-value"]')
      .textContent();
    expect(run1Scalar).not.toBe(run2Scalar);
    await expect(page.locator('[data-testid="run-strip-stale"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="results-stale-banner"]'),
    ).toBeVisible();
    // The critical banner renders ABOVE the sticky strip (never obscured).
    const bannerBox = await page
      .locator('[data-testid="results-stale-banner"]')
      .boundingBox();
    const stripBox2 = await page
      .locator('[data-testid="run-strip"]')
      .boundingBox();
    expect(bannerBox).not.toBeNull();
    expect(stripBox2).not.toBeNull();
    expect(bannerBox!.y + bannerBox!.height).toBeLessThanOrEqual(
      stripBox2!.y + 1,
    );

    // Back to Run 2; stale clears.
    await selectStripRun(page, "Run 2");
    await expect(page.locator('[data-testid="run-strip-title"]')).toHaveText(
      "Run 2",
    );
    await expect(
      page.locator('[data-testid="results-stale-banner"]'),
    ).toHaveCount(0);

    // Runs disclosure: rename the newest run (strip title follows the
    // selection), pin the older run as baseline (strip baseline pill), and
    // delete the renamed run (strip falls back to "Latest run").
    await openAnalysisSection(page, "runs");
    const items = page.locator('[data-testid="run-history-item"]');
    await expect(items).toHaveCount(2);

    const nameInput = items.nth(0).locator('[data-testid="run-history-name"]');
    await nameInput.fill("High pressure");
    await nameInput.blur();
    await expect(page.locator('[data-testid="run-strip-title"]')).toHaveText(
      "High pressure",
    );

    await items.nth(1).locator('[data-testid="pin-baseline"]').click();
    await expect(
      page.locator('[data-testid="baseline-indicator"]'),
    ).toContainText("Baseline: Run 1");
    await expect(page.locator('[data-testid="run-strip-baseline"]')).toHaveText(
      "Baseline: Run 1",
    );
    // The explorer shows the baseline delta for the focused scalar channel.
    await expect(
      page.locator('[data-testid="channel-explorer-baseline-delta"]'),
    ).toBeVisible();

    await items.nth(0).locator('[data-testid="run-history-delete"]').click();
    await expect(page.locator('[data-testid="run-history-item"]')).toHaveCount(
      1,
    );
    await expect(page.locator('[data-testid="run-strip-title"]')).toHaveText(
      "Latest run",
    );
    // The pinned baseline survives the deletion of the other run.
    await expect(page.locator('[data-testid="run-strip-baseline"]')).toHaveText(
      "Baseline: Run 1",
    );

    consoleWatcher.assertNoErrors();
  });

  test("3. Transient run: aggregate presets default, dropdown switches quantity, no time bar — hover tooltip reads any time", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Tank blowdown");
    await page.waitForTimeout(300);
    const configBefore = await readAutosave(page);
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
      { timeout: 15000 },
    );

    // Explorer-first, aggregate-first: the default preset charts every node
    // pressure full-width (tank + ambient), with the dropdown offering the
    // other quantity views.  The legacy Full-network charts disclosure and
    // its charts are gone.
    await page.locator('[data-testid="results-tab"]').click();
    await expect(
      page.locator('[data-testid="channel-explorer-view"]'),
    ).toHaveValue("node-pressure");
    const pressureChart = page.locator(
      '[data-testid="channel-explorer-chart"]',
    );
    await expect(pressureChart).toBeVisible();
    await expect(pressureChart.locator("polyline")).toHaveCount(2); // tank + ambient
    await expect(
      pressureChart.locator('[data-testid^="chart-legend-item-"]', {
        hasText: "Tank",
      }),
    ).toBeVisible();
    await expect(
      pressureChart.locator('[data-testid^="chart-legend-item-"]', {
        hasText: "Ambient",
      }),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="channel-explorer-readout"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="channels-toggle"]')).toHaveCount(
      0,
    );
    await expect(
      page.locator('[data-testid="transient-pressure-chart"]'),
    ).toHaveCount(0);
    await expect(page.locator('[data-testid="final-toggle"]')).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    // Dropdown switches the full-network quantity: temperatures, then mass
    // flow (one series for the single orifice branch).
    await page
      .locator('[data-testid="channel-explorer-view"]')
      .selectOption("node-solid-temperature");
    const tempChart = page.locator('[data-testid="channel-explorer-chart"]');
    await expect(tempChart.locator(".chart-title")).toContainText(
      "Temperature",
    );
    await expect(tempChart.locator("polyline")).toHaveCount(2);

    await page
      .locator('[data-testid="channel-explorer-view"]')
      .selectOption("branch-mdot");
    const mdotChart = page.locator('[data-testid="channel-explorer-chart"]');
    await expect(mdotChart.locator(".chart-title")).toContainText("Mass flow");
    await expect(mdotChart.locator("polyline")).toHaveCount(1);
    await expect(
      mdotChart.locator('[data-testid^="chart-legend-item-"]', {
        hasText: "Orifice",
      }),
    ).toBeVisible();

    // Back to pressures for the cursor assertions.
    await page
      .locator('[data-testid="channel-explorer-view"]')
      .selectOption("node-pressure");

    // View CSV is the displayed preset only (the two node pressures). Export
    // all adds every other quantity — both as a plottable table: time first
    // column, one column per channel, units in the headers.
    const viewCsv = await captureTextDownload(page, async () => {
      await page.locator('[data-testid="channel-explorer-export-csv"]').click();
    });
    expect(viewCsv).toContain("# format=wide");
    expect(viewCsv).toContain("# quantity=pressure");
    const viewHeader = viewCsv.split("\n").find((l) => l.startsWith("time ("))!;
    expect(viewHeader).toContain("Tank · Pressure (");
    expect(viewHeader).not.toContain("Mass flow");

    const allCsv = await captureTextDownload(page, async () => {
      await page
        .locator('[data-testid="channel-explorer-export-all-csv"]')
        .click();
    });
    expect(allCsv).toContain("# format=wide");
    const allHeader = allCsv.split("\n").find((l) => l.startsWith("time ("))!;
    expect(allHeader).toContain("Tank · Pressure (");
    expect(allHeader).toContain("Tank · Temperature (");
    expect(allHeader).toContain("Orifice · Mass flow (");
    // Each saved time is ONE row spanning every channel column.
    const allRows = allCsv.split("\n").filter((l) => /^[0-9]/.test(l));
    expect(allRows.length).toBeGreaterThan(1);
    for (const row of allRows) {
      expect(row.split(",").length).toBe(allHeader.split(",").length);
    }

    // No time bar in Analysis: the transient slider/stepper/Final controls
    // are gone — hovering the chart shows the values at any time point via
    // its tooltip.  The canonical model autosave is untouched by chart
    // inspection.
    await expect(
      page.locator('[data-testid="channel-explorer-time"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="channel-explorer-time-slider"]'),
    ).toHaveCount(0);
    const readout = page.locator('[data-testid="channel-explorer-readout"]');
    await expect(readout).toBeVisible();
    const chartSvg = pressureChart.locator("svg");
    const chartBox = await chartSvg.boundingBox();
    expect(chartBox).not.toBeNull();
    const tooltip = page.locator('[data-testid="chart-tooltip"]');
    // Hover near the left edge (t ≈ 0), then near the right edge (final):
    // the tooltip's time/value lines track the hovered sample.
    await chartSvg.hover({ position: { x: 80, y: 60 } });
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("t =");
    const earlyTip = await tooltip.textContent();
    await chartSvg.hover({ position: { x: chartBox!.width - 40, y: 60 } });
    const lateTip = await tooltip.textContent();
    expect(lateTip).not.toBe(earlyTip);
    expect(await readAutosave(page)).toBe(configBefore);

    // Final-state tables stay behind their disclosure.
    await openAnalysisSection(page, "final");
    await expect(page.locator('[data-testid="mdot-orifice"]')).toBeVisible();

    // The relocated complete-time-series export lives in Run details (no
    // charts restored): one CSV with t + every node P/T + branch mdot, with
    // a captured-config provenance block above the header.
    await openAnalysisSection(page, "summary");
    const csv = await captureTextDownload(page, async () => {
      await page.locator('[data-testid="download-timeseries-csv"]').click();
    });
    expect(csv).toContain("#");
    const csvHeader = csv.split("\n").find((l) => l.startsWith("t ("));
    expect(csvHeader).toBeTruthy();
    expect(csvHeader).toContain("Tank P");
    expect(csvHeader).toContain("Tank T");
    expect(csvHeader).toContain("Orifice mdot");

    // ~700px: the full-width aggregate chart + view dropdown fit the results
    // view without horizontal overflow.
    await page.setViewportSize({ width: 700, height: 600 });
    await expect(
      page.locator('[data-testid="channel-explorer-view"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="channel-explorer-chart"]'),
    ).toBeVisible();
    const overflow = await page
      .locator('[data-testid="results-view"]')
      .evaluate((el: HTMLElement) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1280, height: 720 });

    consoleWatcher.assertNoErrors();
  });

  test("4. Channel exploration and chart time inspection never mutate the model or autosave", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Tank blowdown");
    await page.waitForTimeout(400);
    const configBefore = await readAutosave(page);
    expect(configBefore).toBeTruthy();

    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
      { timeout: 15000 },
    );

    // Explore in Custom channels mode: search narrows the list, kind filter
    // re-scopes it, then pick and pin a branch channel and inspect time via
    // the chart (there is no Analysis time bar — hover shows values at any
    // time, a plain click commits the shared cursor).
    await page.locator('[data-testid="results-tab"]').click();
    await page
      .locator('[data-testid="channel-explorer-view"]')
      .selectOption({ label: "Custom channels" });
    await page.locator('[data-testid="channel-explorer-search"]').fill("Tank");
    await expect(
      page.locator('[data-testid^="channel-item-"]').first(),
    ).toBeVisible();
    await page.locator('[data-testid="channel-explorer-search"]').fill("");
    await page
      .locator('[data-testid="channel-explorer-filter-branch"]')
      .click();
    await page.locator('[data-testid^="channel-item-"]').first().click();
    await page.locator('[data-testid^="channel-pin-"]').first().click();
    await expect(
      page.locator('[data-testid="channel-explorer-status"]'),
    ).toContainText("Pinned");
    await expect(
      page.locator('[data-testid="channel-explorer-time"]'),
    ).toHaveCount(0);
    const focusSvg = page.locator('[data-testid="channel-explorer-chart"] svg');
    await expect(focusSvg).toBeVisible();
    const focusBox = await focusSvg.boundingBox();
    expect(focusBox).not.toBeNull();
    await focusSvg.hover({ position: { x: 90, y: 60 } });
    await expect(page.locator('[data-testid="chart-tooltip"]')).toBeVisible();
    await focusSvg.click({ position: { x: 90, y: 60 } });

    // Show on Diagram: selection + tab + canvas-focus request only.
    await page
      .locator('[data-testid="channel-explorer-show-on-diagram"]')
      .click();
    await expect(page.locator('[data-testid="editor-tab"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // The canonical model, its autosave, and the dirty flag are untouched.
    expect(await readAutosave(page)).toBe(configBefore);
    await expect(
      page.locator('[data-testid="network-name-dirty-dot"]'),
    ).not.toBeVisible();

    consoleWatcher.assertNoErrors();
  });
});
