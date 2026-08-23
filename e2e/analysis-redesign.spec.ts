/**
 * e2e/analysis-redesign.spec.ts — the redesigned Analysis workspace:
 *
 *   1. Fast steady run: the Runs tab opens on ONE EMPTY plot — an axis and an
 *      invitation, because nothing here should presume what the analyst came
 *      to look at; Runs / Diary / Details / Result tables are closed
 *      disclosures opened via the sticky run strip (or their header).
 *   2. Two historical runs: the strip selector switches the displayed run
 *      and its captured context (stale flag follows); the Runs disclosure
 *      still supports rename / pin-baseline / delete.
 *   3. Fast transient run: the plot opens on a time axis and the preset
 *      control fills it (node pressures, temperatures, mass flow) with
 *      full-network series + labels; there is NO time bar (slider/stepper/
 *      Final) — hovering the chart reads values at any time via its tooltip;
 *      Final-state tables stay behind their disclosure.
 *   4. Exploring channels and inspecting time (hover/click on the chart)
 *      never mutates the model, the autosave, or the dirty flag.
 *   5. The topology-aware kinds: a Profile plots the chosen flow path with its
 *      stations and schematic, a Breakdown accounts for each component's
 *      share, and Distribution still offers the unordered bars.
 *   6. Plots are independent documents: several tabs coexist, each with its own
 *      kind and channels, renameable and closeable, surviving a tab switch.
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

/** The panel title IS the run selector; pick the option naming this run. */
async function selectRunFromTitle(page: Page, name: string) {
  const select = page.locator('[data-testid="run-title-select"]');
  const option = select.locator("option", { hasText: name }).first();
  const value = await option.getAttribute("value");
  expect(value, `run option for ${name}`).not.toBeNull();
  await select.selectOption(value!);
}

