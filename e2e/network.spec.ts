/**
 * e2e/network.spec.ts — core application smoke and feature coverage:
 * app load without console errors; steady/transient example runs converging
 * with result tables, charts, and on-canvas labels; build/edit/drag-connect
 * flows; autosave and save/load persistence (incl. subnetwork grouping);
 * validation-error surfacing; settings dialog and unit-preset switching
 * (US units in inputs, axes, and tooltips); thermal palette and conjugate
 * heat transfer; the real-fluid cryogenic chilldown example; long/adaptive
 * transient runs (progress, cancel-retains-partial, dt readout); color-by
 * temperature/mass-flow with time scrubber; Model Table, run history, and
 * schedule editor; palette/map chrome; custom components; and the text
 * model editor (apply, diagnostics, revert, selection sync).
 */
import { test, expect, Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { openAnalysisSection } from "./analysis";

function attachConsoleWatcher(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(msg.text());
    }
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

/** Extract the `data: {…}` JSON payload of the first line starting with `prefix`. */
function recordData(fnText: string, prefix: string): any {
  const line = fnText.split("\n").find((l) => l.startsWith(prefix));
  expect(
    line,
    `expected a record line starting with ${JSON.stringify(prefix)}`,
  ).toBeTruthy();
  return JSON.parse(line!.slice(line!.indexOf("data:") + 5));
}

async function connectWith(
  page: Page,
  sourceId: string,
  targetId: string,
  choice: string,
) {
  const source = page.locator(`[data-testid="node-${sourceId}"]`);
  const target = page.locator(`[data-testid="node-${targetId}"]`);
  await source
    .locator('[data-testid="handle-bottom"]')
    .dragTo(target.locator('[data-testid="handle-top"]'));
  const chooser = page.getByRole("dialog", { name: "Choose connection type" });
  await expect(chooser).toBeVisible();
  await chooser.getByRole("button", { name: choice, exact: true }).click();
}

function propertyField(page: Page, label: string) {
  return page
    .getByRole("textbox", { name: new RegExp(`^${label} \\(`) })
    .first();
}

async function editPropertyField(page: Page, label: string, value: string) {
  const field = propertyField(page, label);
  await field.click();
  await field.fill(value);
  await field.press("Enter");
  return field;
}

function selectionAction(page: Page, name: string) {
  return page
    .getByRole("toolbar", { name: "Selection actions" })
    .getByRole("button", { name, exact: true });
}

test.describe("OpenFLUME E2E", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Reset units to SI default so existing assertions that hard-code SI inputs work
    await page.evaluate(() => {
      localStorage.removeItem("fluids-network-units-v1");
    });
    await page.reload();
  });

  test("1. App loads without console errors", async ({ page }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await expect(page.locator('[data-testid="toolbar"]')).toBeVisible();
    await expect(
      page.getByRole("group", { name: "Model builder tools" }),
    ).toBeVisible();
    await expect(page.locator('[data-testid="flow-canvas"]')).toBeVisible();

    // Give React a moment to settle and any lazy async work to finish
    await page.waitForTimeout(500);
    consoleWatcher.assertNoErrors();
  });

  test("2. Steady example run converges and shows results", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Load example
    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    await page.waitForTimeout(300);

    // Run
    await page.locator('[data-testid="toolbar-run"]').click();

    // Assert convergence status
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    // Run no longer auto-switches tabs; the steady result tables live in the
    // closed "Result tables" disclosure of the redesigned Analysis view.
    await page.locator('[data-testid="results-tab"]').click();
    await openAnalysisSection(page, "final");
    await expect(
      page.locator('[data-testid="steady-branches-table"]'),
    ).toBeVisible();

    const mdotCells = page.locator('[data-testid^="mdot-b"]');
    const count = await mdotCells.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const text = await mdotCells.nth(i).textContent();
      const val = parseFloat(text || "0");
      expect(Math.abs(val)).toBeGreaterThan(0);
    }

    // Scrollability: results should be taller than viewport when shrunk
    await page.setViewportSize({ width: 800, height: 400 });
    const resultsView = page.locator('[data-testid="results-view"]');
    const scrollHeight = await resultsView.evaluate(
      (el: HTMLElement) => el.scrollHeight,
    );
    const clientHeight = await resultsView.evaluate(
      (el: HTMLElement) => el.clientHeight,
    );
    expect(scrollHeight).toBeGreaterThan(clientHeight);
    await page.setViewportSize({ width: 1280, height: 720 });

    // Switch back to Editor to assert on-canvas labels
    await page.locator('[data-testid="editor-tab"]').click();
    await expect(page.locator('[data-testid="node-result-in"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-result-j"]')).toBeVisible();

    consoleWatcher.assertNoErrors();
  });

  test("3. Transient example run shows charts and converges", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Tank blowdown");
    await page.waitForTimeout(300);

    await page.locator('[data-testid="toolbar-run"]').click();

    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    // Run no longer auto-switches tabs; full-network charts are the
    // explorer's aggregate presets — the default node-pressure view needs
    // no disclosure once we're on the Results tab.
    await page.locator('[data-testid="results-tab"]').click();
    const pressureChart = page.locator(
      '[data-testid="channel-explorer-chart"]',
    );
    await expect(pressureChart).toBeVisible();
    // The branch mass-flow view is one dropdown switch away.
    await page
      .locator('[data-testid="channel-explorer-view"]')
      .selectOption("branch-mdot");
    await expect(
      page.locator('[data-testid="channel-explorer-chart"]'),
    ).toBeVisible();
    await page
      .locator('[data-testid="channel-explorer-view"]')
      .selectOption("node-pressure");

    // Combined charts contain at least one polyline with >10 points
    const polylines = pressureChart.locator("polyline");
    await expect(polylines).toHaveCount(2); // tank + ambient
    const pointsAttr = await polylines.first().getAttribute("points");
    const pointCount = pointsAttr?.trim().split(/\s+/).length ?? 0;
    expect(pointCount).toBeGreaterThan(10);

    // --- Interactions ---
    // Raw mouse coordinates need the chart scrolled inside the viewport first.
    await pressureChart.scrollIntoViewIfNeeded();
    const chartBox = await pressureChart.boundingBox();
    expect(chartBox).not.toBeNull();

    // Hover → tooltip with time readout
    await page.mouse.move(
      chartBox!.x + chartBox!.width / 2,
      chartBox!.y + chartBox!.height / 2,
    );
    await expect(page.locator('[data-testid="chart-tooltip"]')).toBeVisible();
    const tooltipText = await page
      .locator('[data-testid="chart-tooltip"]')
      .textContent();
    expect(tooltipText).toMatch(/t\s*=.*/);

    // Click legend item → series hides
    const legendItem = pressureChart.locator(
      '[data-testid^="chart-legend-item-"]',
      { hasText: "Tank" },
    );
    await legendItem.click();
    const visiblePolylines = pressureChart.locator("polyline");
    await expect(visiblePolylines).toHaveCount(1);
    // Show it again so later assertions are on full data
    await legendItem.click();
    await expect(visiblePolylines).toHaveCount(2);

    // Re-measure: the legend clicks above may have auto-scrolled the results
    // view (Playwright scrolls clicked elements into view), so the cached
    // bounding box is stale.
    const chartBox2 = await pressureChart.boundingBox();
    expect(chartBox2).not.toBeNull();

    // Drag-zoom a region (middle 50% of plot area)
    const initialDomain = await pressureChart.getAttribute("data-domain");
    const plotLeft = chartBox2!.x + 64; // MARGIN.left
    const plotWidth = chartBox2!.width - 64 - 16; // innerWidth
    await page.mouse.move(plotLeft + plotWidth * 0.25, chartBox2!.y + 100);
    await page.mouse.down();
    await page.mouse.move(plotLeft + plotWidth * 0.75, chartBox2!.y + 100, {
      steps: 5,
    });
    await page.mouse.up();
    const zoomedDomain = await pressureChart.getAttribute("data-domain");
    expect(zoomedDomain).not.toEqual(initialDomain);

    // Double-click resets zoom
    await pressureChart.dblclick();
    const resetDomain = await pressureChart.getAttribute("data-domain");
    expect(resetDomain).toEqual(initialDomain);

    consoleWatcher.assertNoErrors();
  });

  test("4. Editing flow: build and run a simple network", async ({ page }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Start fresh
    await page.locator('[data-testid="toolbar-new"]').click();
    // New now asks for confirmation before wiping the model
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);

    // Add two boundary nodes
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);

    // Select first boundary node and set pressure to 200000
    await page.locator('[data-testid="node-B1"]').click();
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Node: B1",
    );
    await editPropertyField(page, "Pressure", "200000");
    await page.waitForTimeout(200);

    // Select second boundary node and set pressure to 100000
    await page.locator('[data-testid="node-B2"]').click();
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Node: B2",
    );
    await editPropertyField(page, "Pressure", "100000");
    await page.waitForTimeout(200);

    await connectWith(page, "B1", "B2", "Pipe");
    await page.waitForTimeout(300);

    await expect(
      page.locator('[data-testid="branch-type-select"]'),
    ).toHaveValue("pipe");

    await page.locator('[data-testid="toolbar-run"]').click();

    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    // Assert nonzero flow in results (Result tables disclosure)
    await page.locator('[data-testid="results-tab"]').click();
    await openAnalysisSection(page, "final");
    await expect(
      page.locator('[data-testid="steady-branches-table"]'),
    ).toBeVisible();

    const mdotCell = page.locator('[data-testid^="mdot-"]').first();
    const mdotText = await mdotCell.textContent();
    const mdotVal = parseFloat(mdotText || "0");
    expect(Math.abs(mdotVal)).toBeGreaterThan(0);

    consoleWatcher.assertNoErrors();
  });

  test("5. Persistence: autosave survives reload", async ({ page }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page.locator('[data-testid="toolbar-new"]').click();
    // New now asks for confirmation before wiping the model
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);

    // Add a boundary node
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(300);

    // Verify it exists
    await expect(page.locator('[data-testid="node-B1"]')).toBeVisible();

    // Reload
    await page.reload();
    await page.waitForTimeout(500);

    // Node should be restored
    await expect(page.locator('[data-testid="node-B1"]')).toBeVisible();

    consoleWatcher.assertNoErrors();
  });

  test("6. Save/Load round-trip", async ({ page }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Load a built-in example (valid network with nodes & branches)
    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    await page.waitForTimeout(300);

    // Save (the user-facing format is the .fn text projection)
    const fnText = await captureTextDownload(page, async () => {
      await page.locator('[data-testid="toolbar-save"]').click();
    });

    // Validate shape: header, network line, one record per entity
    expect(fnText.startsWith("// Fluid Network config v2\n")).toBe(true);
    expect(fnText).toContain('network "Three-pipe junction" {');
    expect(fnText.match(/^node "/gm)?.length).toBe(4);
    expect(fnText.match(/^branch "/gm)?.length).toBe(3);

    // Write to a temp .fn file for upload
    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `network-${Date.now()}.fn`);
    fs.writeFileSync(tmpFile, fnText);

    // New network
    await page.locator('[data-testid="toolbar-new"]').click();
    // New now asks for confirmation before wiping the model
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);

    // Verify empty
    await expect(page.locator('[data-testid="node-in"]')).not.toBeVisible();

    // Load the saved .fn file via hidden input
    await page
      .locator('[data-testid="toolbar-load-input"]')
      .setInputFiles(tmpFile);
    await page.waitForTimeout(800);

    // Assert nodes restored
    await expect(page.locator('[data-testid="node-in"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-j"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-out1"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-out2"]')).toBeVisible();

    // Cleanup
    fs.unlinkSync(tmpFile);

    consoleWatcher.assertNoErrors();
  });

  test("7. Validation errors for invalid network", async ({ page }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page.locator('[data-testid="toolbar-new"]').click();
    // New now asks for confirmation before wiping the model
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);

    // Add a single internal node (no boundaries, no branches)
    await page.locator('[data-testid="add-internal-node"]').click();
    await page.waitForTimeout(300);

    // Run
    await page.locator('[data-testid="toolbar-run"]').click();

    // Assert visible error message
    await expect(page.locator('[data-testid="toolbar-error"]')).toBeVisible({
      timeout: 5000,
    });
    const errorText = await page
      .locator('[data-testid="toolbar-error"]')
      .textContent();
    expect(errorText).toBeTruthy();
    expect(errorText!.length).toBeGreaterThan(0);

    // Assert no crash: canvas still visible
    await expect(page.locator('[data-testid="flow-canvas"]')).toBeVisible();

    consoleWatcher.assertNoErrors();
  });

  test("8. Settings dialog persistence", async ({ page }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Open settings
    await page.locator('[data-testid="toolbar-settings"]').click();
    await expect(page.locator('[data-testid="settings-dialog"]')).toBeVisible();

    // Switch to transient, set dt and endTime
    await page
      .locator('[data-testid="settings-mode"]')
      .selectOption("transient");
    // Wait for transient inputs to appear
    await expect(
      page.locator('label:has-text("Time Step") + input'),
    ).toBeVisible();
    await page.locator('label:has-text("Time Step") + input').fill("0.02");
    await page.locator('label:has-text("End Time") + input').fill("2.5");
    await page.locator('label:has-text("End Time") + input').blur();

    // Close via Escape
    await page.keyboard.press("Escape");
    await expect(
      page.locator('[data-testid="settings-dialog"]'),
    ).not.toBeVisible();

    // Reopen and assert values persisted
    await page.locator('[data-testid="toolbar-settings"]').click();
    await expect(page.locator('[data-testid="settings-dialog"]')).toBeVisible();
    await expect(page.locator('[data-testid="settings-mode"]')).toHaveValue(
      "transient",
    );
    await expect(
      page.locator('label:has-text("Time Step") + input'),
    ).toHaveValue("0.02");
    await expect(
      page.locator('label:has-text("End Time") + input'),
    ).toHaveValue("2.5");

    consoleWatcher.assertNoErrors();
  });

  test("9. Drag-connect with visible handles", async ({ page }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Start fresh
    await page.locator('[data-testid="toolbar-new"]').click();
    // New now asks for confirmation before wiping the model
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);

    // Add two boundary nodes
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);

    // Handles open the connection chooser directly.
    const sourceHandle = page
      .locator('[data-testid="node-B1"] [data-testid="handle-bottom"]')
      .first();
    const targetHandle = page
      .locator('[data-testid="node-B2"] [data-testid="handle-top"]')
      .first();
    await expect(sourceHandle).toBeVisible();
    await expect(targetHandle).toBeVisible();
    await sourceHandle.dragTo(targetHandle, { timeout: 5000 });
    const chooser = page.getByRole("dialog", {
      name: "Choose connection type",
    });
    await chooser.getByRole("button", { name: "Valve", exact: true }).click();
    await page.waitForTimeout(500);

    // The new branch should be auto-selected
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Branch:",
    );

    consoleWatcher.assertNoErrors();
  });

  test("10. Unit switching: US preset converts inputs and results", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Load a steady example with known boundary pressure 101325 Pa
    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Tank blowdown");
    await page.waitForTimeout(300);

    // Switch to SI first to ensure base state
    await page
      .locator('[data-testid="toolbar-unit-preset"]')
      .selectOption("SI");
    await page.waitForTimeout(200);

    // Switch to US customary via toolbar quick-switcher
    await page
      .locator('[data-testid="toolbar-unit-preset"]')
      .selectOption("US customary");
    await page.waitForTimeout(300);

    // Select ambient boundary node (101325 Pa)
    await page.locator('[data-testid="node-ambient"]').click();
    await expect(page.locator('[data-testid="property-panel"]')).toBeVisible();

    // Assert label shows psi and value is approximately 14.696
    const pressureLabel = page.locator('label:has-text("Pressure")');
    await expect(pressureLabel).toContainText("psi");
    const pressureInput = propertyField(page, "Pressure");
    const displayedValue = await pressureInput.textContent();
    expect(parseFloat(displayedValue ?? "")).toBeCloseTo(14.696, 2);

    // Edit the field in psi and assert the saved config stores correct SI Pa
    await editPropertyField(page, "Pressure", "20");
    await page.waitForTimeout(200);

    // Save and verify the .fn text projection contains the correct SI value
    const fnText = await captureTextDownload(page, async () => {
      await page.locator('[data-testid="toolbar-save"]').click();
    });
    const ambientData = recordData(fnText, 'node "ambient" ');
    expect(ambientData.pressure).toBeCloseTo(20 * 6894.757293168, 0);

    // Run steady (example is transient, switch to steady)
    await page.locator('[data-testid="toolbar-settings"]').click();
    await expect(page.locator('[data-testid="settings-dialog"]')).toBeVisible();
    await page.locator('[data-testid="settings-mode"]').selectOption("steady");
    await page.keyboard.press("Escape");
    await expect(
      page.locator('[data-testid="settings-dialog"]'),
    ).not.toBeVisible();
    await page.waitForTimeout(200);

    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    // Results table header should show psi (Result tables disclosure)
    await page.locator('[data-testid="results-tab"]').click();
    await openAnalysisSection(page, "final");
    await expect(
      page.locator('[data-testid="steady-nodes-table"]'),
    ).toBeVisible();
    const headerCell = page.locator('th:has-text("Pressure")').first();
    await expect(headerCell).toContainText("psi");

    // Switch back to SI and assert values revert losslessly
    await page
      .locator('[data-testid="toolbar-unit-preset"]')
      .selectOption("SI");
    await page.waitForTimeout(300);

    // Go back to editor tab to access the node
    await page.locator('[data-testid="editor-tab"]').click();
    await expect(page.locator('[data-testid="node-ambient"]')).toBeVisible();

    await page.locator('[data-testid="node-ambient"]').click();
    const siInput = propertyField(page, "Pressure");
    const siValue = await siInput.textContent();
    expect(parseFloat(siValue ?? "")).toBeCloseTo(20 * 6894.757293168, 0);

    consoleWatcher.assertNoErrors();
  });

  test("11. Transient chart axis/tooltip shows selected units", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Tank blowdown");
    await page.waitForTimeout(300);

    // Switch to US customary
    await page
      .locator('[data-testid="toolbar-unit-preset"]')
      .selectOption("US customary");
    await page.waitForTimeout(200);

    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    // Full-network charts are the explorer's aggregate presets; the default
    // node-pressure view renders without opening any disclosure.
    await page.locator('[data-testid="results-tab"]').click();
    const pressureChart = page.locator(
      '[data-testid="channel-explorer-chart"]',
    );
    await expect(pressureChart).toBeVisible();

    // Chart header shows the resolved unit: "Pressure (psi) vs Time (s)"
    // (Wave 2: axis title moved out of the SVG tick column into the header)
    await expect(pressureChart.locator(".chart-title")).toContainText(
      "Pressure (psi)",
    );

    // Hover chart → tooltip should show psi.
    await pressureChart.scrollIntoViewIfNeeded();
    const chartBox = await pressureChart.boundingBox();
    expect(chartBox).not.toBeNull();
    await page.mouse.move(
      chartBox!.x + chartBox!.width / 2,
      chartBox!.y + chartBox!.height / 2,
    );
    await expect(page.locator('[data-testid="chart-tooltip"]')).toBeVisible();
    const tooltipText = await page
      .locator('[data-testid="chart-tooltip"]')
      .textContent();
    expect(tooltipText).toMatch(/psi/);

    consoleWatcher.assertNoErrors();
  });

  test("12. Subnetwork grouping: create, open tab, add node inside", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page.locator('[data-testid="toolbar-new"]').click();
    // New now asks for confirmation before wiping the model
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);

    // Add two boundary nodes
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);

    // One selected node exposes a disabled group action.
    await page.locator('[data-testid="node-B1"]').click();
    await page.waitForTimeout(200);
    await expect(selectionAction(page, "Create subnetwork")).toBeDisabled();

    // Multi-select both nodes (Shift-click)
    await page
      .locator('[data-testid="node-B2"]')
      .click({ modifiers: ["Shift"] });
    await page.waitForTimeout(200);

    await expect(selectionAction(page, "Create subnetwork")).toBeEnabled();
    await selectionAction(page, "Create subnetwork").click();
    await page.waitForTimeout(500);

    // Container should appear with a member count and a Subnetwork badge
    const container = page.locator('[data-testid^="group-"]').first();
    await expect(container).toBeVisible();
    await expect(container).toContainText("Subnetwork");
    await expect(container).toContainText("2 members");

    // Visible Open button opens the group tab (double-click also works)
    await page.locator('[data-testid^="open-subnetwork-"]').first().click();
    await page.waitForTimeout(500);

    // A group tab should appear and be active
    const groupTab = page.locator('[data-testid^="group-tab-"]').first();
    await expect(groupTab).toBeVisible();

    // Add a node inside the group tab
    await page.locator('[data-testid="add-internal-node"]').click();
    await page.waitForTimeout(300);

    // Should show the member node (B1) and the new internal node
    await expect(page.locator('[data-testid="node-B1"]')).toBeVisible();

    consoleWatcher.assertNoErrors();
  });

  test("13. Cross-boundary branch via property panel retargeting", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page.locator('[data-testid="toolbar-new"]').click();
    // New now asks for confirmation before wiping the model
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);

    // Add three boundary nodes at explicit non-overlapping positions (x>200 avoids palette, y=400 avoids toolbar/tabs)
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="node-B1"]').click();
    await editPropertyField(page, "X", "300");
    await editPropertyField(page, "Y", "400");
    await page.waitForTimeout(200);

    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="node-B2"]').click();
    await editPropertyField(page, "X", "500");
    await editPropertyField(page, "Y", "400");
    await page.waitForTimeout(200);

    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="node-B3"]').click();
    await editPropertyField(page, "X", "700");
    await editPropertyField(page, "Y", "400");
    await page.waitForTimeout(200);

    // A fourth node so B1 can be grouped (subnetworks require 2+ members)
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="node-B4"]').click();
    await editPropertyField(page, "X", "300");
    await editPropertyField(page, "Y", "560");
    await page.waitForTimeout(200);

    // Create a pipe from B2 to B3 before grouping changes canvas geometry.
    await connectWith(page, "B2", "B3", "Pipe");

    // Subnetwork of B1 + B4 (multi-select via Shift-click)
    await page.locator('[data-testid="node-B1"]').click();
    await page.waitForTimeout(200);
    await page
      .locator('[data-testid="node-B4"]')
      .click({ modifiers: ["Shift"] });
    await page.waitForTimeout(200);
    await selectionAction(page, "Create subnetwork").click();
    await page.waitForTimeout(500);

    // Open the new branch through the table to avoid collapsed-group overlap.
    await page.locator('[data-testid="canvas-table-view"]').click();
    await page.locator('[data-testid="mt-open-b1"]').click();

    // Now retarget the branch To endpoint to B1 (inside the group) via the property panel dropdown
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Branch:",
    );
    await page.locator('[data-testid="branch-to-select"]').selectOption("B1");
    await page.waitForTimeout(300);

    // Verify the cross-boundary connection via dropdown values
    await expect(
      page.locator('[data-testid="branch-from-select"]'),
    ).toHaveValue("B2");
    await expect(page.locator('[data-testid="branch-to-select"]')).toHaveValue(
      "B1",
    );

    consoleWatcher.assertNoErrors();
  });

  test("14. Grouped network solves identically and grouping persists save/load", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page.locator('[data-testid="toolbar-new"]').click();
    // New now asks for confirmation before wiping the model
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);

    // Build a simple network: B1 --pipe-- B2
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="node-B1"]').click();
    await editPropertyField(page, "X", "300");
    await editPropertyField(page, "Y", "400");
    await editPropertyField(page, "Pressure", "200000");
    await page.waitForTimeout(200);

    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="node-B2"]').click();
    await editPropertyField(page, "X", "500");
    await editPropertyField(page, "Y", "400");
    await editPropertyField(page, "Pressure", "100000");
    await page.waitForTimeout(200);

    await connectWith(page, "B1", "B2", "Pipe");
    await page.waitForTimeout(300);

    // Group B1+B2 into a subnetwork (multi-select via Shift-click)
    await page.locator('[data-testid="node-B1"]').click();
    await page.waitForTimeout(200);
    await page
      .locator('[data-testid="node-B2"]')
      .click({ modifiers: ["Shift"] });
    await page.waitForTimeout(200);
    await selectionAction(page, "Create subnetwork").click();
    await page.waitForTimeout(500);

    // Solve
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    // Save
    const fnText = await captureTextDownload(page, async () => {
      await page.locator('[data-testid="toolbar-save"]').click();
    });

    expect(fnText.match(/^group "/gm)!.length).toBeGreaterThan(0);
    // At least one node record carries a group reference in its data payload.
    expect(
      fnText
        .split("\n")
        .some((l) => l.startsWith('node "') && l.includes('"group"')),
    ).toBe(true);

    // New network and load back
    await page.locator('[data-testid="toolbar-new"]').click();
    // New now asks for confirmation before wiping the model
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);
    // Ensure we're on the Editor tab so nodes are visible
    await page.locator('[data-testid="editor-tab"]').click();
    await page.waitForTimeout(200);

    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, `grouped-${Date.now()}.fn`);
    fs.writeFileSync(tmpFile, fnText);

    await page
      .locator('[data-testid="toolbar-load-input"]')
      .setInputFiles(tmpFile);
    await page.waitForTimeout(800);

    // Group container should be restored
    await expect(page.locator('[data-testid^="group-"]')).toBeVisible();

    fs.unlinkSync(tmpFile);

    consoleWatcher.assertNoErrors();
  });

  test("15. Heated pipe component UI", async ({ page }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page.locator('[data-testid="toolbar-new"]').click();
    // New now asks for confirmation before wiping the model
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);

    // Add two boundary nodes at explicit positions
    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="node-B1"]').click();
    await editPropertyField(page, "X", "300");
    await editPropertyField(page, "Y", "400");
    await editPropertyField(page, "Pressure", "200000");
    await page.waitForTimeout(200);

    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="node-B2"]').click();
    await editPropertyField(page, "X", "500");
    await editPropertyField(page, "Y", "400");
    await editPropertyField(page, "Pressure", "100000");
    await page.waitForTimeout(200);

    await connectWith(page, "B1", "B2", "Heated Pipe");
    await page.waitForTimeout(300);

    const typeSelect = page.locator('[data-testid="branch-type-select"]');
    await expect(typeSelect).toHaveValue("heatedPipe");

    // Set wall temperature
    await editPropertyField(page, "Wall Temperature", "350");
    await page.waitForTimeout(200);

    // Solve
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    consoleWatcher.assertNoErrors();
  });

  test("16. Conjugate heat transfer example: run and show solid temperatures", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Load the conjugate example
    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Heated pipe with radiating wall (conjugate HT)");
    await page.waitForTimeout(300);

    // Run
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    // Switch back to Editor to check canvas overlays
    await page.locator('[data-testid="editor-tab"]').click();
    await expect(page.locator('[data-testid="node-result-w1"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-result-w2"]')).toBeVisible();

    // Results tab should have solid nodes table (Result tables disclosure)
    await page.locator('[data-testid="results-tab"]').click();
    await openAnalysisSection(page, "final");
    await expect(
      page.locator('[data-testid="steady-solid-nodes-table"]'),
    ).toBeVisible();

    consoleWatcher.assertNoErrors();
  });

  test("17. Model rail: add thermal nodes and choose a conduction tie", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page.locator('[data-testid="toolbar-new"]').click();
    // New now asks for confirmation before wiping the model
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);

    await page.locator('[data-testid="add-solid-node"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="add-ambient-node"]').click();
    await page.waitForTimeout(200);

    await connectWith(page, "S1", "A1", "Conduction");
    await page.waitForTimeout(300);

    // The new conductor should be selected
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Conductor:",
    );

    // Set k via unit-aware input
    const kInput = await editPropertyField(page, "k", "50");
    await page.waitForTimeout(200);

    // Assert the input persisted
    await expect(kInput).toHaveText("50");

    // Assert the conductor edge exists on canvas by checking individual edge count
    const edgePaths = page.locator(".react-flow__edge");
    await expect(edgePaths).toHaveCount(1);

    consoleWatcher.assertNoErrors();
  });

  test("18. Real-fluid cryogenic chilldown example loads, runs, and renders charts", async ({
    page,
  }) => {
    test.setTimeout(120000);
    const consoleWatcher = attachConsoleWatcher(page);

    // Open settings and select real fluid
    await page.locator('[data-testid="toolbar-settings"]').click();
    await expect(page.locator('[data-testid="settings-dialog"]')).toBeVisible();

    await page
      .locator('[data-testid="settings-fluid-model"]')
      .selectOption("realFluid");
    await page.waitForTimeout(200);

    // Select Hydrogen (the NBS cryo-line example's LH₂ fluid)
    await page
      .locator('[data-testid="settings-real-fluid-name"]')
      .selectOption("Hydrogen");
    await page.waitForTimeout(200);

    // Close settings
    await page.keyboard.press("Escape");
    await expect(
      page.locator('[data-testid="settings-dialog"]'),
    ).not.toBeVisible();

    // Observe loading state resolves (generous timeout for WASM fetch)
    await expect(
      page.locator('[data-testid="toolbar-coolprop-status"]'),
    ).toBeVisible({ timeout: 30000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector(
          '[data-testid="toolbar-coolprop-status"]',
        );
        return !el || el.textContent === "CoolProp ready";
      },
      { timeout: 30000 },
    );

    // Load the realFluid example (model was modified above, so confirm the replace)
    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Cryogenic line cooldown");
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);

    // Run
    await page.locator('[data-testid="toolbar-run"]').click();

    // Assert converged status
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 90000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    // Charts render (explorer aggregate presets)
    await page.locator('[data-testid="results-tab"]').click();
    await expect(
      page.locator('[data-testid="channel-explorer-chart"]'),
    ).toBeVisible();
    await page
      .locator('[data-testid="channel-explorer-view"]')
      .selectOption("branch-mdot");
    await expect(
      page.locator('[data-testid="channel-explorer-chart"]'),
    ).toBeVisible();

    consoleWatcher.assertNoErrors();
  });

  test("19. Long transient run shows progress bar, live charts, and responsive UI", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Inject a long-running tank blowdown config via localStorage
    await page.evaluate(() => {
      const config = {
        meta: { name: "Long tank blowdown", version: 2 },
        settings: {
          mode: "transient",
          dt: 0.005,
          endTime: 10.0,
          tolerance: 1e-6,
          maxIterations: 200,
          relaxation: 0.9,
        },
        fluid: { model: "idealGas", preset: "air" },
        nodes: [
          {
            id: "tank",
            type: "internal",
            x: 0,
            y: 0,
            pressure: 500000,
            temperature: 300,
            volume: 0.1,
            label: "Tank",
          },
          {
            id: "ambient",
            type: "boundary",
            x: 300,
            y: 0,
            pressure: 101325,
            temperature: 300,
            label: "Ambient",
          },
        ],
        branches: [
          {
            id: "orifice",
            from: "tank",
            to: "ambient",
            component: { type: "orifice", area: 0.0001, cd: 0.6 },
            label: "Orifice",
          },
        ],
      };
      localStorage.setItem("fluids-network-config-v1", JSON.stringify(config));
    });
    await page.reload();
    await page.waitForTimeout(500);

    // Click Run
    await page.locator('[data-testid="toolbar-run"]').click();

    // Assert progress bar appears within 5 s
    const progressBar = page.locator('[data-testid="toolbar-progress-bar"]');
    await expect(progressBar).toBeVisible({ timeout: 5000 });

    // The explorer's default aggregate preset charts the live partial as
    // soon as the first progress update arrives — no disclosure to open.
    await page.locator('[data-testid="results-tab"]').click();
    const pressureChart = page.locator(
      '[data-testid="channel-explorer-chart"]',
    );
    await expect(pressureChart).toBeVisible();
    const polylines = pressureChart.locator("polyline");
    await expect(polylines).toHaveCount(2);

    let prevCount = 0;
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(800);
      const pointsAttr = await polylines.first().getAttribute("points");
      const count = pointsAttr?.trim().split(/\s+/).length ?? 0;
      expect(count).toBeGreaterThanOrEqual(prevCount);
      prevCount = count;
    }

    // Switch to Editor tab and interact while simulation continues
    await page.locator('[data-testid="editor-tab"]').click();
    await expect(page.locator('[data-testid="flow-canvas"]')).toBeVisible();

    // Select a node
    await page.locator('[data-testid="node-tank"]').click();
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Node: tank",
    );

    // Go back to Results tab and verify charts are still updating.  The tab
    // switch remounts the explorer; its aggregate default needs no reopening.
    await page.locator('[data-testid="results-tab"]').click();
    await expect(pressureChart).toBeVisible();

    // Wait for completion and assert converged
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 30000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    consoleWatcher.assertNoErrors();
  });

  test("20. Cancel mid-run retains partial chart data", async ({ page }) => {
    test.setTimeout(60000);
    const consoleWatcher = attachConsoleWatcher(page);

    // Inject a long-running pump-startup-like config with many steps
    // 6 nodes + 5 branches + valve schedule => each step is slower than tank blowdown
    await page.evaluate(() => {
      const config = {
        meta: { name: "Long pump startup", version: 2 },
        settings: {
          mode: "transient",
          dt: 0.005,
          endTime: 200.0,
          tolerance: 1e-6,
          maxIterations: 200,
          relaxation: 0.9,
        },
        fluid: { model: "incompressible", preset: "water" },
        nodes: [
          {
            id: "res",
            type: "boundary",
            x: 0,
            y: 0,
            pressure: 100_000,
            temperature: 300,
            label: "Reservoir",
          },
          {
            id: "pumpOut",
            type: "internal",
            x: 150,
            y: 0,
            pressure: 250_000,
            temperature: 300,
            volume: 0.02,
            label: "Pump out",
          },
          {
            id: "seg1",
            type: "internal",
            x: 300,
            y: 0,
            pressure: 200_000,
            temperature: 300,
            volume: 0.02,
            label: "Seg1",
          },
          {
            id: "seg2",
            type: "internal",
            x: 450,
            y: 0,
            pressure: 180_000,
            temperature: 300,
            volume: 0.02,
            label: "Seg2",
          },
          {
            id: "seg3",
            type: "internal",
            x: 600,
            y: 0,
            pressure: 160_000,
            temperature: 300,
            volume: 0.02,
            label: "Seg3",
          },
          {
            id: "disch",
            type: "boundary",
            x: 750,
            y: 0,
            pressure: 100_000,
            temperature: 300,
            label: "Discharge",
          },
        ],
        branches: [
          {
            id: "pump",
            from: "res",
            to: "pumpOut",
            component: {
              type: "pump",
              curve: [
                [0, 300_000],
                [0.005, 250_000],
                [0.01, 150_000],
                [0.02, 50_000],
              ],
            },
            label: "Pump",
          },
          {
            id: "pipe1",
            from: "pumpOut",
            to: "seg1",
            component: {
              type: "pipe",
              length: 40,
              diameter: 0.05,
              roughness: 1e-5,
            },
            label: "Pipe1",
          },
          {
            id: "pipe2",
            from: "seg1",
            to: "seg2",
            component: {
              type: "pipe",
              length: 40,
              diameter: 0.05,
              roughness: 1e-5,
            },
            label: "Pipe2",
          },
          {
            id: "pipe3",
            from: "seg2",
            to: "seg3",
            component: {
              type: "pipe",
              length: 40,
              diameter: 0.05,
              roughness: 1e-5,
            },
            label: "Pipe3",
          },
          {
            id: "valve",
            from: "seg3",
            to: "disch",
            component: {
              type: "valve",
              area: 0.0005,
              cd: 0.6,
              position: 0,
              positionSchedule: [
                [0, 0],
                [2, 1],
                [5, 1],
              ],
            },
            label: "Valve",
          },
        ],
      };
      localStorage.setItem("fluids-network-config-v1", JSON.stringify(config));
    });
    await page.reload();
    await page.waitForTimeout(500);

    // Click Run and wait for the cancel button; the explorer's default
    // aggregate preset mounts the live chart with the first partial — no
    // disclosure to open first.
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-cancel"]')).toBeVisible({
      timeout: 5000,
    });
    await page.locator('[data-testid="results-tab"]').click();

    // Wait inside the browser for the chart to show partial data (≥3 points),
    // then cancel.  Using a single evaluate with rAF polling minimises
    // Playwright overhead so we cancel as early as possible while the (very
    // long) run is still in progress.
    await page.evaluate(async () => {
      const click = (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) throw new Error(`${sel} not found`);
        el.click();
      };

      // Poll until the live chart has at least 3 points (first real progress)
      await new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + 5000;
        const check = () => {
          const el = document.querySelector(
            '[data-testid="channel-explorer-chart"] polyline',
          );
          if (el) {
            const pts =
              el.getAttribute("points")?.trim().split(/\s+/).length ?? 0;
            if (pts >= 3) {
              resolve();
              return;
            }
          }
          if (performance.now() > deadline) {
            reject(new Error("Chart did not show ≥3 points within 5 s"));
          } else {
            requestAnimationFrame(check);
          }
        };
        requestAnimationFrame(check);
      });

      click('[data-testid="toolbar-cancel"]');
    });

    // Assert cancelled banner appears
    const banner = page.locator('[data-testid="cancelled-banner"]');
    await expect(banner).toBeVisible({ timeout: 10000 });
    const bannerText = await banner.textContent();
    expect(bannerText).toContain("Cancelled at t =");

    // Assert charts still show partial data with >3 points (poll because
    // liveResult may render slightly after the cancelled status transition).
    const pressureChart = page.locator(
      '[data-testid="channel-explorer-chart"]',
    );
    await expect(pressureChart).toBeVisible();
    const polylines = pressureChart.locator("polyline");
    await expect(polylines).toHaveCount(6); // 6 nodes

    await expect
      .poll(async () => {
        const pointsAttr = await polylines.first().getAttribute("points");
        return pointsAttr?.trim().split(/\s+/).length ?? 0;
      })
      .toBeGreaterThan(3);

    consoleWatcher.assertNoErrors();
  });

  test("21. Adaptive transient run shows dt readout and stats", async ({
    page,
  }) => {
    test.setTimeout(60000);
    const consoleWatcher = attachConsoleWatcher(page);

    // Inject a pump-startup-like config with adaptive stepping (slower network so progress is visible)
    await page.evaluate(() => {
      const config = {
        meta: { name: "Adaptive pump startup", version: 2 },
        settings: {
          mode: "transient",
          timeStepping: "adaptive",
          adaptive: { dtMin: 0.001, dtMax: 0.01, relTol: 1e-3, safety: 0.9 },
          endTime: 10.0,
          tolerance: 1e-6,
          maxIterations: 200,
          relaxation: 0.9,
        },
        fluid: { model: "incompressible", preset: "water" },
        nodes: [
          {
            id: "res",
            type: "boundary",
            x: 0,
            y: 0,
            pressure: 100_000,
            temperature: 300,
            label: "Reservoir",
          },
          {
            id: "pumpOut",
            type: "internal",
            x: 150,
            y: 0,
            pressure: 250_000,
            temperature: 300,
            volume: 0.02,
            label: "Pump out",
          },
          {
            id: "seg1",
            type: "internal",
            x: 300,
            y: 0,
            pressure: 200_000,
            temperature: 300,
            volume: 0.02,
            label: "Seg1",
          },
          {
            id: "seg2",
            type: "internal",
            x: 450,
            y: 0,
            pressure: 180_000,
            temperature: 300,
            volume: 0.02,
            label: "Seg2",
          },
          {
            id: "seg3",
            type: "internal",
            x: 600,
            y: 0,
            pressure: 160_000,
            temperature: 300,
            volume: 0.02,
            label: "Seg3",
          },
          {
            id: "disch",
            type: "boundary",
            x: 750,
            y: 0,
            pressure: 100_000,
            temperature: 300,
            label: "Discharge",
          },
        ],
        branches: [
          {
            id: "pump",
            from: "res",
            to: "pumpOut",
            component: {
              type: "pump",
              curve: [
                [0, 300_000],
                [0.005, 250_000],
                [0.01, 150_000],
                [0.02, 50_000],
              ],
            },
            label: "Pump",
          },
          {
            id: "pipe1",
            from: "pumpOut",
            to: "seg1",
            component: {
              type: "pipe",
              length: 40,
              diameter: 0.05,
              roughness: 1e-5,
            },
            label: "Pipe1",
          },
          {
            id: "pipe2",
            from: "seg1",
            to: "seg2",
            component: {
              type: "pipe",
              length: 40,
              diameter: 0.05,
              roughness: 1e-5,
            },
            label: "Pipe2",
          },
          {
            id: "pipe3",
            from: "seg2",
            to: "seg3",
            component: {
              type: "pipe",
              length: 40,
              diameter: 0.05,
              roughness: 1e-5,
            },
            label: "Pipe3",
          },
          {
            id: "valve",
            from: "seg3",
            to: "disch",
            component: {
              type: "valve",
              area: 0.0005,
              cd: 0.6,
              position: 0,
              positionSchedule: [
                [0, 0],
                [2, 1],
                [10, 1],
              ],
            },
            label: "Valve",
          },
        ],
      };
      localStorage.setItem("fluids-network-config-v1", JSON.stringify(config));
    });
    await page.reload();
    await page.waitForTimeout(500);

    await page.locator('[data-testid="toolbar-run"]').click();

    // Progress should show dt readout
    const progressBar = page.locator('[data-testid="toolbar-progress-bar"]');
    await expect(progressBar).toBeVisible({ timeout: 5000 });
    const progressText = await progressBar.textContent();
    expect(progressText).toContain("dt =");

    // Wait for completion
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 30000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    // Results summary should show adaptive stats (Run details disclosure)
    await page.locator('[data-testid="results-tab"]').click();
    await openAnalysisSection(page, "summary");
    await expect(
      page
        .locator('[data-testid="results-view"]')
        .locator(".fact__label", { hasText: "Accepted" }),
    ).toBeVisible();

    consoleWatcher.assertNoErrors();
  });

  test("22. Color by temperature before steady run shows initial temps; legend updates after run", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Load a steady example with heated walls so temperatures change after run
    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Heated pipe with radiating wall (conjugate HT)");
    await page.waitForTimeout(300);

    // Set color by Temperature BEFORE running
    await page
      .locator('[data-testid="color-by-select"]')
      .selectOption("temperature");
    await page.waitForTimeout(200);

    // Legend should show Temperature unit
    const legend = page.locator('[data-testid="canvas-legend"]');
    await expect(legend).toBeVisible();
    const beforeText = await legend.textContent();
    expect(beforeText).toMatch(/Temperature/);

    // Run
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    // Switch back to editor to check legend updated
    await page.locator('[data-testid="editor-tab"]').click();
    await expect(legend).toBeVisible();
    const afterText = await legend.textContent();
    // Legend text should differ: the run solves new fluid/wall temperatures
    // (and the "showing initial values" note clears).
    expect(afterText).not.toEqual(beforeText);

    consoleWatcher.assertNoErrors();
  });

  test("23. Transient run shows time scrubber; scrubbing updates node labels", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Tank blowdown");
    await page.waitForTimeout(300);

    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    // Switch to Editor tab
    await page.locator('[data-testid="editor-tab"]').click();

    // Scrubber should be visible
    const scrubber = page.locator('[data-testid="time-scrubber"]');
    await expect(scrubber).toBeVisible();

    // Read end-time label for tank node
    const tankLabel = page.locator('[data-testid="node-result-tank"]');
    await expect(tankLabel).toBeVisible();
    const endText = await tankLabel.textContent();

    // Scrub to start (value 0)
    await scrubber.fill("0");
    await page.waitForTimeout(200);

    const startText = await tankLabel.textContent();
    expect(startText).not.toEqual(endText);

    consoleWatcher.assertNoErrors();
  });

  test("24. Color by mass flow after steady run colors branches, mutes solid nodes", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Load conjugate HT example (has solids + branches)
    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Heated pipe with radiating wall (conjugate HT)");
    await page.waitForTimeout(300);

    // Set color by Mass flow
    await page.locator('[data-testid="color-by-select"]').selectOption("mdot");
    await page.waitForTimeout(200);

    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    // Switch to Editor tab
    await page.locator('[data-testid="editor-tab"]').click();

    // Legend should show mass-flow unit
    const legend = page.locator('[data-testid="canvas-legend"]');
    await expect(legend).toBeVisible();
    const legendText = await legend.textContent();
    expect(legendText).toMatch(/Mass flow|kg\/s/);

    // Solid nodes should still be visible (muted gray, not hidden)
    await expect(page.locator('[data-testid="node-w1"]')).toBeVisible();
    await expect(page.locator('[data-testid="node-w2"]')).toBeVisible();

    consoleWatcher.assertNoErrors();
  });

  test("25. NBS cryogenic line cooldown (realFluid) example loads and converges", async ({
    page,
  }) => {
    test.setTimeout(120000);
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Cryogenic line cooldown");
    await page.waitForTimeout(300);

    // Wait for CoolProp WASM to initialise (realFluid Hydrogen)
    await expect(
      page.locator('[data-testid="toolbar-coolprop-status"]'),
    ).toBeVisible({ timeout: 30000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector(
          '[data-testid="toolbar-coolprop-status"]',
        );
        return !el || el.textContent === "CoolProp ready";
      },
      { timeout: 30000 },
    );

    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 90000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    consoleWatcher.assertNoErrors();
  });

  test("26. Water distribution network example loads, converges, and shows table results", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Select the water distribution network from the examples dropdown
    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Water distribution network");
    await page.waitForTimeout(300);

    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    // Steady results render as a table (Result tables disclosure), not charts
    await page.locator('[data-testid="results-tab"]').click();
    await openAnalysisSection(page, "final");
    await expect(
      page.locator('[data-testid="steady-branches-table"]'),
    ).toBeVisible();

    // Assert the pump branch shows a non-zero mdot
    const mdotCells = page.locator('[data-testid^="mdot-pump"]');
    const count = await mdotCells.count();
    expect(count).toBeGreaterThan(0);
    const text = await mdotCells.nth(0).textContent();
    const val = parseFloat(text || "0");
    expect(Math.abs(val)).toBeGreaterThan(0);

    consoleWatcher.assertNoErrors();
  });

  test("27. Global map panel: collapsible, expanded by default, preference persisted", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    const toggle = page.locator('[data-testid="global-map-toggle"]');
    // Expanded by default
    await expect(
      page.locator('[data-testid="global-map-panel"]'),
    ).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    // Minimap svg lives inside the card body
    await expect(
      page.locator('[data-testid="global-map-panel"] .react-flow__minimap'),
    ).toBeAttached();

    // Collapse to a compact chip
    await toggle.click();
    await expect(page.locator('[data-testid="global-map-panel"]')).toBeHidden();
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toContainText("Map");
    expect(
      await page.evaluate(() =>
        localStorage.getItem("fluids-network-global-map-v1"),
      ),
    ).toBe("0");

    // Expand again
    await toggle.click();
    await expect(
      page.locator('[data-testid="global-map-panel"]'),
    ).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    consoleWatcher.assertNoErrors();
  });

  test("28. Model builder rail exposes fluid, thermal, annotation, and view tools", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    const rail = page.getByRole("group", { name: "Model builder tools" });
    await expect(rail).toBeVisible();
    for (const id of [
      "add-internal-node",
      "add-boundary-node",
      "add-solid-node",
      "add-ambient-node",
      "add-note",
      "canvas-text-view",
      "canvas-table-view",
    ]) {
      await expect(page.locator(`[data-testid="${id}"]`)).toBeVisible();
    }

    await page.locator('[data-testid="add-internal-node"]').click();
    await expect(page.locator('[data-testid="node-N1"]')).toBeVisible();
    await page.locator('[data-testid="node-N1"]').click();
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Node: N1",
    );

    consoleWatcher.assertNoErrors();
  });

  test("36. Custom components: create from connection chooser and embed on save", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    let componentSource = "";

    await page.route("**/api/library", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          components: componentSource
            ? [
                {
                  path: "e2e-k-factor.component.js",
                  source: componentSource,
                  modifiedAt: "2026-08-10T00:00:00.000Z",
                },
              ]
            : [],
        }),
      });
    });
    await page.route("**/api/library/components", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      expect(body.fileName).toBe("e2e-k-factor");
      expect(body.source).toContain('"name": "e2e-k-factor"');
      componentSource = body.source;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          path: "e2e-k-factor.component.js",
          source: componentSource,
          modifiedAt: "2026-08-10T00:00:00.000Z",
        }),
      });
    });
    await page.reload();

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    await page.waitForTimeout(200);

    const source = page.locator('[data-testid="node-in"]');
    const target = page.locator('[data-testid="node-out1"]');
    await source
      .locator('[data-testid="handle-bottom"]')
      .dragTo(target.locator('[data-testid="handle-top"]'));
    const chooser = page.getByRole("dialog", {
      name: "Choose connection type",
    });
    await chooser
      .getByRole("button", { name: "+ Create custom component" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "New local component" }),
    ).toBeVisible();
    await page.locator("#component-name").fill("e2e-k-factor");
    await page.locator("#component-label").fill("E2E K-factor");
    await page.getByRole("button", { name: "Create component" }).click();

    const fnText = await captureTextDownload(page, () =>
      page.locator('[data-testid="toolbar-save"]').click(),
    );
    const libLine = fnText
      .split("\n")
      .find((l) => l.startsWith("componentLibrary: "));
    expect(libLine).toBeTruthy();
    const componentLibrary = JSON.parse(
      libLine!.slice("componentLibrary: ".length),
    );
    expect(componentLibrary["e2e-k-factor"].code).toBe(componentSource);
    const branchLine = fnText
      .split("\n")
      .find((l) => l.startsWith('branch "') && l.includes(" userComponent "));
    expect(branchLine).toBeTruthy();
    const branchData = JSON.parse(
      branchLine!.slice(branchLine!.indexOf("data:") + 5),
    );
    expect(branchData).toMatchObject({
      component: "e2e-k-factor",
      params: { K: 1 },
    });
    consoleWatcher.assertNoErrors();
  });

  test("29. Create subnetwork via Ctrl/Cmd+G from a multi-selection", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page.locator('[data-testid="toolbar-new"]').click();
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);

    await page.locator('[data-testid="add-boundary-node"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="add-internal-node"]').click();
    await page.waitForTimeout(200);

    // Ctrl/Cmd+G with <2 selected nodes does nothing
    await page.locator('[data-testid="node-B1"]').click();
    await page.waitForTimeout(200);
    await page.keyboard.press("Control+g");
    await page.waitForTimeout(300);
    await expect(page.locator('[data-testid^="group-"]')).toHaveCount(0);

    // Multi-select and use the shortcut
    await page
      .locator('[data-testid="node-N1"]')
      .click({ modifiers: ["Shift"] });
    await page.waitForTimeout(200);
    await expect(selectionAction(page, "Create subnetwork")).toBeEnabled();
    await page.keyboard.press("Control+g");
    await page.waitForTimeout(500);

    const container = page.locator('[data-testid^="group-"]').first();
    await expect(container).toBeVisible();
    await expect(container).toContainText("2 members");
    await expect(
      page.locator('[data-testid="subnetwork-announce"]'),
    ).toContainText("Subnetwork 1");
    // Property panel shows the new subnetwork (creation selects it)
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Subnetwork:",
    );

    // Double-click still opens the subnetwork tab
    await container.dblclick();
    await expect(
      page.locator('[data-testid^="group-tab-"]').first(),
    ).toBeVisible();

    consoleWatcher.assertNoErrors();
  });

  test("30. Model Table modal: sortable tables, row navigation, provenance CSV", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    await page.waitForTimeout(500); // let live validation settle

    // The Table button opens the audit view as a modal.
    await page.locator('[data-testid="canvas-table-view"]').click();
    await expect(
      page.locator('[data-testid="model-view-dialog"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="model-table-view"]'),
    ).toBeVisible();

    // Summary bar: counts + validation status
    const summary = page.locator('[data-testid="model-table-summary"]');
    await expect(summary).toContainText("3 boundary");
    await expect(summary).toContainText("1 internal");
    await expect(summary).toContainText("3 branches");
    await expect(
      page.locator('[data-testid="model-table-validation"]'),
    ).toContainText("No validation issues");

    // Nodes and branches tables render all rows
    await expect(
      page.locator('[data-testid="model-table-nodes"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="model-table-branches"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="mt-node-in"]')).toBeVisible();
    await expect(page.locator('[data-testid="mt-node-j"]')).toBeVisible();
    await expect(page.locator('[data-testid="mt-branch-b1"]')).toBeVisible();

    // Filter narrows rows
    await page.locator('[data-testid="model-table-search"]').fill("out1");
    await expect(page.locator('[data-testid="mt-node-out1"]')).toBeVisible();
    await expect(page.locator('[data-testid="mt-node-in"]')).toBeHidden();
    await page.locator('[data-testid="model-table-search"]').fill("");

    // Sort by ID descending puts out2 first in the nodes table
    await page
      .locator('[data-testid="model-table-nodes"] th:has-text("ID")')
      .click();
    await page
      .locator('[data-testid="model-table-nodes"] th:has-text("ID")')
      .click();
    const firstRowId = await page
      .locator('[data-testid="model-table-nodes"] tbody tr')
      .first()
      .getAttribute("data-testid");
    expect(firstRowId).toBe("mt-node-out2");

    // Row click selects the element and navigates back to the canvas
    // (click the ID cell — text inputs/buttons in other cells intentionally
    // swallow the click for editing).
    await page.locator('[data-testid="mt-node-j"] td').nth(1).click();
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Node: j",
    );

    // Branch row action opens the branch in the property panel
    await page.locator('[data-testid="canvas-table-view"]').click();
    await page.locator('[data-testid="mt-open-b2"]').click();
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Branch: b2",
    );

    // CSV export carries the provenance block above the header
    await page.locator('[data-testid="canvas-table-view"]').click();
    const csv = await captureTextDownload(page, async () => {
      await page.locator('[data-testid="model-table-nodes-csv"]').click();
    });
    expect(csv).toContain("# model=Three-pipe junction");
    expect(csv).toContain("# mode=steady");
    expect(csv).toMatch(/# config_(sha256|hash)=/);
    expect(csv).toContain("Name,ID,Type");

    consoleWatcher.assertNoErrors();
  });

  test("31. Run history: two runs, pinned baseline, delta columns, comparison CSV", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    await page.waitForTimeout(300);

    // Run 1
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
      { timeout: 15000 },
    );
    // Run history lives in the closed "Run history" disclosure.
    await page.locator('[data-testid="results-tab"]').click();
    await openAnalysisSection(page, "runs");
    await expect(page.locator('[data-testid="run-history"]')).toBeVisible();
    await expect(page.locator('[data-testid="run-history-item"]')).toHaveCount(
      1,
    );

    // Edit a boundary pressure between runs
    await page.locator('[data-testid="editor-tab"]').click();
    await page.locator('[data-testid="node-in"]').click();
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Node: in",
    );
    await editPropertyField(page, "Pressure", "250000");
    await page.waitForTimeout(200);

    // Run 2 (the editor round-trip remounted the view → disclosures reset)
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
      { timeout: 15000 },
    );
    await page.locator('[data-testid="results-tab"]').click();
    await openAnalysisSection(page, "runs");
    const items = page.locator('[data-testid="run-history-item"]');
    await expect(items).toHaveCount(2);

    // Newest run is listed first and is the displayed one
    await expect(
      items.nth(0).locator('[data-testid="run-history-name"]'),
    ).toHaveValue("Run 2");
    await expect(
      items.nth(0).locator('[data-testid="run-history-view"]'),
    ).toHaveAttribute("aria-current", "true");

    // Pin Run 1 (second row) as the comparison baseline
    await items.nth(1).locator('[data-testid="pin-baseline"]').click();
    await expect(
      page.locator('[data-testid="baseline-indicator"]'),
    ).toContainText("Baseline: Run 1");

    // Comparison UI: delta note + Δ columns in the steady tables (Result
    // tables disclosure; the Runs disclosure stays open).
    await openAnalysisSection(page, "final");
    await expect(
      page.locator('[data-testid="baseline-delta-note"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="steady-nodes-table"] th:has-text("ΔP")'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="steady-branches-table"] th:has-text("Δṁ")'),
    ).toBeVisible();

    // Comparison CSV: long-format rows + provenance + baseline annotation
    const comparison = await captureTextDownload(page, async () => {
      await page.locator('[data-testid="comparison-csv"]').click();
    });
    expect(comparison).toContain("# model=Three-pipe junction");
    expect(comparison).toMatch(/# config_(sha256|hash)=/);
    expect(comparison).toContain("# baseline=Run 1");
    expect(comparison).toContain(
      "section,element_id,name,quantity,unit,current,baseline,delta",
    );

    // Results-table CSV also carries provenance metadata
    const tableCsv = await captureTextDownload(page, async () => {
      await page.locator('[data-testid="table-download-csv"]').click();
    });
    expect(tableCsv).toContain("# model=Three-pipe junction");
    expect(tableCsv).toContain("# mode=steady");
    expect(tableCsv).toMatch(/# config_(sha256|hash)=/);

    // Viewing the older run marks results stale (its config differs from the live model)
    await items.nth(1).locator('[data-testid="run-history-view"]').click();
    await expect(
      page.locator('[data-testid="results-stale-banner"]'),
    ).toBeVisible();

    // Back to the current run: stale banner clears, baseline stays pinned
    await items.nth(0).locator('[data-testid="run-history-view"]').click();
    await expect(
      page.locator('[data-testid="results-stale-banner"]'),
    ).toBeHidden();
    consoleWatcher.assertNoErrors();
  });

  test("32. Schedule editor: permanent headers, monotonic warning + sort, TSV paste", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // No shipped example carries a valve position schedule anymore, so inject
    // a tank-blowdown-style gas transient whose outlet valve has one (the same
    // shape as the removed Propellant tank pressurization example).
    await page.evaluate(() => {
      const config = {
        meta: { name: "Tank blowdown (scheduled outlet valve)", version: 2 },
        settings: {
          mode: "transient",
          dt: 0.01,
          endTime: 5.0,
          tolerance: 1e-6,
          maxIterations: 200,
          relaxation: 0.9,
        },
        fluid: { model: "idealGas", preset: "air" },
        nodes: [
          {
            id: "tank",
            type: "internal",
            x: 0,
            y: 0,
            pressure: 500000,
            temperature: 300,
            volume: 0.1,
            label: "Tank",
          },
          {
            id: "ambient",
            type: "boundary",
            x: 300,
            y: 0,
            pressure: 101325,
            temperature: 300,
            label: "Ambient",
          },
        ],
        branches: [
          {
            id: "outlet",
            from: "tank",
            to: "ambient",
            component: {
              type: "valve",
              area: 0.0005,
              cd: 0.6,
              position: 0,
              positionSchedule: [
                [0, 0],
                [2, 0],
                [3, 1],
                [8, 1],
              ],
            },
            label: "Outlet valve",
          },
        ],
      };
      localStorage.setItem("fluids-network-config-v1", JSON.stringify(config));
    });
    await page.reload();
    await page.waitForTimeout(500);

    // Open the outlet valve via the Model Table "Open in properties" action
    await page.locator('[data-testid="canvas-table-view"]').click();
    await page.locator('[data-testid="mt-open-outlet"]').click();
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Branch: outlet",
    );

    // Permanent unit-labeled headers + sparkline
    const sched = page.locator('[data-testid="valve-position-schedule"]');
    await expect(sched).toBeVisible();
    await expect(
      page.locator('[data-testid="valve-position-schedule-head-x"]'),
    ).toHaveText(/Time \(s\)/);
    await expect(
      page.locator('[data-testid="valve-position-schedule-head-y"]'),
    ).toHaveText(/Position/);
    await expect(
      page.locator('[data-testid="valve-position-schedule-sparkline"]'),
    ).toBeVisible();

    // Injected schedule [[0,0],[2,0],[3,1],[8,1]] is monotonic: no warning
    await expect(page.getByLabel("Time row 4")).toBeVisible();
    await expect(
      page.locator('[data-testid="valve-position-schedule-warning-monotonic"]'),
    ).toBeHidden();

    // Break the order: row 2 time 2 → 9 s
    await page.getByLabel("Time row 2").fill("9");
    await page.getByLabel("Time row 2").blur();
    await expect(
      page.locator('[data-testid="valve-position-schedule-warning-monotonic"]'),
    ).toBeVisible();

    // Sort restores order and clears the warning
    await page.locator('[data-testid="valve-position-schedule-sort"]').click();
    await expect(
      page.locator('[data-testid="valve-position-schedule-warning-monotonic"]'),
    ).toBeHidden();
    await expect(page.getByLabel("Time row 4")).toHaveValue("9");

    // Paste TSV (no focused cell → replaces the grid)
    await sched.evaluate((el) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "0\t0\n5\t0.5\n10\t1");
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(page.getByLabel("Time row 3")).toHaveValue("10");
    await expect(page.getByLabel("Time row 4")).toHaveCount(0);
    await expect(page.getByLabel("Position row 2")).toHaveValue("0.5");

    consoleWatcher.assertNoErrors();
  });

  test("33. Ctrl/Cmd+D duplicates the selected node; undo restores", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    await page.waitForTimeout(300);

    const rfNodes = page.locator(".react-flow__node");
    await expect(rfNodes).toHaveCount(5);

    await page.locator('[data-testid="node-j"]').click();
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Node: j",
    );

    await page.keyboard.press("Control+d");
    await page.waitForTimeout(300);
    await expect(rfNodes).toHaveCount(6);
    await expect(page.locator('[data-testid="canvas-announce"]')).toContainText(
      "Duplicated 1 node",
    );
    // The duplicate becomes the selection ("Junction copy", id j1)
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Node: j1",
    );

    // Undo removes the duplicate
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
    await expect(rfNodes).toHaveCount(5);

    // Redo restores it
    await page.keyboard.press("Control+Shift+z");
    await page.waitForTimeout(300);
    await expect(rfNodes).toHaveCount(6);

    consoleWatcher.assertNoErrors();
  });

  test("34. Issues popover is genuinely on top (elementFromPoint occlusion probe)", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Invalid model: a single internal node, no boundaries/branches
    await page.locator('[data-testid="toolbar-new"]').click();
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="add-internal-node"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-error"]')).toBeVisible({
      timeout: 5000,
    });

    // Open the issues popover from the health pill
    await page.locator('[data-testid="toolbar-health"]').click();
    const panel = page.locator('[data-testid="issues-panel"]');
    await expect(panel).toBeVisible();
    await expect(
      page.locator('[data-testid="issue-item"]').first(),
    ).toBeVisible();

    // The element at the panel's center must be the panel or its descendant
    // (the portal must not be occluded by the toolbar/canvas stacking contexts).
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    const occluded = await page.evaluate(
      ({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        const panelEl = document.querySelector('[data-testid="issues-panel"]');
        return !!panelEl && !!hit && (hit === panelEl || panelEl.contains(hit));
      },
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
    );
    expect(occluded).toBe(true);

    // Escape closes it
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();

    consoleWatcher.assertNoErrors();
  });

  test("35. Fit-on-load: complex example lands fully inside the canvas", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Water distribution network");
    await page.waitForTimeout(300);

    // FitOnLoad fits once the freshly loaded nodes have been measured — poll
    // a few frames so the assertion runs after the fit, not before it.
    const canvas = page.locator('[data-testid="flow-canvas"]');
    await expect(async () => {
      const c = await canvas.boundingBox();
      expect(c).not.toBeNull();
      for (const id of ["node-SRC", "node-N4", "node-D_LOW", "node-D_HIGH"]) {
        const b = await page.locator(`[data-testid="${id}"]`).boundingBox();
        expect(b, `${id} should be measurable`).not.toBeNull();
        const intersects =
          b!.x < c!.x + c!.width &&
          b!.x + b!.width > c!.x &&
          b!.y < c!.y + c!.height &&
          b!.y + b!.height > c!.y;
        expect(intersects, `${id} should intersect the canvas bounds`).toBe(
          true,
        );
      }
    }).toPass({ timeout: 5000 });

    consoleWatcher.assertNoErrors();
  });

  test("37. Text model editor: default-hidden, apply/shortcut, diagnostics, revert, diagram intact", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Model is the default view; the Text editor is not rendered.
    await expect(
      page.getByRole("tablist", { name: "Workspace" }),
    ).toBeVisible();
    await expect(page.locator('[data-testid="editor-tab"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      page.locator('[data-testid="canvas-text-view"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="flow-canvas"]')).toBeVisible();
    await expect(page.locator('[data-testid="text-model-view"]')).toBeHidden();

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    await page.waitForTimeout(300);

    // Open the Text modal: canonical projection with header + network line.
    await page.locator('[data-testid="canvas-text-view"]').click();
    await expect(page.locator('[data-testid="text-model-view"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="model-view-dialog"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="editor-tab"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const editor = page.getByRole("textbox", { name: "Model text editor" });
    await expect(editor).toBeVisible();
    const canonical = await editor.inputValue();
    expect(canonical).toContain("// Fluid Network config v2");
    expect(canonical).toContain('network "Three-pipe junction" {');
    await expect(page.locator('[data-testid="text-model-status"]')).toHaveText(
      "Up to date",
    );
    await expect(
      page.locator('[data-testid="text-model-apply"]'),
    ).toBeDisabled();
    await expect(
      page.locator('[data-testid="text-model-revert"]'),
    ).toBeDisabled();

    // Type a harmless valid edit (rename the network). Before Apply the
    // config must not change: the autosaved model still carries the old name.
    const renamed = canonical.replace(
      'network "Three-pipe junction" {',
      'network "Renamed via text" {',
    );
    expect(renamed).not.toBe(canonical);
    await editor.fill(renamed);
    await expect(page.locator('[data-testid="text-model-status"]')).toHaveText(
      "Modified — not applied",
    );
    await expect(
      page.locator('[data-testid="text-model-apply"]'),
    ).toBeEnabled();
    await expect(
      page.locator('[data-testid="text-model-revert"]'),
    ).toBeEnabled();
    const persistedBefore = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("fluids-network-config-v1")!).meta.name,
    );
    expect(persistedBefore).toBe("Three-pipe junction");

    // Apply via the button: success collapses to the canonical state and the
    // config (observable via autosave) now carries the rename.
    await page.locator('[data-testid="text-model-apply"]').click();
    await expect(page.locator('[data-testid="text-model-status"]')).toHaveText(
      "Up to date",
    );
    await expect(
      page.locator('[data-testid="text-model-announce"]'),
    ).toContainText("Applied");
    expect(await editor.inputValue()).toContain('network "Renamed via text" {');
    const persistedAfter = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("fluids-network-config-v1")!).meta.name,
    );
    expect(persistedAfter).toBe("Renamed via text");

    // The Ctrl/Cmd+Enter shortcut commits the same way.
    const renamed2 = (await editor.inputValue()).replace(
      'network "Renamed via text" {',
      'network "Renamed twice" {',
    );
    await editor.fill(renamed2);
    await expect(page.locator('[data-testid="text-model-status"]')).toHaveText(
      "Modified — not applied",
    );
    await editor.press("Control+Enter");
    await expect(page.locator('[data-testid="text-model-status"]')).toHaveText(
      "Up to date",
    );
    const persistedAfterShortcut = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("fluids-network-config-v1")!).meta.name,
    );
    expect(persistedAfterShortcut).toBe("Renamed twice");

    // Malformed text: Apply keeps the draft, shows diagnostics, config untouched.
    await editor.fill("this is not a model");
    await page.locator('[data-testid="text-model-apply"]').click();
    const diagnostics = page.getByRole("region", { name: "Text problems" });
    await expect(diagnostics).toBeVisible();
    await expect(
      page.locator('[data-testid="text-model-diagnostic-0"]'),
    ).toContainText("header");
    await expect(
      page.locator('[data-testid="text-model-status"]'),
    ).toContainText("problem");
    await expect(
      page.locator('[data-testid="text-model-status"]'),
    ).toContainText("not applied");
    await expect(editor).toHaveAttribute("aria-invalid", "true");
    await expect(
      page.locator('[data-testid="text-model-announce"]'),
    ).toContainText("model unchanged");
    const persistedAfterFailure = await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("fluids-network-config-v1")!).meta.name,
    );
    expect(persistedAfterFailure).toBe("Renamed twice");

    // Diagnostics click-to-line: caret readout lands on the offending line.
    await page.locator('[data-testid="text-model-diagnostic-0"]').click();
    await expect(
      page.locator('[data-testid="text-model-caret"]'),
    ).toContainText("Line 1");

    // Revert restores the canonical text and clears diagnostics.
    await page.locator('[data-testid="text-model-revert"]').click();
    await expect(page.locator('[data-testid="text-model-status"]')).toHaveText(
      "Up to date",
    );
    await expect(
      page.locator('[data-testid="text-model-announce"]'),
    ).toContainText("Reverted");
    const reverted = await editor.inputValue();
    expect(reverted).toContain("// Fluid Network config v2");
    expect(reverted).toContain('network "Renamed twice" {');
    await expect(diagnostics).toBeHidden();
    expect(await editor.getAttribute("aria-invalid")).toBeNull();

    // Close the modal: the canvas is functional and reflects the same model.
    await page.locator('[data-testid="model-view-dialog-close"]').click();
    await expect(page.locator('[data-testid="flow-canvas"]')).toBeVisible();
    await expect(page.locator('[data-testid="text-model-view"]')).toBeHidden();
    await page.locator('[data-testid="node-in"]').click();
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Node: in",
    );

    consoleWatcher.assertNoErrors();
  });

  test("38. Text model editor: selection syncs diagram → text and caret → store", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page
      .locator('[data-testid="toolbar-examples"]')
      .selectOption("Three-pipe junction");
    await page.waitForTimeout(300);

    // Select a node on the model, then open the Text modal: the entity's
    // record line is revealed and the caret readout names it.
    await page.locator('[data-testid="node-in"]').click();
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Node: in",
    );
    await page.locator('[data-testid="canvas-text-view"]').click();
    const caret = page.locator('[data-testid="text-model-caret"]');
    await expect(caret).toContainText("node in");
    await expect(caret).toContainText(/Line \d+/);

    // Caret → store: put the caret on branch b1's record line (click first to
    // focus — the click lands on the header, a chrome line, so the store
    // selection stays put), then press a key so the caret-move is observed.
    // The property panel remains behind the modal, so close and reopen Text
    // when probing the selection synchronized from the caret.
    const editor = page.locator('[data-testid="text-model-editor"]');
    await editor.click({ position: { x: 4, y: 4 } });
    await page.locator('[data-testid="model-view-dialog-close"]').click();
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Node: in",
    );
    await page.locator('[data-testid="canvas-text-view"]').click();
    await editor.click({ position: { x: 4, y: 4 } });
    await editor.evaluate((el) => {
      const ta = el as HTMLTextAreaElement;
      const lines = ta.value.split("\n");
      const idx = lines.findIndex((l) => l.startsWith('branch "b1"'));
      if (idx < 0) throw new Error('branch "b1" record line not found');
      const start = lines.slice(0, idx).reduce((n, l) => n + l.length + 1, 0);
      ta.setSelectionRange(start, start);
    });
    await editor.press("Home"); // any key triggers the caret observation
    await expect(caret).toContainText("branch b1");

    // Echo suppression: the store update above must not yank the editor back —
    // the caret readout still shows the branch line the user moved to.
    await expect(caret).toContainText(/Line \d+ · branch b1/);

    // Caret → store: the selection followed the caret to branch b1.
    await page.locator('[data-testid="model-view-dialog-close"]').click();
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Branch: b1",
    );

    consoleWatcher.assertNoErrors();
  });
});
