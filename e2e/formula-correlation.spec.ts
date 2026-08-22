/**
 * e2e/formula-correlation.spec.ts — the unified Property Panel surfaces:
 *
 *  1. Formula-capable numeric inputs (core/paramBindings.ts): the shipped
 *     conjugate-HT example binds its convection areas to pipe surface
 *     areas; the panel shows the ƒ badge + resolved preview, "Use resolved
 *     value" reverts to a literal, and a freshly-typed formula commits as
 *     { expr } with inline error reporting that never deletes the formula.
 *  2. Convection "Heat-transfer model" selection: specified h → Dittus–Boelter
 *     → back to specified h as an EQUATION in the same box, per-model fields
 *     appearing/disappearing, and a successful run with the solver-evaluated
 *     h equation (no realFluid needed when it reads only generic quantities).
 *  3. Focus hygiene under the Diagram-only sidebar behaviour: the formula
 *     field is keyboard-reachable in the Diagram tab and the whole panel is
 *     unmounted (not focusable) in the Text tab.
 */
import { test, expect, Page } from "@playwright/test";

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

async function loadConjugateExample(page: Page) {
  await page
    .locator('[data-testid="toolbar-examples"]')
    .selectOption("Heated pipe with radiating wall (conjugate HT)");
  // Loading over a dirtied model asks for confirmation on some paths.
  const confirm = page.locator('[data-testid="confirm-dialog-accept"]');
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await page.waitForTimeout(300);
}

async function selectConductor(page: Page, id: string) {
  // React Flow renders a wide invisible interaction path per edge.  A straight
  // vertical/horizontal edge has a zero-width/height box, which Playwright
  // will not click even with force — aim at the midpoint instead, and retry
  // while the fit-on-load transform is still settling under the pointer.
  const edge = page.locator(`[data-testid="rf__edge-${id}"]`);
  const panel = page.locator('[data-testid="property-panel"]');
  const interaction = edge.locator("path.react-flow__edge-interaction");
  const target =
    (await interaction.count()) > 0
      ? interaction.first()
      : edge.locator("path.react-flow__edge-path");
  for (let attempt = 0; attempt < 5; attempt++) {
    const box = await target.boundingBox();
    if (box !== null) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      if (
        await panel
          .getByText(`Conductor: ${id}`)
          .isVisible()
          .catch(() => false)
      )
        return;
    }
    await page.waitForTimeout(200);
  }
  await expect(panel).toContainText(`Conductor: ${id}`);
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
    .locator('[data-testid="handle-right"]')
    .dragTo(target.locator('[data-testid="handle-left"]'));
  const chooser = page.getByRole("dialog", { name: "Choose connection type" });
  await expect(chooser).toBeVisible();
  await chooser.getByRole("button", { name: choice, exact: true }).click();
}