/** The displayed run, read off the title dropdown's selected option. */
async function expectRunTitle(page: Page, name: string) {
  const label = await page
    .locator('[data-testid="run-title-select"]')
    .evaluate(
      (el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent,
    );
  expect(label ?? "").toContain(name);
}

/** The x axis, read off the selector that sits where its label would go. */
async function expectXAxisLabel(page: Page, label: string) {
  const text = await page
    .locator('[data-testid="plot-x-axis"]')
    .evaluate(
      (el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent,
    );
  expect(text ?? "").toContain(label);
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

  test("1. Steady run: an empty plot first, disclosures closed, each opens from its header", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Pre-run empty state: concise — one hint line and no disclosures
    // (no history yet).
    await page.locator('[data-testid="results-tab"]').click();
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

    // The panel's TITLE answers "what am I looking at?" and switches runs;
    // there is no separate strip repeating it.
    await expect(page.locator('[data-testid="run-strip"]')).toHaveCount(0);
    await expectRunTitle(page, "Run 1");
    await expect(page.locator('[data-testid="run-title-outcome"]')).toHaveText(
      "converged",
    );
    await expect(
      page.locator('[data-testid="run-title-status"]'),
    ).toContainText("Showing Run 1 · steady · converged");

    // Channel explorer is visible FIRST: the rail carries the whole
    // inventory, the node-pressure preset is the default channel set, and a
    // steady run opens on the Profile. Distribution's bars and Focus's
    // scalar stay unmounted until those views are chosen.
    await expect(
      page.locator('[data-testid="channel-explorer"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="plot-channel-picker"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid^="plot-tab-"]').first(),
    ).toContainText("New plot");
    // Nothing is pre-selected: the plot does not presume what you came for.
    await expect(
      page.locator('[data-testid="plot-no-channels"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="plot-chart"]')).toHaveCount(0);
    // A steady result has no time axis to offer.
    await expect(page.locator('[data-testid="plot-x-axis"]')).toHaveValue(
      "station",
    );
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

    // Each secondary section opens from its own disclosure header.
    await openAnalysisSection(page, "summary");
    await expect(
      page.locator('[data-testid="summary-toggle"]'),
    ).toHaveAttribute("aria-expanded", "true");

    await openAnalysisSection(page, "diary");
    await expect(page.locator('[data-testid="diary-toggle"]')).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(
      page.locator('[data-testid="solver-diary-outcome"]'),
    ).toHaveText("converged");

    await openAnalysisSection(page, "runs");
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

    // Picking a channel adds it to THIS plot and selects its element, so the
    // canvas and the properties panel follow the analyst's attention.
    const branchRow = page
      .locator('[data-testid^="plot-channel-ch"]', { hasText: "Mass flow" })
      .first();
    await branchRow.click();
    await expect(branchRow).toHaveAttribute("aria-pressed", "true");
    await page.locator('[data-testid="editor-tab"]').click();
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Branch: b1",
    );
    await page.locator('[data-testid="results-tab"]').click();

    // Narrow viewport: the panel still fits without horizontal overflow.
    await page.setViewportSize({ width: 700, height: 600 });
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

  test("2. Two runs: the title dropdown switches run + captured context; Runs disclosure rename/pin/delete", async ({
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
    const pressureInput = page
      .getByRole("textbox", { name: /^Pressure \(/ })
      .first();
    await pressureInput.click();
    await pressureInput.fill("250000");
    await pressureInput.press("Enter");
    await page.waitForTimeout(300);
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
      { timeout: 15000 },
    );

    // The title shows the newest run and offers every historical run.
    await page.locator('[data-testid="results-tab"]').click();
    await expectRunTitle(page, "Run 2");

    // The picker's values track the displayed (captured) run.
    const run2Value = await page
      .locator('[data-testid^="plot-channel-ch"]')
      .first()
      .textContent();

    // Switch to Run 1 from the title dropdown: the title and the captured
    // scalar follow; the displayed run is now stale (its config differs from
    // the live model).
    await selectRunFromTitle(page, "Run 1");
    await expectRunTitle(page, "Run 1");
    const run1Value = await page
      .locator('[data-testid^="plot-channel-ch"]')
      .first()
      .textContent();
    expect(run1Value).not.toBe(run2Value);
    await expect(
      page.locator('[data-testid="channel-explorer-stale"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="results-stale-banner"]'),
    ).toBeVisible();
    // The critical banner renders ABOVE the plots panel (never obscured).
    const bannerBox = await page
      .locator('[data-testid="results-stale-banner"]')
      .boundingBox();
    const panelBox = await page
      .locator('[data-testid="channel-explorer"]')
      .boundingBox();
    expect(bannerBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    expect(bannerBox!.y + bannerBox!.height).toBeLessThanOrEqual(
      panelBox!.y + 1,
    );

    // Back to Run 2; stale clears.
    await selectRunFromTitle(page, "Run 2");
    await expectRunTitle(page, "Run 2");
    await expect(
      page.locator('[data-testid="results-stale-banner"]'),
    ).toHaveCount(0);

    // Runs disclosure: rename the newest run (the title follows the
    // selection), pin the older run as baseline (title baseline pill), and
    // delete the renamed run (the title falls back to the remaining run).
    await openAnalysisSection(page, "runs");
    const items = page.locator('[data-testid="run-history-item"]');
    await expect(items).toHaveCount(2);

    const nameInput = items.nth(0).locator('[data-testid="run-history-name"]');
    await nameInput.fill("High pressure");
    await nameInput.blur();
    await expectRunTitle(page, "High pressure");

    await items.nth(1).locator('[data-testid="pin-baseline"]').click();
    await expect(
      page.locator('[data-testid="baseline-indicator"]'),
    ).toContainText("Baseline: Run 1");
    await expect(page.locator('[data-testid="run-title-baseline"]')).toHaveText(
      "Baseline: Run 1",
    );
    // A plot overlays that baseline as a dashed companion series.
    await page
      .locator('[data-testid="plot-channel-preset"]')
      .selectOption("node-pressure");
    await expect(
      page.locator('[data-testid^="chart-legend-item-baseline:"]').first(),
    ).toBeVisible();

    await items.nth(0).locator('[data-testid="run-history-delete"]').click();
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await expect(page.locator('[data-testid="run-history-item"]')).toHaveCount(
      1,
    );
    await expectRunTitle(page, "Run 1");
    // The pinned baseline survives the deletion of the other run.
    await expect(page.locator('[data-testid="run-title-baseline"]')).toHaveText(
      "Baseline: Run 1",
    );

    consoleWatcher.assertNoErrors();
  });

  test("3. Transient run: a time axis, presets fill the plot, no time bar — hover tooltip reads any time", async ({
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

    // A transient run opens on an empty plot with a time axis; the preset
    // control fills it with every node pressure (tank + ambient).  The legacy
    // Full-network charts disclosure is gone.
    await page.locator('[data-testid="results-tab"]').click();
    await expect(page.locator('[data-testid="plot-x-axis"]')).toHaveValue(
      "time",
    );
    await page
      .locator('[data-testid="plot-channel-preset"]')
      .selectOption("node-pressure");
    const pressureChart = page.locator('[data-testid="plot-chart"]');
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
    // Values are read by hovering the chart (asserted below), so there is no
    // separate readout strip competing for space.
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

    // The preset control fills the plot: temperatures, then mass flow (one
    // series for the single orifice branch).
    await page
      .locator('[data-testid="plot-channel-preset"]')
      .selectOption("node-solid-temperature");
    const tempChart = page.locator('[data-testid="plot-chart"]');
    await expect(tempChart.locator(".chart-y-axis-label")).toContainText(
      "Temperature",
    );
    await expect(tempChart.locator("polyline")).toHaveCount(2);

    await page
      .locator('[data-testid="plot-channel-preset"]')
      .selectOption("branch-mdot");
    const mdotChart = page.locator('[data-testid="plot-chart"]');
    await expect(mdotChart.locator(".chart-y-axis-label")).toContainText(
      "Mass flow",
    );
    await expect(mdotChart.locator("polyline")).toHaveCount(1);
    await expect(
      mdotChart.locator('[data-testid^="chart-legend-item-"]', {
        hasText: "Orifice",
      }),
    ).toBeVisible();

    // Back to pressures for the cursor assertions.
    await page
      .locator('[data-testid="plot-channel-preset"]')
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

    // ~700px: the rail stacks above the plot column and the full-width chart
    // still fits the results view without horizontal overflow.
    await page.setViewportSize({ width: 700, height: 600 });
    await expect(
      page.locator('[data-testid="plot-channel-picker"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="plot-chart"]')).toBeVisible();
    const overflow = await page
      .locator('[data-testid="results-view"]')
      .evaluate((el: HTMLElement) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1280, height: 720 });

    consoleWatcher.assertNoErrors();
  });

  test("4. Building a plot and inspecting time never mutate the model or autosave", async ({
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

    // Explore from the picker: search narrows the inventory, grouping
    // re-buckets it, then pick a channel and inspect time via the chart
    // (there is no Analysis time bar — hover shows values at any time, a
    // plain click commits the shared cursor).
    await page.locator('[data-testid="results-tab"]').click();
    await page.locator('[data-testid="plot-channel-search"]').fill("Tank");
    await expect(
      page.locator('[data-testid^="plot-channel-ch"]').first(),
    ).toBeVisible();
    await page.locator('[data-testid="plot-channel-search"]').fill("");
    await page.locator('[data-testid="plot-channel-sort"]').click();
    await page.locator('[data-testid="plot-channel-sort-element"]').click();
    await page.locator('[data-testid^="plot-channel-ch"]').first().click();
    await expect(
      page.locator('[data-testid="channel-explorer-time"]'),
    ).toHaveCount(0);
    const focusSvg = page.locator('[data-testid="plot-chart"] svg');
    await expect(focusSvg).toBeVisible();
    const focusBox = await focusSvg.boundingBox();
    expect(focusBox).not.toBeNull();
    await focusSvg.hover({ position: { x: 90, y: 60 } });
    await expect(page.locator('[data-testid="chart-tooltip"]')).toBeVisible();
    await focusSvg.click({ position: { x: 90, y: 60 } });

    // Picking a channel selects its element, which is a store write, not a
    // model edit.
    await page.locator('[data-testid="editor-tab"]').click();
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
  test("5. One plot, several axes: station, position and element order", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    await page.waitForTimeout(400);
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
      { timeout: 15000 },
    );
    await page.locator('[data-testid="results-tab"]').click();

    // ── A plot is an axis and some channels ─────────────────────────────
    // Nothing is drawn until the analyst says what they came for.
    await expect(
      page.locator('[data-testid="plot-no-channels"]'),
    ).toBeVisible();
    await page
      .locator('[data-testid="plot-channel-preset"]')
      .selectOption("node-pressure");

    // Station axis: the three node pressures collapse into ONE line across
    // the network — a grade line, not three flat one-point lines.
    await expect(page.locator('[data-testid="plot-x-axis"]')).toHaveValue(
      "station",
    );
    const chart = page.locator('[data-testid="plot-chart"]');
    await expect(chart).toBeVisible();
    await expect(chart.locator("polyline")).toHaveCount(1);
    const points = await chart
      .locator("polyline")
      .first()
      .getAttribute("points");
    expect(points?.trim().split(/\s+/).length).toBe(3);
    // The pipes carry lengths, so the axis is a real distance, not the
    // ordinal fallback.
    await expectXAxisLabel(page, "Station along path");
    await expect(page.locator('[data-testid="plot-ordinal-note"]')).toHaveCount(
      0,
    );
    // A tee offers one path per outlet.
    await expect(
      page.locator('[data-testid="plot-path"]').locator("option"),
    ).toHaveCount(2);

    // Switching the axis re-plots the same channels against something else.
    await page.locator('[data-testid="plot-x-axis"]').selectOption("positionX");
    await expectXAxisLabel(page, "Position X");
    await page.locator('[data-testid="plot-x-axis"]').selectOption("index");
    await expectXAxisLabel(page, "Element order");
    await expect(
      page.locator('[data-testid="plot-ordinal-note"]'),
    ).toBeVisible();

    // A per-component quantity is drawn as stairs: more vertices than points.
    await page.locator('[data-testid="plot-x-axis"]').selectOption("station");
    await page
      .locator('[data-testid="plot-channel-preset"]')
      .selectOption("branch-mdot");
    const mdotPoints = await chart
      .locator("polyline")
      .first()
      .getAttribute("points");
    expect(mdotPoints?.trim().split(/\s+/).length).toBeGreaterThan(2);

    // Search narrows the inventory and a row adds its channel to the plot.
    await page.locator('[data-testid="plot-channel-search"]').fill("out1");
    const pickerRows = page.locator('[data-testid^="plot-channel-ch"]');
    await expect(pickerRows.first()).toBeVisible();
    await pickerRows.first().click();
    await expect(pickerRows.first()).toHaveAttribute("aria-pressed", "true");

    consoleWatcher.assertNoErrors();
  });

  test("6. Plots are independent tabs that survive leaving the Runs tab", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    await page.waitForTimeout(400);
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
      { timeout: 15000 },
    );
    await page.locator('[data-testid="results-tab"]').click();

    const tabs = page.locator('[data-testid^="plot-tab-"]');
    // A fresh run opens on ONE empty plot; the only plot cannot be closed.
    await expect(tabs).toHaveCount(1);
    await expect(page.locator('[data-testid^="plot-close-"]')).toHaveCount(0);

    // Fill plot 1 and let it name itself from what it draws.
    await page
      .locator('[data-testid="plot-channel-preset"]')
      .selectOption("node-pressure");
    await expect(tabs.first()).toContainText("Pressure");
    // What is plotted is stated at the top of the picker, so it is also what
    // we compare after visiting another plot.
    const plottedHeading = page
      .locator(
        '[data-testid="plot-channel-picker"] .channel-rail__group--plotted',
      )
      .first();
    const plotOnePlotted = await plottedHeading.textContent();

    // A second plot starts empty and independent.
    await page.locator('[data-testid="plot-add"]').click();
    await expect(tabs).toHaveCount(2);
    await expect(
      page.locator('[data-testid="plot-no-channels"]'),
    ).toBeVisible();

    // Give it a different axis and its own channels.
    await page.locator('[data-testid="plot-x-axis"]').selectOption("index");
    await page
      .locator('[data-testid="plot-channel-preset"]')
      .selectOption("branch-mdot");
    await expect(page.locator('[data-testid="plot-chart"]')).toBeVisible();

    // Back to plot 1: its axis and channels are untouched.
    await tabs.first().click();
    await expect(page.locator('[data-testid="plot-x-axis"]')).toHaveValue(
      "station",
    );
    await expect(plottedHeading).toHaveText(plotOnePlotted!);

    // The element-type filter narrows the picker; "All types" restores it.
    await page.locator('[data-testid="plot-channel-filter"]').click();
    await page.locator('[data-testid="plot-channel-filter-branch"]').click();
    const branchOnly = await page
      .locator('[data-testid^="plot-channel-ch"]')
      .count();
    expect(branchOnly).toBeGreaterThan(0);
    await page.locator('[data-testid="plot-channel-filter"]').click();
    await page.locator('[data-testid="plot-channel-filter-all"]').click();
    const allRows = await page
      .locator('[data-testid^="plot-channel-ch"]')
      .count();
    expect(allRows).toBeGreaterThan(branchOnly);

    // Renaming a tab stops the auto-naming from fighting the user.
    await tabs.first().dblclick();
    await page.locator('[data-testid="plot-rename"]').fill("Feed line");
    await page.locator('[data-testid="plot-rename"]').press("Enter");
    await expect(tabs.first()).toContainText("Feed line");

    // Plots live in the store, so the canvas round trip does not lose them.
    await page.locator('[data-testid="editor-tab"]').click();
    await page.locator('[data-testid="results-tab"]').click();
    await expect(tabs).toHaveCount(2);
    await expect(tabs.first()).toContainText("Feed line");

    // Closing a tab lands on its neighbour rather than on nothing.
    await page.locator('[data-testid^="plot-close-"]').last().click();
    await expect(tabs).toHaveCount(1);

    consoleWatcher.assertNoErrors();
  });

  test("7. Two runs on one plot: the design comparison the history exists for", async ({
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

    // A second design: a different inlet pressure, so the two runs differ.
    await page.locator('[data-testid="editor-tab"]').click();
    await page.locator('[data-testid="node-in"]').click();
    const pressureInput = page
      .getByRole("textbox", { name: /^Pressure \(/ })
      .first();
    await pressureInput.click();
    await pressureInput.fill("250000");
    await pressureInput.press("Enter");
    await page.waitForTimeout(300);
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
      { timeout: 15000 },
    );

    await page.locator('[data-testid="results-tab"]').click();
    await page
      .locator('[data-testid="plot-channel-preset"]')
      .selectOption("node-pressure");
    const chart = page.locator('[data-testid="plot-chart"]');
    await expect(chart).toBeVisible();
    const soloSeries = await chart.locator("polyline").count();
    expect(soloSeries).toBeGreaterThan(0);

    // Run 1 is offered as an overlay; the displayed run is named but fixed.
    await expect(
      page.locator('[data-testid="plot-compare-primary"]'),
    ).toContainText("Run 2");
    const add = page.locator('[data-testid="plot-compare-add"]');
    await add.selectOption({ label: "Run 1" });

    // Both designs are now on the SAME axes: same channels, twice the lines,
    // each labelled with the run it came from.
    await expect(
      page.locator('[data-testid^="plot-compare-chip-"]').first(),
    ).toContainText("Run 1");
    await expect(chart.locator("polyline")).toHaveCount(soloSeries * 2);
    await expect(
      chart
        .locator('[data-testid^="chart-legend-item-"]', {
          hasText: "Run 1",
        })
        .first(),
    ).toBeVisible();
    await expect(
      chart
        .locator('[data-testid^="chart-legend-item-"]', {
          hasText: "Run 2",
        })
        .first(),
    ).toBeVisible();

    // The comparison belongs to THIS plot, not to the tab: a new plot opens
    // reading the displayed run alone.
    await page.locator('[data-testid="plot-add"]').click();
    await page
      .locator('[data-testid="plot-channel-preset"]')
      .selectOption("node-pressure");
    await expect(chart.locator("polyline")).toHaveCount(soloSeries);

    // Back on the first plot the overlay survived, and can be dropped.
    await page.locator('[data-testid^="plot-tab-"]').first().click();
    await expect(chart.locator("polyline")).toHaveCount(soloSeries * 2);
    await page.locator('[data-testid^="plot-compare-remove-"]').first().click();
    await expect(chart.locator("polyline")).toHaveCount(soloSeries);

    consoleWatcher.assertNoErrors();
  });
});
