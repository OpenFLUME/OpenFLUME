/**
 * e2e/studio-shell.spec.ts — the Studio shell chrome and its assistance
 * surfaces.
 *
 * Covers what no other spec pins: the project outline (configuration rows,
 * entity rows, run-history rows, filter, hide/show, drag-reorder, hover
 * summaries), the contextual properties dock, the command palette, saving and
 * discarding results, and the New-model template picker.  Canvas/solver/
 * property behavior is covered by the main network spec and friends.
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

async function loadExample(page: Page, name: string) {
  await page.locator('[data-testid="toolbar-examples"]').selectOption(name);
  const confirm = page.locator('[data-testid="confirm-dialog-accept"]');
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await page.waitForTimeout(300);
}

test.describe("Studio shell", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test("1. project outline: configuration rows open Configuration, entity rows select, runs land under Runs", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadExample(page, "Three-pipe junction");

    // Outline shows configuration with value annotations.
    const outline = page.locator('[data-testid="model-outline"]');
    await expect(outline).toBeVisible();
    await expect(
      page.locator('[data-testid="outline-config-solver"]'),
    ).toContainText("Solver");
    await expect(
      page.locator('[data-testid="outline-config-fluids"]'),
    ).toBeVisible();

    // A configuration row opens the Setup tab on its section.
    await page.locator('[data-testid="outline-config-solver"]').click();
    await expect(
      page.locator('[data-testid="configuration-view"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid="config-tab"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      page.locator('[data-testid="settings-tab-panel-solver"]'),
    ).toBeVisible();
    await page.locator('[data-testid="editor-tab"]').click();
    await expect(
      page.locator('[data-testid="configuration-view"]'),
    ).toHaveCount(0);

    // An entity row selects into the docked inspector.
    const entityRow = page.locator('[data-testid^="outline-item-"]').first();
    await entityRow.click();
    await expect(
      page.locator('[data-testid="studio-inspector"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="property-panel"]'),
    ).not.toContainText("Select a node, branch, or group");

    // A completed run appears under Results with a converged dot; clicking
    // it opens the Analysis view.
    await page.locator('[data-testid="toolbar-run"]').click();
    const runRow = page.locator('[data-testid^="outline-run-"]').first();
    await expect(runRow).toBeVisible({ timeout: 30_000 });
    await expect(runRow).toContainText("converged");
    await runRow.click();
    await expect(page.locator('[data-testid="results-view"]')).toBeVisible();

    consoleWatcher.assertNoErrors();
  });

  test("2. outline filter narrows rows; Ctrl+\\ hides and shows the panel", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadExample(page, "Three-pipe junction");

    // Filter down to one branch id.
    const filter = page.locator('[data-testid="outline-filter"]');
    await filter.fill("Solver");
    await expect(
      page.locator('[data-testid="outline-config-solver"]'),
    ).toBeVisible();
    await expect(page.locator('[data-testid^="outline-item-"]')).toHaveCount(0);
    await filter.fill("");

    // Ctrl+\ hides the panel; the edge affordance brings it back.
    await page.keyboard.press("Control+\\");
    await expect(page.locator('[data-testid="studio-outline"]')).toHaveCount(0);
    await page.locator('[data-testid="studio-outline-show"]').click();
    await expect(page.locator('[data-testid="studio-outline"]')).toBeVisible();

    consoleWatcher.assertNoErrors();
  });

  test("3. properties dock is contextual: mounts on selection, gone otherwise", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadExample(page, "Three-pipe junction");

    // Nothing selected: the canvas has the full width.
    await expect(page.locator('[data-testid="studio-inspector"]')).toHaveCount(
      0,
    );
    await expect(page.locator('[data-testid="property-panel"]')).toHaveCount(0);

    await page.locator('[data-testid^="outline-item-"]').first().click();
    await expect(
      page.locator('[data-testid="studio-inspector"]'),
    ).toBeVisible();

    // Clearing the selection puts the width back. Click the React Flow pane
    // clear of the tool rail (left edge) and the map card (bottom right).
    const canvas = page.locator('[data-testid="flow-canvas"]');
    const box = (await canvas.boundingBox())!;
    await canvas.click({ position: { x: box.width - 120, y: 60 } });
    await expect(page.locator('[data-testid="studio-inspector"]')).toHaveCount(
      0,
    );

    consoleWatcher.assertNoErrors();
  });

  test("4. command palette: Cmd/Ctrl+K, filter, jump to an element", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadExample(page, "Three-pipe junction");

    await page.locator('[data-testid="toolbar-commands"]').click();
    await expect(page.locator('[data-testid="command-palette"]')).toBeVisible();
    await page
      .locator('[data-testid="command-palette-input"]')
      .fill("Go to node");
    const gotoCmd = page.locator('[data-testid^="command-goto-node-"]').first();
    await expect(gotoCmd).toBeVisible();
    await gotoCmd.click();
    await expect(page.locator('[data-testid="command-palette"]')).toHaveCount(
      0,
    );
    await expect(page.locator('[data-testid="property-panel"]')).toContainText(
      "Node:",
    );

    // Keyboard toggle.
    await page.keyboard.press("Control+k");
    await expect(page.locator('[data-testid="command-palette"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="command-palette"]')).toHaveCount(
      0,
    );

    consoleWatcher.assertNoErrors();
  });

  test("5. variants: edits are scoped to the active variant, runs are tagged", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadExample(page, "Three-pipe junction");

    // Base is the implicit starting variant.
    await expect(page.locator('[data-testid="variant-picker"]')).toContainText(
      "Base",
    );
    await expect(page.locator('[data-testid="toolbar-variant"]')).toHaveCount(
      0,
    );

    // Run once on Base so there is something to compare against.
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(
      page.locator('[data-testid^="outline-run-"]').first(),
    ).toBeVisible({ timeout: 30_000 });

    // Create a variant from the picker, naming it inline.
    await page.locator('[data-testid="variant-picker"]').click();
    await page.locator('[data-testid="variant-new"]').click();
    await page.locator('[data-testid="variant-new-input"]').fill("Cold day");
    await page.locator('[data-testid="variant-new-input"]').press("Enter");
    await expect(page.locator('[data-testid="variant-picker"]')).toContainText(
      "Cold day",
    );
    // With a non-Base variant active the toolbar names it, so the active
    // variant is visible even with the outline collapsed.
    await expect(page.locator('[data-testid="toolbar-variant"]')).toContainText(
      "Cold day",
    );

    // Edit inside the variant: the row gains a "modified" mark.
    await page.locator('[data-testid="outline-item-in"]').click();
    await page
      .locator(
        '[data-testid="property-panel"] [data-testid="node-type-select"]',
      )
      .selectOption("internal");
    await expect(page.locator('[data-testid="outline-item-in"]')).toContainText(
      "M",
    );
    await expect(page.locator('[data-testid="variant-picker"]')).toContainText(
      "1 change",
    );

    // Switching back to Base shows the unmodified network.
    await page.locator('[data-testid="variant-picker"]').click();
    await page.locator('[data-testid="variant-option-base"]').click();
    await expect(
      page.locator('[data-testid="outline-item-in"]'),
    ).not.toContainText("M");

    // Rename inline from the picker.
    await page.locator('[data-testid="variant-picker"]').click();
    const variantRow = page.locator('[data-testid^="variant-rename-"]').first();
    await variantRow.click();
    const renameInput = page
      .locator('[data-testid^="variant-rename-input-"]')
      .first();
    await renameInput.fill("Cold morning");
    await renameInput.press("Enter");
    await expect(page.locator('[data-testid="variant-menu"]')).toContainText(
      "Cold morning",
    );
    await page.keyboard.press("Escape");

    // Variants live in the saved .fn text, so they travel with the model.
    await page.locator('[data-testid="canvas-text-view"]').click();
    await expect(page.locator('[data-testid="text-model-view"]')).toContainText(
      "variants:",
    );
    await expect(page.locator('[data-testid="text-model-view"]')).toContainText(
      "Cold morning",
    );
    await page.locator('[data-testid="model-view-dialog-close"]').click();

    // Runs are tagged with the variant that produced them.
    await expect(
      page.locator('[data-testid^="outline-run-"]').first(),
    ).toContainText("Base");

    consoleWatcher.assertNoErrors();
  });

  test("6. loading a different model clears the previous model's runs", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadExample(page, "Three-pipe junction");
    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(
      page.locator('[data-testid^="outline-run-"]').first(),
    ).toBeVisible({ timeout: 30_000 });

    await loadExample(page, "Tank blowdown");
    // Runs from the previous model must not follow it into this one.
    await expect(page.locator('[data-testid^="outline-run-"]')).toHaveCount(0);

    consoleWatcher.assertNoErrors();
  });

  test("7. discarding results: one run, then all, and neither comes back on reload", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadExample(page, "Three-pipe junction");

    const runs = page.locator('[data-testid^="outline-run-"]');
    for (let i = 0; i < 3; i++) {
      await page.locator('[data-testid="toolbar-run"]').click();
      await expect(runs).toHaveCount(i + 1, { timeout: 30_000 });
    }

    const dialog = page.locator('[data-testid="confirm-dialog"]');

    // Discarding one run asks first, and cancelling keeps it.
    await page.locator('[data-testid^="outline-discard-run-"]').first().click();
    await expect(dialog).toContainText("cannot be undone");
    await page.locator('[data-testid="confirm-dialog-cancel"]').click();
    await expect(runs).toHaveCount(3);

    // Accepting takes exactly that run.
    await page.locator('[data-testid^="outline-discard-run-"]').first().click();
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await expect(runs).toHaveCount(2);

    // The browser-storage mirror must have lost it too.
    await page.reload();
    await expect(runs).toHaveCount(2);

    // Discarding the whole list also asks, and cancelling keeps them.
    await page.locator('[data-testid="outline-discard-runs"]').click();
    await expect(dialog).toContainText("all 2 recorded runs");
    await page.locator('[data-testid="confirm-dialog-cancel"]').click();
    await expect(runs).toHaveCount(2);

    await page.locator('[data-testid="outline-discard-runs"]').click();
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await expect(runs).toHaveCount(0);
    // With nothing recorded, the section offers neither action.
    await expect(page.locator('[data-testid="outline-save-runs"]')).toHaveCount(
      0,
    );
    await expect(
      page.locator('[data-testid="outline-discard-runs"]'),
    ).toHaveCount(0);

    await page.reload();
    await expect(runs).toHaveCount(0);

    consoleWatcher.assertNoErrors();
  });

  test("8. Save writes the model, and the results sidecar with it once runs exist", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadExample(page, "Three-pipe junction");

    const downloads: string[] = [];
    page.on("download", (d) => downloads.push(d.suggestedFilename()));

    // No runs yet: Save is the model alone.
    await page.locator('[data-testid="toolbar-save"]').click();
    await expect.poll(() => downloads.length).toBe(1);
    expect(downloads[0]).toMatch(/\.fn$/);

    await page.locator('[data-testid="toolbar-run"]').click();
    await expect(page.locator('[data-testid="outline-save-runs"]')).toBeVisible(
      { timeout: 30_000 },
    );

    // With results recorded, one Save captures both halves of the session.
    downloads.length = 0;
    await page.locator('[data-testid="toolbar-save"]').click();
    await expect.poll(() => downloads.length).toBe(2);
    expect(downloads.some((f) => f.endsWith(".fn"))).toBe(true);
    expect(downloads.some((f) => f.endsWith(".runs.json"))).toBe(true);
    // Both name the same model, so the sidecar is recognizable as its pair.
    const stem = downloads.find((f) => f.endsWith(".fn"))!.replace(/\.fn$/, "");
    expect(downloads).toContain(`${stem}.runs.json`);

    consoleWatcher.assertNoErrors();
  });

  test("9. new-model dialog: blank default preserves the classic contract, templates seed models", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);

    // Blank path (the historical toolbar-new → confirm-dialog-accept flow).
    await page.locator('[data-testid="toolbar-new"]').click();
    await expect(
      page.locator('[data-testid="new-model-dialog"]'),
    ).toBeVisible();
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await expect(page.locator('[data-testid="network-name"]')).toHaveValue(
      "Untitled network",
    );

    // Template path: Gas blowdown seeds a transient ideal-gas model, visible
    // straight away in the outline's configuration annotations.
    await page.locator('[data-testid="toolbar-new"]').click();
    await page
      .locator('[data-testid="new-model-template-gas-blowdown"]')
      .click();
    await page.locator('[data-testid="confirm-dialog-accept"]').click();
    await expect(page.locator('[data-testid="network-name"]')).toHaveValue(
      "Gas blowdown",
    );
    await expect(
      page.locator('[data-testid="outline-config-solver"]'),
    ).toContainText("transient");
    await expect(
      page.locator('[data-testid="outline-config-fluids"]'),
    ).toContainText("air");

    consoleWatcher.assertNoErrors();
  });
});
