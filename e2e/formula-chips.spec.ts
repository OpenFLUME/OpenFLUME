/**
 * e2e/formula-chips.spec.ts — the visual formula chip editor
 * (FormulaExpressionEditor inside FormulaUnitInput):
 *
 *  1. Committed model references render as inline chips (id · property),
 *     and a broken reference keeps its exact source on a warning chip.
 *  2. Autocomplete: config-aware suggestions (ids, then properties) insert
 *     safe source, re-chip immediately, and announce via aria-live.
 *  3. Chip removal via keyboard (select + Backspace) removes the whole
 *     source span atomically; a following store undo restores the binding.
 *  4. Invalid-chip repair: double-click explodes the chip to its raw source
 *     selection; retyping fixes the binding without losing the formula.
 *  5. Plain-text fallback: the "Text formula" toggle exposes the ordinary
 *     input path with the old testid-compatible semantics; toggling back
 *     re-chips.
 *  6. Sidebar/tab behaviour: the autocomplete menu is portaled to <body>
 *     (never clipped by the property panel) and the whole panel unmounts in
 *     the Text tab.
 *  7. Formula Options inserts complete model references with one click.
 *  8. Typed formulas need no leading '=' and functions are browsable.
 *  9. Formula Options from plain text returns to the visual browser.
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
  const confirm = page.locator('[data-testid="confirm-dialog-accept"]');
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await page.waitForTimeout(300);
}

async function selectConductor(page: Page, id: string) {
  const edge = page.locator(`[data-testid="rf__edge-${id}"]`);
  const interaction = edge.locator("path.react-flow__edge-interaction");
  if ((await interaction.count()) > 0)
    await interaction.first().click({ force: true });
  else await edge.locator("path.react-flow__edge-path").click({ force: true });
  await expect(page.locator('[data-testid="property-panel"]')).toContainText(
    `Conductor: ${id}`,
  );
}

async function selectFluidNode(page: Page, id: string) {
  await page.locator(`[data-testid="node-${id}"]`).click();
  await expect(page.locator('[data-testid="property-panel"]')).toContainText(
    `Node: ${id}`,
  );
}

test.describe("Visual formula chip editor", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.removeItem("fluids-network-units-v1");
    });
    await page.reload();
  });

  test("1. Committed references render as chips; broken ones warn but keep their source", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadConjugateExample(page);
    await selectConductor(page, "c1");

    // The shipped binding pipe('b_in').surfaceArea renders as ONE chip.
    const editor = page.locator('[data-testid="convection-area-editor"]');
    const chip = page.locator('[data-testid="convection-area-chip"]');
    await expect(chip).toHaveCount(1);
    await expect(chip).toContainText("b_in · surfaceArea");
    await expect(chip).toHaveAttribute(
      "data-chip-source",
      "pipe('b_in').surfaceArea",
    );
    await expect(chip).not.toHaveClass(/formula-chip--invalid/);
    // The '=' formula leader stays plain text, outside the chip.
    await expect(editor).toContainText("=");
    // Remove affordance with an accessible label.
    await expect(chip.locator(".formula-chip__remove")).toHaveAttribute(
      "aria-label",
      "Remove reference b_in · surfaceArea",
    );

    consoleWatcher.assertNoErrors();
  });

  test("2. Autocomplete inserts safe source, re-chips immediately and announces", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadConjugateExample(page);
    await selectFluidNode(page, "f1");

    const editor = page.locator('[data-testid="node-volume-editor"]');
    const menu = page.locator('[data-testid="node-volume-autocomplete"]');
    await editor.click();
    // Replace the literal with the start of a formula.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("=pipe(");
    // Id context: the catalog's branches are listed (sorted by id).
    await expect(menu).toBeVisible();
    const options = page.locator('[data-testid="node-volume-suggestion"]');
    await expect(options.first()).toContainText("b_in");
    await expect(options.filter({ hasText: "b_mid" })).toHaveCount(1);
    // Mouse-accept the id.
    await options.filter({ hasText: "b_in" }).first().click();
    // Continue the reference: close the call, then property suggestions.
    await page.keyboard.type(").");
    await expect(menu).toBeVisible();
    await page.keyboard.type("vol");
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText("volume");
    // Keyboard-accept the property: source completes and re-chips at once.
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    const chip = page.locator('[data-testid="node-volume-chip"]');
    await expect(chip).toHaveCount(1);
    await expect(chip).toContainText("b_in · volume");
    await expect(
      page.locator('[data-testid="node-volume-announce"]'),
    ).toContainText("Inserted volume");
    // Enter on the closed menu commits; the resolved preview appears.
    await page.keyboard.press("Enter");
    await expect(
      page.locator('[data-testid="node-volume-formula-badge"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="node-volume-preview"]'),
    ).toContainText("→ 0.000353429");

    consoleWatcher.assertNoErrors();
  });

  test("3. Select + Backspace removes the whole chip atomically; undo restores it", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadConjugateExample(page);
    await selectFluidNode(page, "f1");

    // Bind the volume first (fast path: fill + commit).
    const editor = page.locator('[data-testid="node-volume-editor"]');
    await editor.click();
    await editor.fill("=pipe('b_in').volume");
    await editor.press("Enter");
    await expect(page.locator('[data-testid="node-volume-chip"]')).toHaveCount(
      1,
    );

    // Click selects the chip; Backspace removes its entire source span.
    const chip = page.locator('[data-testid="node-volume-chip"]');
    await chip.click();
    await expect(chip).toHaveClass(/formula-chip--selected/);
    await page.keyboard.press("Backspace");
    await expect(page.locator('[data-testid="node-volume-chip"]')).toHaveCount(
      0,
    );
    await expect(editor).toHaveText("=");
    await expect(
      page.locator('[data-testid="node-volume-announce"]'),
    ).toContainText("Removed reference b_in · volume");

    // Clear the '=' leader too, then type a literal and commit — one
    // ordinary update (a literal number never opens the autocomplete).
    await page.keyboard.press("Backspace");
    await page.keyboard.type("0.002");
    await expect(
      page.locator('[data-testid="node-volume-autocomplete"]'),
    ).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(
      page.locator('[data-testid="node-volume-formula-badge"]'),
    ).toHaveCount(0);
    await expect(editor).toHaveText("0.002");

    // Store undo (focus is outside the editor now) restores the binding…
    await page
      .locator('[data-testid="property-panel"] .property-panel__title')
      .click();
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(200);
    // …(undo clears the selection by design) re-select to see it.
    await selectFluidNode(page, "f1");
    await expect(
      page.locator('[data-testid="node-volume-formula-badge"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="node-volume-chip"]'),
    ).toContainText("b_in · volume");

    consoleWatcher.assertNoErrors();
  });

  test("4. Double-click explodes an invalid chip to raw source for repair", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadConjugateExample(page);
    await selectFluidNode(page, "f1");

    // Commit a broken reference: the error shows and the chip warns.
    const editor = page.locator('[data-testid="node-volume-editor"]');
    await editor.click();
    await editor.fill("=pipe('nope').volume");
    await editor.press("Enter");
    await expect(
      page.locator('[data-testid="node-volume-error"]'),
    ).toContainText("unknown branch 'nope'");
    const chip = page.locator('[data-testid="node-volume-chip"]');
    await expect(chip).toHaveClass(/formula-chip--invalid/);
    await expect(chip).toHaveAttribute(
      "data-chip-source",
      "pipe('nope').volume",
    );

    // Double-click explodes the chip: its exact source becomes selected text.
    await chip.dblclick();
    await expect(page.locator('[data-testid="node-volume-chip"]')).toHaveCount(
      0,
    );
    await expect(
      page.locator('[data-testid="node-volume-announce"]'),
    ).toContainText("Editing reference nope · volume as text");
    // Retyping over the selection repairs the formula.
    await page.keyboard.type("pipe('b_in').volume");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-testid="node-volume-error"]')).toHaveCount(
      0,
    );
    await expect(
      page.locator('[data-testid="node-volume-preview"]'),
    ).toContainText("→ 0.000353429");
    const fixed = page.locator('[data-testid="node-volume-chip"]');
    await expect(fixed).toContainText("b_in · volume");
    await expect(fixed).not.toHaveClass(/formula-chip--invalid/);

    consoleWatcher.assertNoErrors();
  });

  test("5. Plain-text toggle exposes the ordinary input path and toggles back to chips", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadConjugateExample(page);
    await selectFluidNode(page, "f1");

    const toggle = page.locator('[data-testid="node-volume-plain-toggle"]');
    // The escape hatch is labeled "Text formula"; Formula Options is separate.
    await expect(toggle).toHaveAttribute("aria-label", "Text formula");
    await expect(toggle).toHaveText("Aa");
    await expect(
      page.locator('[data-testid="node-volume-insert-variable"]'),
    ).toHaveText("ƒ Options");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // Plain mode still shows Aa (pressed), independently of Formula Options.
    await expect(toggle).toHaveText("Aa");

    // The old input path: fill-compatible, commits on Enter.
    const input = page.locator('[data-testid="node-volume"] input');
    await expect(input).toBeVisible();
    await input.fill("=pipe('b_in').volume");
    await input.press("Enter");
    await expect(
      page.locator('[data-testid="node-volume-formula-badge"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="node-volume-preview"]'),
    ).toContainText("→ 0.000353429");

    // Back to the visual editor: the committed formula renders as a chip.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(
      page.locator('[data-testid="node-volume-chip"]'),
    ).toContainText("b_in · volume");

    // Literal numbers behave the same in the plain path (no badge).
    await toggle.click();
    await input.fill("0.002");
    await input.press("Enter");
    await expect(
      page.locator('[data-testid="node-volume-formula-badge"]'),
    ).toHaveCount(0);

    consoleWatcher.assertNoErrors();
  });

  test("6. Autocomplete is portaled outside the property panel; Text modal closes it", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadConjugateExample(page);
    await selectFluidNode(page, "f1");

    const editor = page.locator('[data-testid="node-volume-editor"]');
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("=pipe(");
    const menu = page.locator('[data-testid="node-volume-autocomplete"]');
    await expect(menu).toBeVisible();
    // Portaled to <body>: never clipped by the panel's overflow, and its
    // fixed position stays inside the viewport.
    await expect(
      page.locator(
        '[data-testid="property-panel"] [data-testid="node-volume-autocomplete"]',
      ),
    ).toHaveCount(0);
    const box = await menu.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);

    // Opening the Text modal closes the portaled autocomplete menu.
    await page.locator('[data-testid="canvas-text-view"]').click();
    await expect(
      page.locator('[data-testid="model-view-dialog"]'),
    ).toBeVisible();
    await expect(menu).toHaveCount(0);
    // Closing the modal returns to the model editor.
    await page.locator('[data-testid="model-view-dialog-close"]').click();
    await selectFluidNode(page, "f1");
    await expect(
      page.locator('[data-testid="node-volume-editor"]'),
    ).toBeVisible();

    consoleWatcher.assertNoErrors();
  });

  test("7. Formula Options inserts a complete reference without syntax assembly", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadConjugateExample(page);
    await selectFluidNode(page, "f1");

    // Literal field: plain literal text, no badge.
    const editor = page.locator('[data-testid="node-volume-editor"]');
    await expect(editor).toHaveText("0.001");
    await expect(
      page.locator('[data-testid="node-volume-formula-badge"]'),
    ).toHaveCount(0);

    // Formula Options enters formula mode and opens a browsable catalog.
    const fxButton = page.locator(
      '[data-testid="node-volume-insert-variable"]',
    );
    await expect(fxButton).toHaveAttribute(
      "aria-label",
      "Browse formula options for Volume",
    );
    await fxButton.click();
    const browser = page.locator('[data-testid="node-volume-browser"]');
    await expect(browser).toBeVisible();
    await expect(
      browser.getByRole("tab", { name: "Model values" }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText("=");

    // One click inserts accessor, quoted id, parentheses, dot, and property.
    await browser.locator(`button[title="pipe('b_in').volume"]`).click();
    const chip = page.locator('[data-testid="node-volume-chip"]');
    await expect(chip).toHaveCount(1);
    await expect(chip).toContainText("b_in · volume");
    await expect(chip).toHaveAttribute(
      "data-chip-source",
      "pipe('b_in').volume",
    );

    // Enter commits: the binding previews its resolved value.
    await page.keyboard.press("Enter");
    await expect(
      page.locator('[data-testid="node-volume-formula-badge"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="node-volume-preview"]'),
    ).toContainText("→ 0.000353429");

    consoleWatcher.assertNoErrors();
  });

  test("8. typed formulas need no equals sign and functions are browsable", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadConjugateExample(page);
    await selectFluidNode(page, "f1");

    const editor = page.locator('[data-testid="node-volume-editor"]');
    const menu = page.locator('[data-testid="node-volume-autocomplete"]');
    const fxButton = page.locator(
      '[data-testid="node-volume-insert-variable"]',
    );
    await editor.focus();

    // The editing hint keeps the scope/semantics notes but never tells the
    // user to type '='.
    const help = page.locator('[data-testid="node-volume-help"]');
    await expect(help).toBeVisible();
    await expect(help).not.toContainText("Start with =");
    await expect(help).toContainText("ƒ Options");

    // Typing an expression automatically adds the internal formula leader.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("pip");
    await expect(editor).toHaveText("=pip");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // Functions are visible and insert their parentheses automatically.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("2 * ");
    await fxButton.click();
    const browser = page.locator('[data-testid="node-volume-browser"]');
    await browser.getByRole("tab", { name: "Functions" }).click();
    await browser.getByRole("button", { name: /circleArea/ }).click();
    await expect(editor).toHaveText("=2 * circleArea()");

    consoleWatcher.assertNoErrors();
  });

  test("9. Formula Options from plain text returns to the visual browser", async ({
    page,
  }) => {
    const consoleWatcher = attachConsoleWatcher(page);
    await loadConjugateExample(page);
    await selectFluidNode(page, "f1");

    const toggle = page.locator('[data-testid="node-volume-plain-toggle"]');
    await toggle.click();
    const input = page.locator('[data-testid="node-volume-input"]');
    await expect(input).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    // Formula Options works here too: back to the chip editor and browser.
    await page.locator('[data-testid="node-volume-insert-variable"]').click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    const editor = page.locator('[data-testid="node-volume-editor"]');
    await expect(editor).toHaveText("=");
    await expect(editor).toBeFocused();
    await expect(
      page.locator('[data-testid="node-volume-browser"]'),
    ).toBeVisible();

    consoleWatcher.assertNoErrors();
  });
});