test.describe("Formula inputs and convection models", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.removeItem("fluids-network-units-v1");
    });
    await page.reload();
  });

  test("1. Shipped formula binding shows its resolved preview; edits and reverts work", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadConjugateExample(page);

    await selectConductor(page, "c1");

    // The example ships c1.area = { expr: "pipe('b_in').surfaceArea" }.
    const preview = page.locator('[data-testid="convection-area-preview"]');
    await expect(preview).toBeVisible();
    // π · 0.03 m · 0.5 m = 0.047124 m²
    await expect(preview).toContainText("→ 0.0471239");
    await expect(preview).toContainText("m²");

    // Use resolved value → literal replaces the formula and preview.
    await page.locator('[data-testid="convection-area-use-resolved"]').click();
    await expect(preview).toHaveCount(0);
    // The chip editor is the default surface: literal values are plain text.
    const areaEditor = page.locator('[data-testid="convection-area-editor"]');
    await expect(areaEditor).toHaveText(/0\.04712/);
    await expect(
      page.locator('[data-testid="convection-area-chip"]'),
    ).toHaveCount(0);

    // Undo restores the formula binding (undo clears the selection by
    // design — re-select the conductor to see it).
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(200);
    await selectConductor(page, "c1");
    // …and the reference renders as a chip again.
    await expect(
      page.locator('[data-testid="convection-area-chip"]'),
    ).toContainText("b_in · surfaceArea");

    // A fresh formula commits as { expr } and previews its value.
    await areaEditor.click();
    await areaEditor.fill("=2 * pipe('b_in').surfaceArea");
    await areaEditor.press("Enter");
    await expect(
      page.locator('[data-testid="convection-area-preview"]'),
    ).toContainText("→ 0.0942478");

    // A broken formula shows an inline error WITHOUT deleting the source:
    // the invalid chip keeps its exact source span.
    await areaEditor.click();
    await areaEditor.fill("=pipe('nope').surfaceArea");
    await areaEditor.press("Enter");
    const err = page.locator('[data-testid="convection-area-error"]');
    await expect(err).toBeVisible();
    await expect(err).toContainText("unknown branch 'nope'");
    const brokenChip = page.locator('[data-testid="convection-area-chip"]');
    await expect(brokenChip).toHaveClass(/formula-chip--invalid/);
    await expect(brokenChip).toHaveAttribute(
      "data-chip-source",
      "pipe('nope').surfaceArea",
    );

    // Fix it back to a valid binding before continuing.
    await areaEditor.click();
    await areaEditor.fill("=pipe('b_in').surfaceArea");
    await areaEditor.press("Enter");
    await expect(
      page.locator('[data-testid="convection-area-error"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="convection-area-preview"]'),
    ).toContainText("→ 0.0471239");

    consoleWatcher.assertNoErrors();
  });

  test("2. Convection model select: Dittus–Boelter fields, then an h equation, then a clean run", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadConjugateExample(page);
    await selectConductor(page, "c1");

    const modelSelect = page.locator('[data-testid="convection-model"]');
    await expect(modelSelect).toHaveValue("specified");

    // --- Dittus–Boelter ---
    await modelSelect.selectOption("dittusBoelter");
    await expect(
      page.locator('[data-testid="convection-diameter"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="convection-flow-area"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="convection-warning"]'),
    ).toContainText("realFluid");
    // h stays as the documented fallback floor.
    await expect(
      page.locator('label:has-text("h (fallback floor)")'),
    ).toBeVisible();
    // Chilldown-only fields stay hidden.
    await expect(
      page.locator('[data-testid="convection-fluid-front"]'),
    ).toHaveCount(0);

    // Set the correlation diameter (formula-capable: plain literal here).
    const dInput = page.locator('[data-testid="convection-diameter-editor"]');
    await dInput.click();
    await dInput.fill("0.03");
    await dInput.press("Enter");

    // --- Back to specified h, this time as an equation in the SAME box ---
    await modelSelect.selectOption("specified");
    const hEditor = page.locator('[data-testid="convection-h-editor"]');
    await expect(hEditor).toBeVisible();
    // There is no separate menu entry or textarea for an equation any more.
    await expect(modelSelect.locator('option[value="custom"]')).toHaveCount(0);
    await expect(
      page.locator('[data-testid="convection-expression"]'),
    ).toHaveCount(0);

    // An equation over the local flow state moves h into the solver's own
    // evaluation; 0 · Tf keeps it constant-valued on the example's
    // incompressible fluid.
    await hEditor.click();
    await hEditor.fill("=1000 + 0 * Tf");
    await hEditor.press("Enter");
    await expect(
      page.locator('[data-testid="convection-h-help"]'),
    ).toContainText("every h refresh");
    await expect(
      page.locator('[data-testid="convection-params"]'),
    ).toBeVisible();
    // The second h field is gone: the box IS h.
    await expect(
      page.locator('label:has-text("h (fallback floor)")'),
    ).toHaveCount(0);
    // Scope teaching prose lives in the docs, not the panel.
    await expect(
      page.locator('[data-testid="convection-scope-help"]'),
    ).toHaveCount(0);
    // Scope inputs stay opt-in: nothing exposes D (and with it G/Re) until
    // the user asks for it.
    const dToggle = page.locator('[data-testid="convection-diameter-toggle"]');
    await expect(dToggle).not.toBeChecked();
    await dToggle.check();
    await expect(
      page.locator('[data-testid="convection-diameter-editor"]'),
    ).toBeVisible();

    // A malformed equation reports inline and never clears the source.
    await hEditor.click();
    await hEditor.fill("=1000 + 0 * Tf +");
    await hEditor.press("Enter");
    await expect(
      page.locator('[data-testid="convection-h-equation-error"]'),
    ).toBeVisible();
    await expect(hEditor).toHaveText("=1000 + 0 * Tf +");
    // …and the diameter it would read is still there afterwards.
    await expect(dToggle).toBeChecked();
    await hEditor.click();
    await hEditor.fill("=1000 + 0 * Tf");
    await hEditor.press("Enter");
    await expect(
      page.locator('[data-testid="convection-h-equation-error"]'),
    ).toHaveCount(0);

    // The example ships c2.h = { expr: "conductor('c1').h" }, and the equation
    // replaced the h it read: give c2 its own value again so the model is
    // consistent (a dangling reference is reported against c2, not here).
    await selectConductor(page, "c2");
    const h2 = page.locator('[data-testid="convection-h-editor"]');
    await h2.click();
    await h2.fill("1000");
    await h2.press("Enter");
    await expect(page.locator('[data-testid="toolbar-health"]')).toContainText(
      "Ready to solve",
    );

    // --- Formula for the node volume too ---
    await page.locator('[data-testid="node-f1"]').click();
    const volumeEditor = page.locator('[data-testid="node-volume-editor"]');
    await volumeEditor.click();
    await volumeEditor.fill("=pipe('b_in').volume");
    await volumeEditor.press("Enter");
    // π·(0.05/2)² … b_in: L=0.5, d=0.03 → V = 3.5343e-4 m³
    await expect(
      page.locator('[data-testid="node-volume-preview"]'),
    ).toContainText("0.000353429");

    // No validation issues before the run: the health pill is clean with
    // the h equation + formula bindings active.
    await expect(page.locator('[data-testid="toolbar-health"]')).toContainText(
      "Ready to solve",
    );

    // --- Run: the h equation (=1000, as the constant it replaced) converges. ---
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="toolbar-status"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-testid="toolbar-status"]')).toContainText(
      "Converged",
    );

    consoleWatcher.assertNoErrors();
  });

  test("3. Fresh model: chooser-built conductor accepts a formula area", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    await page.locator('[data-testid="toolbar-new"]').click();
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await page.waitForTimeout(300);

    // Solid + ambient + conduction conductor through the canvas rail/chooser.
    await page.locator('[data-testid="add-solid-node"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="add-ambient-node"]').click();
    await page.waitForTimeout(200);
    await connectWith(page, "S1", "A1", "Conduction");
    await page.waitForTimeout(300);

    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Conductor:",
    );

    // Conduction area accepts a formula (pure-arithmetic static scope).
    const areaInput = page.locator('[data-testid="conduction-area-editor"]');
    await areaInput.click();
    await areaInput.fill("=circleArea(0.113)");
    await areaInput.press("Enter");
    await expect(
      page.locator('[data-testid="conduction-area-preview"]'),
    ).toContainText("0.0100287");

    // Solid cp: the five-mode selector includes equation + time table.
    await page.locator('[data-testid="node-S1"]').click();
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Solid Node: S1",
    );
    const modeSelect = page.locator('[data-testid="solid-cp-mode"]');
    await expect(modeSelect.locator("option")).toHaveCount(5);
    await modeSelect.selectOption("expression");
    await expect(
      page.locator('[data-testid="solid-cp-expression"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="solid-cp-expression-preview"]'),
    ).toBeVisible();
    await modeSelect.selectOption("timeTable");
    await expect(
      page.locator('[data-testid="solid-cp-time-table"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="solid-cp-time-table-info"]'),
    ).toContainText("accepted step");

    consoleWatcher.assertNoErrors();
  });

  test("4. Formula field yields focus to the Text modal", async ({ page }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadConjugateExample(page);

    await page.locator('[data-testid="node-f1"]').click();
    const volumeInput = page.locator('[data-testid="node-volume-editor"]');
    await expect(volumeInput).toBeVisible();
    await volumeInput.focus();
    await expect(volumeInput).toBeFocused();
    // Scope help appears while editing.
    await expect(
      page.locator('[data-testid="node-volume-help"]'),
    ).toBeVisible();

    await page.locator('[data-testid="canvas-text-view"]').click();
    await expect(
      page.locator('[data-testid="model-view-dialog"]'),
    ).toBeVisible();
    await expect(volumeInput).not.toBeFocused();

    consoleWatcher.assertNoErrors();
  });
});
